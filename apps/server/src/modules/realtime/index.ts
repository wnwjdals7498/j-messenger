import type { FastifyInstance, FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import {
  type Clock,
  type EventHydrator,
  type FeatureLog,
  type ReadyFrame,
  type RequestContext,
  type SessionResolver,
} from '@j-messenger/contracts';
import { requireContext, routeConfig } from '../../platform/http/index.js';
import type { AppConfig } from '../../platform/config/index.js';
import type { Database } from '../../platform/database/index.js';
import type { SyncService } from '../sync/index.js';

interface ActiveSessionResolver extends SessionResolver {
  sessionActive(context: RequestContext): boolean;
}
export interface RealtimeOptions {
  readonly db: Database;
  readonly config: AppConfig;
  readonly resolver: ActiveSessionResolver;
  readonly sync: SyncService;
  readonly hydrator: EventHydrator;
  readonly clock: Clock;
  readonly logger?: FeatureLog;
  readonly path?: string;
  readonly pollMs?: number;
  readonly heartbeatMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly maxBufferedBytes?: number;
}
interface Peer {
  readonly socket: WebSocket;
  readonly context: RequestContext;
  position: string;
  lastPongAt: number;
  paused: boolean;
  closed: boolean;
  openedAt: number;
}
export interface RealtimeService {
  registerRoutes(scope: FastifyInstance): void;
  close(): void;
  poll(): Promise<void>;
}

export function createRealtimeService(
  options: RealtimeOptions,
): RealtimeService {
  const peers = new Set<Peer>();
  const pollMs = options.pollMs ?? 250;
  const heartbeatMs = options.heartbeatMs ?? 25_000;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 60_000;
  const maxBufferedBytes = options.maxBufferedBytes ?? 1_000_000;
  if (
    ![pollMs, heartbeatMs, heartbeatTimeoutMs, maxBufferedBytes].every(
      Number.isSafeInteger,
    ) ||
    pollMs < 25 ||
    heartbeatMs < 1000 ||
    heartbeatTimeoutMs < heartbeatMs ||
    maxBufferedBytes < 1024
  )
    throw new TypeError('invalid realtime limits');
  let timer: ReturnType<typeof setInterval> | undefined;
  const emit = (
    peer: Peer | undefined,
    event: string,
    outcome: 'success' | 'rejected' | 'failure',
    fields: Record<string, string | number | boolean | null>,
  ): void => {
    try {
      options.logger?.emit({
        featureId: 'F14',
        event,
        outcome,
        ...(peer ? { requestId: peer.context.requestId } : {}),
        fields,
      });
    } catch {
      /* diagnostics do not affect delivery */
    }
  };
  const closePeer = (peer: Peer, reason: string, code = 1000): void => {
    if (peer.closed) return;
    peer.closed = true;
    peers.delete(peer);
    try {
      peer.socket.close(code, reason);
    } catch {
      try {
        peer.socket.terminate();
      } catch {}
    }
    emit(peer, 'realtime.connection.closed', 'success', {
      serverId: peer.context.serverId,
      userId: peer.context.userId,
      reasonCode: reason,
      durationMs: Math.max(0, options.clock.now().getTime() - peer.openedAt),
      queueBytes: peer.socket.bufferedAmount,
    });
  };
  const send = (peer: Peer, value: unknown): boolean => {
    if (peer.closed || peer.socket.readyState !== 1) return false;
    try {
      const payload = JSON.stringify(value);
      if (
        peer.socket.bufferedAmount + Buffer.byteLength(payload, 'utf8') >
        maxBufferedBytes
      ) {
        closePeer(peer, 'backpressure', 1013);
        return false;
      }
      peer.socket.send(payload);
      return true;
    } catch {
      closePeer(peer, 'send_failed', 1011);
      return false;
    }
  };
  const ready = async (peer: Peer): Promise<void> => {
    // Register the peer before taking the high-water snapshot. Polling stays paused until ready is sent.
    const frame: ReadyFrame = await options.sync.ready(peer.context);
    peer.position = frame.position;
    if (send(peer, frame)) peer.paused = false;
  };
  const pollPeer = async (peer: Peer): Promise<void> => {
    if (peer.closed || peer.paused) return;
    if (!options.resolver.sessionActive(peer.context)) {
      closePeer(peer, 'session_revoked', 4001);
      return;
    }
    if (options.clock.now().getTime() - peer.lastPongAt > heartbeatTimeoutMs) {
      closePeer(peer, 'heartbeat_timeout', 4000);
      return;
    }
    if (peer.socket.bufferedAmount > maxBufferedBytes) {
      closePeer(peer, 'backpressure', 1013);
      return;
    }
    const through = await options.db.eventReader.highWatermark(peer.context);
    if (BigInt(through) <= BigInt(peer.position)) return;
    const page = await options.db.eventReader.scan(
      peer.context,
      peer.position,
      through,
      100,
    );
    for (const record of page.rows) {
      const event = await options.hydrator.hydrate(peer.context, record);
      if (event && !send(peer, event)) return;
    }
    peer.position = page.scannedThrough;
  };
  const poll = async (): Promise<void> => {
    for (const peer of [...peers]) {
      try {
        await pollPeer(peer);
      } catch {
        closePeer(peer, 'delivery_failed', 1011);
        emit(peer, 'realtime.delivery.failed', 'failure', {
          serverId: peer.context.serverId,
          userId: peer.context.userId,
          reasonCode: 'delivery_failed',
        });
      }
    }
  };
  const startTimer = (): void => {
    if (!timer)
      timer = setInterval(() => {
        void poll();
      }, pollMs);
  };
  const registerRoutes = (scope: FastifyInstance): void => {
    scope.get(
      options.path ?? '/api/v1/events',
      { websocket: true, config: routeConfig('authRequired') },
      (socket: WebSocket, request: FastifyRequest) => {
        const context = requireContext(request);
        const cookiePresented = typeof request.cookies?.jm_session === 'string';
        const bearerPresented = request.headers.authorization !== undefined;
        const origin = request.headers.origin;
        const originDenied = cookiePresented
          ? origin !== options.config.publicOrigin
          : origin !== undefined && origin !== options.config.publicOrigin;
        const query = request.url.split('?', 2)[1] ?? '';
        const credentialInQuery = [...new URLSearchParams(query).keys()].some(
          (key) => /(?:token|credential|authorization|auth)/i.test(key),
        );
        if (
          originDenied ||
          credentialInQuery ||
          cookiePresented === bearerPresented ||
          !options.resolver.sessionActive(context)
        ) {
          emit(undefined, 'realtime.connection.rejected', 'rejected', {
            serverId: context.serverId,
            userId: context.userId,
            reasonCode: 'unauthorized',
          });
          socket.close(1008, 'unauthorized');
          return;
        }
        const peer: Peer = {
          socket,
          context,
          position: '0',
          lastPongAt: options.clock.now().getTime(),
          paused: true,
          closed: false,
          openedAt: options.clock.now().getTime(),
        };
        peers.add(peer);
        startTimer();
        socket.on('pong', () => {
          peer.lastPongAt = options.clock.now().getTime();
        });
        socket.on('close', () => {
          if (!peer.closed) {
            peer.closed = true;
            peers.delete(peer);
            emit(peer, 'realtime.connection.closed', 'success', {
              serverId: context.serverId,
              userId: context.userId,
              reasonCode: 'client_closed',
              durationMs: Math.max(
                0,
                options.clock.now().getTime() - peer.openedAt,
              ),
              queueBytes: socket.bufferedAmount,
            });
          }
        });
        socket.on('error', () => closePeer(peer, 'socket_error', 1011));
        const heartbeat = setInterval(() => {
          if (!peer.closed && socket.readyState === 1) {
            if (
              options.clock.now().getTime() - peer.lastPongAt >
              heartbeatTimeoutMs
            )
              closePeer(peer, 'heartbeat_timeout', 4000);
            else {
              try {
                socket.ping();
              } catch {
                closePeer(peer, 'heartbeat_failed', 1011);
              }
            }
          }
        }, heartbeatMs);
        socket.once('close', () => clearInterval(heartbeat));
        void ready(peer)
          .then(() =>
            emit(peer, 'realtime.connection.opened', 'success', {
              serverId: context.serverId,
              userId: context.userId,
            }),
          )
          .catch(() => closePeer(peer, 'ready_failed', 1011));
      },
    );
  };
  return {
    registerRoutes,
    close() {
      if (timer) clearInterval(timer);
      timer = undefined;
      for (const peer of [...peers]) closePeer(peer, 'server_shutdown');
    },
    poll,
  };
}
