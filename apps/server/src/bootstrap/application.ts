import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import {
  DomainError,
  FILE_MAX_BYTES,
  SessionCreateRequestSchema,
  CurrentUserResponseSchema,
  NativeSessionResponseSchema,
  ServerListResponseSchema,
  UserListResponseSchema,
  ConversationCreateRequestSchema,
  ConversationResponseSchema,
  ConversationListResponseSchema,
  MessageCreateRequestSchema,
  MessageResponseSchema,
  MessageListResponseSchema,
  PageQuerySchema,
  MessagePageQuerySchema,
  SyncQuerySchema,
  SyncResponseSchema,
  ReadUpdateRequestSchema,
  ReadStateResponseSchema,
  ReadStateListResponseSchema,
  FileResponseSchema,
} from '@j-messenger/contracts';
import type {
  AllowedFileType,
  Clock,
  EventDto,
  EventHydrator,
  FeatureLog,
  Uuid,
} from '@j-messenger/contracts';
import type { AppConfig } from '../platform/config/index.js';
import type { TokenVerifier } from '@j-auth/token-verifier';
import { createLogger } from '../platform/logging/index.js';
import { createDatabase } from '../platform/database/index.js';
import { asStorage } from '../platform/storage/index.js';
import { PostgresStorage } from '../platform/storage/postgres.js';
import { JobStore, createJobRunner } from '../platform/jobs/index.js';
import {
  createHttpServer,
  registerHttpRoutes,
  requireContext,
  routeConfig,
} from '../platform/http/index.js';
import { createIdentityService } from '../modules/identity/index.js';
import { createConversationService } from '../modules/conversations/index.js';
import { createMessageService } from '../modules/messages/index.js';
import { createCursorCodec, createSyncService } from '../modules/sync/index.js';
import { createRealtimeService } from '../modules/realtime/index.js';
import { createFilesService } from '../modules/files/index.js';
import { createReceiptsService } from '../modules/receipts/index.js';
import { createAuditService } from '../modules/audit/index.js';
import { createRetentionService } from '../modules/retention/index.js';
import { MIGRATIONS } from './migrations.js';

export interface ApplicationOptions {
  readonly clock?: Clock;
  readonly logger?: FeatureLog;
  readonly maintenance?: boolean;
  readonly tokenVerifier?: TokenVerifier;
  readonly authFetch?: typeof globalThis.fetch;
}
export async function createApplication(
  config: AppConfig,
  options: ApplicationOptions = {},
) {
  const clock = options.clock ?? { now: () => new Date() };
  const ids = { uuid: () => randomUUID() as Uuid };
  const logger =
    options.logger ??
    createLogger({
      release: config.release,
      module: 'server',
      level: config.logLevel,
      clock,
    });
  for (const directory of [
    ...(config.databaseDriver === 'sqlite'
      ? [path.dirname(config.dbPath)]
      : []),
    config.fileRoot,
    config.tempRoot,
    config.backupRoot,
  ])
    await mkdir(directory, { recursive: true });
  const db =
    config.databaseDriver === 'postgres'
      ? await PostgresStorage.open({
          connectionString: config.databaseUrl!,
          schema: config.databaseSchema!,
          clock,
          logger,
        })
      : asStorage(
          createDatabase(config.dbPath, {
            migrations: MIGRATIONS,
            clock,
            logger,
          }),
          logger,
        );
  try {
    const codec = createCursorCodec({ key: config.cursorSigningKey });
    const identity = await createIdentityService({
      db,
      config,
      clock,
      idFactory: ids,
      logger,
      ...(options.tokenVerifier
        ? { tokenVerifier: options.tokenVerifier }
        : {}),
      ...(options.authFetch ? { fetch: options.authFetch } : {}),
    });
    const conversations = createConversationService({
      db,
      identity,
      clock,
      logger,
      cursorCodec: codec,
    });
    const jobs = new JobStore(db, { clock, idFactory: ids, logger });
    const files = createFilesService({
      db,
      root: config.fileRoot,
      tempRoot: config.tempRoot,
      clock,
      ids,
      access: conversations,
      logger,
      policy: {
        quotaBytes: config.fileQuotaBytes || 2_000_000_000,
        minimumFreeBytes: 1_073_741_824,
      },
      jobs,
    });
    const messages = createMessageService({
      db,
      access: conversations,
      activity: conversations,
      clock,
      logger,
      cursorCodec: codec,
      ...(config.features.files ? { files } : {}),
    });
    const receipts = createReceiptsService({
      db,
      clock,
      access: conversations,
      activity: conversations,
      validateMessage: messages.validateMessage,
      logger,
    });
    const audit = createAuditService({ db, clock, logger });
    const retention = createRetentionService({
      db,
      clock,
      files,
      audit,
      logger,
      purgeMessages: messages.purgeExpiredBatch,
      eventExpiredFile: (tx, context, fileId) =>
        messages.expireFileReference(tx, context, fileId),
      policyRoutesEnabled: false,
    });
    const hydrator: EventHydrator = {
      async hydrate(context, record): Promise<EventDto | null> {
        if (record.serverId !== context.serverId) return null;
        if (
          record.payloadRef.entityType === 'message' ||
          record.payloadRef.entityType === 'file'
        )
          return messages.hydrateEvent(context, record);
        if (
          !record.conversationId ||
          !(await conversations.canAccess(context, record.conversationId))
        )
          return null;
        if (record.payloadRef.entityType === 'conversation')
          return {
            eventId: record.id,
            type: record.type,
            occurredAt: record.occurredAt,
            conversationId: record.conversationId,
            data: await conversations.get(context, record.conversationId),
          };
        if (record.payloadRef.entityType === 'receipt')
          return {
            eventId: record.id,
            type: record.type,
            occurredAt: record.occurredAt,
            conversationId: record.conversationId,
            data: {
              receipts: await receipts.get(context, record.conversationId),
            },
          };
        return null;
      },
    };
    const sync = createSyncService({
      db,
      hydrator,
      cursorCodec: codec,
      clock,
      logger,
    });
    const https = config.tls
      ? {
          cert: await readFile(config.tls.certPath),
          key: await readFile(config.tls.keyPath),
        }
      : undefined;
    const app = createHttpServer({
      config,
      resolver: identity,
      logger,
      ...(https ? { https } : {}),
    });
    const realtime = createRealtimeService({
      db,
      config,
      resolver: identity,
      sync,
      hydrator,
      clock,
      logger,
    });
    const runner = createJobRunner({
      db,
      store: jobs,
      clock,
      idFactory: ids,
      logger,
      handlers: [files.deleteHandler],
    });
    let closing = false;
    let maintaining = false;
    const maintain = async () => {
      if (closing || maintaining) return;
      maintaining = true;
      try {
        if (config.features.retention)
          for (const server of config.mailServers) {
            const context = { serverId: server.id, requestId: ids.uuid() };
            for (let index = 0; index < 20; index++)
              if ((await retention.runSystemBatch(context, 100)).complete)
                break;
          }
        await runner.runBatch(100);
        if (config.features.files) await files.reconcileOrphans(100);
      } catch {
        logger.emit({
          featureId: 'F42',
          event: 'maintenance.failed',
          outcome: 'failure',
          fields: { reasonCode: 'maintenance_failed' },
        });
      } finally {
        maintaining = false;
      }
    };
    registerHttpRoutes(app, (scope) => {
      scope.register(multipart, {
        limits: { fileSize: FILE_MAX_BYTES, files: 1, fields: 0 },
      });
      const protectedConfig = routeConfig('authRequired');
      scope.get('/health/live', { config: routeConfig('public') }, () => ({
        data: { alive: true },
      }));
      scope.get(
        '/health/ready',
        { config: routeConfig('public') },
        (_request, reply) =>
          reply.code(closing ? 503 : 200).send({ data: { ready: !closing } }),
      );
      if (config.authMode !== 'j-auth') {
        scope.get(
          '/api/v1/servers',
          {
            config: routeConfig('public'),
            schema: { response: { 200: ServerListResponseSchema } },
          },
          () => ({ data: identity.listServers() }),
        );
        scope.post<{
          Body: { serverId: string; username: string; password: string };
        }>(
          '/api/v1/session',
          {
            config: routeConfig('public'),
            schema: {
              body: SessionCreateRequestSchema,
              response: { 201: CurrentUserResponseSchema },
            },
          },
          async (request, reply) => {
            const result = await identity.login(
              request.body.serverId,
              request.body.username,
              request.body.password,
            );
            reply.setCookie('jm_session', result.credential, {
              httpOnly: true,
              secure: config.secureCookies || config.tls !== null,
              sameSite: 'strict',
              path: '/',
              maxAge: config.sessionDays * 86400,
            });
            return reply.code(201).send({ data: result.user });
          },
        );
        if (config.features.nativeSessions)
          scope.post<{
            Body: { serverId: string; username: string; password: string };
          }>(
            '/api/v1/native/session',
            {
              config: routeConfig('public', { credentialSubmission: 'native' }),
              schema: {
                body: SessionCreateRequestSchema,
                response: { 201: NativeSessionResponseSchema },
              },
            },
            async (request, reply) => {
              const result = await identity.login(
                request.body.serverId,
                request.body.username,
                request.body.password,
                'native',
              );
              return reply.code(201).send({
                data: {
                  user: result.user,
                  credential: result.credential,
                  expiresAt: result.expiresAt,
                },
              });
            },
          );
      }
      scope.get(
        '/api/v1/me',
        {
          config: protectedConfig,
          schema: { response: { 200: CurrentUserResponseSchema } },
        },
        async (request) => ({
          data: await identity.get(requireContext(request)),
        }),
      );
      if (config.authMode !== 'j-auth')
        scope.delete(
          '/api/v1/session',
          { config: protectedConfig },
          async (request, reply) => {
            await identity.logout(requireContext(request));
            reply.clearCookie('jm_session', { path: '/' });
            return { data: { loggedOut: true } };
          },
        );
      scope.get<{ Querystring: { cursor?: string; limit?: number } }>(
        '/api/v1/users',
        {
          config: protectedConfig,
          schema: {
            querystring: PageQuerySchema,
            response: { 200: UserListResponseSchema },
          },
        },
        async (request) => {
          const context = requireContext(request);
          const page = await identity.listSameServer(
            context,
            request.query.cursor ?? null,
            request.query.limit ?? 50,
          );
          const position = await db.eventReader.highWatermark(context);
          return {
            data: page.items,
            page: { nextCursor: page.nextCursor },
            snapshotPosition: position,
            snapshotCursor: codec.encode({
              serverId: context.serverId,
              userId: context.userId,
              epoch: (await db.getStreamMetadata()).epoch,
              position,
              expiresAt: new Date(
                clock.now().getTime() + 7 * 86400000,
              ).toISOString(),
            }),
          };
        },
      );
      scope.get<{ Querystring: { cursor?: string; limit?: number } }>(
        '/api/v1/conversations',
        {
          config: protectedConfig,
          schema: {
            querystring: PageQuerySchema,
            response: { 200: ConversationListResponseSchema },
          },
        },
        async (request) => {
          const page = await conversations.list(
            requireContext(request),
            request.query.cursor ?? null,
            request.query.limit ?? 50,
          );
          return {
            data: page.items,
            page: { nextCursor: page.nextCursor },
            snapshotCursor: page.snapshotCursor,
            snapshotPosition: page.snapshotPosition,
          };
        },
      );
      scope.post<{ Body: Parameters<typeof conversations.create>[1] }>(
        '/api/v1/conversations',
        {
          config: protectedConfig,
          schema: {
            body: ConversationCreateRequestSchema,
            response: {
              200: ConversationResponseSchema,
              201: ConversationResponseSchema,
            },
          },
        },
        async (request, reply) => {
          const result = await conversations.create(
            requireContext(request),
            request.body,
          );
          return reply
            .code(result.created ? 201 : 200)
            .send({ data: result.conversation });
        },
      );
      scope.get<{
        Params: { id: string };
        Querystring: { before?: string; after?: string; limit?: number };
      }>(
        '/api/v1/conversations/:id/messages',
        {
          config: protectedConfig,
          schema: {
            querystring: MessagePageQuerySchema,
            response: { 200: MessageListResponseSchema },
          },
        },
        async (request) => {
          const page = await messages.list(
            requireContext(request),
            request.params.id,
            { ...request.query, limit: request.query.limit ?? 50 },
          );
          return {
            data: page.items,
            page: { nextCursor: page.nextCursor },
            snapshotCursor: page.snapshotCursor,
            snapshotPosition: page.snapshotPosition,
          };
        },
      );
      scope.post<{
        Params: { id: string };
        Body: Parameters<typeof messages.create>[2];
      }>(
        '/api/v1/conversations/:id/messages',
        {
          config: protectedConfig,
          schema: {
            body: MessageCreateRequestSchema,
            response: {
              200: MessageResponseSchema,
              201: MessageResponseSchema,
            },
          },
        },
        async (request, reply) => {
          const result = await messages.create(
            requireContext(request),
            request.params.id,
            request.body,
          );
          return reply.code(result.status).send({ data: result.message });
        },
      );
      scope.get<{
        Querystring: { after: string; through?: string; limit?: number };
      }>(
        '/api/v1/sync',
        {
          config: protectedConfig,
          schema: {
            querystring: SyncQuerySchema,
            response: { 200: SyncResponseSchema },
          },
        },
        async (request) =>
          sync.sync(requireContext(request), {
            ...request.query,
            limit: request.query.limit ?? 100,
          }),
      );
      if (config.features.files) {
        scope.post<{ Params: { id: string } }>(
          '/api/v1/conversations/:id/files',
          {
            config: protectedConfig,
            bodyLimit: FILE_MAX_BYTES + 65536,
            schema: { response: { 201: FileResponseSchema } },
          },
          async (request, reply) => {
            const part = await request.file();
            if (!part) throw new DomainError('bad_request');
            const extension = path
              .extname(part.filename)
              .slice(1)
              .toLowerCase();
            const type = (
              extension === 'jpeg' ? 'jpg' : extension
            ) as AllowedFileType;
            if (
              ![
                'png',
                'jpg',
                'webp',
                'pdf',
                'txt',
                'csv',
                'docx',
                'xlsx',
                'zip',
              ].includes(type)
            )
              throw new DomainError('bad_request');
            async function* verifiedStream() {
              for await (const chunk of part!.file) yield chunk;
              if (part!.file.truncated) throw new DomainError('too_large');
            }
            const descriptor = await files.prepare(
              requireContext(request),
              request.params.id,
              {
                filename: part.filename,
                contentType: type,
                sizeBytes: null,
                stream: verifiedStream(),
              },
            );
            return reply.code(201).send({ data: descriptor });
          },
        );
        scope.get<{ Params: { id: string } }>(
          '/api/v1/files/:id/content',
          { config: protectedConfig },
          async (request, reply) => {
            const result = await files.openDownload(
              requireContext(request),
              request.params.id,
            );
            reply
              .header(
                'Content-Disposition',
                `attachment; filename*=UTF-8''${encodeURIComponent(result.descriptor.filename)}`,
              )
              .header('X-Content-Type-Options', 'nosniff')
              .header('Cache-Control', 'no-store')
              .type(result.descriptor.contentType);
            return reply.send(Readable.from(result.stream));
          },
        );
      }
      if (config.features.receipts) {
        scope.put<{
          Params: { id: string };
          Body: { lastReadMessageId: string };
        }>(
          '/api/v1/conversations/:id/read',
          {
            config: protectedConfig,
            schema: {
              body: ReadUpdateRequestSchema,
              response: { 200: ReadStateResponseSchema },
            },
          },
          async (request) => {
            const context = requireContext(request);
            const result = await receipts.advance(
              context,
              request.params.id,
              request.body.lastReadMessageId,
            );
            return {
              data: {
                conversationId: request.params.id,
                userId: context.userId,
                lastReadMessageId: result.lastReadMessageId,
              },
            };
          },
        );
        scope.get<{ Params: { id: string } }>(
          '/api/v1/conversations/:id/read',
          {
            config: protectedConfig,
            schema: { response: { 200: ReadStateListResponseSchema } },
          },
          async (request) => {
            const context = requireContext(request);
            const data = await receipts.get(context, request.params.id);
            const frame = await sync.ready(context);
            return {
              data,
              snapshotCursor: frame.cursor,
              snapshotPosition: frame.position,
            };
          },
        );
      }
      realtime.registerRoutes(scope);
      scope.addHook('onRoute', (route) => {
        if (!route.url.startsWith('/api/'))
          route.config = { ...route.config, ...routeConfig('public') };
      });
      scope.register(staticFiles, {
        root: config.webDist,
        prefix: '/',
        index: 'index.html',
      });
    });
    await app.ready();
    let timer: ReturnType<typeof setInterval> | undefined;
    if (options.maintenance !== false) {
      await maintain();
      timer = setInterval(() => {
        void maintain();
      }, 60000);
      timer.unref();
    }
    const close = async () => {
      if (closing) return;
      closing = true;
      if (timer) clearInterval(timer);
      realtime.close();
      runner.stop();
      await app.close();
      await db.close();
    };
    return {
      app,
      db,
      identity,
      conversations,
      messages,
      files,
      receipts,
      retention,
      jobs,
      runner,
      sync,
      realtime,
      maintain,
      close,
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}
