import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  DomainError,
  isUtcDateTime,
  type Clock,
  type EventDto,
  type EventHydrator,
  type EventReader,
  type FeatureLog,
  type OpaqueCursorCodec,
  type PositionId,
  type ReadyFrame,
  type RequestContext,
  type SyncResponse,
} from '@j-messenger/contracts';
import type { Database } from '../../platform/database/index.js';

const MAX_SQLITE_ID = 9_223_372_036_854_775_807n;
const decimal = (value: string): boolean =>
  /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= MAX_SQLITE_ID;
export class SyncError extends DomainError {
  constructor(
    code: 'bad_request' | 'sync_reset_required' | 'internal' = 'internal',
  ) {
    super(code);
    this.name = 'SyncError';
  }
}
interface CursorClaims {
  readonly v: 1;
  readonly serverId: string;
  readonly userId: string;
  readonly epoch: string;
  readonly position: string;
  readonly expiresAt: string;
}
export interface CursorCodecOptions {
  readonly key: string | Uint8Array;
}
export function createCursorCodec(
  options: CursorCodecOptions,
): OpaqueCursorCodec {
  const key =
    typeof options.key === 'string'
      ? Buffer.from(options.key, 'utf8')
      : Buffer.from(options.key);
  if (key.byteLength < 32)
    throw new TypeError('cursor signing key must contain at least 32 bytes');
  const mac = (payload: string): Buffer =>
    createHmac('sha256', key).update(payload, 'ascii').digest();
  return {
    encode(claims) {
      if (
        !/^[a-z0-9-]{1,32}$/.test(claims.serverId) ||
        !/^[1-9][0-9]*$/.test(claims.userId) ||
        claims.epoch.length < 1 ||
        claims.epoch.length > 128 ||
        !decimal(claims.position) ||
        !isUtcDateTime(claims.expiresAt)
      )
        throw new SyncError('internal');
      const body = Buffer.from(
        JSON.stringify({ v: 1, ...claims } satisfies CursorClaims),
        'utf8',
      ).toString('base64url');
      return `${body}.${mac(body).toString('base64url')}`;
    },
    decode(token, expected) {
      if (typeof token !== 'string' || token.length > 4096)
        throw new SyncError('bad_request');
      const parts = token.split('.');
      if (
        parts.length !== 2 ||
        !/^[A-Za-z0-9_-]+$/.test(parts[0]!) ||
        !/^[A-Za-z0-9_-]+$/.test(parts[1]!)
      )
        throw new SyncError('bad_request');
      const actual = Buffer.from(parts[1]!, 'base64url');
      const wanted = mac(parts[0]!);
      if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted))
        throw new SyncError('bad_request');
      let value: unknown;
      try {
        value = JSON.parse(
          Buffer.from(parts[0]!, 'base64url').toString('utf8'),
        );
      } catch {
        throw new SyncError('bad_request');
      }
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new SyncError('bad_request');
      const c = value as Partial<CursorClaims>;
      if (
        c.v !== 1 ||
        c.serverId !== expected.serverId ||
        c.userId !== expected.userId ||
        typeof c.epoch !== 'string' ||
        c.epoch.length < 1 ||
        c.epoch.length > 128 ||
        typeof c.position !== 'string' ||
        !decimal(c.position) ||
        typeof c.expiresAt !== 'string' ||
        !isUtcDateTime(c.expiresAt)
      )
        throw new SyncError('bad_request');
      if (
        c.epoch !== expected.epoch ||
        Date.parse(c.expiresAt) <= expected.now.getTime()
      )
        throw new SyncError('sync_reset_required');
      return { position: c.position as PositionId, expiresAt: c.expiresAt };
    },
  };
}

export interface SyncOptions {
  readonly db: Database;
  readonly reader?: EventReader;
  readonly hydrator: EventHydrator;
  readonly cursorCodec: OpaqueCursorCodec;
  readonly clock: Clock;
  readonly logger?: FeatureLog;
  readonly cursorDays?: number;
  readonly scanLimit?: number;
}
export interface SyncService {
  ready(context: RequestContext): Promise<ReadyFrame>;
  initialCursor(context: RequestContext): string;
  sync(
    context: RequestContext,
    input: { after: string | null; through?: string; limit: number },
  ): Promise<SyncResponse>;
}
const compare = (a: string, b: string): number =>
  a.length === b.length ? (a < b ? -1 : a > b ? 1 : 0) : a.length - b.length;

export function createSyncService(options: SyncOptions): SyncService {
  const reader = options.reader ?? options.db.eventReader;
  const days = options.cursorDays ?? 7;
  const scanLimit = options.scanLimit ?? 1000;
  if (
    !Number.isSafeInteger(days) ||
    days < 1 ||
    days > 30 ||
    !Number.isSafeInteger(scanLimit) ||
    scanLimit < 1 ||
    scanLimit > 5000
  )
    throw new TypeError('invalid sync limits');
  const epoch = (): string => options.db.getStreamMetadata().epoch;
  const encode = (
    context: RequestContext,
    position: string,
    streamEpoch = epoch(),
  ): string =>
    options.cursorCodec.encode({
      serverId: context.serverId,
      userId: context.userId,
      epoch: streamEpoch,
      position: position as PositionId,
      expiresAt: new Date(
        options.clock.now().getTime() + days * 86_400_000,
      ).toISOString(),
    });
  const decode = (
    context: RequestContext,
    token: string,
    streamEpoch = epoch(),
  ): string =>
    options.cursorCodec.decode(token, {
      serverId: context.serverId,
      userId: context.userId,
      epoch: streamEpoch,
      now: options.clock.now(),
    }).position;
  const log = (
    context: RequestContext,
    event: string,
    outcome: 'success' | 'rejected' | 'failure',
    fields: Record<string, string | number | boolean | null>,
  ): void => {
    try {
      options.logger?.emit({
        featureId: 'F16',
        event,
        outcome,
        requestId: context.requestId,
        fields,
      });
    } catch {
      /* logging does not affect sync */
    }
  };
  return {
    async ready(context) {
      const initialEpoch = epoch();
      const position = await reader.highWatermark(context);
      if (epoch() !== initialEpoch) throw new SyncError('sync_reset_required');
      return {
        type: 'ready',
        cursor: encode(context, position, initialEpoch),
        position: position as PositionId,
      };
    },
    initialCursor(context) {
      return encode(context, '0');
    },
    async sync(context, input) {
      if (
        !input ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 100
      )
        throw new SyncError('bad_request');
      const startEpoch = epoch();
      let after: string;
      let through: string;
      let throughPosition: string;
      try {
        after =
          input.after === null ? '0' : decode(context, input.after, startEpoch);
        if (input.through === undefined) {
          throughPosition = await reader.highWatermark(context);
          if (epoch() !== startEpoch)
            throw new SyncError('sync_reset_required');
          through = encode(context, throughPosition, startEpoch);
        } else {
          through = input.through;
          throughPosition = decode(context, through, startEpoch);
        }
      } catch (error) {
        if (error instanceof SyncError) throw error;
        if (error instanceof DomainError) throw error;
        throw new SyncError('bad_request');
      }
      const meta = options.db.getStreamMetadata();
      if (meta.epoch !== startEpoch) throw new SyncError('sync_reset_required');
      if (
        !decimal(after) ||
        !decimal(throughPosition) ||
        compare(after, throughPosition) > 0 ||
        compare(throughPosition, meta.lastSequence) > 0
      )
        throw new SyncError('bad_request');
      if (compare(after, meta.minValidPosition) < 0)
        throw new SyncError('sync_reset_required');
      const scanned = await reader.scan(
        context,
        after as PositionId,
        throughPosition as PositionId,
        scanLimit,
      );
      if (
        !decimal(scanned.scannedThrough) ||
        compare(scanned.scannedThrough, after) < 0 ||
        compare(scanned.scannedThrough, throughPosition) > 0
      )
        throw new SyncError('internal');
      const data: EventDto[] = [];
      let stoppedAt: string | null = null;
      let remainingRows = false;
      for (let index = 0; index < scanned.rows.length; index++) {
        const row = scanned.rows[index]!;
        const event = await options.hydrator.hydrate(context, row);
        if (event) data.push(event);
        if (data.length === input.limit) {
          stoppedAt = row.id;
          remainingRows = index + 1 < scanned.rows.length;
          break;
        }
      }
      if (options.db.getStreamMetadata().epoch !== startEpoch)
        throw new SyncError('sync_reset_required');
      // EventReader scans a bounded raw range. Cursor advances through hidden rows even when data is empty.
      const scannedThrough =
        stoppedAt !== null && remainingRows
          ? stoppedAt
          : scanned.scannedThrough;
      const hasMore = remainingRows || scanned.hasMore;
      const nextCursor = encode(context, scannedThrough, startEpoch);
      log(context, 'sync.page.completed', 'success', {
        count: data.length,
        processedCount: scanned.rows.length,
        skippedCount: scanned.rows.length - data.length,
        hasMore,
      });
      return {
        data,
        nextCursor,
        hasMore,
        through,
        throughPosition: throughPosition as PositionId,
        scannedThrough: scannedThrough as PositionId,
      };
    },
  };
}
