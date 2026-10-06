import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createMessengerClient,
  type ClientSocket,
} from '@j-messenger/client-core';
import { MessengerApp } from '@j-messenger/client-react';

function socketFactory(path: string): ClientSocket {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url);
  const messageHandlers = new Set<(value: unknown) => void>();
  const closeHandlers = new Set<() => void>();
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    try {
      const value: unknown = JSON.parse(event.data);
      for (const handler of messageHandlers) handler(value);
    } catch {
      // Ignore malformed frames; the client will recover through cursor sync.
    }
  });
  socket.addEventListener('close', () => {
    for (const handler of closeHandlers) handler();
  });
  return {
    send: (value) => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(value));
    },
    close: () => socket.close(),
    onMessage: (handler) => {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onClose: (handler) => {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
  };
}

const client = createMessengerClient({ socketFactory });
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('앱을 표시할 영역을 찾을 수 없습니다.');
createRoot(rootElement).render(
  <StrictMode>
    <MessengerApp client={client} />
  </StrictMode>,
);
void client.resumeSession().catch(() => undefined);
window.addEventListener('pagehide', () => client.dispose(), { once: true });
