import type {
  DecimalId,
  ErrorCode,
  ServerId,
  PositionId,
  Uuid,
  MessageOutput,
  EventDto,
  UserDto,
  ConversationDto,
  CurrentUserDto,
  FileDto,
  ReadStateDto,
  RetentionPolicyDto,
} from './schema.js';

export interface RequestContext {
  readonly serverId: ServerId;
  readonly userId: DecimalId;
  readonly sessionId: DecimalId;
  readonly requestId: Uuid;
  readonly authenticatedAt: string;
}
export interface Clock {
  now(): Date;
}
export interface IdFactory {
  uuid(): Uuid;
}
export type PublicRuntimeCapabilities = CurrentUserDto['enabledFeatures'];
export type RuntimeCapabilities = PublicRuntimeCapabilities;
export interface SessionResolver {
  resolve(input: {
    readonly credential: string;
    readonly requestId: Uuid;
  }): Promise<RequestContext>;
}

export interface FeatureLog {
  emit(event: SafeLogEvent): void;
  /** Hold a success event until the enclosing transaction commits. */
  afterCommit(tx: TxContext, event: SafeLogEvent): void;
}
export interface SafeLogEvent {
  readonly featureId: string;
  readonly event: string;
  readonly outcome: 'success' | 'rejected' | 'failure';
  readonly requestId?: Uuid;
  readonly jobId?: Uuid;
  readonly fields: Readonly<Record<string, string | number | boolean | null>>;
}

export interface TxContext {
  readonly active: boolean;
  assertActive(): void;
  afterCommit(effect: () => void | Promise<void>): void;
}
export interface UnitOfWork {
  /** Callback must be synchronous; async work and external I/O belong after commit. */
  run<T>(work: (tx: TxContext) => T): Promise<T>;
}
export function assertSynchronousResult<T>(result: T): T {
  if (
    typeof result === 'object' &&
    result !== null &&
    'then' in result &&
    typeof result.then === 'function'
  ) {
    throw new TypeError('UnitOfWork callback must not return a thenable');
  }
  return result;
}

export interface ConversationAccess {
  requireMember(
    context: RequestContext,
    conversationId: DecimalId,
  ): Promise<void>;
  /** Recheck authorization synchronously inside the caller's transaction. */
  recheckMember(
    tx: TxContext,
    context: RequestContext,
    conversationId: DecimalId,
  ): void;
  canAccess(
    context: RequestContext,
    conversationId: DecimalId,
  ): Promise<boolean>;
}
export interface UserDirectory {
  requireSameServer(context: RequestContext, userId: DecimalId): Promise<void>;
  listSameServer(
    context: RequestContext,
    cursor: string | null,
    limit: number,
  ): Promise<{ items: readonly UserSummary[]; nextCursor: string | null }>;
}
export interface ConversationActivity {
  recordMessage(
    tx: TxContext,
    context: RequestContext,
    conversationId: DecimalId,
    occurredAt: string,
  ): void;
  memberIds(
    context: RequestContext,
    conversationId: DecimalId,
  ): readonly DecimalId[];
}
export type UserSummary = UserDto;
export interface ConversationQueries {
  list(
    context: RequestContext,
    cursor: string | null,
    limit: number,
  ): Promise<Page<ConversationDto>>;
  get(
    context: RequestContext,
    conversationId: DecimalId,
  ): Promise<ConversationDto>;
}
export interface CurrentUserQueries {
  get(context: RequestContext): Promise<CurrentUserDto>;
}

export interface MessageCommands {
  create(
    context: RequestContext,
    conversationId: DecimalId,
    input: { clientMessageId: Uuid; text: string; fileIds?: readonly Uuid[] },
  ): Promise<{ message: MessageOutput; created: boolean; status: 200 | 201 }>;
  purgeExpired(
    context: RequestContext,
    through: string,
  ): Promise<{ purged: number }>;
}
export interface MessageQueries {
  list(
    context: RequestContext,
    conversationId: DecimalId,
    input: { before?: DecimalId; after?: DecimalId; limit: number },
  ): Promise<Page<MessageOutput>>;
}
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly snapshotCursor: string;
  readonly snapshotPosition: PositionId;
}

export interface EventWriter {
  append(tx: TxContext, event: EventAppend): DecimalId;
}
export interface EventAppend {
  readonly type: string;
  readonly occurredAt: string;
  readonly serverId: ServerId;
  readonly conversationId?: DecimalId;
  readonly entityId: EntityReference;
  readonly recipientUserIds: readonly DecimalId[];
  /** References only; message body or file contents are forbidden. */
  readonly payloadRef: {
    readonly entityType:
      | 'message'
      | 'conversation'
      | 'receipt'
      | 'file'
      | 'retention'
      | 'device'
      | 'job';
    readonly entityId: EntityReference;
  };
}
export type EntityReference = DecimalId | Uuid;
export interface EventReader {
  snapshotPosition(tx: TxContext, context: RequestContext): PositionId;
  highWatermark(context: RequestContext): Promise<PositionId>;
  /** `through` is fixed for the paging run; scannedThrough advances over hidden as well as visible rows. */
  scan(
    context: RequestContext,
    after: PositionId,
    through: PositionId,
    limit: number,
  ): Promise<{
    rows: readonly EventRecord[];
    scannedThrough: PositionId;
    hasMore: boolean;
  }>;
}
export interface SystemContext {
  readonly serverId: ServerId;
  readonly requestId: Uuid;
  readonly jobId?: Uuid;
}
export interface EventRecord {
  readonly id: DecimalId;
  readonly type: string;
  readonly occurredAt: string;
  readonly serverId: ServerId;
  readonly conversationId: DecimalId | null;
  readonly entityId: EntityReference;
  readonly payloadRef: EventAppend['payloadRef'];
}
export interface EventHydrator {
  hydrate(
    context: RequestContext,
    record: EventRecord,
  ): Promise<EventDto | null>;
}
export interface OpaqueCursorCodec {
  encode(claims: {
    serverId: ServerId;
    userId: DecimalId;
    epoch: string;
    position: PositionId;
    expiresAt: string;
  }): string;
  decode(
    token: string,
    expected: {
      serverId: ServerId;
      userId: DecimalId;
      epoch: string;
      now: Date;
    },
  ): { position: PositionId; expiresAt: string };
}

export interface JobHandler<T = unknown> {
  readonly kind: string;
  handle(job: Job<T>): Promise<JobResult>;
}
export interface Job<T = unknown> {
  readonly id: Uuid;
  readonly kind: string;
  readonly payload: T;
  readonly attempt: number;
  readonly requestId: Uuid | null;
}
export type JobResult =
  | { readonly status: 'completed' }
  | {
      readonly status: 'retry';
      readonly retryAt: string;
      readonly reason: string;
    }
  | { readonly status: 'failed'; readonly reason: string };
export interface JobRunner {
  runBatch(
    limit: number,
  ): Promise<{ completed: number; retried: number; failed: number }>;
}

export interface FileCommands {
  prepare(
    context: RequestContext,
    conversationId: DecimalId,
    input: {
      filename: string;
      contentType: AllowedFileType;
      /** Exact declared length; null means a bounded stream of unknown length. */
      sizeBytes: number | null;
      stream: AsyncIterable<Uint8Array>;
    },
  ): Promise<FileDescriptor>;
  bind(
    tx: TxContext,
    context: RequestContext,
    conversationId: DecimalId,
    messageId: DecimalId,
    fileIds: readonly Uuid[],
  ): void;
  openDownload(
    context: RequestContext,
    fileId: Uuid,
  ): Promise<{ descriptor: FileDescriptor; stream: AsyncIterable<Uint8Array> }>;
  scheduleDelete(tx: TxContext, fileId: Uuid, reasonCode: string): void;
}
export type FileDescriptor = FileDto;

export interface ReceiptCommands {
  advance(
    context: RequestContext,
    conversationId: DecimalId,
    messageId: DecimalId,
  ): Promise<{ lastReadMessageId: DecimalId; advanced: boolean }>;
  get(
    context: RequestContext,
    conversationId: DecimalId,
  ): Promise<readonly ReadStateDto[]>;
}
export interface RetentionCommands {
  get(context: RequestContext): Promise<RetentionPolicy>;
  update(context: RequestContext, policy: RetentionPolicy): Promise<void>;
  purgeBatch(
    context: RequestContext,
    limit: number,
  ): Promise<{ messages: number; files: number }>;
}
export type RetentionPolicy = RetentionPolicyDto;
export interface AuditWriter {
  append(
    tx: TxContext,
    context: RequestContext,
    event: {
      action: string;
      targetId: EntityReference | null;
      metadata: Readonly<Record<string, string | number | boolean | null>>;
    },
  ): void;
}

export interface ClientTransport {
  request<T>(input: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    body?: unknown;
    credential?: string;
  }): Promise<{
    status: number;
    data?: T;
    error?: { code: ErrorCode; requestId: Uuid };
  }>;
}
export interface CredentialStore {
  read(): Promise<string | null>;
  write(credential: string): Promise<void>;
  clear(): Promise<void>;
}

export type AllowedFileType =
  'png' | 'jpg' | 'webp' | 'pdf' | 'txt' | 'csv' | 'docx' | 'xlsx' | 'zip';
