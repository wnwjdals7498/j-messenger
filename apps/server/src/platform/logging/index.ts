import { Writable } from 'node:stream';
import pino from 'pino';
import type {
  Clock,
  FeatureLog,
  SafeLogEvent,
  TxContext,
} from '@j-messenger/contracts';
import { assertSafeLogEvent } from '@j-messenger/contracts';
import type { LogLevel } from '../config/index.js';

export interface LoggerOptions {
  readonly release: string;
  readonly module: string;
  readonly level: LogLevel;
  readonly clock?: Clock;
  /** Test/host integration sink. Production defaults to JSON on stdout. */
  readonly sink?: (record: Readonly<Record<string, unknown>>) => void;
}

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 30,
  warn: 40,
  error: 50,
};
const diagnosticRecord = {
  level: 40,
  event: 'logging.entry.dropped',
  outcome: 'failure',
} as const;

export function createLogger(options: LoggerOptions): FeatureLog {
  const threshold = levelPriority[options.level];
  const destination = options.sink
    ? new Writable({
        write(chunk, _encoding, callback) {
          try {
            options.sink!(JSON.parse(String(chunk)) as Record<string, unknown>);
          } catch {
            writeDiagnostic();
          }
          callback();
        },
      })
    : process.stdout;
  const backend = pino(
    {
      level: options.level,
      base: {
        release: safeLabel(options.release),
        module: safeLabel(options.module),
      },
      timestamp: () =>
        `,"time":${JSON.stringify((options.clock?.now() ?? new Date()).toISOString())}`,
    },
    destination,
  );

  function writeDiagnostic(): void {
    try {
      if (options.sink) options.sink(diagnosticRecord);
      else process.stderr.write(`${JSON.stringify(diagnosticRecord)}\n`);
    } catch {
      try {
        process.stderr.write(`${JSON.stringify(diagnosticRecord)}\n`);
      } catch {
        /* no safe diagnostic channel remains */
      }
    }
  }

  const emit = (event: SafeLogEvent): void => {
    try {
      assertSafeLogEvent(event);
      const priority =
        event.outcome === 'failure'
          ? 50
          : /(?:\.retry|\.warn)$/.test(event.event)
            ? 40
            : 30;
      if (priority < threshold) return;
      const record: Record<string, unknown> = {
        featureId: event.featureId,
        event: event.event,
        outcome: event.outcome,
        ...(event.requestId === undefined
          ? {}
          : { requestId: event.requestId }),
        ...(event.jobId === undefined ? {} : { jobId: event.jobId }),
        ...event.fields,
      };
      backend[priority === 50 ? 'error' : priority === 40 ? 'warn' : 'info'](
        record,
      );
    } catch {
      // Never stringify the rejected event or the sink exception.
      writeDiagnostic();
    }
  };
  return Object.freeze({
    emit,
    afterCommit(tx: TxContext, event: SafeLogEvent): void {
      try {
        assertSafeLogEvent(event);
        if (event.outcome !== 'success') return;
        tx.afterCommit(() => emit(event));
      } catch {
        writeDiagnostic();
      }
    },
  });
}

function safeLabel(value: string): string {
  return /^[a-zA-Z0-9._-]{1,80}$/.test(value) ? value : 'unknown';
}
