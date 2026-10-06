import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Clock,
  ConversationAccess,
  IdFactory,
  RequestContext,
  Uuid,
} from '@j-messenger/contracts';
import { MIGRATIONS } from '../../src/bootstrap/migrations.js';
import { createDatabase } from '../../src/platform/database/index.js';
import type { Database } from '../../src/platform/database/index.js';
import { createJobRunner, JobStore } from '../../src/platform/jobs/index.js';
import { createFilesService } from '../../src/modules/files/index.js';

class TestClock implements Clock {
  value = new Date('2026-10-06T00:00:00.000Z');
  now() {
    return new Date(this.value);
  }
}
class TestIds implements IdFactory {
  private n = 1;
  uuid() {
    return `00000000-0000-4000-8000-${String(this.n++).padStart(12, '0')}` as Uuid;
  }
}
const context: RequestContext = {
  serverId: 'dev-a' as RequestContext['serverId'],
  userId: '1' as RequestContext['userId'],
  sessionId: '1' as RequestContext['sessionId'],
  requestId: '00000000-0000-4000-8000-000000000099' as Uuid,
  authenticatedAt: '2026-10-06T00:00:00.000Z',
};
describe('files module', () => {
  let dir: string,
    db: Database,
    clock: TestClock,
    service: ReturnType<typeof createFilesService>;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jm-files-'));
    clock = new TestClock();
    db = createDatabase(path.join(dir, 'db.sqlite'), {
      migrations: MIGRATIONS,
      clock,
    });
    await db.run(() =>
      db.prepare("INSERT INTO mail_servers VALUES('dev-a','dev-a')").run(),
    );
    await db.run(() =>
      db
        .prepare(
          "INSERT INTO users(server_id,username,display_name,created_at) VALUES('dev-a','test','Test',?)",
        )
        .run(clock.now().toISOString()),
    );
    await db.run(() =>
      db
        .prepare(
          "INSERT INTO conversations(server_id,kind,title,created_at) VALUES('dev-a','group','test',?)",
        )
        .run(clock.now().toISOString()),
    );
    await db.run(() =>
      db
        .prepare(
          "INSERT INTO members(server_id,conversation_id,user_id) VALUES('dev-a',1,1)",
        )
        .run(),
    );
    const access: ConversationAccess = {
      async requireMember(ctx, id) {
        if (ctx.serverId !== 'dev-a' || id !== '1')
          throw new Error('not a member');
      },
      recheckMember(tx, ctx, id) {
        tx.assertActive();
        if (ctx.serverId !== 'dev-a' || id !== '1')
          throw new Error('not a member');
      },
      async canAccess() {
        return true;
      },
    };
    service = createFilesService({
      db,
      root: path.join(dir, 'objects'),
      tempRoot: path.join(dir, 'temp'),
      clock,
      ids: new TestIds(),
      access,
      jobs: new JobStore(db, { clock, idFactory: new TestIds() }),
      policy: { quotaBytes: 2_000_000_000, minimumFreeBytes: 0 },
      diskFreeBytes: async () => 10_000_000,
    });
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const png = (n: number) => {
    const bytes = Buffer.alloc(n);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    return bytes;
  };
  const stream = (b: Uint8Array) => ({
    async *[Symbol.asyncIterator]() {
      yield b;
    },
  });
  it('accepts a real 5,000,000 byte PNG and serves it only after owner bind', async () => {
    const bytes = png(5_000_000),
      descriptor = await service.prepare(
        context,
        '1' as RequestContext['userId'],
        {
          filename: 'photo.PNG',
          contentType: 'png',
          sizeBytes: bytes.length,
          stream: stream(bytes),
        },
      );
    expect(descriptor.sizeBytes).toBe(5_000_000);
    expect(descriptor.status).toBe('ready');
    await expect(
      service.openDownload(context, descriptor.id),
    ).rejects.toThrow();
    await db.run((tx) =>
      service.bind(
        tx,
        context,
        '1' as RequestContext['userId'],
        '9' as RequestContext['userId'],
        [descriptor.id],
      ),
    );
    const opened = await service.openDownload(context, descriptor.id);
    const pieces: Buffer[] = [];
    for await (const piece of opened.stream) pieces.push(Buffer.from(piece));
    expect(Buffer.concat(pieces).equals(bytes)).toBe(true);
  }, 30_000);
  it('rejects a mislabeled binary and an over-limit stream, leaving no downloadable object', async () => {
    await expect(
      service.prepare(context, '1' as RequestContext['userId'], {
        filename: 'x.pdf',
        contentType: 'pdf',
        sizeBytes: 8,
        stream: stream(png(8)),
      }),
    ).rejects.toThrow();
    await expect(
      service.prepare(context, '1' as RequestContext['userId'], {
        filename: 'x.png',
        contentType: 'png',
        sizeBytes: 5_000_001,
        stream: stream(png(8)),
      }),
    ).rejects.toThrow();
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM files WHERE state='ready'")
      .get() as { n: bigint };
    expect(Number(count.n)).toBe(0);
  });
  it('enqueues physical deletion in the same transaction and treats an absent object as success', async () => {
    const bytes = png(8),
      f = await service.prepare(context, '1' as RequestContext['userId'], {
        filename: 'x.png',
        contentType: 'png',
        sizeBytes: 8,
        stream: stream(bytes),
      });
    await db.run((tx) =>
      service.bind(
        tx,
        context,
        '1' as RequestContext['userId'],
        '9' as RequestContext['userId'],
        [f.id],
      ),
    );
    await db.run((tx) => service.scheduleDelete(tx, f.id, 'retention_expired'));
    const job = db
      .prepare("SELECT id FROM platform_jobs WHERE kind='files.delete'")
      .get() as { id: Uuid };
    const runner = createJobRunner({
      db,
      store: new JobStore(db, { clock, idFactory: new TestIds() }),
      clock,
      idFactory: new TestIds(),
      handlers: [service.deleteHandler],
    });
    expect(await runner.runBatch(1)).toEqual({
      completed: 1,
      retried: 0,
      failed: 0,
    });
    const row = db.prepare('SELECT state FROM files WHERE id=?').get(f.id) as {
      state: string;
    };
    expect(row.state).toBe('deleted');
    expect(
      db.prepare('SELECT status FROM platform_jobs WHERE id=?').get(job.id),
    ).toMatchObject({ status: 'completed' });
    expect(
      (
        await service.deleteHandler.handle({
          id: job.id,
          kind: 'files.delete',
          payload: { fileId: f.id },
          attempt: 2,
          requestId: null,
        })
      ).status,
    ).toBe('completed');
  });
  it('reconciles interrupted streams and blocks downloads at the independent fourteen-day boundary', async () => {
    const broken = {
      async *[Symbol.asyncIterator]() {
        yield png(4);
        throw new Error('interrupted');
      },
    };
    await expect(
      service.prepare(context, '1' as RequestContext['userId'], {
        filename: 'broken.png',
        contentType: 'png',
        sizeBytes: 8,
        stream: broken,
      }),
    ).rejects.toThrow();
    clock.value = new Date(clock.value.getTime() + 60 * 60_000 + 1);
    expect(await service.reconcileOrphans(10)).toEqual({ removed: 1 });
    expect(
      db
        .prepare("SELECT state,filename FROM files WHERE state='deleted'")
        .get(),
    ).toMatchObject({ state: 'deleted', filename: null });
    clock.value = new Date('2026-10-06T00:00:00.000Z');
    const f = await service.prepare(context, '1' as RequestContext['userId'], {
      filename: 'x.png',
      contentType: 'png',
      sizeBytes: 8,
      stream: stream(png(8)),
    });
    await db.run((tx) =>
      service.bind(
        tx,
        context,
        '1' as RequestContext['userId'],
        '9' as RequestContext['userId'],
        [f.id],
      ),
    );
    clock.value = new Date(clock.value.getTime() + 14 * 86400000);
    await expect(service.openDownload(context, f.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
