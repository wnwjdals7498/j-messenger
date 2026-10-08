import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Clock, RequestContext, Uuid } from '@j-messenger/contracts';
import { MIGRATIONS } from '../../src/bootstrap/migrations.js';
import { createDatabase } from '../../src/platform/database/index.js';
import type { Database } from '../../src/platform/database/index.js';
import {
  asStorage,
  type StorageDatabase,
} from '../../src/platform/storage/index.js';
import { createAuditService } from '../../src/modules/audit/index.js';

class TestClock implements Clock {
  now() {
    return new Date('2026-10-06T00:00:00.000Z');
  }
}
const ctx = (server = 'dev-a', user = '1'): RequestContext => ({
  serverId: server as RequestContext['serverId'],
  userId: user as RequestContext['userId'],
  sessionId: '1' as RequestContext['sessionId'],
  requestId: '00000000-0000-4000-8000-000000000099' as Uuid,
  authenticatedAt: '2026-10-06T00:00:00.000Z',
});
describe('audit module', () => {
  let dir: string, db: Database, storage: StorageDatabase, clock: TestClock;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jm-audit-'));
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
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  it('commits append atomically, keeps system actor null, and fails closed for reads without verified admin', async () => {
    const service = createAuditService({
      db,
      clock,
      authorizeAdmin: async (c) => c.serverId === 'dev-a' && c.userId === '1',
    });
    await expect(
      storage.run(async (tx) => {
        await service.append(tx, ctx(), {
          action: 'files.delete',
          targetId: '00000000-0000-4000-8000-000000000001' as Uuid,
          metadata: { count: 1 },
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    await storage.run((tx) =>
      service.appendSystem(
        tx,
        {
          serverId: 'dev-a' as RequestContext['serverId'],
          requestId: ctx().requestId,
        },
        { action: 'retention.batch', targetId: null, metadata: { count: 1 } },
      ),
    );
    const stored = db
      .prepare('SELECT actor_id,metadata_json FROM audit_events')
      .get() as { actor_id: bigint | null; metadata_json: string };
    expect(stored.actor_id).toBeNull();
    expect(JSON.parse(stored.metadata_json)).toEqual({ count: 1 });
    await expect(service.list(ctx('dev-b'), null, 10)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect((await service.list(ctx(), null, 10)).items).toHaveLength(1);
  });
  it('rejects free-form sensitive metadata before changing the transaction', async () => {
    const service = createAuditService({ db, clock });
    await expect(
      storage.run((tx) =>
        service.append(tx, ctx(), {
          action: 'message.created',
          targetId: '1',
          metadata: { body: 'private text' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM audit_events').get(),
    ).toMatchObject({ n: 0n });
  });
});
