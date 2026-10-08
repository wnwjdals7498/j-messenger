import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/platform/config/index.js';

const tempDirs: string[] = [];
function baseDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'j-messenger-config-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('requires a fixed customer tenant and HTTPS Keycloak origin for j-auth without mail or native login', () => {
    const env = {
      AUTH_MODE: 'j-auth',
      JAUTH_TENANT: 'sample-a',
      KC_PUBLIC_URL: 'https://auth.jgw.test',
    };
    const config = loadConfig(env, baseDir());
    expect(config.jAuth).toEqual({
      tenantId: 'sample-a',
      keycloakOrigin: 'https://auth.jgw.test',
    });
    expect(config.features.nativeSessions).toBe(false);
    expect(Object.isFrozen(config.jAuth)).toBe(true);
    for (const changed of [
      { JAUTH_TENANT: '' },
      { JAUTH_TENANT: 'operator' },
      { JAUTH_TENANT: '../sample-a' },
      { KC_PUBLIC_URL: 'http://auth.jgw.test' },
      { KC_PUBLIC_URL: 'https://outside.test' },
      { KC_PUBLIC_URL: 'https://auth.jgw.test:3001' },
      { KC_PUBLIC_URL: 'https://auth.jgw.test/realms/test' },
      { KC_PUBLIC_URL: 'https://auth.jgw.test?secret=hidden' },
      { PORT: '3001' },
      { HOST: '0.0.0.0' },
    ])
      expect(() => loadConfig({ ...env, ...changed }, baseDir())).toThrow(
        ConfigError,
      );
    const base = baseDir();
    expect(
      loadConfig(
        {
          ...env,
          NODE_ENV: 'production',
          DB_PATH: path.join(base, 'db.sqlite'),
          PUBLIC_ORIGIN: 'https://messenger.jgw.test',
          TLS_CERT_PATH: path.join(base, 'server.crt'),
          TLS_KEY_PATH: path.join(base, 'server.key'),
          CURSOR_SIGNING_KEY: 'x'.repeat(32),
        },
        base,
      ).authMode,
    ).toBe('j-auth');
  });
  it('returns immutable development defaults and independent retention periods', () => {
    const config = loadConfig({}, baseDir());
    expect(config.mode).toBe('development');
    expect(config.host).toBe('localhost');
    expect(config.port).toBe(3000);
    expect(config.publicOrigin).toBe('http://127.0.0.1:3000');
    expect(config.authMode).toBe('development-fixed');
    expect(config.features).toMatchObject({
      files: true,
      receipts: true,
      retention: true,
      notifications: false,
      nativeSessions: true,
    });
    expect(config.fileQuotaBytes).toBe(2_000_000_000);
    expect(config.retentionPolicy).toEqual({ messageDays: 5, fileDays: 14 });
    expect(config.mailServers.map((server) => server.id)).toEqual([
      'dev-a',
      'dev-b',
    ]);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('rejects invalid settings with only the known setting key', () => {
    const base = baseDir();
    const invalids: Array<[Record<string, string>, string]> = [
      [{ PORT: 'nope' }, 'PORT'],
      [{ TEMP_ROOT: 'relative-secret-path' }, 'PATHS'],
      [
        {
          FILE_ROOT: path.join(base, 'data'),
          TEMP_ROOT: path.join(base, 'data', 'tmp'),
        },
        'PATHS',
      ],
      [{ SESSION_DAYS: '8' }, 'SESSION_DAYS'],
      [{ MAIL_SERVERS: 'private-host.example' }, 'MAIL_SERVERS'],
      [{ FEATURE_NOTIFICATIONS: 'true' }, 'FEATURE_NOTIFICATIONS'],
      [{ HOST: '' }, 'HOST'],
      [{ RELEASE: 'unsafe value' }, 'RELEASE'],
      [{ CURSOR_SIGNING_KEY: 'short' }, 'CURSOR_SIGNING_KEY'],
    ];
    for (const [env, key] of invalids) {
      try {
        loadConfig(env, base);
        throw new Error('expected configuration error');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).key).toBe(key);
        expect((error as Error).message).not.toContain('private-host');
        expect((error as Error).message).not.toContain('relative-secret');
      }
    }
  });

  it('requires positive quota when files are enabled and exposes TLS paths when supplied', () => {
    const base = baseDir();
    expect(() =>
      loadConfig({ FEATURE_FILES: 'true', FILE_QUOTA_BYTES: '0' }, base),
    ).toThrow(ConfigError);
    const certPath = path.join(base, 'tls-cert.pem');
    const keyPath = path.join(base, 'tls-key.pem');
    expect(
      loadConfig({ TLS_CERT_PATH: certPath, TLS_KEY_PATH: keyPath }, base).tls,
    ).toEqual({ certPath, keyPath });
    expect(
      loadConfig({ FEATURE_FILES: 'false', FILE_QUOTA_BYTES: '0' }, base)
        .fileQuotaBytes,
    ).toBe(0);
  });

  it('refuses production development auth and missing production prerequisites', () => {
    const base = baseDir();
    const cases = [
      { NODE_ENV: 'production', AUTH_MODE: 'development-fixed' },
      { NODE_ENV: 'production' },
      {
        NODE_ENV: 'production',
        AUTH_MODE: 'mail',
        DB_PATH: path.join(base, 'db.sqlite'),
        TLS_CERT_PATH: path.join(base, 'cert.pem'),
        TLS_KEY_PATH: path.join(base, 'key.pem'),
        CURSOR_SIGNING_KEY: 'x'.repeat(32),
      },
    ];
    for (const env of cases)
      expect(() => loadConfig(env, base)).toThrow(ConfigError);
  });
});
