import { createHash } from 'node:crypto';
import { DomainError } from '@j-messenger/contracts';
import type {
  Clock,
  FeatureLog,
  IdFactory,
  JobHandler,
  JobResult,
  JobRunner,
  TxContext,
  Uuid,
} from '@j-messenger/contracts';
import type { Migration } from '../database/index.js';
import {
  asStorage,
  type StorageDatabase,
  type StorageInput,
} from '../storage/index.js';

export const JOB_MIGRATION: Migration = Object.freeze({
  version: 2,
  sql: `
CREATE TABLE platform_jobs (
 id TEXT PRIMARY KEY,
 server_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 request_id TEXT,
 dedup_key TEXT,
 status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
 attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
 next_run_at TEXT NOT NULL,
 lease_owner TEXT,
 lease_until TEXT,
 reason_code TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 completed_at TEXT,
 CHECK ((status='running' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL) OR (status<>'running' AND lease_owner IS NULL AND lease_until IS NULL)),
 UNIQUE(server_id,dedup_key)
);
CREATE INDEX platform_jobs_due_idx ON platform_jobs(status,next_run_at,created_at);
CREATE INDEX platform_jobs_lease_idx ON platform_jobs(status,lease_until);
`,
});

export class JobStoreError extends DomainError {
  constructor(code: 'conflict' | 'not_found' | 'internal' = 'internal') {
    super(code, '작업 요청을 처리할 수 없습니다.');
    this.name = 'JobStoreError';
  }
}

export interface EnqueueInput {
  readonly id?: Uuid;
  readonly kind: string;
  readonly payload: unknown;
  readonly requestId?: Uuid;
  readonly dedupKey?: string;
  readonly serverId?: string;
}
export interface JobStoreOptions {
  readonly clock: Clock;
  readonly idFactory: IdFactory;
  readonly logger?: FeatureLog;
}
export interface StoredJob<T = unknown> {
  readonly id: Uuid;
  readonly serverId: string;
  readonly kind: string;
  readonly payload: T;
  readonly requestId: Uuid | null;
  readonly attempt: number;
  readonly status: 'pending' | 'running' | 'completed' | 'failed';
  readonly nextRunAt: string;
  readonly leaseOwner: Uuid | null;
  readonly leaseUntil: string | null;
  readonly reasonCode: string | null;
  readonly createdAt: string;
}
interface JobRow extends Record<string, unknown> {
  id: string;
  server_id: string;
  kind: string;
  payload_json: string;
  request_id: string | null;
  status: StoredJob['status'];
  attempt: number | bigint;
  next_run_at: string;
  lease_owner: string | null;
  lease_until: string | null;
  reason_code: string | null;
  created_at: string;
}
const iso = (date: Date): string => {
  const value = date.getTime();
  if (!Number.isFinite(value)) throw new TypeError('invalid clock');
  return date.toISOString();
};
const stable = (value: unknown): string => {
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(visit);
    if (
      typeof item === 'object' &&
      item !== null &&
      Object.getPrototypeOf(item) === Object.prototype
    ) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, visit((item as Record<string, unknown>)[key])]),
      );
    }
    throw new TypeError('job payload must be JSON data');
  };
  return JSON.stringify(visit(value));
};
const mapJob = (row: JobRow): StoredJob => ({
  id: row.id as Uuid,
  serverId: row.server_id,
  kind: row.kind,
  payload: JSON.parse(row.payload_json) as unknown,
  requestId: row.request_id as Uuid | null,
  attempt: Number(row.attempt),
  status: row.status,
  nextRunAt: row.next_run_at,
  leaseOwner: row.lease_owner as Uuid | null,
  leaseUntil: row.lease_until,
  reasonCode: row.reason_code,
  createdAt: row.created_at,
});
const validateKind = (kind: string): void => {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(kind) || kind.length > 80)
    throw new TypeError('invalid job kind');
};
const validUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
const emit = (
  logger: FeatureLog | undefined,
  event: string,
  outcome: 'success' | 'rejected' | 'failure',
  job: { id: Uuid; requestId?: Uuid | null },
  fields: Record<string, string | number | boolean | null> = {},
): void => {
  try {
    logger?.emit({
      featureId: 'F42',
      event,
      outcome,
      ...(job.requestId ? { requestId: job.requestId } : {}),
      jobId: job.id,
      fields,
    });
  } catch {
    /* logging cannot change durable job state */
  }
};

export class JobStore {
  private readonly db: StorageDatabase;
  private readonly clock: Clock;
  private readonly ids: IdFactory;
  private readonly logger: FeatureLog | undefined;
  constructor(db: StorageInput, options: JobStoreOptions) {
    this.db = asStorage(db);
    this.clock = options.clock;
    this.ids = options.idFactory;
    this.logger = options.logger;
  }

  async enqueue(tx: TxContext, input: EnqueueInput): Promise<Uuid> {
    this.db.assertOwn(tx);
    validateKind(input.kind);
    if (
      input.serverId !== undefined &&
      !/^[a-z0-9-]{1,32}$/.test(input.serverId)
    )
      throw new TypeError('invalid server id');
    if (
      (input.id !== undefined && !validUuid(input.id)) ||
      (input.requestId !== undefined && !validUuid(input.requestId))
    )
      throw new TypeError('invalid job identifier');
    if (
      input.dedupKey !== undefined &&
      (!input.dedupKey ||
        input.dedupKey.length > 256 ||
        /[\r\n\u0000-\u001f]/.test(input.dedupKey))
    )
      throw new TypeError('invalid dedup key');
    const payload = stable(input.payload);
    const hash = createHash('sha256').update(payload).digest('hex');
    const serverId = input.serverId ?? '';
    if (input.dedupKey !== undefined) {
      const existing = (await this.db
        .prepare(
          'SELECT id,kind,payload_hash FROM platform_jobs WHERE server_id=? AND dedup_key=?',
        )
        .get(serverId, input.dedupKey)) as
        { id: Uuid; kind: string; payload_hash: string } | undefined;
      if (existing) {
        if (existing.kind !== input.kind || existing.payload_hash !== hash)
          throw new JobStoreError('conflict');
        return existing.id;
      }
    }
    const id = input.id ?? this.ids.uuid();
    if (!validUuid(id)) throw new TypeError('invalid job identifier');
    const now = iso(this.clock.now());
    await this.db
      .prepare(
        `INSERT INTO platform_jobs(id,server_id,kind,payload_json,payload_hash,request_id,dedup_key,status,attempt,next_run_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'pending',0,?,?,?)`,
      )
      .run(
        id,
        serverId,
        input.kind,
        payload,
        hash,
        input.requestId ?? null,
        input.dedupKey ?? null,
        now,
        now,
        now,
      );
    return id;
  }

  async get(tx: TxContext, id: Uuid): Promise<StoredJob | null> {
    this.db.assertOwn(tx);
    const row = (await this.db
      .prepare('SELECT * FROM platform_jobs WHERE id=?')
      .get(id)) as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  async resume(tx: TxContext, id: Uuid): Promise<void> {
    this.db.assertOwn(tx);
    const now = iso(this.clock.now());
    const result = await this.db
      .prepare(
        "UPDATE platform_jobs SET status='pending',attempt=0,next_run_at=?,lease_owner=NULL,lease_until=NULL,reason_code=NULL,updated_at=? WHERE id=? AND status='failed'",
      )
      .run(now, now, id);
    if (result.changes === 0 || result.changes === 0n)
      throw new JobStoreError('not_found');
    tx.afterCommit(() => emit(this.logger, 'job.resumed', 'success', { id }));
  }

  async claim(
    tx: TxContext,
    owner: Uuid,
    leaseMs: number,
    maxAttempts: number,
  ): Promise<StoredJob | null> {
    this.db.assertOwn(tx);
    const current = this.clock.now();
    const now = iso(current);
    const leaseUntil = iso(new Date(current.getTime() + leaseMs));
    const row = (await this.db
      .prepare(
        "SELECT * FROM platform_jobs WHERE (status='pending' AND next_run_at<=?) OR (status='running' AND lease_until<=?) ORDER BY next_run_at,created_at,id LIMIT 1",
      )
      .get(now, now)) as JobRow | undefined;
    if (!row) return null;
    const attempt = Number(row.attempt) + 1;
    if (attempt > maxAttempts) {
      await this.db
        .prepare(
          "UPDATE platform_jobs SET status='failed',attempt=?,lease_owner=NULL,lease_until=NULL,reason_code='max_attempts',updated_at=? WHERE id=?",
        )
        .run(attempt, now, row.id);
      tx.afterCommit(() =>
        emit(
          this.logger,
          'job.failed',
          'failure',
          { id: row.id as Uuid, requestId: row.request_id },
          { attempt, reasonCode: 'max_attempts' },
        ),
      );
      return mapJob({
        ...row,
        status: 'failed',
        attempt,
        lease_owner: null,
        lease_until: null,
        reason_code: 'max_attempts',
      });
    }
    const changed = await this.db
      .prepare(
        "UPDATE platform_jobs SET status='running',attempt=?,lease_owner=?,lease_until=?,reason_code=NULL,updated_at=? WHERE id=? AND ((status='pending' AND next_run_at<=?) OR (status='running' AND lease_until<=?))",
      )
      .run(attempt, owner, leaseUntil, now, row.id, now, now);
    if (changed.changes === 0 || changed.changes === 0n) return null;
    return mapJob({
      ...row,
      status: 'running',
      attempt,
      lease_owner: owner,
      lease_until: leaseUntil,
      reason_code: null,
    });
  }

  async complete(tx: TxContext, job: StoredJob, owner: Uuid): Promise<boolean> {
    this.db.assertOwn(tx);
    const now = iso(this.clock.now());
    const changed = await this.db
      .prepare(
        "UPDATE platform_jobs SET status='completed',lease_owner=NULL,lease_until=NULL,reason_code=NULL,completed_at=?,updated_at=? WHERE id=? AND status='running' AND lease_owner=? AND lease_until>?",
      )
      .run(now, now, job.id, owner, now);
    return changed.changes !== 0 && changed.changes !== 0n;
  }
  async retry(
    tx: TxContext,
    job: StoredJob,
    owner: Uuid,
    at: Date,
    reasonCode: string,
  ): Promise<boolean> {
    this.db.assertOwn(tx);
    const now = iso(this.clock.now());
    const changed = await this.db
      .prepare(
        "UPDATE platform_jobs SET status='pending',next_run_at=?,lease_owner=NULL,lease_until=NULL,reason_code=?,updated_at=? WHERE id=? AND status='running' AND lease_owner=? AND lease_until>?",
      )
      .run(iso(at), reasonCode, now, job.id, owner, now);
    return changed.changes !== 0 && changed.changes !== 0n;
  }
  async fail(
    tx: TxContext,
    job: StoredJob,
    owner: Uuid,
    reasonCode: string,
  ): Promise<boolean> {
    this.db.assertOwn(tx);
    const now = iso(this.clock.now());
    const changed = await this.db
      .prepare(
        "UPDATE platform_jobs SET status='failed',lease_owner=NULL,lease_until=NULL,reason_code=?,updated_at=? WHERE id=? AND status='running' AND lease_owner=? AND lease_until>?",
      )
      .run(reasonCode, now, job.id, owner, now);
    return changed.changes !== 0 && changed.changes !== 0n;
  }
}

export interface JobRunnerOptions {
  readonly db: StorageInput;
  readonly store: JobStore;
  readonly clock: Clock;
  readonly idFactory: IdFactory;
  readonly logger?: FeatureLog;
  readonly handlers: readonly JobHandler[];
  readonly leaseMs?: number;
  readonly handlerTimeoutMs?: number;
  readonly maxAttempts?: number;
}
export function createJobRunner(
  options: JobRunnerOptions,
): JobRunner & { stop(): void } {
  const leaseMs = options.leaseMs ?? 30_000;
  const timeoutMs = options.handlerTimeoutMs ?? Math.min(leaseMs - 1, 25_000);
  const maxAttempts = options.maxAttempts ?? 10;
  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 10 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs >= leaseMs ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1
  )
    throw new TypeError('invalid job runner options');
  const db = asStorage(options.db);
  const handlers = new Map<string, JobHandler>();
  for (const handler of options.handlers) {
    validateKind(handler.kind);
    if (handlers.has(handler.kind))
      throw new TypeError('duplicate job handler');
    handlers.set(handler.kind, handler);
  }
  const owner = options.idFactory.uuid();
  if (!validUuid(owner)) throw new TypeError('invalid runner owner');
  let stopped = false;
  const finishFailure = async (
    job: StoredJob,
    code: string,
    attemptResult: 'retry' | 'failed',
    requestedAt?: string,
  ): Promise<boolean> =>
    db.run(async (tx) => {
      if (attemptResult === 'failed')
        return await options.store.fail(tx, job, owner, code);
      const now = options.clock.now();
      const fallback = Math.min(
        300_000,
        1000 * 2 ** Math.max(0, job.attempt - 1),
      );
      const parsed = requestedAt === undefined ? NaN : Date.parse(requestedAt);
      const requestedDelay = Number.isFinite(parsed)
        ? parsed - now.getTime()
        : fallback;
      const delay = Math.max(1000, Math.min(300_000, requestedDelay));
      return await options.store.retry(
        tx,
        job,
        owner,
        new Date(now.getTime() + delay),
        code,
      );
    });
  return {
    stop() {
      stopped = true;
    },
    async runBatch(limit: number) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        throw new TypeError('invalid job batch limit');
      let completed = 0,
        retried = 0,
        failed = 0;
      for (let i = 0; i < limit && !stopped; i++) {
        const job = await db.run(
          async (tx) =>
            await options.store.claim(tx, owner, leaseMs, maxAttempts),
        );
        if (!job) break;
        if (job.status === 'failed') {
          failed++;
          continue;
        }
        emit(options.logger, 'job.started', 'success', job, {
          attempt: job.attempt,
          phase: 'handler',
        });
        const handler = handlers.get(job.kind);
        if (!handler) {
          if (await finishFailure(job, 'handler_missing', 'failed')) failed++;
          emit(options.logger, 'job.failed', 'failure', job, {
            attempt: job.attempt,
            reasonCode: 'handler_missing',
          });
          continue;
        }
        let timeout: ReturnType<typeof setTimeout>;
        const timer = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        });
        let result: JobResult;
        try {
          result = await Promise.race([
            handler.handle({
              id: job.id,
              kind: job.kind,
              payload: job.payload,
              attempt: job.attempt,
              requestId: job.requestId,
            }),
            timer,
          ]);
        } catch {
          const terminal = job.attempt >= maxAttempts;
          const code = 'handler_error';
          if (await finishFailure(job, code, terminal ? 'failed' : 'retry')) {
            if (terminal) failed++;
            else retried++;
            emit(
              options.logger,
              terminal ? 'job.failed' : 'job.retry',
              terminal ? 'failure' : 'rejected',
              job,
              { attempt: job.attempt, reasonCode: code },
            );
          }
          continue;
        } finally {
          clearTimeout(timeout!);
        }
        if (result.status === 'completed') {
          const changed = await db.run(
            async (tx) => await options.store.complete(tx, job, owner),
          );
          if (changed) {
            completed++;
            emit(options.logger, 'job.completed', 'success', job, {
              attempt: job.attempt,
            });
          }
        } else if (result.status === 'failed' || job.attempt >= maxAttempts) {
          const code =
            result.status === 'failed' ? 'handler_failed' : 'max_attempts';
          if (await finishFailure(job, code, 'failed')) {
            failed++;
            emit(options.logger, 'job.failed', 'failure', job, {
              attempt: job.attempt,
              reasonCode: code,
            });
          }
        } else {
          const code = 'handler_retry';
          if (await finishFailure(job, code, 'retry', result.retryAt)) {
            retried++;
            emit(options.logger, 'job.retry', 'rejected', job, {
              attempt: job.attempt,
              reasonCode: code,
            });
          }
        }
      }
      return { completed, retried, failed };
    },
  };
}
