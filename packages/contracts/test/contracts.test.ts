import { describe, expect, it } from 'vitest';
import {
  ConversationCreateRequestSchema,
  CurrentUserResponseSchema,
  ErrorEnvelopeSchema,
  FileDescriptorSchema,
  HTTP_STATUS_BY_ERROR,
  MessageCreateRequestSchema,
  MessageOutputSchema,
  ReadUpdateRequestSchema,
  RetentionPolicyResponseSchema,
  RetentionUpdateRequestSchema,
  SessionCreateRequestSchema,
  SyncQuerySchema,
} from '../src/index.js';
import { Value } from 'typebox/value';
import { assertSynchronousResult } from '../src/ports.js';
import { assertSafeLogEvent } from '../src/logging.js';
import {
  DomainError,
  PositionIdSchema,
  ServerIdSchema,
  hasUnpairedSurrogate,
  isUtcDateTime,
  isValidMessageCreateRequest,
  isValidMessageOutput,
  isValidMessageText,
  normalizeMessageText,
  toApiError,
} from '../src/schema.js';

const uuid = '55a827ef-88ac-4201-9e94-539bec429f74';

describe('wire contracts', () => {
  it('rejects unknown fields and malformed identifiers at raw input boundaries', () => {
    expect(
      Value.Check(SessionCreateRequestSchema, {
        serverId: 'mail-prod-1',
        username: 'u',
        password: 'p',
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionCreateRequestSchema, {
        serverId: 'mail_server',
        username: 'u',
        password: 'p',
      }),
    ).toBe(false);
    expect(
      Value.Check(SessionCreateRequestSchema, {
        serverId: 'tenant',
        username: 'u',
        password: 'p',
        userId: '2',
      }),
    ).toBe(false);
    expect(
      Value.Check(MessageCreateRequestSchema, {
        clientMessageId: 'nope',
        text: 'x',
      }),
    ).toBe(false);
    expect(
      Value.Check(SyncQuerySchema, {
        after: 'opaque',
        limit: 501,
        cursor: 'x',
      }),
    ).toBe(false);
    expect(Value.Check(ServerIdSchema, 'tenant-01')).toBe(true);
    expect(Value.Check(ServerIdSchema, '')).toBe(false);
    expect(Value.Check(PositionIdSchema, '0')).toBe(true);
    expect(Value.Check(PositionIdSchema, '900719925474099312345')).toBe(true);
  });

  it('preserves decimal IDs beyond JavaScript safe integer precision', () => {
    const largeId = '9007199254740993123456789';
    expect(
      Value.Check(MessageOutputSchema, {
        id: largeId,
        conversationId: '2',
        senderId: '3',
        clientMessageId: uuid,
        text: 'ok',
        contentExpired: false,
        fileIds: [],
        createdAt: '2026-10-02T00:00:00.000Z',
      }),
    ).toBe(true);
    expect(
      Value.Check(MessageOutputSchema, {
        id: 9007199254740992,
        conversationId: '2',
        senderId: '3',
        clientMessageId: uuid,
        text: 'ok',
        contentExpired: false,
        fileIds: [],
        createdAt: '2026-10-02T00:00:00.000Z',
      }),
    ).toBe(false);
  });

  it('normalizes first, then counts UTF-16 units and rejects malformed surrogate pairs', () => {
    expect(
      isValidMessageText(
        `${' '.repeat(100)}${'😀'.repeat(2000)}${' '.repeat(100)}`,
      ),
    ).toBe(true);
    expect(normalizeMessageText('  hello  ')).toBe('hello');
    expect(isValidMessageText('😀'.repeat(2001))).toBe(false);
    expect(
      isValidMessageCreateRequest({ clientMessageId: uuid, text: '   ' }),
    ).toBe(false);
    expect(hasUnpairedSurrogate('\ud800')).toBe(true);
    expect(isValidMessageText('\ud800')).toBe(false);
    // TypeBox's JSON Schema limit counts code points; the request-level helper adds UTF-16 validation.
    expect(
      Value.Check(MessageCreateRequestSchema, {
        clientMessageId: uuid,
        text: '😀'.repeat(2001),
      }),
    ).toBe(true);
    expect(
      isValidMessageCreateRequest({
        clientMessageId: uuid,
        text: '😀'.repeat(2001),
      }),
    ).toBe(false);
  });

  it('represents independently retained attachments after message text expires', () => {
    const expired = {
      id: '1',
      conversationId: '2',
      senderId: '3',
      clientMessageId: uuid,
      text: null,
      contentExpired: true,
      fileIds: [uuid],
      createdAt: '2026-10-02T00:00:00.000Z',
    };
    expect(isValidMessageOutput(expired)).toBe(true);
    expect(isValidMessageOutput({ ...expired, contentExpired: false })).toBe(
      false,
    );
    expect(isValidMessageOutput({ ...expired, text: 'resurrected' })).toBe(
      false,
    );
  });

  it('validates typed current user, conversation, receipt, retention and file API data', () => {
    expect(
      Value.Check(CurrentUserResponseSchema, {
        data: {
          id: '9007199254740993',
          serverId: 'tenant-a',
          displayName: 'User',
          enabledFeatures: { files: true },
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(ConversationCreateRequestSchema, {
        kind: 'group',
        memberIds: ['2', '3'],
        title: 'Team',
        clientRequestId: uuid,
      }),
    ).toBe(true);
    expect(
      Value.Check(ConversationCreateRequestSchema, {
        kind: 'group',
        memberIds: ['2', '2'],
        clientRequestId: uuid,
      }),
    ).toBe(false);
    expect(
      Value.Check(ReadUpdateRequestSchema, {
        lastReadMessageId: '9007199254740993',
      }),
    ).toBe(true);
    expect(
      Value.Check(RetentionUpdateRequestSchema, {
        messageDays: 5,
        fileDays: 14,
      }),
    ).toBe(true);
    expect(
      Value.Check(RetentionUpdateRequestSchema, {
        messageDays: 0,
        fileDays: 14,
      }),
    ).toBe(false);
    expect(
      Value.Check(RetentionPolicyResponseSchema, {
        data: { messageDays: 5, fileDays: 14, version: 2 },
      }),
    ).toBe(true);
    expect(
      Value.Check(FileDescriptorSchema, {
        id: uuid,
        filename: 'report.pdf',
        contentType: 'application/pdf',
        sizeBytes: 5_000_000,
        status: 'ready',
      }),
    ).toBe(true);
    expect(
      Value.Check(FileDescriptorSchema, {
        id: uuid,
        filename: 'report.exe',
        contentType: 'application/octet-stream',
        sizeBytes: 5_000_001,
        status: 'ready',
      }),
    ).toBe(false);
  });

  it('requires UTC timestamps and preserves large IDs as strings', () => {
    expect(isUtcDateTime('2026-10-02T03:00:00.000Z')).toBe(true);
    expect(isUtcDateTime('2026-10-02T03:00:00+09:00')).toBe(false);
    expect(isUtcDateTime('2026-02-30T03:00:00Z')).toBe(false);
    expect(isUtcDateTime('not-a-date')).toBe(false);
    expect(
      Value.Check(MessageOutputSchema, {
        id: '9007199254740993123456789',
        conversationId: '2',
        senderId: '3',
        clientMessageId: uuid,
        text: 'ok',
        contentExpired: false,
        fileIds: [],
        createdAt: '2026-10-02T00:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('fixes public error status mapping and rejects extra envelope fields', () => {
    expect(HTTP_STATUS_BY_ERROR.sync_reset_required).toBe(410);
    expect(HTTP_STATUS_BY_ERROR.unavailable).toBe(503);
    expect(
      Value.Check(ErrorEnvelopeSchema, {
        error: { code: 'unauthorized', message: 'Denied', requestId: uuid },
      }),
    ).toBe(true);
    expect(
      Value.Check(ErrorEnvelopeSchema, {
        error: {
          code: 'unauthorized',
          message: 'Denied',
          requestId: uuid,
          stack: 'secret',
        },
      }),
    ).toBe(false);
  });

  it('maps only safe domain error fields to wire and hides unexpected errors', () => {
    const mapped = toApiError(new DomainError('not_found'), uuid);
    expect(mapped).toEqual({
      error: {
        code: 'not_found',
        message: expect.any(String),
        requestId: uuid,
      },
    });
    expect(JSON.stringify(mapped)).not.toContain('stack');
    expect(toApiError(new Error('private path'), uuid).error).toEqual({
      code: 'internal',
      message: expect.any(String),
      requestId: uuid,
    });
  });
});

describe('shared port invariants', () => {
  it('rejects async UnitOfWork callbacks before they can escape the transaction', () => {
    expect(() => assertSynchronousResult(Promise.resolve(1))).toThrow(
      /thenable/,
    );
    expect(assertSynchronousResult(1)).toBe(1);
  });

  it('enforces a safe structured-log field allowlist', () => {
    const base = {
      featureId: 'F12',
      event: 'messages.accepted',
      outcome: 'success' as const,
      requestId: uuid,
      fields: { messageId: '1' },
    };
    expect(() => assertSafeLogEvent(base)).not.toThrow();
    for (const forbiddenKey of [
      'token',
      'cursor',
      'authorization',
      'cookie',
      'sessionHash',
      'rawInput',
      'unknownField',
    ]) {
      expect(() =>
        assertSafeLogEvent({ ...base, fields: { [forbiddenKey]: 'secret' } }),
      ).toThrow();
    }
    expect(() =>
      assertSafeLogEvent({ ...base, fields: { count: Number.NaN } }),
    ).toThrow();
    expect(() =>
      assertSafeLogEvent({
        ...base,
        fields: { reasonCode: 'user supplied text' },
      }),
    ).toThrow();
    expect(() =>
      assertSafeLogEvent({
        ...base,
        fields: { messageId: '9007199254740993' },
      }),
    ).not.toThrow();
  });
});
