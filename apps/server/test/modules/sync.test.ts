import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Clock,
  EventHydrator,
  EventRecord,
  PositionId,
  Uuid,
} from '@j-messenger/contracts';
import { loadConfig } from '../../src/platform/config/index.js';
import {
  createDatabase,
  type Database,
} from '../../src/platform/database/index.js';
import { createLogger } from '../../src/platform/logging/index.js';
import { MIGRATIONS } from '../../src/bootstrap/migrations.js';
import { createIdentityService } from '../../src/modules/identity/index.js';
import {
  createCursorCodec,
  createSyncService,
} from '../../src/modules/sync/index.js';

class TestClock implements Clock {
  value = new Date('2026-10-02T00:00:00.000Z');
  now() {
    return new Date(this.value);
  }
}
const key = 'sync-test-signing-key-with-at-least-thirty-two-bytes';
const config = (dir: string) =>
  loadConfig({ NODE_ENV: 'development', CURSOR_SIGNING_KEY: key }, dir);

describe('sync module', () => {
  let dir: string;
  let db: Database;
  let clock: TestClock;
  let identity: Awaited<ReturnType<typeof createIdentityService>>;
  let context: Awaited<ReturnType<typeof identity.resolve>>;
  let logRecords: Readonly<Record<string, unknown>>[];
  const ids = {
    n: 0,
    uuid() {
      return `00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}` as Uuid;
    },
  };
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jm-sync-'));
    clock = new TestClock();
    logRecords = [];
    db = createDatabase(path.join(dir, 'sync.sqlite'), {
      migrations: MIGRATIONS,
      clock,
    });
    identity = await createIdentityService({
      db,
      config: config(dir),
      clock,
      idFactory: ids,
    });
    const login = await identity.login('dev-a', 'alice', 'dev-only');
    context = await identity.resolve({
      credential: login.credential,
      requestId: ids.uuid(),
    });
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const hydrator: EventHydrator = {
    async hydrate(_ctx, record: EventRecord) {
      if (record.type === 'hidden.test.v1') return null;
      return {
        eventId: record.id,
        type: record.type,
        occurredAt: record.occurredAt,
        data: { id: record.entityId },
      };
    },
  };

  it('signs cursors with full context and rejects tampered, cross-user, expired, and rotated tokens', () => {
    const codec = createCursorCodec({ key });
    const claims = {
      serverId: context.serverId,
      userId: context.userId,
      epoch: db.getStreamMetadata().epoch,
      position: '9223372036854775800' as PositionId,
      expiresAt: new Date(clock.now().getTime() + 1000).toISOString(),
    };
    const token = codec.encode(claims);
    expect(
      codec.decode(token, {
        serverId: context.serverId,
        userId: context.userId,
        epoch: claims.epoch,
        now: clock.now(),
      }).position,
    ).toBe(claims.position);
    expect(() =>
      codec.decode(`${token}x`, {
        serverId: context.serverId,
        userId: context.userId,
        epoch: claims.epoch,
        now: clock.now(),
      }),
    ).toThrow();
    expect(() =>
      codec.decode(token, {
        serverId: context.serverId,
        userId: '99',
        epoch: claims.epoch,
        now: clock.now(),
      }),
    ).toThrow();
    expect(() =>
      codec.decode(token, {
        serverId: context.serverId,
        userId: context.userId,
        epoch: 'rotated',
        now: clock.now(),
      }),
    ).toThrow();
    clock.value = new Date('2026-10-02T00:00:02.000Z');
    expect(() =>
      codec.decode(token, {
        serverId: context.serverId,
        userId: context.userId,
        epoch: claims.epoch,
        now: clock.now(),
      }),
    ).toThrow();
  });

  it('advances through hidden rows, holds a fixed upper bound, and returns only hydrated events', async () => {
    const codec = createCursorCodec({ key });
    await db.run((tx) => {
      db.append(tx, {
        type: 'hidden.test.v1',
        occurredAt: clock.now().toISOString(),
        serverId: 'dev-a',
        entityId: '1',
        recipientUserIds: [],
        payloadRef: { entityType: 'message', entityId: '1' },
      });
      db.append(tx, {
        type: 'visible.test.v1',
        occurredAt: clock.now().toISOString(),
        serverId: 'dev-a',
        entityId: '2',
        recipientUserIds: [context.userId],
        payloadRef: { entityType: 'message', entityId: '2' },
      });
    });
    const logger = createLogger({
      release: 'test',
      module: 'sync-test',
      level: 'debug',
      clock,
      sink: (record) => logRecords.push(record),
    });
    const sync = createSyncService({
      db,
      hydrator,
      cursorCodec: codec,
      clock,
      scanLimit: 1,
      logger,
    });
    const first = await sync.sync(context, { after: null, limit: 10 });
    expect(first.data).toHaveLength(0);
    expect(first.scannedThrough).toBe('1');
    expect(first.hasMore).toBe(true);
    await db.run((tx) =>
      db.append(tx, {
        type: 'later.test.v1',
        occurredAt: clock.now().toISOString(),
        serverId: 'dev-a',
        entityId: '3',
        recipientUserIds: [context.userId],
        payloadRef: { entityType: 'message', entityId: '3' },
      }),
    );
    const second = await sync.sync(context, {
      after: first.nextCursor,
      through: first.through,
      limit: 10,
    });
    expect(second.data).toHaveLength(1);
    expect(second.data[0]!.type).toBe('visible.test.v1');
    expect(second.through).toBe(first.through);
    expect(second.throughPosition).toBe(first.throughPosition);
    expect(second.scannedThrough).toBe(first.throughPosition);
    const completed = await sync.sync(context, {
      after: second.nextCursor,
      through: first.through,
      limit: 10,
    });
    expect(completed.data).toHaveLength(0);
    expect(completed.hasMore).toBe(false);
    expect(
      logRecords.some((record) => record.event === 'logging.entry.dropped'),
    ).toBe(false);
    expect(
      logRecords.some(
        (record) =>
          record.event === 'sync.page.completed' && record.skippedCount === 1,
      ),
    ).toBe(true);
    expect(JSON.stringify(logRecords)).not.toContain(first.nextCursor);
    expect(JSON.stringify(logRecords)).not.toContain(first.through);
  });

  it('keeps high 64-bit event positions exact and rejects positions outside the fixed through bound', async () => {
    const codec = createCursorCodec({ key });
    await db.run((tx) => {
      db.append(tx, {
        type: 'visible.test.v1',
        occurredAt: clock.now().toISOString(),
        serverId: 'dev-a',
        entityId: '1',
        recipientUserIds: [context.userId],
        payloadRef: { entityType: 'message', entityId: '1' },
      });
      db.prepare(
        "UPDATE sqlite_sequence SET seq=? WHERE name='event_outbox'",
      ).run(9007199254740992n);
    });
    const service = createSyncService({
      db,
      hydrator,
      cursorCodec: codec,
      clock,
    });
    const ready = await service.ready(context);
    expect(ready.position).toBe('9007199254740992');
    const page = await service.sync(context, { after: null, limit: 10 });
    expect(page.throughPosition).toBe('9007199254740992');
    const tooFar = codec.encode({
      serverId: context.serverId,
      userId: context.userId,
      epoch: db.getStreamMetadata().epoch,
      position: '9007199254740993' as PositionId,
      expiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
    });
    await expect(
      service.sync(context, {
        after: tooFar,
        through: page.through,
        limit: 10,
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('returns the reset error for a signed cursor after stream epoch rotation', async () => {
    const codec = createCursorCodec({ key });
    const service = createSyncService({
      db,
      hydrator,
      cursorCodec: codec,
      clock,
    });
    const prior = service.initialCursor(context);
    await db.run((tx) => db.rotateStreamEpoch(tx));
    await expect(
      service.sync(context, { after: prior, limit: 10 }),
    ).rejects.toMatchObject({ code: 'sync_reset_required' });
  });
});
