import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDom, tick, settle } from './helpers/dom.ts';
import { startApp } from '../src/app.ts';
import { createDemoApi } from '../src/demo/demo-api.ts';
import { startDemo, login, startAndLogin, sidebarIds, messageIds } from './helpers/app.ts';

test('shows the login form first', async () => {
  const { root, api } = await startDemo();
  assert.strictEqual(root.dataset.view, 'login');
  const form = root.querySelector('form.login');
  assert.ok(form);
  const options = Array.from(form!.querySelectorAll('option')).map(o => o.value);
  assert.ok(options.includes('mail-a'));
  assert.ok(options.includes('mail-b'));
  assert.ok(root.querySelector('.demo-notice'));
});

test('alice sees the main layout with her conversations', async () => {
  const { root } = await startAndLogin('alice');
  assert.strictEqual(root.dataset.view, 'main');
  assert.strictEqual(root.querySelector('.app')?.getAttribute('data-pane'), 'list');
  assert.strictEqual(root.querySelector('.sidebar .me')?.textContent, '앨리스');
  assert.deepEqual(sidebarIds(root), ['c-team', 'c-alice-bob']);
  assert.strictEqual(root.querySelector('.messages p.empty')?.textContent, '대화를 선택하세요');
  assert.ok(root.querySelector('form.composer'));
  assert.strictEqual(root.querySelector('.chat-title')?.textContent, '');
});

test('dave sees only mail-b conversations', async () => {
  const { root } = await startAndLogin('dave', 'mail-b');
  assert.deepEqual(sidebarIds(root), ['c-b-chat']);
});

test('unknown user stays on the login form with an error', async () => {
  const { root } = await startDemo();
  await login(root, 'nobody');
  assert.strictEqual(root.dataset.view, 'login');
  assert.strictEqual(root.querySelector('.login-error')?.textContent, '아이디 또는 비밀번호가 올바르지 않습니다');
  assert.strictEqual(root.querySelector('.app'), null);
});
