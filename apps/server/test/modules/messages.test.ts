import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Clock,
  OpaqueCursorCodec,
  PositionId,
  RequestContext,
  TxContext,
  Uuid,
} from '@j-messenger/contracts';
import { DomainError } from '@j-messenger/contracts';
import { loadConfig } from '../../src/platform/config/index.js';
import {
  createDatabase,
  type Database,
} from '../../src/platform/database/index.js';
import { createLogger } from '../../src/platform/logging/index.js';
import { MIGRATIONS } from '../../src/bootstrap/migrations.js';
import { createIdentityService } from '../../src/modules/identity/index.js';
import { createConversationService } from '../../src/modules/conversations/index.js';
import {
  createMessageService,
  type FilesPort,
} from '../../src/modules/messages/index.js';
import { createFilesService } from '../../src/modules/files/index.js';
import { JobStore } from '../../src/platform/jobs/index.js';

class TestClock implements Clock {
  value = new Date('2026-10-02T00:00:00.000Z');
  now() {
    return new Date(this.value);
  }
  advance(ms: number) {
    this.value = new Date(this.value.getTime() + ms);
  }
}
const config = (dir: string) =>
  loadConfig(
    {
      NODE_ENV: 'development',
      CURSOR_SIGNING_KEY: 'message-test-signing-key-with-at-least-32-bytes',
    },
    dir,
  );
const codec: OpaqueCursorCodec = {
  encode(c) {
    return `opaque:${c.serverId}:${c.userId}:${c.epoch}:${c.position}:${c.expiresAt}`;
  },
  decode(t, e) {
    const p = t.split(':');
    if (
      p.length !== 6 ||
      p[0] !== 'opaque' ||
      p[1] !== e.serverId ||
      p[2] !== e.userId ||
      p[3] !== e.epoch ||
      Date.parse(p[5]!) <= e.now.getTime()
    )
      throw new Error('bad cursor');
    return { position: p[4] as PositionId, expiresAt: p[5]! };
  },
};

describe('messages module', () => {
  let dir: string;
  let db: Database;
  let clock: TestClock;
  let identity: Awaited<ReturnType<typeof createIdentityService>>;
  let context: RequestContext;
  let outsider: RequestContext;
  let conversationId: string;
  let conversations: ReturnType<typeof createConversationService>;
  let service: ReturnType<typeof createMessageService>;
  let logRecords: Readonly<Record<string, unknown>>[];
  const ids = {
    next: 0,
    uuid() {
      return `00000000-0000-4000-8000-${String(++this.next).padStart(12, '0')}` as Uuid;
    },
  };
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jm-messages-'));
    clock = new TestClock();
    logRecords = [];
    const logger = createLogger({
      release: 'test',
      module: 'messages-test',
      level: 'debug',
      clock,
      sink: (record) => logRecords.push(record),
    });
    db = createDatabase(path.join(dir, 'messages.sqlite'), {
      migrations: MIGRATIONS,
      clock,
    });
    identity = await createIdentityService({
      db,
      config: config(dir),
      clock,
      idFactory: ids,
    });
    const alice = await identity.login('dev-a', 'alice', 'dev-only');
    const bob = await identity.login('dev-a', 'bob', 'dev-only');
    const carol = await identity.login('dev-a', 'carol', 'dev-only');
    context = await identity.resolve({
      credential: alice.credential,
      requestId: ids.uuid(),
    });
    outsider = await identity.resolve({
      credential: carol.credential,
      requestId: ids.uuid(),
    });
    conversations = createConversationService({
      db,
      identity,
      clock,
      cursorCodec: codec,
    });
    const created = await conversations.create(context, {
      kind: 'group',
      memberIds: [bob.user.id],
      clientRequestId: ids.uuid(),
    });
    conversationId = created.conversation.id;
    service = createMessageService({
      db,
      access: conversations,
      activity: conversations,
      clock,
      cursorCodec: codec,
      logger,
    });
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('trims UTF-16 text, deduplicates concurrent retries, and rejects changed content', async () => {
    const clientMessageId = ids.uuid();
    const input = { clientMessageId, text: `  ${'한'.repeat(3998)}😀  ` };
    const [a, b] = await Promise.all([
      service.create(context, conversationId, input),
      service.create(context, conversationId, input),
    ]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.message.text).toBe(`${'한'.repeat(3998)}😀`);
    expect(
      db.prepare('SELECT count(*) AS count FROM messages').get()!.count,
    ).toBe(1n);
    expect(
      db
        .prepare('SELECT count(*) AS count FROM event_outbox WHERE type=?')
        .get('message.created.v1')!.count,
    ).toBe(1n);
    expect(
      logRecords.some((record) => record.event === 'logging.entry.dropped'),
    ).toBe(false);
    expect(
      logRecords.some((record) => record.event === 'messages.accepted'),
    ).toBe(true);
    expect(JSON.stringify(logRecords)).not.toContain(input.text);
    await expect(
      service.create(context, conversationId, {
        clientMessageId,
        text: 'changed',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('uses exclusive before/after boundaries, hides nonmember history, and rejects both boundaries together', async () => {
    const m1 = await service.create(context, conversationId, {
      clientMessageId: ids.uuid(),
      text: 'one',
    });
    const m2 = await service.create(context, conversationId, {
      clientMessageId: ids.uuid(),
      text: 'two',
    });
    const after = await service.list(context, conversationId, {
      after: m1.message.id,
      limit: 10,
    });
    expect(after.items.map((m) => m.id)).toEqual([m2.message.id]);
    const before = await service.list(context, conversationId, {
      before: m2.message.id,
      limit: 10,
    });
    expect(before.items.map((m) => m.id)).toEqual([m1.message.id]);
    await expect(
      service.list(context, conversationId, {
        before: m2.message.id,
        after: m1.message.id,
        limit: 10,
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      service.list(outsider, conversationId, { limit: 10 }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('atomically rolls message, dedup, activity, and outbox back when event storage fails', async () => {
    db.connection.exec('DROP TABLE event_outbox');
    await expect(
      service.create(context, conversationId, {
        clientMessageId: ids.uuid(),
        text: 'rollback',
      }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(
      db.prepare('SELECT count(*) AS count FROM messages').get()!.count,
    ).toBe(0n);
    expect(
      db.prepare('SELECT count(*) AS count FROM message_dedup').get()!.count,
    ).toBe(0n);
    expect(
      (
        db
          .prepare('SELECT last_message_at FROM conversations WHERE id=?')
          .get(BigInt(conversationId)) as { last_message_at: string | null }
      ).last_message_at,
    ).toBeNull();
  });

  it('expires only plaintext after five days and keeps live attachment references', async () => {
    const fileId = ids.uuid();
    let live = true;
    const filePort: FilesPort = {
      bind(tx, ctx, convId, msgId, fileIds) {
        db.assertOwn(tx);
        void ctx;
        void convId;
        void msgId;
        void fileIds;
      },
      attachedLiveIds(_tx: TxContext, _ctx, _msgId) {
        return live ? [fileId] : [];
      },
    };
    service = createMessageService({
      db,
      access: conversations,
      activity: conversations,
      clock,
      files: filePort,
      cursorCodec: codec,
    });
    await service.create(context, conversationId, {
      clientMessageId: ids.uuid(),
      text: 'secret body',
      fileIds: [fileId],
    });
    clock.advance(5 * 86_400_000 + 1);
    const system = { serverId: context.serverId, requestId: ids.uuid() };
    expect(await service.purgeExpiredForServer(system)).toEqual({ purged: 1 });
    const page = await service.list(context, conversationId, { limit: 10 });
    expect(page.items[0]).toMatchObject({
      text: null,
      contentExpired: true,
      fileIds: [fileId],
    });
    expect(
      db.prepare('SELECT count(*) AS count FROM message_files').get()!.count,
    ).toBe(1n);
    live = false;
    expect(
      (await service.list(context, conversationId, { limit: 10 })).items[0]!
        .fileIds,
    ).toEqual([]);
    clock.advance(9 * 86_400_000);
    await db.run((tx) => service.expireFileReference(tx, system, fileId));
    expect(
      db.prepare('SELECT count(*) AS count FROM messages').get()!.count,
    ).toBe(0n);
    expect(
      db.prepare('SELECT message_id FROM message_dedup').get()!.message_id,
    ).toBeNull();
  });

  it('refuses attachments without a files port and retains decimal IDs as strings', async () => {
    const id = ids.uuid();
    await expect(
      service.create(context, conversationId, {
        clientMessageId: ids.uuid(),
        text: 'attachment',
        fileIds: [id],
      }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    const big = '9007199254740999';
    db.prepare(
      'INSERT INTO messages(server_id,conversation_id,sender_id,client_message_id,text,created_at) VALUES(?,?,?,?,?,?)',
    ).run(
      context.serverId,
      BigInt(conversationId),
      BigInt(context.userId),
      ids.uuid(),
      'large',
      clock.now().toISOString(),
    );
    db.prepare('UPDATE sqlite_sequence SET seq=? WHERE name=?').run(
      BigInt(big) - 1n,
      'messages',
    );
    const created = await service.create(context, conversationId, {
      clientMessageId: ids.uuid(),
      text: 'large',
    });
    const row = db
      .prepare('SELECT id FROM messages ORDER BY id DESC LIMIT 1')
      .get() as { id: bigint };
    expect(row.id.toString()).toBe(big);
    expect(created.message.id).toBe(big);
  });

  it('rolls back the message if the files owner refuses to bind an attachment', async () => {
    const rejectedFiles: FilesPort = {
      bind() {
        throw new DomainError('not_found');
      },
      attachedLiveIds() {
        return [];
      },
    };
    const withFiles = createMessageService({
      db,
      access: conversations,
      activity: conversations,
      clock,
      cursorCodec: codec,
      files: rejectedFiles,
    });
    await expect(
      withFiles.create(context, conversationId, {
        clientMessageId: ids.uuid(),
        text: 'attach',
        fileIds: [ids.uuid()],
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(
      db.prepare('SELECT count(*) AS count FROM messages').get()!.count,
    ).toBe(0n);
    expect(
      db.prepare('SELECT count(*) AS count FROM message_dedup').get()!.count,
    ).toBe(0n);
    expect(
      db.prepare('SELECT count(*) AS count FROM message_files').get()!.count,
    ).toBe(0n);
    expect(
      db
        .prepare(
          "SELECT count(*) AS count FROM event_outbox WHERE type='message.created.v1'",
        )
        .get()!.count,
    ).toBe(0n);
  });

  it('keeps a dedup tombstone after body expiry, removes the message row at 14 days, then expires dedup at 30 days', async () => {
    const clientMessageId = ids.uuid();
    const created = await service.create(context, conversationId, {
      clientMessageId,
      text: 'retained',
    });
    const system = { serverId: context.serverId, requestId: ids.uuid() };
    clock.advance(5 * 86_400_000 + 1);
    await service.purgeExpiredForServer(system);
    expect(
      db
        .prepare('SELECT content_expired FROM messages WHERE id=?')
        .get(BigInt(created.message.id))!.content_expired,
    ).toBe(1n);
    clock.advance(9 * 86_400_000 + 1);
    await service.purgeExpiredForServer(system);
    expect(
      db
        .prepare('SELECT count(*) AS count FROM messages WHERE id=?')
        .get(BigInt(created.message.id))!.count,
    ).toBe(0n);
    expect(
      db
        .prepare(
          'SELECT message_id FROM message_dedup WHERE client_message_id=?',
        )
        .get(clientMessageId)!.message_id,
    ).toBeNull();
    const login = await identity.login('dev-a', 'alice', 'dev-only');
    const current = await identity.resolve({
      credential: login.credential,
      requestId: ids.uuid(),
    });
    await expect(
      service.create(current, conversationId, {
        clientMessageId,
        text: 'retained',
      }),
    ).rejects.toMatchObject({ code: 'message_expired' });
    clock.advance(30 * 86_400_000 + 1);
    await service.purgeExpiredForServer(system);
    expect(
      db
        .prepare(
          'SELECT count(*) AS count FROM message_dedup WHERE client_message_id=?',
        )
        .get(clientMessageId)!.count,
    ).toBe(0n);
  });

  it('binds a real SQLite file through the owner port and keeps it downloadable after body expiry', async () => {
    const jobs = new JobStore(db, { clock, idFactory: ids });
    const files = createFilesService({
      db,
      root: path.join(dir, 'objects'),
      tempRoot: path.join(dir, 'temporary'),
      clock,
      ids,
      access: conversations,
      jobs,
      policy: { quotaBytes: 10_000_000, minimumFreeBytes: 0 },
      diskFreeBytes: async () => 20_000_000,
    });
    const bytes = new TextEncoder().encode('attachment payload');
    const file = await files.prepare(context, conversationId, {
      filename: 'notes.txt',
      contentType: 'txt',
      sizeBytes: bytes.length,
      stream: {
        async *[Symbol.asyncIterator]() {
          yield bytes;
        },
      },
    });
    const integrated = createMessageService({
      db,
      access: conversations,
      activity: conversations,
      clock,
      cursorCodec: codec,
      files,
    });
    const sent = await integrated.create(context, conversationId, {
      clientMessageId: ids.uuid(),
      text: 'body',
      fileIds: [file.id],
    });
    expect(sent.message.fileIds).toEqual([file.id]);
    expect(
      db
        .prepare('SELECT file_id FROM message_files WHERE message_id=?')
        .get(BigInt(sent.message.id))!.file_id,
    ).toBe(file.id);
    clock.advance(5 * 86_400_000 + 1);
    const system = { serverId: context.serverId, requestId: ids.uuid() };
    await integrated.purgeExpiredForServer(system);
    const expired = await integrated.list(context, conversationId, {
      limit: 10,
    });
    expect(expired.items[0]).toMatchObject({
      contentExpired: true,
      text: null,
      fileIds: [file.id],
    });
    const download = await files.openDownload(context, file.id);
    const chunks: Uint8Array[] = [];
    for await (const chunk of download.stream) chunks.push(chunk as Uint8Array);
    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))).toEqual(
      Buffer.from(bytes),
    );
    clock.advance(9 * 86_400_000 + 1);
    await db.run((tx) => {
      files.scheduleDelete(tx, file.id, 'retention_expired');
      integrated.expireFileReference(tx, system, file.id);
    });
    expect(
      db
        .prepare('SELECT count(*) AS count FROM message_files WHERE file_id=?')
        .get(file.id)!.count,
    ).toBe(0n);
    expect(
      db
        .prepare('SELECT count(*) AS count FROM messages WHERE id=?')
        .get(BigInt(sent.message.id))!.count,
    ).toBe(0n);
    expect(
      db
        .prepare(
          'SELECT message_id FROM message_dedup WHERE client_message_id=?',
        )
        .get(sent.message.clientMessageId)!.message_id,
    ).toBeNull();
  });
});
