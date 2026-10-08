import { DomainError } from '@j-messenger/contracts';
import type {
  AuditWriter,
  Clock,
  FeatureLog,
  RequestContext,
  RetentionCommands,
  RetentionPolicy,
  SystemContext,
  TxContext,
} from '@j-messenger/contracts';
import { asStorage, type StorageInput } from '../../platform/storage/index.js';
import type { FilesService } from '../files/index.js';

export interface RetentionProgress {
  readonly messages: number;
  readonly files: number;
  readonly complete: boolean;
}
export interface RetentionOptions {
  readonly db: StorageInput;
  readonly clock: Clock;
  readonly files: FilesService;
  readonly audit: AuditWriter;
  readonly logger?: FeatureLog;
  readonly authorizeAdmin?: (context: RequestContext) => Promise<boolean>;
  /** Runs synchronously in the supplied transaction and must update messages/events only through their owner. */
  readonly purgeMessages: (
    tx: TxContext,
    context: SystemContext,
    cutoff: string,
    afterId: string,
    limit: number,
  ) =>
    | { processed: number; lastId: string; hasMore: boolean }
    | Promise<{ processed: number; lastId: string; hasMore: boolean }>;
  readonly eventExpiredFile: (
    tx: TxContext,
    context: SystemContext,
    fileId: string,
  ) => void | Promise<void>;
  readonly policyRoutesEnabled?: boolean;
}
const defaultPolicy: RetentionPolicy = {
  messageDays: 5,
  fileDays: 14,
  version: 1,
};
const emit = (
  o: RetentionOptions,
  event: string,
  outcome: 'success' | 'rejected' | 'failure',
  c: RequestContext | SystemContext,
  fields: Record<string, string | number | boolean | null> = {},
) => {
  try {
    o.logger?.emit({
      featureId: 'F27',
      event,
      outcome,
      requestId: c.requestId,
      ...('jobId' in c && c.jobId ? { jobId: c.jobId } : {}),
      fields,
    });
  } catch {}
};
const days = (d: number) => d * 86_400_000;
export function createRetentionService(
  options: RetentionOptions,
): RetentionCommands & {
  applyCurrentPolicy(context: SystemContext): Promise<void>;
  runSystemBatch(
    context: SystemContext,
    limit: number,
  ): Promise<RetentionProgress>;
} {
  const db = asStorage(options.db);
  const policy = async (serverId: string): Promise<RetentionPolicy> => {
    const row = (await db
      .prepare(
        'SELECT message_days,file_days,version FROM retention_policies WHERE server_id=?',
      )
      .get(serverId)) as
      { message_days: bigint; file_days: bigint; version: bigint } | undefined;
    return row
      ? {
          messageDays: Number(row.message_days),
          fileDays: Number(row.file_days),
          version: Number(row.version),
        }
      : defaultPolicy;
  };
  const authorize = async (c: RequestContext) => {
    if (
      !options.policyRoutesEnabled ||
      !options.authorizeAdmin ||
      !(await options.authorizeAdmin(c))
    ) {
      emit(options, 'retention.policy.accessed', 'rejected', c, {
        serverId: c.serverId,
        reasonCode: 'forbidden',
      });
      throw new DomainError('forbidden');
    }
  };
  const progress = async (serverId: string, kind: 'messages' | 'files') =>
    (await db
      .prepare(
        'SELECT last_id,cutoff_at,policy_version FROM retention_progress WHERE server_id=? AND kind=?',
      )
      .get(serverId, kind)) as
      | {
          last_id: string | null;
          cutoff_at: string | null;
          policy_version: bigint;
        }
      | undefined;
  return {
    /** Offline recovery re-applies the current policy before public access. */
    async applyCurrentPolicy(context: SystemContext) {
      if (!/^[a-z0-9-]{1,32}$/.test(context.serverId))
        throw new DomainError('bad_request');
      await db.run(async (tx) => {
        db.assertOwn(tx);
        const old = await policy(context.serverId);
        await db
          .prepare(
            'INSERT INTO retention_policies(server_id,message_days,file_days,version,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(server_id) DO UPDATE SET message_days=excluded.message_days,file_days=excluded.file_days,version=excluded.version,updated_at=excluded.updated_at',
          )
          .run(
            context.serverId,
            5,
            14,
            old.version + 1,
            options.clock.now().toISOString(),
          );
        await db
          .prepare('DELETE FROM retention_progress WHERE server_id=?')
          .run(context.serverId);
      });
    },
    async get(context) {
      await authorize(context);
      return await policy(context.serverId);
    },
    async update(context, next) {
      await authorize(context);
      if (
        !Number.isSafeInteger(next.messageDays) ||
        next.messageDays !== 5 ||
        !Number.isSafeInteger(next.fileDays) ||
        next.fileDays !== 14
      )
        throw new DomainError('bad_request');
      await db.run(async (tx) => {
        const old = await policy(context.serverId);
        const version = old.version + 1;
        await db
          .prepare(
            'INSERT INTO retention_policies(server_id,message_days,file_days,version,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(server_id) DO UPDATE SET message_days=excluded.message_days,file_days=excluded.file_days,version=excluded.version,updated_at=excluded.updated_at',
          )
          .run(
            context.serverId,
            5,
            14,
            version,
            options.clock.now().toISOString(),
          );
        await options.audit.append(tx, context, {
          action: 'retention.policy.updated',
          targetId: null,
          metadata: {
            policyVersion: version,
            messageDays: 5,
            attachmentDays: 14,
          },
        });
        tx.afterCommit(() =>
          emit(options, 'retention.policy.changed', 'success', context, {
            serverId: context.serverId,
            userId: context.userId,
            policyVersion: version,
          }),
        );
      });
    },
    async purgeBatch(context, limit) {
      if (
        !options.policyRoutesEnabled ||
        !options.authorizeAdmin ||
        !(await options.authorizeAdmin(context))
      )
        throw new DomainError('forbidden');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new DomainError('bad_request');
      const result = await db.run(async (tx) => {
        const sys: SystemContext = {
          serverId: context.serverId,
          requestId: context.requestId,
        };
        return await processBatch(tx, sys, limit);
      });
      emit(options, 'retention.batch.completed', 'success', context, {
        serverId: context.serverId,
        userId: context.userId,
        processedCount: result.messages + result.files,
      });
      return { messages: result.messages, files: result.files };
    },
    async runSystemBatch(context, limit) {
      if (
        !/^[a-z0-9-]{1,32}$/.test(context.serverId) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        throw new DomainError('bad_request');
      const result = await db.run(
        async (tx) => await processBatch(tx, context, limit),
      );
      emit(options, 'retention.batch.completed', 'success', context, {
        serverId: context.serverId,
        messageCount: result.messages,
        fileCount: result.files,
      });
      return result;
    },
  };

  async function processBatch(
    tx: TxContext,
    context: SystemContext,
    limit: number,
  ): Promise<RetentionProgress> {
    db.assertOwn(tx);
    const current = await policy(context.serverId),
      now = options.clock.now();
    const getCursor = async (
      kind: 'messages' | 'files',
      retentionDays: number,
    ) => {
      const old = await progress(context.serverId, kind);
      if (
        old &&
        Number(old.policy_version) === current.version &&
        old.cutoff_at
      )
        return { after: old.last_id ?? '0', cutoff: old.cutoff_at };
      return {
        after: '0',
        cutoff: new Date(now.getTime() - days(retentionDays)).toISOString(),
      };
    };
    const write = async (
      kind: 'messages' | 'files',
      lastId: string,
      cutoff: string,
    ) =>
      await db
        .prepare(
          'INSERT INTO retention_progress(server_id,kind,last_id,cutoff_at,policy_version,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(server_id,kind) DO UPDATE SET last_id=excluded.last_id,cutoff_at=excluded.cutoff_at,policy_version=excluded.policy_version,updated_at=excluded.updated_at',
        )
        .run(
          context.serverId,
          kind,
          lastId,
          cutoff,
          current.version,
          now.toISOString(),
        );
    const mc = await getCursor('messages', current.messageDays),
      messageResult = await options.purgeMessages(
        tx,
        context,
        mc.cutoff,
        mc.after,
        limit,
      );
    await write(
      'messages',
      messageResult.hasMore ? messageResult.lastId : '0',
      messageResult.hasMore
        ? mc.cutoff
        : new Date(now.getTime() - days(current.messageDays)).toISOString(),
    );
    const fc = await getCursor('files', current.fileDays),
      fileResult = await options.files.expireBatch(
        tx,
        context,
        fc.cutoff,
        fc.after,
        limit,
      );
    for (const fileId of fileResult.fileIds)
      await options.eventExpiredFile(tx, context, fileId);
    await write(
      'files',
      fileResult.hasMore ? fileResult.lastId : '0',
      fileResult.hasMore
        ? fc.cutoff
        : new Date(now.getTime() - days(current.fileDays)).toISOString(),
    );
    const hasMessages = messageResult.hasMore,
      hasFiles = fileResult.hasMore;
    return {
      messages: messageResult.processed,
      files: fileResult.fileIds.length,
      complete: !hasMessages && !hasFiles,
    };
  }
}
