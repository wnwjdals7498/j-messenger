import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Clock,
  ConversationAccess,
  IdFactory,
  RequestContext,
  SystemContext,
  Uuid,
} from '@j-messenger/contracts';
import { MIGRATIONS } from '../../src/bootstrap/migrations.js';
import { createDatabase } from '../../src/platform/database/index.js';
import type { Database } from '../../src/platform/database/index.js';
import {
  asStorage,
  type StorageDatabase,
} from '../../src/platform/storage/index.js';
import { JobStore } from '../../src/platform/jobs/index.js';
import { createFilesService } from '../../src/modules/files/index.js';
import { createAuditService } from '../../src/modules/audit/index.js';
import { createRetentionService } from '../../src/modules/retention/index.js';

class TestClock implements Clock {
  now() {
    return new Date('2026-10-06T00:00:00.000Z');
  }
}
class TestIds implements IdFactory {
  private n = 1;
  uuid() {
    return `00000000-0000-4000-8000-${String(this.n++).padStart(12, '0')}` as Uuid;
  }
}
const sys: SystemContext = {
  serverId: 'dev-a' as SystemContext['serverId'],
  requestId: '00000000-0000-4000-8000-000000000099' as Uuid,
  jobId: '00000000-0000-4000-8000-000000000098' as Uuid,
};
const ctx: RequestContext = {
  ...sys,
  userId: '1' as RequestContext['userId'],
  sessionId: '1' as RequestContext['sessionId'],
  authenticatedAt: '2026-10-06T00:00:00.000Z',
};
describe('retention module', () => {
  let dir: string,
    db: Database,
    storage: StorageDatabase,
    clock: TestClock,
    files: ReturnType<typeof createFilesService>;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jm-retention-'));
    clock = new TestClock();
    db = createDatabase(path.join(dir, 'db.sqlite'), {
      migrations: MIGRATIONS,
      clock,
    });
    storage = asStorage(db);
    await db.run(() =>
      db.prepare("INSERT INTO mail_servers VALUES('dev-a','dev-a')").run(),
    );
    await db.run(() =>
      db
        .prepare(
          "INSERT INTO users(server_id,username,display_name,created_at) VALUES('dev-a','u','U',?)",
        )
        .run(clock.now().toISOString()),
    );
    await db.run(() =>
      db
        .prepare(
          "INSERT INTO conversations(server_id,kind,title,created_at) VALUES('dev-a','group','g',?)",
        )
        .run(clock.now().toISOString()),
    );
    const access: ConversationAccess = {
      async requireMember() {},
      recheckMember() {},
      async canAccess() {
        return true;
      },
    };
    files = createFilesService({
      db,
      root: path.join(dir, 'objects'),
      tempRoot: path.join(dir, 'temp'),
      clock,
      ids: new TestIds(),
      access,
      jobs: new JobStore(db, { clock, idFactory: new TestIds() }),
      policy: { quotaBytes: 2_000_000_000, minimumFreeBytes: 0 },
      diskFreeBytes: async () => 5_000_000_000,
    });
    db.connection.exec(
      'CREATE TABLE test_messages(id INTEGER PRIMARY KEY,created_at TEXT,purged INTEGER NOT NULL DEFAULT 0);CREATE TABLE test_file_events(id TEXT PRIMARY KEY);',
    );
    await db.run(() => {
      for (const id of [1, 2])
        db.prepare('INSERT INTO test_messages(id,created_at) VALUES(?,?)').run(
          id,
          '2026-10-01T00:00:00.000Z',
        );
      for (const [id, date] of [
        ['00000000-0000-4000-8000-000000000011', '2026-10-01T00:00:00.000Z'],
        ['00000000-0000-4000-8000-000000000012', '2026-09-22T00:00:00.000Z'],
      ] as const)
        db.prepare(
          "INSERT INTO files(id,server_id,owner_user_id,conversation_id,filename,mime_type,size_bytes,object_key,state,created_at,expires_at) VALUES(?,'dev-a',1,1,'name.png','image/png',3,?,'attached',?,?)",
        ).run(
          id,
          id,
          date,
          new Date(Date.parse(date) + 14 * 86400000).toISOString(),
        );
    });
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  it('keeps five-day message expiry independent from fourteen-day file expiry and resumes atomically', async () => {
    const audit = createAuditService({ db, clock });
    const retention = createRetentionService({
      db,
      clock,
      files,
      audit,
      purgeMessages(tx, system, cutoff, afterId, limit) {
        expect(system.serverId).toBe('dev-a');
        const rows = db
          .prepare(
            'SELECT id FROM test_messages WHERE created_at<=? AND id>? ORDER BY id LIMIT ?',
          )
          .all(cutoff, BigInt(afterId), limit + 1) as Array<{ id: bigint }>;
        const page = rows.slice(0, limit);
        for (const row of page)
          db.prepare('UPDATE test_messages SET purged=1 WHERE id=?').run(
            row.id,
          );
        return {
          processed: page.length,
          lastId: String(page.at(-1)?.id ?? afterId),
          hasMore: rows.length > limit,
        };
      },
      async eventExpiredFile(tx, system, fileId) {
        storage.assertOwn(tx);
        await storage
          .prepare('INSERT INTO test_file_events VALUES(?)')
          .run(fileId);
      },
    });
    const first = await retention.runSystemBatch(sys, 1);
    expect(first).toMatchObject({ messages: 1, files: 1, complete: false });
    const fileStatuses = db
      .prepare('SELECT id,state FROM files ORDER BY id')
      .all() as Array<{ id: string; state: string }>;
    expect(fileStatuses).toEqual([
      { id: '00000000-0000-4000-8000-000000000011', state: 'attached' },
      { id: '00000000-0000-4000-8000-000000000012', state: 'deleting' },
    ]);
    const second = await retention.runSystemBatch(sys, 1);
    expect(second.messages).toBe(1);
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM test_messages WHERE purged=1')
        .get(),
    ).toMatchObject({ n: 2n });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM platform_jobs WHERE kind='files.delete'",
        )
        .get(),
    ).toMatchObject({ n: 1n });
    await expect(retention.get(ctx)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
  it('rolls back retention progress, file state, and job together if event reference fails', async () => {
    const audit = createAuditService({ db, clock });
    const retention = createRetentionService({
      db,
      clock,
      files,
      audit,
      purgeMessages() {
        return { processed: 0, lastId: '0', hasMore: false };
      },
      eventExpiredFile() {
        throw new Error('outbox unavailable');
      },
    });
    await expect(retention.runSystemBatch(sys, 10)).rejects.toThrow(
      'outbox unavailable',
    );
    expect(
      db
        .prepare(
          "SELECT state FROM files WHERE id='00000000-0000-4000-8000-000000000012'",
        )
        .get(),
    ).toMatchObject({ state: 'attached' });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM platform_jobs WHERE kind='files.delete'",
        )
        .get(),
    ).toMatchObject({ n: 0n });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM retention_progress').get(),
    ).toMatchObject({ n: 0n });
  });
});
