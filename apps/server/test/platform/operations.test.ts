import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  PLATFORM_MIGRATION,
} from '../../src/platform/database/index.js';
import type { Migration } from '../../src/platform/database/index.js';
import { createLogger } from '../../src/platform/logging/index.js';
import {
  createOfflineBackup,
  restoreOfflineBackup,
  sampleResources,
  verifyOfflineBackup,
} from '../../src/platform/operations/index.js';

const FILES_TEST_MIGRATION: Migration = {
  version: 2,
  sql: `CREATE TABLE files (id TEXT PRIMARY KEY, object_key TEXT NOT NULL, sha256 TEXT, state TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, size_bytes INTEGER NOT NULL); CREATE TABLE sessions (id INTEGER PRIMARY KEY);`,
};
const migrations = [PLATFORM_MIGRATION, FILES_TEST_MIGRATION];
let operationBusy = false;
const lock = {
  acquire: async () => {
    if (operationBusy) throw new Error('operation is already running');
    operationBusy = true;
    return async () => {
      operationBusy = false;
    };
  },
};

describe('offline operations', () => {
  let root = '';
  const open = async () => {
    root = await mkdtemp(path.join(tmpdir(), 'jm-ops-'));
    const dbPath = path.join(root, 'data.sqlite');
    const fileRoot = path.join(root, 'files');
    const backupRoot = path.join(root, 'backups');
    await writeFile(path.join(root, 'seed'), 'x');
    const db = createDatabase(dbPath, { migrations });
    return { db, dbPath, fileRoot, backupRoot };
  };
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
  });

  it('creates an integrity-checked SQLite snapshot and a hash manifest for files', async () => {
    const input = await open();
    await mkdir(input.fileRoot);
    const objectKey = '123e4567-e89b-42d3-a456-426614174000';
    await writeFile(path.join(input.fileRoot, objectKey), 'attachment');
    const { createHash } = await import('node:crypto');
    input.db
      .prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?)')
      .run(
        'file-id',
        objectKey,
        createHash('sha256').update('attachment').digest('hex'),
        'attached',
        '2026-10-01T00:00:00.000Z',
        '2026-10-15T00:00:00.000Z',
        10,
      );
    const logs: Array<Record<string, unknown>> = [];
    const logger = createLogger({
      release: 'test',
      module: 'operations',
      level: 'info',
      sink: (record) => logs.push(record),
    });
    const backup = await createOfflineBackup({
      ...input,
      serviceStopped: true,
      operationLock: lock,
      migrations,
      ids: { uuid: () => '123e4567-e89b-42d3-a456-426614174001' },
      clock: { now: () => new Date('2026-10-06T00:00:00.000Z') },
      logger,
    });
    expect(backup.files).toEqual([
      {
        id: 'file-id',
        objectKey,
        sha256: expect.any(String),
        state: 'attached',
        createdAt: '2026-10-01T00:00:00.000Z',
        expiresAt: '2026-10-15T00:00:00.000Z',
        bytes: 10,
      },
    ]);
    expect(backup.schemaVersion).toBe(2);
    expect(
      JSON.parse(
        await readFile(
          path.join(
            input.backupRoot,
            '123e4567-e89b-42d3-a456-426614174001',
            'manifest.json',
          ),
          'utf8',
        ),
      ),
    ).toMatchObject({
      format: 1,
      id: '123e4567-e89b-42d3-a456-426614174001',
      totalBytes: backup.totalBytes,
    });
    await expect(
      verifyOfflineBackup({
        backupDir: path.join(
          input.backupRoot,
          '123e4567-e89b-42d3-a456-426614174001',
        ),
        backupRoot: input.backupRoot,
        serviceStopped: true,
        operationLock: lock,
        migrations,
      }),
    ).resolves.toMatchObject({ id: '123e4567-e89b-42d3-a456-426614174001' });
    expect(logs[0]).toMatchObject({
      featureId: 'F45',
      event: 'operations.backup.completed',
      backupId: '123e4567-e89b-42d3-a456-426614174001',
      byteCount: backup.totalBytes,
      count: 1,
    });
    expect(JSON.stringify(logs)).not.toContain('attachment');
    input.db.close();
  });

  it('fails closed without explicit service-stop proof and preserves the last backup on quota failure', async () => {
    const input = await open();
    const args = {
      ...input,
      serviceStopped: true as const,
      operationLock: lock,
      migrations,
      ids: { uuid: () => '123e4567-e89b-42d3-a456-426614174001' },
    };
    const held = await lock.acquire();
    await expect(createOfflineBackup(args)).rejects.toThrow(/already running/);
    await held();
    await expect(
      createOfflineBackup({ ...args, serviceStopped: false as never }),
    ).rejects.toThrow(/stopped/);
    await createOfflineBackup(args);
    await expect(
      createOfflineBackup({
        ...args,
        ids: { uuid: () => '123e4567-e89b-42d3-a456-426614174002' },
        limitBytes: 1,
      }),
    ).rejects.toThrow(/size limit/);
    expect(await readdir(input.backupRoot)).toEqual([
      '123e4567-e89b-42d3-a456-426614174001',
    ]);
    input.db.close();
  });

  it('rejects missing source blobs and tampered snapshots without replacing a valid backup', async () => {
    const input = await open();
    const args = {
      ...input,
      serviceStopped: true as const,
      operationLock: lock,
      migrations,
      ids: { uuid: () => '123e4567-e89b-42d3-a456-426614174001' },
    };
    await createOfflineBackup(args);
    const { createHash } = await import('node:crypto');
    input.db
      .prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?)')
      .run(
        'file-id',
        '123e4567-e89b-42d3-a456-426614174000',
        createHash('sha256').update('missing').digest('hex'),
        'attached',
        '2026-10-01T00:00:00.000Z',
        '2026-10-15T00:00:00.000Z',
        7,
      );
    await expect(
      createOfflineBackup({
        ...args,
        ids: { uuid: () => '123e4567-e89b-42d3-a456-426614174002' },
      }),
    ).rejects.toThrow();
    expect(await readdir(input.backupRoot)).toEqual([
      '123e4567-e89b-42d3-a456-426614174001',
    ]);
    input.db.close();
    await writeFile(
      path.join(
        input.backupRoot,
        '123e4567-e89b-42d3-a456-426614174001',
        'database.sqlite',
      ),
      'tampered',
    );
    await expect(
      verifyOfflineBackup({
        backupDir: path.join(
          input.backupRoot,
          '123e4567-e89b-42d3-a456-426614174001',
        ),
        backupRoot: input.backupRoot,
        serviceStopped: true,
        operationLock: lock,
        migrations,
      }),
    ).rejects.toThrow(/checksum mismatch/);
  });

  it('reports storage and quota capacity without recording paths or content', async () => {
    const input = await open();
    const logs: Array<Record<string, unknown>> = [];
    const sample = await sampleResources({
      ...input,
      configuredFileQuotaBytes: 100,
      minimumFreeBytes: 0,
      eventLoopDelayP99Ms: 3.5,
      requestLatencyP95Ms: 12,
      now: () => new Date('2026-10-06T00:00:00.000Z'),
      logger: createLogger({
        release: 'test',
        module: 'operations',
        level: 'info',
        sink: (record) => logs.push(record),
      }),
    });
    expect(sample).toMatchObject({
      sampledAt: '2026-10-06T00:00:00.000Z',
      fileBytes: 0,
      configuredFileQuotaBytes: 100,
      writesAllowed: true,
      eventLoopDelayP99Ms: 3.5,
      requestLatencyP95Ms: 12,
    });
    expect(logs[0]).toMatchObject({
      featureId: 'F44',
      event: 'operations.resources.sampled',
      configuredFileQuotaBytes: 100,
      writesAllowed: true,
    });
    input.db.close();
  });

  it('keeps the current database and files when restore finalization fails', async () => {
    const input = await open();
    await mkdir(input.fileRoot);
    const objectKey = '123e4567-e89b-42d3-a456-426614174000';
    await writeFile(path.join(input.fileRoot, objectKey), 'attachment');
    const { createHash } = await import('node:crypto');
    input.db
      .prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?)')
      .run(
        'file-id',
        objectKey,
        createHash('sha256').update('attachment').digest('hex'),
        'attached',
        '2026-10-01T00:00:00.000Z',
        '2026-10-15T00:00:00.000Z',
        10,
      );
    await createOfflineBackup({
      ...input,
      serviceStopped: true,
      operationLock: lock,
      migrations,
      ids: { uuid: () => '123e4567-e89b-42d3-a456-426614174001' },
    });
    input.db.close();
    const before = await readFile(input.dbPath);
    const logs: Array<Record<string, unknown>> = [];
    await expect(
      restoreOfflineBackup({
        backupDir: path.join(
          input.backupRoot,
          '123e4567-e89b-42d3-a456-426614174001',
        ),
        backupRoot: input.backupRoot,
        serviceStopped: true,
        operationLock: lock,
        migrations,
        workspaceRoot: root,
        dbPath: input.dbPath,
        fileRoot: input.fileRoot,
        applyCurrentPolicyRevokeSessionsAndRotateEpoch: async () => {
          throw new Error('policy step failed');
        },
        logger: createLogger({
          release: 'test',
          module: 'operations',
          level: 'info',
          sink: (record) => logs.push(record),
        }),
      }),
    ).rejects.toThrow('policy step failed');
    expect(await readFile(input.dbPath)).toEqual(before);
    expect(await readFile(path.join(input.fileRoot, objectKey), 'utf8')).toBe(
      'attachment',
    );
    expect(await readdir(input.backupRoot)).toEqual([
      '123e4567-e89b-42d3-a456-426614174001',
    ]);
    expect(logs[0]).toMatchObject({
      featureId: 'F46',
      event: 'operations.restore.failed',
      outcome: 'failure',
    });
  });

  it('restores a verified snapshot, revokes sessions, rotates the epoch, and preserves current data', async () => {
    const input = await open();
    await mkdir(input.fileRoot);
    const objectKey = '123e4567-e89b-42d3-a456-426614174000';
    await writeFile(path.join(input.fileRoot, objectKey), 'snapshot');
    const { createHash } = await import('node:crypto');
    input.db
      .prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?)')
      .run(
        'file-id',
        objectKey,
        createHash('sha256').update('snapshot').digest('hex'),
        'attached',
        '2026-10-01T00:00:00.000Z',
        '2026-10-15T00:00:00.000Z',
        8,
      );
    input.db.prepare('INSERT INTO sessions DEFAULT VALUES').run();
    await createOfflineBackup({
      ...input,
      serviceStopped: true,
      operationLock: lock,
      migrations,
      ids: { uuid: () => '123e4567-e89b-42d3-a456-426614174001' },
    });
    const sourceManifest = await readFile(
      path.join(
        input.backupRoot,
        '123e4567-e89b-42d3-a456-426614174001',
        'manifest.json',
      ),
    );
    input.db.close();
    await writeFile(path.join(input.fileRoot, objectKey), 'current');
    const currentDb = new DatabaseSync(input.dbPath);
    currentDb.prepare('INSERT INTO sessions DEFAULT VALUES').run();
    currentDb.close();
    const logs: Array<Record<string, unknown>> = [];
    const logger = createLogger({
      release: 'test',
      module: 'operations',
      level: 'info',
      sink: (record) => logs.push(record),
    });
    const result = await restoreOfflineBackup({
      backupDir: path.join(
        input.backupRoot,
        '123e4567-e89b-42d3-a456-426614174001',
      ),
      backupRoot: input.backupRoot,
      serviceStopped: true,
      operationLock: lock,
      migrations,
      workspaceRoot: root,
      dbPath: input.dbPath,
      fileRoot: input.fileRoot,
      applyCurrentPolicyRevokeSessionsAndRotateEpoch: async ({ dbPath }) => {
        const restoredDb = new DatabaseSync(dbPath);
        restoredDb.prepare('DELETE FROM sessions').run();
        restoredDb
          .prepare(
            "UPDATE platform_metadata SET value='fresh-epoch' WHERE key='stream_epoch'",
          )
          .run();
        restoredDb.close();
        return {
          currentPolicyApplied: true,
          sessionsRevoked: true,
          streamEpochRotated: true,
        };
      },
      logger,
    });
    expect(await readFile(path.join(input.fileRoot, objectKey), 'utf8')).toBe(
      'snapshot',
    );
    expect(
      await readFile(
        path.join(
          input.backupRoot,
          '123e4567-e89b-42d3-a456-426614174001',
          'manifest.json',
        ),
      ),
    ).toEqual(sourceManifest);
    const restoredDb = new DatabaseSync(input.dbPath, { readOnly: true });
    expect(
      restoredDb.prepare('SELECT count(*) AS n FROM sessions').get()?.n,
    ).toBe(0);
    expect(
      restoredDb
        .prepare("SELECT value FROM platform_metadata WHERE key='stream_epoch'")
        .get()?.value,
    ).toBe('fresh-epoch');
    restoredDb.close();
    expect(
      await readFile(
        path.join(result.recoveryDirectory, 'files', objectKey),
        'utf8',
      ),
    ).toBe('current');
    expect(logs[0]).toMatchObject({
      featureId: 'F46',
      event: 'operations.restore.completed',
      backupId: '123e4567-e89b-42d3-a456-426614174001',
    });
    const recoveryDb = new DatabaseSync(
      path.join(result.recoveryDirectory, 'database.sqlite'),
      { readOnly: true },
    );
    expect(
      recoveryDb.prepare('SELECT count(*) AS n FROM sessions').get()?.n,
    ).toBe(2);
    recoveryDb.close();
  });
});
