import { createHash } from 'node:crypto';
import {
  DomainError,
  type Clock,
  type ConversationAccess,
  type ConversationActivity,
  type ConversationCreateRequest,
  type ConversationDto,
  type ConversationQueries,
  type DecimalId,
  type EventDto,
  type EventRecord,
  type FeatureLog,
  type OpaqueCursorCodec,
  type RequestContext,
  type SystemContext,
  type TxContext,
  type UserDirectory,
} from '@j-messenger/contracts';
import { asStorage } from '../../platform/storage/index.js';
import type {
  StorageDatabase,
  StorageInput,
} from '../../platform/storage/index.js';

type IdentityPort = UserDirectory & {
  get(context: RequestContext): Promise<unknown>;
  sessionActive(context: RequestContext): boolean | Promise<boolean>;
};
export interface ConversationService
  extends ConversationAccess, ConversationActivity, ConversationQueries {
  create(
    context: RequestContext,
    input: ConversationCreateRequest,
  ): Promise<{ conversation: ConversationDto; created: boolean }>;
  listSnapshot(
    context: RequestContext,
    limit: number,
  ): Promise<{
    items: readonly ConversationDto[];
    snapshotCursor: string;
    snapshotPosition: string;
  }>;
  memberIdsForSystem(
    tx: TxContext,
    system: SystemContext,
    conversationId: DecimalId,
  ): readonly DecimalId[] | Promise<readonly DecimalId[]>;
  hydrateEvent(
    context: RequestContext,
    record: EventRecord,
  ): Promise<EventDto | null>;
}
export interface ConversationOptions {
  readonly db: StorageInput;
  readonly identity: IdentityPort;
  readonly clock: Clock;
  readonly logger?: FeatureLog;
  readonly cursorCodec?: OpaqueCursorCodec;
}
export class ConversationError extends DomainError {
  constructor(
    code:
      | 'bad_request'
      | 'unauthorized'
      | 'not_found'
      | 'conflict'
      | 'sync_reset_required'
      | 'internal' = 'internal',
  ) {
    super(code);
    this.name = 'ConversationError';
  }
}
type ConversationRow = {
  id: bigint;
  kind: 'direct' | 'group';
  title: string | null;
  created_at: string;
  last_message_at: string | null;
};
const positive = (value: string): boolean =>
  /^[1-9][0-9]*$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
const decimal = (value: unknown): string =>
  typeof value === 'bigint' ? value.toString() : String(value);
const safeEmit = (
  logger: FeatureLog | undefined,
  event: string,
  outcome: 'success' | 'rejected' | 'failure',
  context: RequestContext | undefined,
  fields: Record<string, string | number | boolean | null>,
): void => {
  try {
    logger?.emit({
      featureId: 'F07',
      event,
      outcome,
      ...(context ? { requestId: context.requestId } : {}),
      fields,
    });
  } catch {
    /* logging cannot change access decisions */
  }
};
const dto = (
  db: StorageDatabase,
  context: RequestContext,
  row: ConversationRow,
): Promise<ConversationDto> =>
  db
    .prepare(
      'SELECT user_id FROM members WHERE server_id=? AND conversation_id=? ORDER BY user_id',
    )
    .all(context.serverId, row.id)
    .then((members) => ({
      id: decimal(row.id) as DecimalId,
      kind: row.kind,
      title: row.title,
      memberIds: (members as Array<{ user_id: bigint }>).map(
        (member) => decimal(member.user_id) as DecimalId,
      ),
      createdAt: row.created_at,
      lastMessageAt: row.last_message_at,
    }));
const toRow = (value: unknown): ConversationRow | undefined =>
  value as ConversationRow | undefined;

export function createConversationService(
  options: ConversationOptions,
): ConversationService {
  const db = asStorage(options.db);
  const { identity, clock, logger, cursorCodec } = options;
  const assertContext = async (context: RequestContext): Promise<void> => {
    if (!positive(context.userId) || !positive(context.sessionId))
      throw new ConversationError('unauthorized');
    try {
      await identity.get(context);
    } catch {
      throw new ConversationError('unauthorized');
    }
  };
  const epoch = async (): Promise<string> =>
    (await db.getStreamMetadata()).epoch;
  const encode = async (
    context: RequestContext,
    position: string,
    streamEpoch?: string,
  ): Promise<string> => {
    if (!cursorCodec) throw new ConversationError('internal');
    return cursorCodec.encode({
      serverId: context.serverId,
      userId: context.userId,
      epoch: streamEpoch ?? (await epoch()),
      position,
      expiresAt: new Date(clock.now().getTime() + 15 * 60_000).toISOString(),
    });
  };
  const decode = async (
    context: RequestContext,
    token: string,
    streamEpoch?: string,
  ): Promise<string> => {
    if (!cursorCodec) throw new ConversationError('bad_request');
    try {
      const result = cursorCodec.decode(token, {
        serverId: context.serverId,
        userId: context.userId,
        epoch: streamEpoch ?? (await epoch()),
        now: clock.now(),
      });
      if (
        !/^(0|[1-9][0-9]*)$/.test(result.position) ||
        BigInt(result.position) > 9_223_372_036_854_775_807n
      )
        throw new Error('invalid position');
      return result.position;
    } catch (error) {
      if (error instanceof DomainError && error.code === 'sync_reset_required')
        throw new ConversationError('sync_reset_required');
      throw new ConversationError('bad_request');
    }
  };
  const encodeListCursor = async (
    context: RequestContext,
    snapshotPosition: string,
    snapshotMax: string,
    after: string,
  ): Promise<string> => {
    const streamEpoch = await epoch();
    const [snapshot, max, encodedAfter] = await Promise.all([
      encode(context, snapshotPosition, streamEpoch),
      encode(context, snapshotMax, streamEpoch),
      encode(context, after, streamEpoch),
    ]);
    return Buffer.from(
      JSON.stringify({ snapshot, max, after: encodedAfter }),
      'utf8',
    ).toString('base64url');
  };
  const decodeListCursor = async (
    context: RequestContext,
    token: string,
  ): Promise<{
    snapshotPosition: string;
    snapshotMax: string;
    after: string;
  }> => {
    if (!/^[A-Za-z0-9_-]{1,4096}$/.test(token))
      throw new ConversationError('bad_request');
    try {
      const value = JSON.parse(
        Buffer.from(token, 'base64url').toString('utf8'),
      ) as { snapshot?: unknown; max?: unknown; after?: unknown };
      if (
        typeof value.snapshot !== 'string' ||
        typeof value.max !== 'string' ||
        typeof value.after !== 'string'
      )
        throw new Error('invalid list cursor');
      const streamEpoch = await epoch();
      const [snapshotPosition, snapshotMax, after] = await Promise.all([
        decode(context, value.snapshot, streamEpoch),
        decode(context, value.max, streamEpoch),
        decode(context, value.after, streamEpoch),
      ]);
      if (!positive(snapshotMax) && snapshotMax !== '0')
        throw new Error('invalid snapshot');
      if (!positive(after) && after !== '0')
        throw new Error('invalid position');
      if (BigInt(after) > BigInt(snapshotMax)) throw new Error('invalid range');
      return { snapshotPosition, snapshotMax, after };
    } catch (error) {
      if (error instanceof ConversationError) throw error;
      throw new ConversationError('bad_request');
    }
  };
  const getRow = async (
    context: RequestContext,
    id: DecimalId,
  ): Promise<ConversationRow | undefined> => {
    if (!positive(id)) return undefined;
    return toRow(
      await db
        .prepare(
          'SELECT id,kind,title,created_at,last_message_at FROM conversations WHERE server_id=? AND id=? AND EXISTS (SELECT 1 FROM members WHERE members.server_id=conversations.server_id AND members.conversation_id=conversations.id AND members.user_id=?)',
        )
        .get(context.serverId, BigInt(id), BigInt(context.userId)),
    );
  };
  const service: ConversationService = {
    async create(context, input) {
      await assertContext(context);
      if (
        !input ||
        !['direct', 'group'].includes(input.kind) ||
        !Array.isArray(input.memberIds) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          input.clientRequestId,
        )
      )
        throw new ConversationError('bad_request');
      const members = [...new Set([...input.memberIds, context.userId])].sort(
        (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0),
      );
      if (
        members.length < (input.kind === 'direct' ? 2 : 2) ||
        (input.kind === 'direct' && members.length !== 2) ||
        members.some((id) => !positive(id))
      )
        throw new ConversationError('bad_request');
      for (const id of members) {
        try {
          await identity.requireSameServer(context, id as DecimalId);
        } catch {
          throw new ConversationError('not_found');
        }
      }
      const title = input.kind === 'group' ? input.title?.trim() || null : null;
      if (title !== null && title.length > 200)
        throw new ConversationError('bad_request');
      const semantic = JSON.stringify({ kind: input.kind, members, title });
      const digest = createHash('sha256')
        .update(semantic, 'utf8')
        .digest('hex');
      try {
        const result = await db.run(async (tx) => {
          db.assertOwn(tx);
          if (input.kind === 'group') {
            const existing = (await db
              .prepare(
                'SELECT payload_digest,conversation_id FROM conversation_requests WHERE server_id=? AND sender_id=? AND client_request_id=?',
              )
              .get(
                context.serverId,
                BigInt(context.userId),
                input.clientRequestId,
              )) as
              { payload_digest: string; conversation_id: bigint } | undefined;
            if (existing) {
              if (existing.payload_digest !== digest)
                throw new ConversationError('conflict');
              const row = (await db
                .prepare(
                  'SELECT id,kind,title,created_at,last_message_at FROM conversations WHERE server_id=? AND id=?',
                )
                .get(context.serverId, existing.conversation_id)) as
                ConversationRow | undefined;
              if (!row) throw new ConversationError('internal');
              return {
                conversation: await dto(db, context, row),
                created: false,
              };
            }
          }
          let row: ConversationRow | undefined;
          let created = false;
          if (input.kind === 'direct') {
            const pair = members.join(':');
            row = toRow(
              await db
                .prepare(
                  'SELECT id,kind,title,created_at,last_message_at FROM conversations WHERE server_id=? AND direct_pair=?',
                )
                .get(context.serverId, pair),
            );
          }
          if (!row) {
            await db
              .prepare(
                'INSERT INTO conversations(server_id,kind,title,direct_pair,created_at) VALUES(?,?,?,?,?)',
              )
              .run(
                context.serverId,
                input.kind,
                title,
                input.kind === 'direct' ? members.join(':') : null,
                clock.now().toISOString(),
              );
            const id = await db.lastInsertId();
            for (const userId of members)
              await db
                .prepare(
                  'INSERT INTO members(server_id,conversation_id,user_id) VALUES(?,?,?)',
                )
                .run(context.serverId, BigInt(id), BigInt(userId));
            row = toRow(
              await db
                .prepare(
                  'SELECT id,kind,title,created_at,last_message_at FROM conversations WHERE server_id=? AND id=?',
                )
                .get(context.serverId, BigInt(id)),
            );
            if (!row) throw new ConversationError('internal');
            created = true;
            if (input.kind === 'group')
              await db
                .prepare(
                  'INSERT INTO conversation_requests(server_id,sender_id,client_request_id,payload_digest,conversation_id) VALUES(?,?,?,?,?)',
                )
                .run(
                  context.serverId,
                  BigInt(context.userId),
                  input.clientRequestId,
                  digest,
                  BigInt(id),
                );
            await db.eventWriter.append(tx, {
              type: 'conversation.created.v1',
              occurredAt: row.created_at,
              serverId: context.serverId,
              conversationId: decimal(row.id) as DecimalId,
              entityId: decimal(row.id) as DecimalId,
              recipientUserIds: members as DecimalId[],
              payloadRef: {
                entityType: 'conversation',
                entityId: decimal(row.id) as DecimalId,
              },
            });
            tx.afterCommit(() =>
              safeEmit(
                logger,
                input.kind === 'direct'
                  ? 'conversations.direct.resolved'
                  : 'conversations.group.created',
                'success',
                context,
                { conversationId: decimal(row!.id), count: members.length },
              ),
            );
          } else {
            tx.afterCommit(() =>
              safeEmit(
                logger,
                'conversations.direct.resolved',
                'success',
                context,
                { conversationId: decimal(row!.id), count: 2 },
              ),
            );
          }
          return { conversation: await dto(db, context, row), created };
        });
        return result;
      } catch (error) {
        safeEmit(
          logger,
          'conversations.create.failed',
          error instanceof ConversationError ? 'rejected' : 'failure',
          context,
          {
            reasonCode:
              error instanceof DomainError ? error.code : 'database_failure',
          },
        );
        if (error instanceof ConversationError) throw error;
        throw new ConversationError('conflict');
      }
    },
    async requireMember(context, conversationId) {
      await assertContext(context);
      if (!(await getRow(context, conversationId))) {
        safeEmit(logger, 'access.denied', 'rejected', context, {
          reasonCode: 'not_found',
        });
        throw new ConversationError('not_found');
      }
    },
    async recheckMember(tx: TxContext, context, conversationId) {
      db.assertOwn(tx);
      if (!(await identity.sessionActive(context)))
        throw new ConversationError('not_found');
      if (!(await getRow(context, conversationId)))
        throw new ConversationError('not_found');
    },
    async canAccess(context, conversationId) {
      try {
        await service.requireMember(context, conversationId);
        return true;
      } catch (error) {
        if (error instanceof ConversationError && error.code === 'not_found')
          return false;
        throw error;
      }
    },
    async recordMessage(tx, context, conversationId, occurredAt) {
      db.assertOwn(tx);
      await service.recheckMember(tx, context, conversationId);
      await db
        .prepare(
          'UPDATE conversations SET last_message_at=CASE WHEN last_message_at IS NULL OR last_message_at<? THEN ? ELSE last_message_at END WHERE server_id=? AND id=?',
        )
        .run(occurredAt, occurredAt, context.serverId, BigInt(conversationId));
    },
    async memberIds(context, conversationId) {
      if (!positive(conversationId)) return [];
      return (
        (await db
          .prepare(
            'SELECT user_id FROM members WHERE server_id=? AND conversation_id=? ORDER BY user_id',
          )
          .all(context.serverId, BigInt(conversationId))) as Array<{
          user_id: bigint;
        }>
      ).map((row) => decimal(row.user_id) as DecimalId);
    },
    async memberIdsForSystem(tx, system, conversationId) {
      db.assertOwn(tx);
      if (!positive(conversationId)) return [];
      return (
        (await db
          .prepare(
            'SELECT user_id FROM members WHERE server_id=? AND conversation_id=? ORDER BY user_id',
          )
          .all(system.serverId, BigInt(conversationId))) as Array<{
          user_id: bigint;
        }>
      ).map((row) => decimal(row.user_id) as DecimalId);
    },
    async get(context, conversationId) {
      await service.requireMember(context, conversationId);
      const row = await getRow(context, conversationId);
      if (!row) throw new ConversationError('not_found');
      return dto(db, context, row);
    },
    async hydrateEvent(context, record) {
      if (record.type !== 'conversation.created.v1' || !record.conversationId)
        return null;
      try {
        const conversation = await service.get(context, record.conversationId);
        return {
          eventId: record.id,
          type: record.type,
          occurredAt: record.occurredAt,
          conversationId: record.conversationId,
          data: conversation,
        };
      } catch (error) {
        if (error instanceof ConversationError && error.code === 'not_found')
          return null;
        throw error;
      }
    },
    async list(context, cursor, limit) {
      await assertContext(context);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new ConversationError('bad_request');
      const prior =
        cursor === null ? null : await decodeListCursor(context, cursor);
      const snapshot = await db.run(async (tx) => {
        if (!(await identity.sessionActive(context)))
          throw new ConversationError('unauthorized');
        const position =
          prior?.snapshotPosition ??
          (await db.eventReader.snapshotPosition(tx, context));
        const maxId =
          prior?.snapshotMax ??
          decimal(
            (
              (await db
                .prepare(
                  'SELECT COALESCE(MAX(c.id),0) AS id FROM conversations c JOIN members m ON m.server_id=c.server_id AND m.conversation_id=c.id WHERE c.server_id=? AND m.user_id=?',
                )
                .get(context.serverId, BigInt(context.userId))) as {
                id: bigint;
              }
            ).id,
          );
        const after = prior?.after ?? '0';
        const rows = (await db
          .prepare(
            'SELECT c.id,c.kind,c.title,c.created_at,c.last_message_at FROM conversations c JOIN members m ON m.server_id=c.server_id AND m.conversation_id=c.id WHERE c.server_id=? AND m.user_id=? AND c.id>? AND c.id<=? ORDER BY c.id LIMIT ?',
          )
          .all(
            context.serverId,
            BigInt(context.userId),
            BigInt(after),
            BigInt(maxId),
            limit + 1,
          )) as ConversationRow[];
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        return {
          position,
          maxId,
          hasMore,
          items: await Promise.all(page.map((row) => dto(db, context, row))),
          lastId: page.at(-1) ? decimal(page.at(-1)!.id) : null,
        };
      });
      safeEmit(logger, 'conversations.listed', 'success', context, {
        count: snapshot.items.length,
      });
      return {
        items: snapshot.items,
        nextCursor:
          snapshot.hasMore && snapshot.lastId
            ? await encodeListCursor(
                context,
                snapshot.position,
                snapshot.maxId,
                snapshot.lastId,
              )
            : null,
        snapshotCursor: await encode(context, snapshot.position),
        snapshotPosition: snapshot.position,
      };
    },
    async listSnapshot(context, limit) {
      await assertContext(context);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new ConversationError('bad_request');
      const result = await db.run(async (tx) => {
        if (!(await identity.sessionActive(context)))
          throw new ConversationError('unauthorized');
        const position = await db.eventReader.snapshotPosition(tx, context);
        const rows = (await db
          .prepare(
            'SELECT c.id,c.kind,c.title,c.created_at,c.last_message_at FROM conversations c JOIN members m ON m.server_id=c.server_id AND m.conversation_id=c.id WHERE c.server_id=? AND m.user_id=? ORDER BY c.id LIMIT ?',
          )
          .all(
            context.serverId,
            BigInt(context.userId),
            limit,
          )) as ConversationRow[];
        return {
          position,
          items: await Promise.all(rows.map((row) => dto(db, context, row))),
        };
      });
      return {
        items: result.items,
        snapshotCursor: await encode(context, result.position),
        snapshotPosition: result.position,
      };
    },
  };
  return service;
}

export function systemContextForConversations(_context: SystemContext): void {
  /* no conversation maintenance is required */
}
