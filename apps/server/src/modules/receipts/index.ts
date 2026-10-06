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
import type { Database } from '../../platform/database/index.js';

export interface ReceiptOptions {
  readonly db: Database;
  readonly clock: Clock;
  readonly access: ConversationAccess;
  readonly activity: ConversationActivity;
  readonly validateMessage: (
    tx: TxContext,
    context: RequestContext,
    conversationId: string,
    messageId: string,
  ) => MessageOutput;
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
  const read = (
    serverId: string,
    conversationId: string,
    userId: string,
  ): string | null => {
    const row = options.db
      .prepare(
        'SELECT last_read_message_id FROM read_cursors WHERE server_id=? AND conversation_id=? AND user_id=?',
      )
      .get(serverId, BigInt(conversationId), BigInt(userId)) as
      { last_read_message_id: bigint } | undefined;
    return row ? decimal(row.last_read_message_id) : null;
  };
  return {
    async advance(context, conversationId, messageId) {
      await options.access.requireMember(context, conversationId);
      const outcome = await options.db.run((tx) => {
        options.access.recheckMember(tx, context, conversationId);
        const message = options.validateMessage(
          tx,
          context,
          conversationId,
          messageId,
        );
        if (message.contentExpired) throw new DomainError('message_expired');
        const old = read(context.serverId, conversationId, context.userId);
        if (old !== null && compare(messageId, old) <= 0)
          return { lastReadMessageId: old, advanced: false };
        const now = options.clock.now().toISOString();
        options.db
          .prepare(
            `INSERT INTO read_cursors(server_id,conversation_id,user_id,last_read_message_id,updated_at) VALUES(?,?,?,?,?)
          ON CONFLICT(server_id,conversation_id,user_id) DO UPDATE SET last_read_message_id=excluded.last_read_message_id,updated_at=excluded.updated_at
          WHERE length(excluded.last_read_message_id)>length(last_read_message_id) OR (length(excluded.last_read_message_id)=length(last_read_message_id) AND excluded.last_read_message_id>last_read_message_id)`,
          )
          .run(
            context.serverId,
            BigInt(conversationId),
            BigInt(context.userId),
            BigInt(messageId),
            now,
          );
        const members = options.activity.memberIds(context, conversationId);
        options.db.append(tx, {
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
      const members = options.activity.memberIds(context, conversationId);
      const states = members.map((userId) => ({
        conversationId: conversationId as MessageOutput['conversationId'],
        userId,
        lastReadMessageId: read(context.serverId, conversationId, userId),
      }));
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
