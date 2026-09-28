import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDom, tick, settle, keydown } from './helpers/dom.ts';

test('createDom gives a connected root', () => {
  const { window, document, root } = createDom();
  assert.strictEqual(root.id, 'app');
  assert.strictEqual(root.parentElement, document.body);
});

test('textContent never parses HTML', () => {
  const { document } = createDom();
  const p = document.createElement('p');
  p.textContent = '<b>x</b>';
  assert.strictEqual(p.querySelector('b'), null);
  assert.strictEqual(p.textContent, '<b>x</b>');
});

test('keydown helper reports isComposing and preventDefault', () => {
  const { window, document, root } = createDom();
  let preventCalled = false;
  root.addEventListener('keydown', (event) => {
    event.preventDefault();
    preventCalled = true;
  });
  const ev = keydown(window, root, { key: 'Enter', isComposing: true });
  assert.strictEqual(ev.isComposing, true);
  assert.strictEqual(ev.defaultPrevented, true);
  assert.strictEqual(preventCalled, true);
});

