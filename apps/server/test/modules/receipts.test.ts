import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Clock,
  ConversationAccess,
  ConversationActivity,
  RequestContext,
  TxContext,
  Uuid,
} from '@j-messenger/contracts';
import { MIGRATIONS } from '../../src/bootstrap/migrations.js';
import { createDatabase } from '../../src/platform/database/index.js';
import type { Database } from '../../src/platform/database/index.js';
import { createReceiptsService } from '../../src/modules/receipts/index.js';

class TestClock implements Clock {
  now() {
    return new Date('2026-10-06T00:00:00.000Z');
  }
}
const context: RequestContext = {
  serverId: 'dev-a' as RequestContext['serverId'],
  userId: '1' as RequestContext['userId'],
  sessionId: '1' as RequestContext['sessionId'],
  requestId: '00000000-0000-4000-8000-000000000099' as Uuid,
  authenticatedAt: '2026-10-06T00:00:00.000Z',
};
describe('receipts module', () => {
  let dir: string, db: Database, clock: TestClock;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jm-receipts-'));
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
    await db.run(() =>
      db
        .prepare(
          "INSERT INTO members(server_id,conversation_id,user_id) VALUES('dev-a',1,1)",
        )
        .run(),
    );
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const make = (fail = false) => {
    const access: ConversationAccess = {
      async requireMember() {},
      recheckMember(tx) {
        tx.assertActive();
      },
      async canAccess() {
        return true;
      },
    };
    const activity: ConversationActivity = {
      recordMessage() {},
      memberIds() {
        return ['1' as RequestContext['userId']];
      },
    };
    return createReceiptsService({
      db,
      clock,
      access,
      activity,
      validateMessage(_tx: TxContext, _ctx, conversationId, messageId) {
        if (fail) throw new Error('message lookup failed');
        return {
          id: messageId as never,
          conversationId: conversationId as never,
          senderId: '1' as never,
          clientMessageId: context.requestId,
          text: 'x',
          contentExpired: false,
          fileIds: [],
          createdAt: clock.now().toISOString(),
        };
      },
    });
  };
  it('advances only forward and commits one outbox reference with the read position', async () => {
    const service = make();
    expect(await service.advance(context, '1' as never, '12' as never)).toEqual(
      { lastReadMessageId: '12', advanced: true },
    );
    expect(await service.advance(context, '1' as never, '3' as never)).toEqual({
      lastReadMessageId: '12',
      advanced: false,
    });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM event_outbox').get(),
    ).toMatchObject({ n: 1n });
    expect(
      (await service.get(context, '1' as never))[0]?.lastReadMessageId,
    ).toBe('12');
  });
  it('rolls back both cursor and event when message owner validation fails', async () => {
    const service = make(true);
    await expect(
      service.advance(context, '1' as never, '1' as never),
    ).rejects.toThrow('message lookup failed');
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM read_cursors').get(),
    ).toMatchObject({ n: 0n });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM event_outbox').get(),
    ).toMatchObject({ n: 0n });
  });
});
