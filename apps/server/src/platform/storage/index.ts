import type {
  DecimalId,
  EventReader,
  EventWriter,
  FeatureLog,
  PositionId,
  TxContext,
} from '@j-messenger/contracts';
import type { SQLInputValue } from 'node:sqlite';
import { Database } from '../database/index.js';
import { SqliteStorage } from './sqlite.js';

export type StorageParameter = SQLInputValue;
export interface StorageStatement {
  run(
    ...parameters: StorageParameter[]
  ): Promise<{ changes: number | bigint; lastInsertRowid?: number | bigint }>;
  get(
    ...parameters: StorageParameter[]
  ): Promise<Record<string, unknown> | undefined>;
  all(...parameters: StorageParameter[]): Promise<Record<string, unknown>[]>;
}
export interface StreamMetadata {
  epoch: string;
  minValidPosition: string;
  lastSequence: string;
}
/** Database operations may await I/O; all operations in run use one owned transaction. */
export interface StorageDatabase {
  readonly kind: 'sqlite' | 'postgres';
  readonly unitOfWork: StorageDatabase;
  readonly eventWriter: EventWriter;
  readonly eventReader: EventReader;
  prepare(sql: string): StorageStatement;
  run<T>(work: (tx: TxContext) => T | Promise<T>): Promise<T>;
  lastInsertId(): Promise<DecimalId>;
  assertOwn(tx: TxContext): void;
  getStreamMetadata(): Promise<StreamMetadata>;
  rotateStreamEpoch(tx: TxContext): Promise<string>;
  pruneEvents(tx: TxContext, through: PositionId): Promise<number>;
  getConsumerPosition(consumer: string): Promise<string | null>;
  advanceConsumerPosition(
    tx: TxContext,
    consumer: string,
    position: PositionId,
  ): Promise<void>;
  backup(destination: string): Promise<void>;
  close(): Promise<void>;
}
export type StorageInput = Database | StorageDatabase;
const adapters = new WeakMap<Database, StorageDatabase>();
export function asStorage(
  db: StorageInput,
  logger?: FeatureLog,
): StorageDatabase {
  if (!(db instanceof Database)) return db;
  let adapter = adapters.get(db);
  if (!adapter) {
    adapter = new SqliteStorage(db, logger);
    adapters.set(db, adapter);
  }
  return adapter;
}
