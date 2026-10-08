import path from 'node:path';
import { DomainError } from '@j-messenger/contracts';

export type RuntimeMode = 'development' | 'test' | 'production';
export type AuthMode = 'mail' | 'development-fixed' | 'j-auth';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type ConfigKey =
  | 'NODE_ENV'
  | 'HOST'
  | 'PORT'
  | 'PUBLIC_ORIGIN'
  | 'PATHS'
  | 'DB_PATH'
  | 'DATABASE_DRIVER'
  | 'DATABASE_URL'
  | 'DATABASE_SCHEMA'
  | 'AUTH_MODE'
  | 'JAUTH_TENANT'
  | 'KC_PUBLIC_URL'
  | 'SESSION_DAYS'
  | 'SECURE_COOKIES'
  | 'CURSOR_SIGNING_KEY'
  | 'TLS_CERT_PATH'
  | 'TLS_KEY_PATH'
  | 'MAIL_ADAPTER'
  | 'MAIL_SERVERS'
  | 'LOG_LEVEL'
  | 'RELEASE'
  | 'FEATURE_FILES'
  | 'FEATURE_NOTIFICATIONS'
  | 'FILE_QUOTA_BYTES'
  | 'FEATURES';

export class ConfigError extends DomainError {
  constructor(readonly key: ConfigKey) {
    super('bad_request', '서버 설정이 올바르지 않습니다.');
    this.name = 'ConfigError';
  }
}

export interface AppConfig {
  readonly mode: RuntimeMode;
  readonly host: string;
  readonly port: number;
  readonly publicOrigin: string;
  readonly dbPath: string;
  readonly databaseDriver: 'sqlite' | 'postgres';
  readonly databaseUrl?: string;
  readonly databaseSchema?: string;
  readonly fileRoot: string;
  readonly tempRoot: string;
  readonly webDist: string;
  readonly backupRoot: string;
  readonly tls: Readonly<{ certPath: string; keyPath: string }> | null;
  readonly authMode: AuthMode;
  readonly jAuth?: Readonly<{ tenantId: string; keycloakOrigin: string }>;
  readonly sessionDays: number;
  readonly secureCookies: boolean;
  readonly cursorSigningKey: string;
  readonly release: string;
  readonly logLevel: LogLevel;
  readonly mailServers: readonly {
    readonly id: string;
    readonly tenantId: string;
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
  }[];
  readonly features: Readonly<{
    files: boolean;
    receipts: boolean;
    retention: boolean;
    notifications: boolean;
    nativeSessions: boolean;
  }>;
  readonly fileQuotaBytes: number;
  readonly retentionPolicy: Readonly<{ messageDays: 5; fileDays: 14 }>;
}

const fail = (key: ConfigKey): never => {
  throw new ConfigError(key);
};
const bool = (
  value: string | undefined,
  fallback: boolean,
  key: ConfigKey,
): boolean =>
  value === undefined
    ? fallback
    : value === 'true'
      ? true
      : value === 'false'
        ? false
        : fail(key);
const integer = (
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  key: ConfigKey,
): number => {
  if (value === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return fail(key);
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max
    ? number
    : fail(key);
};
const absolute = (
  value: string | undefined,
  fallback: string,
  key: ConfigKey,
): string => {
  const candidate = value ?? fallback;
  if (!path.isAbsolute(candidate)) return fail(key);
  return path.resolve(candidate);
};

export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  baseDir = process.cwd(),
): AppConfig {
  const mode = env['NODE_ENV'] ?? 'development';
  if (!['development', 'test', 'production'].includes(mode))
    return fail('NODE_ENV');
  const typedMode = mode as RuntimeMode;
  const base = path.resolve(baseDir);
  const host = env['HOST'] ?? 'localhost';
  if (
    !host ||
    host.length > 253 ||
    !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\[[0-9a-fA-F:]+\])$/.test(
      host,
    )
  )
    return fail('HOST');
  const port = integer(env['PORT'], 3000, 1, 65535, 'PORT');
  const publicOrigin = env['PUBLIC_ORIGIN'] ?? 'http://127.0.0.1:3000';
  let origin: URL;
  try {
    origin = new URL(publicOrigin);
  } catch {
    return fail('PUBLIC_ORIGIN');
  }
  if (
    origin.origin !== publicOrigin ||
    !['http:', 'https:'].includes(origin.protocol) ||
    (typedMode === 'production' && origin.protocol !== 'https:')
  )
    return fail('PUBLIC_ORIGIN');

  const authMode =
    env['AUTH_MODE'] ??
    (typedMode === 'production' ? 'mail' : 'development-fixed');
  if (!['mail', 'development-fixed', 'j-auth'].includes(authMode))
    return fail('AUTH_MODE');
  if (typedMode === 'production' && authMode === 'development-fixed')
    return fail('AUTH_MODE');
  let jAuth: AppConfig['jAuth'];
  if (authMode === 'j-auth') {
    if (!['127.0.0.1', 'localhost'].includes(host)) return fail('HOST');
    const tenantId = env['JAUTH_TENANT'];
    if (
      !tenantId ||
      !/^[a-z][a-z0-9-]{2,30}$/.test(tenantId) ||
      tenantId === 'operator'
    )
      return fail('JAUTH_TENANT');
    let keycloak: URL;
    try {
      keycloak = new URL(env['KC_PUBLIC_URL'] ?? '');
    } catch {
      return fail('KC_PUBLIC_URL');
    }
    if (
      keycloak.protocol !== 'https:' ||
      !keycloak.hostname.endsWith('.jgw.test') ||
      keycloak.port === '3001' ||
      keycloak.username ||
      keycloak.password ||
      keycloak.search ||
      keycloak.hash ||
      keycloak.pathname !== '/'
    )
      return fail('KC_PUBLIC_URL');
    jAuth = Object.freeze({ tenantId, keycloakOrigin: keycloak.origin });
    if (port === 3001 || origin.port === '3001') return fail('PORT');
  }
  const secureCookies = bool(
    env['SECURE_COOKIES'],
    typedMode === 'production',
    'SECURE_COOKIES',
  );
  if (typedMode === 'production' && !secureCookies)
    return fail('SECURE_COOKIES');

  const databaseDriver = env['DATABASE_DRIVER'] ?? 'sqlite';
  if (!['sqlite', 'postgres'].includes(databaseDriver))
    return fail('DATABASE_DRIVER');
  let databaseUrl: string | undefined;
  const databaseSchema = env['DATABASE_SCHEMA'] ?? 'public';
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(databaseSchema) ||
    (databaseDriver !== 'postgres' && env['DATABASE_SCHEMA'])
  )
    return fail('DATABASE_SCHEMA');
  if (databaseDriver === 'postgres') {
    try {
      const parsed = new URL(env['DATABASE_URL'] ?? '');
      if (
        !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
        !['localhost', '127.0.0.1'].includes(parsed.hostname) ||
        !parsed.username ||
        !parsed.password ||
        parsed.pathname !== '/jgw_messenger' ||
        parsed.port === '3001' ||
        parsed.search ||
        parsed.hash
      )
        return fail('DATABASE_URL');
      databaseUrl = parsed.href;
    } catch {
      return fail('DATABASE_URL');
    }
  } else if (env['DATABASE_URL']) return fail('DATABASE_DRIVER');
  if (
    typedMode === 'production' &&
    databaseDriver === 'sqlite' &&
    !env['DB_PATH']
  )
    return fail('DB_PATH');
  const paths = {
    dbPath: absolute(
      env['DB_PATH'],
      path.join(base, 'data', 'j-messenger.sqlite'),
      'DB_PATH',
    ),
    fileRoot: absolute(
      env['FILE_ROOT'],
      path.join(base, 'data', 'files'),
      'PATHS',
    ),
    tempRoot: absolute(
      env['TEMP_ROOT'],
      path.join(base, 'data', 'tmp'),
      'PATHS',
    ),
    webDist: absolute(
      env['WEB_DIST'],
      path.join(base, 'apps', 'web', 'dist'),
      'PATHS',
    ),
    backupRoot: absolute(
      env['BACKUP_ROOT'],
      path.join(base, 'data', 'backups'),
      'PATHS',
    ),
  };
  const dirs = [
    paths.fileRoot,
    paths.tempRoot,
    paths.webDist,
    paths.backupRoot,
  ];
  const windows = process.platform === 'win32';
  const comparePath = (value: string): string =>
    windows ? value.toLocaleLowerCase('en-US') : value;
  const overlaps = (a: string, b: string): boolean => {
    const left = comparePath(a);
    const right = comparePath(b);
    return (
      left === right ||
      left.startsWith(`${right}${path.sep}`) ||
      right.startsWith(`${left}${path.sep}`)
    );
  };
  for (let i = 0; i < dirs.length; i++)
    for (let j = i + 1; j < dirs.length; j++)
      if (overlaps(dirs[i]!, dirs[j]!)) return fail('PATHS');
  if (dirs.some((dir) => overlaps(dir, paths.dbPath))) return fail('PATHS');

  const cursorSigningKey =
    env['CURSOR_SIGNING_KEY'] ??
    (typedMode === 'production' ? '' : 'development-only-cursor-key-change-me');
  if (!/^[\x21-\x7e]{32,256}$/.test(cursorSigningKey))
    return fail('CURSOR_SIGNING_KEY');
  const cert = env['TLS_CERT_PATH'];
  const key = env['TLS_KEY_PATH'];
  if (Boolean(cert) !== Boolean(key))
    return fail(cert ? 'TLS_KEY_PATH' : 'TLS_CERT_PATH');
  if (typedMode === 'production' && !cert) return fail('TLS_CERT_PATH');
  const tls =
    cert && key
      ? Object.freeze({
          certPath: absolute(cert, cert, 'TLS_CERT_PATH'),
          keyPath: absolute(key, key, 'TLS_KEY_PATH'),
        })
      : null;
  if (typedMode === 'production' && authMode === 'mail' && !env['MAIL_ADAPTER'])
    return fail('MAIL_ADAPTER');

  const level = env['LOG_LEVEL'] ?? 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(level))
    return fail('LOG_LEVEL');
  const release = env['RELEASE'] ?? 'dev';
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(release)) return fail('RELEASE');
  const serverNames = (
    env['MAIL_SERVERS'] ?? (typedMode === 'production' ? '' : 'dev-a,dev-b')
  )
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (
    (typedMode !== 'production' && serverNames.length === 0) ||
    serverNames.some((name) => !['dev-a', 'dev-b'].includes(name)) ||
    new Set(serverNames).size !== serverNames.length
  )
    return fail('MAIL_SERVERS');
  const mailServers = (jAuth ? [jAuth.tenantId] : serverNames).map((id) => ({
    id,
    tenantId: id,
    host: `${id}.invalid`,
    port: 993,
    secure: true,
  }));
  const features = Object.freeze({
    files: bool(
      env['FEATURE_FILES'],
      typedMode === 'development',
      'FEATURE_FILES',
    ),
    receipts: bool(
      env['FEATURE_RECEIPTS'],
      typedMode === 'development',
      'FEATURES',
    ),
    retention: bool(
      env['FEATURE_RETENTION'],
      typedMode === 'development',
      'FEATURES',
    ),
    notifications: bool(
      env['FEATURE_NOTIFICATIONS'],
      false,
      'FEATURE_NOTIFICATIONS',
    ),
    nativeSessions:
      authMode !== 'j-auth' &&
      bool(
        env['FEATURE_NATIVE_SESSIONS'],
        typedMode === 'development',
        'FEATURES',
      ),
  });
  if (features.notifications) return fail('FEATURE_NOTIFICATIONS');
  const fileQuotaBytes = integer(
    env['FILE_QUOTA_BYTES'],
    typedMode === 'development' ? 2_000_000_000 : 0,
    0,
    Number.MAX_SAFE_INTEGER,
    'FILE_QUOTA_BYTES',
  );
  if (features.files && fileQuotaBytes === 0) return fail('FILE_QUOTA_BYTES');

  return Object.freeze({
    mode: typedMode,
    host,
    port,
    publicOrigin,
    ...paths,
    databaseDriver: databaseDriver as 'sqlite' | 'postgres',
    ...(databaseUrl ? { databaseUrl } : {}),
    ...(databaseDriver === 'postgres' ? { databaseSchema } : {}),
    tls,
    authMode: authMode as AuthMode,
    ...(jAuth ? { jAuth } : {}),
    sessionDays: integer(env['SESSION_DAYS'], 7, 1, 7, 'SESSION_DAYS'),
    secureCookies,
    cursorSigningKey,
    release,
    logLevel: level as LogLevel,
    mailServers: Object.freeze(
      mailServers.map((server) => Object.freeze(server)),
    ),
    features,
    fileQuotaBytes,
    retentionPolicy: Object.freeze({
      messageDays: 5 as const,
      fileDays: 14 as const,
    }),
  });
}
