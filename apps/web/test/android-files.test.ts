// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { createAndroidFilesBridge } from '../src/android-files.js';

afterEach(() => {
  delete window.JMessengerAndroidDownloads;
});

it('keeps ordinary browsers on their existing file implementation', () => {
  expect(createAndroidFilesBridge()).toBeUndefined();
});

it('transfers the authorized blob bytes and waits for its own native acknowledgement', async () => {
  const sent = vi.fn();
  const channel = {
    postMessage: sent,
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
  };
  window.JMessengerAndroidDownloads = channel;
  const files = createAndroidFilesBridge()!;
  const saved = files.saveFile(
    new Blob(['owned file'], { type: 'text/plain' }),
    'attachment.txt',
  );
  await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce());
  const message = JSON.parse(sent.mock.calls[0]![0] as string) as {
    id: string;
    base64: string;
  };
  expect(atob(message.base64)).toBe('owned file');
  expect(Object.keys(message).sort()).toEqual([
    'base64',
    'filename',
    'id',
    'mime',
  ]);
  channel.onmessage?.(
    new MessageEvent('message', {
      data: JSON.stringify({ id: message.id, saved: true }),
    }),
  );
  await expect(saved).resolves.toBe(true);
});

it('treats save picker cancellation as cancellation', async () => {
  let id = '';
  const channel = {
    postMessage: (value: string) => {
      id = (JSON.parse(value) as { id: string }).id;
    },
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
  };
  window.JMessengerAndroidDownloads = channel;
  const saved = createAndroidFilesBridge()!.saveFile(
    new Blob(['file']),
    'attachment',
  );
  await vi.waitFor(() => expect(id).not.toBe(''));
  channel.onmessage?.(
    new MessageEvent('message', {
      data: JSON.stringify({ id, saved: false, error: 'cancelled' }),
    }),
  );
  await expect(saved).resolves.toBe(false);
});

it('rejects oversize content before crossing the native channel', async () => {
  const send = vi.fn();
  window.JMessengerAndroidDownloads = { postMessage: send, onmessage: null };
  await expect(
    createAndroidFilesBridge()!.saveFile(
      new Blob([new Uint8Array(5_000_001)]),
      'attachment',
    ),
  ).rejects.toMatchObject({ code: 'too_large' });
  expect(send).not.toHaveBeenCalled();
});
