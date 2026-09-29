import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDom, tick, settle, keydown } from './helpers/dom.ts';
import { mountComposer } from '../src/ui/composer.ts';

function setup(onSend: (text: string) => Promise<boolean>) {
  const dom = createDom();
  mountComposer(dom.root, onSend);
  const form = dom.root.querySelector('form.composer')!;
  return {
    ...dom,
    form,
    textarea: form.querySelector('textarea[name="text"]')!,
    button: form.querySelector('button[type="submit"]')!,
    error: form.querySelector('.composer-error')!
  };
}

test('renders textarea, send button and error area', () => {
  const calls: string[] = [];
  const { textarea, button, error } = setup(async (t) => { calls.push(t); return true; });
  assert.strictEqual(textarea.getAttribute('maxlength'), '4000');
  assert.strictEqual(textarea.getAttribute('aria-label'), '메시지 입력');
  assert.strictEqual(button.textContent, '보내기');
  assert.ok(error);
  assert.strictEqual(error.getAttribute('aria-live'), 'polite');
});

test('clicking send sends trimmed text and clears the box', async () => {
  const calls: string[] = [];
  const { textarea, button } = setup(async (t) => { calls.push(t); return true; });
  textarea.value = '  안녕  ';
  button.click();
  await settle();
  assert.deepEqual(calls, ['안녕']);
  assert.strictEqual(textarea.value, '');
});

test('Enter sends and Shift+Enter does not', async () => {
  const calls: string[] = [];
  const { window, textarea } = setup(async (t) => { calls.push(t); return true; });
  textarea.value = 'a';
  const shifted = keydown(window, textarea, { key: 'Enter', shiftKey: true });
  await settle();
  assert.deepEqual(calls, []);
  assert.equal(shifted.defaultPrevented, false);
  const ev = keydown(window, textarea, { key: 'Enter' });
  await settle();
  assert.deepEqual(calls, ['a']);
  assert.equal(ev.defaultPrevented, true);
});

test('Enter while composing Korean text does not send', async () => {
  const calls: string[] = [];
  const { window, textarea } = setup(async (t) => { calls.push(t); return true; });
  textarea.value = '가';
  keydown(window, textarea, { key: 'Enter', isComposing: true });
  await settle();
  assert.deepEqual(calls, []);
});

test('empty text shows an error and does not send', async () => {
  const calls: string[] = [];
  const { textarea, button, error } = setup(async (t) => { calls.push(t); return true; });
  textarea.value = '   ';
  button.click();
  await settle();
  assert.deepEqual(calls, []);
  assert.strictEqual(error.textContent, '메시지를 입력하세요');
});

test('too long text shows an error and does not send', async () => {
  const calls: string[] = [];
  const { textarea, button, error } = setup(async (t) => { calls.push(t); return true; });
  textarea.value = 'x'.repeat(4001);
  button.click();
  await settle();
  assert.deepEqual(calls, []);
  assert.strictEqual(error.textContent, '4000자 이하로 입력하세요');
});

test('ignores new submits while a send is pending', async () => {
  const calls: string[] = [];
  let resolve: (v: boolean) => void;
  const pending = new Promise<boolean>(r => { resolve = r; });
  const { window, textarea, button } = setup(async (t) => { calls.push(t); return pending; });
  textarea.value = 'a';
  button.click();
  button.click();
  keydown(window, textarea, { key: 'Enter' });
  await settle();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(button.disabled, true);
  resolve!(true);
  await settle();
  assert.strictEqual(button.disabled, false);
  assert.strictEqual(textarea.value, '');
});

test('a failed send keeps the text and shows an error', async () => {
  const calls: string[] = [];
  const { textarea, button, error } = setup(async (t) => { calls.push(t); return false; });
  textarea.value = 'a';
  button.click();
  await settle();
  assert.strictEqual(textarea.value, 'a');
  assert.strictEqual(error.textContent, '전송하지 못했습니다');
  assert.strictEqual(button.disabled, false);
});

test('a rejected send behaves like a failed send', async () => {
  const calls: string[] = [];
  const { textarea, button, error } = setup(async (t) => { calls.push(t); return Promise.reject(new Error('x')); });
  textarea.value = 'a';
  button.click();
  await settle();
  assert.strictEqual(textarea.value, 'a');
  assert.strictEqual(error.textContent, '전송하지 못했습니다');
  assert.strictEqual(button.disabled, false);
});

test('a successful send clears an earlier error', async () => {
  const calls: string[] = [];
  const { textarea, button, error } = setup(async (t) => { calls.push(t); return true; });
  textarea.value = '   ';
  button.click();
  await settle();
  assert.strictEqual(error.textContent, '메시지를 입력하세요');
  textarea.value = 'b';
  button.click();
  await settle();
  assert.strictEqual(error.textContent, '');
});
