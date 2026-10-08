import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Clock,
  IdFactory,
  JobHandler,
  Uuid,
} from '@j-messenger/contracts';
import {
  createDatabase,
  PLATFORM_MIGRATION,
} from '../../src/platform/database/index.js';
import type { Database } from '../../src/platform/database/index.js';
import {
  asStorage,
  type StorageDatabase,
} from '../../src/platform/storage/index.js';
import { createLogger } from '../../src/platform/logging/index.js';
import {
  JOB_MIGRATION,
  JobStore,
  createJobRunner,
} from '../../src/platform/jobs/index.js';

const migrations = [PLATFORM_MIGRATION, JOB_MIGRATION] as const;
class TestClock implements Clock {
  value = new Date('2026-10-02T00:00:00.000Z');
  now(): Date {
    return new Date(this.value);
  }
  advance(ms: number): void {
    this.value = new Date(this.value.getTime() + ms);
  }
}
class TestIds implements IdFactory {
  private n = 1;
  uuid(): Uuid {
    return `00000000-0000-4000-8000-${String(this.n++).padStart(12, '0')}` as Uuid;
  }
}
describe('persistent job platform', () => {
  let dir: string;
  let db: Database;
  let storage: StorageDatabase;
  let clock: TestClock;
  let ids: TestIds;
  let store: JobStore;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jm-jobs-'));
    clock = new TestClock();
    ids = new TestIds();
    db = createDatabase(path.join(dir, 'jobs.sqlite'), { migrations, clock });
    storage = asStorage(db);
    store = new JobStore(db, { clock, idFactory: ids });
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const enqueue = (payload: unknown, extras: Record<string, unknown> = {}) =>
    storage.run(
      async (tx) =>
        await store.enqueue(tx, {
          kind: 'mail.cleanup',
          payload,
          serverId: 'srv',
          ...extras,
        } as Parameters<JobStore['enqueue']>[1]),
    );

  it('deduplicates identical references and rejects a changed payload; commit and rollback are atomic with consumer progress', async () => {
    let id = '';
    await storage.run(async (tx) => {
      id = await store.enqueue(tx, {
        kind: 'mail.cleanup',
        payload: { b: 2, a: 1 },
        serverId: 'srv',
        dedupKey: 'key',
      });
      await storage.advanceConsumerPosition(tx, 'notifications', '7');
    });
    expect(await enqueue({ a: 1, b: 2 }, { dedupKey: 'key' })).toBe(id);
    await expect(enqueue({ a: 9 }, { dedupKey: 'key' })).rejects.toThrow();
    expect(db.getConsumerPosition('notifications')).toBe('7');
    let rolled = '';
    await expect(
      storage.run(async (tx) => {
        rolled = await store.enqueue(tx, {
          kind: 'mail.cleanup',
          payload: {},
          serverId: 'srv',
        });
        await storage.advanceConsumerPosition(tx, 'notifications', '8');
        throw Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(db.getConsumerPosition('notifications')).toBe('7');
    await storage.run(async (tx) =>
      expect(await store.get(tx, rolled)).toBeNull(),
    );
  });

  it('claims once across two runners and executes handlers outside the transaction', async () => {
    db.connection.exec('CREATE TABLE handler_effects(id TEXT PRIMARY KEY)');
    const id = await enqueue({ ref: 'payloadRef' });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler: JobHandler<{ ref: string }> = {
      kind: 'mail.cleanup',
      async handle(job) {
        expect(job.id).toBe(id);
        await db.run(() => {
          db.prepare('INSERT INTO handler_effects VALUES(?)').run(job.id);
        });
        entered();
        await gate;
        return { status: 'completed' };
      },
    };
    const runnerA = createJobRunner({
      db,
      store,
      clock,
      idFactory: ids,
      handlers: [handler],
      leaseMs: 1000,
      handlerTimeoutMs: 900,
    });
    const runnerB = createJobRunner({
      db,
      store,
      clock,
      idFactory: ids,
      handlers: [handler],
      leaseMs: 1000,
      handlerTimeoutMs: 900,
    });
    const inFlight = runnerA.runBatch(1);
    await started;
    expect(await runnerB.runBatch(1)).toEqual({
      completed: 0,
      retried: 0,
      failed: 0,
    });
    release();
    expect(await inFlight).toEqual({ completed: 1, retried: 0, failed: 0 });
    expect(
      db.prepare('SELECT count(*) AS n FROM handler_effects').get()!.n,
    ).toBe(1n);
    await storage.run(async (tx) =>
      expect((await store.get(tx, id))?.status).toBe('completed'),
    );
  });

  it('reclaims only expired leases after restart and rejects the former owner acknowledgement', async () => {
    const id = await enqueue({ ref: '1' });
    const owner1 = ids.uuid();
    await storage.run(async (tx) =>
      expect((await store.claim(tx, owner1, 5000, 10))?.attempt).toBe(1),
    );
    db.close();
    db = createDatabase(path.join(dir, 'jobs.sqlite'), { migrations, clock });
    storage = asStorage(db);
    store = new JobStore(db, { clock, idFactory: ids });
    const owner2 = ids.uuid();
    await storage.run(async (tx) =>
      expect(await store.claim(tx, owner2, 5000, 10)).toBeNull(),
    );
    clock.advance(5001);
    let reclaimed!: Awaited<ReturnType<(typeof store)['claim']>>;
    await storage.run(async (tx) => {
      reclaimed = await store.claim(tx, owner2, 5000, 10);
    });
    expect(reclaimed?.id).toBe(id);
    expect(reclaimed?.attempt).toBe(2);
    await storage.run(async (tx) =>
      expect(await store.complete(tx, reclaimed!, owner1)).toBe(false),
    );
    await storage.run(async (tx) =>
      expect(await store.complete(tx, reclaimed!, owner2)).toBe(true),
    );
  });

  it('backs off invalid retry times safely, fails at attempt ten, and resumes the same ID', async () => {
    const id = await enqueue({ ref: 'durable' });
    const handler: JobHandler = {
      kind: 'mail.cleanup',
      async handle() {
        return {
          status: 'retry',
          retryAt: 'not-a-time',
          reason: 'raw provider response',
        };
      },
    };
    const runner = createJobRunner({
      db,
      store,
      clock,
      idFactory: ids,
      handlers: [handler],
      maxAttempts: 10,
      leaseMs: 1000,
      handlerTimeoutMs: 900,
    });
    for (let attempt = 1; attempt <= 10; attempt++) {
      const result = await runner.runBatch(1);
      if (attempt < 10) {
        expect(result.retried).toBe(1);
        await storage.run(async (tx) =>
          expect((await store.get(tx, id))?.nextRunAt).toBe(
            new Date(
              clock.now().getTime() +
                Math.min(300_000, 1000 * 2 ** (attempt - 1)),
            ).toISOString(),
          ),
        );
        clock.advance(Math.min(300_000, 1000 * 2 ** (attempt - 1)));
      } else expect(result.failed).toBe(1);
    }
    await storage.run(async (tx) =>
      expect(await store.get(tx, id)).toMatchObject({
        id,
        status: 'failed',
        attempt: 10,
        reasonCode: 'max_attempts',
      }),
    );
    await storage.run(async (tx) => store.resume(tx, id));
    await storage.run(async (tx) =>
      expect(await store.get(tx, id)).toMatchObject({
        id,
        status: 'pending',
        attempt: 0,
        reasonCode: null,
      }),
    );
  });

  it('preserves unknown kinds for explicit resume and applies handler effects before completion acknowledgement', async () => {
    const id = await enqueue({ onlyReference: 'entity-id' });
    const missing = createJobRunner({
      db,
      store,
      clock,
      idFactory: ids,
      handlers: [],
      leaseMs: 1000,
      handlerTimeoutMs: 900,
    });
    expect(await missing.runBatch(1)).toMatchObject({ failed: 1 });
    let effected = false;
    const registered: JobHandler = {
      kind: 'mail.cleanup',
      async handle() {
        effected = true;
        return { status: 'completed' };
      },
    };
    await storage.run(async (tx) => store.resume(tx, id));
    const runner = createJobRunner({
      db,
      store,
      clock,
      idFactory: ids,
      handlers: [registered],
      leaseMs: 1000,
      handlerTimeoutMs: 900,
    });
    expect(await runner.runBatch(1)).toMatchObject({ completed: 1 });
    expect(effected).toBe(true);
  });

  it('logs lifecycle signals through F42 without payload content', async () => {
    const records: Readonly<Record<string, unknown>>[] = [];
    const logger = createLogger({
      release: 'test',
      module: 'server',
      level: 'debug',
      sink: (record) => records.push(record),
    });
    store = new JobStore(db, { clock, idFactory: ids, logger });
    await storage.run(
      async (tx) =>
        await store.enqueue(tx, {
          kind: 'mail.cleanup',
          payload: { body: 'sensitive-payload' },
          serverId: 'srv',
        }),
    );
    const handler: JobHandler = {
      kind: 'mail.cleanup',
      async handle() {
        return { status: 'completed' };
      },
    };
    const runner = createJobRunner({
      db,
      store,
      clock,
      idFactory: ids,
      handlers: [handler],
      logger,
    });
    expect(await runner.runBatch(1)).toEqual({
      completed: 1,
      retried: 0,
      failed: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const output = JSON.stringify(records);
    expect(output).toContain('job.started');
    expect(output).toContain('job.completed');
    expect(output).not.toContain('sensitive-payload');
    expect(output).not.toContain('logging.entry.dropped');
  });

  it('honors stop and turns handler timeouts into durable retries', async () => {
    const id = await enqueue({ ref: 'slow' });
    const handler: JobHandler = {
      kind: 'mail.cleanup',
      handle: () => new Promise(() => {}),
    };
    const stopped = createJobRunner({
      db,
      store,
      clock,
      idFactory: ids,
      handlers: [handler],
      leaseMs: 100,
      handlerTimeoutMs: 20,
    });
    stopped.stop();
    expect(await stopped.runBatch(1)).toEqual({
      completed: 0,
      retried: 0,
      failed: 0,
    });
    const runner = createJobRunner({
      db,
      store,
      clock,
      idFactory: ids,
      handlers: [handler],
      leaseMs: 100,
      handlerTimeoutMs: 20,
    });
    expect(await runner.runBatch(1)).toEqual({
      completed: 0,
      retried: 1,
      failed: 0,
    });
    await storage.run(async (tx) =>
      expect(await store.get(tx, id)).toMatchObject({
        status: 'pending',
        attempt: 1,
        reasonCode: 'handler_error',
      }),
    );
  });
});
