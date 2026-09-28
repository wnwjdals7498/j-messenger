import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDom, tick, settle, keydown } from './helpers/dom.ts';

// This import will fail because we do not create src/ui/message-list.ts yet.
// That's expected for this test task.
import { renderMessageList } from '../src/ui/message-list.ts';

const TZ = 'Asia/Seoul';

const u1 = { id: 'u1', serverId: 's', username: 'a', displayName: '앨리스' };
const u2 = { id: 'u2', serverId: 's', username: 'b', displayName: '밥' };
const users = [u1, u2];

const m1 = { id: 'm1', conversationId: 'c', senderId: 'u1', clientMessageId: 'k1', text: '안녕', createdAt: '2026-09-22T01:00:00Z' };
const m2 = { id: 'm2', conversationId: 'c', senderId: 'u2', clientMessageId: 'k2', text: '<b>굵게 아님</b>', createdAt: '2026-09-22T02:30:00Z' };
const m3 = { id: 'm3', conversationId: 'c', senderId: 'u9', clientMessageId: 'k3', text: '줄1\n줄2', createdAt: '2026-09-22T15:10:00Z' };
const msgs = [m1, m2, m3];

test('renders one article per message in order', () => {
  const { document, root } = createDom();
  renderMessageList(root, msgs, users, 'u1', TZ);
  const articles = root.querySelectorAll('article.message');
  assert.strictEqual(articles.length, 3);
  assert.deepEqual(Array.from(articles).map(a => a.getAttribute('data-id')), ['m1', 'm2', 'm3']);
});

test('inserts a date separator whenever the local date changes', () => {
  const { document, root } = createDom();
  renderMessageList(root, msgs, users, 'u1', TZ);
  const classes = Array.from(root.children).map(c => c.classList[0]);
  assert.deepEqual(classes, ['date-separator', 'message', 'message', 'date-separator', 'message']);
  const separators = root.querySelectorAll('.date-separator');
  assert.deepEqual(Array.from(separators).map(s => s.textContent), ['2026-09-22', '2026-09-23']);
});

test('shows sender name and local HH:mm time', () => {
  const { document, root } = createDom();
  renderMessageList(root, msgs, users, 'u1', TZ);
  const m1Article = root.querySelector('[data-id=\"m1\"]')!;
  const sender = m1Article.querySelector('.sender');
  assert.strictEqual(sender?.textContent, '앨리스');
  const timeEl = m1Article.querySelector('time');
  assert.ok(timeEl);
  assert.strictEqual(timeEl?.textContent, '10:00');
  assert.strictEqual(timeEl?.getAttribute('datetime'), '2026-09-22T01:00:00Z');
});

test('unknown sender falls back to the sender id', () => {
  const { document, root } = createDom();
  renderMessageList(root, msgs, users, 'u1', TZ);
  const m3Article = root.querySelector('[data-id=\"m3\"]')!;
  const sender = m3Article.querySelector('.sender');
  assert.strictEqual(sender?.textContent, 'u9');
});

test('marks my messages with is-mine', () => {
  const { document, root } = createDom();
  renderMessageList(root, msgs, users, 'u1', TZ);
  const m1Article = root.querySelector('[data-id=\"m1\"]')!;
  const m2Article = root.querySelector('[data-id=\"m2\"]')!;
  assert.ok(m1Article.classList.contains('is-mine'));
  assert.ok(!m2Article.classList.contains('is-mine'));
});

test('message text is not parsed as HTML and keeps newlines', () => {
  const { document, root } = createDom();
  renderMessageList(root, msgs, users, 'u1', TZ);
  const m2Article = root.querySelector('[data-id=\"m2\"]')!;
  const m2Text = m2Article.querySelector('.text');
  assert.strictEqual(m2Text?.textContent, '<b>굵게 아님</b>');
  assert.strictEqual(root.querySelector('b'), null);
  const m3Article = root.querySelector('[data-id=\"m3\"]')!;
  const m3Text = m3Article.querySelector('.text');
  assert.strictEqual(m3Text?.textContent, '줄1\n줄2');
});

test('an empty list shows a message', () => {
  const { document, root } = createDom();
  renderMessageList(root, [], users, 'u1', TZ);
  const p = root.querySelector('p.empty');
  assert.ok(p);
  assert.strictEqual(p.textContent, '메시지가 없습니다');
});

test('rendering again replaces the previous content', () => {
  const { document, root } = createDom();
  renderMessageList(root, msgs, users, 'u1', TZ);
  renderMessageList(root, msgs, users, 'u1', TZ);
  const articles = root.querySelectorAll('article.message');
  assert.strictEqual(articles.length, 3);
});
