import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
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
import path from 'node:path';
import { promisify } from 'node:util';
import type { StorageDatabase } from '../storage/index.js';
import { FILE_MAX_BYTES } from '@j-messenger/contracts';
import type { FeatureLog } from '@j-messenger/contracts';

const execute = promisify(execFile);
const MAX_BYTES = 2 * 1024 ** 3;
const KEEP_COUNT = 7;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PostgresFileReference {
  readonly id: string;
  readonly serverId: string;
  readonly conversationId: string;
  readonly messageId: string | null;
  readonly objectKey: string;
  readonly storagePath: string;
  readonly sha256: string;
  readonly state: 'ready' | 'attached' | 'deleting';
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly bytes: number;
}

export interface PostgresBackupManifest {
  readonly format: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly schema: string;
  readonly database: {
    readonly name: 'database.dump';
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly files: readonly PostgresFileReference[];
  readonly totalBytes: number;
  readonly streamEpoch: string;
}

export interface PostgresOfflineOptions {
  readonly db: StorageDatabase;
  readonly connectionString: string;
  readonly schema: string;
  readonly fileRoot: string;
  readonly backupRoot: string;
  readonly workspaceRoot: string;
  /** Provided by the service lifecycle owner; confirms listeners/workers are quiesced. */
  readonly assertServiceStopped: () => Promise<boolean>;
  readonly operationLock: { acquire(): Promise<() => Promise<void>> };
  /** File module-owned enumeration. The operations layer never queries files tables. */
  readonly listFileReferences: (
    db: StorageDatabase,
  ) => Promise<readonly PostgresFileReference[]>;
  readonly now?: () => Date;
  readonly id?: () => string;
  readonly limitBytes?: number;
  readonly keepCount?: number;
  readonly logger?: FeatureLog;
}

export interface PostgresRestoreOptions extends PostgresOfflineOptions {
  readonly backupDir: string;
  /** Reopen the same dedicated schema after pg_restore; caller keeps public access stopped. */
  readonly reopenDatabase: () => Promise<StorageDatabase>;
  /** Owner modules reapply 5/14-day retention, delete all sessions, and run expired-file jobs. */
  readonly finalizeRestoredState: (input: {
    readonly db: StorageDatabase;
    readonly fileRoot: string;
    readonly currentPolicy: { readonly messageDays: 5; readonly fileDays: 14 };
  }) => Promise<{
    readonly currentPolicyApplied: true;
    readonly sessionsRevoked: true;
  }>;
}

export class PostgresRestoreRecoveryError extends Error {
  constructor(
    readonly recoveryDirectory: string,
    readonly stagingDirectory: string,
    readonly targetMayBePartial: true,
  ) {
    super(
      'PostgreSQL restore rollback could not fully restore the previous state',
    );
    this.name = 'PostgresRestoreRecoveryError';
  }
}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return (
    rel === '' ||
    (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))
  );
}

async function noSymlinkComponents(target: string): Promise<void> {
  let cursor = path.resolve(target);
  while (true) {
    try {
      if ((await lstat(cursor)).isSymbolicLink())
        throw new Error('symbolic link in recovery path');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

async function hashFile(
  file: string,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.byteLength;
    if (!Number.isSafeInteger(bytes))
      throw new Error('file exceeds supported size');
    hash.update(chunk);
  }
  return { sha256: hash.digest('hex'), bytes };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}

async function inspectArchive(archive: string, schema: string): Promise<void> {
  const result = await execute('pg_restore', ['--list', archive], {
    env: process.env,
    maxBuffer: 1024 * 1024,
  });
  const schemaEntries = result.stdout
    .split(/\r?\n/)
    .filter((line) => /^\s*\d+;\s+\d+\s+\d+\s+SCHEMA\s+-\s+/.test(line));
  const expected = schemaEntries.filter((line) => {
    const match = line.match(/^\s*\d+;\s+\d+\s+\d+\s+SCHEMA\s+-\s+(\S+)/);
    return match?.[1] === schema;
  });
  if (expected.length !== 1 || schemaEntries.length !== 1)
    throw new Error('database archive schema does not match configured schema');
}

async function directoryBytes(root: string): Promise<number> {
  const rootStat = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!rootStat) return 0;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error('invalid recovery directory');
  let total = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error('symbolic link in recovery directory');
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) {
        total += (await stat(target)).size;
        if (!Number.isSafeInteger(total))
          throw new Error('recovery directory is too large');
      } else throw new Error('invalid recovery directory entry');
    }
  };
  await visit(root);
  return total;
}

function validateReferences(
  refs: readonly PostgresFileReference[],
): PostgresFileReference[] {
  const sorted = [...refs].sort((a, b) => a.id.localeCompare(b.id));
  const keys = new Set<string>();
  const ids = new Set<string>();
  for (const file of sorted) {
    if (
      !uuidPattern.test(file.id) ||
      !/^[a-z0-9-]{1,32}$/.test(file.serverId) ||
      !/^[1-9][0-9]*$/.test(file.conversationId) ||
      (file.messageId !== null && !/^[1-9][0-9]*$/.test(file.messageId)) ||
      !uuidPattern.test(file.objectKey) ||
      file.storagePath !== `${file.objectKey.slice(0, 2)}/${file.objectKey}` ||
      !/^[0-9a-f]{64}$/i.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > FILE_MAX_BYTES ||
      !['ready', 'attached', 'deleting'].includes(file.state) ||
      !Number.isFinite(Date.parse(file.createdAt)) ||
      !Number.isFinite(Date.parse(file.expiresAt)) ||
      keys.has(file.objectKey) ||
      ids.has(file.id)
    )
      throw new Error('invalid file reference manifest');
    keys.add(file.objectKey);
    ids.add(file.id);
  }
  return sorted;
}

async function snapshotFiles(
  root: string,
  destination: string,
  refs: readonly PostgresFileReference[],
): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const ref of refs) {
    const from = path.resolve(root, ref.storagePath);
    const to = path.resolve(destination, ref.objectKey);
    if (
      !inside(path.resolve(root), from) ||
      !inside(path.resolve(destination), to)
    )
      throw new Error('unsafe file reference');
    const sourceStat = await lstat(from);
    if (
      !sourceStat.isFile() ||
      sourceStat.isSymbolicLink() ||
      sourceStat.size !== ref.bytes ||
      sourceStat.size > FILE_MAX_BYTES
    )
      throw new Error('missing referenced file');
    await copyFile(from, to);
    const digest = await hashFile(to);
    if (digest.sha256 !== ref.sha256 || digest.bytes !== ref.bytes)
      throw new Error('file integrity mismatch');
  }
}

async function verifyFilesAtRoot(
  root: string,
  refs: readonly PostgresFileReference[],
): Promise<void> {
  for (const ref of refs) {
    const file = path.resolve(root, ref.storagePath);
    if (!inside(path.resolve(root), file))
      throw new Error('unsafe file reference');
    await noSymlinkComponents(file);
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== ref.bytes ||
      info.size > FILE_MAX_BYTES
    )
      throw new Error('missing referenced file');
    const digest = await hashFile(file);
    if (digest.sha256 !== ref.sha256 || digest.bytes !== ref.bytes)
      throw new Error('file integrity mismatch');
  }
}

function manifestPath(directory: string): string {
  return path.join(directory, 'manifest.json');
}

async function readAndVerify(
  options: Pick<PostgresOfflineOptions, 'backupRoot' | 'schema'> & {
    backupDir: string;
  },
): Promise<PostgresBackupManifest> {
  const root = path.resolve(options.backupRoot);
  const dir = path.resolve(options.backupDir);
  if (!inside(root, dir) || dir === root)
    throw new Error('backup is outside configured root');
  const dirStat = await lstat(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink())
    throw new Error('invalid backup directory');
  const manifestFile = manifestPath(dir);
  await noSymlinkComponents(manifestFile);
  const manifestStat = await lstat(manifestFile);
  if (!manifestStat.isFile() || manifestStat.size > MAX_MANIFEST_BYTES)
    throw new Error('invalid backup manifest');
  const text = await readFile(manifestFile, 'utf8');
  const manifest = JSON.parse(text) as PostgresBackupManifest;
  if (
    manifest.format !== 1 ||
    !uuidPattern.test(manifest.id) ||
    dir !== path.join(root, manifest.id) ||
    manifest.schema !== options.schema ||
    manifest.database.name !== 'database.dump' ||
    !Array.isArray(manifest.files)
  )
    throw new Error('invalid backup manifest');
  if (
    !Number.isSafeInteger(manifest.database.bytes) ||
    manifest.database.bytes <= 0 ||
    manifest.database.bytes > MAX_BYTES ||
    !/^[0-9a-f]{64}$/i.test(manifest.database.sha256) ||
    !uuidPattern.test(manifest.streamEpoch) ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    !Number.isSafeInteger(manifest.totalBytes) ||
    manifest.totalBytes <= 0 ||
    manifest.totalBytes > MAX_BYTES
  )
    throw new Error('invalid backup manifest metadata');
  const archive = path.join(dir, 'database.dump');
  await noSymlinkComponents(archive);
  const archiveStat = await lstat(archive);
  if (
    !archiveStat.isFile() ||
    archiveStat.isSymbolicLink() ||
    archiveStat.size !== manifest.database.bytes ||
    archiveStat.size > MAX_BYTES
  )
    throw new Error('invalid database archive');
  const digest = await hashFile(archive);
  if (
    digest.sha256 !== manifest.database.sha256 ||
    digest.bytes !== manifest.database.bytes
  )
    throw new Error('database archive checksum mismatch');
  const recorded = validateReferences(manifest.files);
  const filesDirectory = path.join(dir, 'files');
  await noSymlinkComponents(filesDirectory);
  const actualNames = (await readdir(filesDirectory)).sort();
  const expectedNames = recorded.map((file) => file.objectKey).sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  )
    throw new Error('backup file manifest topology mismatch');
  let total = digest.bytes + Buffer.byteLength(text);
  for (let i = 0; i < recorded.length; i++) {
    const actual = recorded[i]!;
    const file = path.resolve(dir, 'files', actual.objectKey);
    if (!inside(dir, file)) throw new Error('unsafe backup file path');
    await noSymlinkComponents(file);
    const fileStat = await lstat(file);
    if (
      !fileStat.isFile() ||
      fileStat.isSymbolicLink() ||
      fileStat.size !== actual.bytes ||
      fileStat.size > FILE_MAX_BYTES
    )
      throw new Error('missing backup file');
    const fileDigest = await hashFile(file);
    if (
      fileDigest.sha256 !== actual.sha256 ||
      fileDigest.bytes !== actual.bytes
    )
      throw new Error('backup file checksum mismatch');
    total += fileDigest.bytes;
  }
  if (
    !Number.isSafeInteger(manifest.totalBytes) ||
    manifest.totalBytes > MAX_BYTES ||
    total !== manifest.totalBytes
  )
    throw new Error('backup size mismatch');
  return manifest;
}

export async function createPostgresOfflineBackup(
  options: PostgresOfflineOptions,
): Promise<PostgresBackupManifest> {
  if (options.db.kind !== 'postgres' || !(await options.assertServiceStopped()))
    throw new Error('stopped PostgreSQL service is required');
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(options.schema))
    throw new TypeError('invalid PostgreSQL schema');
  positiveInteger(options.limitBytes ?? MAX_BYTES, 'limitBytes');
  positiveInteger(options.keepCount ?? KEEP_COUNT, 'keepCount');
  const release = await options.operationLock.acquire();
  try {
    if (!(await options.assertServiceStopped()))
      throw new Error('PostgreSQL service resumed during backup acquisition');
    const root = path.resolve(options.backupRoot);
    const filesRoot = path.resolve(options.fileRoot);
    await Promise.all([
      noSymlinkComponents(root),
      noSymlinkComponents(filesRoot),
    ]);
    if (inside(root, filesRoot) || inside(filesRoot, root))
      throw new Error('overlapping backup paths');
    if (
      !inside(path.resolve(options.workspaceRoot), root) ||
      !inside(path.resolve(options.workspaceRoot), filesRoot)
    )
      throw new Error('backup paths are outside configured workspace');
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(root, 0o700);
    const id = options.id?.() ?? randomUUID();
    if (!uuidPattern.test(id)) throw new TypeError('invalid backup id');
    const destination = path.join(root, id);
    const temporary = path.join(root, `.${id}.partial`);
    try {
      await lstat(destination);
      throw new Error('backup destination already exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(temporary, { mode: 0o700 });
    try {
      const dbPath = path.join(temporary, 'database.dump');
      if (!(await options.assertServiceStopped()))
        throw new Error('PostgreSQL service resumed before snapshot');
      await options.db.backup(dbPath);
      const archiveStat = await lstat(dbPath);
      if (
        !archiveStat.isFile() ||
        archiveStat.isSymbolicLink() ||
        archiveStat.size <= 0 ||
        archiveStat.size > (options.limitBytes ?? MAX_BYTES)
      )
        throw new Error('database archive size limit exceeded');
      await inspectArchive(dbPath, options.schema);
      const files = validateReferences(
        await options.listFileReferences(options.db),
      );
      await snapshotFiles(filesRoot, path.join(temporary, 'files'), files);
      const database = {
        name: 'database.dump' as const,
        ...(await hashFile(dbPath)),
      };
      const epoch = await options.db.getStreamMetadata();
      const base = {
        format: 1 as const,
        id,
        createdAt: (options.now?.() ?? new Date()).toISOString(),
        schema: options.schema,
        database,
        files,
        streamEpoch: epoch.epoch,
      };
      let totalBytes =
        database.bytes + files.reduce((sum, file) => sum + file.bytes, 0);
      let serialized = '';
      for (let attempt = 0; attempt < 4; attempt++) {
        serialized = `${JSON.stringify({ ...base, totalBytes }, null, 2)}\n`;
        const next =
          database.bytes +
          files.reduce((sum, file) => sum + file.bytes, 0) +
          Buffer.byteLength(serialized);
        if (next === totalBytes) break;
        totalBytes = next;
      }
      serialized = `${JSON.stringify({ ...base, totalBytes }, null, 2)}\n`;
      if (
        database.bytes +
          files.reduce((sum, file) => sum + file.bytes, 0) +
          Buffer.byteLength(serialized) !==
        totalBytes
      )
        throw new Error('manifest size did not stabilize');
      if (totalBytes > (options.limitBytes ?? MAX_BYTES))
        throw new Error('backup size limit exceeded');
      if (!(await options.assertServiceStopped()))
        throw new Error('PostgreSQL service resumed during snapshot');
      await writeFile(manifestPath(temporary), serialized, {
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporary, destination);
      const dirs = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && uuidPattern.test(entry.name))
        .map((entry) => entry.name);
      const records = await Promise.all(
        dirs.map(async (name) => {
          const dir = path.join(root, name);
          const checked = await readAndVerify({
            backupRoot: root,
            backupDir: dir,
            schema: options.schema,
          });
          return {
            name,
            time: (await stat(dir)).mtimeMs,
            bytes: checked.totalBytes,
          };
        }),
      );
      records.sort((a, b) => a.time - b.time);
      let used = records.reduce((sum, item) => sum + item.bytes, 0);
      let rootUsed = await directoryBytes(root);
      while (
        records.length > (options.keepCount ?? KEEP_COUNT) ||
        used > (options.limitBytes ?? MAX_BYTES) ||
        rootUsed > (options.limitBytes ?? MAX_BYTES)
      ) {
        const index = records.findIndex((item) => item.name !== id);
        if (index < 0) throw new Error('backup retention limit exceeded');
        const [removed] = records.splice(index, 1);
        used -= removed!.bytes;
        await rm(path.join(root, removed!.name), {
          recursive: true,
          force: false,
        });
        rootUsed = await directoryBytes(root);
      }
      try {
        options.logger?.emit({
          featureId: 'F45',
          event: 'operations.backup.completed',
          outcome: 'success',
          fields: {
            backupId: id,
            byteCount: totalBytes,
            count: files.length,
            schema: options.schema,
          },
        });
      } catch {}
      return { ...base, totalBytes };
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
      try {
        options.logger?.emit({
          featureId: 'F45',
          event: 'operations.backup.failed',
          outcome: 'failure',
          fields: { backupId: id },
        });
      } catch {}
      throw error;
    }
  } finally {
    await release();
  }
}

export async function verifyPostgresOfflineBackup(
  options: PostgresOfflineOptions & { readonly backupDir: string },
): Promise<PostgresBackupManifest> {
  if (options.db.kind !== 'postgres' || !(await options.assertServiceStopped()))
    throw new Error('stopped PostgreSQL service is required');
  const release = await options.operationLock.acquire();
  try {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(options.schema))
      throw new TypeError('invalid PostgreSQL schema');
    if (!(await options.assertServiceStopped()))
      throw new Error('PostgreSQL service resumed during verification');
    const result = await readAndVerify(options);
    await inspectArchive(
      path.join(options.backupDir, 'database.dump'),
      options.schema,
    );
    return result;
  } finally {
    await release();
  }
}

async function pgRestore(
  connectionString: string,
  schema: string,
  archive: string,
  clean: boolean,
): Promise<void> {
  // The TOC/schema check constrains the target namespace; it does not sandbox SQL.
  // Archives must be trusted and restored only into the dedicated DB/schema.
  const url = new URL(connectionString);
  if (
    !['postgresql:', 'postgres:'].includes(url.protocol) ||
    !url.hostname ||
    !url.pathname ||
    url.search ||
    url.hash ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(schema)
  )
    throw new Error('invalid PostgreSQL recovery connection');
  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
  };
  const args = [
    '--no-owner',
    '--no-acl',
    '--exit-on-error',
    '--single-transaction',
    `--schema=${schema}`,
  ];
  if (clean) args.push('--clean', '--if-exists');
  args.push('--dbname', env.PGDATABASE, archive);
  try {
    await inspectArchive(archive, schema);
    await execute('pg_restore', args, {
      env,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new Error('PostgreSQL archive restore failed');
  }
}

export async function restorePostgresOfflineBackup(
  options: PostgresRestoreOptions,
): Promise<{ readonly recoveryDirectory: string; readonly backupId: string }> {
  if (options.db.kind !== 'postgres' || !(await options.assertServiceStopped()))
    throw new Error('stopped PostgreSQL service is required');
  positiveInteger(options.limitBytes ?? MAX_BYTES, 'limitBytes');
  positiveInteger(options.keepCount ?? KEEP_COUNT, 'keepCount');
  const release = await options.operationLock.acquire();
  let stage: string | undefined;
  let recovery: string | undefined;
  let oldFilesMoved = false;
  let newFilesMoved = false;
  let openDb: StorageDatabase | undefined = options.db;
  let originalDbClosed = false;
  let backupId: string | undefined;
  try {
    if (!(await options.assertServiceStopped()))
      throw new Error('PostgreSQL service resumed before restore');
    const workspace = path.resolve(options.workspaceRoot);
    const root = path.resolve(options.backupRoot);
    const files = path.resolve(options.fileRoot);
    const backup = path.resolve(options.backupDir);
    if (
      !inside(workspace, root) ||
      !inside(workspace, files) ||
      !inside(root, backup) ||
      root === files ||
      inside(root, files) ||
      inside(files, root)
    )
      throw new Error('recovery paths are outside configured workspace');
    await Promise.all([
      noSymlinkComponents(workspace),
      noSymlinkComponents(root),
      noSymlinkComponents(files),
      noSymlinkComponents(backup),
    ]);
    const manifest = await readAndVerify(options);
    backupId = manifest.id;
    try {
      options.logger?.emit({
        featureId: 'F46',
        event: 'operations.restore.started',
        outcome: 'success',
        fields: { backupId, schema: options.schema },
      });
    } catch {}
    await inspectArchive(path.join(backup, 'database.dump'), options.schema);
    const currentId = randomUUID();
    recovery = path.join(root, `recovery-${currentId}`);
    stage = path.join(workspace, `.pg-restore-${currentId}`);
    await mkdir(recovery, { recursive: false, mode: 0o700 });
    await mkdir(stage, { recursive: false, mode: 0o700 });
    const currentArchive = path.join(recovery, 'database.dump');
    await options.db.backup(currentArchive);
    const currentRefs = validateReferences(
      await options.listFileReferences(options.db),
    );
    await verifyFilesAtRoot(files, currentRefs);
    const existingBackupBytes = await directoryBytes(root);
    const currentFilesBytes = await directoryBytes(files);
    if (
      existingBackupBytes + currentFilesBytes >
      (options.limitBytes ?? MAX_BYTES)
    )
      throw new Error('restore recovery size limit exceeded');
    if (
      await lstat(files)
        .then((s) => !s.isDirectory() || s.isSymbolicLink())
        .catch((e: NodeJS.ErrnoException) => e.code !== 'ENOENT')
    )
      throw new Error('invalid current file root');
    const stagedFiles = path.join(stage, 'files');
    await mkdir(stagedFiles, { mode: 0o700 });
    for (const ref of manifest.files)
      await mkdir(path.dirname(path.join(stagedFiles, ref.storagePath)), {
        recursive: true,
        mode: 0o700,
      });
    for (const ref of manifest.files)
      await copyFile(
        path.join(backup, 'files', ref.objectKey),
        path.join(stagedFiles, ref.storagePath),
      );
    await options.db.close();
    originalDbClosed = true;
    openDb = undefined;
    if (!(await options.assertServiceStopped()))
      throw new Error('PostgreSQL service resumed before archive restore');
    await pgRestore(
      options.connectionString,
      options.schema,
      path.join(backup, 'database.dump'),
      true,
    );
    if (
      await lstat(files)
        .then(() => true)
        .catch(() => false)
    ) {
      await rename(files, path.join(recovery, 'files'));
      oldFilesMoved = true;
    }
    await rename(stagedFiles, files);
    newFilesMoved = true;
    openDb = await options.reopenDatabase();
    if (openDb.kind !== 'postgres')
      throw new Error('reopened database is not PostgreSQL');
    const finalized = await options.finalizeRestoredState({
      db: openDb,
      fileRoot: files,
      currentPolicy: { messageDays: 5, fileDays: 14 },
    });
    if (
      finalized.currentPolicyApplied !== true ||
      finalized.sessionsRevoked !== true
    )
      throw new Error('restore finalization incomplete');
    const epoch = await openDb.getStreamMetadata();
    if (epoch.epoch === manifest.streamEpoch)
      throw new Error('restore stream epoch was not rotated');
    const restoredRefs = validateReferences(
      await options.listFileReferences(openDb),
    );
    const archivedRefs = new Map(manifest.files.map((ref) => [ref.id, ref]));
    for (const ref of restoredRefs) {
      const archived = archivedRefs.get(ref.id);
      if (
        !archived ||
        archived.serverId !== ref.serverId ||
        archived.conversationId !== ref.conversationId ||
        archived.messageId !== ref.messageId ||
        archived.objectKey !== ref.objectKey ||
        archived.storagePath !== ref.storagePath ||
        archived.sha256 !== ref.sha256 ||
        archived.state !== ref.state ||
        archived.createdAt !== ref.createdAt ||
        archived.expiresAt !== ref.expiresAt ||
        archived.bytes !== ref.bytes
      )
        throw new Error('restored file manifest mismatch');
      const file = path.resolve(files, ref.storagePath);
      if (!inside(files, file))
        throw new Error('unsafe restored file reference');
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error('restored file is missing');
      const digest = await hashFile(file);
      if (digest.sha256 !== ref.sha256 || digest.bytes !== ref.bytes)
        throw new Error('restored file integrity mismatch');
    }
    const retainedPaths = new Set(restoredRefs.map((ref) => ref.storagePath));
    for (const ref of manifest.files)
      if (!retainedPaths.has(ref.storagePath)) {
        const exists = await lstat(path.join(files, ref.storagePath))
          .then(() => true)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          });
        if (exists)
          throw new Error('expired file cleanup is incomplete after restore');
      }
    await openDb.close();
    openDb = undefined;
    if (!(await options.assertServiceStopped()))
      throw new Error('PostgreSQL service resumed before recovery completion');
    await rm(stage, { recursive: true, force: false });
    stage = undefined;
    try {
      options.logger?.emit({
        featureId: 'F46',
        event: 'operations.restore.completed',
        outcome: 'success',
        fields: {
          backupId,
          count: restoredRefs.length,
          messageDays: 5,
          fileDays: 14,
        },
      });
    } catch {}
    return { recoveryDirectory: recovery, backupId: manifest.id };
  } catch (error) {
    if (openDb && (openDb !== options.db || originalDbClosed)) {
      await openDb.close().catch(() => {});
      openDb = undefined;
    }
    let rollbackFailed = false;
    if (recovery && originalDbClosed) {
      try {
        if (
          await lstat(path.join(recovery, 'database.dump'))
            .then(() => true)
            .catch(() => false)
        ) {
          const archive = path.join(recovery, 'database.dump');
          await pgRestore(
            options.connectionString,
            options.schema,
            archive,
            true,
          );
        }
        if (newFilesMoved)
          await rm(options.fileRoot, { recursive: true, force: true });
        if (oldFilesMoved)
          await rename(path.join(recovery, 'files'), options.fileRoot);
      } catch {
        rollbackFailed = true;
      }
    }
    if (rollbackFailed && recovery && stage)
      throw new PostgresRestoreRecoveryError(recovery, stage, true);
    if (stage)
      await rm(stage, { recursive: true, force: true }).catch(() => {});
    if (recovery)
      await rm(recovery, { recursive: true, force: true }).catch(() => {});
    try {
      options.logger?.emit({
        featureId: 'F46',
        event: 'operations.restore.failed',
        outcome: 'failure',
        fields: { ...(backupId ? { backupId } : {}) },
      });
    } catch {}
    throw error;
  } finally {
    await release();
  }
}
