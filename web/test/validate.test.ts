import { test } from 'node:test';
import assert from 'node:assert/strict';

// This import will fail because we do not create src/lib/validate.ts yet.
// That's expected for this test task.
import { validateMessageText, validateLogin } from '../src/lib/validate.ts';
import { MESSAGE_MAX_LENGTH } from '../src/types.ts';

test('validateMessageText trims surrounding whitespace', () => {
  assert.deepEqual(validateMessageText('  hi \n'), { ok: true, value: 'hi' });
});

test('validateMessageText keeps inner newlines', () => {
  assert.deepEqual(validateMessageText('a\nb'), { ok: true, value: 'a\nb' });
});

test('validateMessageText rejects empty or whitespace-only text', () => {
  assert.deepEqual(validateMessageText(''), { ok: false, error: 'empty' });
  assert.deepEqual(validateMessageText('   \n\t'), { ok: false, error: 'empty' });
});

test('validateMessageText limits length after trimming', () => {
  assert.strictEqual(MESSAGE_MAX_LENGTH, 4000);
  const maxLen = 'x'.repeat(4000);
  assert.deepEqual(validateMessageText(maxLen), { ok: true, value: maxLen });
  assert.deepEqual(validateMessageText(' ' + maxLen + ' '), { ok: true, value: maxLen });
  assert.deepEqual(validateMessageText('x'.repeat(4001)), { ok: false, error: 'too_long' });
});

test('validateLogin checks server, then username, then password', () => {
  assert.deepEqual(validateLogin({ serverId: '', username: '', password: '' }), { ok: false, error: 'server_required' });
  assert.deepEqual(validateLogin({ serverId: '', username: 'a', password: 'p' }), { ok: false, error: 'server_required' });
  assert.deepEqual(validateLogin({ serverId: 'mail-a', username: '  ', password: 'p' }), { ok: false, error: 'username_required' });
  assert.deepEqual(validateLogin({ serverId: 'mail-a', username: 'alice', password: '' }), { ok: false, error: 'password_required' });
});

test('validateLogin trims the username but never the password', () => {
  assert.deepEqual(validateLogin({ serverId: 'mail-a', username: ' alice ', password: ' p ' }), { ok: true, value: { serverId: 'mail-a', username: 'alice', password: ' p ' } });
  assert.deepEqual(validateLogin({ serverId: 'mail-a', username: 'bob', password: '   ' }), { ok: true, value: { serverId: 'mail-a', username: 'bob', password: '   ' } });
});
