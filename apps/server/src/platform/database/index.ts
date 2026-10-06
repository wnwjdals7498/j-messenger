import { createHash, randomUUID } from 'node:crypto';
import {
  backup as sqliteBackup,
  DatabaseSync,
  type StatementSync,
} from 'node:sqlite';
import { DomainError } from '@j-messenger/contracts';
import type {
  Clock,
  DecimalId,
  EventAppend,
  EventReader,
  EventRecord,
  EventWriter,
  FeatureLog,
  PositionId,
  RequestContext,
  TxContext,
  UnitOfWork,
} from '@j-messenger/contracts';

export interface Migration {
  readonly version: number;
  readonly sql: string;
}
export interface DatabaseOptions {
  readonly migrations?: readonly Migration[];
  readonly clock?: Clock;
  readonly logger?: FeatureLog;
  readonly busyTimeoutMs?: number;
}
export const PLATFORM_MIGRATION: Migration = Object.freeze({
  version: 1,
  sql: `
CREATE TABLE platform_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO platform_metadata(key,value) VALUES ('stream_epoch','1'),('min_valid_position','0');
CREATE TABLE event_outbox (
 id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, occurred_at TEXT NOT NULL,
 server_id TEXT NOT NULL, conversation_id TEXT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
 recipient_user_ids TEXT NOT NULL, payload_entity_type TEXT NOT NULL, payload_entity_id TEXT NOT NULL
);
CREATE INDEX event_outbox_server_id_idx ON event_outbox(server_id,id);
CREATE TABLE consumer_positions (consumer TEXT PRIMARY KEY, position TEXT NOT NULL);
`,
});

export class DatabaseError extends DomainError {
  constructor(code: 'unavailable' | 'internal' = 'unavailable') {
    super(code, '데이터 저장소 요청을 처리할 수 없습니다.');
    this.name = 'DatabaseError';
  }
}
const safeEmit = (
  logger: FeatureLog | undefined,
  event: string,
  outcome: 'success' | 'failure',
  fields: Record<string, string | number | boolean | null> = {},
): void => {
  try {
    logger?.emit({ featureId: 'F39', event, outcome, fields });
  } catch {
    /* diagnostics must not alter database outcomes */
  }
};
const isThenable = (value: unknown): boolean =>
  ((typeof value === 'object' && value !== null) ||
    typeof value === 'function') &&
  typeof (value as { then?: unknown }).then === 'function';
const decimal = (v: unknown): string =>
  typeof v === 'bigint' ? v.toString() : String(v);
const safeNumber = (value: bigint): number => {
  const n = Number(value);
  if (!Number.isSafeInteger(n))
    throw new RangeError('database count exceeds safe integer range');
  return n;
};
const hideSqliteError = (error: unknown): unknown => {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    String((error as { code: unknown }).code).includes('SQLITE')
  )
    return new DatabaseError();
  return error;
};

export class Database implements UnitOfWork, EventWriter, EventReader {
  readonly connection!: DatabaseSync;
  readonly unitOfWork: UnitOfWork = this;
  readonly eventWriter: EventWriter = this;
  readonly eventReader: EventReader = this;
  private readonly clock: Clock;
  private readonly logger: FeatureLog | undefined;
  private readonly ownedTransactions = new WeakSet<object>();
  private transactionActive = false;
  private closed = false;
  constructor(path: string, options: DatabaseOptions = {}) {
    if (
      !Number.isSafeInteger(options.busyTimeoutMs ?? 1000) ||
      (options.busyTimeoutMs ?? 1000) < 0
    )
      throw new TypeError('invalid database options');
    this.clock = options.clock ?? { now: () => new Date() };
    this.logger = options.logger;
    try {
      this.connection = new DatabaseSync(path);
      this.connection.exec(
        `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=${options.busyTimeoutMs ?? 1000};`,
      );
      this.runMigrations(options.migrations ?? []);
    } catch {
      try {
        this.connection?.close();
      } catch {
        /* connection setup may not have completed */
      }
      safeEmit(this.logger, 'database.open.failed', 'failure');
      throw new DatabaseError();
    }
    safeEmit(this.logger, 'database.opened', 'success');
  }
  prepare(sql: string): StatementSync {
    this.assertOpen();
    const statement = this.connection.prepare(sql);
    statement.setReadBigInts(true);
    return statement;
  }
  lastInsertId(): DecimalId {
    this.assertOpen();
    const row = this.prepare('SELECT last_insert_rowid() AS id').get();
    return decimal(row!.id as bigint) as DecimalId;
  }
  close(): void {
    if (!this.closed) {
      this.connection.close();
      this.closed = true;
    }
  }
  run<T>(work: (tx: TxContext) => T): Promise<T> {
    this.assertOpen();
    if (this.transactionActive) {
      const rejected = Promise.reject(new DatabaseError('internal'));
      rejected.catch(() => {});
      return rejected;
    }
    let active = true;
    const effects: Array<() => void | Promise<void>> = [];
    const tx: TxContext = Object.freeze({
      get active() {
        return active;
      },
      assertActive() {
        if (!active) throw new DatabaseError('internal');
      },
      afterCommit(effect: () => void | Promise<void>) {
        if (!active) throw new DatabaseError('internal');
        if (typeof effect !== 'function') throw new TypeError('invalid effect');
        effects.push(effect);
      },
    });
    this.ownedTransactions.add(tx);
    let result: T;
    let began = false;
    try {
      this.connection.exec('BEGIN IMMEDIATE');
      began = true;
      this.transactionActive = true;
      result = work(tx);
      if (isThenable(result))
        throw new TypeError('transaction callback must be synchronous');
      tx.assertActive();
      this.connection.exec('COMMIT');
    } catch (error) {
      if (began) {
        try {
          this.connection.exec('ROLLBACK');
        } catch {
          /* transaction may already be gone */
        }
      }
      this.transactionActive = false;
      active = false;
      safeEmit(this.logger, 'database.transaction.rollback', 'failure');
      return Promise.reject(hideSqliteError(error));
    }
    this.transactionActive = false;
    active = false;
    for (const effect of effects) {
      try {
        const pending = effect();
        if (isThenable(pending))
          Promise.resolve(pending).catch(() =>
            safeEmit(this.logger, 'database.aftercommit.failed', 'failure'),
          );
      } catch {
        safeEmit(this.logger, 'database.aftercommit.failed', 'failure');
      }
    }
    safeEmit(this.logger, 'database.transaction.committed', 'success');
    return Promise.resolve(result);
  }
  append(tx: TxContext, event: EventAppend): string {
    this.assertOwn(tx);
    this.prepare(
      `INSERT INTO event_outbox(type,occurred_at,server_id,conversation_id,entity_type,entity_id,recipient_user_ids,payload_entity_type,payload_entity_id) VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(
      event.type,
      event.occurredAt,
      event.serverId,
      event.conversationId ?? null,
      typeof event.entityId === 'string' && /^[0-9]+$/.test(event.entityId)
        ? 'id'
        : 'uuid',
      event.entityId,
      JSON.stringify(event.recipientUserIds),
      event.payloadRef.entityType,
      event.payloadRef.entityId,
    );
    return this.lastInsertId();
  }
  assertOwn(tx: TxContext): void {
    tx.assertActive();
    if (!this.ownedTransactions.has(tx)) throw new DatabaseError('internal');
  }
  snapshotPosition(tx: TxContext, context: RequestContext): PositionId {
    this.assertOwn(tx);
    // Cursor positions are global; scans still filter hydrated rows by serverId.
    void context;
    const row = this.prepare(
      "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='event_outbox'),0) AS position",
    ).get();
    return decimal(row!.position as bigint) as PositionId;
  }
  async highWatermark(context: RequestContext): Promise<PositionId> {
    this.assertOpen();
    void context;
    return decimal(
      this.prepare(
        "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='event_outbox'),0) AS position",
      ).get()!.position as bigint,
    ) as PositionId;
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
    this.assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new TypeError('invalid scan limit');
    const scannedIds = this.prepare(
      'SELECT id FROM event_outbox WHERE id>? AND id<=? ORDER BY id LIMIT ?',
    ).all(BigInt(after), BigInt(through), limit) as Array<{ id: bigint }>;
    const scanned = scannedIds.at(-1) ? decimal(scannedIds.at(-1)!.id) : after;
    const p = scannedIds.length
      ? (this.prepare(
          'SELECT id,type,occurred_at,server_id,conversation_id,entity_id,payload_entity_type,payload_entity_id FROM event_outbox WHERE server_id=? AND id>? AND id<=? ORDER BY id',
        ).all(context.serverId, BigInt(after), BigInt(scanned)) as Record<
          string,
          unknown
        >[])
      : [];
    const rows = p.map((r): EventRecord => ({
      id: decimal(r.id) as EventRecord['id'],
      type: String(r.type),
      occurredAt: String(r.occurred_at),
      serverId: String(r.server_id) as EventRecord['serverId'],
      conversationId:
        r.conversation_id === null
          ? null
          : (decimal(r.conversation_id) as EventRecord['conversationId']),
      entityId: String(r.entity_id) as EventRecord['entityId'],
      payloadRef: {
        entityType: String(
          r.payload_entity_type,
        ) as EventRecord['payloadRef']['entityType'],
        entityId: String(r.payload_entity_id) as EventRecord['entityId'],
      },
    }));
    const hasMore =
      this.prepare(
        'SELECT 1 AS found FROM event_outbox WHERE id>? AND id<=? LIMIT 1',
      ).get(BigInt(scanned), BigInt(through)) !== undefined;
    return { rows, scannedThrough: scanned as PositionId, hasMore };
  }
  rotateStreamEpoch(tx: TxContext): string {
    this.assertOwn(tx);
    const next = randomUUID();
    this.prepare(
      "UPDATE platform_metadata SET value=? WHERE key='stream_epoch'",
    ).run(next);
    return next;
  }
  pruneEvents(tx: TxContext, through: PositionId): number {
    this.assertOwn(tx);
    const cut = BigInt(through);
    const metadata = this.getStreamMetadata();
    const minValid = BigInt(metadata.minValidPosition);
    const lastSequence = BigInt(metadata.lastSequence);
    if (cut < minValid || cut > lastSequence)
      throw new DatabaseError('internal');
    const result = this.prepare('DELETE FROM event_outbox WHERE id<=?').run(
      cut,
    );
    this.prepare(
      "UPDATE platform_metadata SET value=? WHERE key='min_valid_position'",
    ).run(cut.toString());
    const count = result.changes;
    if (typeof count === 'bigint') return safeNumber(count);
    if (!Number.isSafeInteger(count))
      throw new RangeError('database count exceeds safe integer range');
    return count;
  }
  getStreamMetadata(): {
    epoch: string;
    minValidPosition: string;
    lastSequence: string;
  } {
    this.assertOpen();
    const values = this.prepare(
      'SELECT key,value FROM platform_metadata',
    ).all() as Array<{ key: string; value: string }>;
    const map = new Map(values.map((v) => [v.key, v.value]));
    const last = this.prepare(
      "SELECT seq FROM sqlite_sequence WHERE name='event_outbox'",
    ).get() as { seq: bigint } | undefined;
    return {
      epoch: map.get('stream_epoch') ?? '1',
      minValidPosition: map.get('min_valid_position') ?? '0',
      lastSequence: decimal(last?.seq ?? 0n),
    };
  }
  getConsumerPosition(consumer: string): string | null {
    return (
      (
        this.prepare(
          'SELECT position FROM consumer_positions WHERE consumer=?',
        ).get(consumer) as { position: string } | undefined
      )?.position ?? null
    );
  }
  advanceConsumerPosition(
    tx: TxContext,
    consumer: string,
    position: PositionId,
  ): void {
    this.assertOwn(tx);
    this.prepare(
      'INSERT INTO consumer_positions(consumer,position) VALUES(?,?) ON CONFLICT(consumer) DO UPDATE SET position=excluded.position WHERE length(excluded.position)>length(position) OR (length(excluded.position)=length(position) AND excluded.position>position)',
    ).run(consumer, position);
  }
  async backup(destination: string): Promise<void> {
    this.assertOpen();
    try {
      await sqliteBackup(this.connection, destination);
    } catch {
      throw new DatabaseError();
    }
  }
  private runMigrations(migrations: readonly Migration[]): void {
    this.connection.exec(
      'CREATE TABLE IF NOT EXISTS migration_history(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    const ordered = [...migrations].sort((a, b) => a.version - b.version);
    for (let i = 0; i < ordered.length; i++) {
      const m = ordered[i]!;
      if (
        !Number.isSafeInteger(m.version) ||
        m.version !== i + 1 ||
        !m.sql.trim()
      )
        throw new DatabaseError('internal');
    }
    const applied = this.prepare(
      'SELECT version,checksum FROM migration_history ORDER BY version',
    ).all() as Array<{ version: bigint; checksum: string }>;
    const supported = new Map(
      ordered.map((migration) => [
        migration.version,
        createHash('sha256').update(migration.sql).digest('hex'),
      ]),
    );
    for (let i = 0; i < applied.length; i++) {
      const row = applied[i]!;
      const version = Number(row.version);
      if (
        !Number.isSafeInteger(version) ||
        version !== i + 1 ||
        !supported.has(version) ||
        supported.get(version) !== row.checksum
      )
        throw new DatabaseError('internal');
    }
    for (const m of ordered) {
      const checksum = createHash('sha256').update(m.sql).digest('hex');
      const existing = this.prepare(
        'SELECT checksum FROM migration_history WHERE version=?',
      ).get(m.version) as { checksum: string } | undefined;
      if (existing) {
        if (existing.checksum !== checksum) throw new DatabaseError('internal');
        continue;
      }
      this.connection.exec('BEGIN IMMEDIATE');
      try {
        this.connection.exec(m.sql);
        this.prepare(
          'INSERT INTO migration_history(version,checksum,applied_at) VALUES(?,?,?)',
        ).run(m.version, checksum, this.clock.now().toISOString());
        this.connection.exec('COMMIT');
        safeEmit(this.logger, 'database.migration.applied', 'success', {
          schemaVersion: m.version,
        });
      } catch {
        try {
          this.connection.exec('ROLLBACK');
        } catch {}
        safeEmit(this.logger, 'database.migration.failed', 'failure', {
          schemaVersion: m.version,
        });
        throw new DatabaseError();
      }
    }
  }
  private assertOpen(): void {
    if (this.closed) throw new DatabaseError('internal');
  }
}
export function createDatabase(
  path: string,
  options: DatabaseOptions = {},
): Database {
  return new Database(path, options);
}
export { safeNumber as safeDatabaseCount };
