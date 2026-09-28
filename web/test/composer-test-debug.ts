import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDom, tick, settle, keydown } from './helpers/dom.ts';
import { mountComposer } from '../src/ui/composer.ts';

test('debug too long text', async () => {
  const calls: string[] = [];
  const dom = createDom();
  mountComposer(dom.root, async (t) => { calls.push(t); return true; });
  const form = dom.root.querySelector('form.composer')!;
  const textarea = form.querySelector('textarea[name=\"text\"]')!;
  const button = form.querySelector('button[type=\"submit\"]')!;
  const error = form.querySelector('.composer-error')!;
  
  textarea.value = 'x'.repeat(4001);
  console.log('After setting value, textarea.value.length:', textarea.value.length);
  console.log('textarea.maxLength:', textarea.maxLength);
  console.log('textarea.value:', textarea.value.substring(0, 50));
  
  button.click();
  await settle();
  
  console.log('After click, calls:', calls);
  console.log('error.textContent:', error.textContent);
});
