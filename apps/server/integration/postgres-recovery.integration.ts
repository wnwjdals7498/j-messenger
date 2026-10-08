import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RequestContext, Uuid } from '@j-messenger/contracts';
import { createApplication } from '../src/bootstrap/application.js';
import {
  finalizePostgresRecovery,
  postgresBackupReferences,
} from '../src/bootstrap/postgres-recovery.js';
import { loadConfig } from '../src/platform/config/index.js';
import { createCursorCodec } from '../src/modules/sync/index.js';
import {
  createPostgresOfflineBackup,
  restorePostgresOfflineBackup,
  verifyPostgresOfflineBackup,
} from '../src/platform/operations/postgres-offline.js';

const connectionString = process.env['JMS_TEST_DATABASE_URL']!;
if (
  process.env['JMS_PG_TEST_MARKER'] !== 'isolated-cloud-messenger-pg' ||
  !connectionString
)
  throw new Error('isolated PostgreSQL environment required');

const cursorKey = 'postgres-recovery-test-cursor-key-at-least-32-bytes';
const testContext: RequestContext = {
  serverId: 'dev-a',
  userId: '1',
  sessionId: '1',
  requestId: randomUUID() as Uuid,
  authenticatedAt: '2026-10-08T00:00:00.000Z',
};
const lockState = { held: false };
const operationLock = {
  async acquire() {
    if (lockState.held) throw new Error('recovery operation already running');
    lockState.held = true;
    return async () => {
      lockState.held = false;
    };
  },
};

describe('isolated PostgreSQL file-aware recovery', () => {
  let root = '';
  let schema = '';
  let runtime: Awaited<ReturnType<typeof createApplication>> | undefined;
  let backupDir = '';
  let objectKey = '';
  let expiredObjectKey = '';
  let orphanObjectKey = '';
  let oldEpoch = '';
  let config: ReturnType<typeof loadConfig>;
  let beforeRestoreSessionCount = 0;

  const startOfflineRuntime = async () => {
    runtime = await createApplication(config, { maintenance: false });
    return runtime;
  };
  const assertStopped = async () =>
    Boolean(runtime && !runtime.app.server.listening);
  const liveFilePath = (key: string) =>
    path.join(config.fileRoot, key.slice(0, 2), key);
  const writeLiveFile = async (key: string, contents: Buffer | string) => {
    const target = liveFilePath(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  };
  const baseOptions = () => {
    if (!runtime) throw new Error('offline runtime is unavailable');
    const initial = runtime;
    return {
      db: initial.db,
      connectionString,
      schema,
      fileRoot: config.fileRoot,
      backupRoot: config.backupRoot,
      workspaceRoot: root,
      assertServiceStopped: assertStopped,
      operationLock,
      listFileReferences: (db: typeof initial.db) => {
        if (!runtime || db !== runtime.db)
          throw new Error('file owner is bound to another database');
        return postgresBackupReferences(runtime);
      },
    };
  };

  beforeEach(async () => {
    schema = `test_recovery_${randomUUID().replaceAll('-', '')}`;
    root = await mkdtemp(path.join(tmpdir(), 'jm-pg-recovery-'));
    const fileRoot = path.join(root, 'files');
    const tempRoot = path.join(root, 'tmp');
    const backupRoot = path.join(root, 'backups');
    await Promise.all([mkdir(fileRoot), mkdir(tempRoot), mkdir(backupRoot)]);
    config = loadConfig(
      {
        NODE_ENV: 'development',
        HOST: '127.0.0.1',
        PORT: '54252',
        PUBLIC_ORIGIN: 'http://127.0.0.1:54252',
        CURSOR_SIGNING_KEY: cursorKey,
        DATABASE_DRIVER: 'postgres',
        DATABASE_URL: connectionString,
        DATABASE_SCHEMA: schema,
        MAIL_SERVERS: 'dev-a',
        FEATURE_FILES: 'true',
        FEATURE_RETENTION: 'true',
        FILE_ROOT: fileRoot,
        TEMP_ROOT: tempRoot,
        BACKUP_ROOT: backupRoot,
        WEB_DIST: path.resolve('apps/web/dist'),
      },
      root,
    );
    lockState.held = false;
    runtime = await startOfflineRuntime();
    objectKey = randomUUID();
    expiredObjectKey = randomUUID();
    orphanObjectKey = randomUUID();
    const now = Date.parse('2026-10-08T00:00:00.000Z');
    const createdMessageAt = new Date(now - 6 * 86_400_000).toISOString();
    const createdFileAt = new Date(now - 7 * 86_400_000).toISOString();
    const expiresFileAt = new Date(now + 7 * 86_400_000).toISOString();
    const body = Buffer.from('valid fourteen-day attachment');
    const sha256 = createHash('sha256').update(body).digest('hex');
    await writeLiveFile(objectKey, body);
    await writeLiveFile(orphanObjectKey, 'unreferenced local object');
    const expiredBody = Buffer.from('expired attachment');
    const expiredSha256 = createHash('sha256')
      .update(expiredBody)
      .digest('hex');
    await writeLiveFile(expiredObjectKey, expiredBody);
    const tokenHash = createHash('sha256').update(randomUUID()).digest('hex');
    await runtime.db.run(async () => {
      await runtime!.db
        .prepare(
          'INSERT INTO users(id,server_id,username,display_name,created_at) VALUES(?,?,?,?,?)',
        )
        .run(1n, 'dev-a', 'alice', 'Alice', createdMessageAt);
      await runtime!.db
        .prepare(
          'INSERT INTO conversations(id,server_id,kind,title,created_at) VALUES(?,?,?,?,?)',
        )
        .run(1n, 'dev-a', 'group', 'recovery', createdMessageAt);
      await runtime!.db
        .prepare(
          'INSERT INTO members(server_id,conversation_id,user_id) VALUES(?,?,?)',
        )
        .run('dev-a', 1n, 1n);
      await runtime!.db
        .prepare(
          'INSERT INTO sessions(id,server_id,user_id,token_hash,expires_at,kind) VALUES(?,?,?,?,?,?)',
        )
        .run(
          1n,
          'dev-a',
          1n,
          tokenHash,
          new Date(now + 86_400_000).toISOString(),
          'cookie',
        );
      await runtime!.db
        .prepare(
          'INSERT INTO files(id,server_id,owner_user_id,conversation_id,filename,mime_type,size_bytes,object_key,sha256,state,created_at,expires_at,message_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          objectKey,
          'dev-a',
          1n,
          1n,
          'fixture.txt',
          'text/plain',
          body.length,
          objectKey,
          sha256,
          'attached',
          createdFileAt,
          expiresFileAt,
          1n,
        );
      await runtime!.db
        .prepare(
          'INSERT INTO files(id,server_id,owner_user_id,conversation_id,filename,mime_type,size_bytes,object_key,sha256,state,created_at,expires_at,message_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          expiredObjectKey,
          'dev-a',
          1n,
          1n,
          'old.txt',
          'text/plain',
          expiredBody.length,
          expiredObjectKey,
          expiredSha256,
          'attached',
          new Date(now - 15 * 86_400_000).toISOString(),
          new Date(now - 86_400_000).toISOString(),
          1n,
        );
      await runtime!.db
        .prepare(
          'INSERT INTO messages(id,server_id,conversation_id,sender_id,client_message_id,text,created_at) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          1n,
          'dev-a',
          1n,
          1n,
          randomUUID(),
          'must expire after five days',
          createdMessageAt,
        );
      await runtime!.db
        .prepare(
          'INSERT INTO message_files(server_id,message_id,file_id) VALUES(?,?,?)',
        )
        .run('dev-a', 1n, objectKey);
      await runtime!.db
        .prepare(
          'INSERT INTO message_files(server_id,message_id,file_id) VALUES(?,?,?)',
        )
        .run('dev-a', 1n, expiredObjectKey);
      await runtime!.db
        .prepare(
          'INSERT INTO retention_policies(server_id,message_days,file_days,version,updated_at) VALUES(?,?,?,?,?)',
        )
        .run('dev-a', 30n, 30n, 8n, createdMessageAt);
    });
    await runtime.db.run((tx) => runtime!.db.rotateStreamEpoch(tx));
    oldEpoch = (await runtime.db.getStreamMetadata()).epoch;
    beforeRestoreSessionCount = Number(
      (await runtime.db.prepare('SELECT COUNT(*) AS n FROM sessions').get())!.n,
    );
  });

  afterEach(async () => {
    if (runtime) await runtime.close().catch(() => {});
    runtime = undefined;
    if (schema) {
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString });
      try {
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    }
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
  });

  it('restores attachments and reapplies five/fourteen-day retention, sessions, and cursor generation', async () => {
    const options = baseOptions();
    await runtime!.db.run(async () => {
      await runtime!.db
        .prepare('INSERT INTO mail_servers(id,name) VALUES(?,?)')
        .run('retired-a', 'Retired fixture');
      await runtime!.db
        .prepare(
          'INSERT INTO users(id,server_id,username,display_name,created_at) VALUES(?,?,?,?,?)',
        )
        .run(
          3n,
          'retired-a',
          'old-user',
          'Old user',
          '2026-10-08T00:00:00.000Z',
        );
      await runtime!.db
        .prepare(
          'INSERT INTO sessions(id,server_id,user_id,token_hash,expires_at,kind) VALUES(?,?,?,?,?,?)',
        )
        .run(
          3n,
          'retired-a',
          3n,
          createHash('sha256').update(randomUUID()).digest('hex'),
          '2026-10-15T00:00:00.000Z',
          'native',
        );
    });
    const saved = await createPostgresOfflineBackup({
      ...options,
      id: () => randomUUID(),
    });
    backupDir = path.join(config.backupRoot, saved.id);
    expect(
      await verifyPostgresOfflineBackup({ ...options, backupDir }),
    ).toMatchObject({ id: saved.id, schema });
    const epochBeforeRestore = (await runtime!.db.getStreamMetadata()).epoch;
    const originalCursor = createCursorCodec({ key: cursorKey }).encode({
      serverId: 'dev-a',
      userId: '1',
      epoch: epochBeforeRestore,
      position: '0',
      expiresAt: '2026-10-15T00:00:00.000Z',
    });

    const result = await restorePostgresOfflineBackup({
      ...options,
      backupDir,
      reopenDatabase: async () => {
        const reopened = await startOfflineRuntime();
        return reopened.db;
      },
      finalizeRestoredState: async () => {
        if (!runtime) throw new Error('offline runtime is unavailable');
        return finalizePostgresRecovery(runtime);
      },
    });
    expect(result.backupId).toBe(saved.id);
    runtime = await startOfflineRuntime();
    expect(runtime.app.server.listening).toBe(false);
    expect(await readFile(liveFilePath(objectKey), 'utf8')).toBe(
      'valid fourteen-day attachment',
    );
    await expect(
      readFile(liveFilePath(expiredObjectKey)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const message = await runtime!.db
      .prepare('SELECT text,content_expired FROM messages WHERE id=?')
      .get(1n);
    expect(message).toMatchObject({ text: null, content_expired: 1n });
    const file = await runtime!.db
      .prepare('SELECT state FROM files WHERE id=?')
      .get(objectKey);
    expect(file?.state).toBe('attached');
    expect(
      await runtime!.db
        .prepare('SELECT state FROM files WHERE id=?')
        .get(expiredObjectKey),
    ).toMatchObject({ state: 'deleted' });
    expect(
      await runtime!.db
        .prepare(
          'SELECT message_days,file_days FROM retention_policies WHERE server_id=?',
        )
        .get('dev-a'),
    ).toMatchObject({ message_days: 5n, file_days: 14n });
    expect(
      Number(
        (await runtime!.db.prepare('SELECT COUNT(*) AS n FROM sessions').get())!
          .n,
      ),
    ).toBe(0);
    const downloadSessionId = '2';
    await runtime!.db
      .prepare(
        'INSERT INTO sessions(id,server_id,user_id,token_hash,expires_at,kind) VALUES(?,?,?,?,?,?)',
      )
      .run(
        BigInt(downloadSessionId),
        'dev-a',
        1n,
        createHash('sha256').update(randomUUID()).digest('hex'),
        '2026-10-15T00:00:00.000Z',
        'cookie',
      );
    const download = await runtime!.files.openDownload(
      {
        ...testContext,
        sessionId: downloadSessionId as RequestContext['sessionId'],
        requestId: randomUUID() as Uuid,
      },
      objectKey as Uuid,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of download.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(
      Buffer.from('valid fourteen-day attachment'),
    );
    const newEpoch = (await runtime!.db.getStreamMetadata()).epoch;
    expect(newEpoch).not.toBe(oldEpoch);
    expect(newEpoch).not.toBe(epochBeforeRestore);
    await expect(
      runtime!.sync.sync(testContext, { after: originalCursor, limit: 10 }),
    ).rejects.toMatchObject({ code: 'sync_reset_required' });
    expect(beforeRestoreSessionCount).toBe(1);
    expect(runtime!.app.server.listening).toBe(false);
    await expect(readFile(liveFilePath(orphanObjectKey))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
  }, 60_000);

  it('rejects dangling, cross-tenant, and unlinked attached file references', async () => {
    const options = baseOptions();
    const unknownFile = randomUUID();
    await runtime!.db.run(async () => {
      await runtime!.db
        .prepare(
          'INSERT INTO message_files(server_id,message_id,file_id) VALUES(?,?,?)',
        )
        .run('dev-a', 1n, unknownFile);
    });
    await expect(postgresBackupReferences(runtime!)).rejects.toThrow();
    await expect(createPostgresOfflineBackup(options)).rejects.toThrow();
    await runtime!.db.run(async () => {
      await runtime!.db
        .prepare('DELETE FROM message_files WHERE server_id=? AND file_id=?')
        .run('dev-a', unknownFile);
      await runtime!.db
        .prepare('INSERT INTO mail_servers(id,name) VALUES(?,?)')
        .run('dev-b', 'fixture tenant');
      await runtime!.db
        .prepare(
          'INSERT INTO users(id,server_id,username,display_name,created_at) VALUES(?,?,?,?,?)',
        )
        .run(2n, 'dev-b', 'bob', 'Bob', '2026-10-08T00:00:00.000Z');
      await runtime!.db
        .prepare(
          'INSERT INTO conversations(id,server_id,kind,title,created_at) VALUES(?,?,?,?,?)',
        )
        .run(2n, 'dev-b', 'group', 'other tenant', '2026-10-08T00:00:00.000Z');
      await runtime!.db
        .prepare(
          'INSERT INTO messages(id,server_id,conversation_id,sender_id,client_message_id,text,created_at) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          2n,
          'dev-b',
          2n,
          2n,
          randomUUID(),
          'cross-tenant fixture',
          '2026-10-08T00:00:00.000Z',
        );
      await runtime!.db
        .prepare(
          'INSERT INTO message_files(server_id,message_id,file_id) VALUES(?,?,?)',
        )
        .run('dev-b', 2n, objectKey);
    });
    await expect(postgresBackupReferences(runtime!)).rejects.toThrow();
    await expect(createPostgresOfflineBackup(options)).rejects.toThrow();
    await runtime!.db.run(async () => {
      await runtime!.db
        .prepare('DELETE FROM message_files WHERE server_id=? AND file_id=?')
        .run('dev-b', objectKey);
      await runtime!.db
        .prepare('DELETE FROM message_files WHERE server_id=? AND file_id=?')
        .run('dev-a', objectKey);
    });
    await expect(postgresBackupReferences(runtime!)).rejects.toThrow();
  });

  it('rejects missing/corrupt attachments and keeps failed restoration closed with the original data recoverable', async () => {
    const options = baseOptions();
    const originalFile = liveFilePath(objectKey);
    await rm(originalFile);
    await expect(createPostgresOfflineBackup(options)).rejects.toThrow(
      /ENOENT|referenced file/,
    );
    await writeLiveFile(objectKey, 'valid fourteen-day attachment');
    const saved = await createPostgresOfflineBackup({
      ...options,
      id: () => randomUUID(),
    });
    backupDir = path.join(config.backupRoot, saved.id);
    await writeFile(path.join(backupDir, 'files', objectKey), 'corrupt');
    await expect(
      verifyPostgresOfflineBackup({ ...options, backupDir }),
    ).rejects.toThrow(/checksum mismatch|missing backup file/);
    await writeFile(
      path.join(backupDir, 'files', objectKey),
      'valid fourteen-day attachment',
    );

    await rm(originalFile);
    await expect(
      restorePostgresOfflineBackup({
        ...options,
        backupDir,
        reopenDatabase: async () => (await startOfflineRuntime()).db,
        finalizeRestoredState: async () => finalizePostgresRecovery(runtime!),
      }),
    ).rejects.toThrow(/ENOENT|referenced file/);
    expect(
      Number(
        (await runtime!.db.prepare('SELECT COUNT(*) AS n FROM sessions').get())
          ?.n,
      ),
    ).toBe(beforeRestoreSessionCount);
    expect(await readFile(liveFilePath(orphanObjectKey), 'utf8')).toBe(
      'unreferenced local object',
    );
    await writeLiveFile(objectKey, 'valid fourteen-day attachment');

    await expect(
      restorePostgresOfflineBackup({
        ...options,
        backupDir,
        reopenDatabase: async () => (await startOfflineRuntime()).db,
        finalizeRestoredState: async () => {
          throw new Error('forced restore finalization failure');
        },
      }),
    ).rejects.toThrow('forced restore finalization failure');
    expect(runtime?.app.server.listening).toBe(false);
    expect(await readFile(originalFile, 'utf8')).toBe(
      'valid fourteen-day attachment',
    );
    expect(await readFile(liveFilePath(orphanObjectKey), 'utf8')).toBe(
      'unreferenced local object',
    );
    const reopened = await import('../src/platform/storage/postgres.js').then(
      ({ PostgresStorage: Pg }) => Pg.open({ connectionString, schema }),
    );
    const sessions = await reopened
      .prepare('SELECT COUNT(*) AS n FROM sessions')
      .get();
    expect(Number(sessions?.n)).toBe(beforeRestoreSessionCount);
    await reopened.close();
  }, 60_000);

  it('preserves an existing backup on repeated ID and applies retention only after publication', async () => {
    const options = baseOptions();
    const firstId = randomUUID();
    const first = await createPostgresOfflineBackup({
      ...options,
      id: () => firstId,
      keepCount: 2,
    });
    const firstDir = path.join(config.backupRoot, first.id);
    const originalManifest = await readFile(
      path.join(firstDir, 'manifest.json'),
    );
    await expect(
      createPostgresOfflineBackup({ ...options, id: () => firstId }),
    ).rejects.toThrow(/already exists/);
    expect(await readFile(path.join(firstDir, 'manifest.json'))).toEqual(
      originalManifest,
    );
    await verifyPostgresOfflineBackup({ ...options, backupDir: firstDir });

    const second = await createPostgresOfflineBackup({
      ...options,
      id: () => randomUUID(),
      keepCount: 1,
    });
    expect(second.id).not.toBe(first.id);
    await expect(
      readFile(path.join(firstDir, 'manifest.json')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await verifyPostgresOfflineBackup({
      ...options,
      backupDir: path.join(config.backupRoot, second.id),
    });
  }, 60_000);

  it('rejects an archive whose actual schema differs before touching the target', async () => {
    const options = baseOptions();
    const saved = await createPostgresOfflineBackup(options);
    const backupDir = path.join(config.backupRoot, saved.id);
    const manifestPath = path.join(backupDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      schema: string;
    };
    const wrongSchema = `wrong${manifest.schema.slice(5)}`;
    expect(wrongSchema).toHaveLength(manifest.schema.length);
    manifest.schema = wrongSchema;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(
      verifyPostgresOfflineBackup({
        ...options,
        schema: wrongSchema,
        backupDir,
      }),
    ).rejects.toThrow(/archive schema/);
    await expect(
      restorePostgresOfflineBackup({
        ...options,
        schema: wrongSchema,
        backupDir,
        reopenDatabase: async () => (await startOfflineRuntime()).db,
        finalizeRestoredState: async () => ({
          currentPolicyApplied: true,
          sessionsRevoked: true,
        }),
      }),
    ).rejects.toThrow(/archive schema/);
    expect(runtime!.app.server.listening).toBe(false);
    expect(
      await runtime!.db.prepare('SELECT COUNT(*) AS n FROM messages').get(),
    ).toMatchObject({
      n: 1n,
    });
    await expect(readFile(manifestPath)).resolves.toBeTruthy();
    await expect(
      readFile(path.join(backupDir, 'database.dump')),
    ).resolves.toBeTruthy();
  }, 60_000);

  it('refuses backup and owner inspection while the actual HTTP listener is open', async () => {
    await runtime!.app.listen({ host: '127.0.0.1', port: 0 });
    expect(runtime!.app.server.listening).toBe(true);
    await expect(postgresBackupReferences(runtime!)).rejects.toThrow(
      /stopped public transport/,
    );
    await expect(createPostgresOfflineBackup(baseOptions())).rejects.toThrow(
      /stopped PostgreSQL service/,
    );
    await runtime!.app.close();
    expect(runtime!.app.server.listening).toBe(false);
    await expect(postgresBackupReferences(runtime!)).resolves.toHaveLength(2);
  });
});
