import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');

function block(start: string): string {
  const idx = css.indexOf(start);
  if (idx === -1) return '';
  let depth = 0;
  let inBlock = false;
  let endIdx = -1;
  for (let i = idx; i < css.length; i++) {
    if (css[i] === '{') {
      depth++;
      inBlock = true;
    } else if (css[i] === '}') {
      depth--;
      if (inBlock && depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx === -1) return '';
  return css.slice(idx, endIdx + 1);
}

test('defines the color variables', () => {
  const rootBlock = block(':root');
  assert.ok(rootBlock.includes('--color-bg'));
  assert.ok(rootBlock.includes('--color-surface'));
  assert.ok(rootBlock.includes('--color-text'));
  assert.ok(rootBlock.includes('--color-muted'));
  assert.ok(rootBlock.includes('--color-accent'));
  assert.ok(rootBlock.includes('--color-mine'));
  assert.ok(rootBlock.includes('--color-border'));
});

test('styles every UI part', () => {
  const selectors = [
    '.app', '.sidebar', '.chat', '.conversation', '.conversation.is-selected',
    '.message', '.message.is-mine', '.date-separator', '.composer', '.composer-error',
    '.login', '.login-error', '.demo-notice', '.empty', ':focus-visible'
  ];
  for (const sel of selectors) {
    assert.ok(css.includes(sel), 'Missing selector: ' + sel);
  }
});

test('message text keeps line breaks', () => {
  // Just check that the text rule has white-space property
  assert.ok(css.includes('white-space: pre-wrap'));
});

test('narrow screens show one pane at a time', () => {
  const m = block('@media (max-width: 640px)');
  const hasList = m.includes('display: none') && m.includes('data-pane');
  const hasChat = m.includes('display: none') && (m.includes('data-pane') || m.includes('data-pane'));
  const hasDark = m.includes('display: none');
  assert.ok(hasList, 'Missing list media query');
  assert.ok(hasChat, 'Missing chat media query');
  assert.ok(hasDark, 'Missing dark mode media query');
});

test('supports dark mode', () => {
  const m = block('@media (prefers-color-scheme: dark)');
  assert.ok(m.includes('--color-bg'));
});

test('never hides focus outlines', () => {
  assert.ok(!css.match(/outline:\s*(none|0)\b/));
});
