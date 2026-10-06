import { describe, expect, it } from 'vitest';
import type { SafeLogEvent, TxContext } from '@j-messenger/contracts';
import { createLogger } from '../../src/platform/logging/index.js';

const event = (
  fields: SafeLogEvent['fields'] = {},
  outcome: SafeLogEvent['outcome'] = 'success',
): SafeLogEvent => ({
  featureId: 'F38',
  event: 'config.validated',
  outcome,
  fields,
});

function txFake() {
  const callbacks: Array<() => void | Promise<void>> = [];
  const tx: TxContext = {
    active: true,
    assertActive() {
      if (!this.active) throw new Error('inactive');
    },
    afterCommit(effect) {
      callbacks.push(effect);
    },
  };
  return { tx, callbacks };
}

describe('safeFeatureLog', () => {
  it('keeps only safe fields and never prints secret request material or raw errors', () => {
    const captured: Readonly<Record<string, unknown>>[] = [];
    const logger = createLogger({
      release: 'test-1',
      module: 'server',
      level: 'debug',
      sink: (record) => captured.push(record),
    });
    logger.emit(event({ result: 'ok', count: 2 }));
    const privateFixture = 'SECRET-body-cookie-password-email-cursor-filePath';
    logger.emit({ ...event(), fields: { password: privateFixture } });
    expect(JSON.stringify(captured)).not.toContain(privateFixture);
    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatchObject({
      event: 'config.validated',
      outcome: 'success',
      result: 'ok',
      count: 2,
    });
    expect(captured[1]).toMatchObject({
      event: 'logging.entry.dropped',
      outcome: 'failure',
    });
  });

  it('holds only successful records until commit and drops rollback callbacks', async () => {
    const captured: Readonly<Record<string, unknown>>[] = [];
    const logger = createLogger({
      release: 'test',
      module: 'server',
      level: 'info',
      sink: (record) => captured.push(record),
    });
    const held = txFake();
    logger.afterCommit(held.tx, event({ result: 'saved' }));
    expect(captured).toHaveLength(0);
    expect(held.callbacks).toHaveLength(1);
    await held.callbacks[0]!();
    expect(captured[0]).toMatchObject({ result: 'saved' });

    const rolledBack = txFake();
    logger.afterCommit(rolledBack.tx, event({ result: 'rolled-back' }));
    rolledBack.callbacks.length = 0;
    expect(captured).toHaveLength(1);
  });

  it('does not throw when the sink fails or a non-success event is passed to afterCommit', () => {
    const logger = createLogger({
      release: 'test',
      module: 'server',
      level: 'info',
      sink: (record) => {
        if (record.event !== 'logging.entry.dropped')
          throw new Error('sink-secret');
      },
    });
    expect(() => logger.emit(event())).not.toThrow();
    const fake = txFake();
    expect(() =>
      logger.afterCommit(fake.tx, event({}, 'failure')),
    ).not.toThrow();
    expect(fake.callbacks).toHaveLength(0);
  });

  it('uses the injected clock for UTC ISO timestamps', () => {
    const captured: Readonly<Record<string, unknown>>[] = [];
    const logger = createLogger({
      release: 'test',
      module: 'server',
      level: 'info',
      clock: { now: () => new Date('2026-10-02T00:00:00.000Z') },
      sink: (record) => captured.push(record),
    });
    logger.emit(event());
    expect(captured[0]?.['time']).toBe('2026-10-02T00:00:00.000Z');
  });
});
