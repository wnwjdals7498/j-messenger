import { DomainError } from '@j-messenger/contracts';
import type {
  Clock,
  ConversationAccess,
  ConversationActivity,
  FeatureLog,
  MessageOutput,
  ReceiptCommands,
  RequestContext,
  TxContext,
} from '@j-messenger/contracts';
import { asStorage, type StorageInput } from '../../platform/storage/index.js';

export interface ReceiptOptions {
  readonly db: StorageInput;
  readonly clock: Clock;
  readonly access: ConversationAccess;
  readonly activity: ConversationActivity;
  readonly validateMessage: (
    tx: TxContext,
    context: RequestContext,
    conversationId: string,
    messageId: string,
  ) => MessageOutput | Promise<MessageOutput>;
  readonly logger?: FeatureLog;
}
const decimal = (value: unknown): string =>
  typeof value === 'bigint' ? value.toString() : String(value);
const emit = (
  options: ReceiptOptions,
  event: string,
  outcome: 'success' | 'rejected' | 'failure',
  context: RequestContext,
  fields: Record<string, string | number | boolean | null> = {},
) => {
  try {
    options.logger?.emit({
      featureId: 'F24',
      event,
      outcome,
      requestId: context.requestId,
      fields,
    });
  } catch {}
};
const compare = (a: string, b: string): number =>
  a.length === b.length ? (a < b ? -1 : a > b ? 1 : 0) : a.length - b.length;
export function createReceiptsService(
  options: ReceiptOptions,
): ReceiptCommands {
  const db = asStorage(options.db);
  const read = (
    serverId: string,
    conversationId: string,
    userId: string,
  ): Promise<string | null> => {
    const row = db
      .prepare(
        'SELECT last_read_message_id FROM read_cursors WHERE server_id=? AND conversation_id=? AND user_id=?',
      )
      .get(serverId, BigInt(conversationId), BigInt(userId));
    return row.then((result) => {
      const typed = result as { last_read_message_id: bigint } | undefined;
      return typed ? decimal(typed.last_read_message_id) : null;
    });
  };
  return {
    async advance(context, conversationId, messageId) {
      await options.access.requireMember(context, conversationId);
      const outcome = await db.run(async (tx) => {
        await options.access.recheckMember(tx, context, conversationId);
        const message = await options.validateMessage(
          tx,
          context,
          conversationId,
          messageId,
        );
        if (message.contentExpired) throw new DomainError('message_expired');
        const old = await read(
          context.serverId,
          conversationId,
          context.userId,
        );
        if (old !== null && compare(messageId, old) <= 0)
          return { lastReadMessageId: old, advanced: false };
        const now = options.clock.now().toISOString();
        await db
          .prepare(
            `INSERT INTO read_cursors(server_id,conversation_id,user_id,last_read_message_id,updated_at) VALUES(?,?,?,?,?)
          ON CONFLICT(server_id,conversation_id,user_id) DO UPDATE SET last_read_message_id=excluded.last_read_message_id,updated_at=excluded.updated_at
          WHERE excluded.last_read_message_id>read_cursors.last_read_message_id`,
          )
          .run(
            context.serverId,
            BigInt(conversationId),
            BigInt(context.userId),
            BigInt(messageId),
            now,
          );
        const members = await options.activity.memberIds(
          context,
          conversationId,
        );
        await db.eventWriter.append(tx, {
          type: 'receipt.updated.v1',
          occurredAt: now,
          serverId: context.serverId,
          conversationId: conversationId as MessageOutput['conversationId'],
          entityId: context.userId,
          payloadRef: { entityType: 'receipt', entityId: context.userId },
          recipientUserIds: members,
        });
        return {
          lastReadMessageId: messageId as MessageOutput['id'],
          advanced: true,
        };
      });
      emit(options, 'receipts.advanced', 'success', context, {
        serverId: context.serverId,
        userId: context.userId,
        conversationId,
        advanced: outcome.advanced,
      });
      return outcome;
    },
    async get(context, conversationId) {
      await options.access.requireMember(context, conversationId);
      const members = await options.activity.memberIds(context, conversationId);
      const states = [];
      for (const userId of members)
        states.push({
          conversationId: conversationId as MessageOutput['conversationId'],
          userId,
          lastReadMessageId: await read(
            context.serverId,
            conversationId,
            userId,
          ),
        });
      emit(options, 'receipts.listed', 'success', context, {
        serverId: context.serverId,
        userId: context.userId,
        conversationId,
        count: states.length,
      });
      return states;
    },
  };
}
