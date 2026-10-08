import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EventAppend,
  RequestContext,
  TxContext,
  Uuid,
} from '@j-messenger/contracts';
import { createApplication } from '../src/bootstrap/application.js';
import { loadConfig } from '../src/platform/config/index.js';
import { createDatabase } from '../src/platform/database/index.js';
import { MIGRATIONS } from '../src/bootstrap/migrations.js';
import { asStorage } from '../src/platform/storage/index.js';
import {
  PostgresStorage,
  bindPostgresSql,
} from '../src/platform/storage/postgres.js';
import { importSqlite, IMPORT_TABLES } from '../src/bootstrap/import-sqlite.js';

const connectionString = process.env['JMS_TEST_DATABASE_URL']!;
if (
  process.env['JMS_PG_TEST_MARKER'] !== 'isolated-cloud-messenger-pg' ||
  !connectionString
)
  throw new Error('isolated PostgreSQL environment required');
const context: RequestContext = {
  serverId: 'dev-a',
  userId: '1',
  sessionId: '1',
  requestId: randomUUID() as Uuid,
  authenticatedAt: '2026-10-08T00:00:00.000Z',
};
const event = (entityId = '1', serverId = 'dev-a'): EventAppend => ({
  type: 'message.created.v1',
  occurredAt: '2026-10-08T00:00:00.000Z',
  serverId,
  entityId,
  recipientUserIds: ['1'],
  payloadRef: { entityType: 'message', entityId },
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
describe('real PostgreSQL storage and migration', () => {
  let schema: string;
  let root: string;
  let db: PostgresStorage;
  const additional: PostgresStorage[] = [];
  const applications: Awaited<ReturnType<typeof createApplication>>[] = [];
  beforeEach(async () => {
    schema = `test_ms_${randomUUID().replaceAll('-', '')}`;
    root = await mkdtemp(path.join(tmpdir(), 'jm-real-pg-'));
    db = await PostgresStorage.open({ connectionString, schema });
  });
  afterEach(async () => {
    for (const app of applications.splice(0)) await app.close();
    for (const other of additional.splice(0)) await other.close();
    await db.close();
    const pool = new Pool({ connectionString });
    try {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
    await rm(root, { recursive: true, force: true });
  });
  const peer = async () => {
    const other = await PostgresStorage.open({ connectionString, schema });
    additional.push(other);
    return other;
  };
  const start = async (driver: 'sqlite' | 'postgres', directory = root) => {
    const config = loadConfig(
      {
        NODE_ENV: 'development',
        HOST: '127.0.0.1',
        PORT: '54252',
        PUBLIC_ORIGIN: 'http://127.0.0.1:54252',
        CURSOR_SIGNING_KEY: 'postgres-migration-cursor-signing-key',
        ...(driver === 'postgres'
          ? {
              DATABASE_DRIVER: driver,
              DATABASE_URL: connectionString,
              DATABASE_SCHEMA: schema,
            }
          : {}),
      },
      directory,
    );
    const app = await createApplication(config, { maintenance: false });
    applications.push(app);
    return app;
  };
  it('keeps bound values opaque and retains signed 64-bit identifiers', async () => {
    expect(
      bindPostgresSql("SELECT '?' AS a, ? AS b -- ?\n/* ? */ WHERE ?='?'"),
    ).toBe("SELECT '?' AS a, $1 AS b -- ?\n/* ? */ WHERE $2='?'");
    await db.run(async (tx) => {
      await db
        .prepare('INSERT INTO mail_servers(id,name) VALUES(?,?)')
        .run('dev-a', 'dev-a');
      await db
        .prepare(
          'INSERT INTO users(id,server_id,username,display_name,created_at) VALUES(?,?,?,?,?)',
        )
        .run(
          9007199254740993n,
          'dev-a',
          "O'Reilly ? ; DROP TABLE users",
          'display',
          context.authenticatedAt,
        );
      expect(await db.lastInsertId()).toBe('9007199254740993');
      expect(
        (
          await db
            .prepare(
              'SELECT id,username FROM users WHERE server_id=? AND username=?',
            )
            .get('dev-a', "O'Reilly ? ; DROP TABLE users")
        )?.id,
      ).toBe(9007199254740993n);
      await db.eventWriter.append(tx, event('9007199254740993'));
    });
    expect((await db.getStreamMetadata()).lastSequence).toBe('1');
  });
  it('rolls message and outbox writes back together and commits effects only after commit', async () => {
    const calls: string[] = [];
    await db.run(async () => {
      await db
        .prepare('INSERT INTO mail_servers(id,name) VALUES(?,?)')
        .run('dev-a', 'dev-a');
      await db
        .prepare(
          'INSERT INTO users(server_id,username,display_name,created_at) VALUES(?,?,?,?)',
        )
        .run('dev-a', 'alice', 'alice', context.authenticatedAt);
      await db
        .prepare(
          'INSERT INTO conversations(server_id,kind,created_at) VALUES(?,?,?)',
        )
        .run('dev-a', 'group', context.authenticatedAt);
    });
    await expect(
      db.run(async (tx) => {
        await db
          .prepare(
            'INSERT INTO messages(server_id,conversation_id,sender_id,client_message_id,text,created_at) VALUES(?,?,?,?,?,?)',
          )
          .run(
            'dev-a',
            1n,
            1n,
            randomUUID(),
            'rollback-body',
            context.authenticatedAt,
          );
        await db.eventWriter.append(tx, event());
        tx.afterCommit(() => {
          calls.push('rollback');
        });
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');
    expect(
      (await db.prepare('SELECT COUNT(*) AS n FROM messages').get())!.n,
    ).toBe(0n);
    expect(
      (await db.prepare('SELECT COUNT(*) AS n FROM event_outbox').get())!.n,
    ).toBe(0n);
    expect((await db.getStreamMetadata()).lastSequence).toBe('0');
    expect(calls).toEqual([]);
    await db.run(async (tx) => {
      await db.eventWriter.append(tx, event());
      tx.afterCommit(() => {
        calls.push('committed');
      });
    });
    expect(calls).toEqual(['committed']);
    expect((await db.getStreamMetadata()).lastSequence).toBe('2');
  });
  it('serializes two instances before sequence allocation, so a later commit cannot hide an earlier event', async () => {
    const other = await peer();
    const entered = deferred();
    const release = deferred();
    let secondEntered = false;
    const first = db.run(async (tx) => {
      await db.eventWriter.append(tx, event('1'));
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const second = other.run(async (tx) => {
      secondEntered = true;
      await other.eventWriter.append(tx, event('2'));
    });
    try {
      await new Promise((done) => setTimeout(done, 50));
      expect(secondEntered).toBe(false);
      expect(await other.eventReader.highWatermark(context)).toBe('0');
    } finally {
      release.resolve();
    }
    await Promise.all([first, second]);
    expect(
      (await other.eventReader.scan(context, '0', '2', 100)).rows.map(
        (row) => row.entityId,
      ),
    ).toEqual(['1', '2']);
  });
  it('rejects nested, foreign and escaped transaction contexts and retains pruning high watermarks', async () => {
    const other = await peer();
    let escaped!: TxContext;
    await db.run(async (tx) => {
      escaped = tx;
      expect(() => other.assertOwn(tx)).toThrow();
      await expect(db.run(() => 1)).rejects.toThrow();
      await db.eventWriter.append(tx, event());
    });
    expect(() => db.assertOwn(escaped)).toThrow();
    await db.run(async (tx) => {
      await db.advanceConsumerPosition(tx, 'test', '10');
      await db.advanceConsumerPosition(tx, 'test', '9');
      await db.pruneEvents(tx, '1');
    });
    expect(await db.getConsumerPosition('test')).toBe('10');
    expect(await db.getStreamMetadata()).toEqual({
      epoch: '1',
      minValidPosition: '1',
      lastSequence: '1',
    });
    await db.run(async (tx) => {
      await db.eventWriter.append(tx, event('2', 'dev-b'));
    });
    const scan = await db.eventReader.scan(context, '1', '2', 100);
    expect(scan.rows).toEqual([]);
    expect(scan.scannedThrough).toBe('2');
    await expect(db.run((tx) => db.pruneEvents(tx, '3'))).rejects.toThrow();
  });
  it('reopens unchanged migrations and refuses altered checksums and unknown histories', async () => {
    const other = await peer();
    await other.close();
    await db
      .prepare('UPDATE storage_migration_checksums SET checksum=?')
      .run('tampered');
    await expect(
      PostgresStorage.open({ connectionString, schema }),
    ).rejects.toThrow();
    expect(
      (await db.prepare('SELECT COUNT(*) AS n FROM pgmigrations').get())!.n,
    ).toBe(1n);
  });
  it('preserves SQLite message/dedup/cursor/receipt/attachment data, source bytes and future IDs during explicit import', async () => {
    const source = await start('sqlite');
    const alice = await source.identity.login('dev-a', 'alice', 'dev-only');
    const bob = await source.identity.login('dev-a', 'bob', 'dev-only');
    const aliceContext = await source.identity.resolve({
      credential: alice.credential,
      requestId: randomUUID() as Uuid,
    });
    const bobContext = await source.identity.resolve({
      credential: bob.credential,
      requestId: randomUUID() as Uuid,
    });
    const conversation = await source.conversations.create(aliceContext, {
      kind: 'group',
      memberIds: [bob.user.id],
      title: 'preserved',
      clientRequestId: randomUUID() as Uuid,
    });
    const id = conversation.conversation.id;
    const cursor = (await source.sync.ready(aliceContext)).cursor;
    const file = await source.files.prepare(aliceContext, id, {
      filename: 'note.txt',
      contentType: 'txt',
      sizeBytes: null,
      stream: (await import('node:stream')).Readable.from([
        Buffer.from('attachment survives'),
      ]),
    });
    const input = {
      clientMessageId: randomUUID() as Uuid,
      text: 'import body',
      fileIds: [file.id],
    };
    const sent = await source.messages.create(aliceContext, id, input);
    await source.receipts.advance(bobContext, id, sent.message.id);
    await source.db.run(async (tx) => {
      await source.db.advanceConsumerPosition(tx, 'import-proof', '100');
    });
    const prior = await source.db.getStreamMetadata();
    await source.close();
    const sourceFile = path.join(root, 'data/j-messenger.sqlite');
    const before = createHash('sha256')
      .update(await readFile(sourceFile))
      .digest('hex');
    const imported = await importSqlite(sourceFile, db);
    expect(imported.counts.messages).toBe(1);
    expect(imported.counts.files).toBe(1);
    expect(imported.lastSequence).toBe(prior.lastSequence);
    expect(
      createHash('sha256')
        .update(await readFile(sourceFile))
        .digest('hex'),
    ).toBe(before);
    const pg = await start('postgres');
    const resumed = await pg.identity.resolve({
      credential: alice.credential,
      requestId: randomUUID() as Uuid,
    });
    const retry = await pg.messages.create(resumed, id, input);
    expect(retry.created).toBe(false);
    expect(retry.message.id).toBe(sent.message.id);
    expect(
      (await pg.sync.sync(resumed, { after: cursor, limit: 100 })).data.map(
        (item) => item.type,
      ),
    ).toContain('message.created.v1');
    const downloaded = await pg.files.openDownload(resumed, file.id);
    const chunks: Buffer[] = [];
    for await (const chunk of downloaded.stream)
      chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('attachment survives');
    expect(await pg.db.getConsumerPosition('import-proof')).toBe('100');
    const next = await pg.messages.create(resumed, id, {
      clientMessageId: randomUUID() as Uuid,
      text: 'new after import',
    });
    expect(BigInt(next.message.id)).toBeGreaterThan(BigInt(sent.message.id));
    await expect(importSqlite(sourceFile, db)).rejects.toThrow();
  });
  it('retains pruned event sequence holes and rejects unknown SQLite tables without target writes', async () => {
    const raw = createDatabase(path.join(root, 'source.sqlite'), {
      migrations: MIGRATIONS,
    });
    const storage = asStorage(raw);
    await storage.run(async (tx) => {
      await storage.eventWriter.append(tx, event());
      await storage.pruneEvents(tx, '1');
    });
    await storage.close();
    await importSqlite(path.join(root, 'source.sqlite'), db);
    expect(await db.getStreamMetadata()).toEqual({
      epoch: '1',
      minValidPosition: '1',
      lastSequence: '1',
    });
    await db.run(async (tx) => {
      expect(await db.eventWriter.append(tx, event('2'))).toBe('2');
    });
    const unknown = createDatabase(path.join(root, 'unknown.sqlite'), {
      migrations: MIGRATIONS,
    });
    unknown.connection.exec('CREATE TABLE unowned(id INTEGER)');
    unknown.close();
    await expect(
      importSqlite(path.join(root, 'unknown.sqlite'), db),
    ).rejects.toThrow();
    expect(
      (await db.prepare('SELECT COUNT(*) AS n FROM event_outbox').get())!.n,
    ).toBe(1n);
  });
  it('rolls back an import whose target column topology is incompatible', async () => {
    const raw = createDatabase(path.join(root, 'bad.sqlite'), {
      migrations: MIGRATIONS,
    });
    raw
      .prepare('INSERT INTO mail_servers(id,name) VALUES(?,?)')
      .run('dev-a', 'original');
    raw.close();
    await db.prepare('ALTER TABLE files ADD COLUMN incompatible TEXT').run();
    await expect(
      importSqlite(path.join(root, 'bad.sqlite'), db),
    ).rejects.toThrow();
    for (const table of IMPORT_TABLES)
      expect(
        (await db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get())!.n,
      ).toBe(0n);
    expect((await db.getStreamMetadata()).lastSequence).toBe('0');
  });
  it('backs up a real PostgreSQL store without overwriting files and restores its committed cursor state', async () => {
    await db.run(async (tx) => {
      await db.eventWriter.append(tx, event());
      await db.advanceConsumerPosition(tx, 'backup-proof', '100');
    });
    const file = path.join(root, 'storage.dump');
    await db.backup(file);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const digest = createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
    await expect(db.backup(file)).rejects.toThrow();
    expect(
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
    ).toBe(digest);
    await db.close();
    const pool = new Pool({ connectionString });
    try {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
    await promisify(execFile)(
      'pg_restore',
      [
        '--no-owner',
        '--no-acl',
        '--exit-on-error',
        '--dbname',
        'jgw_messenger',
        file,
      ],
      {
        env: {
          ...process.env,
          PGDATABASE: connectionString,
          PGHOST: '127.0.0.1',
          PGPORT: '54240',
          PGUSER: 'jgw_messenger',
          PGPASSWORD: decodeURIComponent(new URL(connectionString).password),
        },
        maxBuffer: 1024,
      },
    );
    db = await PostgresStorage.open({ connectionString, schema });
    expect((await db.getStreamMetadata()).lastSequence).toBe('1');
    expect(await db.getConsumerPosition('backup-proof')).toBe('100');
    expect(
      (await db.eventReader.scan(context, '0', '1', 100)).rows.map(
        (row) => row.entityId,
      ),
    ).toEqual(['1']);
  });
  it('handles simultaneous real HTTP retries across instances and rolls a failed outbox append back before retry', async () => {
    const first = await start('postgres');
    const second = await start('postgres');
    const firstOrigin = await first.app.listen({ host: '127.0.0.1', port: 0 });
    const secondOrigin = await second.app.listen({
      host: '127.0.0.1',
      port: 0,
    });
    const login = async (origin: string, username: string) => {
      const response = await fetch(origin + '/api/v1/native/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          serverId: 'dev-a',
          username,
          password: 'dev-only',
        }),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as {
        data: { credential: string; user: { id: string } };
      };
    };
    const alice = await login(firstOrigin, 'alice');
    const bob = await login(secondOrigin, 'bob');
    const headers = {
      Authorization: `Bearer ${alice.data.credential}`,
      'content-type': 'application/json',
    };
    const conversation = await fetch(firstOrigin + '/api/v1/conversations', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'group',
        memberIds: [bob.data.user.id],
        clientRequestId: randomUUID(),
        title: 'concurrent',
      }),
    });
    expect(conversation.status).toBe(201);
    const id = ((await conversation.json()) as { data: { id: string } }).data
      .id;
    const endpoint = `/api/v1/conversations/${id}/messages`;
    const input = {
      clientMessageId: randomUUID(),
      text: 'same request across processes',
    };
    const fault = vi
      .spyOn(first.db.eventWriter, 'append')
      .mockRejectedValueOnce(new Error('outbox unavailable'));
    try {
      expect(
        (
          await fetch(firstOrigin + endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(input),
          })
        ).status,
      ).toBe(503);
    } finally {
      fault.mockRestore();
    }
    expect(
      (await db.prepare('SELECT COUNT(*) AS n FROM messages').get())!.n,
    ).toBe(0n);
    expect(
      (await db.prepare('SELECT COUNT(*) AS n FROM message_dedup').get())!.n,
    ).toBe(0n);
    const retries = await Promise.all(
      [firstOrigin, secondOrigin].map((origin) =>
        fetch(origin + endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(input),
        }),
      ),
    );
    expect(retries.map((response) => response.status).sort()).toEqual([
      200, 201,
    ]);
    const bodies = await Promise.all(
      retries.map(
        (response) => response.json() as Promise<{ data: { id: string } }>,
      ),
    );
    expect(bodies[0]!.data.id).toBe(bodies[1]!.data.id);
    expect(
      (await db.prepare('SELECT COUNT(*) AS n FROM messages').get())!.n,
    ).toBe(1n);
    expect(
      (await db
        .prepare(
          "SELECT COUNT(*) AS n FROM event_outbox WHERE type='message.created.v1'",
        )
        .get())!.n,
    ).toBe(1n);
    expect(
      (
        await fetch(secondOrigin + endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...input, text: 'different' }),
        })
      ).status,
    ).toBe(409);
    const otherTenant = await fetch(firstOrigin + '/api/v1/native/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        serverId: 'dev-b',
        username: 'mallory',
        password: 'dev-only',
      }),
    });
    expect(otherTenant.status).toBe(201);
    const otherToken = (
      (await otherTenant.json()) as { data: { credential: string } }
    ).data.credential;
    expect(
      (
        await fetch(secondOrigin + endpoint, {
          headers: { Authorization: `Bearer ${otherToken}` },
        })
      ).status,
    ).toBe(404);
  });
});
