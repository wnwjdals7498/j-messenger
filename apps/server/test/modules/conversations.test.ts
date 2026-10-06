import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Clock,
  OpaqueCursorCodec,
  PositionId,
  RequestContext,
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
  createConversationService,
  type ConversationService,
} from '../../src/modules/conversations/index.js';

class TestClock implements Clock {
  now() {
    return new Date('2026-10-02T00:00:00.000Z');
  }
}
const config = (dir: string) =>
  loadConfig(
    {
      NODE_ENV: 'development',
      CURSOR_SIGNING_KEY: 'conversation-test-signing-key-32-bytes-minimum',
    },
    dir,
  );
const codec: OpaqueCursorCodec = {
  encode(claims) {
    return `opaque:${claims.serverId}:${claims.userId}:${claims.epoch}:${claims.position}:${claims.expiresAt}`;
  },
  decode(token, expected) {
    const parts = /^opaque:([^:]+):([^:]+):([^:]+):([^:]+):(.+)$/.exec(token);
    if (
      !parts ||
      parts[1] !== expected.serverId ||
      parts[2] !== expected.userId ||
      parts[3] !== expected.epoch ||
      Date.parse(parts[5]!) <= expected.now.getTime()
    )
      throw new Error('invalid cursor');
    return { position: parts[4] as PositionId, expiresAt: parts[5]! };
  },
};

describe('conversations module', () => {
  let dir: string;
  let db: Database;
  let context: RequestContext;
  let conversations: ConversationService;
  let logRecords: Readonly<Record<string, unknown>>[];
  const ids = {
    n: 0,
    uuid() {
      this.n++;
      return `00000000-0000-4000-8000-${String(this.n).padStart(12, '0')}` as Uuid;
    },
  };
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jm-conversations-'));
    const clock = new TestClock();
    logRecords = [];
    const logger = createLogger({
      release: 'test',
      module: 'conversations-test',
      level: 'debug',
      clock,
      sink: (record) => logRecords.push(record),
    });
    db = createDatabase(path.join(dir, 'conversations.sqlite'), {
      migrations: MIGRATIONS,
      clock,
    });
    const identity = await createIdentityService({
      db,
      config: config(dir),
      clock,
      idFactory: ids,
    });
    const alice = await identity.login('dev-a', 'alice', 'dev-only');
    const bob = await identity.login('dev-a', 'bob', 'dev-only');
    await identity.login('dev-a', 'carol', 'dev-only');
    await identity.login('dev-b', 'mallory', 'dev-only');
    context = await identity.resolve({
      credential: alice.credential,
      requestId: ids.uuid(),
    });
    conversations = createConversationService({
      db,
      identity,
      clock,
      cursorCodec: codec,
      logger,
    });
    context = { ...context, userId: alice.user.id };
    void bob;
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('converges concurrent direct creation to one conversation and hides it from nonmembers', async () => {
    const input = {
      kind: 'direct' as const,
      memberIds: ['2'],
      clientRequestId: ids.uuid(),
    };
    const results = await Promise.all([
      conversations.create(context, input),
      conversations.create(context, input),
    ]);
    expect(results.map((result) => result.conversation.id)).toEqual([
      results[0]!.conversation.id,
      results[0]!.conversation.id,
    ]);
    expect(
      db.prepare('SELECT count(*) AS count FROM conversations').get()!.count,
    ).toBe(1n);
    expect(
      db.prepare('SELECT count(*) AS count FROM event_outbox').get()!.count,
    ).toBe(1n);
    const other = await createIdentityService({
      db,
      config: config(dir),
      clock: new TestClock(),
      idFactory: ids,
    });
    const mallory = await other.login('dev-b', 'mallory', 'dev-only');
    const outsider = await other.resolve({
      credential: mallory.credential,
      requestId: ids.uuid(),
    });
    await expect(
      conversations.get(outsider, results[0]!.conversation.id),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(
      await conversations.canAccess(outsider, results[0]!.conversation.id),
    ).toBe(false);
  });

  it('deduplicates identical group request IDs and conflicts when their meaning changes', async () => {
    const clientRequestId = ids.uuid();
    const input = {
      kind: 'group' as const,
      memberIds: ['2', '3'],
      title: 'Team',
      clientRequestId,
    };
    const first = await conversations.create(context, input);
    const retry = await conversations.create(context, input);
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.conversation.id).toBe(first.conversation.id);
    await expect(
      conversations.create(context, { ...input, title: 'Changed' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(
      db.prepare('SELECT count(*) AS count FROM conversations').get()!.count,
    ).toBe(1n);
  });

  it('rejects unregistered cross-server member IDs and rolls event and membership back on failure', async () => {
    await expect(
      conversations.create(context, {
        kind: 'group',
        memberIds: ['999'],
        clientRequestId: ids.uuid(),
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    db.connection.exec('DROP TABLE event_outbox');
    await expect(
      conversations.create(context, {
        kind: 'group',
        memberIds: ['2'],
        clientRequestId: ids.uuid(),
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(
      db.prepare('SELECT count(*) AS count FROM conversations').get()!.count,
    ).toBe(0n);
    expect(
      db.prepare('SELECT count(*) AS count FROM members').get()!.count,
    ).toBe(0n);
  });

  it('returns a stable opaque snapshot cursor and position from one read transaction', async () => {
    await conversations.create(context, {
      kind: 'group',
      memberIds: ['2'],
      clientRequestId: ids.uuid(),
    });
    const page = await conversations.listSnapshot(context, 20);
    expect(page.items).toHaveLength(1);
    expect(page.snapshotPosition).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(page.snapshotCursor).not.toBe(page.snapshotPosition);
  });

  it('emits allowlisted metadata without logger drop diagnostics', async () => {
    await conversations.create(context, {
      kind: 'group',
      memberIds: ['2'],
      clientRequestId: ids.uuid(),
    });
    expect(
      logRecords.some((record) => record.event === 'logging.entry.dropped'),
    ).toBe(false);
    expect(
      logRecords.some(
        (record) =>
          record.event === 'conversations.group.created' && record.count === 2,
      ),
    ).toBe(true);
    expect(JSON.stringify(logRecords)).not.toContain('Team');
  });

  it('keeps list pagination inside its original snapshot when newer conversations arrive', async () => {
    for (let i = 0; i < 3; i++)
      await conversations.create(context, {
        kind: 'group',
        memberIds: ['2'],
        clientRequestId: ids.uuid(),
      });
    const first = await conversations.list(context, null, 1);
    await conversations.create(context, {
      kind: 'group',
      memberIds: ['2'],
      clientRequestId: ids.uuid(),
    });
    const second = await conversations.list(context, first.nextCursor, 1);
    const third = await conversations.list(context, second.nextCursor, 1);
    expect([
      first.items[0]!.id,
      second.items[0]!.id,
      third.items[0]!.id,
    ]).toEqual(['1', '2', '3']);
    expect(second.snapshotPosition).toBe(first.snapshotPosition);
    expect(third.snapshotPosition).toBe(first.snapshotPosition);
  });
});
