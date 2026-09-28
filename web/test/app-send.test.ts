import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDom, tick, settle, keydown } from './helpers/dom.ts';
import { startApp } from '../src/app.ts';
import { createDemoApi } from '../src/demo/demo-api.ts';
import { startDemo, login, startAndLogin, sidebarIds, messageIds } from './helpers/app.ts';

test('sending adds my message to the open conversation', async () => {
  const { root } = await startAndLogin('alice');
  const cTeamBtn = root.querySelector('.sidebar button.conversation[data-id=\"c-team\"]')!;
  cTeamBtn.click();
  await settle();

  const form = root.querySelector('form.composer')!;
  const textarea = form.querySelector('textarea[name=\"text\"]')!;
  const submitBtn = form.querySelector('button[type=\"submit\"]')!;
  textarea.value = '앱 테스트';
  submitBtn.click();
  await settle();

  const messages = root.querySelectorAll('.messages article.message');
  const lastMsg = messages[messages.length - 1];
  assert.ok(lastMsg.textContent?.includes('앱 테스트'));
  assert.ok(lastMsg.classList.contains('is-mine'));
  assert.strictEqual(textarea.value, '');
  assert.strictEqual(messageIds(root).length, 4);
});

test('the conversation I wrote to moves to the top and stays selected', async () => {
  const { root } = await startAndLogin('alice');
  const cAliceBobBtn = root.querySelector('.sidebar button.conversation[data-id=\"c-alice-bob\"]')!;
  cAliceBobBtn.click();
  await settle();

  const form = root.querySelector('form.composer')!;
  const textarea = form.querySelector('textarea[name=\"text\"]')!;
  const submitBtn = form.querySelector('button[type=\"submit\"]')!;
  textarea.value = '위로';
  submitBtn.click();
  await settle();

  assert.deepEqual(sidebarIds(root), ['c-alice-bob', 'c-team']);
  const cAliceBobBtn2 = root.querySelector('.sidebar button.conversation[data-id=\"c-alice-bob\"]')!;
  assert.strictEqual(cAliceBobBtn2.getAttribute('aria-current'), 'true');
});

test('sending without a selected conversation fails', async () => {
  const { root } = await startAndLogin('alice');
  // No conversation selected yet (list pane)
  const form = root.querySelector('form.composer')!;
  const textarea = form.querySelector('textarea[name=\"text\"]')!;
  const submitBtn = form.querySelector('button[type=\"submit\"]')!;
  textarea.value = 'x';
  submitBtn.click();
  await settle();

  const error = form.querySelector('.composer-error')!;
  assert.strictEqual(error.textContent, '전송하지 못했습니다');
  assert.strictEqual(messageIds(root).length, 0);
});

test('logout returns to the login form', async () => {
  const { root } = await startAndLogin('alice');
  const logoutBtn = root.querySelector('.sidebar .logout')!;
  logoutBtn.click();
  await settle();

  assert.strictEqual(root.dataset.view, 'login');
  assert.ok(root.querySelector('form.login'));
  assert.strictEqual(root.querySelector('.app'), null);
});

test('after logout another user can log in', async () => {
  const { root } = await startAndLogin('alice');
  const logoutBtn = root.querySelector('.sidebar .logout')!;
  logoutBtn.click();
  await settle();

  await login(root, 'carol');
  assert.deepEqual(sidebarIds(root), ['c-team']);
  assert.strictEqual(root.querySelector('.sidebar .me')?.textContent, '캐럴');
});
