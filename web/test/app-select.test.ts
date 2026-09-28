import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDom, tick, settle, keydown } from './helpers/dom.ts';
import { startApp } from '../src/app.ts';
import { createDemoApi } from '../src/demo/demo-api.ts';
import { startDemo, login, startAndLogin, sidebarIds, messageIds } from './helpers/app.ts';
import { DEMO_MESSAGES } from '../src/demo/demo-data.ts';

test('selecting a conversation shows only its messages', async () => {
  const { root } = await startAndLogin('alice');
  const cTeamBtn = root.querySelector('.sidebar button.conversation[data-id=\"c-team\"]')!;
  cTeamBtn.click();
  await settle();

  assert.strictEqual(root.querySelector('.app')?.getAttribute('data-pane'), 'chat');
  assert.strictEqual(root.querySelector('.chat-title')?.textContent, '팀 채널');
  assert.deepEqual(messageIds(root), ['m-3', 'm-5', 'm-7']);
});

test('the selected conversation is marked in the sidebar', async () => {
  const { root } = await startAndLogin('alice');
  const cTeamBtn = root.querySelector('.sidebar button.conversation[data-id=\"c-team\"]')!;
  cTeamBtn.click();
  await settle();

  const cTeamSelected = root.querySelector('.sidebar button.conversation[data-id=\"c-team\"]')!;
  const cAliceBobBtn = root.querySelector('.sidebar button.conversation[data-id=\"c-alice-bob\"]')!;
  assert.strictEqual(cTeamSelected.getAttribute('aria-current'), 'true');
  assert.ok(cTeamSelected.classList.contains('is-selected'));
  assert.strictEqual(cAliceBobBtn.getAttribute('aria-current'), null);
  assert.ok(!cAliceBobBtn.classList.contains('is-selected'));
});

test('switching conversations replaces the messages', async () => {
  const { root } = await startAndLogin('alice');
  const cTeamBtn = root.querySelector('.sidebar button.conversation[data-id=\"c-team\"]')!;
  cTeamBtn.click();
  await settle();
  assert.deepEqual(messageIds(root), ['m-3', 'm-5', 'm-7']);

  const cAliceBobBtn = root.querySelector('.sidebar button.conversation[data-id=\"c-alice-bob\"]')!;
  cAliceBobBtn.click();
  await settle();
  assert.deepEqual(messageIds(root), ['m-1', 'm-2']);
  assert.strictEqual(root.querySelector('.chat-title')?.textContent, '앨리스, 밥');
});

test('the back button returns to the list pane', async () => {
  const { root } = await startAndLogin('alice');
  const cTeamBtn = root.querySelector('.sidebar button.conversation[data-id=\"c-team\"]')!;
  cTeamBtn.click();
  await settle();
  assert.strictEqual(root.querySelector('.app')?.getAttribute('data-pane'), 'chat');

  const backBtn = root.querySelector('.chat-header .back')!;
  backBtn.click();
  await settle();
  assert.strictEqual(root.querySelector('.app')?.getAttribute('data-pane'), 'list');
});

test('my messages are marked', async () => {
  const { root } = await startAndLogin('alice');
  const cTeamBtn = root.querySelector('.sidebar button.conversation[data-id=\"c-team\"]')!;
  cTeamBtn.click();
  await settle();

  const m7 = root.querySelector('[data-id=\"m-7\"]')!;
  const m3 = root.querySelector('[data-id=\"m-3\"]')!;
  assert.ok(m7.classList.contains('is-mine'));
  assert.ok(!m3.classList.contains('is-mine'));
});
