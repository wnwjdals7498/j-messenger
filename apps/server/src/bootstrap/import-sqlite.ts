import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { MIGRATIONS } from './migrations.js';
import { DatabaseError } from '../platform/database/index.js';
import type { StorageParameter } from '../platform/storage/index.js';
import type { PostgresStorage } from '../platform/storage/postgres.js';

// Dependency order and identifiers are owned here, never supplied by the caller.
export const IMPORT_TABLES = Object.freeze([
  'mail_servers',
  'users',
  'sessions',
  'conversations',
  'members',
  'conversation_requests',
  'messages',
  'message_dedup',
  'message_files',
  'read_cursors',
  'retention_policies',
  'audit_events',
  'files',
  'retention_progress',
  'event_outbox',
  'consumer_positions',
  'platform_jobs',
]);
const identityTables = [
  'users',
  'sessions',
  'conversations',
  'messages',
  'audit_events',
  'event_outbox',
];
/** Explicit, one-way import into a virgin PostgreSQL store. Source is read-only. */
export async function importSqlite(
  sourcePath: string,
  target: PostgresStorage,
): Promise<{ counts: Record<string, number>; lastSequence: string }> {
  if (!path.isAbsolute(sourcePath)) throw new DatabaseError('internal');
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const statement = (sql: string) => {
    const prepared = source.prepare(sql);
    prepared.setReadBigInts(true);
    return prepared;
  };
  try {
    source.exec('BEGIN');
    const knownTables = new Set([
      ...IMPORT_TABLES,
      'migration_history',
      'platform_metadata',
      'sqlite_sequence',
    ]);
    const tables = statement(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all();
    if (
      tables.some((row) => !knownTables.has(String(row.name))) ||
      tables.length !== knownTables.size
    )
      throw new DatabaseError('internal');
    const history = statement(
      'SELECT version,checksum FROM migration_history ORDER BY version',
    ).all();
    if (
      history.length !== MIGRATIONS.length ||
      history.some(
        (row, index) =>
          Number(row.version) !== MIGRATIONS[index]!.version ||
          row.checksum !==
            createHash('sha256').update(MIGRATIONS[index]!.sql).digest('hex'),
      )
    )
      throw new DatabaseError('internal');
    const integrity = statement('PRAGMA integrity_check').all();
    if (
      integrity.length !== 1 ||
      Object.values(integrity[0]!)[0] !== 'ok' ||
      statement('PRAGMA foreign_key_check').all().length
    )
      throw new DatabaseError('internal');
    const metadata = new Map(
      statement('SELECT key,value FROM platform_metadata')
        .all()
        .map((row) => [String(row.key), String(row.value)]),
    );
    if (
      metadata.size !== 2 ||
      !metadata.has('stream_epoch') ||
      !/^(0|[1-9][0-9]*)$/.test(metadata.get('min_valid_position') ?? '')
    )
      throw new DatabaseError('internal');
    const sequences = new Map(
      statement('SELECT name,seq FROM sqlite_sequence')
        .all()
        .map((row) => [String(row.name), BigInt(String(row.seq))]),
    );
    const lastSequence = String(sequences.get('event_outbox') ?? 0n);
    if (BigInt(metadata.get('min_valid_position')!) > BigInt(lastSequence))
      throw new DatabaseError('internal');
    const counts: Record<string, number> = {};
    await target.run(async () => {
      const initial = await target.getStreamMetadata();
      if (
        initial.epoch !== '1' ||
        initial.minValidPosition !== '0' ||
        initial.lastSequence !== '0'
      )
        throw new DatabaseError('internal');
      for (const table of IMPORT_TABLES)
        if (
          BigInt(
            String(
              (await target
                .prepare(`SELECT COUNT(*) AS n FROM "${table}"`)
                .get())!.n,
            ),
          ) !== 0n
        )
          throw new DatabaseError('internal');
      for (const table of IMPORT_TABLES) {
        const columns = statement(`PRAGMA table_info("${table}")`)
          .all()
          .map((row) => String(row.name));
        if (
          !columns.length ||
          columns.some((column) => !/^[a-z][a-z0-9_]*$/.test(column))
        )
          throw new DatabaseError('internal');
        // Require the exact target column topology before copying any rows.
        const targetColumns = await target
          .prepare(
            'SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position',
          )
          .all(target.schema, table);
        if (
          JSON.stringify(columns) !==
          JSON.stringify(targetColumns.map((row) => row.column_name))
        )
          throw new DatabaseError('internal');
        const insert = target.prepare(
          `INSERT INTO "${table}"(${columns.map((column) => `"${column}"`).join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
        );
        let count = 0;
        for (const row of statement(`SELECT * FROM "${table}"`).iterate()) {
          await insert.run(
            ...columns.map((column) => row[column] as StorageParameter),
          );
          count++;
        }
        counts[table] = count;
      }
      for (const table of identityTables) {
        const max = BigInt(
          String(
            (await target
              .prepare(`SELECT COALESCE(MAX(id),0) AS id FROM "${table}"`)
              .get())!.id,
          ),
        );
        const last = sequences.get(table) ?? 0n;
        const value = max > last ? max : last;
        await target
          .prepare(
            "SELECT setval(pg_get_serial_sequence(?, 'id'), ?::bigint, ?::boolean)",
          )
          .get(
            `${target.schema}.${table}`,
            String(value || 1n),
            value > 0n ? 'true' : 'false',
          );
      }
      for (const [key, value] of [...metadata, ['last_sequence', lastSequence]])
        await target
          .prepare('UPDATE platform_metadata SET value=? WHERE key=?')
          .run(value!, key!);
    });
    return { counts, lastSequence };
  } catch (error) {
    if (error instanceof DatabaseError) throw error;
    throw new DatabaseError();
  } finally {
    try {
      source.exec('ROLLBACK');
    } finally {
      source.close();
    }
  }
}
