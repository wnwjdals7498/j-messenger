import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDom, tick, settle, keydown } from './helpers/dom.ts';
import { mountLogin } from '../src/ui/login.ts';

const servers = [
  { id: 'mail-a', name: 'A사 메일' },
  { id: 'mail-b', name: 'B사 메일' }
];
const user = { id: 'u-alice', serverId: 'mail-a', username: 'alice', displayName: '앨리스' };

function setup(demo: boolean, onSubmit: (input: { serverId: string; username: string; password: string }) => Promise<{ ok: true; value: typeof user } | { ok: false; error: string }>, onSuccess: (user: typeof user) => void) {
  const dom = createDom();
  mountLogin(dom.root, servers, onSubmit, onSuccess, { demo });
  const form = dom.root.querySelector('form.login')!;
  return {
    ...dom,
    form,
    select: form.querySelector('select[name=\"serverId\"]')!,
    username: form.querySelector('input[name=\"username\"]')!,
    password: form.querySelector('input[name=\"password\"]')!,
    button: form.querySelector('button[type=\"submit\"]')!,
    error: form.querySelector('.login-error')!
  };
}

test('renders server choice, username, password and submit', () => {
  const { select, username, password, button, error } = setup(true, async () => ({ ok: true, value: user }), () => {});
  const options = Array.from(select.querySelectorAll('option'));
  assert.deepEqual(options.map(o => o.value), ['', 'mail-a', 'mail-b']);
  assert.deepEqual(options.map(o => o.textContent), ['선택하세요', 'A사 메일', 'B사 메일']);
  assert.strictEqual(username.getAttribute('autocomplete'), 'username');
  assert.strictEqual(password.getAttribute('type'), 'password');
  assert.strictEqual(password.getAttribute('autocomplete'), 'current-password');
  assert.strictEqual(button.textContent, '로그인');
  assert.strictEqual(error.getAttribute('role'), 'alert');
});

test('demo notice appears only in demo mode', () => {
  const { root } = setup(true, async () => ({ ok: true, value: user }), () => {});
  const notice = root.querySelector('.demo-notice');
  assert.ok(notice);
  assert.ok(notice.textContent?.includes('데모'));

  const dom2 = createDom();
  mountLogin(dom2.root, servers, async () => ({ ok: true, value: user }), () => {}, { demo: false });
  assert.strictEqual(dom2.root.querySelector('.demo-notice'), null);
});

test('validation errors are shown in order and nothing is submitted', async () => {
  let submitCalled = false;
  const { select, username, password, button, error } = setup(true, async (input) => {
    submitCalled = true;
    return { ok: true, value: user };
  }, () => {});

  // All empty
  button.click();
  await settle();
  assert.strictEqual(error.textContent, '메일 서버를 선택하세요');
  assert.strictEqual(submitCalled, false);

  // Server selected, username empty
  select.value = 'mail-a';
  button.click();
  await settle();
  assert.strictEqual(error.textContent, '아이디를 입력하세요');
  assert.strictEqual(submitCalled, false);

  // Username filled, password empty
  username.value = 'alice';
  button.click();
  await settle();
  assert.strictEqual(error.textContent, '비밀번호를 입력하세요');
  assert.strictEqual(submitCalled, false);
});

test('valid input submits a trimmed username and calls onSuccess', async () => {
  let submitInput: { serverId: string; username: string; password: string } | null = null;
  let successUser: typeof user | null = null;
  const { select, username, password, button } = setup(true, async (input) => {
    submitInput = input;
    return { ok: true, value: user };
  }, (u) => { successUser = u; });

  select.value = 'mail-a';
  username.value = ' alice ';
  password.value = 'pw';
  button.click();
  await settle();

  assert.deepEqual(submitInput, { serverId: 'mail-a', username: 'alice', password: 'pw' });
  assert.deepEqual(successUser, user);
});

test('invalid credentials show a message and clear the password', async () => {
  let successCalled = false;
  const { select, username, password, button, error } = setup(true, async () => ({ ok: false, error: 'invalid_credentials' }), () => { successCalled = true; });

  select.value = 'mail-a';
  username.value = 'alice';
  password.value = 'pw';
  button.click();
  await settle();

  assert.strictEqual(error.textContent, '아이디 또는 비밀번호가 올바르지 않습니다');
  assert.strictEqual(password.value, '');
  assert.strictEqual(username.value, 'alice');
  assert.strictEqual(successCalled, false);
});

test('other failures show a generic message', async () => {
  let successCalled = false;
  const { select, username, password, button, error } = setup(true, async () => ({ ok: false, error: 'boom' }), () => { successCalled = true; });

  select.value = 'mail-a';
  username.value = 'alice';
  password.value = 'pw';
  button.click();
  await settle();

  assert.strictEqual(error.textContent, '로그인하지 못했습니다');
  assert.strictEqual(successCalled, false);

  // New dom with rejecting onSubmit
  const dom2 = createDom();
  mountLogin(dom2.root, servers, async () => { throw new Error('x'); }, () => {}, { demo: true });
  const form2 = dom2.root.querySelector('form.login')!;
  const select2 = form2.querySelector('select[name=\"serverId\"]')!;
  const username2 = form2.querySelector('input[name=\"username\"]')!;
  const password2 = form2.querySelector('input[name=\"password\"]')!;
  const button2 = form2.querySelector('button[type=\"submit\"]')!;
  const error2 = form2.querySelector('.login-error')!;

  select2.value = 'mail-a';
  username2.value = 'alice';
  password2.value = 'pw';
  button2.click();
  await settle();
  assert.strictEqual(error2.textContent, '로그인하지 못했습니다');
});

test('the button is disabled while submitting', async () => {
  let resolve: (v: { ok: true; value: typeof user }) => void;
  const pending = new Promise<{ ok: true; value: typeof user }>(r => { resolve = r; });
  const { select, username, password, button } = setup(true, async () => pending, () => {});

  select.value = 'mail-a';
  username.value = 'alice';
  password.value = 'pw';
  button.click();
  await settle();

  assert.strictEqual(button.disabled, true);

  resolve!({ ok: true, value: user });
  await settle();

  assert.strictEqual(button.disabled, false);
});
