import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDom, tick, settle, keydown } from './helpers/dom.ts';
import { renderSidebar } from '../src/ui/sidebar.ts';

const convs = [
  { id: 'c1', serverId: 's', title: '첫 대화', memberIds: ['a', 'b'], lastMessageAt: null },
  { id: 'c2', serverId: 's', title: '<i>둘</i>', memberIds: ['a', 'b'], lastMessageAt: null },
  { id: 'c3', serverId: 's', title: '셋', memberIds: ['a', 'b'], lastMessageAt: null },
];

test('renders one button per conversation inside a list', () => {
  const { window, document, root } = createDom();
  renderSidebar(root, convs, null, () => {});
  const buttons = root.querySelectorAll('ul.conversation-list > li > button.conversation');
  assert.strictEqual(buttons.length, 3);
  assert.deepEqual(Array.from(buttons).map(b => b.getAttribute('data-id')), ['c1', 'c2', 'c3']);
  assert.deepEqual(Array.from(buttons).map(b => b.textContent), ['첫 대화', '<i>둘</i>', '셋']);
  assert.strictEqual(root.querySelector('i'), null);
  for (const b of buttons) assert.strictEqual(b.getAttribute('type'), 'button');
});

test('marks only the selected conversation', () => {
  const { window, document, root } = createDom();
  renderSidebar(root, convs, 'c2', () => {});
  const b1 = root.querySelector('[data-id="c1"]');
  const b2 = root.querySelector('[data-id="c2"]');
  const b3 = root.querySelector('[data-id="c3"]');
  assert.strictEqual(b1?.getAttribute('aria-current'), null);
  assert.ok(!b1?.classList.contains('is-selected'));
  assert.strictEqual(b2?.getAttribute('aria-current'), 'true');
  assert.ok(b2?.classList.contains('is-selected'));
  assert.strictEqual(b3?.getAttribute('aria-current'), null);
  assert.ok(!b3?.classList.contains('is-selected'));
});

test('clicking a conversation calls onSelect with its id', () => {
  const { window, document, root } = createDom();
  const selected: string[] = [];
  renderSidebar(root, convs, null, (id) => selected.push(id));
  (root.querySelector('button[data-id="c3"]') as HTMLButtonElement).click();
  assert.deepEqual(selected, ['c3']);
});

test('rendering again replaces the previous list', () => {
  const { window, document, root } = createDom();
  renderSidebar(root, convs, null, () => {});
  renderSidebar(root, convs, null, () => {});
  const uls = root.querySelectorAll('ul.conversation-list');
  assert.strictEqual(uls.length, 1);
  const buttons = root.querySelectorAll('ul.conversation-list > li > button.conversation');
  assert.strictEqual(buttons.length, 3);
});

test('an empty list shows a message', () => {
  const { window, document, root } = createDom();
  renderSidebar(root, [], null, () => {});
  const p = root.querySelector('p.empty');
  assert.ok(p);
  assert.strictEqual(p.textContent, '대화가 없습니다');
  assert.strictEqual(root.querySelector('ul'), null);
});

test('arrow keys move focus between conversations', () => {
  const { window, document, root } = createDom();
  renderSidebar(root, convs, null, () => {});
  const buttons = Array.from(root.querySelectorAll('ul.conversation-list > li > button.conversation')) as HTMLButtonElement[];
  buttons[0].focus();
  keydown(window, buttons[0], { key: 'ArrowDown' });
  assert.strictEqual(document.activeElement, buttons[1]);
  keydown(window, buttons[1], { key: 'ArrowUp' });
  assert.strictEqual(document.activeElement, buttons[0]);
  keydown(window, buttons[0], { key: 'ArrowUp' });
  assert.strictEqual(document.activeElement, buttons[0]);
  buttons[2].focus();
  keydown(window, buttons[2], { key: 'ArrowDown' });
  assert.strictEqual(document.activeElement, buttons[2]);
});
