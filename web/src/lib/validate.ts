import { MESSAGE_MAX_LENGTH } from '../types.ts';
import type { Result, LoginInput } from '../types.ts';

export function validateMessageText(raw: string): Result<string> {
  const text = raw.trim();
  if (text === '') return { ok: false, error: 'empty' };
  if (text.length > MESSAGE_MAX_LENGTH) return { ok: false, error: 'too_long' };
  return { ok: true, value: text };
}

export function validateLogin(input: LoginInput): Result<LoginInput> {
  if (input.serverId === '') return { ok: false, error: 'server_required' };
  if (input.username.trim() === '') return { ok: false, error: 'username_required' };
  if (input.password === '') return { ok: false, error: 'password_required' };
  return {
    ok: true,
    value: {
      serverId: input.serverId,
      username: input.username.trim(),
      password: input.password
    }
  };
}
