import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/platform/config/index.js';
import { createDatabase } from '../../src/platform/database/index.js';
import type { Database } from '../../src/platform/database/index.js';
import { createLogger } from '../../src/platform/logging/index.js';
import { MIGRATIONS } from '../../src/bootstrap/migrations.js';
import {
  createIdentityService,
  type IdentityError,
  type IdentityService,
  type MailAuthenticator,
} from '../../src/modules/identity/index.js';
import type {
  Clock,
  IdFactory,
  RequestContext,
  Uuid,
} from '@j-messenger/contracts';

class TestClock implements Clock {
  value = new Date('2026-10-02T00:00:00.000Z');
  now(): Date {
    return new Date(this.value);
  }
  advance(ms: number): void {
    this.value = new Date(this.value.getTime() + ms);
  }
}
class TestIds implements IdFactory {
  private next = 1;
  uuid(): Uuid {
    return `00000000-0000-4000-8000-${String(this.next++).padStart(12, '0')}` as Uuid;
  }
}
const newConfig = (base: string) =>
  loadConfig(
    {
      NODE_ENV: 'development',
      CURSOR_SIGNING_KEY: 'identity-test-signing-key-with-more-than-32-chars',
    },
    base,
  );

describe('identity module', () => {
  let dir: string;
  let db: Database;
  let clock: TestClock;
  let ids: TestIds;
  let identity: IdentityService;
  let tokenByte = 1;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jm-identity-'));
    clock = new TestClock();
    ids = new TestIds();
    db = createDatabase(path.join(dir, 'identity.sqlite'), {
      migrations: MIGRATIONS,
      clock,
    });
    identity = await createIdentityService({
      db,
      config: newConfig(dir),
      clock,
      idFactory: ids,
      tokenBytes: () => new Uint8Array(32).fill(tokenByte++),
      serverAliases: { 'dev-a': ['primary'] },
    });
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const login = (user: string, password = 'dev-only', server = 'dev-a') =>
    identity.login(server, user, password);

  it('registers only servers, exposes safe aliases, then upserts real login users with hashed credentials', async () => {
    expect(db.prepare('SELECT count(*) AS n FROM users').get()!.n).toBe(0n);
    expect(identity.resolveServer('primary').id).toBe('dev-a');
    const alice = await login('alice');
    const repeated = await login('alice');
    const bob = await login('bob');
    expect(alice.user.id).toBe(repeated.user.id);
    expect(alice.user.id).not.toBe(bob.user.id);
    expect(alice.user).toMatchObject({
      serverId: 'dev-a',
      displayName: 'Alice',
      enabledFeatures: {
        developmentAuth: true,
        adminRetention: false,
        notifications: false,
      },
    });
    const actual = db
      .prepare('SELECT token_hash FROM sessions ORDER BY id LIMIT 1')
      .get() as { token_hash: string };
    expect(actual.token_hash).toBe(
      createHash('sha256').update(alice.credential).digest('hex'),
    );
    expect(actual.token_hash).not.toBe(alice.credential);
    expect(db.prepare('SELECT count(*) AS n FROM users').get()!.n).toBe(2n);
    expect(identity.listServers()).toEqual([
      { id: 'dev-a', name: 'dev-a', aliases: ['primary'] },
      { id: 'dev-b', name: 'dev-b', aliases: [] },
    ]);
  });

  it('uses identical public errors for unknown users and wrong passwords, and never tries unknown server selectors', async () => {
    const errors: unknown[] = [];
    for (const input of [
      ['unknown', 'dev-only', 'dev-a'],
      ['alice', 'wrong', 'dev-a'],
      ['alice', 'dev-only', 'not-registered'],
    ]) {
      try {
        await identity.login(input[2]!, input[0]!, input[1]!);
      } catch (error) {
        errors.push(error);
      }
    }
    expect(errors).toHaveLength(3);
    expect(errors.map((error) => (error as IdentityError).code)).toEqual([
      'unauthorized',
      'unauthorized',
      'not_found',
    ]);
    expect(db.prepare('SELECT count(*) AS n FROM users').get()!.n).toBe(0n);
    let calls = 0;
    const adapter: MailAuthenticator = {
      async authenticate() {
        calls++;
        return null;
      },
    };
    await expect(
      createIdentityService({
        db,
        config: { ...newConfig(dir), authMode: 'mail' },
        clock,
        idFactory: ids,
        authenticator: adapter,
        tokenBytes: () => new Uint8Array(32),
      }).then((service) => service.login('missing', 'alice', 'pw')),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(calls).toBe(0);
  });

  it('rolls user upsert back when session persistence fails', async () => {
    db.connection.exec('DROP TABLE sessions');
    await expect(login('alice')).rejects.toMatchObject({ code: 'unavailable' });
    expect(db.prepare('SELECT count(*) AS n FROM users').get()!.n).toBe(0n);
  });

  it('creates and resolves 32-byte credentials, rejects tampered or expired sessions, and logout is idempotent', async () => {
    const logged = await login('alice');
    expect(Buffer.from(logged.credential, 'base64url')).toHaveLength(32);
    const requestId = ids.uuid();
    const context = await identity.resolve({
      credential: logged.credential,
      requestId,
    });
    expect(context).toMatchObject({
      serverId: 'dev-a',
      userId: logged.user.id,
      requestId,
    });
    expect(await identity.get(context)).toEqual(logged.user);
    expect(identity.sessionActive(context)).toBe(true);
    await expect(
      identity.resolve({
        credential: `${logged.credential.slice(0, -1)}x`,
        requestId,
      }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    const forged = {
      ...context,
      userId: '99999999999999999' as RequestContext['userId'],
    };
    expect(identity.sessionActive(forged)).toBe(false);
    await expect(identity.get(forged)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    const wrongServer = {
      ...context,
      serverId: 'dev-b' as RequestContext['serverId'],
    };
    expect(identity.sessionActive(wrongServer)).toBe(false);
    await expect(identity.get(wrongServer)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(
      identity.sessionActive({
        ...context,
        sessionId: 'bad' as RequestContext['sessionId'],
      }),
    ).toBe(false);
    await identity.logout({
      ...context,
      sessionId: 'bad' as RequestContext['sessionId'],
    });
    await identity.logout(context);
    await identity.logout(context);
    expect(identity.sessionActive(context)).toBe(false);
    await expect(
      identity.resolve({ credential: logged.credential, requestId }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    const expired = await login('bob');
    const expiredContext = await identity.resolve({
      credential: expired.credential,
      requestId,
    });
    clock.advance(8 * 86_400_000);
    expect(identity.sessionActive(expiredContext)).toBe(false);
    await expect(
      identity.resolve({ credential: expired.credential, requestId }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('pages only same-server users with signed cursors bound to server and requester', async () => {
    const a = await login('alice');
    await login('bob');
    const b = await login('mallory', 'dev-only', 'dev-b');
    const contextA = await identity.resolve({
      credential: a.credential,
      requestId: ids.uuid(),
    });
    const page = await identity.listSameServer(contextA, null, 1);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    const next = await identity.listSameServer(contextA, page.nextCursor, 1);
    expect(next.items).toHaveLength(1);
    expect(next.items[0]?.id).not.toBe(page.items[0]?.id);
    const contextB = await identity.resolve({
      credential: b.credential,
      requestId: ids.uuid(),
    });
    await expect(
      identity.listSameServer(contextB, page.nextCursor, 1),
    ).rejects.toMatchObject({ code: 'bad_request' });
    const altered = `${page.nextCursor!.slice(0, -1)}${page.nextCursor!.endsWith('a') ? 'b' : 'a'}`;
    await expect(
      identity.listSameServer(contextA, altered, 1),
    ).rejects.toMatchObject({ code: 'bad_request' });
    clock.advance(16 * 60_000);
    await expect(
      identity.listSameServer(contextA, page.nextCursor, 1),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      identity.requireSameServer(contextA, b.user.id),
    ).rejects.toMatchObject({ code: 'not_found' });
    await identity.requireSameServer(contextA, a.user.id);
  });

  it('keeps database identity and session IDs as exact decimal strings above Number precision', async () => {
    db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('users',?)").run(
      9007199254740992n,
    );
    const logged = await login('alice');
    expect(logged.user.id).toBe('9007199254740993');
    const context = await identity.resolve({
      credential: logged.credential,
      requestId: ids.uuid(),
    });
    expect(context.userId).toBe(logged.user.id);
    expect(await identity.get(context)).toEqual(logged.user);
  });

  it('fails closed for fixed auth in production and for mail auth without an adapter', async () => {
    const production = {
      ...newConfig(dir),
      mode: 'production' as const,
      authMode: 'development-fixed' as const,
    };
    await expect(
      createIdentityService({ db, config: production, clock, idFactory: ids }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    const mail = await createIdentityService({
      db,
      config: { ...newConfig(dir), authMode: 'mail' },
      clock,
      idFactory: ids,
    });
    await expect(
      mail.login('dev-a', 'alice', 'dev-only'),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(db.prepare('SELECT count(*) AS n FROM users').get()!.n).toBe(0n);
  });

  it('emits only safe identity log fields', async () => {
    const records: Readonly<Record<string, unknown>>[] = [];
    const logger = createLogger({
      release: 'test',
      module: 'server',
      level: 'debug',
      sink: (record) => records.push(record),
    });
    identity = await createIdentityService({
      db,
      config: newConfig(dir),
      clock,
      idFactory: ids,
      logger,
      tokenBytes: () => new Uint8Array(32).fill(77),
    });
    const logged = await login('alice');
    const context = await identity.resolve({
      credential: logged.credential,
      requestId: ids.uuid(),
    });
    await identity.logout(context);
    await identity.listSameServer(context, null, 10);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const output = JSON.stringify(records);
    expect(output).toContain('identity.login.completed');
    expect(output).toContain('identity.session.checked');
    expect(output).toContain('identity.logout.completed');
    expect(output).toContain('identity.users.listed');
    for (const secret of [
      'alice',
      'dev-only',
      logged.credential,
      createHash('sha256').update(logged.credential).digest('hex'),
      'identity.sqlite',
    ])
      expect(output).not.toContain(secret);
    expect(output).not.toContain('logging.entry.dropped');
  });
});
