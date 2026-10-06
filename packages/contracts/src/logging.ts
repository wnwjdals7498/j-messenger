import type { SafeLogEvent } from './ports.js';

/** Explicit low-risk metadata keys; free-form input and credential fields never belong in logs. */
export const SAFE_LOG_FIELD_KEYS = new Set([
  'serverId',
  'userId',
  'conversationId',
  'messageId',
  'fileId',
  'deviceId',
  'eventId',
  'auditId',
  'backupId',
  'policyVersion',
  'schemaVersion',
  'count',
  'processedCount',
  'failedCount',
  'skippedCount',
  'byteCount',
  'durationMs',
  'attempt',
  'statusCode',
  'errorCode',
  'reasonCode',
  'activeConnections',
  'queueBytes',
  'result',
  'direction',
  'created',
  'reused',
  'advanced',
  'platform',
  'phase',
  'limit',
  'hasMore',
  'route',
  'memoryBytes',
  'freeBytes',
  'databaseBytes',
  'walBytes',
  'outboxRows',
  'fileBytes',
  'configuredFileQuotaBytes',
  'writesAllowed',
  'eventLoopDelayP99Ms',
  'requestLatencyP95Ms',
]);

export function assertSafeLogEvent(event: SafeLogEvent): void {
  if (!/^[A-Z][0-9]{2}$/.test(event.featureId))
    throw new Error('Invalid feature identifier');
  if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/.test(event.event))
    throw new Error('Invalid event identifier');
  if (event.requestId !== undefined && !isUuid(event.requestId))
    throw new Error('Invalid requestId');
  if (event.jobId !== undefined && !isUuid(event.jobId))
    throw new Error('Invalid jobId');
  for (const [key, value] of Object.entries(event.fields)) {
    if (!SAFE_LOG_FIELD_KEYS.has(key)) throw new Error('Forbidden log field');
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new Error('Invalid numeric log value');
    if (
      value !== null &&
      !['string', 'number', 'boolean'].includes(typeof value)
    )
      throw new Error('Invalid log value');
    if (typeof value === 'string' && !isSafeValue(key, value))
      throw new Error('Unsafe log value');
  }
}

function isSafeValue(key: string, value: string): boolean {
  if (key === 'route')
    return value.length <= 256 && /^\/(?:[a-zA-Z0-9_:/.*-]*)$/.test(value);
  if (key === 'reasonCode' || key === 'errorCode')
    return /^[a-z][a-z0-9_]{0,63}$/.test(value);
  if (key.endsWith('Id'))
    return key === 'serverId'
      ? /^[a-z0-9-]{1,32}$/.test(value)
      : /^(?:[1-9][0-9]*|[0-9a-f]{8}-[0-9a-f-]{27})$/i.test(value);
  return value.length <= 128 && !/[\r\n\u0000-\u001f]/.test(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
