import { DomainError } from '@j-messenger/contracts';
import type {
  AuditWriter,
  Clock,
  EntityReference,
  FeatureLog,
  RequestContext,
  SystemContext,
  TxContext,
  Uuid,
} from '@j-messenger/contracts';
import type { Database } from '../../platform/database/index.js';

export interface AuditRecord {
  readonly id: string;
  readonly action: string;
  readonly targetId: string | null;
  readonly outcome: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
  readonly requestId: Uuid;
  readonly occurredAt: string;
}
export interface AuditPage {
  readonly items: readonly AuditRecord[];
  readonly nextCursor: string | null;
}
export interface AuditOptions {
  readonly db: Database;
  readonly clock: Clock;
  readonly logger?: FeatureLog;
  readonly authorizeAdmin?: (context: RequestContext) => Promise<boolean>;
}
const safeAction = (v: string) =>
  /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,5}$/.test(v) && v.length <= 80;
const validTarget = (v: EntityReference | null): string | null => {
  if (v === null) return null;
  const s = String(v);
  if (!/^(?:[1-9][0-9]*|[0-9a-f]{8}-[0-9a-f-]{27})$/i.test(s))
    throw new DomainError('bad_request');
  return s;
};
const AUDIT_METADATA_KEYS = new Set([
  'count',
  'byteCount',
  'policyVersion',
  'messageDays',
  'attachmentDays',
  'reasonCode',
  'attempt',
  'result',
]);
const cleanMetadata = (
  m: Readonly<Record<string, string | number | boolean | null>>,
) => {
  const entries = Object.entries(m);
  if (entries.length > 20) throw new DomainError('bad_request');
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of entries) {
    if (
      !AUDIT_METADATA_KEYS.has(k) ||
      !(
        v === null ||
        typeof v === 'boolean' ||
        typeof v === 'number' ||
        typeof v === 'string'
      ) ||
      (typeof v === 'number' && !Number.isFinite(v)) ||
      (typeof v === 'string' &&
        (v.length > 128 || /[\r\n\u0000-\u001f]/.test(v)))
    )
      throw new DomainError('bad_request');
    out[k] = v;
  }
  return out;
};
const log = (
  o: AuditOptions,
  event: string,
  outcome: 'success' | 'rejected' | 'failure',
  ctx: RequestContext | SystemContext | undefined,
  fields: Record<string, string | number | boolean | null> = {},
) => {
  try {
    o.logger?.emit({
      featureId: 'F30',
      event,
      outcome,
      ...(ctx && 'requestId' in ctx ? { requestId: ctx.requestId } : {}),
      ...(ctx && 'jobId' in ctx && ctx.jobId ? { jobId: ctx.jobId } : {}),
      fields,
    });
  } catch {}
};
export function createAuditService(options: AuditOptions): AuditWriter & {
  list(
    context: RequestContext,
    cursor: string | null,
    limit: number,
  ): Promise<AuditPage>;
  purge(
    context: SystemContext,
    through: string,
    limit: number,
  ): Promise<{ purged: number }>;
  appendSystem(
    tx: TxContext,
    context: SystemContext,
    event: {
      action: string;
      targetId: EntityReference | null;
      metadata: Readonly<Record<string, string | number | boolean | null>>;
    },
  ): void;
} {
  const appendRow = (
    tx: TxContext,
    serverId: string,
    actorId: string | null,
    requestId: Uuid,
    event: {
      action: string;
      targetId: EntityReference | null;
      metadata: Readonly<Record<string, string | number | boolean | null>>;
    },
  ) => {
    options.db.assertOwn(tx);
    if (!/^[a-z0-9-]{1,32}$/.test(serverId) || !safeAction(event.action))
      throw new DomainError('bad_request');
    const metadata = cleanMetadata(event.metadata),
      now = options.clock.now().toISOString();
    options.db
      .prepare(
        'INSERT INTO audit_events(server_id,actor_id,action,target_id,outcome,metadata_json,request_id,occurred_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        serverId,
        actorId === null ? null : BigInt(actorId),
        event.action,
        validTarget(event.targetId),
        'success',
        JSON.stringify(metadata),
        requestId,
        now,
      );
    const id = options.db.lastInsertId();
    tx.afterCommit(() =>
      log(
        options,
        'audit.appended',
        'success',
        { serverId, requestId },
        {
          serverId,
          ...(actorId ? { userId: actorId } : {}),
          count: 1,
          auditId: id,
        },
      ),
    );
  };
  return {
    append(tx, context, event) {
      appendRow(tx, context.serverId, context.userId, context.requestId, event);
    },
    appendSystem(tx, context, event) {
      appendRow(tx, context.serverId, null, context.requestId, event);
    },
    async list(context, cursor, limit) {
      if (!options.authorizeAdmin || !(await options.authorizeAdmin(context))) {
        log(options, 'audit.listed', 'rejected', context, {
          serverId: context.serverId,
          reasonCode: 'forbidden',
        });
        throw new DomainError('forbidden');
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new DomainError('bad_request');
      if (cursor !== null && !/^[0-9]+$/.test(cursor))
        throw new DomainError('bad_request');
      const rows = options.db
        .prepare(
          'SELECT id,action,target_id,outcome,metadata_json,request_id,occurred_at FROM audit_events WHERE server_id=? AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?',
        )
        .all(
          context.serverId,
          cursor === null ? null : BigInt(cursor),
          cursor === null ? null : BigInt(cursor),
          limit + 1,
        ) as Array<Record<string, unknown>>;
      const page = rows.slice(0, limit),
        last = page.at(-1);
      const items = page.map((r) => ({
        id: String(r.id),
        action: String(r.action),
        targetId: r.target_id === null ? null : String(r.target_id),
        outcome: String(r.outcome),
        metadata: JSON.parse(String(r.metadata_json)) as Record<
          string,
          string | number | boolean | null
        >,
        requestId: String(r.request_id) as Uuid,
        occurredAt: String(r.occurred_at),
      }));
      log(options, 'audit.listed', 'success', context, {
        serverId: context.serverId,
        userId: context.userId,
        count: items.length,
      });
      return {
        items,
        nextCursor: rows.length > limit && last ? String(last.id) : null,
      };
    },
    async purge(context, through, limit) {
      if (
        !Number.isFinite(Date.parse(through)) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 1000
      )
        throw new DomainError('bad_request');
      const purged = await options.db.run((tx) => {
        options.db.assertOwn(tx);
        const result = options.db
          .prepare(
            'DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events WHERE server_id=? AND occurred_at<? ORDER BY id LIMIT ?)',
          )
          .run(context.serverId, through, limit);
        return Number(result.changes);
      });
      log(options, 'audit.retention.completed', 'success', context, {
        serverId: context.serverId,
        count: purged,
      });
      return { purged };
    },
  };
}
