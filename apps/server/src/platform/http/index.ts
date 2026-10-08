import { randomUUID } from 'node:crypto';
import type { ServerOptions as HttpsOptions } from 'node:https';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import websocket from '@fastify/websocket';
import { TypeBoxValidatorCompiler } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  DomainError,
  HTTP_STATUS_BY_ERROR,
  toApiError,
} from '@j-messenger/contracts';
import {
  ConversationCreateRequestSchema,
  ConversationDtoSchema,
  CurrentUserDtoSchema,
  ErrorEnvelopeSchema,
  FileDescriptorSchema,
  ListEnvelopeSchema,
  MessageCreateRequestSchema,
  MessageOutputSchema,
  MessagePageQuerySchema,
  PageQuerySchema,
  ReadStateDtoSchema,
  ReadUpdateRequestSchema,
  RetentionPolicyDtoSchema,
  RetentionUpdateRequestSchema,
  SessionCreateRequestSchema,
  SuccessEnvelopeSchema,
  SyncQuerySchema,
  UserDtoSchema,
} from '@j-messenger/contracts';
import type {
  FeatureLog,
  RequestContext,
  SessionResolver,
  Uuid,
} from '@j-messenger/contracts';
import type { AppConfig } from '../config/index.js';

export type HttpAuthPolicy = 'authRequired' | 'public' | 'native';
export interface HttpRouteConfig {
  readonly auth: HttpAuthPolicy;
  /** Allows an unauthenticated native-session exchange without Origin. */
  readonly credentialSubmission?: 'native';
}
export interface HttpOptions {
  readonly config: AppConfig;
  readonly resolver: SessionResolver;
  readonly logger: FeatureLog;
  readonly registerWebsocket?: boolean;
  /** TLS material is supplied by bootstrap after resolving config.tls paths. */
  readonly https?: HttpsOptions;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    http?: HttpRouteConfig;
  }
  interface FastifyRequest {
    requestId: Uuid;
    authContext: RequestContext | null;
  }
}

export function createHttpServer(options: HttpOptions): FastifyInstance {
  if (options.config.mode === 'production' && !options.https)
    throw new Error('HTTPS options are required in production');
  const app = Fastify({
    logger: false,
    ...(options.https ? { https: options.https } : {}),
    bodyLimit: 64 * 1024,
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
        useDefaults: false,
      },
    },
  });
  app.setValidatorCompiler(TypeBoxValidatorCompiler);
  app.decorateRequest('requestId', '');
  app.decorateRequest('authContext', null);
  app.register(cookie);
  app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (request) =>
      request.ip ?? request.raw.socket?.remoteAddress ?? 'unknown',
  });
  app.register(swagger, {
    openapi: {
      info: { title: 'J-Messenger API', version: options.config.release },
      servers: [{ url: options.config.publicOrigin }],
    },
  });
  const schemas = {
    ErrorEnvelope: ErrorEnvelopeSchema,
    SuccessEnvelope: SuccessEnvelopeSchema,
    ListEnvelope: ListEnvelopeSchema,
    SessionCreateRequest: SessionCreateRequestSchema,
    PageQuery: PageQuerySchema,
    MessagePageQuery: MessagePageQuerySchema,
    SyncQuery: SyncQuerySchema,
    MessageCreateRequest: MessageCreateRequestSchema,
    ConversationCreateRequest: ConversationCreateRequestSchema,
    ReadUpdateRequest: ReadUpdateRequestSchema,
    RetentionUpdateRequest: RetentionUpdateRequestSchema,
    MessageOutput: MessageOutputSchema,
    UserDto: UserDtoSchema,
    ConversationDto: ConversationDtoSchema,
    CurrentUserDto: CurrentUserDtoSchema,
    FileDescriptor: FileDescriptorSchema,
    ReadStateDto: ReadStateDtoSchema,
    RetentionPolicyDto: RetentionPolicyDtoSchema,
  };
  for (const [name, schema] of Object.entries(schemas))
    app.addSchema({ ...schema, $id: `contracts.${name}` });
  if (options.registerWebsocket !== false) app.register(websocket);

  app.addHook('onRequest', async (request, reply) => {
    request.requestId = randomUUID() as Uuid;
    reply.header('X-Request-Id', request.requestId);
    if (!request.routeOptions.url) return;
    const route = request.routeOptions.config.http;
    const policy = route?.auth ?? 'authRequired';
    const cookiePresented = /(?:^|;\s*)jm_session=/.test(
      request.headers.cookie ?? '',
    );
    const bearer = request.headers.authorization;
    const bearerPresented = bearer !== undefined;
    const cookieValue = request.cookies['jm_session'];
    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    const websocketHandshake =
      request.headers.upgrade?.toLowerCase() === 'websocket';
    const nativeLogin =
      route?.credentialSubmission === 'native' && policy === 'public';
    const protectedRoute = policy === 'authRequired' || policy === 'native';
    const authorizationValid =
      bearer !== undefined && /^Bearer [^\s]+$/.test(bearer);
    if (options.config.authMode === 'j-auth' && protectedRoute) {
      const query = request.query;
      const hasQueryCredential =
        typeof query === 'object' &&
        query !== null &&
        Object.keys(query).some((key) =>
          /(?:token|jwt|credential|session|authorization|^auth$)/iu.test(key),
        );
      if (
        !authorizationValid ||
        request.headers.cookie !== undefined ||
        hasQueryCredential
      )
        throw new DomainError('unauthorized');
    }
    if (bearerPresented && !authorizationValid)
      throw new DomainError('unauthorized');
    if (cookiePresented && bearerPresented)
      throw new DomainError('unauthorized');
    if (policy === 'native' && (!bearerPresented || cookiePresented))
      throw new DomainError('unauthorized');
    if (nativeLogin && (cookiePresented || bearerPresented))
      throw new DomainError('unauthorized');
    if (protectedRoute && !bearerPresented && !cookieValue)
      throw new DomainError('unauthorized');
    const bearerOnly = protectedRoute && bearerPresented && !cookiePresented;
    const origin = request.headers.origin;
    const mustCheckOrigin = (websocketHandshake || isWrite) && !nativeLogin;
    const originIsPresent = origin !== undefined;
    const originIsExact = origin === options.config.publicOrigin;
    if (
      mustCheckOrigin &&
      (bearerOnly ? originIsPresent && !originIsExact : !originIsExact)
    ) {
      throw new DomainError('forbidden');
    }
    if (policy === 'public' && websocketHandshake && cookiePresented)
      throw new DomainError('unauthorized');
  });

  app.addHook('preHandler', async (request) => {
    if (!request.routeOptions.url) return;
    const policy = request.routeOptions.config.http?.auth ?? 'authRequired';
    if (policy === 'public') return;
    const authorization = request.headers.authorization;
    const credential =
      policy === 'native' || authorization !== undefined
        ? authorization?.slice('Bearer '.length)
        : request.cookies['jm_session'];
    if (!credential) throw new DomainError('unauthorized');
    request.authContext = await options.resolver.resolve({
      credential,
      requestId: request.requestId,
    });
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    const status =
      error instanceof DomainError
        ? HTTP_STATUS_BY_ERROR[error.code]
        : statusCode === 413
          ? HTTP_STATUS_BY_ERROR.too_large
          : statusCode === 400 || statusCode === 415
            ? HTTP_STATUS_BY_ERROR.bad_request
            : statusCode === 429
              ? HTTP_STATUS_BY_ERROR.rate_limited
              : HTTP_STATUS_BY_ERROR.internal;
    const normalized =
      error instanceof DomainError
        ? error
        : new DomainError(
            status === 413
              ? 'too_large'
              : status === 400
                ? 'bad_request'
                : status === 429
                  ? 'rate_limited'
                  : 'internal',
          );
    void reply.code(status).send(toApiError(normalized, request.requestId));
  });

  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .send(toApiError(new DomainError('not_found'), request.requestId));
  });

  app.addHook('onResponse', async (request, reply) => {
    options.logger.emit({
      featureId: 'F19',
      event: 'http.request.completed',
      outcome:
        reply.statusCode >= 500
          ? 'failure'
          : reply.statusCode >= 400
            ? 'rejected'
            : 'success',
      requestId: request.requestId,
      fields: {
        route: request.routeOptions.url ?? '/',
        statusCode: reply.statusCode,
        durationMs: Math.max(0, Math.round(reply.elapsedTime)),
      },
    });
  });
  return app;
}

export function requireContext(request: FastifyRequest): RequestContext {
  if (!request.authContext) throw new DomainError('unauthorized');
  return request.authContext;
}

/** Register feature routes after shared Fastify plugins have initialized. */
export function registerHttpRoutes(
  app: FastifyInstance,
  register: (scope: FastifyInstance) => void,
): void {
  app.register(async (scope) => {
    register(scope);
  });
}

export function routeConfig(
  auth: HttpAuthPolicy,
  extra: Omit<HttpRouteConfig, 'auth'> = {},
): { http: HttpRouteConfig } {
  return { http: { auth, ...extra } };
}
