import { randomUUID } from 'node:crypto';
import type {
  DecimalId,
  EventAppend,
  EventRecord,
  PositionId,
  RequestContext,
  TxContext,
} from '@j-messenger/contracts';
import { DatabaseError, safeDatabaseCount } from '../database/index.js';
import type {
  StorageDatabase,
  StorageStatement,
  StreamMetadata,
} from './index.js';

/** Shared cursor semantics; database adapters own I/O, transactions and sequences. */
export abstract class BaseStorage implements StorageDatabase {
  abstract readonly kind: 'sqlite' | 'postgres';
  readonly unitOfWork = this;
  readonly eventWriter = this;
  readonly eventReader = this;
  abstract prepare(sql: string): StorageStatement;
  abstract run<T>(work: (tx: TxContext) => T | Promise<T>): Promise<T>;
  abstract lastInsertId(): Promise<DecimalId>;
  abstract assertOwn(tx: TxContext): void;
  abstract backup(destination: string): Promise<void>;
  abstract close(): Promise<void>;
  protected abstract lastSequence(): Promise<string>;
  protected abstract readSnapshot<T>(work: () => Promise<T>): Promise<T>;
  protected async recordSequence(
    _tx: TxContext,
    _position: string,
  ): Promise<void> {}
  async append(tx: TxContext, event: EventAppend): Promise<DecimalId> {
    this.assertOwn(tx);
    await this.prepare(
      'INSERT INTO event_outbox(type,occurred_at,server_id,conversation_id,entity_type,entity_id,recipient_user_ids,payload_entity_type,payload_entity_id) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(
      event.type,
      event.occurredAt,
      event.serverId,
      event.conversationId ?? null,
      /^[0-9]+$/.test(event.entityId) ? 'id' : 'uuid',
      event.entityId,
      JSON.stringify(event.recipientUserIds),
      event.payloadRef.entityType,
      event.payloadRef.entityId,
    );
    const position = await this.lastInsertId();
    await this.recordSequence(tx, position);
    return position;
  }
  async snapshotPosition(
    tx: TxContext,
    _context: RequestContext,
  ): Promise<PositionId> {
    this.assertOwn(tx);
    return (await this.lastSequence()) as PositionId;
  }
  async highWatermark(_context: RequestContext): Promise<PositionId> {
    return (await this.lastSequence()) as PositionId;
  }
  async scan(
    context: RequestContext,
    after: PositionId,
    through: PositionId,
    limit: number,
  ): Promise<{
    rows: readonly EventRecord[];
    scannedThrough: PositionId;
    hasMore: boolean;
  }> {
    return this.readSnapshot(() =>
      this.scanSnapshot(context, after, through, limit),
    );
  }
  private async scanSnapshot(
    context: RequestContext,
    after: PositionId,
    through: PositionId,
    limit: number,
  ): Promise<{
    rows: readonly EventRecord[];
    scannedThrough: PositionId;
    hasMore: boolean;
  }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new TypeError('invalid scan limit');
    const ids = await this.prepare(
      'SELECT id FROM event_outbox WHERE id>? AND id<=? ORDER BY id LIMIT ?',
    ).all(BigInt(after), BigInt(through), limit);
    const scannedThrough = String(ids.at(-1)?.id ?? after) as PositionId;
    const data = ids.length
      ? await this.prepare(
          'SELECT id,type,occurred_at,server_id,conversation_id,entity_id,payload_entity_type,payload_entity_id FROM event_outbox WHERE server_id=? AND id>? AND id<=? ORDER BY id',
        ).all(context.serverId, BigInt(after), BigInt(scannedThrough))
      : [];
    const rows = data.map((row): EventRecord => ({
      id: String(row.id) as EventRecord['id'],
      type: String(row.type),
      occurredAt: String(row.occurred_at),
      serverId: String(row.server_id) as EventRecord['serverId'],
      conversationId:
        row.conversation_id === null
          ? null
          : (String(row.conversation_id) as EventRecord['conversationId']),
      entityId: String(row.entity_id),
      payloadRef: {
        entityType: String(
          row.payload_entity_type,
        ) as EventRecord['payloadRef']['entityType'],
        entityId: String(row.payload_entity_id),
      },
    }));
    const hasMore =
      (await this.prepare(
        'SELECT 1 AS found FROM event_outbox WHERE id>? AND id<=? LIMIT 1',
      ).get(BigInt(scannedThrough), BigInt(through))) !== undefined;
    return { rows, scannedThrough, hasMore };
  }
  async getStreamMetadata(): Promise<StreamMetadata> {
    return this.readSnapshot(async () => {
      const rows = await this.prepare(
        'SELECT key,value FROM platform_metadata',
      ).all();
      const values = new Map(
        rows.map((row) => [String(row.key), String(row.value)]),
      );
      return {
        epoch: values.get('stream_epoch') ?? '1',
        minValidPosition: values.get('min_valid_position') ?? '0',
        lastSequence: await this.lastSequence(),
      };
    });
  }
  async rotateStreamEpoch(tx: TxContext): Promise<string> {
    this.assertOwn(tx);
    const epoch = randomUUID();
    await this.prepare(
      "UPDATE platform_metadata SET value=? WHERE key='stream_epoch'",
    ).run(epoch);
    return epoch;
  }
  async pruneEvents(tx: TxContext, through: PositionId): Promise<number> {
    this.assertOwn(tx);
    const metadata = await this.getStreamMetadata();
    const cut = BigInt(through);
    if (
      cut < BigInt(metadata.minValidPosition) ||
      cut > BigInt(metadata.lastSequence)
    )
      throw new DatabaseError('internal');
    const result = await this.prepare(
      'DELETE FROM event_outbox WHERE id<=?',
    ).run(cut);
    await this.prepare(
      "UPDATE platform_metadata SET value=? WHERE key='min_valid_position'",
    ).run(cut.toString());
    return safeDatabaseCount(BigInt(result.changes));
  }
  async getConsumerPosition(consumer: string): Promise<string | null> {
    const row = await this.prepare(
      'SELECT position FROM consumer_positions WHERE consumer=?',
    ).get(consumer);
    return row ? String(row.position) : null;
  }
  async advanceConsumerPosition(
    tx: TxContext,
    consumer: string,
    position: PositionId,
  ): Promise<void> {
    this.assertOwn(tx);
    await this.prepare(
      'INSERT INTO consumer_positions(consumer,position) VALUES(?,?) ON CONFLICT(consumer) DO UPDATE SET position=excluded.position WHERE length(excluded.position)>length(consumer_positions.position) OR (length(excluded.position)=length(consumer_positions.position) AND excluded.position>consumer_positions.position)',
    ).run(consumer, position);
  }
}
