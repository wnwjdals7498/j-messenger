import {
  EventSchema,
  ConversationDtoSchema,
  ReadyFrameSchema,
  ServerListResponseSchema,
  ConversationListResponseSchema,
  ConversationResponseSchema,
  CurrentUserResponseSchema,
  ErrorEnvelopeSchema,
  FileResponseSchema,
  MessageListResponseSchema,
  MessageResponseSchema,
  ReadStateListResponseSchema,
  RetentionPolicyResponseSchema,
  SyncResponseSchema,
  UserListResponseSchema,
  checkSchema,
  isValidMessageOutput,
  type ConversationDto,
  type CurrentUserDto,
  type DecimalId,
  type ErrorCode,
  type EventDto,
  type FileDto,
  type MessageOutput,
  type RetentionPolicyDto,
  type ServerDto,
  type SyncResponse,
  type Uuid,
  type UserDto,
} from '@j-messenger/contracts';

export type ClientErrorCode =
  ErrorCode | 'network' | 'invalid_response' | 'timeout';
export class ClientError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    readonly requestId: string | null = null,
  ) {
    super(code);
    this.name = 'ClientError';
  }
}
export interface Clock {
  now(): Date;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface ClientSocket {
  send(value: unknown): void;
  close(): void;
  onMessage(callback: (value: unknown) => void): () => void;
  onClose(callback: () => void): () => void;
}
export interface MessengerOptions {
  baseUrl?: string;
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  socketFactory?: (url: string) => ClientSocket;
  clock?: Clock;
  idFactory?: { uuid(): Uuid };
  localLog?: (event: {
    featureId: string;
    event: string;
    outcome: 'success' | 'rejected' | 'failure';
    fields: Readonly<Record<string, string | number | boolean | null>>;
  }) => void;
  visibilitySource?: {
    addEventListener(type: 'visibilitychange', listener: () => void): void;
    removeEventListener(type: 'visibilitychange', listener: () => void): void;
    readonly visibilityState: string;
  };
}
export interface Snapshot {
  readonly generation: number;
  readonly user: CurrentUserDto | null;
  readonly users: readonly UserDto[];
  readonly conversations: readonly ConversationDto[];
  readonly messages: readonly MessageOutput[];
  readonly pending: readonly {
    readonly conversationId: DecimalId;
    readonly clientMessageId: Uuid;
    readonly text: string;
    readonly fileIds: readonly Uuid[];
    readonly createdAt: number;
    readonly state: 'pending' | 'failed';
  }[];
  readonly syncCursor: string | null;
  readonly snapshotPosition: string;
  readonly snapshotPositionByConversation: Readonly<Record<string, string>>;
}
const systemClock: Clock = {
  now: () => new Date(),
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (h) =>
    globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};
const defaultIds = { uuid: () => crypto.randomUUID() as Uuid };
const emptySnapshot = (generation: number): Snapshot =>
  Object.freeze({
    generation,
    user: null,
    users: Object.freeze([]),
    conversations: Object.freeze([]),
    messages: Object.freeze([]),
    pending: Object.freeze([]),
    syncCursor: null,
    snapshotPosition: '0',
    snapshotPositionByConversation: Object.freeze({}),
  });
function freezeValue<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeValue(child);
    Object.freeze(value);
  }
  return value;
}
const cmp = (a: string, b: string): number => {
  const x = BigInt(a),
    y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

export function createMessengerClient(options: MessengerOptions = {}) {
  const suppliedBase = options.baseUrl ?? '';
  const base = `${suppliedBase.replace(/\/$/, '').replace(/\/api\/v1$/, '')}/api/v1`;
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const visibilitySource =
    options.visibilitySource ??
    (typeof document === 'undefined' ? undefined : document);
  const clock = options.clock ?? systemClock;
  const ids = options.idFactory ?? defaultIds;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const listeners = new Set<() => void>();
  let snapshot = emptySnapshot(0);
  let generation = 0;
  let socket: ClientSocket | null = null;
  let socketDisposers: (() => void)[] = [];
  let retryTimer: unknown = null;
  const messageRetryTimers = new Map<string, unknown>();
  const messageRetryAttempts = new Map<string, number>();
  let syncTimer: unknown = null;
  let lastEventId = '0';
  let latestRequestId: string | null = null;
  let buffered: EventDto[] = [];
  let bootstrapping = false;
  const messageTombstones = new Set<string>();
  const fileTombstones = new Set<string>();
  let disposed = false;
  const safeLog = (
    event: string,
    outcome: 'success' | 'rejected' | 'failure',
    fields: Readonly<Record<string, string | number | boolean | null>> = {},
  ) =>
    options.localLog?.({
      featureId: event.startsWith('client.send')
        ? 'F13'
        : event.startsWith('client.sync')
          ? 'F17'
          : 'F04',
      event,
      outcome,
      fields,
    });
  const publish = (next: Snapshot) => {
    snapshot = freezeValue(next);
    for (const listener of listeners) listener();
  };
  const update = (part: Partial<Snapshot>) => publish({ ...snapshot, ...part });
  const current = (g: number) => !disposed && generation === g;
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    schema?: unknown,
  ): Promise<T> {
    const g = generation;
    const init: RequestInit = {
      method,
      credentials: 'include',
      headers:
        body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    let response: Response;
    const controller = new AbortController();
    let timeoutHandle: unknown = null;
    let timedOut = false;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutHandle = clock.setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new ClientError('timeout'));
        }, requestTimeoutMs);
      });
      response = await Promise.race([
        fetcher(`${base}${path}`, { ...init, signal: controller.signal }),
        timeout,
      ]);
    } catch {
      if (timedOut) throw new ClientError('timeout');
      throw new ClientError('network');
    } finally {
      if (timeoutHandle !== null) clock.clearTimeout(timeoutHandle);
    }
    const requestId = response.headers.get('X-Request-Id');
    if (current(g)) latestRequestId = requestId;
    if (!current(g)) throw new ClientError('unauthorized', requestId);
    let value: unknown;
    try {
      value = response.status === 204 ? null : await response.json();
    } catch {
      throw new ClientError('invalid_response', requestId);
    }
    if (!response.ok) {
      const valid = checkSchema(ErrorEnvelopeSchema, value);
      const errorBody = value as {
        error: { code: ErrorCode; requestId: Uuid };
      };
      throw new ClientError(
        valid
          ? errorBody.error.code
          : response.status === 401
            ? 'unauthorized'
            : 'internal',
        valid ? errorBody.error.requestId : requestId,
      );
    }
    if (schema && !checkSchema(schema as never, value))
      throw new ClientError('invalid_response', requestId);
    return value as T;
  }
  function mergeMessage(message: MessageOutput, g = generation) {
    if (!current(g) || !isValidMessageOutput(message)) return;
    if (messageTombstones.has(message.id)) return;
    const merged = {
      ...message,
      fileIds: message.fileIds.filter((id) => !fileTombstones.has(id)),
    };
    const messages = [...snapshot.messages];
    const i = messages.findIndex(
      (m) => m.id === merged.id || m.clientMessageId === merged.clientMessageId,
    );
    if (i >= 0) messages[i] = merged;
    else messages.push(merged);
    messages.sort((a, b) => cmp(a.id, b.id));
    update({
      messages: Object.freeze(messages),
      pending: Object.freeze(
        snapshot.pending.filter(
          (p) => p.clientMessageId !== merged.clientMessageId,
        ),
      ),
    });
    const timer = messageRetryTimers.get(message.clientMessageId);
    if (timer !== undefined) clock.clearTimeout(timer);
    messageRetryTimers.delete(message.clientMessageId);
    messageRetryAttempts.delete(message.clientMessageId);
  }
  function scheduleMessageRetry(item: Snapshot['pending'][number]) {
    if (!snapshot.user || messageRetryTimers.has(item.clientMessageId)) return;
    const age = clock.now().getTime() - item.createdAt;
    if (age >= 7 * 86_400_000) {
      update({
        pending: Object.freeze(
          snapshot.pending.map((p) =>
            p.clientMessageId === item.clientMessageId
              ? Object.freeze({ ...p, state: 'failed' as const })
              : p,
          ),
        ),
      });
      return;
    }
    const attempt = (messageRetryAttempts.get(item.clientMessageId) ?? 0) + 1;
    messageRetryAttempts.set(item.clientMessageId, attempt);
    const delay =
      Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5)) *
      (0.8 + Math.random() * 0.4);
    const g = generation;
    const timer = clock.setTimeout(
      () => {
        messageRetryTimers.delete(item.clientMessageId);
        if (
          current(g) &&
          clock.now().getTime() - item.createdAt < 7 * 86_400_000
        )
          void retryMessage(item.clientMessageId).catch(() => undefined);
        else if (current(g))
          update({
            pending: Object.freeze(
              snapshot.pending.map((p) =>
                p.clientMessageId === item.clientMessageId
                  ? Object.freeze({ ...p, state: 'failed' as const })
                  : p,
              ),
            ),
          });
      },
      Math.min(delay, Math.max(0, 7 * 86_400_000 - age)),
    );
    messageRetryTimers.set(item.clientMessageId, timer);
    safeLog('client.send.retry', 'failure', {
      attempt,
      delayMs: Math.round(delay),
      reason: 'retryable',
    });
  }
  function clearMessageRetries() {
    for (const timer of messageRetryTimers.values()) clock.clearTimeout(timer);
    messageRetryTimers.clear();
    messageRetryAttempts.clear();
  }
  function applyEvent(event: EventDto, g = generation) {
    if (!current(g)) return;
    const payload: Record<string, unknown> = {
      ...(event.data as unknown as Record<string, unknown>),
    };
    if (event.type === 'message.created.v1' && isValidMessageOutput(payload))
      mergeMessage(payload, g);
    const data: Record<string, unknown> = payload;
    if (
      event.type === 'conversation.created.v1' &&
      checkSchema(ConversationDtoSchema, payload)
    ) {
      const byId = new Map(
        snapshot.conversations.map((conversation) => [
          conversation.id,
          conversation,
        ]),
      );
      byId.set(payload.id, payload);
      update({ conversations: Object.freeze([...byId.values()]) });
    }
    if (
      event.type === 'message.deleted.v1' &&
      typeof data['messageId'] === 'string'
    ) {
      const messageId = data['messageId'];
      messageTombstones.add(messageId);
      update({
        messages: Object.freeze(
          snapshot.messages.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  text: null,
                  contentExpired: true as const,
                  fileIds: Array.isArray(data['fileIds'])
                    ? (data['fileIds'] as Uuid[])
                    : m.fileIds,
                }
              : m,
          ),
        ),
      });
    }
    if (
      event.type === 'file.deleted.v1' &&
      typeof data['fileId'] === 'string'
    ) {
      const fileId = data['fileId'];
      fileTombstones.add(fileId);
      update({
        messages: Object.freeze(
          snapshot.messages.map((m) => ({
            ...m,
            fileIds: m.fileIds.filter((id) => id !== fileId),
          })),
        ),
      });
    }
    if (cmp(event.eventId, lastEventId) > 0) lastEventId = event.eventId;
  }
  async function loadSnapshot(g: number) {
    const conversations = await request<{
      data: ConversationDto[];
      snapshotCursor: string;
      snapshotPosition: string;
    }>('GET', '/conversations', undefined, ConversationListResponseSchema);
    if (!current(g)) return;
    update({ conversations: Object.freeze([...conversations.data]) });
    const idsToLoad = conversations.data.map((c) => c.id);
    const pages = await Promise.all(
      idsToLoad.map((id) =>
        request<{
          data: MessageOutput[];
          snapshotCursor: string;
          snapshotPosition: string;
        }>(
          'GET',
          `/conversations/${encodeURIComponent(id)}/messages`,
          undefined,
          MessageListResponseSchema,
        ),
      ),
    );
    if (!current(g)) return;
    const positions: Record<string, string> = {};
    for (let i = 0; i < conversations.data.length; i++) {
      const id = conversations.data[i]!.id;
      positions[id] = pages[i]!.snapshotPosition;
    }
    const byId = new Map<string, MessageOutput>();
    for (const page of pages)
      for (const message of page.data) {
        if (messageTombstones.has(message.id))
          byId.set(message.id, {
            ...message,
            text: null,
            contentExpired: true,
            fileIds: message.fileIds.filter((id) => !fileTombstones.has(id)),
          });
        else
          byId.set(message.id, {
            ...message,
            fileIds: message.fileIds.filter((id) => !fileTombstones.has(id)),
          });
      }
    publish({
      ...snapshot,
      messages: Object.freeze(
        [...byId.values()].sort((a, b) => cmp(a.id, b.id)),
      ),
      // Conversation list snapshots use the same signed user/server/epoch cursor
      // format as sync. Events after this snapshot are recovered at WS ready.
      syncCursor: conversations.snapshotCursor,
      snapshotPosition: conversations.snapshotPosition,
      snapshotPositionByConversation: Object.freeze(positions),
    });
  }
  async function sync(
    g = generation,
    after = snapshot.syncCursor ?? '',
    through?: string,
    throughPosition?: string,
  ) {
    if (!after) return;
    let cursor = after;
    let fixed = through;
    let fixedPosition: string | null = throughPosition ?? null;
    let hasMore = false;
    try {
      for (let pageNo = 0; pageNo < 500; pageNo++) {
        const query = new URLSearchParams({ after: cursor, limit: '100' });
        if (fixed) query.set('through', fixed);
        const result = await request<SyncResponse>(
          'GET',
          `/sync?${query}`,
          undefined,
          SyncResponseSchema,
        );
        if (!current(g)) return;
        if (!fixed) fixed = result.through;
        if (
          result.through !== fixed ||
          (fixedPosition !== null &&
            result.throughPosition !== fixedPosition) ||
          cmp(result.scannedThrough, result.throughPosition) > 0 ||
          cmp(result.scannedThrough, snapshot.snapshotPosition) < 0
        )
          throw new ClientError('invalid_response');
        fixedPosition = result.throughPosition;
        if (result.hasMore && result.nextCursor === cursor)
          throw new ClientError('invalid_response');
        if (cmp(result.scannedThrough, snapshot.snapshotPosition) < 0)
          throw new ClientError('invalid_response');
        for (const event of result.data) applyEvent(event, g);
        cursor = result.nextCursor;
        update({ syncCursor: cursor, snapshotPosition: result.scannedThrough });
        hasMore = result.hasMore;
        if (!hasMore) break;
      }
      if (hasMore) throw new ClientError('invalid_response');
      safeLog('client.sync.completed', 'success', { pages: 1 });
    } catch (error) {
      if (
        error instanceof ClientError &&
        error.code === 'sync_reset_required'
      ) {
        safeLog('client.sync.reset', 'rejected', {
          reason: 'sync_reset_required',
        });
        lastEventId = '0';
        messageTombstones.clear();
        fileTombstones.clear();
        bootstrapping = true;
        publish({ ...emptySnapshot(g), user: snapshot.user });
        await loadSnapshot(g);
        if (through) {
          update({ syncCursor: through });
          await sync(g, through);
        } else {
          update({ syncCursor: null });
          socket?.close();
        }
        applyBuffered(g);
        bootstrapping = false;
      } else if (
        error instanceof ClientError &&
        error.code === 'unauthorized'
      ) {
        void logout(false);
      } else throw error;
    }
  }
  function applyBuffered(g: number) {
    const events = buffered.sort((a, b) => cmp(a.eventId, b.eventId));
    buffered = [];
    for (const event of events) {
      const conversationId = event.conversationId;
      const floor = conversationId
        ? snapshot.snapshotPositionByConversation[conversationId]
        : snapshot.snapshotPosition;
      if (floor === undefined || cmp(event.eventId, floor) > 0)
        applyEvent(event, g);
    }
  }
  function disconnect() {
    for (const off of socketDisposers) off();
    socketDisposers = [];
    socket?.close();
    socket = null;
    if (retryTimer !== null) clock.clearTimeout(retryTimer);
    retryTimer = null;
  }
  function connect(g: number, attempt = 0) {
    if (!options.socketFactory || !current(g)) return;
    disconnect();
    const url = base
      .replace(/^http/, 'ws')
      .replace(/\/api\/v1\/?$/, '/api/v1/events');
    const ws = options.socketFactory(url);
    socket = ws;
    let ready = false;
    let highWater = '';
    let highPosition = '0';
    let syncing = false;
    socketDisposers.push(
      ws.onMessage((raw) => {
        if (!current(g) || typeof raw !== 'object' || raw === null) return;
        const value = raw as Record<string, unknown>;
        if (checkSchema(ReadyFrameSchema, value)) {
          ready = true;
          highWater = value.cursor;
          highPosition = value.position;
          const oldCursor = snapshot.syncCursor;
          syncing = true;
          bootstrapping = !oldCursor;
          const work = oldCursor
            ? sync(g, oldCursor, highWater, value.position)
            : loadSnapshot(g)
                .then(() => {
                  if (current(g))
                    update({
                      syncCursor: highWater,
                      snapshotPosition: value.position,
                    });
                })
                .then(() => sync(g, highWater));
          void work
            .then(() => {
              if (current(g)) {
                applyBuffered(g);
                syncing = false;
                bootstrapping = false;
              }
            })
            .catch(() => {
              syncing = false;
              bootstrapping = false;
              if (current(g)) ws.close();
            });
        } else if (checkSchema(EventSchema, value)) {
          const event = value as EventDto;
          if (!ready || syncing || bootstrapping) buffered.push(event);
          else if (cmp(event.eventId, highPosition) > 0) applyEvent(event, g);
          else applyEvent(event, g);
        }
      }),
    );
    socketDisposers.push(
      ws.onClose(() => {
        if (!current(g)) return;
        const delay =
          Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5)) *
          (0.8 + Math.random() * 0.4);
        retryTimer = clock.setTimeout(() => connect(g, attempt + 1), delay);
      }),
    );
  }
  async function login(input: {
    serverId: string;
    username: string;
    password: string;
  }) {
    const g = ++generation;
    disconnect();
    clearMessageRetries();
    buffered = [];
    lastEventId = '0';
    messageTombstones.clear();
    fileTombstones.clear();
    publish(emptySnapshot(g));
    try {
      await request('POST', '/session', input);
      const me = await request<{ data: CurrentUserDto }>(
        'GET',
        '/me',
        undefined,
        CurrentUserResponseSchema,
      );
      if (!current(g)) return null;
      update({ user: me.data });
      await loadSnapshot(g);
      if (!current(g)) return null;
      connect(g);
      scheduleSync(g);
      return me.data;
    } catch (error) {
      if (!current(g)) return null;
      if (current(g)) {
        publish(emptySnapshot(g));
      }
      throw error;
    }
  }
  async function resumeSession() {
    const g = ++generation;
    disconnect();
    clearMessageRetries();
    buffered = [];
    lastEventId = '0';
    messageTombstones.clear();
    fileTombstones.clear();
    publish(emptySnapshot(g));
    try {
      const me = await request<{ data: CurrentUserDto }>(
        'GET',
        '/me',
        undefined,
        CurrentUserResponseSchema,
      );
      if (!current(g)) return null;
      update({ user: me.data });
      await loadSnapshot(g);
      if (!current(g)) return null;
      connect(g);
      scheduleSync(g);
      return me.data;
    } catch (error) {
      if (!current(g)) return null;
      publish(emptySnapshot(g));
      if (error instanceof ClientError && error.code === 'unauthorized')
        return null;
      throw error;
    }
  }
  function scheduleSync(g: number) {
    if (syncTimer !== null) clock.clearTimeout(syncTimer);
    syncTimer = clock.setTimeout(() => {
      if (current(g)) {
        void sync(g).catch(() => undefined);
        scheduleSync(g);
      }
    }, 30_000);
  }
  async function logout(callServer = true) {
    const oldGeneration = generation;
    generation++;
    const newGeneration = generation;
    disconnect();
    clearMessageRetries();
    buffered = [];
    lastEventId = '0';
    messageTombstones.clear();
    fileTombstones.clear();
    if (syncTimer !== null) clock.clearTimeout(syncTimer);
    syncTimer = null;
    publish(emptySnapshot(newGeneration));
    latestRequestId = null;
    safeLog('client.state.cleared', 'success');
    try {
      if (callServer) {
        const response = await fetcher(`${base}/session`, {
          method: 'DELETE',
          credentials: 'include',
          headers: { accept: 'application/json' },
        });
        if (!response.ok && response.status !== 401)
          throw new ClientError(
            'unavailable',
            response.headers.get('X-Request-Id'),
          );
      }
    } catch (error) {
      // Local state stays cleared even when remote revocation did not complete.
      throw error instanceof ClientError ? error : new ClientError('network');
    }
    return oldGeneration;
  }
  async function sendMessage(
    conversationId: DecimalId,
    text: string,
    fileIds: readonly Uuid[] = [],
  ) {
    if (!snapshot.user) throw new ClientError('unauthorized');
    const id = ids.uuid();
    const createdAt = clock.now().getTime();
    const g = generation;
    const pending = [
      ...snapshot.pending,
      Object.freeze({
        conversationId,
        clientMessageId: id,
        text,
        fileIds: Object.freeze([...fileIds]),
        createdAt,
        state: 'pending' as const,
      }),
    ];
    update({ pending: Object.freeze(pending) });
    try {
      const result = await request<{ data: MessageOutput }>(
        'POST',
        `/conversations/${encodeURIComponent(conversationId)}/messages`,
        { clientMessageId: id, text, ...(fileIds.length ? { fileIds } : {}) },
        MessageResponseSchema,
      );
      mergeMessage(result.data, g);
      return result.data;
    } catch (error) {
      if (!current(g)) return null;
      const permanent =
        error instanceof ClientError &&
        [
          'conflict',
          'message_expired',
          'unauthorized',
          'forbidden',
          'not_found',
          'bad_request',
        ].includes(error.code);
      if (permanent) {
        update({
          pending: Object.freeze(
            snapshot.pending.map((p) =>
              p.clientMessageId === id
                ? Object.freeze({ ...p, state: 'failed' as const })
                : p,
            ),
          ),
        });
        safeLog('client.send.failed', 'rejected', { reason: error.code });
        if (error.code === 'unauthorized') void logout(false);
      } else {
        const item = snapshot.pending.find((p) => p.clientMessageId === id);
        if (item) scheduleMessageRetry(item);
      }
      throw error;
    }
  }
  async function retryMessage(clientMessageId: Uuid) {
    const pending = snapshot.pending.find(
      (p) => p.clientMessageId === clientMessageId,
    );
    if (!pending || !snapshot.user) return null;
    if (clock.now().getTime() - pending.createdAt >= 7 * 86_400_000) {
      update({
        pending: Object.freeze(
          snapshot.pending.map((p) =>
            p.clientMessageId === clientMessageId
              ? Object.freeze({ ...p, state: 'failed' as const })
              : p,
          ),
        ),
      });
      return null;
    }
    const g = generation;
    try {
      const result = await request<{ data: MessageOutput }>(
        'POST',
        `/conversations/${encodeURIComponent(pending.conversationId)}/messages`,
        {
          clientMessageId,
          text: pending.text,
          ...(pending.fileIds.length ? { fileIds: pending.fileIds } : {}),
        },
        MessageResponseSchema,
      );
      mergeMessage(result.data, g);
      return result.data;
    } catch (error) {
      if (!current(g)) return null;
      if (
        error instanceof ClientError &&
        ['conflict', 'message_expired', 'unauthorized'].includes(error.code)
      )
        update({
          pending: Object.freeze(
            snapshot.pending.map((p) =>
              p.clientMessageId === clientMessageId
                ? Object.freeze({ ...p, state: 'failed' as const })
                : p,
            ),
          ),
        });
      if (error instanceof ClientError && error.code === 'unauthorized') {
        void logout(false);
      } else if (!(
        error instanceof ClientError &&
        [
          'conflict',
          'message_expired',
          'forbidden',
          'not_found',
          'bad_request',
        ].includes(error.code)
      )) {
        const item = snapshot.pending.find(
          (p) => p.clientMessageId === clientMessageId,
        );
        if (item) scheduleMessageRetry(item);
      }
      throw error;
    }
  }
  const api = {
    getSnapshot: () => snapshot,
    getLastRequestId: () => latestRequestId,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    login,
    resumeSession,
    logout,
    getMe: async () => {
      const g = generation;
      const result = await request<{ data: CurrentUserDto }>(
        'GET',
        '/me',
        undefined,
        CurrentUserResponseSchema,
      );
      if (current(g)) update({ user: result.data });
      return result.data;
    },
    listServers: async () =>
      (
        await request<{ data: ServerDto[] }>(
          'GET',
          '/servers',
          undefined,
          ServerListResponseSchema,
        )
      ).data,
    listUsers: async (cursor?: string, limit = 50) => {
      const g = generation;
      const result = await request<{
        data: UserDto[];
        page: { nextCursor: string | null };
        snapshotCursor: string;
        snapshotPosition: string;
      }>(
        'GET',
        `/users?${new URLSearchParams({ ...(cursor ? { cursor } : {}), limit: String(limit) })}`,
        undefined,
        UserListResponseSchema,
      );
      if (current(g)) {
        const byId = new Map(snapshot.users.map((u) => [u.id, u]));
        for (const user of result.data) byId.set(user.id, user);
        update({ users: Object.freeze([...byId.values()]) });
      }
      return result;
    },
    listConversations: async (cursor?: string, limit = 50) => {
      const g = generation;
      const result = await request<{
        data: ConversationDto[];
        page: { nextCursor: string | null };
        snapshotCursor: string;
        snapshotPosition: string;
      }>(
        'GET',
        `/conversations?${new URLSearchParams({ ...(cursor ? { cursor } : {}), limit: String(limit) })}`,
        undefined,
        ConversationListResponseSchema,
      );
      if (current(g)) {
        const byId = new Map(snapshot.conversations.map((c) => [c.id, c]));
        for (const conversation of result.data)
          byId.set(conversation.id, conversation);
        update({ conversations: Object.freeze([...byId.values()]) });
      }
      return result;
    },
    createConversation: async (input: {
      kind: 'direct' | 'group';
      memberIds: readonly DecimalId[];
      title?: string;
      clientRequestId?: Uuid;
    }) => {
      const g = generation;
      const body = {
        ...input,
        clientRequestId: input.clientRequestId ?? ids.uuid(),
      };
      const r = await request<{ data: ConversationDto }>(
        'POST',
        '/conversations',
        body,
        ConversationResponseSchema,
      );
      if (current(g))
        update({
          conversations: Object.freeze([
            ...snapshot.conversations.filter((c) => c.id !== r.data.id),
            r.data,
          ]),
        });
      return r.data;
    },
    listMessages: async (
      id: DecimalId,
      query: { before?: DecimalId; after?: DecimalId; limit?: number } = {},
    ) => {
      const g = generation;
      const r = await request<{
        data: MessageOutput[];
        page: { nextCursor: string | null };
        snapshotCursor: string;
        snapshotPosition: string;
      }>(
        'GET',
        `/conversations/${encodeURIComponent(id)}/messages?${new URLSearchParams(
          Object.fromEntries(
            Object.entries(query)
              .filter(([, v]) => v !== undefined)
              .map(([k, v]) => [k, String(v)]),
          ),
        )}`,
        undefined,
        MessageListResponseSchema,
      );
      if (current(g)) for (const m of r.data) mergeMessage(m);
      return r;
    },
    sendMessage,
    retryMessage,
    uploadFile: async (
      conversationId: DecimalId,
      file: Blob,
      filename: string,
    ) => {
      const g = generation;
      const form = new FormData();
      form.append('file', file, filename);
      let res: Response;
      try {
        res = await fetcher(
          `${base}/conversations/${encodeURIComponent(conversationId)}/files`,
          { method: 'POST', credentials: 'include', body: form },
        );
      } catch {
        throw new ClientError('network');
      }
      if (!current(g)) throw new ClientError('unauthorized');
      latestRequestId = res.headers.get('X-Request-Id');
      let value: unknown;
      try {
        value = await res.json();
      } catch {
        throw new ClientError('invalid_response', latestRequestId);
      }
      if (!res.ok)
        throw new ClientError(
          checkSchema(ErrorEnvelopeSchema, value)
            ? value.error.code
            : 'internal',
        );
      if (!checkSchema(FileResponseSchema, value))
        throw new ClientError('invalid_response');
      return (value as { data: FileDto }).data;
    },
    downloadFile: async (id: Uuid) => {
      const g = generation;
      let res: Response;
      try {
        res = await fetcher(`${base}/files/${encodeURIComponent(id)}/content`, {
          credentials: 'include',
        });
      } catch {
        throw new ClientError('network');
      }
      if (!current(g)) throw new ClientError('unauthorized');
      latestRequestId = res.headers.get('X-Request-Id');
      if (!res.ok)
        throw new ClientError(
          res.status === 401 ? 'unauthorized' : 'not_found',
        );
      return res.blob();
    },
    advanceRead: (id: DecimalId, lastReadMessageId: DecimalId) =>
      request('PUT', `/conversations/${encodeURIComponent(id)}/read`, {
        lastReadMessageId,
      }),
    getRead: async (id: DecimalId) =>
      request(
        'GET',
        `/conversations/${encodeURIComponent(id)}/read`,
        undefined,
        ReadStateListResponseSchema,
      ),
    getRetention: async () =>
      request<{ data: RetentionPolicyDto }>(
        'GET',
        '/admin/retention',
        undefined,
        RetentionPolicyResponseSchema,
      ),
    updateRetention: (policy: { messageDays: number; fileDays: number }) =>
      request('PUT', '/admin/retention', policy),
    sync: () => sync(),
    dispose: () => {
      disposed = true;
      generation++;
      disconnect();
      clearMessageRetries();
      if (syncTimer !== null) clock.clearTimeout(syncTimer);
      listeners.clear();
      if (visibilitySource)
        visibilitySource.removeEventListener(
          'visibilitychange',
          visibilityListener,
        );
    },
  };
  const visibilityListener = () => {
    if (visibilitySource?.visibilityState === 'visible')
      void sync().catch(() => undefined);
  };
  visibilitySource?.addEventListener('visibilitychange', visibilityListener);
  return Object.freeze(api);
}
