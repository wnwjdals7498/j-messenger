import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  statfs,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { DomainError, FILE_MAX_BYTES } from '@j-messenger/contracts';
import type {
  AllowedFileType,
  Clock,
  ConversationAccess,
  DecimalId,
  FileCommands,
  FileDescriptor,
  FeatureLog,
  IdFactory,
  RequestContext,
  SystemContext,
  TxContext,
  Uuid,
} from '@j-messenger/contracts';
import { asStorage, type StorageInput } from '../../platform/storage/index.js';
import type { JobHandler } from '@j-messenger/contracts';
import type { JobStore } from '../../platform/jobs/index.js';

const MIME: Record<AllowedFileType, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
};
const validUuid = (v: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
const safeName = (s: string): string => {
  const name = path.posix
    .basename(s.replace(/\\/g, '/'))
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .trim();
  if (!name || name.length > 255 || name === '.' || name === '..')
    throw new DomainError('bad_request');
  return name;
};
export interface FilePolicy {
  readonly quotaBytes: number;
  readonly minimumFreeBytes: number;
}
export interface FilesOptions {
  readonly db: StorageInput;
  readonly root: string;
  readonly tempRoot: string;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly access: ConversationAccess;
  readonly logger?: FeatureLog;
  readonly policy: FilePolicy;
  readonly jobs: JobStore;
  readonly diskFreeBytes?: (path: string) => Promise<number>;
}
export interface FilesService extends FileCommands {
  readonly deleteHandler: JobHandler<{ fileId: Uuid }>;
  reconcileOrphans(limit: number): Promise<{ removed: number }>;
  attachedLiveIds(
    tx: TxContext,
    context: RequestContext | SystemContext,
    messageId: string,
  ): Promise<readonly Uuid[]>;
  getLiveFileIds(
    tx: TxContext,
    context: RequestContext,
    conversationId: string,
    fileIds: readonly Uuid[],
  ): Promise<readonly FileDescriptor[]>;
  expireBatch(
    tx: TxContext,
    context: SystemContext,
    cutoff: string,
    afterId: string,
    limit: number,
  ): Promise<{ fileIds: readonly string[]; lastId: string; hasMore: boolean }>;
}
interface FileRow {
  id: string;
  server_id: string;
  owner_user_id: bigint;
  conversation_id: bigint;
  filename: string;
  mime_type: string;
  size_bytes: bigint;
  object_key: string;
  state: 'uploading' | 'ready' | 'attached' | 'deleting' | 'deleted';
  created_at: string;
  expires_at: string;
  message_id: bigint | null;
  delete_reason: string | null;
}
const dto = (r: FileRow): FileDescriptor => ({
  id: r.id as Uuid,
  filename: r.filename,
  contentType: r.mime_type as FileDescriptor['contentType'],
  sizeBytes: Number(r.size_bytes),
  status: r.state === 'uploading' ? 'ready' : r.state,
});
const emit = (
  logger: FeatureLog | undefined,
  event: string,
  outcome: 'success' | 'rejected' | 'failure',
  ctx: RequestContext | undefined,
  fields: Record<string, string | number | boolean | null> = {},
) => {
  try {
    logger?.emit({
      featureId: 'F20',
      event,
      outcome,
      ...(ctx ? { requestId: ctx.requestId } : {}),
      fields,
    });
  } catch {}
};
const filePath = (root: string, key: string): string => {
  if (!/^[0-9a-f-]{36}$/.test(key)) throw new DomainError('internal');
  return path.join(root, key.slice(0, 2), key);
};
const moveObject = async (from: string, to: string): Promise<void> => {
  try {
    await rename(from, to);
  } catch (error) {
    if (!(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EXDEV'
    ))
      throw error;
    await copyFile(from, to, fsConstants.COPYFILE_EXCL);
    await rm(from, { force: true });
  }
};
const sniff = (head: Uint8Array, ext: string): boolean => {
  const b = Buffer.from(head);
  if (ext === 'png')
    return b
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (ext === 'jpg' || ext === 'jpeg')
    return b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255;
  if (ext === 'webp')
    return (
      b.length >= 12 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WEBP'
    );
  if (ext === 'pdf') return b.subarray(0, 5).toString('ascii') === '%PDF-';
  if (ext === 'zip' || ext === 'docx' || ext === 'xlsx')
    return (
      b.length >= 4 &&
      b[0] === 0x50 &&
      b[1] === 0x4b &&
      [3, 5, 7].includes(b[2]!) &&
      [4, 6, 8].includes(b[3]!)
    );
  return b.length > 0;
};
const sniffStored = async (
  filename: string,
  ext: string,
  head: Uint8Array,
): Promise<boolean> => {
  if (!sniff(head, ext)) return false;
  if (ext === 'txt' || ext === 'csv') {
    try {
      const data = await readFile(filename);
      if (data.includes(0)) return false;
      new TextDecoder('utf-8', { fatal: true }).decode(data);
      return true;
    } catch {
      return false;
    }
  }
  if (ext === 'docx' || ext === 'xlsx') {
    try {
      const archive = await readFile(filename);
      const names = archive.toString('latin1');
      return (
        names.includes('[Content_Types].xml') &&
        (ext === 'docx'
          ? names.includes('word/document.xml')
          : names.includes('xl/workbook.xml'))
      );
    } catch {
      return false;
    }
  }
  return true;
};
export function createFilesService(options: FilesOptions): FilesService {
  const db = asStorage(options.db);
  if (
    !Number.isSafeInteger(options.policy.quotaBytes) ||
    options.policy.quotaBytes < FILE_MAX_BYTES ||
    !Number.isSafeInteger(options.policy.minimumFreeBytes) ||
    options.policy.minimumFreeBytes < 0
  )
    throw new TypeError('invalid file policy');
  const free =
    options.diskFreeBytes ??
    (async (p) => {
      const s = await statfs(p);
      return Number(s.bavail * s.bsize);
    });
  const lookup = async (id: Uuid): Promise<FileRow | undefined> =>
    (await db.prepare('SELECT * FROM files WHERE id=?').get(id)) as
      FileRow | undefined;
  const handler: JobHandler<{ fileId: Uuid }> = {
    kind: 'files.delete',
    async handle(job) {
      if (!job.payload || !validUuid(job.payload.fileId))
        return { status: 'failed', reason: 'invalid_reference' };
      const row = await lookup(job.payload.fileId);
      if (!row || row.state === 'deleted') return { status: 'completed' };
      if (row.state !== 'deleting')
        return {
          status: 'retry',
          retryAt: new Date(Date.now() + 1000).toISOString(),
          reason: 'state_changed',
        };
      try {
        await rm(filePath(options.root, row.object_key), { force: true });
      } catch {
        try {
          options.logger?.emit({
            featureId: 'F20',
            event: 'files.delete.retry',
            outcome: 'rejected',
            ...(job.requestId ? { requestId: job.requestId } : {}),
            jobId: job.id,
            fields: {
              serverId: row.server_id,
              fileId: row.id,
              reasonCode: 'storage_error',
              attempt: job.attempt,
            },
          });
        } catch {}
        return {
          status: 'retry',
          retryAt: new Date(options.clock.now().getTime() + 1000).toISOString(),
          reason: 'storage_error',
        };
      }
      await db.run(async () => {
        const latest = await lookup(job.payload.fileId);
        if (latest?.state === 'deleting')
          await db
            .prepare(
              "UPDATE files SET state='deleted',filename=NULL,mime_type='application/octet-stream',size_bytes=0,sha256=NULL,deleted_at=? WHERE id=? AND state='deleting'",
            )
            .run(options.clock.now().toISOString(), job.payload.fileId);
      });
      try {
        options.logger?.emit({
          featureId: 'F20',
          event: 'files.delete.completed',
          outcome: 'success',
          ...(job.requestId ? { requestId: job.requestId } : {}),
          jobId: job.id,
          fields: {
            serverId: row.server_id,
            fileId: row.id,
            byteCount: Number(row.size_bytes),
          },
        });
      } catch {}
      return { status: 'completed' };
    },
  };
  const scheduleDelete = async (
    tx: TxContext,
    fileId: Uuid,
    reasonCode: string,
  ): Promise<void> => {
    db.assertOwn(tx);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(reasonCode))
      throw new DomainError('bad_request');
    const row = await lookup(fileId);
    if (!row || row.state === 'deleted' || row.state === 'deleting') return;
    await db
      .prepare("UPDATE files SET state='deleting',delete_reason=? WHERE id=?")
      .run(reasonCode, fileId);
    await options.jobs.enqueue(tx, {
      kind: 'files.delete',
      payload: { fileId },
      serverId: row.server_id,
      dedupKey: `files.delete:${fileId}`,
    });
  };
  return {
    async prepare(context, conversationId, input) {
      await options.access.requireMember(context, conversationId);
      if (
        input.sizeBytes !== null &&
        (!Number.isSafeInteger(input.sizeBytes) ||
          input.sizeBytes < 1 ||
          input.sizeBytes > FILE_MAX_BYTES)
      )
        throw new DomainError('too_large');
      const reservedBytes = input.sizeBytes ?? FILE_MAX_BYTES;
      const filename = safeName(input.filename),
        ext = path.extname(filename).slice(1).toLowerCase(),
        type = ext === 'jpeg' ? 'jpg' : (ext as AllowedFileType),
        mime = MIME[type];
      if (!mime || type !== input.contentType)
        throw new DomainError('bad_request');
      await mkdir(options.root, { recursive: true });
      await mkdir(options.tempRoot, { recursive: true });
      const [available, temporaryAvailable] = await Promise.all([
        free(options.root),
        free(options.tempRoot),
      ]);
      if (
        available - reservedBytes < options.policy.minimumFreeBytes ||
        temporaryAvailable - reservedBytes < options.policy.minimumFreeBytes
      )
        throw new DomainError('unavailable');
      const id = options.ids.uuid(),
        objectKey = randomUUID(),
        now = options.clock.now();
      if (!validUuid(id)) throw new DomainError('internal');
      await db.run(async (tx) => {
        options.access.recheckMember(tx, context, conversationId);
        const used = (await db
          .prepare(
            "SELECT COALESCE(SUM(size_bytes),0) AS n FROM files WHERE server_id=? AND state IN ('uploading','ready','attached','deleting')",
          )
          .get(context.serverId)) as { n: bigint };
        if (Number(used.n) + reservedBytes > options.policy.quotaBytes)
          throw new DomainError('too_large');
        await db
          .prepare(
            "INSERT INTO files(id,server_id,owner_user_id,conversation_id,filename,mime_type,size_bytes,object_key,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?, 'uploading',?,?)",
          )
          .run(
            id,
            context.serverId,
            BigInt(context.userId),
            BigInt(conversationId),
            filename,
            mime,
            reservedBytes,
            objectKey,
            now.toISOString(),
            new Date(now.getTime() + 14 * 86400000).toISOString(),
          );
      });
      const temp = path.join(options.tempRoot, `${objectKey}.part`),
        final = filePath(options.root, objectKey);
      let bytes = 0,
        head = Buffer.alloc(0);
      const hash = createHash('sha256');
      try {
        await mkdir(path.dirname(final), { recursive: true });
        const source = Readable.from(
          (async function* () {
            for await (const piece of input.stream) {
              if (!(piece instanceof Uint8Array))
                throw new DomainError('bad_request');
              bytes += piece.byteLength;
              if (bytes > reservedBytes) throw new DomainError('too_large');
              if (head.length < 8192)
                head = Buffer.concat([
                  head,
                  Buffer.from(piece.subarray(0, 8192 - head.length)),
                ]);
              hash.update(piece);
              yield piece;
            }
          })(),
        );
        await pipeline(
          source,
          createWriteStream(temp, { flags: 'wx', mode: 0o600 }),
        );
        if (
          bytes < 1 ||
          (input.sizeBytes !== null && bytes !== input.sizeBytes) ||
          !(await sniffStored(temp, ext, head))
        )
          throw new DomainError('bad_request');
        await moveObject(temp, final);
        await db.run(async () => {
          const changed = await db
            .prepare(
              "UPDATE files SET state='ready',sha256=?,size_bytes=? WHERE id=? AND state='uploading'",
            )
            .run(hash.digest('hex'), bytes, id);
          if (!changed.changes) throw new DomainError('conflict');
        });
        emit(options.logger, 'files.upload.completed', 'success', context, {
          serverId: context.serverId,
          userId: context.userId,
          fileId: id,
          byteCount: bytes,
        });
        const row = await lookup(id);
        if (!row) throw new DomainError('internal');
        return dto(row);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => {});
        await rm(final, { force: true }).catch(() => {});
        emit(options.logger, 'files.upload.failed', 'failure', context, {
          serverId: context.serverId,
          userId: context.userId,
          reasonCode:
            error instanceof DomainError ? error.code : 'storage_error',
        });
        throw error;
      }
    },
    async bind(tx: TxContext, context, conversationId, messageId, fileIds) {
      db.assertOwn(tx);
      options.access.recheckMember(tx, context, conversationId);
      if (new Set(fileIds).size !== fileIds.length)
        throw new DomainError('bad_request');
      for (const id of fileIds) {
        const row = await lookup(id);
        if (
          !row ||
          row.server_id !== context.serverId ||
          row.owner_user_id !== BigInt(context.userId) ||
          row.conversation_id !== BigInt(conversationId) ||
          row.state !== 'ready'
        )
          throw new DomainError('not_found');
        const changed = await db
          .prepare(
            "UPDATE files SET state='attached',message_id=? WHERE id=? AND state='ready'",
          )
          .run(BigInt(messageId), id);
        if (changed.changes === 0 || changed.changes === 0n)
          throw new DomainError('conflict');
        tx.afterCommit(() =>
          emit(options.logger, 'files.bound', 'success', context, {
            serverId: context.serverId,
            userId: context.userId,
            conversationId,
            messageId,
            fileId: id,
            count: 1,
          }),
        );
      }
    },
    async openDownload(context, fileId) {
      const row = await lookup(fileId);
      if (
        !row ||
        row.server_id !== context.serverId ||
        row.state !== 'attached' ||
        Date.parse(row.expires_at) <= options.clock.now().getTime()
      ) {
        emit(options.logger, 'files.download.rejected', 'rejected', context, {
          serverId: context.serverId,
          userId: context.userId,
          fileId,
          reasonCode: 'not_found',
        });
        throw new DomainError('not_found');
      }
      await options.access.requireMember(
        context,
        String(row.conversation_id) as DecimalId,
      );
      const final = filePath(options.root, row.object_key);
      const stream = (async function* () {
        let byteCount = 0;
        try {
          for await (const chunk of createReadStream(final)) {
            byteCount += chunk.byteLength;
            yield chunk;
          }
          emit(options.logger, 'files.download.completed', 'success', context, {
            serverId: context.serverId,
            userId: context.userId,
            fileId,
            byteCount,
          });
        } catch {
          emit(
            options.logger,
            'files.download.interrupted',
            'rejected',
            context,
            {
              serverId: context.serverId,
              userId: context.userId,
              fileId,
              byteCount,
              reasonCode: 'stream_interrupted',
            },
          );
          throw new DomainError('unavailable');
        }
      })();
      return { descriptor: dto(row), stream };
    },
    scheduleDelete,
    async reconcileOrphans(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        throw new DomainError('bad_request');
      const stale = new Date(
        options.clock.now().getTime() - 60 * 60_000,
      ).toISOString();
      const rows = (await db
        .prepare(
          "SELECT id,object_key FROM files WHERE state='uploading' AND created_at<? ORDER BY created_at LIMIT ?",
        )
        .all(stale, limit)) as Array<{ id: string; object_key: string }>;
      let removed = 0;
      for (const r of rows) {
        await rm(path.join(options.tempRoot, `${r.object_key}.part`), {
          force: true,
        });
        await rm(filePath(options.root, r.object_key), { force: true });
        await db.run(
          async () =>
            await db
              .prepare(
                "UPDATE files SET state='deleted',filename=NULL,mime_type='application/octet-stream',size_bytes=0,sha256=NULL,deleted_at=? WHERE id=? AND state='uploading'",
              )
              .run(options.clock.now().toISOString(), r.id),
        );
        removed++;
      }
      emit(options.logger, 'files.reconcile.completed', 'success', undefined, {
        count: removed,
      });
      return { removed };
    },
    async attachedLiveIds(tx, context, messageId) {
      db.assertOwn(tx);
      if (!/^[1-9][0-9]*$/.test(messageId)) return [];
      const now = options.clock.now().toISOString();
      const rows = (await db
        .prepare(
          "SELECT id FROM files WHERE server_id=? AND message_id=? AND state='attached' AND expires_at>? ORDER BY id",
        )
        .all(context.serverId, BigInt(messageId), now)) as Array<{
        id: string;
      }>;
      return rows.map((r) => r.id as Uuid);
    },
    async getLiveFileIds(tx, context, conversationId, fileIds) {
      db.assertOwn(tx);
      options.access.recheckMember(tx, context, conversationId as DecimalId);
      if (new Set(fileIds).size !== fileIds.length)
        throw new DomainError('bad_request');
      const now = options.clock.now().toISOString();
      const result: FileDescriptor[] = [];
      for (const id of fileIds) {
        const row = await lookup(id);
        if (
          !row ||
          row.server_id !== context.serverId ||
          row.conversation_id !== BigInt(conversationId) ||
          row.owner_user_id !== BigInt(context.userId) ||
          row.state !== 'ready' ||
          row.expires_at <= now
        )
          throw new DomainError('not_found');
        result.push(dto(row));
      }
      return result;
    },
    async expireBatch(tx, context, cutoff, afterId, limit) {
      db.assertOwn(tx);
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isFinite(Date.parse(cutoff)) ||
        !(/^(0|[1-9][0-9]*)$/.test(afterId) || validUuid(afterId))
      )
        throw new DomainError('bad_request');
      const rows = (await db
        .prepare(
          "SELECT id FROM files WHERE server_id=? AND state IN ('ready','attached') AND created_at<=? AND id>? ORDER BY id LIMIT ?",
        )
        .all(context.serverId, cutoff, afterId, limit + 1)) as Array<{
        id: string;
      }>;
      const batch = rows.slice(0, limit);
      for (const row of batch)
        await scheduleDelete(tx, row.id as Uuid, 'retention_expired');
      return {
        fileIds: batch.map((r) => r.id),
        lastId: batch.at(-1)?.id ?? afterId,
        hasMore: rows.length > limit,
      };
    },
    deleteHandler: handler,
  };
}
