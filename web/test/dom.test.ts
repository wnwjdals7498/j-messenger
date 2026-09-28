import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDom, tick, settle, keydown } from './helpers/dom.ts';

// This import will fail because we do not create src/ui/dom.ts yet.
// That's expected for this test task.
import { el, clear } from '../src/ui/dom.ts';

test('el creates an element with class, text and attributes', () => {
  const { document } = createDom();
  const b = el(document, 'button', { className: 'x y', text: '<b>hi</b>', attrs: { type: 'button', 'data-id': 'c1' } });
  assert.strictEqual(b.tagName, 'BUTTON');
  assert.strictEqual(b.className, 'x y');
  assert.strictEqual(b.textContent, '<b>hi</b>');
  assert.strictEqual(b.querySelector('b'), null);
  assert.strictEqual(b.getAttribute('type'), 'button');
  assert.strictEqual(b.getAttribute('data-id'), 'c1');
});

test('el appends children in order', () => {
  const { document } = createDom();
  const ul = el(document, 'ul', {}, [
    el(document, 'li', { text: '1' }),
    el(document, 'li', { text: '2' })
  ]);
  assert.strictEqual(ul.children.length, 2);
  assert.strictEqual(ul.children[0].textContent, '1');
  assert.strictEqual(ul.children[1].textContent, '2');
});

test('el works without props', () => {
  const { document } = createDom();
  const div = el(document, 'div');
  assert.strictEqual(div.className, '');
  assert.strictEqual(div.childNodes.length, 0);
});

test('clear removes every child', () => {
  const { document } = createDom();
  const div = document.createElement('div');
  div.appendChild(document.createElement('span'));
  div.appendChild(document.createTextNode('text'));
  div.appendChild(document.createElement('em'));
  clear(div);
  assert.strictEqual(div.childNodes.length, 0);
});
