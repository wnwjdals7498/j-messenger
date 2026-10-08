import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  chmod,
  link,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';
import { Pool, types, type PoolClient } from 'pg';
import { runner } from 'node-pg-migrate';
import type {
  Clock,
  DecimalId,
  FeatureLog,
  TxContext,
} from '@j-messenger/contracts';
import { DatabaseError } from '../database/index.js';
import { BaseStorage } from './base.js';
import type { StorageParameter, StorageStatement } from './index.js';

const WRITE_LOCK = 1246577485;
const MIGRATION_LOCK = 1246577486;
const generatedIds = new Set([
  'users',
  'sessions',
  'conversations',
  'messages',
  'event_outbox',
  'audit_events',
]);
interface TransactionState {
  readonly client: PoolClient;
  readonly tx: TxContext;
  lastId?: DecimalId;
}
export interface PostgresOptions {
  readonly connectionString: string;
  readonly schema?: string;
  readonly clock?: Clock;
  readonly logger?: FeatureLog;
}

/** Converts bound placeholders only; literals/comments are left intact. */
export function bindPostgresSql(sql: string): string {
  let index = 0;
  return sql.replace(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\?/g,
    (part) => (part === '?' ? `$${++index}` : part),
  );
}
export class PostgresStorage extends BaseStorage {
  readonly kind = 'postgres' as const;
  readonly schema: string;
  private readonly pool: Pool;
  private readonly context = new AsyncLocalStorage<TransactionState>();
  private closed = false;
  private constructor(private readonly options: PostgresOptions) {
    super();
    this.schema = options.schema ?? 'public';
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(this.schema))
      throw new DatabaseError('internal');
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: 10,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
      options: `-c search_path=${this.schema} -c timezone=UTC -c statement_timeout=10000`,
      types: {
        getTypeParser: (oid, format) =>
          oid === 20 && format !== 'binary'
            ? BigInt
            : types.getTypeParser(oid, format),
      },
    });
    this.pool.on('error', () =>
      this.emit('database.connection.failed', 'failure'),
    );
  }
  static async open(options: PostgresOptions): Promise<PostgresStorage> {
    const storage = new PostgresStorage(options);
    try {
      await storage.migrate();
      storage.emit('database.opened', 'success');
      return storage;
    } catch {
      await storage.pool.end();
      throw new DatabaseError();
    }
  }
  private emit(event: string, outcome: 'success' | 'failure'): void {
    try {
      this.options.logger?.emit({
        featureId: 'F39',
        event,
        outcome,
        fields: {},
      });
    } catch {
      /* diagnostics are isolated */
    }
  }
  private async migrate(): Promise<void> {
    const directory = fileURLToPath(
      new URL('../../../../../deploy/postgres-migrations/', import.meta.url),
    );
    const files = (await readdir(directory))
      .filter((file) => /^\d+-[a-z0-9-]+\.sql$/.test(file))
      .sort();
    if (!files.length) throw new DatabaseError('internal');
    const expected = new Map<string, string>();
    for (const file of files)
      expected.set(
        file.replace(/\.sql$/, ''),
        createHash('sha256')
          .update(await readFile(`${directory}/${file}`))
          .digest('hex'),
      );
    const client = await this.pool.connect();
    let locked = false;
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
      locked = true;
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
      await client.query(
        'CREATE TABLE IF NOT EXISTS storage_migration_checksums(name TEXT PRIMARY KEY, checksum TEXT NOT NULL)',
      );
      const recorded = await client.query<{ name: string; checksum: string }>(
        'SELECT name,checksum FROM storage_migration_checksums',
      );
      for (const row of recorded.rows)
        if (expected.get(row.name) !== row.checksum)
          throw new DatabaseError('internal');
      const migrationTable = await client.query(
        "SELECT to_regclass('pgmigrations') AS name",
      );
      if (migrationTable.rows[0]?.name) {
        const applied = await client.query<{ name: string }>(
          'SELECT name FROM pgmigrations ORDER BY id',
        );
        for (const row of applied.rows)
          if (
            !expected.has(row.name) ||
            !recorded.rows.some((record) => record.name === row.name)
          )
            throw new DatabaseError('internal');
      }
      // The session lock above serializes concurrent bootstraps and checksum checks.
      await runner({
        dbClient: client,
        dir: directory,
        direction: 'up',
        migrationsTable: 'pgmigrations',
        schema: this.schema,
        migrationsSchema: this.schema,
        noLock: true,
        singleTransaction: true,
        logger: { info() {}, warn() {}, error() {} },
        migrationLoaderStrategies: [
          {
            extensions: ['.sql'],
            loader: async (paths) =>
              Promise.all(
                paths.map(async (file) => {
                  const name = basename(file, '.sql');
                  const checksum = expected.get(name);
                  if (!checksum) throw new DatabaseError('internal');
                  const source = await readFile(file, 'utf8');
                  const up = source
                    .split('-- Down Migration')[0]!
                    .replace('-- Up Migration', '');
                  return {
                    id: file,
                    filePaths: [file],
                    actions: {
                      up: (pgm) => {
                        pgm.sql(up);
                        // Whitelisted filename and hex digest, recorded in the migration's transaction.
                        pgm.sql(
                          `INSERT INTO storage_migration_checksums(name,checksum) VALUES('${name}','${checksum}')`,
                        );
                      },
                      down: false,
                    },
                  };
                }),
              ),
          },
        ],
      });
    } finally {
      try {
        if (locked)
          await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]);
      } finally {
        client.release();
      }
    }
  }
  private assertOpen(): void {
    if (this.closed && !this.context.getStore())
      throw new DatabaseError('internal');
  }
  private async query(
    sql: string,
    parameters: StorageParameter[] = [],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
    this.assertOpen();
    const state = this.context.getStore();
    if (state) state.tx.assertActive();
    try {
      return await (state?.client ?? this.pool).query(
        bindPostgresSql(sql),
        parameters.map((value) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
      );
    } catch {
      throw new DatabaseError();
    }
  }
  prepare(sql: string): StorageStatement {
    return {
      get: async (...parameters) => (await this.query(sql, parameters)).rows[0],
      all: async (...parameters) => (await this.query(sql, parameters)).rows,
      run: async (...parameters) => {
        if (!this.context.getStore())
          return this.run(() => this.prepare(sql).run(...parameters));
        const insert = /^\s*INSERT\s+INTO\s+([a-z_]+)\b/i.exec(sql);
        const withId =
          insert &&
          generatedIds.has(insert[1]!.toLowerCase()) &&
          !/\bRETURNING\b/i.test(sql);
        const result = await this.query(
          withId ? `${sql.trim().replace(/;$/, '')} RETURNING id` : sql,
          parameters,
        );
        const id = result.rows[0]?.id;
        if (withId && id !== undefined)
          this.context.getStore()!.lastId = String(id) as DecimalId;
        return {
          changes: result.rowCount ?? 0,
          ...(withId && id !== undefined
            ? { lastInsertRowid: BigInt(String(id)) }
            : {}),
        };
      },
    };
  }
  async run<T>(work: (tx: TxContext) => T | Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.context.getStore()) throw new DatabaseError('internal');
    const client = await this.pool.connect().catch(() => {
      throw new DatabaseError();
    });
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
        if (typeof effect !== 'function') throw new TypeError('invalid effect');
        effects.push(effect);
      },
    });
    let result: T;
    try {
      await client.query('BEGIN');
      // Sequence allocation is not commit order. Serialize database-only writers
      // before allocating IDs, retaining SQLite's no-missed-cursor contract.
      await client.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK]);
      result = await this.context.run({ client, tx }, () => work(tx));
      tx.assertActive();
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection may already be lost */
      }
      this.emit('database.transaction.rollback', 'failure');
      throw error;
    } finally {
      active = false;
      client.release();
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
  }
  assertOwn(tx: TxContext): void {
    tx.assertActive();
    if (this.context.getStore()?.tx !== tx) throw new DatabaseError('internal');
  }
  async lastInsertId(): Promise<DecimalId> {
    const state = this.context.getStore();
    if (!state?.lastId) throw new DatabaseError('internal');
    state.tx.assertActive();
    return state.lastId;
  }
  protected async lastSequence(): Promise<string> {
    return String(
      (await this.prepare(
        "SELECT value FROM platform_metadata WHERE key='last_sequence'",
      ).get())!.value,
    );
  }
  protected async readSnapshot<T>(work: () => Promise<T>): Promise<T> {
    const existing = this.context.getStore();
    if (existing) {
      existing.tx.assertActive();
      return work();
    }
    this.assertOpen();
    const client = await this.pool.connect().catch(() => {
      throw new DatabaseError();
    });
    let active = true;
    const tx: TxContext = Object.freeze({
      get active() {
        return active;
      },
      assertActive() {
        if (!active) throw new DatabaseError('internal');
      },
      afterCommit() {
        throw new DatabaseError('internal');
      },
    });
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await this.context.run({ client, tx }, work);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection may have gone */
      }
      throw error;
    } finally {
      active = false;
      client.release();
    }
  }
  protected override async recordSequence(
    tx: TxContext,
    position: string,
  ): Promise<void> {
    this.assertOwn(tx);
    await this.prepare(
      "UPDATE platform_metadata SET value=? WHERE key='last_sequence'",
    ).run(position);
  }
  async backup(destination: string): Promise<void> {
    this.assertOpen();
    if (this.context.getStore()) throw new DatabaseError('internal');
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const url = new URL(this.options.connectionString);
    try {
      await writeFile(temporary, '', { flag: 'wx', mode: 0o600 });
      await promisify(execFile)(
        'pg_dump',
        [
          '--format=custom',
          '--no-owner',
          '--no-acl',
          `--schema=${this.schema}`,
          `--file=${temporary}`,
        ],
        {
          env: {
            ...process.env,
            PGHOST: url.hostname,
            PGPORT: url.port || '5432',
            PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
            PGUSER: decodeURIComponent(url.username),
            PGPASSWORD: decodeURIComponent(url.password),
          },
          timeout: 120000,
          maxBuffer: 1024,
        },
      );
      await chmod(temporary, 0o600);
      await link(temporary, destination);
    } catch {
      throw new DatabaseError();
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async close(): Promise<void> {
    if (this.context.getStore()) throw new DatabaseError('internal');
    if (!this.closed) {
      this.closed = true;
      await this.pool.end();
    }
  }
}
