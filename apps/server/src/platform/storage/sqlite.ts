import { AsyncLocalStorage } from 'node:async_hooks';
import type { DecimalId, FeatureLog, TxContext } from '@j-messenger/contracts';
import { DatabaseError, type Database } from '../database/index.js';
import { BaseStorage } from './base.js';
import type { StorageParameter, StorageStatement } from './index.js';

interface TransactionState {
  readonly tx: TxContext;
}
/** Retains the original SQLite schema and queues work across asynchronous callbacks. */
export class SqliteStorage extends BaseStorage {
  readonly kind = 'sqlite' as const;
  private readonly context = new AsyncLocalStorage<TransactionState>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(
    private readonly database: Database,
    private readonly logger?: FeatureLog,
  ) {
    super();
  }
  private emit(event: string, outcome: 'success' | 'failure'): void {
    try {
      this.logger?.emit({ featureId: 'F39', event, outcome, fields: {} });
    } catch {
      /* diagnostics are isolated */
    }
  }
  private enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }
  private operation<T>(work: () => T | Promise<T>): Promise<T> {
    const state = this.context.getStore();
    if (state) {
      state.tx.assertActive();
      return Promise.resolve().then(work);
    }
    if (this.closed) return Promise.reject(new DatabaseError('internal'));
    return this.enqueue(work);
  }
  prepare(sql: string): StorageStatement {
    const statement = () => this.database.prepare(sql);
    return {
      get: (...parameters) =>
        this.operation(
          () =>
            statement().get(...parameters) as
              Record<string, unknown> | undefined,
        ),
      all: (...parameters) =>
        this.operation(
          () => statement().all(...parameters) as Record<string, unknown>[],
        ),
      run: (...parameters: StorageParameter[]) =>
        this.operation(() => statement().run(...parameters)),
    };
  }
  run<T>(work: (tx: TxContext) => T | Promise<T>): Promise<T> {
    if (this.closed || this.context.getStore())
      return Promise.reject(new DatabaseError('internal'));
    return this.enqueue(async () => {
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
          this.assertActive();
          if (typeof effect !== 'function')
            throw new TypeError('invalid effect');
          effects.push(effect);
        },
      });
      let result: T;
      this.database.connection.exec('BEGIN IMMEDIATE');
      try {
        result = await this.context.run({ tx }, () => work(tx));
        tx.assertActive();
        this.database.connection.exec('COMMIT');
      } catch (error) {
        try {
          this.database.connection.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        this.emit('database.transaction.rollback', 'failure');
        throw error;
      } finally {
        active = false;
      }
      for (const effect of effects) {
        try {
          void Promise.resolve(effect()).catch(() =>
            this.emit('database.aftercommit.failed', 'failure'),
          );
        } catch {
          this.emit('database.aftercommit.failed', 'failure');
        }
      }
      this.emit('database.transaction.committed', 'success');
      return result;
    });
  }
  assertOwn(tx: TxContext): void {
    tx.assertActive();
    if (this.context.getStore()?.tx !== tx) throw new DatabaseError('internal');
  }
  async lastInsertId(): Promise<DecimalId> {
    return this.operation(() => this.database.lastInsertId());
  }
  protected async lastSequence(): Promise<string> {
    const row = await this.prepare(
      "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='event_outbox'),0) AS position",
    ).get();
    return String(row!.position);
  }
  protected readSnapshot<T>(work: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) {
      this.context.getStore()!.tx.assertActive();
      return work();
    }
    return this.run(work);
  }
  async backup(destination: string): Promise<void> {
    await this.operation(() => this.database.backup(destination));
  }
  async close(): Promise<void> {
    if (this.context.getStore()) throw new DatabaseError('internal');
    if (this.closed) return;
    this.closed = true;
    await this.enqueue(() => this.database.close());
  }
}
