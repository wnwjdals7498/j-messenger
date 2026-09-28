import { test } from 'node:test';
import assert from 'node:assert/strict';

// This import will fail because we do not create src/demo/demo-api.ts yet.
// That's expected for this test task.
import { createDemoApi } from '../src/demo/demo-api.ts';

const now = () => new Date('2026-09-23T06:00:00Z');

async function loggedIn(username: string, serverId = 'mail-a') {
  const api = createDemoApi({ now });
  const r = await api.login({ serverId, username, password: 'pw' });
  assert.equal(r.ok, true);
  return api;
}

test('listServers returns both demo servers', async () => {
  const api = createDemoApi({ now });
  const servers = await api.listServers();
  assert.deepEqual(servers.map(s => s.id), ['mail-a', 'mail-b']);
});

test('login rejects unknown user, wrong server and empty password', async () => {
  const api = createDemoApi({ now });
  
  let r = await api.login({ serverId: 'mail-a', username: 'nobody', password: 'x' });
  assert.deepEqual(r, { ok: false, error: 'invalid_credentials' });
  
  r = await api.login({ serverId: 'mail-a', username: 'dave', password: 'x' });
  assert.deepEqual(r, { ok: false, error: 'invalid_credentials' });
  
  r = await api.login({ serverId: 'mail-a', username: 'alice', password: '' });
  assert.deepEqual(r, { ok: false, error: 'invalid_credentials' });
});

test('login returns the matching user', async () => {
  const api = createDemoApi({ now });
  const r = await api.login({ serverId: 'mail-a', username: 'alice', password: 'x' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.strictEqual(r.value.id, 'u-alice');
    assert.strictEqual(r.value.displayName, '앨리스');
  }
});

test('list methods require login', async () => {
  const api = createDemoApi({ now });
  
  await assert.rejects(api.listUsers(), /not_logged_in/);
  await assert.rejects(api.listConversations(), /not_logged_in/);
  await assert.rejects(api.listMessages('c-team'), /not_logged_in/);
  
  const r = await api.sendMessage('c-team', 'hi', 'k');
  assert.deepEqual(r, { ok: false, error: 'not_logged_in' });
});

test('listUsers returns only users of the same server', async () => {
  let api = await loggedIn('alice');
  let users = await api.listUsers();
  assert.deepEqual(users.map(u => u.id), ['u-alice', 'u-bob', 'u-carol']);
  
  api = await loggedIn('dave', 'mail-b');
  users = await api.listUsers();
  assert.deepEqual(users.map(u => u.id), ['u-dave', 'u-erin']);
});

test('listConversations returns member conversations newest first', async () => {
  let api = await loggedIn('alice');
  let convs = await api.listConversations();
  assert.deepEqual(convs.map(c => c.id), ['c-team', 'c-alice-bob']);
  
  api = await loggedIn('carol');
  convs = await api.listConversations();
  assert.deepEqual(convs.map(c => c.id), ['c-team']);
  
  api = await loggedIn('dave', 'mail-b');
  convs = await api.listConversations();
  assert.deepEqual(convs.map(c => c.id), ['c-b-chat']);
});

test('listMessages returns oldest first and hides other conversations', async () => {
  const api = await loggedIn('alice');
  
  let msgs = await api.listMessages('c-team');
  assert.deepEqual(msgs.map(m => m.id), ['m-3', 'm-5', 'm-7']);
  
  await assert.rejects(api.listMessages('c-b-chat'), /not_found/);
  await assert.rejects(api.listMessages('nope'), /not_found/);
});

test('sendMessage stores a trimmed message with backend time', async () => {
  const api = await loggedIn('alice');
  
  const r = await api.sendMessage('c-alice-bob', '  hello  ', 'k-new');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.value, {
      id: 'm-8',
      conversationId: 'c-alice-bob',
      senderId: 'u-alice',
      clientMessageId: 'k-new',
      text: 'hello',
      createdAt: '2026-09-23T06:00:00.000Z'
    });
  }
  
  const msgs = await api.listMessages('c-alice-bob');
  assert.deepEqual(msgs.map(m => m.id), ['m-1', 'm-2', 'm-8']);
  
  const convs = await api.listConversations();
  assert.deepEqual(convs.map(c => c.id), ['c-alice-bob', 'c-team']);
  assert.strictEqual(convs[0].lastMessageAt, '2026-09-23T06:00:00.000Z');
});

test('sendMessage validates text', async () => {
  const api = await loggedIn('alice');
  
  let r = await api.sendMessage('c-team', '   ', 'k');
  assert.deepEqual(r, { ok: false, error: 'empty' });
  
  r = await api.sendMessage('c-team', 'x'.repeat(4001), 'k');
  assert.deepEqual(r, { ok: false, error: 'too_long' });
});

test('sendMessage returns the existing message for a repeated clientMessageId', async () => {
  const api = await loggedIn('alice');
  
  const r1 = await api.sendMessage('c-team', 'a', 'k-dup');
  const r2 = await api.sendMessage('c-team', 'a', 'k-dup');
  
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  if (r1.ok && r2.ok) {
    assert.strictEqual(r1.value.id, r2.value.id);
  }
  
  const msgs = await api.listMessages('c-team');
  assert.strictEqual(msgs.length, 4);
});

test('sendMessage rejects conversations the user is not in', async () => {
  const api = await loggedIn('alice');
  const r = await api.sendMessage('c-b-chat', 'x', 'k');
  assert.deepEqual(r, { ok: false, error: 'not_found' });
});

test('logout ends the session', async () => {
  const api = await loggedIn('alice');
  await api.logout();
  await assert.rejects(api.listConversations(), /not_logged_in/);
});

test('each api instance has its own copy of the data', async () => {
  const api1 = await loggedIn('alice');
  await api1.sendMessage('c-team', 'only here', 'k-unique');
  
  const api2 = await loggedIn('alice');
  const msgs = await api2.listMessages('c-team');
  assert.strictEqual(msgs.length, 3);
});

test('returned objects are copies', async () => {
  const api = await loggedIn('alice');
  const convs = await api.listConversations();
  convs[0].title = 'changed';
  
  const convs2 = await api.listConversations();
  assert.strictEqual(convs2[0].title, '팀 채널');
});
