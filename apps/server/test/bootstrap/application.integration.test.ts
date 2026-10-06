import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InjectPayload, Response } from 'light-my-request';
import WebSocket from 'ws';
import type { Clock, Uuid } from '@j-messenger/contracts';
import { loadConfig } from '../../src/platform/config/index.js';
import { createLogger } from '../../src/platform/logging/index.js';
import { createApplication } from '../../src/bootstrap/application.js';

const socketInbox = new WeakMap<
  WebSocket,
  { queue: string[]; waiters: Array<(value: string) => void> }
>();
const watchSocket = (socket: WebSocket) => {
  const box = {
    queue: [] as string[],
    waiters: [] as Array<(value: string) => void>,
  };
  socketInbox.set(socket, box);
  socket.on('message', (data) => {
    const value = data.toString();
    const waiter = box.waiters.shift();
    if (waiter) waiter(value);
    else box.queue.push(value);
  });
};
const nextSocketMessage = (socket: WebSocket) =>
  new Promise<string>((resolve, reject) => {
    const box = socketInbox.get(socket)!;
    const queued = box.queue.shift();
    if (queued !== undefined) {
      resolve(queued);
      return;
    }
    const timer = setTimeout(
      () => reject(new Error('WebSocket message timed out')),
      3000,
    );
    box.waiters.push((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });

class TestClock implements Clock {
  value = new Date('2026-10-06T00:00:00.000Z');
  now() {
    return new Date(this.value);
  }
  advance(days: number) {
    this.value = new Date(this.value.getTime() + days * 86_400_000);
  }
}

describe('application bootstrap integration', () => {
  let root: string;
  let port: number;
  let clock: TestClock;
  let app: Awaited<ReturnType<typeof createApplication>>;
  let logger: ReturnType<typeof createLogger>;
  const logs: Readonly<Record<string, unknown>>[] = [];
  const origin = () => `http://127.0.0.1:${port}`;
  const reservePort = async () =>
    new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('No ephemeral port'));
          return;
        }
        const value = address.port;
        server.close((error) => (error ? reject(error) : resolve(value)));
      });
    });

  const start = async () => {
    const config = loadConfig(
      {
        NODE_ENV: 'development',
        HOST: '127.0.0.1',
        PORT: String(port),
        PUBLIC_ORIGIN: origin(),
      },
      root,
    );
    app = await createApplication(config, {
      clock,
      logger,
      maintenance: false,
    });
  };
  const login = async (username: string) => {
    const response = await app.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers: { origin: origin() },
      payload: { serverId: 'dev-a', username, password: 'dev-only' },
    });
    expect(response.statusCode).toBe(201);
    const cookie = response.cookies.find((item) => item.name === 'jm_session');
    expect(cookie?.httpOnly).toBe(true);
    return {
      cookie: `jm_session=${cookie!.value}`,
      user: response.json().data as { id: string },
    };
  };
  const request = (
    cookie: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: InjectPayload,
  ): Promise<Response> =>
    app.app.inject({
      method,
      url,
      headers: { cookie, origin: origin() },
      ...(payload === undefined ? {} : { payload }),
    });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'jm-app-integration-'));
    port = await reservePort();
    clock = new TestClock();
    logs.length = 0;
    logger = createLogger({
      release: 'integration-test',
      module: 'server',
      level: 'info',
      clock,
      sink: (record) => logs.push(record),
    });
    await start();
  });
  afterEach(async () => {
    if (app) await app.close();
    expect(
      logs.some((record) => record.event === 'logging.entry.dropped'),
    ).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it('uses real HTTP routes and SQLite for identity, server isolation, message dedup, receipts, and opaque sync cursors', async () => {
    const alice = await login('alice');
    const bob = await login('bob');
    const mallory = await request(alice.cookie, 'POST', '/api/v1/session', {
      serverId: 'dev-b',
      username: 'mallory',
      password: 'dev-only',
    });
    expect(mallory.statusCode).toBe(201);
    const users = await request(alice.cookie, 'GET', '/api/v1/users');
    expect(users.json().data.map((x: { id: string }) => x.id)).toContain(
      bob.user.id,
    );
    expect(
      (
        await request(
          alice.cookie,
          'GET',
          '/api/v1/users?cursor=eyJub3QiOiJudW1iZXIifQ',
        )
      ).statusCode,
    ).toBe(400);
    const native = await app.app.inject({
      method: 'POST',
      url: '/api/v1/native/session',
      payload: { serverId: 'dev-a', username: 'alice', password: 'dev-only' },
    });
    expect(native.statusCode).toBe(201);
    const bearer = native.json().data.credential as string;
    expect(
      (
        await app.app.inject({
          method: 'GET',
          url: '/api/v1/me',
          headers: { authorization: `Bearer ${bearer}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.app.inject({
          method: 'GET',
          url: '/api/v1/me',
          headers: { authorization: `Bearer ${bearer}`, cookie: alice.cookie },
        })
      ).statusCode,
    ).toBe(401);

    const created = await request(
      alice.cookie,
      'POST',
      '/api/v1/conversations',
      {
        kind: 'group',
        memberIds: [bob.user.id],
        title: 'integration',
        clientRequestId: '11111111-1111-4111-8111-111111111111',
      },
    );
    expect(created.statusCode).toBe(201);
    const conversationId = created.json().data.id as string;
    const messageId = '22222222-2222-4222-8222-222222222222' as Uuid;
    const first = await request(
      alice.cookie,
      'POST',
      `/api/v1/conversations/${conversationId}/messages`,
      { clientMessageId: messageId, text: 'persist this' },
    );
    const retry = await request(
      alice.cookie,
      'POST',
      `/api/v1/conversations/${conversationId}/messages`,
      { clientMessageId: messageId, text: 'persist this' },
    );
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().data.id).toBe(first.json().data.id);
    const forbidden = await request(
      (await login('carol')).cookie,
      'GET',
      `/api/v1/conversations/${conversationId}/messages`,
    );
    expect(forbidden.statusCode).toBe(404);
    const messageIdDecimal = first.json().data.id as string;
    expect(
      (
        await request(
          bob.cookie,
          'PUT',
          `/api/v1/conversations/${conversationId}/read`,
          { lastReadMessageId: messageIdDecimal },
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request(
          bob.cookie,
          'PUT',
          `/api/v1/conversations/${conversationId}/read`,
          { lastReadMessageId: '1' },
        )
      ).json().data.lastReadMessageId,
    ).toBe(messageIdDecimal);

    const ready = await app.sync.ready(
      await app.identity.resolve({
        credential: bob.cookie.slice('jm_session='.length),
        requestId: '33333333-3333-4333-8333-333333333333' as Uuid,
      }),
    );
    expect(ready.cursor).not.toMatch(/^\d+$/);
    expect(ready.position).toMatch(/^\d+$/);
    const sync = await request(
      bob.cookie,
      'GET',
      `/api/v1/sync?after=${encodeURIComponent(ready.cursor)}&limit=100`,
    );
    expect(sync.statusCode).toBe(200);
    expect(sync.json().data).toEqual([]);
    expect(
      (await request(alice.cookie, 'GET', '/api/v1/admin/retention'))
        .statusCode,
    ).toBe(404);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'http.request.completed',
          route: '/api/v1/conversations/:id/messages',
          statusCode: 201,
        }),
        expect.objectContaining({
          event: 'messages.accepted',
          outcome: 'success',
          messageId: messageIdDecimal,
        }),
      ]),
    );
    const encodedLogs = JSON.stringify(logs);
    for (const secret of [
      'dev-only',
      alice.cookie.slice('jm_session='.length),
      bearer,
      'persist this',
      ready.cursor,
    ]) {
      expect(encodedLogs).not.toContain(secret);
    }
    expect(
      logs.some((record) => record.event === 'logging.entry.dropped'),
    ).toBe(false);
  });

  it('sends committed messages through a live authenticated WebSocket after the ready watermark', async () => {
    const alice = await login('alice');
    const bob = await login('bob');
    const conversation = await request(
      alice.cookie,
      'POST',
      '/api/v1/conversations',
      {
        kind: 'group',
        memberIds: [bob.user.id],
        title: 'live',
        clientRequestId: '66666666-6666-4666-8666-666666666666',
      },
    );
    const conversationId = conversation.json().data.id as string;
    await app.app.listen({ host: '127.0.0.1', port });
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`, {
      headers: { Origin: origin(), Cookie: alice.cookie },
    });
    watchSocket(socket);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      const readyText = await nextSocketMessage(socket);
      const ready = JSON.parse(readyText) as {
        type: string;
        cursor: string;
        position: string;
      };
      expect(ready.type).toBe('ready');
      expect(ready.cursor).not.toMatch(/^\d+$/);
      expect(ready.position).toMatch(/^\d+$/);
      const posted = await request(
        alice.cookie,
        'POST',
        `/api/v1/conversations/${conversationId}/messages`,
        {
          clientMessageId: '77777777-7777-4777-8777-777777777777',
          text: 'websocket commit',
        },
      );
      expect(posted.statusCode).toBe(201);
      const eventText = await nextSocketMessage(socket);
      const event = JSON.parse(eventText) as {
        type: string;
        eventId: string;
        data: { id: string; text: string };
      };
      expect(event).toMatchObject({
        type: 'message.created.v1',
        data: { id: posted.json().data.id, text: 'websocket commit' },
      });
      expect(BigInt(event.eventId)).toBeGreaterThan(BigInt(ready.position));
    } finally {
      socket.close();
      await new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) resolve();
        else {
          socket.once('close', resolve);
          setTimeout(resolve, 1000).unref();
        }
      });
    }
  }, 10_000);

  it('rejects a real multipart stream above the five million byte limit', async () => {
    const alice = await login('alice');
    const bob = await login('bob');
    const conversation = await request(
      alice.cookie,
      'POST',
      '/api/v1/conversations',
      {
        kind: 'group',
        memberIds: [bob.user.id],
        title: 'size limit',
        clientRequestId: '88888888-8888-4888-8888-888888888888',
      },
    );
    const boundary = 'jm-boundary-over-limit';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="too-large.txt"\r\nContent-Type: text/plain\r\n\r\n`,
      ),
      Buffer.alloc(5_000_001, 0x61),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await app.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversation.json().data.id}/files`,
      headers: {
        cookie: alice.cookie,
        origin: origin(),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('too_large');
    expect(
      Number(
        (
          app.db
            .prepare(
              "SELECT COUNT(*) AS n FROM files WHERE state IN ('ready','attached')",
            )
            .get() as { n: bigint }
        ).n,
      ),
    ).toBe(0);
  }, 10_000);

  it('uploads, sends, and downloads a small TXT file through the real HTTP routes', async () => {
    const alice = await login('alice');
    const bob = await login('bob');
    const conversation = await request(
      alice.cookie,
      'POST',
      '/api/v1/conversations',
      {
        kind: 'group',
        memberIds: [bob.user.id],
        title: 'small attachment',
        clientRequestId: '99999999-9999-4999-8999-999999999999',
      },
    );
    const conversationId = conversation.json().data.id as string;
    const bytes = Buffer.from('small real HTTP attachment');
    const boundary = 'jm-boundary-small-file';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="small.txt"\r\nContent-Type: text/plain\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const upload = await app.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/files`,
      headers: {
        cookie: alice.cookie,
        origin: origin(),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const fileId = upload.json().data.id as string;
    const message = await request(
      alice.cookie,
      'POST',
      `/api/v1/conversations/${conversationId}/messages`,
      {
        clientMessageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        text: 'small attachment round trip',
        fileIds: [fileId],
      },
    );
    expect(message.statusCode).toBe(201);
    const download = await request(
      bob.cookie,
      'GET',
      `/api/v1/files/${fileId}/content`,
    );
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(bytes)).toBe(true);
  });

  it('keeps file lifetime independent from message lifetime and preserves state through a database restart', async () => {
    const alice = await login('alice');
    const bob = await login('bob');
    const conversation = await request(
      alice.cookie,
      'POST',
      '/api/v1/conversations',
      {
        kind: 'group',
        memberIds: [bob.user.id],
        title: 'retention',
        clientRequestId: '44444444-4444-4444-8444-444444444444',
      },
    );
    const conversationId = conversation.json().data.id as string;
    const content = Buffer.alloc(5_000_000, 0x61);
    const boundary = 'jm-boundary-integration';
    const multipartBody = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const uploaded = await app.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/files`,
      headers: {
        cookie: alice.cookie,
        origin: origin(),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const fileId = uploaded.json().data.id as string;
    const sent = await request(
      alice.cookie,
      'POST',
      `/api/v1/conversations/${conversationId}/messages`,
      {
        clientMessageId: '55555555-5555-4555-8555-555555555555',
        text: 'body expires first',
        fileIds: [fileId],
      },
    );
    expect(sent.statusCode).toBe(201);
    const messageId = sent.json().data.id as string;

    clock.advance(4);
    expect(
      (
        await request(
          alice.cookie,
          'GET',
          `/api/v1/conversations/${conversationId}/messages`,
        )
      ).json().data[0],
    ).toMatchObject({
      id: messageId,
      text: 'body expires first',
      contentExpired: false,
      fileIds: [fileId],
    });
    clock.advance(1);

    await app.close();
    await start();
    expect(
      (
        await request(
          alice.cookie,
          'GET',
          `/api/v1/conversations/${conversationId}/messages`,
        )
      ).statusCode,
    ).toBe(200);
    await app.maintain();
    const page = await request(
      alice.cookie,
      'GET',
      `/api/v1/conversations/${conversationId}/messages`,
    );
    expect(page.json().data?.[0], page.body).toMatchObject({
      id: messageId,
      text: null,
      contentExpired: true,
      fileIds: [fileId],
    });
    const download = await request(
      alice.cookie,
      'GET',
      `/api/v1/files/${fileId}/content`,
    );
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(content)).toBe(true);

    clock.advance(9);
    await app.maintain();
    const aliceAfterExpiry = await login('alice');
    expect(
      (
        await request(
          aliceAfterExpiry.cookie,
          'GET',
          `/api/v1/files/${fileId}/content`,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await request(
          aliceAfterExpiry.cookie,
          'GET',
          `/api/v1/conversations/${conversationId}/messages`,
        )
      ).statusCode,
    ).toBe(200);
  }, 30_000);
});
