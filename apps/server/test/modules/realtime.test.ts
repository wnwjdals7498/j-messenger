import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type {
  Clock,
  EventHydrator,
  EventRecord,
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
import {
  createHttpServer,
  registerHttpRoutes,
} from '../../src/platform/http/index.js';
import {
  createRealtimeService,
  type RealtimeService,
} from '../../src/modules/realtime/index.js';

class TestClock implements Clock {
  value = new Date('2026-10-02T00:00:00.000Z');
  now() {
    return new Date(this.value);
  }
}
const signingKey = 'realtime-test-signing-key-with-at-least-32-bytes';
const inbox = new WeakMap<
  WebSocket,
  { queue: string[]; waiters: Array<(value: unknown) => void> }
>();
const message = (socket: WebSocket) =>
  new Promise<unknown>((resolve, reject) => {
    const box = inbox.get(socket)!;
    const queued = box.queue.shift();
    if (queued !== undefined) {
      resolve(JSON.parse(queued));
      return;
    }
    const timer = setTimeout(
      () => reject(new Error('websocket message timeout')),
      2500,
    );
    box.waiters.push((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
const watch = (socket: WebSocket) => {
  const box = {
    queue: [] as string[],
    waiters: [] as Array<(value: unknown) => void>,
  };
  inbox.set(socket, box);
  socket.on('message', (raw) => {
    const rawText = raw.toString();
    const waiter = box.waiters.shift();
    if (waiter) waiter(JSON.parse(rawText));
    else box.queue.push(rawText);
  });
};

describe('realtime module', () => {
  let dir: string;
  let db: Database;
  let clock: TestClock;
  let identity: Awaited<ReturnType<typeof createIdentityService>>;
  let realtime: RealtimeService;
  let app: ReturnType<typeof createHttpServer>;
  let port: number;
  let credential: string;
  let context: Awaited<ReturnType<typeof identity.resolve>>;
  let logRecords: Readonly<Record<string, unknown>>[];
  const ids = {
    n: 0,
    uuid() {
      return `00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}` as Uuid;
    },
  };
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jm-realtime-'));
    clock = new TestClock();
    logRecords = [];
    db = createDatabase(path.join(dir, 'realtime.sqlite'), {
      migrations: MIGRATIONS,
      clock,
    });
    const baseConfig = loadConfig(
      { NODE_ENV: 'development', CURSOR_SIGNING_KEY: signingKey },
      dir,
    );
    identity = await createIdentityService({
      db,
      config: baseConfig,
      clock,
      idFactory: ids,
    });
    const login = await identity.login('dev-a', 'alice', 'dev-only');
    credential = login.credential;
    context = await identity.resolve({ credential, requestId: ids.uuid() });
    const listener = net.createServer();
    await new Promise<void>((resolve) =>
      listener.listen(0, '127.0.0.1', resolve),
    );
    port = (listener.address() as net.AddressInfo).port;
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    const config = { ...baseConfig, publicOrigin: `http://127.0.0.1:${port}` };
    const codec = createCursorCodec({ key: signingKey });
    const hydrator: EventHydrator = {
      async hydrate(_context, row: EventRecord) {
        return {
          eventId: row.id,
          type: row.type,
          occurredAt: row.occurredAt,
          data: { item: row.entityId },
        };
      },
    };
    const sync = createSyncService({ db, hydrator, cursorCodec: codec, clock });
    const logger = createLogger({
      release: 'test',
      module: 'realtime-test',
      level: 'debug',
      clock,
      sink: (record) => logRecords.push(record),
    });
    realtime = createRealtimeService({
      db,
      config,
      resolver: identity,
      sync,
      hydrator,
      clock,
      logger,
      pollMs: 60_000,
      heartbeatMs: 60_000,
      maxBufferedBytes: 1024,
    });
    app = createHttpServer({ config, resolver: identity, logger });
    registerHttpRoutes(app, (scope) => realtime.registerRoutes(scope));
    await app.listen({ host: '127.0.0.1', port });
  });
  afterEach(async () => {
    realtime.close();
    await app.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const connect = async (origin = `http://127.0.0.1:${port}`) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`, {
      headers: { Origin: origin, Cookie: `jm_session=${credential}` },
    });
    watch(socket);
    await once(socket, 'open');
    return socket;
  };

  it('authenticates the real cookie session, sends ready high-water, and emits only committed hydrated events', async () => {
    const socket = await connect();
    try {
      const ready = (await message(socket)) as {
        type: string;
        cursor: string;
        position: string;
      };
      expect(ready).toMatchObject({ type: 'ready', position: '0' });
      await db.run((tx) =>
        db.append(tx, {
          type: 'committed.test.v1',
          occurredAt: clock.now().toISOString(),
          serverId: context.serverId,
          entityId: '77',
          recipientUserIds: [context.userId],
          payloadRef: { entityType: 'message', entityId: '77' },
        }),
      );
      await realtime.poll();
      expect(await message(socket)).toMatchObject({
        type: 'committed.test.v1',
        eventId: '1',
      });
      expect(
        logRecords.some((record) => record.event === 'logging.entry.dropped'),
      ).toBe(false);
      expect(
        logRecords.some(
          (record) => record.event === 'realtime.connection.opened',
        ),
      ).toBe(true);
      expect(JSON.stringify(logRecords)).not.toContain(credential);
    } finally {
      socket.close();
    }
  });

  it('closes the actual websocket after session revocation and rejects a wrong Origin', async () => {
    const socket = await connect();
    await message(socket);
    await identity.logout(context);
    await realtime.poll();
    const [code] = (await once(socket, 'close')) as [number];
    expect(code).toBe(4001);
    const rejected = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`, {
      headers: {
        Origin: 'http://evil.example',
        Cookie: `jm_session=${credential}`,
      },
    });
    const [error] = await once(rejected, 'error');
    expect(error).toBeTruthy();
    rejected.terminate();
  });

  it('accepts a bearer-only native websocket without Origin', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`, {
      headers: { Authorization: `Bearer ${credential}` },
    });
    watch(socket);
    await once(socket, 'open');
    try {
      expect(await message(socket)).toMatchObject({
        type: 'ready',
        position: '0',
      });
    } finally {
      socket.close();
    }
  });

  it('closes when a hydrated event exceeds the bounded send queue', async () => {
    const socket = await connect();
    await message(socket);
    await db.run((tx) =>
      db.append(tx, {
        type: 'large.test.v1',
        occurredAt: clock.now().toISOString(),
        serverId: context.serverId,
        entityId: '7'.repeat(2000),
        recipientUserIds: [context.userId],
        payloadRef: { entityType: 'message', entityId: '7'.repeat(2000) },
      }),
    );
    await realtime.poll();
    const [code] = (await once(socket, 'close')) as [number];
    expect(code).toBe(1013);
  });

  it('closes a live socket after heartbeat lease expiry', async () => {
    const socket = await connect();
    await message(socket);
    clock.value = new Date(clock.value.getTime() + 61_000);
    await realtime.poll();
    const [code] = (await once(socket, 'close')) as [number];
    expect(code).toBe(4000);
  });
});
