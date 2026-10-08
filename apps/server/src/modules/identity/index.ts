import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { DomainError } from '@j-messenger/contracts';
import {
  createTokenVerifier,
  TokenVerificationError,
} from '@j-auth/token-verifier';
import type { TokenVerifier } from '@j-auth/token-verifier';
import type { AppConfig } from '../../platform/config/index.js';
import type { Database } from '../../platform/database/index.js';
import type {
  Clock,
  CurrentUserDto,
  FeatureLog,
  IdFactory,
  RequestContext,
  ServerDto,
  SessionResolver,
  UserDirectory,
  UserSummary,
  Uuid,
} from '@j-messenger/contracts';

export interface MailAuthenticator {
  authenticate(input: {
    readonly serverId: string;
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
    readonly username: string;
    readonly password: string;
  }): Promise<{
    readonly canonicalUsername: string;
    readonly displayName: string;
  } | null>;
}
export interface IdentityOptions {
  readonly db: Database;
  readonly config: AppConfig;
  readonly clock: Clock;
  readonly idFactory: IdFactory;
  readonly logger?: FeatureLog;
  readonly authenticator?: MailAuthenticator;
  readonly tokenVerifier?: TokenVerifier;
  readonly fetch?: typeof globalThis.fetch;
  readonly tokenBytes?: () => Uint8Array;
  readonly serverAliases?: Readonly<Record<string, readonly string[]>>;
}
export interface LoginResult {
  readonly user: CurrentUserDto;
  readonly credential: string;
  readonly expiresAt: string;
}
export interface IdentityService extends SessionResolver, UserDirectory {
  listServers(): readonly ServerDto[];
  resolveServer(value: string): ServerDto;
  login(
    serverId: string,
    username: string,
    password: string,
    kind?: 'cookie' | 'native',
  ): Promise<LoginResult>;
  get(context: RequestContext): Promise<CurrentUserDto>;
  logout(context: RequestContext): Promise<void>;
  sessionActive(context: RequestContext): boolean;
}
export class IdentityError extends DomainError {
  constructor(
    code:
      | 'bad_request'
      | 'unauthorized'
      | 'forbidden'
      | 'not_found'
      | 'unavailable'
      | 'internal' = 'internal',
  ) {
    super(code);
    this.name = 'IdentityError';
  }
}
interface MailServer {
  id: string;
  host: string;
  port: number;
  secure: boolean;
}
interface SessionRow {
  id: bigint;
  server_id: string;
  user_id: bigint;
  username: string;
  display_name: string;
  expires_at: string;
}
interface JAuthSession {
  readonly expiresAt: number;
  readonly subject: string;
  readonly serverId: RequestContext['serverId'];
  readonly userId: RequestContext['userId'];
  readonly sessionId: RequestContext['sessionId'];
}
const SESSION_TOKEN_BYTES = 32;
const safeEmit = (
  logger: FeatureLog | undefined,
  featureId: string,
  event: string,
  outcome: 'success' | 'rejected' | 'failure',
  requestId: Uuid | undefined,
  fields: Record<string, string | number | boolean | null> = {},
): void => {
  try {
    logger?.emit({
      featureId,
      event,
      outcome,
      ...(requestId ? { requestId } : {}),
      fields,
    });
  } catch {
    /* diagnostics cannot alter auth decisions */
  }
};
const decimal = (value: unknown): string =>
  typeof value === 'bigint' ? value.toString() : String(value);
const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');
const validUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
const validDecimal = (value: string): boolean => /^[1-9][0-9]*$/.test(value);
const defaultAccounts: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = Object.freeze({
  'dev-a': Object.freeze({ alice: 'Alice', bob: 'Bob', carol: 'Carol' }),
  'dev-b': Object.freeze({ mallory: 'Mallory' }),
});
const stableNow = (clock: Clock): Date => {
  const now = clock.now();
  if (!Number.isFinite(now.getTime())) throw new IdentityError('internal');
  return now;
};
const toUser = (
  row: { id: unknown; server_id: string; display_name: string },
  config: AppConfig,
): CurrentUserDto => ({
  id: decimal(row.id) as CurrentUserDto['id'],
  serverId: row.server_id as CurrentUserDto['serverId'],
  displayName: row.display_name,
  enabledFeatures: {
    files: config.features.files,
    receipts: config.features.receipts,
    retention: config.features.retention,
    notifications: false,
    nativeSessions: config.features.nativeSessions,
    developmentAuth: config.authMode === 'development-fixed',
    adminRetention: false,
  },
});
const signCursor = (secret: string, claims: CursorClaims): string => {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
};
interface CursorClaims {
  readonly v: 1;
  readonly serverId: string;
  readonly userId: string;
  readonly after: string;
  readonly expiresAt: number;
}

export async function createIdentityService(
  options: IdentityOptions,
): Promise<IdentityService> {
  const { db, config, clock } = options;
  if (config.mode === 'production' && config.authMode === 'development-fixed')
    throw new IdentityError('unavailable');
  if (
    !Number.isSafeInteger(config.sessionDays) ||
    config.sessionDays < 1 ||
    config.sessionDays > 7
  )
    throw new IdentityError('internal');
  const jAuthMode = config.authMode === 'j-auth';
  const jAuthConfig = jAuthMode ? config.jAuth : undefined;
  const tokenVerifier = jAuthMode
    ? (options.tokenVerifier ??
      (jAuthConfig
        ? createTokenVerifier({
            publicUrl: jAuthConfig.keycloakOrigin,
            ...(options.fetch ? { fetch: options.fetch } : {}),
          })
        : undefined))
    : undefined;
  if (jAuthMode && (!jAuthConfig || !tokenVerifier))
    throw new IdentityError('unavailable');
  const servers: MailServer[] =
    jAuthMode && jAuthConfig
      ? [
          {
            id: jAuthConfig.tenantId,
            host: '',
            port: 0,
            secure: true,
          },
        ]
      : config.mailServers.map((server) => ({
          id: server.id,
          host: server.host,
          port: server.port,
          secure: server.secure,
        }));
  const serverBySelector = new Map<string, MailServer>();
  for (const server of servers) {
    for (const selector of [
      server.id,
      ...(options.serverAliases?.[server.id] ?? []),
    ]) {
      if (!/^[a-z0-9-]{1,32}$/.test(selector) || serverBySelector.has(selector))
        throw new IdentityError('internal');
      serverBySelector.set(selector, server);
    }
  }
  if (config.authMode === 'mail' && !options.authenticator) {
    /* service can still serve sessions; login reports unavailable */
  }
  await db.run(() => {
    for (const server of servers)
      db.prepare(
        'INSERT INTO mail_servers(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name',
      ).run(server.id, server.id);
  });
  const jAuthSessions = new WeakMap<RequestContext, JAuthSession>();
  let nextJAuthSessionId = 0n;
  const cursorKey = config.cursorSigningKey;
  const featuresFor = (row: {
    id: unknown;
    server_id: string;
    display_name: string;
  }): CurrentUserDto => toUser(row, config);
  const sessionRow = (context: RequestContext): SessionRow | undefined =>
    validDecimal(context.sessionId) &&
    validDecimal(context.userId) &&
    /^[a-z0-9-]{1,32}$/.test(context.serverId)
      ? (db
          .prepare(
            `SELECT s.id,s.server_id,s.user_id,u.username,u.display_name,s.expires_at
    FROM sessions s JOIN users u ON u.server_id=s.server_id AND u.id=s.user_id
    WHERE s.id=? AND s.server_id=? AND s.user_id=? AND s.expires_at>?`,
          )
          .get(
            BigInt(context.sessionId),
            context.serverId,
            BigInt(context.userId),
            stableNow(clock).toISOString(),
          ) as SessionRow | undefined)
      : undefined;
  const jAuthSession = (context: RequestContext): JAuthSession | undefined => {
    const session = jAuthSessions.get(context);
    if (
      !session ||
      context.serverId !== session.serverId ||
      context.userId !== session.userId ||
      context.sessionId !== session.sessionId ||
      context.serverId !== jAuthConfig?.tenantId ||
      !validDecimal(context.sessionId) ||
      !validDecimal(context.userId) ||
      !Number.isFinite(session.expiresAt) ||
      session.expiresAt <= stableNow(clock).getTime()
    )
      return undefined;
    return session;
  };
  const userById = (
    serverId: string,
    userId: string,
  ): { id: unknown; server_id: string; display_name: string } | undefined =>
    db
      .prepare(
        'SELECT id,server_id,display_name FROM users WHERE server_id=? AND id=?',
      )
      .get(serverId, BigInt(userId)) as
      { id: unknown; server_id: string; display_name: string } | undefined;
  const authenticate = async (
    server: MailServer,
    username: string,
    password: string,
  ): Promise<{ canonicalUsername: string; displayName: string } | null> => {
    if (options.authenticator && config.authMode === 'mail') {
      try {
        return await options.authenticator.authenticate({
          serverId: server.id,
          host: server.host,
          port: server.port,
          secure: server.secure,
          username,
          password,
        });
      } catch (error) {
        if (error instanceof DomainError && error.code === 'unauthorized')
          return null;
        throw new IdentityError('unavailable');
      }
    }
    if (config.authMode !== 'development-fixed' || config.mode === 'production')
      throw new IdentityError('unavailable');
    const displayName = defaultAccounts[server.id]?.[username];
    return password === 'dev-only' && displayName
      ? { canonicalUsername: username, displayName }
      : null;
  };
  const resolveJAuth = async (input: {
    credential: string;
    requestId: Uuid;
  }): Promise<RequestContext> => {
    if (!jAuthConfig || !tokenVerifier) throw new IdentityError('unavailable');
    let identity: Awaited<ReturnType<TokenVerifier['verify']>>;
    try {
      identity = await tokenVerifier.verify(input.credential, {
        tenantId: jAuthConfig.tenantId,
        audience: 'j-messenger',
      });
    } catch (error) {
      if (error instanceof TokenVerificationError) {
        safeEmit(
          options.logger,
          'F03',
          'identity.session.checked',
          error.kind === 'invalid' ? 'rejected' : 'failure',
          input.requestId,
          {
            reasonCode:
              error.kind === 'invalid' ? 'unauthorized' : 'unavailable',
          },
        );
        throw new IdentityError(
          error.kind === 'invalid' ? 'unauthorized' : 'unavailable',
        );
      }
      safeEmit(
        options.logger,
        'F03',
        'identity.session.checked',
        'failure',
        input.requestId,
        { reasonCode: 'unavailable' },
      );
      throw new IdentityError('unavailable');
    }
    const audience = identity.claims['aud'];
    if (
      audience !== 'j-messenger' &&
      !(
        Array.isArray(audience) &&
        audience.length === 1 &&
        audience[0] === 'j-messenger'
      )
    )
      throw new IdentityError('unauthorized');
    if (!identity.roles.includes('messenger:use')) {
      safeEmit(
        options.logger,
        'F03',
        'identity.session.checked',
        'rejected',
        input.requestId,
        { reasonCode: 'forbidden' },
      );
      throw new IdentityError('forbidden');
    }
    const username = identity.claims['preferred_username'];
    const candidateName = identity.claims['name'];
    const displayName =
      typeof candidateName === 'string' ? candidateName : username;
    if (
      typeof username !== 'string' ||
      username.length < 1 ||
      username.length > 256 ||
      username.trim().length === 0 ||
      /[\u0000-\u001f\u007f\u0080-\u009f]/u.test(username) ||
      typeof displayName !== 'string' ||
      displayName.length < 1 ||
      displayName.length > 128 ||
      /[\u0000-\u001f\u007f\u0080-\u009f]/u.test(displayName) ||
      displayName.trim().length === 0
    )
      throw new IdentityError('unauthorized');

    const now = stableNow(clock);
    const tokenExpiry = identity.claims.exp;
    if (
      typeof tokenExpiry !== 'number' ||
      !Number.isSafeInteger(tokenExpiry) ||
      tokenExpiry * 1000 <= now.getTime()
    )
      throw new IdentityError('unauthorized');
    let user:
      { id: bigint; server_id: string; display_name: string } | undefined;
    try {
      user = await db.run(() => {
        db.prepare(
          `INSERT INTO users(server_id,username,display_name,created_at) VALUES(?,?,?,?)
          ON CONFLICT(server_id,username) DO UPDATE SET display_name=excluded.display_name`,
        ).run(jAuthConfig.tenantId, username, displayName, now.toISOString());
        return db
          .prepare(
            'SELECT id,server_id,display_name FROM users WHERE server_id=? AND username=?',
          )
          .get(jAuthConfig.tenantId, username) as
          { id: bigint; server_id: string; display_name: string } | undefined;
      });
    } catch {
      throw new IdentityError('unavailable');
    }
    if (!user) throw new IdentityError('unavailable');
    const sessionId = (++nextJAuthSessionId).toString();
    const context: RequestContext = Object.freeze({
      serverId: jAuthConfig.tenantId as RequestContext['serverId'],
      userId: decimal(user.id) as RequestContext['userId'],
      sessionId: sessionId as RequestContext['sessionId'],
      requestId: input.requestId,
      authenticatedAt: now.toISOString(),
    });
    jAuthSessions.set(context, {
      expiresAt: Math.min(tokenExpiry * 1000, now.getTime() + 5 * 60_000),
      subject: identity.subject,
      serverId: context.serverId,
      userId: context.userId,
      sessionId: context.sessionId,
    });
    safeEmit(
      options.logger,
      'F03',
      'identity.session.checked',
      'success',
      input.requestId,
      { serverId: context.serverId, userId: context.userId },
    );
    return context;
  };
  return {
    listServers() {
      const result = servers.map((server) => ({
        id: server.id as ServerDto['id'],
        name: server.id,
        aliases: [...(options.serverAliases?.[server.id] ?? [])],
      }));
      safeEmit(
        options.logger,
        'F01',
        'identity.servers.listed',
        'success',
        undefined,
        { count: result.length },
      );
      return result;
    },
    resolveServer(value: string) {
      const server = serverBySelector.get(value);
      if (!server) {
        safeEmit(
          options.logger,
          'F01',
          'identity.servers.resolved',
          'rejected',
          undefined,
          { reasonCode: 'not_found' },
        );
        throw new IdentityError('not_found');
      }
      safeEmit(
        options.logger,
        'F01',
        'identity.servers.resolved',
        'success',
        undefined,
        { serverId: server.id },
      );
      return {
        id: server.id as ServerDto['id'],
        name: server.id,
        aliases: [...(options.serverAliases?.[server.id] ?? [])],
      };
    },
    async login(
      serverId: string,
      username: string,
      password: string,
      kind: 'cookie' | 'native' = 'cookie',
    ) {
      if (jAuthMode) throw new IdentityError('forbidden');
      const server = serverBySelector.get(serverId);
      if (!server) throw new IdentityError('not_found');
      if (
        typeof username !== 'string' ||
        username.length < 1 ||
        username.length > 256 ||
        typeof password !== 'string' ||
        password.length < 1 ||
        password.length > 4096
      )
        throw new IdentityError('unauthorized');
      if (kind === 'native' && !config.features.nativeSessions)
        throw new IdentityError('forbidden');
      let authenticated: {
        canonicalUsername: string;
        displayName: string;
      } | null;
      try {
        authenticated = await authenticate(server, username, password);
      } catch (error) {
        safeEmit(
          options.logger,
          'F02',
          'identity.login.completed',
          'failure',
          undefined,
          { serverId: server.id, reasonCode: 'auth_unavailable' },
        );
        throw error instanceof DomainError
          ? error
          : new IdentityError('unavailable');
      }
      if (!authenticated) {
        safeEmit(
          options.logger,
          'F02',
          'identity.login.completed',
          'rejected',
          undefined,
          { serverId: server.id, reasonCode: 'unauthorized' },
        );
        throw new IdentityError('unauthorized');
      }
      if (
        !authenticated.canonicalUsername ||
        authenticated.canonicalUsername.length > 256 ||
        !authenticated.displayName ||
        authenticated.displayName.length > 128
      )
        throw new IdentityError('unavailable');
      const bytes = options.tokenBytes?.() ?? randomBytes(SESSION_TOKEN_BYTES);
      if (bytes.byteLength !== SESSION_TOKEN_BYTES)
        throw new IdentityError('internal');
      const credential = Buffer.from(bytes).toString('base64url');
      const tokenHash = sha256(credential);
      const now = stableNow(clock);
      const expiresAt = new Date(
        now.getTime() + config.sessionDays * 86_400_000,
      ).toISOString();
      try {
        const saved = await db.run((tx) => {
          db.prepare(
            `INSERT INTO users(server_id,username,display_name,created_at) VALUES(?,?,?,?)
            ON CONFLICT(server_id,username) DO UPDATE SET display_name=excluded.display_name`,
          ).run(
            server.id,
            authenticated!.canonicalUsername,
            authenticated!.displayName,
            now.toISOString(),
          );
          const user = db
            .prepare(
              'SELECT id,server_id,display_name FROM users WHERE server_id=? AND username=?',
            )
            .get(server.id, authenticated!.canonicalUsername) as
            { id: bigint; server_id: string; display_name: string } | undefined;
          if (!user) throw new IdentityError('internal');
          db.prepare(
            'INSERT INTO sessions(server_id,user_id,token_hash,expires_at,kind) VALUES(?,?,?,?,?)',
          ).run(server.id, user.id, tokenHash, expiresAt, kind);
          const sessionId = db.lastInsertId();
          const output = featuresFor(user);
          tx.afterCommit(() =>
            safeEmit(
              options.logger,
              'F02',
              'identity.login.completed',
              'success',
              undefined,
              { serverId: server.id, userId: output.id },
            ),
          );
          return { user: output, sessionId };
        });
        return { user: saved.user, credential, expiresAt };
      } catch (error) {
        safeEmit(
          options.logger,
          'F02',
          'identity.login.completed',
          'failure',
          undefined,
          { serverId: server.id, reasonCode: 'database_failure' },
        );
        throw error instanceof DomainError
          ? error
          : new IdentityError('unavailable');
      }
    },
    async resolve(input: { credential: string; requestId: Uuid }) {
      if (jAuthMode) return resolveJAuth(input);
      if (
        !validUuid(input.requestId) ||
        typeof input.credential !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(input.credential)
      ) {
        safeEmit(
          options.logger,
          'F03',
          'identity.session.checked',
          'rejected',
          validUuid(input.requestId) ? input.requestId : undefined,
          { reasonCode: 'unauthorized' },
        );
        throw new IdentityError('unauthorized');
      }
      const row = db
        .prepare(
          `SELECT s.id,s.server_id,s.user_id,s.expires_at FROM sessions s JOIN users u ON u.server_id=s.server_id AND u.id=s.user_id
        WHERE s.token_hash=? AND s.expires_at>?`,
        )
        .get(sha256(input.credential), stableNow(clock).toISOString()) as
        | { id: bigint; server_id: string; user_id: bigint; expires_at: string }
        | undefined;
      if (!row) {
        safeEmit(
          options.logger,
          'F03',
          'identity.session.checked',
          'rejected',
          input.requestId,
          { reasonCode: 'unauthorized' },
        );
        throw new IdentityError('unauthorized');
      }
      const context = {
        serverId: row.server_id as RequestContext['serverId'],
        userId: decimal(row.user_id) as RequestContext['userId'],
        sessionId: decimal(row.id) as RequestContext['sessionId'],
        requestId: input.requestId,
        authenticatedAt: stableNow(clock).toISOString(),
      };
      safeEmit(
        options.logger,
        'F03',
        'identity.session.checked',
        'success',
        input.requestId,
        { serverId: context.serverId, userId: context.userId },
      );
      return context;
    },
    async get(context: RequestContext) {
      if (jAuthMode) {
        if (!jAuthSession(context)) throw new IdentityError('unauthorized');
        const user = userById(context.serverId, context.userId);
        if (!user) throw new IdentityError('unauthorized');
        return featuresFor(user);
      }
      if (!sessionRow(context)) throw new IdentityError('unauthorized');
      const user = userById(context.serverId, context.userId);
      if (!user) throw new IdentityError('unauthorized');
      return featuresFor(user);
    },
    logout(context: RequestContext) {
      if (jAuthMode) return Promise.reject(new IdentityError('forbidden'));
      if (
        !validDecimal(context.sessionId) ||
        !validDecimal(context.userId) ||
        !/^[a-z0-9-]{1,32}$/.test(context.serverId)
      )
        return Promise.resolve();
      return db.run((tx) => {
        db.assertOwn(tx);
        const changed = db
          .prepare(
            'DELETE FROM sessions WHERE id=? AND server_id=? AND user_id=?',
          )
          .run(
            BigInt(context.sessionId),
            context.serverId,
            BigInt(context.userId),
          );
        const logoutCount =
          changed.changes === 0 || changed.changes === 0n ? 0 : 1;
        tx.afterCommit(() =>
          safeEmit(
            options.logger,
            'F04',
            'identity.logout.completed',
            'success',
            context.requestId,
            {
              serverId: context.serverId,
              userId: context.userId,
              count: logoutCount,
            },
          ),
        );
      });
    },
    sessionActive(context: RequestContext) {
      if (jAuthMode) return Boolean(jAuthSession(context));
      return Boolean(sessionRow(context));
    },
    async requireSameServer(context: RequestContext, userId: string) {
      if (!/^[1-9][0-9]*$/.test(userId)) throw new IdentityError('not_found');
      const row = db
        .prepare('SELECT 1 AS found FROM users WHERE server_id=? AND id=?')
        .get(context.serverId, BigInt(userId));
      if (!row) throw new IdentityError('not_found');
    },
    async listSameServer(
      context: RequestContext,
      cursor: string | null,
      limit: number,
    ) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new IdentityError('bad_request');
      let after = '0';
      if (cursor !== null)
        after = decodeCursor(
          cursor,
          cursorKey,
          context,
          stableNow(clock).getTime(),
        );
      const rows = db
        .prepare(
          'SELECT id,display_name FROM users WHERE server_id=? AND id>? ORDER BY id LIMIT ?',
        )
        .all(context.serverId, BigInt(after), limit + 1) as Array<{
        id: bigint;
        display_name: string;
      }>;
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const nextCursor =
        hasMore && last
          ? signCursor(cursorKey, {
              v: 1,
              serverId: context.serverId,
              userId: context.userId,
              after: decimal(last.id),
              expiresAt: stableNow(clock).getTime() + 15 * 60_000,
            })
          : null;
      safeEmit(
        options.logger,
        'F06',
        'identity.users.listed',
        'success',
        context.requestId,
        {
          serverId: context.serverId,
          userId: context.userId,
          count: page.length,
        },
      );
      return {
        items: page.map((row) => ({
          id: decimal(row.id) as UserSummary['id'],
          displayName: row.display_name,
        })),
        nextCursor,
      };
    },
  };
}

function decodeCursor(
  token: string,
  secret: string,
  context: RequestContext,
  now: number,
): string {
  const parts = token.split('.');
  if (parts.length !== 2) throw new IdentityError('bad_request');
  const expected = createHmac('sha256', secret).update(parts[0]!).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(
      parts[1]!.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    );
  } catch {
    throw new IdentityError('bad_request');
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new IdentityError('bad_request');
  let value: unknown;
  try {
    value = JSON.parse(
      Buffer.from(
        parts[0]!.replace(/-/g, '+').replace(/_/g, '/'),
        'base64',
      ).toString('utf8'),
    );
  } catch {
    throw new IdentityError('bad_request');
  }
  if (typeof value !== 'object' || value === null)
    throw new IdentityError('bad_request');
  const claims = value as Partial<CursorClaims>;
  if (
    claims.v !== 1 ||
    claims.serverId !== context.serverId ||
    claims.userId !== context.userId ||
    typeof claims.after !== 'string' ||
    !/^[1-9][0-9]*$/.test(claims.after) ||
    typeof claims.expiresAt !== 'number' ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.expiresAt <= now
  )
    throw new IdentityError('bad_request');
  return claims.after;
}
