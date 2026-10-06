import {
  DomainError,
  normalizeMessageText,
  type Clock,
  type ConversationAccess,
  type ConversationActivity,
  type DecimalId,
  type EventDto,
  type EventRecord,
  type FeatureLog,
  type FileCommands,
  type MessageOutput,
  type MessageQueries,
  type OpaqueCursorCodec,
  type Page,
  type RequestContext,
  type SystemContext,
  type TxContext,
  type Uuid,
} from '@j-messenger/contracts';
import type { Database } from '../../platform/database/index.js';

export interface FilesPort extends Pick<FileCommands, 'bind'> {
  attachedLiveIds(
    tx: TxContext,
    context: RequestContext | SystemContext,
    messageId: DecimalId,
  ): readonly Uuid[];
}
export interface MessageService extends MessageCommandsSurface, MessageQueries {
  validateMessage(
    tx: TxContext,
    context: RequestContext,
    conversationId: DecimalId,
    messageId: DecimalId,
  ): MessageOutput;
  purgeExpiredBatch(
    tx: TxContext,
    system: SystemContext,
    cutoff: string,
    afterId: string,
    limit: number,
  ): { processed: number; lastId: string; hasMore: boolean };
  expireFileReference(tx: TxContext, system: SystemContext, fileId: Uuid): void;
  hydrateEvent(
    context: RequestContext,
    record: EventRecord,
  ): Promise<EventDto | null>;
  purgeExpiredForServer(
    system: SystemContext,
    cutoff?: string,
    limit?: number,
  ): Promise<{ purged: number }>;
}
interface MessageCommandsSurface {
  create(
    context: RequestContext,
    conversationId: DecimalId,
    input: { clientMessageId: Uuid; text: string; fileIds?: readonly Uuid[] },
  ): Promise<{ message: MessageOutput; created: boolean; status: 200 | 201 }>;
}
export interface MessageOptions {
  readonly db: Database;
  readonly access: ConversationAccess;
  readonly activity: ConversationActivity & {
    memberIdsForSystem(
      tx: TxContext,
      system: SystemContext,
      conversationId: DecimalId,
    ): readonly DecimalId[];
  };
  readonly clock: Clock;
  readonly logger?: FeatureLog;
  readonly files?: FilesPort;
  readonly cursorCodec: OpaqueCursorCodec;
}
export class MessageError extends DomainError {
  constructor(
    code:
      | 'bad_request'
      | 'unauthorized'
      | 'not_found'
      | 'conflict'
      | 'message_expired'
      | 'internal'
      | 'unavailable' = 'internal',
  ) {
    super(code);
    this.name = 'MessageError';
  }
}
type MessageRow = {
  id: bigint;
  conversation_id: bigint;
  sender_id: bigint;
  client_message_id: string;
  text: string | null;
  content_expired: bigint;
  created_at: string;
};
const positive = (value: string): boolean =>
  /^[1-9][0-9]*$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
const decimal = (value: unknown): string =>
  typeof value === 'bigint' ? value.toString() : String(value);
const safeEmit = (
  logger: FeatureLog | undefined,
  event: string,
  outcome: 'success' | 'rejected' | 'failure',
  ctx: RequestContext | SystemContext | undefined,
  fields: Record<string, string | number | boolean | null>,
): void => {
  try {
    logger?.emit({
      featureId: 'F11',
      event,
      outcome,
      ...(ctx ? { requestId: ctx.requestId } : {}),
      ...(ctx && 'jobId' in ctx && ctx.jobId ? { jobId: ctx.jobId } : {}),
      fields,
    });
  } catch {
    /* diagnostics cannot change message behavior */
  }
};

export function createMessageService(options: MessageOptions): MessageService {
  const { db, access, activity, clock, logger, files, cursorCodec } = options;
  const epoch = (): string => db.getStreamMetadata().epoch;
  const encode = (context: RequestContext, position: string): string => {
    return cursorCodec.encode({
      serverId: context.serverId,
      userId: context.userId,
      epoch: epoch(),
      position,
      expiresAt: new Date(clock.now().getTime() + 15 * 60_000).toISOString(),
    });
  };
  const messageQuery =
    'SELECT id,conversation_id,sender_id,client_message_id,text,content_expired,created_at FROM messages';
  const validateMessage = (
    tx: TxContext,
    context: RequestContext,
    conversationId: DecimalId,
    messageId: DecimalId,
  ): MessageOutput => {
    db.assertOwn(tx);
    access.recheckMember(tx, context, conversationId);
    const row = db
      .prepare(
        `${messageQuery} WHERE server_id=? AND conversation_id=? AND id=?`,
      )
      .get(context.serverId, BigInt(conversationId), BigInt(messageId)) as
      MessageRow | undefined;
    if (!row) throw new MessageError('not_found');
    return output(tx, context, row);
  };
  const fileIds = (
    tx: TxContext,
    context: RequestContext,
    conversationId: DecimalId,
    messageId: DecimalId,
  ): Uuid[] => {
    if (!files) return [];
    void conversationId;
    return [...files.attachedLiveIds(tx, context, messageId)];
  };
  const output = (
    tx: TxContext,
    context: RequestContext,
    row: MessageRow,
  ): MessageOutput => ({
    id: decimal(row.id) as DecimalId,
    conversationId: decimal(row.conversation_id) as DecimalId,
    senderId: decimal(row.sender_id) as DecimalId,
    clientMessageId: row.client_message_id as Uuid,
    text: row.content_expired === 1n ? null : row.text,
    contentExpired: row.content_expired === 1n,
    fileIds: fileIds(
      tx,
      context,
      decimal(row.conversation_id) as DecimalId,
      decimal(row.id) as DecimalId,
    ),
    createdAt: row.created_at,
  });
  const purgeBatch = (
    tx: TxContext,
    system: SystemContext,
    cutoff: string,
    afterId: string,
    limit: number,
  ) => {
    db.assertOwn(tx);
    if (
      !/^[a-z0-9-]{1,32}$/.test(system.serverId) ||
      !/^(0|[1-9][0-9]*)$/.test(afterId) ||
      Number.isNaN(Date.parse(cutoff)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 5000
    )
      throw new MessageError('bad_request');
    const rows = db
      .prepare(
        'SELECT id,conversation_id,sender_id,client_message_id,created_at FROM messages WHERE server_id=? AND content_expired=0 AND created_at<=? AND id>? ORDER BY id LIMIT ?',
      )
      .all(system.serverId, cutoff, BigInt(afterId), limit) as Array<{
      id: bigint;
      conversation_id: bigint;
      sender_id: bigint;
      client_message_id: string;
      created_at: string;
    }>;
    const now = clock.now().toISOString();
    const fileCutoff = new Date(
      clock.now().getTime() - 14 * 86_400_000,
    ).toISOString();
    const oldTombstones = db
      .prepare(
        'SELECT id FROM messages WHERE server_id=? AND content_expired=1 AND created_at<=? ORDER BY id LIMIT ?',
      )
      .all(system.serverId, fileCutoff, limit) as Array<{ id: bigint }>;
    let removedTombstones = 0;
    for (const tombstone of oldTombstones) {
      if (files) {
        const live = new Set(
          files.attachedLiveIds(tx, system, decimal(tombstone.id) as DecimalId),
        );
        const bound = db
          .prepare(
            'SELECT file_id FROM message_files WHERE server_id=? AND message_id=?',
          )
          .all(system.serverId, tombstone.id) as Array<{ file_id: string }>;
        for (const file of bound)
          if (!live.has(file.file_id as Uuid))
            db.prepare(
              'DELETE FROM message_files WHERE server_id=? AND message_id=? AND file_id=?',
            ).run(system.serverId, tombstone.id, file.file_id);
      }
      const remains = db
        .prepare(
          'SELECT 1 AS found FROM message_files WHERE server_id=? AND message_id=? LIMIT 1',
        )
        .get(system.serverId, tombstone.id);
      if (remains) continue;
      db.prepare(
        'UPDATE message_dedup SET message_id=NULL WHERE server_id=? AND message_id=?',
      ).run(system.serverId, tombstone.id);
      db.prepare(
        'DELETE FROM messages WHERE server_id=? AND id=? AND content_expired=1',
      ).run(system.serverId, tombstone.id);
      removedTombstones++;
    }
    const dedupCutoff = new Date(
      clock.now().getTime() - 30 * 86_400_000,
    ).toISOString();
    const oldDedup = db
      .prepare(
        'SELECT rowid FROM message_dedup WHERE server_id=? AND expired_at IS NOT NULL AND expired_at<=? AND message_id IS NULL ORDER BY expired_at LIMIT ?',
      )
      .all(system.serverId, dedupCutoff, limit) as Array<{ rowid: bigint }>;
    for (const item of oldDedup)
      db.prepare('DELETE FROM message_dedup WHERE rowid=?').run(item.rowid);
    for (const row of rows) {
      const messageId = decimal(row.id) as DecimalId;
      const conversationId = decimal(row.conversation_id) as DecimalId;
      db.prepare(
        'UPDATE messages SET text=NULL,content_expired=1 WHERE server_id=? AND id=? AND content_expired=0',
      ).run(system.serverId, row.id);
      db.prepare(
        'UPDATE message_dedup SET expired_at=? WHERE server_id=? AND sender_id=? AND client_message_id=? AND expired_at IS NULL',
      ).run(now, system.serverId, row.sender_id, row.client_message_id);
      const live = new Set(files?.attachedLiveIds(tx, system, messageId) ?? []);
      const bound = db
        .prepare(
          'SELECT file_id FROM message_files WHERE server_id=? AND message_id=?',
        )
        .all(system.serverId, row.id) as Array<{ file_id: string }>;
      for (const file of bound)
        if (!live.has(file.file_id as Uuid))
          db.prepare(
            'DELETE FROM message_files WHERE server_id=? AND message_id=? AND file_id=?',
          ).run(system.serverId, row.id, file.file_id);
      db.append(tx, {
        type: 'message.deleted.v1',
        occurredAt: now,
        serverId: system.serverId,
        conversationId,
        entityId: messageId,
        recipientUserIds: activity.memberIdsForSystem(
          tx,
          system,
          conversationId,
        ),
        payloadRef: { entityType: 'message', entityId: messageId },
      });
    }
    const lastId = rows.length ? decimal(rows.at(-1)!.id) : afterId;
    const hasMore =
      db
        .prepare(
          'SELECT 1 AS found FROM messages WHERE server_id=? AND content_expired=0 AND created_at<=? AND id>? LIMIT 1',
        )
        .get(system.serverId, cutoff, BigInt(lastId)) !== undefined;
    if (rows.length)
      tx.afterCommit(() =>
        safeEmit(logger, 'messages.content.purged', 'success', system, {
          count: rows.length,
        }),
      );
    const hasTombstones =
      db
        .prepare(
          'SELECT 1 AS found FROM messages WHERE server_id=? AND content_expired=1 AND created_at<=? LIMIT 1',
        )
        .get(system.serverId, fileCutoff) !== undefined;
    const hasDedup =
      db
        .prepare(
          'SELECT 1 AS found FROM message_dedup WHERE server_id=? AND expired_at IS NOT NULL AND expired_at<=? AND message_id IS NULL LIMIT 1',
        )
        .get(system.serverId, dedupCutoff) !== undefined;
    return {
      processed: rows.length + removedTombstones + oldDedup.length,
      lastId,
      hasMore: hasMore || hasTombstones || hasDedup,
    };
  };
  const expireFileReference = (
    tx: TxContext,
    system: SystemContext,
    fileId: Uuid,
  ): void => {
    db.assertOwn(tx);
    const row = db
      .prepare(
        'SELECT message_id FROM message_files WHERE server_id=? AND file_id=?',
      )
      .get(system.serverId, fileId) as { message_id: bigint } | undefined;
    if (!row) return;
    db.prepare(
      'DELETE FROM message_files WHERE server_id=? AND message_id=? AND file_id=?',
    ).run(system.serverId, row.message_id, fileId);
    const message = db
      .prepare(
        'SELECT content_expired FROM messages WHERE server_id=? AND id=?',
      )
      .get(system.serverId, row.message_id) as
      { content_expired: bigint } | undefined;
    if (!message || message.content_expired !== 1n) return;
    const remaining = db
      .prepare(
        'SELECT 1 AS found FROM message_files WHERE server_id=? AND message_id=? LIMIT 1',
      )
      .get(system.serverId, row.message_id);
    if (remaining) return;
    db.prepare(
      'UPDATE message_dedup SET message_id=NULL WHERE server_id=? AND message_id=?',
    ).run(system.serverId, row.message_id);
    db.prepare(
      'DELETE FROM messages WHERE server_id=? AND id=? AND content_expired=1',
    ).run(system.serverId, row.message_id);
    tx.afterCommit(() =>
      safeEmit(logger, 'messages.tombstone.removed', 'success', system, {
        count: 1,
      }),
    );
  };

  return {
    validateMessage,
    purgeExpiredBatch(tx, system, cutoff, afterId, limit) {
      return purgeBatch(tx, system, cutoff, afterId, limit);
    },
    expireFileReference,
    async hydrateEvent(context, record) {
      if (
        (record.type !== 'message.created.v1' &&
          record.type !== 'message.deleted.v1') ||
        !record.conversationId ||
        !positive(record.entityId)
      )
        return null;
      if (!(await access.canAccess(context, record.conversationId)))
        return null;
      return db.run((tx) => {
        db.assertOwn(tx);
        access.recheckMember(tx, context, record.conversationId!);
        const row = db
          .prepare(
            `${messageQuery} WHERE server_id=? AND conversation_id=? AND id=?`,
          )
          .get(
            context.serverId,
            BigInt(record.conversationId!),
            BigInt(record.entityId),
          ) as MessageRow | undefined;
        if (!row && record.type === 'message.created.v1') return null;
        const fileIds = row
          ? (files?.attachedLiveIds(
              tx,
              context,
              record.entityId as DecimalId,
            ) ?? [])
          : [];
        const data =
          record.type === 'message.deleted.v1'
            ? {
                messageId: record.entityId as DecimalId,
                contentExpired: true,
                fileIds: [...fileIds],
              }
            : row
              ? { ...output(tx, context, row), fileIds: [...fileIds] }
              : null;
        if (!data) return null;
        return {
          eventId: record.id,
          type: record.type,
          occurredAt: record.occurredAt,
          conversationId: record.conversationId!,
          data,
        };
      });
    },
    async create(context, conversationId, input) {
      if (!positive(conversationId)) throw new MessageError('not_found');
      await access.requireMember(context, conversationId);
      if (
        !input ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          input.clientMessageId,
        ) ||
        typeof input.text !== 'string'
      )
        throw new MessageError('bad_request');
      const normalized = normalizeMessageText(input.text);
      if (normalized === null) throw new MessageError('bad_request');
      const ids = [...new Set(input.fileIds ?? [])].sort();
      if (
        ids.length !== (input.fileIds ?? []).length ||
        ids.length > 10 ||
        ids.some(
          (id) =>
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              id,
            ),
        )
      )
        throw new MessageError('bad_request');
      if (ids.length > 0 && !files) throw new MessageError('unavailable');
      try {
        return await db.run((tx) => {
          db.assertOwn(tx);
          access.recheckMember(tx, context, conversationId);
          const prior = db
            .prepare(
              'SELECT conversation_id,message_id,expired_at FROM message_dedup WHERE server_id=? AND sender_id=? AND client_message_id=?',
            )
            .get(
              context.serverId,
              BigInt(context.userId),
              input.clientMessageId,
            ) as
            | {
                conversation_id: bigint;
                message_id: bigint | null;
                expired_at: string | null;
              }
            | undefined;
          if (prior) {
            if (prior.conversation_id !== BigInt(conversationId))
              throw new MessageError('conflict');
            const row =
              prior.message_id === null
                ? undefined
                : (db
                    .prepare(`${messageQuery} WHERE server_id=? AND id=?`)
                    .get(context.serverId, prior.message_id) as
                    MessageRow | undefined);
            if (!row || row.content_expired === 1n || prior.expired_at !== null)
              throw new MessageError('message_expired');
            if (row.text !== normalized) throw new MessageError('conflict');
            const bound = (
              db
                .prepare(
                  'SELECT file_id FROM message_files WHERE server_id=? AND message_id=? ORDER BY file_id',
                )
                .all(context.serverId, row.id) as Array<{ file_id: string }>
            )
              .map((item) => item.file_id)
              .sort();
            if (JSON.stringify(bound) !== JSON.stringify(ids))
              throw new MessageError('conflict');
            return {
              message: output(tx, context, row),
              created: false,
              status: 200 as const,
            };
          }
          const now = clock.now().toISOString();
          db.prepare(
            'INSERT INTO messages(server_id,conversation_id,sender_id,client_message_id,text,created_at) VALUES(?,?,?,?,?,?)',
          ).run(
            context.serverId,
            BigInt(conversationId),
            BigInt(context.userId),
            input.clientMessageId,
            normalized,
            now,
          );
          const messageId = db.lastInsertId();
          db.prepare(
            'INSERT INTO message_dedup(server_id,sender_id,client_message_id,conversation_id,message_id,created_at,expired_at) VALUES(?,?,?,?,?,?,NULL)',
          ).run(
            context.serverId,
            BigInt(context.userId),
            input.clientMessageId,
            BigInt(conversationId),
            BigInt(messageId),
            now,
          );
          if (ids.length) {
            files!.bind(tx, context, conversationId, messageId, ids);
            for (const fileId of ids)
              db.prepare(
                'INSERT INTO message_files(server_id,message_id,file_id) VALUES(?,?,?)',
              ).run(context.serverId, BigInt(messageId), fileId);
          }
          activity.recordMessage(tx, context, conversationId, now);
          const members = activity.memberIds(context, conversationId);
          db.append(tx, {
            type: 'message.created.v1',
            occurredAt: now,
            serverId: context.serverId,
            conversationId,
            entityId: messageId,
            recipientUserIds: members,
            payloadRef: { entityType: 'message', entityId: messageId },
          });
          const row = db
            .prepare(`${messageQuery} WHERE server_id=? AND id=?`)
            .get(context.serverId, BigInt(messageId)) as MessageRow | undefined;
          if (!row) throw new MessageError('internal');
          tx.afterCommit(() =>
            safeEmit(logger, 'messages.accepted', 'success', context, {
              conversationId,
              messageId,
              count: ids.length,
            }),
          );
          return {
            message: output(tx, context, row),
            created: true,
            status: 201 as const,
          };
        });
      } catch (error) {
        safeEmit(
          logger,
          'messages.store.failed',
          error instanceof MessageError ? 'rejected' : 'failure',
          context,
          {
            conversationId,
            reasonCode:
              error instanceof DomainError ? error.code : 'database_failure',
          },
        );
        if (error instanceof DomainError) throw error;
        throw new MessageError('unavailable');
      }
    },
    async list(context, conversationId, input): Promise<Page<MessageOutput>> {
      if (
        !positive(conversationId) ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 100 ||
        (input.before && input.after) ||
        (input.before && !positive(input.before)) ||
        (input.after && !positive(input.after))
      )
        throw new MessageError('bad_request');
      await access.requireMember(context, conversationId);
      const result = await db.run((tx) => {
        access.recheckMember(tx, context, conversationId);
        const snapshotPosition = db.snapshotPosition(tx, context);
        const boundary = input.before ?? input.after;
        const direction = input.before ? '<' : input.after ? '>' : '<';
        const sort = input.after ? 'ASC' : 'DESC';
        const rows = db
          .prepare(
            `${messageQuery} WHERE server_id=? AND conversation_id=? AND id ${direction} ? ORDER BY id ${sort} LIMIT ?`,
          )
          .all(
            context.serverId,
            BigInt(conversationId),
            boundary
              ? BigInt(boundary)
              : input.before || input.after
                ? 0n
                : 9223372036854775807n,
            input.limit + 1,
          ) as MessageRow[];
        const pageRows = rows.slice(0, input.limit);
        if (!input.after) pageRows.reverse();
        const hasMore = rows.length > input.limit;
        const last = pageRows.at(-1);
        const nextCursor = hasMore && last ? decimal(last.id) : null;
        return {
          items: pageRows.map((row) => output(tx, context, row)),
          nextCursor,
          snapshotPosition,
        };
      });
      safeEmit(logger, 'messages.listed', 'success', context, {
        conversationId,
        count: result.items.length,
      });
      return {
        ...result,
        snapshotCursor: encode(context, result.snapshotPosition),
        snapshotPosition: result.snapshotPosition,
      };
    },
    async purgeExpiredForServer(
      system: SystemContext,
      cutoff = new Date(clock.now().getTime() - 5 * 86_400_000).toISOString(),
      limit = 500,
    ) {
      const result = await db.run((tx) =>
        purgeBatch(tx, system, cutoff, '0', limit),
      );
      return { purged: result.processed };
    },
  };
}
