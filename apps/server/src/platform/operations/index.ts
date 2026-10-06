import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import type { FeatureLog } from '@j-messenger/contracts';
import type { Database, Migration } from '../database/index.js';

const DEFAULT_MAX_BYTES = 2 * 1024 ** 3;
const DEFAULT_KEEP_COUNT = 7;
const safeEmit = (
  featureId: 'F44' | 'F45' | 'F46',
  logger: FeatureLog | undefined,
  event: string,
  outcome: 'success' | 'failure',
  fields: Record<string, string | number | boolean> = {},
): void => {
  try {
    logger?.emit({ featureId, event, outcome, fields });
  } catch {
    /* diagnostics must not alter operations */
  }
};

export interface ResourceSnapshot {
  readonly sampledAt: string;
  readonly memoryBytes: number;
  readonly eventLoopDelayP99Ms: number | null;
  readonly requestLatencyP95Ms: number | null;
  readonly databaseBytes: number;
  readonly walBytes: number;
  readonly freeBytes: number;
  readonly outboxRows: number;
  readonly fileBytes: number;
  readonly configuredFileQuotaBytes: number;
  readonly writesAllowed: boolean;
  readonly capacityReason:
    'available' | 'disk-low' | 'quota-reached' | 'disk-and-quota-low';
}

export interface ResourceSampleInput {
  readonly db: Database;
  readonly dbPath: string;
  readonly fileRoot: string;
  readonly configuredFileQuotaBytes: number;
  readonly minimumFreeBytes: number;
  readonly eventLoopDelayP99Ms?: number | null;
  readonly requestLatencyP95Ms?: number | null;
  readonly now?: () => Date;
  readonly logger?: FeatureLog;
}

async function treeBytes(root: string): Promise<number> {
  let total = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('unsafe filesystem entry');
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) total += (await stat(target)).size;
      else throw new Error('unsafe filesystem entry');
    }
  };
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw new Error('unsafe filesystem root');
    await visit(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return total;
}

export async function sampleResources(
  input: ResourceSampleInput,
): Promise<ResourceSnapshot> {
  if (
    !Number.isSafeInteger(input.configuredFileQuotaBytes) ||
    input.configuredFileQuotaBytes < 0 ||
    !Number.isSafeInteger(input.minimumFreeBytes) ||
    input.minimumFreeBytes < 0
  )
    throw new TypeError('invalid resource limits');
  const [dbStat, walStat, disk, fileBytes] = await Promise.all([
    stat(input.dbPath).catch(() => ({ size: 0 })),
    stat(`${input.dbPath}-wal`).catch(() => ({ size: 0 })),
    import('node:fs/promises').then(({ statfs }) =>
      statfs(path.dirname(input.dbPath)),
    ),
    treeBytes(input.fileRoot),
  ]);
  const freeBytes = Number(disk.bavail) * Number(disk.bsize);
  const outboxRows = Number(
    (
      input.db.prepare('SELECT count(*) AS n FROM event_outbox').get() as {
        n: bigint;
      }
    ).n,
  );
  const writesAllowed =
    freeBytes >= input.minimumFreeBytes &&
    (input.configuredFileQuotaBytes === 0 ||
      fileBytes < input.configuredFileQuotaBytes);
  const diskLow = freeBytes < input.minimumFreeBytes;
  const quotaReached =
    input.configuredFileQuotaBytes > 0 &&
    fileBytes >= input.configuredFileQuotaBytes;
  const capacityReason = diskLow
    ? quotaReached
      ? 'disk-and-quota-low'
      : 'disk-low'
    : quotaReached
      ? 'quota-reached'
      : 'available';
  const snapshot: ResourceSnapshot = Object.freeze({
    sampledAt: (input.now?.() ?? new Date()).toISOString(),
    memoryBytes: process.memoryUsage().rss,
    eventLoopDelayP99Ms: input.eventLoopDelayP99Ms ?? null,
    requestLatencyP95Ms: input.requestLatencyP95Ms ?? null,
    databaseBytes: dbStat.size,
    walBytes: walStat.size,
    freeBytes,
    outboxRows,
    fileBytes,
    configuredFileQuotaBytes: input.configuredFileQuotaBytes,
    writesAllowed,
    capacityReason,
  });
  safeEmit('F44', input.logger, 'operations.resources.sampled', 'success', {
    memoryBytes: snapshot.memoryBytes,
    ...(snapshot.eventLoopDelayP99Ms === null
      ? {}
      : { eventLoopDelayP99Ms: snapshot.eventLoopDelayP99Ms }),
    ...(snapshot.requestLatencyP95Ms === null
      ? {}
      : { requestLatencyP95Ms: snapshot.requestLatencyP95Ms }),
    databaseBytes: snapshot.databaseBytes,
    walBytes: snapshot.walBytes,
    freeBytes: snapshot.freeBytes,
    outboxRows: snapshot.outboxRows,
    fileBytes: snapshot.fileBytes,
    configuredFileQuotaBytes: snapshot.configuredFileQuotaBytes,
    writesAllowed: snapshot.writesAllowed,
  });
  return snapshot;
}

export interface OfflineBackupOptions {
  readonly db: Database;
  readonly dbPath: string;
  readonly fileRoot: string;
  readonly backupRoot: string;
  readonly serviceStopped: true;
  readonly operationLock: { acquire(): Promise<() => Promise<void>> };
  readonly clock?: { now(): Date };
  readonly ids?: { uuid(): string };
  readonly limitBytes?: number;
  readonly keepCount?: number;
  readonly migrations: readonly Migration[];
  readonly logger?: FeatureLog;
}
export interface BackupManifest {
  readonly format: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly database: {
    readonly name: 'database.sqlite';
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly files: readonly {
    readonly id: string;
    readonly objectKey: string;
    readonly sha256: string;
    readonly state: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly bytes: number;
  }[];
  readonly totalBytes: number;
  readonly schemaVersion: number;
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}
async function assertNoSymlinkComponents(target: string): Promise<void> {
  let cursor = path.resolve(target);
  while (true) {
    try {
      if ((await lstat(cursor)).isSymbolicLink())
        throw new Error('symbolic link in operations path');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}
async function digest(
  file: string,
): Promise<{ sha256: string; bytes: number }> {
  const data = await readFile(file);
  return {
    sha256: createHash('sha256').update(data).digest('hex'),
    bytes: data.byteLength,
  };
}
async function snapshotReferencedFiles(
  root: string,
  destination: string,
  rows: readonly BackupManifest['files'][number][],
): Promise<BackupManifest['files']> {
  const result: BackupManifest['files'][number][] = [];
  const sourceRoot = path.resolve(root);
  const targetRoot = path.resolve(destination);
  await mkdir(targetRoot, { recursive: true });
  for (const row of rows) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        row.objectKey,
      )
    )
      throw new Error('invalid file object reference');
    const source = path.resolve(sourceRoot, row.objectKey);
    const target = path.resolve(targetRoot, row.objectKey);
    if (!inside(sourceRoot, source) || !inside(targetRoot, target))
      throw new Error('unsafe file path');
    const sourceStat = await lstat(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink())
      throw new Error('invalid referenced file');
    await copyFile(source, target);
    const actual = await digest(target);
    if (actual.sha256 !== row.sha256 || actual.bytes !== row.bytes)
      throw new Error('file integrity mismatch');
    result.push({ ...row });
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

async function validateDatabase(
  file: string,
  migrations: readonly Migration[],
): Promise<{ schemaVersion: number; files: BackupManifest['files'] }> {
  const sqlite = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = sqlite.prepare('PRAGMA integrity_check').get() as {
      integrity_check: string;
    };
    if (integrity.integrity_check !== 'ok')
      throw new Error('invalid backup database');
    if ((sqlite.prepare('PRAGMA foreign_key_check').all() as unknown[]).length)
      throw new Error('invalid backup references');
    const rows = sqlite
      .prepare(
        'SELECT version,checksum FROM migration_history ORDER BY version',
      )
      .all() as Array<{ version: number; checksum: string }>;
    const expected = [...migrations].sort((a, b) => a.version - b.version);
    if (rows.length !== expected.length)
      throw new Error('unsupported backup schema');
    for (let i = 0; i < rows.length; i++) {
      const migration = expected[i]!;
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      if (
        rows[i]!.version !== migration.version ||
        rows[i]!.checksum !== checksum
      )
        throw new Error('unsupported backup schema');
    }
    const fileRows = sqlite
      .prepare(
        "SELECT id,object_key,sha256,state,created_at,expires_at,size_bytes FROM files WHERE state<>'deleted' ORDER BY id",
      )
      .all() as Array<{
      id: string;
      object_key: string;
      sha256: string | null;
      state: string;
      created_at: string;
      expires_at: string;
      size_bytes: bigint | number;
    }>;
    if (
      fileRows.some(
        (row) =>
          row.state === 'uploading' ||
          !row.sha256 ||
          !Number.isSafeInteger(Number(row.size_bytes)),
      )
    )
      throw new Error('file metadata is not quiescent');
    return {
      schemaVersion: rows.at(-1)?.version ?? 0,
      files: fileRows.map((row) => ({
        id: row.id,
        objectKey: row.object_key,
        sha256: row.sha256!,
        state: row.state,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        bytes: Number(row.size_bytes),
      })),
    };
  } finally {
    sqlite.close();
  }
}

async function createOfflineBackupLocked(
  options: OfflineBackupOptions,
): Promise<BackupManifest> {
  if (options.serviceStopped !== true)
    throw new Error('service must be explicitly stopped');
  const limitBytes = options.limitBytes ?? DEFAULT_MAX_BYTES;
  const keepCount = options.keepCount ?? DEFAULT_KEEP_COUNT;
  if (
    !Number.isSafeInteger(limitBytes) ||
    limitBytes < 1 ||
    !Number.isSafeInteger(keepCount) ||
    keepCount < 1
  )
    throw new TypeError('invalid backup limits');
  const root = path.resolve(options.backupRoot);
  const dbPath = path.resolve(options.dbPath);
  const fileRoot = path.resolve(options.fileRoot);
  await Promise.all([
    assertNoSymlinkComponents(root),
    assertNoSymlinkComponents(dbPath),
    assertNoSymlinkComponents(fileRoot),
  ]);
  if (
    inside(root, dbPath) ||
    inside(dbPath, root) ||
    inside(root, fileRoot) ||
    inside(fileRoot, root)
  )
    throw new Error('overlapping backup paths');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const backupRootStat = await lstat(root);
  if (!backupRootStat.isDirectory() || backupRootStat.isSymbolicLink())
    throw new Error('invalid backup root');
  const sourceDbStat = await lstat(dbPath);
  if (!sourceDbStat.isFile() || sourceDbStat.isSymbolicLink())
    throw new Error('invalid source database');
  const sourceFilesStat = await lstat(fileRoot).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
  if (
    sourceFilesStat &&
    (!sourceFilesStat.isDirectory() || sourceFilesStat.isSymbolicLink())
  )
    throw new Error('invalid source file root');
  if (process.platform !== 'win32') await chmod(root, 0o700);
  const id = options.ids?.uuid() ?? randomUUID();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  )
    throw new TypeError('invalid backup id');
  const createdAt = (options.clock?.now() ?? new Date()).toISOString();
  const finalDir = path.join(root, id);
  const tempDir = path.join(root, `.${id}.partial`);
  if (
    !inside(root, path.resolve(finalDir)) ||
    !inside(root, path.resolve(tempDir))
  )
    throw new Error('unsafe backup target');
  await mkdir(tempDir, { mode: 0o700 });
  let published = false;
  try {
    const dbTarget = path.join(tempDir, 'database.sqlite');
    await options.db.backup(dbTarget);
    const validated = await validateDatabase(dbTarget, options.migrations);
    const schemaVersion = validated.schemaVersion;
    const files = await snapshotReferencedFiles(
      fileRoot,
      path.join(tempDir, 'files'),
      validated.files,
    );
    const database = {
      name: 'database.sqlite' as const,
      ...(await digest(dbTarget)),
    };
    const payloadBytes =
      database.bytes + files.reduce((sum, file) => sum + file.bytes, 0);
    let totalBytes = payloadBytes;
    let manifest: BackupManifest;
    let serializedManifest: string;
    for (let attempt = 0; attempt < 4; attempt++) {
      manifest = Object.freeze({
        format: 1,
        id,
        createdAt,
        database,
        files,
        totalBytes,
        schemaVersion,
      });
      serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
      const nextTotal = payloadBytes + Buffer.byteLength(serializedManifest);
      if (nextTotal === totalBytes) break;
      totalBytes = nextTotal;
    }
    manifest = Object.freeze({
      format: 1,
      id,
      createdAt,
      database,
      files,
      totalBytes,
      schemaVersion,
    });
    serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
    if (payloadBytes + Buffer.byteLength(serializedManifest) !== totalBytes)
      throw new Error('backup manifest size did not stabilize');
    if (totalBytes > limitBytes) throw new Error('backup size limit exceeded');
    await writeFile(path.join(tempDir, 'manifest.json'), serializedManifest, {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(tempDir, finalDir);
    published = true;
    const dirs = (await readdir(root, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            entry.name,
          ),
      )
      .map((entry) => entry.name);
    const records = await Promise.all(
      dirs.map(async (name) => {
        const directory = path.join(root, name);
        const data = await verifyOfflineBackupLocked({
          backupDir: directory,
          backupRoot: root,
          serviceStopped: true,
          operationLock: options.operationLock,
          migrations: options.migrations,
        });
        if (data.id !== name || !Number.isSafeInteger(data.totalBytes))
          throw new Error('invalid existing backup');
        return {
          name,
          time: (await stat(directory)).mtimeMs,
          bytes: data.totalBytes,
        };
      }),
    );
    records.sort((a, b) => a.time - b.time);
    let usedBytes = records.reduce((sum, record) => sum + record.bytes, 0);
    while (records.length > keepCount || usedBytes > limitBytes) {
      const removable = records.findIndex((record) => record.name !== id);
      if (removable < 0) throw new Error('backup retention limit exceeded');
      const [old] = records.splice(removable, 1);
      usedBytes -= old!.bytes;
      await rm(path.join(root, old!.name), { recursive: true, force: false });
    }
    safeEmit('F45', options.logger, 'operations.backup.completed', 'success', {
      backupId: id,
      byteCount: totalBytes,
      count: files.length,
      schemaVersion,
    });
    return manifest;
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    if (published)
      await rm(finalDir, { recursive: true, force: true }).catch(() => {});
    safeEmit('F45', options.logger, 'operations.backup.failed', 'failure', {
      backupId: id,
    });
    throw error;
  }
}

export async function createOfflineBackup(
  options: OfflineBackupOptions,
): Promise<BackupManifest> {
  if (options.serviceStopped !== true)
    throw new Error('service must be explicitly stopped');
  const release = await options.operationLock.acquire();
  try {
    return await createOfflineBackupLocked(options);
  } finally {
    await release();
  }
}

export interface VerifyOfflineBackupOptions {
  readonly backupDir: string;
  readonly backupRoot: string;
  readonly serviceStopped: true;
  readonly operationLock: { acquire(): Promise<() => Promise<void>> };
  readonly migrations: readonly Migration[];
}

async function verifyOfflineBackupLocked(
  options: VerifyOfflineBackupOptions,
): Promise<BackupManifest> {
  if (options.serviceStopped !== true)
    throw new Error('service must be explicitly stopped');
  const root = path.resolve(options.backupRoot);
  const directory = path.resolve(options.backupDir);
  if (!inside(root, directory) || directory === root)
    throw new Error('backup is outside the configured root');
  const dirStat = await lstat(directory);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink())
    throw new Error('invalid backup directory');
  const manifestText = await readFile(
    path.join(directory, 'manifest.json'),
    'utf8',
  );
  const manifest = JSON.parse(manifestText) as BackupManifest;
  if (
    manifest.format !== 1 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      manifest.id,
    ) ||
    directory !== path.join(root, manifest.id) ||
    manifest.database.name !== 'database.sqlite' ||
    !Array.isArray(manifest.files)
  )
    throw new Error('invalid backup manifest');
  const dbFile = path.join(directory, 'database.sqlite');
  const dbStat = await lstat(dbFile);
  if (!dbStat.isFile() || dbStat.isSymbolicLink())
    throw new Error('invalid backup database file');
  const dbHash = await digest(dbFile);
  if (
    dbHash.sha256 !== manifest.database.sha256 ||
    dbHash.bytes !== manifest.database.bytes
  )
    throw new Error('database snapshot checksum mismatch');
  const validated = await validateDatabase(dbFile, options.migrations);
  if (validated.schemaVersion !== manifest.schemaVersion)
    throw new Error('backup schema version mismatch');
  if (validated.files.length !== manifest.files.length)
    throw new Error('backup file manifest mismatch');
  let totalBytes = dbHash.bytes + Buffer.byteLength(manifestText);
  for (let index = 0; index < manifest.files.length; index++) {
    const expected = manifest.files[index]!;
    const fromDb = validated.files[index]!;
    if (
      expected.id !== fromDb.id ||
      expected.objectKey !== fromDb.objectKey ||
      expected.sha256 !== fromDb.sha256 ||
      expected.state !== fromDb.state ||
      expected.createdAt !== fromDb.createdAt ||
      expected.expiresAt !== fromDb.expiresAt ||
      expected.bytes !== fromDb.bytes ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        expected.objectKey,
      )
    )
      throw new Error('backup file manifest mismatch');
    const file = path.resolve(directory, 'files', expected.objectKey);
    if (!inside(directory, file)) throw new Error('unsafe backup file path');
    const fileStat = await lstat(file);
    if (!fileStat.isFile() || fileStat.isSymbolicLink())
      throw new Error('missing backup file');
    const fileDigest = await digest(file);
    if (
      fileDigest.sha256 !== expected.sha256 ||
      fileDigest.bytes !== expected.bytes
    )
      throw new Error('backup file checksum mismatch');
    totalBytes += fileDigest.bytes;
  }
  if (totalBytes !== manifest.totalBytes)
    throw new Error('backup size mismatch');
  return manifest;
}

export async function verifyOfflineBackup(
  options: VerifyOfflineBackupOptions,
): Promise<BackupManifest> {
  const release = await options.operationLock.acquire();
  try {
    return await verifyOfflineBackupLocked(options);
  } finally {
    await release();
  }
}

export interface RestoreOfflineBackupOptions extends VerifyOfflineBackupOptions {
  readonly workspaceRoot: string;
  readonly dbPath: string;
  readonly fileRoot: string;
  readonly applyCurrentPolicyRevokeSessionsAndRotateEpoch: (input: {
    readonly dbPath: string;
    readonly fileRoot: string;
    readonly currentPolicy: { readonly messageDays: 5; readonly fileDays: 14 };
  }) => Promise<{
    readonly currentPolicyApplied: true;
    readonly sessionsRevoked: true;
    readonly streamEpochRotated: true;
  }>;
  readonly logger?: FeatureLog;
}

export class RestoreRecoveryError extends Error {
  constructor(
    readonly recoveryDirectory: string,
    readonly stagingDirectory: string,
    readonly targetMayBePartial: true,
  ) {
    super('restore rollback could not fully restore the previous workspace');
    this.name = 'RestoreRecoveryError';
  }
}

/**
 * Restores a verified snapshot while retaining the pre-restore database and
 * files under a new recovery directory. The injected operation must apply the
 * current retention policy, revoke every session, and rotate the stream epoch
 * against the staged database before it returns.
 */
export async function restoreOfflineBackup(
  options: RestoreOfflineBackupOptions,
): Promise<{ recoveryDirectory: string; backupId: string }> {
  if (options.serviceStopped !== true)
    throw new Error('service must be explicitly stopped');
  if (
    typeof options.applyCurrentPolicyRevokeSessionsAndRotateEpoch !== 'function'
  )
    throw new Error('restore finalization is required');
  const release = await options.operationLock.acquire();
  let stageDirectory: string | undefined;
  let recoveryDirectory: string | undefined;
  let oldDbMoved = false;
  let oldFilesMoved = false;
  let newDbMoved = false;
  let newFilesMoved = false;
  try {
    const workspace = path.resolve(options.workspaceRoot);
    const dbPath = path.resolve(options.dbPath);
    const fileRoot = path.resolve(options.fileRoot);
    const backupRoot = path.resolve(options.backupRoot);
    const backupDir = path.resolve(options.backupDir);
    await Promise.all([
      assertNoSymlinkComponents(workspace),
      assertNoSymlinkComponents(dbPath),
      assertNoSymlinkComponents(fileRoot),
      assertNoSymlinkComponents(backupRoot),
      assertNoSymlinkComponents(backupDir),
    ]);
    if (
      !inside(workspace, dbPath) ||
      !inside(workspace, fileRoot) ||
      !inside(workspace, backupRoot) ||
      !inside(backupRoot, backupDir) ||
      dbPath === fileRoot ||
      inside(dbPath, fileRoot) ||
      inside(fileRoot, dbPath) ||
      inside(backupDir, dbPath) ||
      inside(backupDir, fileRoot) ||
      inside(dbPath, backupDir) ||
      inside(fileRoot, backupDir)
    )
      throw new Error('restore paths are outside the configured workspace');
    const manifest = await verifyOfflineBackupLocked({
      ...options,
      backupDir,
      backupRoot,
    });
    const operationId = randomUUID();
    stageDirectory = path.join(workspace, `.restore-${operationId}`);
    recoveryDirectory = path.join(workspace, `recovery-${operationId}`);
    if (
      !inside(workspace, stageDirectory) ||
      !inside(workspace, recoveryDirectory)
    )
      throw new Error('unsafe restore staging path');
    const stagedDb = path.join(stageDirectory, 'database.sqlite');
    const stagedFiles = path.join(stageDirectory, 'files');
    await mkdir(stageDirectory, { recursive: false, mode: 0o700 });
    await mkdir(stagedFiles, { recursive: true, mode: 0o700 });
    await copyFile(path.join(backupDir, 'database.sqlite'), stagedDb);
    for (const file of manifest.files) {
      const source = path.resolve(backupDir, 'files', file.objectKey);
      const target = path.resolve(stagedFiles, file.objectKey);
      if (!inside(backupDir, source) || !inside(stagedFiles, target))
        throw new Error('unsafe restore file path');
      await copyFile(source, target);
    }
    const finalization =
      await options.applyCurrentPolicyRevokeSessionsAndRotateEpoch({
        dbPath: stagedDb,
        fileRoot: stagedFiles,
        currentPolicy: { messageDays: 5, fileDays: 14 },
      });
    if (
      finalization?.currentPolicyApplied !== true ||
      finalization.sessionsRevoked !== true ||
      finalization.streamEpochRotated !== true
    )
      throw new Error('restore finalization incomplete');
    const restored = await validateDatabase(stagedDb, options.migrations);
    const retainedKeys = new Set(restored.files.map((file) => file.objectKey));
    for (const file of manifest.files) {
      if (retainedKeys.has(file.objectKey)) continue;
      const staleFile = path.resolve(stagedFiles, file.objectKey);
      if (!inside(stagedFiles, staleFile))
        throw new Error('unsafe staged cleanup path');
      await rm(staleFile, { force: false });
    }
    for (const file of restored.files) {
      const target = path.resolve(stagedFiles, file.objectKey);
      if (!inside(stagedFiles, target))
        throw new Error('unsafe restored file path');
      const targetStat = await lstat(target);
      if (!targetStat.isFile() || targetStat.isSymbolicLink())
        throw new Error('restored file is missing');
      const actual = await digest(target);
      if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes)
        throw new Error('restored file integrity mismatch');
    }
    const dbStat = await lstat(dbPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (dbStat && (!dbStat.isFile() || dbStat.isSymbolicLink()))
      throw new Error('invalid current database path');
    const filesStat = await lstat(fileRoot).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      },
    );
    if (filesStat && (!filesStat.isDirectory() || filesStat.isSymbolicLink()))
      throw new Error('invalid current file path');
    await mkdir(path.dirname(dbPath), { recursive: true });
    await mkdir(path.dirname(fileRoot), { recursive: true });
    await mkdir(recoveryDirectory, { recursive: false, mode: 0o700 });
    if (dbStat) {
      await rename(dbPath, path.join(recoveryDirectory, 'database.sqlite'));
      oldDbMoved = true;
      for (const suffix of ['-wal', '-shm']) {
        await rename(
          `${dbPath}${suffix}`,
          path.join(recoveryDirectory, `database.sqlite${suffix}`),
        ).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    }
    if (filesStat) {
      await rename(fileRoot, path.join(recoveryDirectory, 'files'));
      oldFilesMoved = true;
    }
    await rename(stagedFiles, fileRoot);
    newFilesMoved = true;
    await rename(stagedDb, dbPath);
    newDbMoved = true;
    await rm(stageDirectory, { recursive: true, force: false });
    stageDirectory = undefined;
    safeEmit('F46', options.logger, 'operations.restore.completed', 'success', {
      backupId: manifest.id,
      count: restored.files.length,
      schemaVersion: restored.schemaVersion,
    });
    return { recoveryDirectory, backupId: manifest.id };
  } catch (error) {
    const rollbackFailures: string[] = [];
    if (recoveryDirectory) {
      if (newDbMoved && stageDirectory) {
        try {
          await rename(
            options.dbPath,
            path.join(stageDirectory, 'failed.sqlite'),
          );
        } catch {
          rollbackFailures.push('new-database-preserve');
        }
      }
      if (newFilesMoved && stageDirectory) {
        try {
          await rename(
            options.fileRoot,
            path.join(stageDirectory, 'failed-files'),
          );
        } catch {
          rollbackFailures.push('new-files-preserve');
        }
      }
      if (oldFilesMoved) {
        try {
          await rename(path.join(recoveryDirectory, 'files'), options.fileRoot);
        } catch {
          rollbackFailures.push('original-files-restore');
        }
      }
      if (oldDbMoved) {
        try {
          await rename(
            path.join(recoveryDirectory, 'database.sqlite'),
            options.dbPath,
          );
        } catch {
          rollbackFailures.push('original-database-restore');
        }
        for (const suffix of ['-wal', '-shm']) {
          try {
            await rename(
              path.join(recoveryDirectory, `database.sqlite${suffix}`),
              `${options.dbPath}${suffix}`,
            );
          } catch (renameError) {
            if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT')
              rollbackFailures.push('original-database-sidecar-restore');
          }
        }
      }
      if (rollbackFailures.length === 0) {
        const remaining = await readdir(recoveryDirectory).catch(() => [
          'unknown',
        ]);
        if (remaining.length === 0)
          await rm(recoveryDirectory, { recursive: false, force: true });
      }
    }
    safeEmit('F46', options.logger, 'operations.restore.failed', 'failure');
    if (rollbackFailures.length > 0 && recoveryDirectory && stageDirectory)
      throw new RestoreRecoveryError(recoveryDirectory, stageDirectory, true);
    if (stageDirectory) {
      const workspace = path.resolve(options.workspaceRoot);
      const stage = path.resolve(stageDirectory);
      if (!inside(workspace, stage) || stage === workspace)
        throw new Error('unsafe restore cleanup path');
      await rm(stage, { recursive: true, force: false });
    }
    throw error;
  } finally {
    await release();
  }
}
