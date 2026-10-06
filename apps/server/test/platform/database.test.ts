import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  DatabaseError,
  PLATFORM_MIGRATION,
} from '../../src/platform/database/index.js';
import type { Database } from '../../src/platform/database/index.js';
import { createLogger } from '../../src/platform/logging/index.js';
import type {
  EventAppend,
  PositionId,
  RequestContext,
  TxContext,
} from '@j-messenger/contracts';

describe('SQLite platform database', () => {
  let dir: string;
  let db: Database;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jm-db-'));
    db = createDatabase(path.join(dir, 'test.sqlite'), {
      migrations: [PLATFORM_MIGRATION],
    });
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  it('commits writes and effects after commit; rollback discards effects', async () => {
    expect(db.prepare('PRAGMA busy_timeout').get()!.timeout).toBe(1000n);
    expect(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys).toBe(1n);
    expect(db.prepare('PRAGMA synchronous').get()!.synchronous).toBe(2n);
    db.connection.exec(
      'CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT)',
    );
    const calls: string[] = [];
    await db.run((tx) => {
      db.prepare('INSERT INTO sample(value) VALUES(?)').run('ok');
      tx.afterCommit(() => {
        calls.push('commit');
      });
    });
    expect(calls).toEqual(['commit']);
    await expect(
      db.run((tx) => {
        db.prepare('INSERT INTO sample(value) VALUES(?)').run('rolled');
        tx.afterCommit(() => {
          calls.push('rollback');
        });
        throw Error('stop');
      }),
    ).rejects.toThrow('stop');
    expect(calls).toEqual(['commit']);
    expect(db.prepare('SELECT count(*) AS n FROM sample').get()!.n).toBe(1n);
  });
  it('rejects thenables, nested transactions, inactive contexts and broken foreign keys', async () => {
    let escaped!: TxContext;
    await expect(
      db.run((tx) => {
        escaped = tx;
        return Promise.resolve(1);
      }),
    ).rejects.toThrow();
    await expect(db.run(() => db.run(() => 1))).rejects.toThrow();
    expect(() => escaped.assertActive()).toThrow();
    db.connection.exec(
      'CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(pid INTEGER REFERENCES parent(id))',
    );
    expect(() => db.prepare('INSERT INTO child VALUES(9)').run()).toThrow();
  });
  it('rejects foreign transaction contexts and keeps commits despite effect failures', async () => {
    const other = createDatabase(path.join(dir, 'other.sqlite'), {
      migrations: [PLATFORM_MIGRATION],
    });
    try {
      const event: EventAppend = {
        type: 'test.v1',
        occurredAt: '2026-01-01T00:00:00.000Z',
        serverId: 'srv',
        entityId: '1',
        recipientUserIds: [],
        payloadRef: { entityType: 'message', entityId: '1' },
      };
      await other.run((tx) => expect(() => db.append(tx, event)).toThrow());
    } finally {
      other.close();
    }
    db.connection.exec('CREATE TABLE keep(id INTEGER PRIMARY KEY)');
    await db.run((tx) => {
      db.prepare('INSERT INTO keep VALUES(1)').run();
      tx.afterCommit(() => {
        throw Error('effect error');
      });
      tx.afterCommit(async () => {
        throw Error('async effect error');
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(db.prepare('SELECT count(*) AS n FROM keep').get()!.n).toBe(1n);
  });
  it('keeps sequence positions after pruning and preserves 64-bit ids as strings', async () => {
    const big: EventAppend = {
      type: 'message.created.v1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      serverId: 'srv',
      entityId: '9007199254740993',
      recipientUserIds: ['2'],
      payloadRef: { entityType: 'message', entityId: '9007199254740993' },
    };
    await db.run((tx) => {
      db.append(tx, big);
    });
    const id = await db.highWatermark({ serverId: 'srv' } as RequestContext);
    expect(id).toBe('1');
    await db.run((tx) => {
      db.pruneEvents(tx, id);
    });
    expect(db.getStreamMetadata().lastSequence).toBe('1');
    expect(await db.highWatermark({ serverId: 'srv' } as RequestContext)).toBe(
      '1',
    );
    await db.run((tx) => {
      db.append(tx, big);
    });
    expect(await db.highWatermark({ serverId: 'srv' } as RequestContext)).toBe(
      '2',
    );
    const metadata = db.getStreamMetadata();
    expect(metadata.minValidPosition).toBe('1');
    db.connection.exec('CREATE TABLE big_values(value INTEGER)');
    db.prepare('INSERT INTO big_values VALUES(?)').run(9007199254740993n);
    expect(db.prepare('SELECT value FROM big_values').get()!.value).toBe(
      9007199254740993n,
    );
    const oldEpoch = db.getStreamMetadata().epoch;
    let rotated = '';
    await db.run((tx) => {
      rotated = db.rotateStreamEpoch(tx);
    });
    expect(rotated).not.toBe(oldEpoch);
    expect(db.getStreamMetadata().epoch).toBe(rotated);
    db.close();
    db = createDatabase(path.join(dir, 'test.sqlite'), {
      migrations: [PLATFORM_MIGRATION],
    });
    expect(db.getStreamMetadata().epoch).toBe(rotated);
  });
  it('uses a bigint last-insert query and enforces monotonic bounded pruning', async () => {
    if (
      !db
        .prepare("SELECT seq FROM sqlite_sequence WHERE name='event_outbox'")
        .get()
    ) {
      db.prepare(
        "INSERT INTO sqlite_sequence(name,seq) VALUES('event_outbox',?)",
      ).run(9007199254740993n);
    }
    const event: EventAppend = {
      type: 'test.v1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      serverId: 'srv',
      entityId: '1',
      recipientUserIds: [],
      payloadRef: { entityType: 'message', entityId: '1' },
    };
    await db.run((tx) => {
      expect(db.append(tx, event)).toBe('9007199254740994');
    });
    await expect(
      db.run((tx) => db.pruneEvents(tx, '9007199254740995' as PositionId)),
    ).rejects.toBeInstanceOf(Error);
    await db.run((tx) => {
      db.pruneEvents(tx, '9007199254740994' as PositionId);
    });
    await expect(
      db.run((tx) => db.pruneEvents(tx, '9007199254740993' as PositionId)),
    ).rejects.toBeInstanceOf(Error);
    expect(db.getStreamMetadata().minValidPosition).toBe('9007199254740994');
  });
  it('reads a global snapshot position inside its owning transaction', async () => {
    const event: EventAppend = {
      type: 'test.v1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      serverId: 'one',
      entityId: '1',
      recipientUserIds: [],
      payloadRef: { entityType: 'message', entityId: '1' },
    };
    await db.run((tx) => {
      db.append(tx, event);
    });
    await db.run((tx) => {
      db.append(tx, { ...event, serverId: 'two' });
    });
    await db.run((tx) => {
      expect(
        db.snapshotPosition(tx, { serverId: 'one' } as RequestContext),
      ).toBe('2');
    });
    expect(await db.highWatermark({ serverId: 'two' } as RequestContext)).toBe(
      '2',
    );
    const foreign = createDatabase(path.join(dir, 'foreign.sqlite'), {
      migrations: [PLATFORM_MIGRATION],
    });
    try {
      await foreign.run((tx) =>
        expect(() =>
          db.snapshotPosition(tx, { serverId: 'one' } as RequestContext),
        ).toThrow(),
      );
    } finally {
      foreign.close();
    }
  });
  it('rejects modified migration checksums and version gaps', async () => {
    db.close();
    const file = path.join(dir, 'test.sqlite');
    expect(() =>
      createDatabase(file, {
        migrations: [
          {
            ...PLATFORM_MIGRATION,
            sql: PLATFORM_MIGRATION.sql + '\n-- changed',
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      createDatabase(path.join(dir, 'gap.sqlite'), {
        migrations: [{ version: 2, sql: 'SELECT 1' }],
      }),
    ).toThrow();
    const futurePath = path.join(dir, 'future.sqlite');
    const future = createDatabase(futurePath);
    future
      .prepare(
        'INSERT INTO migration_history(version,checksum,applied_at) VALUES(?,?,?)',
      )
      .run(2, 'future-hash', '2026-01-01T00:00:00.000Z');
    future.close();
    expect(() =>
      createDatabase(futurePath, { migrations: [PLATFORM_MIGRATION] }),
    ).toThrow();
  });
  it('reopens a database and keeps its applied schema', async () => {
    db.close();
    db = createDatabase(path.join(dir, 'test.sqlite'), {
      migrations: [PLATFORM_MIGRATION],
    });
    expect(db.getStreamMetadata()).toEqual({
      epoch: '1',
      minValidPosition: '0',
      lastSequence: '0',
    });
  });
  it('performs a SQLite online backup', async () => {
    const backupPath = path.join(dir, 'copy.sqlite');
    await db.backup(backupPath);
    const copy = createDatabase(backupPath, {
      migrations: [PLATFORM_MIGRATION],
    });
    expect(copy.getStreamMetadata().epoch).toBe('1');
    copy.close();
  });
  it('emits database logs through the safe logger without SQL or path data', async () => {
    const records: Readonly<Record<string, unknown>>[] = [];
    const logger = createLogger({
      release: 'test',
      module: 'server',
      level: 'debug',
      sink: (record) => records.push(record),
    });
    db.close();
    const privatePath = path.join(dir, 'private-secret-path.sqlite');
    db = createDatabase(privatePath, {
      migrations: [PLATFORM_MIGRATION],
      logger,
    });
    await db.run(() => {
      db.prepare('SELECT 1').get();
    });
    await expect(
      db.run(() =>
        db
          .prepare('SELECT * FROM private_secret_table WHERE password=?')
          .get('secret-value'),
      ),
    ).rejects.toBeInstanceOf(DatabaseError);
    await db.run((tx) => {
      tx.afterCommit(() => {
        throw Error('raw-after-commit-secret');
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const output = JSON.stringify(records);
    expect(output).toContain('database.migration.applied');
    expect(output).toContain('database.opened');
    expect(output).toContain('database.transaction.committed');
    expect(output).toContain('database.transaction.rollback');
    expect(output).toContain('database.aftercommit.failed');
    expect(output).not.toContain('logging.entry.dropped');
    expect(
      records.find(
        (record) => record['event'] === 'database.migration.applied',
      ),
    ).toMatchObject({ featureId: 'F39', schemaVersion: 1 });
    expect(output).not.toContain(privatePath);
    expect(output).not.toContain('private_secret_table');
    expect(output).not.toContain('secret-value');
    expect(output).not.toContain('raw-after-commit-secret');
  });
});
