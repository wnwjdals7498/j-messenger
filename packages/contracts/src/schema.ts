import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';

/** Positive DB identifiers are strings so JSON never rounds a 64-bit integer. */
export const DecimalIdSchema = Type.String({ pattern: '^[1-9][0-9]*$' });
export const PositionIdSchema = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });
export const ServerIdSchema = Type.String({ pattern: '^[a-z0-9-]{1,32}$' });
export const UuidSchema = Type.String({ format: 'uuid' });
export const IsoDateTimeSchema = Type.String({ format: 'date-time' });
// JSON Schema string length is based on Unicode code points. Runtime must also call isValidMessageText
// because this product limit is measured in JavaScript UTF-16 code units after trimming.
export const MessageInputTextSchema = Type.String({ minLength: 1 });
export const MessageOutputSchema = Type.Object(
  {
    id: DecimalIdSchema,
    conversationId: DecimalIdSchema,
    senderId: DecimalIdSchema,
    clientMessageId: UuidSchema,
    text: Type.Union([Type.String(), Type.Null()]),
    contentExpired: Type.Boolean(),
    fileIds: Type.Array(UuidSchema),
    createdAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);

export const SuccessEnvelopeSchema = Type.Object(
  { data: Type.Unknown() },
  { additionalProperties: false },
);
export const ListEnvelopeSchema = Type.Object(
  {
    data: Type.Array(Type.Unknown()),
    page: Type.Object(
      { nextCursor: Type.Union([Type.String(), Type.Null()]) },
      { additionalProperties: false },
    ),
    snapshotCursor: Type.String(),
    snapshotPosition: PositionIdSchema,
  },
  { additionalProperties: false },
);
export const ErrorCodeSchema = Type.Union([
  Type.Literal('bad_request'),
  Type.Literal('unauthorized'),
  Type.Literal('forbidden'),
  Type.Literal('not_found'),
  Type.Literal('conflict'),
  Type.Literal('sync_reset_required'),
  Type.Literal('message_expired'),
  Type.Literal('too_large'),
  Type.Literal('rate_limited'),
  Type.Literal('internal'),
  Type.Literal('unavailable'),
]);
export const ErrorEnvelopeSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: ErrorCodeSchema,
        message: Type.String(),
        requestId: UuidSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const SessionCreateRequestSchema = Type.Object(
  {
    serverId: ServerIdSchema,
    username: Type.String({ minLength: 1 }),
    password: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export const MessageCreateRequestSchema = Type.Object(
  {
    clientMessageId: UuidSchema,
    text: MessageInputTextSchema,
    fileIds: Type.Optional(
      Type.Array(UuidSchema, { maxItems: 10, uniqueItems: true }),
    ),
  },
  { additionalProperties: false },
);
export const PageQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);
export const MessagePageQuerySchema = Type.Object(
  {
    before: Type.Optional(DecimalIdSchema),
    after: Type.Optional(DecimalIdSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);
export const SyncQuerySchema = Type.Object(
  {
    after: Type.String(),
    through: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);

export const ConversationCreateRequestSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal('direct'), Type.Literal('group')]),
    memberIds: Type.Array(DecimalIdSchema, { minItems: 1, uniqueItems: true }),
    title: Type.Optional(Type.String({ maxLength: 200 })),
    clientRequestId: UuidSchema,
  },
  { additionalProperties: false },
);
export const ReadUpdateRequestSchema = Type.Object(
  { lastReadMessageId: DecimalIdSchema },
  { additionalProperties: false },
);
export const RetentionUpdateRequestSchema = Type.Object(
  {
    messageDays: Type.Integer({ minimum: 1 }),
    fileDays: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const UserDtoSchema = Type.Object(
  { id: DecimalIdSchema, displayName: Type.String() },
  { additionalProperties: false },
);
export const ConversationDtoSchema = Type.Object(
  {
    id: DecimalIdSchema,
    kind: Type.Union([Type.Literal('direct'), Type.Literal('group')]),
    title: Type.Union([Type.String(), Type.Null()]),
    memberIds: Type.Array(DecimalIdSchema),
    createdAt: IsoDateTimeSchema,
    lastMessageAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export const ServerDtoSchema = Type.Object(
  {
    id: ServerIdSchema,
    name: Type.String(),
    aliases: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);
export const ServerListResponseSchema = Type.Object(
  { data: Type.Array(ServerDtoSchema) },
  { additionalProperties: false },
);
export const RuntimeCapabilitiesSchema = Type.Record(
  Type.String(),
  Type.Boolean(),
);
export const CurrentUserDtoSchema = Type.Object(
  {
    id: DecimalIdSchema,
    serverId: ServerIdSchema,
    displayName: Type.String(),
    enabledFeatures: RuntimeCapabilitiesSchema,
  },
  { additionalProperties: false },
);
export const FileDescriptorSchema = Type.Object(
  {
    id: UuidSchema,
    filename: Type.String(),
    contentType: Type.Union([
      Type.Literal('image/png'),
      Type.Literal('image/jpeg'),
      Type.Literal('image/webp'),
      Type.Literal('application/pdf'),
      Type.Literal('text/plain'),
      Type.Literal('text/csv'),
      Type.Literal(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
      Type.Literal(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
      Type.Literal('application/zip'),
    ]),
    sizeBytes: Type.Integer({ minimum: 0, maximum: 5_000_000 }),
    status: Type.Union([
      Type.Literal('ready'),
      Type.Literal('attached'),
      Type.Literal('deleting'),
      Type.Literal('deleted'),
    ]),
  },
  { additionalProperties: false },
);
export const ReadStateDtoSchema = Type.Object(
  {
    conversationId: DecimalIdSchema,
    userId: DecimalIdSchema,
    lastReadMessageId: Type.Union([DecimalIdSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export const RetentionPolicyDtoSchema = Type.Object(
  {
    messageDays: Type.Integer({ minimum: 1 }),
    fileDays: Type.Integer({ minimum: 1 }),
    version: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const CurrentUserResponseSchema = Type.Object(
  { data: CurrentUserDtoSchema },
  { additionalProperties: false },
);
export const NativeSessionResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        user: CurrentUserDtoSchema,
        credential: Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }),
        expiresAt: IsoDateTimeSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const UserListResponseSchema = Type.Object(
  {
    data: Type.Array(UserDtoSchema),
    page: Type.Object(
      { nextCursor: Type.Union([Type.String(), Type.Null()]) },
      { additionalProperties: false },
    ),
    snapshotCursor: Type.String(),
    snapshotPosition: PositionIdSchema,
  },
  { additionalProperties: false },
);
export const ConversationListResponseSchema = Type.Object(
  {
    data: Type.Array(ConversationDtoSchema),
    page: Type.Object(
      { nextCursor: Type.Union([Type.String(), Type.Null()]) },
      { additionalProperties: false },
    ),
    snapshotCursor: Type.String(),
    snapshotPosition: PositionIdSchema,
  },
  { additionalProperties: false },
);
export const ConversationResponseSchema = Type.Object(
  { data: ConversationDtoSchema },
  { additionalProperties: false },
);
export const MessageListResponseSchema = Type.Object(
  {
    data: Type.Array(MessageOutputSchema),
    page: Type.Object(
      { nextCursor: Type.Union([Type.String(), Type.Null()]) },
      { additionalProperties: false },
    ),
    snapshotCursor: Type.String(),
    snapshotPosition: PositionIdSchema,
  },
  { additionalProperties: false },
);
export const MessageResponseSchema = Type.Object(
  { data: MessageOutputSchema },
  { additionalProperties: false },
);
export const FileResponseSchema = Type.Object(
  { data: FileDescriptorSchema },
  { additionalProperties: false },
);
export const ReadStateResponseSchema = Type.Object(
  { data: ReadStateDtoSchema, snapshotCursor: Type.Optional(Type.String()) },
  { additionalProperties: false },
);
export const ReadStateListResponseSchema = Type.Object(
  {
    data: Type.Array(ReadStateDtoSchema),
    snapshotCursor: Type.String(),
    snapshotPosition: PositionIdSchema,
  },
  { additionalProperties: false },
);
export const RetentionPolicyResponseSchema = Type.Object(
  { data: RetentionPolicyDtoSchema },
  { additionalProperties: false },
);
export const MessageCreatedEventSchema = Type.Object(
  {
    eventId: DecimalIdSchema,
    type: Type.Literal('message.created.v1'),
    occurredAt: IsoDateTimeSchema,
    conversationId: DecimalIdSchema,
    data: MessageOutputSchema,
  },
  { additionalProperties: false },
);
export const MessageDeletedEventSchema = Type.Object(
  {
    eventId: DecimalIdSchema,
    type: Type.Literal('message.deleted.v1'),
    occurredAt: IsoDateTimeSchema,
    conversationId: DecimalIdSchema,
    data: Type.Object(
      {
        messageId: DecimalIdSchema,
        contentExpired: Type.Literal(true),
        fileIds: Type.Array(UuidSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const EventSchema = Type.Object(
  {
    eventId: DecimalIdSchema,
    type: Type.String({ pattern: '^[a-z]+(?:\\.[a-z]+)+\\.v[1-9][0-9]*$' }),
    occurredAt: IsoDateTimeSchema,
    conversationId: Type.Optional(DecimalIdSchema),
    data: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
export const ReadyFrameSchema = Type.Object(
  {
    type: Type.Literal('ready'),
    cursor: Type.String({ minLength: 1 }),
    position: PositionIdSchema,
  },
  { additionalProperties: false },
);
export const SyncResponseSchema = Type.Object(
  {
    data: Type.Array(EventSchema),
    nextCursor: Type.String(),
    hasMore: Type.Boolean(),
    through: Type.String(),
    throughPosition: PositionIdSchema,
    scannedThrough: PositionIdSchema,
  },
  { additionalProperties: false },
);

export type DecimalId = Static<typeof DecimalIdSchema>;
export type PositionId = Static<typeof PositionIdSchema>;
export type ServerId = Static<typeof ServerIdSchema>;
export type Uuid = Static<typeof UuidSchema>;
export type MessageOutput = Static<typeof MessageOutputSchema>;
export type MessageCreateRequest = Static<typeof MessageCreateRequestSchema>;
export type ErrorCode = Static<typeof ErrorCodeSchema>;
export type ApiErrorEnvelope = Static<typeof ErrorEnvelopeSchema>;
export type EventDto = Static<typeof EventSchema>;
export type UserDto = Static<typeof UserDtoSchema>;
export type ServerDto = Static<typeof ServerDtoSchema>;
export type ReadyFrame = Static<typeof ReadyFrameSchema>;
export type SyncResponse = Static<typeof SyncResponseSchema>;
export type ConversationDto = Static<typeof ConversationDtoSchema>;
export type CurrentUserDto = Static<typeof CurrentUserDtoSchema>;
export type NativeSessionResponse = Static<typeof NativeSessionResponseSchema>;
export type FileDto = Static<typeof FileDescriptorSchema>;
export type ReadStateDto = Static<typeof ReadStateDtoSchema>;
export type RetentionPolicyDto = Static<typeof RetentionPolicyDtoSchema>;
export type ConversationCreateRequest = Static<
  typeof ConversationCreateRequestSchema
>;
export type ReadUpdateRequest = Static<typeof ReadUpdateRequestSchema>;
export type RetentionUpdateRequest = Static<
  typeof RetentionUpdateRequestSchema
>;

export const HTTP_STATUS_BY_ERROR = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  sync_reset_required: 410,
  message_expired: 410,
  too_large: 413,
  rate_limited: 429,
  internal: 500,
  unavailable: 503,
} as const satisfies Record<ErrorCode, number>;

/** JavaScript string length and iteration both differ from Unicode code points in UTF-16 edge cases. */
export function isValidMessageText(text: string): boolean {
  const normalized = text.trim();
  const length = normalized.length;
  return length >= 1 && length <= 4000 && !hasUnpairedSurrogate(text);
}

export function normalizeMessageText(text: string): string | null {
  return isValidMessageText(text) ? text.trim() : null;
}

export function isValidMessageCreateRequest(
  value: unknown,
): value is MessageCreateRequest {
  return (
    Value.Check(MessageCreateRequestSchema, value) &&
    isValidMessageText((value as MessageCreateRequest).text)
  );
}

/** ISO timestamp whose textual timezone is UTC and whose instant is parseable. */
export function isUtcDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))
    return false;
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return false;
  const fields = value.slice(0, 19);
  return new Date(instant).toISOString().slice(0, 19) === fields;
}

export function isValidMessageOutput(value: unknown): value is MessageOutput {
  if (!Value.Check(MessageOutputSchema, value)) return false;
  const message = value as MessageOutput;
  return message.contentExpired === (message.text === null);
}

export function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

export function checkSchema<T extends TSchema>(
  schema: T,
  value: unknown,
): value is Static<T> {
  return Value.Check(schema, value);
}

export const FILE_MAX_BYTES = 5_000_000;
export const MESSAGE_RETENTION_DAYS = 5;
export const FILE_RETENTION_DAYS = 14;
export const ALLOWED_DOWNLOAD_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip',
] as const;
export type AllowedDownloadMimeType =
  (typeof ALLOWED_DOWNLOAD_MIME_TYPES)[number];

const SAFE_ERROR_MESSAGES: Record<ErrorCode, string> = {
  bad_request: '요청 형식이 올바르지 않습니다.',
  unauthorized: '인증이 필요합니다.',
  forbidden: '요청한 작업을 수행할 수 없습니다.',
  not_found: '요청한 항목을 찾을 수 없습니다.',
  conflict: '요청이 현재 상태와 충돌합니다.',
  sync_reset_required: '동기화 상태를 다시 설정해야 합니다.',
  message_expired: '메시지 보존 기간이 만료되었습니다.',
  too_large: '요청 크기가 허용 한도를 초과했습니다.',
  rate_limited: '요청이 너무 많습니다.',
  internal: '요청을 처리하지 못했습니다.',
  unavailable: '서비스를 일시적으로 사용할 수 없습니다.',
};

/** Domain failures carry only a public code and safe message; adapters must not serialize `stack`. */
export class DomainError extends Error {
  readonly code: ErrorCode;
  constructor(
    code: ErrorCode,
    publicMessage: string = SAFE_ERROR_MESSAGES[code],
  ) {
    super(publicMessage);
    this.name = 'DomainError';
    this.code = code;
  }
}

export function toApiError(error: unknown, requestId: Uuid): ApiErrorEnvelope {
  if (error instanceof DomainError)
    return {
      error: {
        code: error.code,
        message: SAFE_ERROR_MESSAGES[error.code],
        requestId,
      },
    };
  return {
    error: {
      code: 'internal',
      message: SAFE_ERROR_MESSAGES.internal,
      requestId,
    },
  };
}
