import { ClientError } from '@j-messenger/client-core';
import type { MessengerFileBridge } from '@j-messenger/client-react';

interface AndroidDownloadTransport {
  postMessage(value: string): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
}
declare global {
  interface Window {
    JMessengerAndroidDownloads?: AndroidDownloadTransport;
  }
}

export function createAndroidFilesBridge(): MessengerFileBridge | undefined {
  const transport = window.JMessengerAndroidDownloads;
  if (!transport || typeof transport.postMessage !== 'function') return;
  const pending = new Map<
    string,
    { resolve(value: boolean): void; reject(error: ClientError): void }
  >();
  transport.onmessage = (event) => {
    if (typeof event.data !== 'string') return;
    let response: unknown;
    try {
      response = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!response || typeof response !== 'object') return;
    const { id, saved, error } = response as Record<string, unknown>;
    if (typeof id !== 'string' || typeof saved !== 'boolean') return;
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    if (typeof error === 'string' && error && error !== 'cancelled')
      request.reject(
        new ClientError(error === 'too_large' ? 'too_large' : 'unavailable'),
      );
    else request.resolve(saved);
  };
  window.addEventListener(
    'pagehide',
    () => {
      for (const request of pending.values())
        request.reject(new ClientError('unavailable'));
      pending.clear();
    },
    { once: true },
  );
  return {
    pickFile: () =>
      new Promise<File | null>((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.png,.jpg,.jpeg,.webp,.pdf,.txt,.csv,.docx,.xlsx,.zip';
        input.style.display = 'none';
        const finish = (file: File | null) => {
          input.remove();
          resolve(file);
        };
        input.addEventListener(
          'change',
          () => finish(input.files?.[0] ?? null),
          { once: true },
        );
        input.addEventListener('cancel', () => finish(null), { once: true });
        document.body.append(input);
        input.click();
      }),
    async saveFile(blob, suggestedName) {
      if (blob.size < 1 || blob.size > 5_000_000)
        throw new ClientError('too_large');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let start = 0; start < bytes.length; start += 8192)
        binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
      const id = crypto.randomUUID();
      return await new Promise<boolean>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          transport.postMessage(
            JSON.stringify({
              id,
              filename: suggestedName,
              mime: blob.type || 'application/octet-stream',
              base64: btoa(binary),
            }),
          );
        } catch {
          pending.delete(id);
          reject(new ClientError('unavailable'));
        }
      });
    },
  };
}
