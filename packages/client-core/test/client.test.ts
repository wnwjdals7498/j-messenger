import { describe, expect, it } from 'vitest';
import { createMessengerClient, type MessengerOptions } from '../src/index.js';

const me = {
  id: '9007199254740993',
  serverId: 'lab',
  displayName: 'A',
  enabledFeatures: {},
};
const message = {
  id: '9007199254740995',
  conversationId: '9007199254740994',
  senderId: me.id,
  clientMessageId: '00000000-0000-4000-8000-000000000003',
  text: null,
  contentExpired: true,
  fileIds: ['00000000-0000-4000-8000-000000000002'],
  createdAt: '2026-10-02T00:00:00.000Z',
};
function response(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
function fixture(fetchImpl: typeof fetch) {
  const uuid = '00000000-0000-4000-8000-000000000003';
  return createMessengerClient({
    fetch: fetchImpl,
    idFactory: { uuid: () => uuid },
    baseUrl: 'http://local',
  });
}
class FakeClock {
  private next = 1;
  private timers = new Map<number, () => void>();
  now() {
    return new Date('2026-10-02T00:00:00.000Z');
  }
  setTimeout(callback: () => void) {
    const id = this.next++;
    this.timers.set(id, callback);
    return id;
  }
  clearTimeout(handle: unknown) {
    this.timers.delete(handle as number);
  }
  runLatest() {
    const entries = [...this.timers.entries()];
    const entry = entries[entries.length - 1] as
      [number, () => void] | undefined;
    if (!entry) throw new Error('no timer');
    this.timers.delete(entry[0]);
    entry[1]();
  }
}

describe('client-core', () => {
  it('restores an existing session without sending a password or creating a new session', async () => {
    const calls: Request[] = [];
    const c = fixture((async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push(request);
      if (request.url.endsWith('/me')) return response({ data: me });
      return response({
        data: [],
        page: { nextCursor: null },
        snapshotCursor: 'opaque-snapshot',
        snapshotPosition: '0',
      });
    }) as typeof fetch);
    try {
      await expect(c.resumeSession()).resolves.toEqual(me);
      expect(c.getSnapshot().user).toEqual(me);
      expect(calls.every((request) => request.method === 'GET')).toBe(true);
      expect(calls.some((request) => request.url.endsWith('/session'))).toBe(
        false,
      );
    } finally {
      c.dispose();
    }
  });

  it('clears local state while reporting a failed remote session revocation', async () => {
    const c = fixture((async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === 'DELETE')
        return response({ error: { code: 'unavailable' } }, 503);
      if (request.url.endsWith('/me')) return response({ data: me });
      return response({
        data: [],
        page: { nextCursor: null },
        snapshotCursor: 'opaque-snapshot',
        snapshotPosition: '0',
      });
    }) as typeof fetch);
    try {
      await c.resumeSession();
      await expect(c.logout()).rejects.toMatchObject({ code: 'unavailable' });
      expect(c.getSnapshot().user).toBeNull();
      expect(c.getSnapshot().messages).toHaveLength(0);
    } finally {
      c.dispose();
    }
  });
  it('keeps credentials on browser requests and ignores a late response after logout', async () => {
    let resolveMe!: (r: Response) => void;
    const calls: Request[] = [];
    const c = fixture((async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      calls.push(req);
      if (req.url.endsWith('/session') && req.method === 'POST')
        return response(null, 204);
      if (req.url.endsWith('/me'))
        return new Promise<Response>((resolve) => {
          resolveMe = resolve;
        });
      if (req.method === 'DELETE') return response(null);
      return response({
        data: [],
        page: { nextCursor: null },
        snapshotCursor: '0',
        snapshotPosition: '0',
      });
    }) as typeof fetch);
    const login = c.login({
      serverId: 'lab',
      username: 'a',
      password: 'secret',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await c.logout();
    resolveMe(response({ data: me }));
    await expect(login).resolves.toBeNull();
    expect(c.getSnapshot().user).toBeNull();
    expect(calls[0]?.credentials).toBe('include');
    expect(JSON.stringify(calls.map((r) => r.url))).not.toContain('secret');
  });

  it('reuses the original clientMessageId on retry and merges expired body with live attachments', async () => {
    const bodies: unknown[] = [];
    let fail = true;
    const c = fixture((async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.endsWith('/session') && req.method === 'POST')
        return response(null, 204);
      if (req.url.endsWith('/me')) return response({ data: me });
      if (req.url.endsWith('/conversations'))
        return response({
          data: [],
          page: { nextCursor: null },
          snapshotCursor: '0',
          snapshotPosition: '0',
        });
      if (req.url.includes('/messages') && req.method === 'POST') {
        bodies.push(await req.json());
        if (fail) {
          fail = false;
          throw new TypeError('offline');
        }
        return response({ data: message });
      }
      if (req.method === 'DELETE') return response(null);
      return response({
        data: [],
        page: { nextCursor: null },
        snapshotCursor: '0',
        snapshotPosition: '0',
      });
    }) as typeof fetch);
    await c.login({ serverId: 'lab', username: 'a', password: 'secret' });
    await expect(
      c.sendMessage('9007199254740994' as never, 'private body'),
    ).rejects.toMatchObject({ code: 'network' });
    const pendingId = c.getSnapshot().pending[0]?.clientMessageId;
    expect(pendingId).toBe('00000000-0000-4000-8000-000000000003');
    const retried = await c.retryMessage(pendingId!);
    expect(bodies).toHaveLength(2);
    expect((bodies[0] as { clientMessageId: string }).clientMessageId).toBe(
      (bodies[1] as { clientMessageId: string }).clientMessageId,
    );
    expect(retried?.text).toBeNull();
    expect(retried?.fileIds).toHaveLength(1);
    expect(c.getSnapshot().pending).toHaveLength(0);
    c.dispose();
  });

  it('normalizes server failure without exposing untrusted message or secret in local logs', async () => {
    const logs: unknown[] = [];
    const c = createMessengerClient({
      baseUrl: 'http://local/api/v1',
      localLog: (e) => logs.push(e),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        if (req.url.endsWith('/session')) return response(null, 204);
        if (req.url.endsWith('/me')) return response({ data: me });
        if (req.url.endsWith('/conversations'))
          return response({
            data: [],
            page: { nextCursor: null },
            snapshotCursor: 'list:opaque',
            snapshotPosition: '1',
          });
        return response(
          {
            error: {
              code: 'conflict',
              message: 'private body and secret',
              requestId: '00000000-0000-4000-8000-000000000004',
            },
          },
          409,
        );
      }) as typeof fetch,
      idFactory: { uuid: () => message.clientMessageId as never },
    } as MessengerOptions);
    await c.login({ serverId: 'lab', username: 'a', password: 'secret' });
    await expect(
      c.sendMessage(message.conversationId as never, 'private body'),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(JSON.stringify(logs)).not.toContain('private body');
    expect(JSON.stringify(logs)).not.toContain('secret');
    c.dispose();
  });

  it('uses opaque cursors only as tokens, fixes through across hidden pages, and keeps live events off the recovery cursor', async () => {
    let onSocketMessage: ((value: unknown) => void) | undefined;
    const syncQueries: URL[] = [];
    let syncCount = 0;
    const socket = {
      send: () => undefined,
      close: () => undefined,
      onMessage: (callback: (value: unknown) => void) => {
        onSocketMessage = callback;
        return () => undefined;
      },
      onClose: () => () => undefined,
    };
    const c = createMessengerClient({
      baseUrl: 'http://local',
      socketFactory: () => socket,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        if (url.pathname.endsWith('/session')) return response(null, 204);
        if (url.pathname.endsWith('/me')) return response({ data: me });
        if (url.pathname.endsWith('/conversations'))
          return response({
            data: [],
            page: { nextCursor: null },
            snapshotCursor: 'snap:opaque',
            snapshotPosition: '20',
          });
        if (url.pathname.includes('/messages'))
          return response({
            data: [],
            page: { nextCursor: null },
            snapshotCursor: 'msg:opaque',
            snapshotPosition: '18',
          });
        if (url.pathname.endsWith('/sync')) {
          syncQueries.push(url);
          syncCount++;
          return response({
            data: [],
            nextCursor: syncCount === 1 ? 'next:not-a-number' : 'last:token',
            hasMore: syncCount === 1,
            through: 'bound:opaque:H',
            throughPosition: '100',
            scannedThrough: syncCount === 1 ? '80' : '100',
          });
        }
        return response({ data: [] });
      }) as typeof fetch,
      idFactory: {
        uuid: () => '00000000-0000-4000-8000-000000000003' as never,
      },
    });
    await c.login({ serverId: 'lab', username: 'a', password: 'secret' });
    onSocketMessage?.({
      type: 'ready',
      cursor: 'bound:opaque:H',
      position: '100',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(syncQueries).toHaveLength(2);
    expect(syncQueries[0]?.searchParams.get('after')).toBe('snap:opaque');
    expect(syncQueries[0]?.searchParams.get('through')).toBe('bound:opaque:H');
    expect(syncQueries[1]?.searchParams.get('after')).toBe('next:not-a-number');
    expect(syncQueries[1]?.searchParams.get('through')).toBe('bound:opaque:H');
    expect(c.getSnapshot().syncCursor).toBe('last:token');
    onSocketMessage?.({
      eventId: '101',
      type: 'message.created.v1',
      occurredAt: '2026-10-02T00:00:00.000Z',
      conversationId: message.conversationId,
      data: message,
    });
    expect(c.getSnapshot().messages).toHaveLength(1);
    expect(c.getSnapshot().syncCursor).toBe('last:token');
    const same = c.getSnapshot();
    expect(c.getSnapshot()).toBe(same);
    expect(Object.isFrozen(same)).toBe(true);
    expect(Object.isFrozen(same.messages)).toBe(true);
    c.dispose();
  });

  it('resets on an expired cursor and keeps a deleted body’s attachment until file.deleted', async () => {
    let onSocketMessage: ((value: unknown) => void) | undefined;
    let snapshots = 0;
    let syncCount = 0;
    const socket = {
      send: () => undefined,
      close: () => undefined,
      onMessage: (cb: (v: unknown) => void) => {
        onSocketMessage = cb;
        return () => undefined;
      },
      onClose: () => () => undefined,
    };
    const c = createMessengerClient({
      baseUrl: 'http://local',
      socketFactory: () => socket,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        if (url.pathname.endsWith('/session')) return response(null, 204);
        if (url.pathname.endsWith('/me')) return response({ data: me });
        if (url.pathname.endsWith('/conversations')) {
          snapshots++;
          return response({
            data: [],
            page: { nextCursor: null },
            snapshotCursor: `list:${snapshots}`,
            snapshotPosition: '40',
          });
        }
        if (url.pathname.includes('/messages'))
          return response({
            data: [],
            page: { nextCursor: null },
            snapshotCursor: 'msg:opaque',
            snapshotPosition: '40',
          });
        if (url.pathname.endsWith('/sync')) {
          syncCount++;
          if (syncCount === 2)
            return response(
              {
                error: {
                  code: 'sync_reset_required',
                  message: 'expired',
                  requestId: '00000000-0000-4000-8000-000000000004',
                },
              },
              410,
            );
          return response({
            data: [],
            nextCursor:
              syncCount === 1 ? 'cursor:before-reset' : 'cursor:after-reset',
            hasMore: false,
            through: syncCount === 1 ? 'ready:initial' : 'ready:reset-bound',
            throughPosition: '50',
            scannedThrough: '50',
          });
        }
        return response({ data: [] });
      }) as typeof fetch,
    });
    await c.login({ serverId: 'lab', username: 'a', password: 'secret' });
    onSocketMessage?.({
      type: 'ready',
      cursor: 'ready:initial',
      position: '50',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    onSocketMessage?.({
      type: 'ready',
      cursor: 'ready:reset-bound',
      position: '50',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(snapshots).toBeGreaterThanOrEqual(2);
    expect(c.getSnapshot().syncCursor).toBe('cursor:after-reset');
    const activeMessage = { ...message, text: 'body', contentExpired: false };
    onSocketMessage?.({
      eventId: '51',
      type: 'message.created.v1',
      occurredAt: message.createdAt,
      conversationId: message.conversationId,
      data: activeMessage,
    });
    onSocketMessage?.({
      eventId: '52',
      type: 'message.deleted.v1',
      occurredAt: message.createdAt,
      conversationId: message.conversationId,
      data: {
        messageId: message.id,
        contentExpired: true,
        fileIds: message.fileIds,
      },
    });
    expect(c.getSnapshot().messages[0]?.text).toBeNull();
    expect(c.getSnapshot().messages[0]?.fileIds).toHaveLength(1);
    onSocketMessage?.({
      eventId: '51',
      type: 'message.created.v1',
      occurredAt: message.createdAt,
      conversationId: message.conversationId,
      data: activeMessage,
    });
    expect(c.getSnapshot().messages[0]?.text).toBeNull();
    onSocketMessage?.({
      eventId: '53',
      type: 'file.deleted.v1',
      occurredAt: message.createdAt,
      conversationId: message.conversationId,
      data: { fileId: message.fileIds[0] },
    });
    expect(c.getSnapshot().messages[0]?.fileIds).toHaveLength(0);
    c.dispose();
  });

  it('does not restore a send result after logout while the request is in flight', async () => {
    let resolveSend!: (r: Response) => void;
    const c = fixture((async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.endsWith('/session')) return response(null, 204);
      if (req.url.endsWith('/me')) return response({ data: me });
      if (req.url.endsWith('/conversations'))
        return response({
          data: [],
          page: { nextCursor: null },
          snapshotCursor: 'snap:one',
          snapshotPosition: '1',
        });
      if (req.url.includes('/messages') && req.method === 'POST')
        return new Promise<Response>((resolve) => {
          resolveSend = resolve;
        });
      return response({
        data: [],
        page: { nextCursor: null },
        snapshotCursor: 'snap:two',
        snapshotPosition: '1',
      });
    }) as typeof fetch);
    await c.login({ serverId: 'lab', username: 'a', password: 'secret' });
    const send = c.sendMessage(message.conversationId as never, 'private body');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await c.logout();
    resolveSend(response({ data: message }));
    expect(await send).toBeNull();
    expect(c.getSnapshot().messages).toHaveLength(0);
    expect(c.getSnapshot().pending).toHaveLength(0);
    c.dispose();
  });

  it('discards a conversation-list response that finishes after logout', async () => {
    let resolveList!: (r: Response) => void;
    const c = fixture((async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.endsWith('/session')) return response(null, 204);
      if (req.url.endsWith('/me')) return response({ data: me });
      if (req.url.endsWith('/conversations'))
        return new Promise<Response>((resolve) => {
          resolveList = resolve;
        });
      return response({
        data: [],
        page: { nextCursor: null },
        snapshotCursor: 'messages:opaque',
        snapshotPosition: '1',
      });
    }) as typeof fetch);
    const login = c.login({
      serverId: 'lab',
      username: 'a',
      password: 'secret',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await c.logout();
    resolveList(
      response({
        data: [],
        page: { nextCursor: null },
        snapshotCursor: 'list:opaque',
        snapshotPosition: '1',
      }),
    );
    expect(await login).toBeNull();
    expect(c.getSnapshot().user).toBeNull();
    expect(c.getSnapshot().conversations).toHaveLength(0);
    c.dispose();
  });

  it('syncs changes after one snapshot, merges duplicates, and reconnects from the last cursor', async () => {
    let onSocketMessage: ((value: unknown) => void) | undefined;
    let onSocketClose: (() => void) | undefined;
    let resolveFirstSync!: (r: Response) => void;
    const sockets: { emit(value: unknown): void; close(): void }[] = [];
    const syncQueries: URL[] = [];
    let conversationGets = 0;
    let messageGets = 0;
    let syncCalls = 0;
    const clock = new FakeClock();
    const group = {
      id: message.conversationId,
      kind: 'direct' as const,
      title: null,
      memberIds: [me.id, message.senderId],
      createdAt: message.createdAt,
      lastMessageAt: message.createdAt,
    };
    const syncedMessage = {
      ...message,
      text: 'snapshot and sync duplicate',
      contentExpired: false,
      fileIds: [],
    };
    const bufferedMessage = {
      ...syncedMessage,
      id: '9007199254740996',
      clientMessageId: '00000000-0000-4000-8000-000000000006',
      text: 'arrived while sync was in flight',
    };
    const event = (eventId: string, data: typeof syncedMessage) => ({
      eventId,
      type: 'message.created.v1',
      occurredAt: message.createdAt,
      conversationId: message.conversationId,
      data,
    });
    const c = createMessengerClient({
      baseUrl: 'http://local',
      clock,
      socketFactory: () => {
        const current = {
          emit(value: unknown) {
            onSocketMessage?.(value);
          },
          close() {
            onSocketClose?.();
          },
        };
        sockets.push(current);
        return {
          send: () => undefined,
          close: () => undefined,
          onMessage: (cb: (value: unknown) => void) => {
            onSocketMessage = cb;
            return () => {
              if (onSocketMessage === cb) onSocketMessage = undefined;
            };
          },
          onClose: (cb: () => void) => {
            onSocketClose = cb;
            return () => {
              if (onSocketClose === cb) onSocketClose = undefined;
            };
          },
        };
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        if (url.pathname.endsWith('/me')) return response({ data: me });
        if (url.pathname.endsWith('/conversations')) {
          conversationGets++;
          return response({
            data: [group],
            page: { nextCursor: null },
            snapshotCursor: 'snapshot:opaque:C5',
            snapshotPosition: '5',
          });
        }
        if (url.pathname.endsWith(`/conversations/${group.id}/messages`)) {
          messageGets++;
          return response({
            data: [syncedMessage],
            page: { nextCursor: null },
            snapshotCursor: 'message-snapshot:opaque:C7',
            snapshotPosition: '7',
          });
        }
        if (url.pathname.endsWith('/sync')) {
          syncQueries.push(url);
          syncCalls++;
          if (syncCalls === 1)
            return new Promise<Response>((resolve) => {
              resolveFirstSync = resolve;
            });
          return response({
            data: [],
            nextCursor: 'sync:cursor:page2',
            hasMore: false,
            through: 'ready:cursor:H9',
            throughPosition: '9',
            scannedThrough: '9',
          });
        }
        return response({ data: [] });
      }) as typeof fetch,
    });
    await c.resumeSession();
    expect(conversationGets).toBe(1);
    expect(messageGets).toBe(1);
    expect(c.getSnapshot().syncCursor).toBe('snapshot:opaque:C5');

    sockets[0]!.emit({
      type: 'ready',
      cursor: 'ready:cursor:H8',
      position: '8',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(syncQueries[0]?.searchParams.get('after')).toBe(
      'snapshot:opaque:C5',
    );
    expect(syncQueries[0]?.searchParams.get('through')).toBe('ready:cursor:H8');
    sockets[0]!.emit(event('9', bufferedMessage));
    resolveFirstSync(
      response({
        data: [event('7', syncedMessage)],
        nextCursor: 'sync:cursor:page1',
        hasMore: false,
        through: 'ready:cursor:H8',
        throughPosition: '8',
        scannedThrough: '8',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(conversationGets).toBe(1);
    expect(messageGets).toBe(1);
    expect(c.getSnapshot().messages).toHaveLength(2);
    expect(
      c.getSnapshot().messages.find((item) => item.id === syncedMessage.id)
        ?.text,
    ).toBe('snapshot and sync duplicate');
    expect(c.getSnapshot().syncCursor).toBe('sync:cursor:page1');

    sockets[0]!.close();
    clock.runLatest();
    expect(sockets).toHaveLength(2);
    sockets[1]!.emit({
      type: 'ready',
      cursor: 'ready:cursor:H9',
      position: '9',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(syncQueries[1]?.searchParams.get('after')).toBe('sync:cursor:page1');
    expect(syncQueries[1]?.searchParams.get('through')).toBe('ready:cursor:H9');
    expect(conversationGets).toBe(1);
    expect(messageGets).toBe(1);
    c.dispose();
  });

  it('rejects a changing sync bound even when the position keeps increasing', async () => {
    let onSocketMessage: ((value: unknown) => void) | undefined;
    let syncCalls = 0;
    const socket = {
      send: () => undefined,
      close: () => undefined,
      onMessage: (cb: (v: unknown) => void) => {
        onSocketMessage = cb;
        return () => undefined;
      },
      onClose: () => () => undefined,
    };
    const c = createMessengerClient({
      baseUrl: 'http://local',
      socketFactory: () => socket,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        if (url.pathname.endsWith('/session')) return response(null, 204);
        if (url.pathname.endsWith('/me')) return response({ data: me });
        if (url.pathname.endsWith('/conversations'))
          return response({
            data: [],
            page: { nextCursor: null },
            snapshotCursor: 'list:opaque',
            snapshotPosition: '5',
          });
        if (url.pathname.endsWith('/sync')) {
          syncCalls++;
          return response({
            data: [],
            nextCursor: `page:${syncCalls}`,
            hasMore: syncCalls === 1,
            through: syncCalls === 1 ? 'ready:opaque' : 'bound:two',
            throughPosition: syncCalls === 1 ? '20' : '21',
            scannedThrough: syncCalls === 1 ? '10' : '20',
          });
        }
        return response({
          data: [],
          page: { nextCursor: null },
          snapshotCursor: 'messages:opaque',
          snapshotPosition: '5',
        });
      }) as typeof fetch,
    });
    await c.login({ serverId: 'lab', username: 'a', password: 'secret' });
    onSocketMessage?.({
      type: 'ready',
      cursor: 'ready:opaque',
      position: '20',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(syncCalls).toBe(2);
    expect(c.getSnapshot().syncCursor).toBe('page:1');
    c.dispose();
  });

  it('rejects a server that changes the opaque through bound between sync pages', async () => {
    let onSocketMessage: ((value: unknown) => void) | undefined;
    let syncCalls = 0;
    const socket = {
      send: () => undefined,
      close: () => undefined,
      onMessage: (cb: (v: unknown) => void) => {
        onSocketMessage = cb;
        return () => undefined;
      },
      onClose: () => () => undefined,
    };
    const c = createMessengerClient({
      baseUrl: 'http://local',
      socketFactory: () => socket,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        if (url.pathname.endsWith('/session')) return response(null, 204);
        if (url.pathname.endsWith('/me')) return response({ data: me });
        if (url.pathname.endsWith('/conversations'))
          return response({
            data: [],
            page: { nextCursor: null },
            snapshotCursor: 'list:opaque',
            snapshotPosition: '5',
          });
        if (url.pathname.endsWith('/sync')) {
          syncCalls++;
          return response({
            data: [],
            nextCursor: 'page:opaque',
            hasMore: true,
            through: syncCalls === 1 ? 'ready:opaque' : 'bound:changed',
            throughPosition: '20',
            scannedThrough: syncCalls === 1 ? '10' : '20',
          });
        }
        return response({
          data: [],
          page: { nextCursor: null },
          snapshotCursor: 'messages:opaque',
          snapshotPosition: '5',
        });
      }) as typeof fetch,
    });
    await c.login({ serverId: 'lab', username: 'a', password: 'secret' });
    onSocketMessage?.({
      type: 'ready',
      cursor: 'ready:opaque',
      position: '20',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(syncCalls).toBe(2);
    expect(c.getSnapshot().syncCursor).toBe('page:opaque');
    c.dispose();
  });

  it('retries an uncertain timeout with the original message ID inside the seven-day window', async () => {
    const clock = new FakeClock();
    let sendCount = 0;
    const ids: unknown[] = [];
    const c = createMessengerClient({
      baseUrl: 'http://local',
      clock,
      requestTimeoutMs: 10,
      idFactory: {
        uuid: () => '00000000-0000-4000-8000-000000000003' as never,
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        if (url.pathname.endsWith('/session')) return response(null, 204);
        if (url.pathname.endsWith('/me')) return response({ data: me });
        if (url.pathname.endsWith('/conversations'))
          return response({
            data: [],
            page: { nextCursor: null },
            snapshotCursor: 'list:opaque',
            snapshotPosition: '1',
          });
        if (url.pathname.includes('/messages') && req.method === 'POST') {
          sendCount++;
          ids.push(await req.json());
          if (sendCount === 1) return new Promise<Response>(() => undefined);
          return response({ data: message });
        }
        return response({
          data: [],
          page: { nextCursor: null },
          snapshotCursor: 'messages:opaque',
          snapshotPosition: '1',
        });
      }) as typeof fetch,
    });
    await c.login({ serverId: 'lab', username: 'a', password: 'secret' });
    const sending = c.sendMessage(
      message.conversationId as never,
      'uncertain send',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock.runLatest();
    await expect(sending).rejects.toMatchObject({ code: 'timeout' });
    clock.runLatest();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendCount).toBe(2);
    expect((ids[0] as { clientMessageId: string }).clientMessageId).toBe(
      (ids[1] as { clientMessageId: string }).clientMessageId,
    );
    expect(c.getSnapshot().pending).toHaveLength(0);
    c.dispose();
  });
});
