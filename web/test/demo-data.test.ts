import { test } from 'node:test';
import assert from 'node:assert/strict';

// This import will fail because we do not create src/demo/demo-data.ts yet.
// That's expected for this test task.
import { DEMO_SERVERS, DEMO_USERS, DEMO_CONVERSATIONS, DEMO_MESSAGES } from '../src/demo/demo-data.ts';
import { MESSAGE_MAX_LENGTH } from '../src/types.ts';

const seoulDate = (iso: string) => new Date(Date.parse(iso) + 9 * 3600 * 1000).toISOString().slice(0, 10);

test('servers are mail-a and mail-b', () => {
  assert.deepEqual(DEMO_SERVERS.map(s => s.id), ['mail-a', 'mail-b']);
  assert.deepEqual(DEMO_SERVERS.map(s => s.name), ['A사 메일', 'B사 메일']);
});

test('users are the fixed demo accounts', () => {
  assert.deepEqual(DEMO_USERS.map(u => [u.id, u.serverId, u.username, u.displayName]), [
    ['u-alice', 'mail-a', 'alice', '앨리스'],
    ['u-bob', 'mail-a', 'bob', '밥'],
    ['u-carol', 'mail-a', 'carol', '캐럴'],
    ['u-dave', 'mail-b', 'dave', '데이브'],
    ['u-erin', 'mail-b', 'erin', '에린'],
  ]);
});

test('conversations are the fixed demo conversations', () => {
  assert.deepEqual(DEMO_CONVERSATIONS.map(c => [c.id, c.serverId, c.title, c.memberIds]), [
    ['c-alice-bob', 'mail-a', '앨리스, 밥', ['u-alice', 'u-bob']],
    ['c-team', 'mail-a', '팀 채널', ['u-alice', 'u-bob', 'u-carol']],
    ['c-b-chat', 'mail-b', '데이브, 에린', ['u-dave', 'u-erin']],
  ]);
});

test('every member belongs to the conversation server', () => {
  const usersById = new Map(DEMO_USERS.map(u => [u.id, u]));
  for (const c of DEMO_CONVERSATIONS) {
    for (const memberId of c.memberIds) {
      const user = usersById.get(memberId);
      assert.ok(user, 'User ' + memberId + ' not found');
      assert.strictEqual(user.serverId, c.serverId);
    }
  }
});

test('messages reference existing conversations and member senders', () => {
  const convIds = new Set(DEMO_CONVERSATIONS.map(c => c.id));
  const usersById = new Map(DEMO_USERS.map(u => [u.id, u]));
  for (const m of DEMO_MESSAGES) {
    assert.ok(convIds.has(m.conversationId), 'Conversation ' + m.conversationId + ' not found');
    const user = usersById.get(m.senderId);
    assert.ok(user, 'User ' + m.senderId + ' not found');
    const conv = DEMO_CONVERSATIONS.find(c => c.id === m.conversationId);
    assert.ok(conv?.memberIds.includes(m.senderId), 'Sender ' + m.senderId + ' not member of ' + m.conversationId);
  }
});

test('messages are unique, valid and sorted oldest first', () => {
  assert.strictEqual(DEMO_MESSAGES.length, 7);
  const ids = new Set(DEMO_MESSAGES.map(m => m.id));
  assert.strictEqual(ids.size, DEMO_MESSAGES.length);
  const dateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  for (const m of DEMO_MESSAGES) {
    assert.match(m.createdAt, dateRegex);
    assert.ok(m.createdAt < '2026-09-23T00:00:00Z');
    assert.ok(m.text.length > 0 && m.text.length <= MESSAGE_MAX_LENGTH);
  }
  for (let i = 1; i < DEMO_MESSAGES.length; i++) {
    assert.ok(DEMO_MESSAGES[i-1].createdAt <= DEMO_MESSAGES[i].createdAt);
  }
  const clientKeys = new Set(DEMO_MESSAGES.map(m => m.senderId + ':' + m.clientMessageId));
  assert.strictEqual(clientKeys.size, DEMO_MESSAGES.length);
});

test('lastMessageAt equals the newest message of each conversation', () => {
  for (const c of DEMO_CONVERSATIONS) {
    const msgs = DEMO_MESSAGES.filter(m => m.conversationId === c.id);
    const maxCreated = msgs.reduce((max, m) => m.createdAt > max ? m.createdAt : max, '');
    assert.strictEqual(c.lastMessageAt, maxCreated);
  }
});

test('team conversation spans two Seoul dates and contains HTML-like text', () => {
  const teamMsgs = DEMO_MESSAGES.filter(m => m.conversationId === 'c-team');
  const dates = new Set(teamMsgs.map(m => seoulDate(m.createdAt)));
  assert.strictEqual(dates.size, 2);
  assert.ok(teamMsgs.some(m => m.text.includes('<b>')));
});

test('team conversation is the newest on mail-a', () => {
  const teamConv = DEMO_CONVERSATIONS.find(c => c.id === 'c-team')!;
  const aliceBobConv = DEMO_CONVERSATIONS.find(c => c.id === 'c-alice-bob')!;
  assert.ok(teamConv.lastMessageAt > aliceBobConv.lastMessageAt);
});
