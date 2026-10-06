import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type {
  DecimalId,
  FileDto,
  MessageOutput,
  RetentionPolicyDto,
  Uuid,
} from '@j-messenger/contracts';
import { isValidMessageText } from '@j-messenger/contracts';
import { ClientError } from '@j-messenger/client-core';
import type { createMessengerClient } from '@j-messenger/client-core';
import './messenger.css';

export type MessengerClient = ReturnType<typeof createMessengerClient>;
export interface MessengerFileBridge {
  pickFile(): Promise<File | null>;
  saveFile(blob: Blob, suggestedName: string): Promise<boolean>;
}
export interface MessengerAppProps {
  client: MessengerClient;
  files?: MessengerFileBridge;
}

const KOREAN_ERRORS: Record<string, string> = {
  bad_request: '입력 내용을 확인해 주세요.',
  unauthorized: '로그인 정보가 만료되었습니다. 다시 로그인해 주세요.',
  forbidden: '이 작업을 수행할 권한이 없습니다.',
  not_found: '항목을 찾을 수 없습니다.',
  conflict: '이미 처리되었거나 현재 상태와 충돌합니다.',
  sync_reset_required: '대화 기록을 다시 불러옵니다.',
  message_expired: '메시지 보존 기간이 만료되었습니다.',
  too_large: '파일 크기는 5MB 이하여야 합니다.',
  rate_limited: '요청이 많습니다. 잠시 뒤 다시 시도해 주세요.',
  unavailable: '서비스에 연결할 수 없습니다. 잠시 뒤 다시 시도해 주세요.',
  network: '네트워크 연결을 확인해 주세요.',
  timeout: '응답이 늦어 전송 결과를 확인 중입니다.',
  invalid_response: '서버 응답을 확인할 수 없습니다.',
  internal: '요청을 처리하지 못했습니다.',
};
const DATE_FORMAT = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  dateStyle: 'short',
  timeStyle: 'short',
});
const ALLOWED_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'pdf',
  'txt',
  'csv',
  'docx',
  'xlsx',
  'zip',
]);
const messageLength = (text: string) => text.trim().length;
function errorText(error: unknown) {
  return error instanceof ClientError
    ? (KOREAN_ERRORS[error.code] ?? '요청을 처리하지 못했습니다.')
    : '요청을 처리하지 못했습니다.';
}
export function MessengerApp({ client, files }: MessengerAppProps) {
  const snapshot = useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    client.getSnapshot,
  );
  const [servers, setServers] = useState<
    readonly { id: string; name: string; aliases?: readonly string[] }[]
  >([]);
  const [serverId, setServerId] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [selectedConversationId, setSelectedConversationId] =
    useState<DecimalId | null>(null);
  const [draft, setDraft] = useState('');
  const [sendBusy, setSendBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [conversationKind, setConversationKind] = useState<'direct' | 'group'>(
    'direct',
  );
  const [memberIds, setMemberIds] = useState<DecimalId[]>([]);
  const [groupTitle, setGroupTitle] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<
    { id: Uuid; name: string }[]
  >([]);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [retentionOpen, setRetentionOpen] = useState(false);
  const [retentionPolicy, setRetentionPolicy] =
    useState<RetentionPolicyDto | null>(null);
  const [retentionLoading, setRetentionLoading] = useState(false);
  const [retentionSaving, setRetentionSaving] = useState(false);
  const [retentionError, setRetentionError] = useState('');
  const [messageDays, setMessageDays] = useState('5');
  const [fileDays, setFileDays] = useState('14');
  const lastRead = useRef<Record<string, string>>({});
  const messageScrollRef = useRef<HTMLDivElement | null>(null);
  const observedGeneration = useRef(snapshot.generation);
  const currentConversation =
    snapshot.conversations.find(
      (conversation) => conversation.id === selectedConversationId,
    ) ?? null;
  const messages = useMemo(
    () =>
      snapshot.messages.filter(
        (message) => message.conversationId === selectedConversationId,
      ),
    [snapshot.messages, selectedConversationId],
  );
  const pending = snapshot.pending.filter(
    (item) => item.conversationId === selectedConversationId,
  );

  useEffect(() => {
    if (observedGeneration.current === snapshot.generation) return;
    observedGeneration.current = snapshot.generation;
    setDraft('');
    setSelectedFiles([]);
    setSelectedConversationId(null);
    setMemberIds([]);
    setGroupTitle('');
    setCreateOpen(false);
    setRetentionOpen(false);
    setRetentionPolicy(null);
    setRetentionError('');
    setNotice('');
    setError('');
    lastRead.current = {};
  }, [snapshot.generation]);

  useEffect(() => {
    let active = true;
    void client
      .listServers()
      .then((items) => {
        if (!active) return;
        const available = items.map((item) => ({
          id: item.id,
          name: item.name,
          ...(item.aliases ? { aliases: item.aliases } : {}),
        }));
        setServers(available);
        setServerId((current) => current || available[0]?.id || '');
      })
      .catch((reason: unknown) => {
        if (active) setError(errorText(reason));
      });
    return () => {
      active = false;
    };
  }, [client]);

  useEffect(() => {
    if (!snapshot.user) return;
    void client
      .listUsers()
      .catch((reason: unknown) => setError(errorText(reason)));
  }, [client, snapshot.user?.id, snapshot.generation]);

  useEffect(() => {
    if (!snapshot.user?.enabledFeatures['receipts'] || !selectedConversationId)
      return;
    const container = messageScrollRef.current;
    if (!container || typeof IntersectionObserver === 'undefined') return;
    let highestVisible = lastRead.current[selectedConversationId] ?? '0';
    let requestInFlight = false;
    let active = true;
    const advance = () => {
      if (
        !active ||
        requestInFlight ||
        BigInt(highestVisible) <=
          BigInt(lastRead.current[selectedConversationId] ?? '0')
      )
        return;
      requestInFlight = true;
      const messageId = highestVisible as DecimalId;
      void client
        .advanceRead(selectedConversationId, messageId)
        .then(() => {
          if (!active) return;
          lastRead.current[selectedConversationId] = messageId;
          requestInFlight = false;
          advance();
        })
        .catch(() => {
          // A later visibility event can retry; a failed request must not loop.
          requestInFlight = false;
        });
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || !(entry.target instanceof HTMLElement))
            continue;
          const id = entry.target.dataset['messageId'];
          if (id && BigInt(id) > BigInt(highestVisible)) highestVisible = id;
        }
        advance();
      },
      { root: container, threshold: 0.5 },
    );
    for (const element of container.querySelectorAll<HTMLElement>(
      '[data-message-id]',
    ))
      observer.observe(element);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [client, messages, selectedConversationId, snapshot.user]);

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    if (loginBusy || actionBusy || !serverId || !username.trim() || !password)
      return;
    setLoginBusy(true);
    setError('');
    try {
      await client.login({ serverId, username: username.trim(), password });
      setPassword('');
      setSelectedConversationId(null);
      setDraft('');
      setSelectedFiles([]);
      setNotice('');
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoginBusy(false);
    }
  }

  async function handleLogout() {
    setActionBusy(true);
    setError('');
    const logoutRequest = client.logout();
    setDraft('');
    setSelectedFiles([]);
    setSelectedConversationId(null);
    setMemberIds([]);
    setGroupTitle('');
    setCreateOpen(false);
    setNotice('');
    lastRead.current = {};
    try {
      await logoutRequest;
    } catch (reason) {
      setError(
        `${errorText(reason)} 로그아웃 상태를 서버에서 확인하지 못했습니다.`,
      );
    } finally {
      setActionBusy(false);
    }
  }

  async function handleCreateConversation(event: FormEvent) {
    event.preventDefault();
    if (
      actionBusy ||
      memberIds.length < 1 ||
      (conversationKind === 'direct' && memberIds.length !== 1)
    )
      return;
    setActionBusy(true);
    setError('');
    try {
      const created = await client.createConversation({
        kind: conversationKind,
        memberIds,
        ...(conversationKind === 'group' && groupTitle.trim()
          ? { title: groupTitle.trim() }
          : {}),
      });
      setSelectedConversationId(created.id);
      setHasOlderMessages(false);
      setCreateOpen(false);
      setMemberIds([]);
      setGroupTitle('');
      setNotice('대화를 만들었습니다.');
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setActionBusy(false);
    }
  }

  async function handleOpenRetention() {
    setRetentionOpen((open) => !open);
    if (retentionOpen) return;
    const requestGeneration = client.getSnapshot().generation;
    setRetentionLoading(true);
    setRetentionError('');
    try {
      const result = await client.getRetention();
      if (client.getSnapshot().generation !== requestGeneration) return;
      setRetentionPolicy(result.data);
      setMessageDays(String(result.data.messageDays));
      setFileDays(String(result.data.fileDays));
    } catch (reason) {
      if (client.getSnapshot().generation === requestGeneration)
        setRetentionError(errorText(reason));
    } finally {
      if (client.getSnapshot().generation === requestGeneration)
        setRetentionLoading(false);
    }
  }

  async function handleSaveRetention(event: FormEvent) {
    event.preventDefault();
    if (retentionSaving) return;
    const messageDaysValue = Number(messageDays);
    const fileDaysValue = Number(fileDays);
    if (
      !Number.isSafeInteger(messageDaysValue) ||
      messageDaysValue < 1 ||
      !Number.isSafeInteger(fileDaysValue) ||
      fileDaysValue < 1
    ) {
      setRetentionError('각 보존 기간은 1일 이상의 정수로 입력하세요.');
      return;
    }
    const requestGeneration = client.getSnapshot().generation;
    setRetentionSaving(true);
    setRetentionError('');
    try {
      await client.updateRetention({
        messageDays: messageDaysValue,
        fileDays: fileDaysValue,
      });
      const result = await client.getRetention();
      if (client.getSnapshot().generation !== requestGeneration) return;
      setRetentionPolicy(result.data);
      setMessageDays(String(result.data.messageDays));
      setFileDays(String(result.data.fileDays));
      setNotice('보존 정책을 저장했습니다.');
    } catch (reason) {
      if (client.getSnapshot().generation === requestGeneration)
        setRetentionError(errorText(reason));
    } finally {
      if (client.getSnapshot().generation === requestGeneration)
        setRetentionSaving(false);
    }
  }

  async function handleSend(event: FormEvent) {
    event.preventDefault();
    if (
      !selectedConversationId ||
      !isValidMessageText(draft) ||
      sendBusy ||
      uploadBusy
    )
      return;
    const requestGeneration = client.getSnapshot().generation;
    setSendBusy(true);
    setError('');
    try {
      await client.sendMessage(
        selectedConversationId,
        draft.trim(),
        selectedFiles.map((file) => file.id),
      );
      setDraft('');
      setSelectedFiles([]);
    } catch (reason) {
      if (
        reason instanceof ClientError &&
        ['network', 'timeout', 'unavailable', 'invalid_response'].includes(
          reason.code,
        )
      ) {
        setDraft('');
        setSelectedFiles([]);
        setNotice('전송 결과를 확인하고 있습니다. 잠시만 기다려 주세요.');
      }
      if (client.getSnapshot().generation === requestGeneration)
        setError(errorText(reason));
    } finally {
      setSendBusy(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    )
      return;
    event.preventDefault();
    const form = event.currentTarget.form;
    if (form && form.requestSubmit) form.requestSubmit();
  }

  async function handleFiles(fileList: FileList | null) {
    const file = fileList?.[0];
    if (!file) return;
    await handleFile(file);
  }

  async function handleFile(file: File | null) {
    if (!file || !selectedConversationId || uploadBusy) return;
    if (!file) return;
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (file.size > 5_000_000) {
      setError(
        KOREAN_ERRORS.too_large ?? '파일 크기가 허용 한도를 넘었습니다.',
      );
      return;
    }
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      setError('허용된 파일 형식만 첨부할 수 있습니다.');
      return;
    }
    setUploadBusy(true);
    setError('');
    const requestGeneration = client.getSnapshot().generation;
    try {
      const uploaded: FileDto = await client.uploadFile(
        selectedConversationId,
        file,
        file.name,
      );
      setSelectedFiles((current) => [
        ...current,
        { id: uploaded.id, name: uploaded.filename },
      ]);
    } catch (reason) {
      if (client.getSnapshot().generation === requestGeneration)
        setError(errorText(reason));
    } finally {
      setUploadBusy(false);
    }
  }

  async function handleDownload(fileId: Uuid) {
    setError('');
    const requestGeneration = client.getSnapshot().generation;
    try {
      const blob = await client.downloadFile(fileId);
      if (files) {
        await files.saveFile(blob, `attachment-${fileId}`);
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `attachment-${fileId}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      if (client.getSnapshot().generation === requestGeneration)
        setError(errorText(reason));
    }
  }

  async function handleRetry(clientMessageId: Uuid) {
    setError('');
    const requestGeneration = client.getSnapshot().generation;
    try {
      await client.retryMessage(clientMessageId);
    } catch (reason) {
      if (client.getSnapshot().generation === requestGeneration)
        setError(errorText(reason));
    }
  }

  async function handleLoadOlder() {
    if (!selectedConversationId || !messages.length || historyBusy) return;
    const requestGeneration = client.getSnapshot().generation;
    setHistoryBusy(true);
    setError('');
    try {
      const page = await client.listMessages(selectedConversationId, {
        before: messages[0]!.id,
        limit: 50,
      });
      if (page.data.length < 50) setHasOlderMessages(false);
    } catch (reason) {
      if (client.getSnapshot().generation === requestGeneration)
        setError(errorText(reason));
    } finally {
      setHistoryBusy(false);
    }
  }

  if (!snapshot.user) {
    return (
      <main className="login-page">
        <section className="login-card" aria-labelledby="app-title">
          <div className="brand-mark" aria-hidden="true">
            J
          </div>
          <p className="eyebrow">PRIVATE MESSENGER</p>
          <h1 id="app-title">J 메신저</h1>
          <p className="muted">허용된 서버를 선택하고 계정으로 로그인하세요.</p>
          <p className="dev-note">
            개발 모드 · 메일 인증은 연결되지 않았습니다. 로컬 테스트 계정:
            alice, bob, carol / 비밀번호 dev-only
          </p>
          <form onSubmit={handleLogin} className="login-form">
            <label>
              서버
              <select
                value={serverId}
                onChange={(event) => setServerId(event.target.value)}
                required
                disabled={!servers.length}
              >
                {!servers.length && (
                  <option value="">서버 목록 불러오는 중…</option>
                )}
                {servers.map((server) => (
                  <option key={server.id} value={server.id}>
                    {server.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              사용자 이름
              <input
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
              />
            </label>
            <label>
              비밀번호
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            {error && (
              <p className="error-message" role="alert">
                {error}
              </p>
            )}
            <button
              className="primary-button full-width"
              type="submit"
              disabled={loginBusy || actionBusy || !serverId}
            >
              {loginBusy ? '로그인 중…' : '로그인'}
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main
      className={`messenger-shell ${selectedConversationId ? 'conversation-open' : ''}`}
    >
      <aside className="sidebar" aria-label="대화 메뉴">
        <header className="sidebar-header">
          <div className="brand-lockup">
            <span className="brand-mark small" aria-hidden="true">
              J
            </span>
            <div>
              <strong>J 메신저</strong>
              <span className="online-label">
                {servers.find((server) => server.id === snapshot.user?.serverId)
                  ?.name ?? snapshot.user.serverId}
              </span>
            </div>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="로그아웃"
            onClick={() => void handleLogout()}
            disabled={actionBusy}
          >
            ↗
          </button>
        </header>
        <div className="profile-card">
          <span className="avatar">
            {snapshot.user.displayName.slice(0, 1)}
          </span>
          <div>
            <strong>{snapshot.user.displayName}</strong>
            <span>{snapshot.user.serverId}</span>
          </div>
        </div>
        <div className="section-heading">
          <h2>대화</h2>
          {snapshot.user.enabledFeatures['adminRetention'] && (
            <button
              className="text-button"
              type="button"
              aria-expanded={retentionOpen}
              onClick={() => void handleOpenRetention()}
            >
              보존 정책
            </button>
          )}
          <button
            className="icon-button add-button"
            type="button"
            aria-label="새 대화 만들기"
            onClick={() => {
              setCreateOpen((open) => !open);
              setError('');
            }}
          >
            ＋
          </button>
        </div>
        {retentionOpen && (
          <section
            className="retention-panel"
            aria-labelledby="retention-title"
          >
            <div className="retention-panel-heading">
              <h3 id="retention-title">보존 정책</h3>
              <button
                className="text-button"
                type="button"
                onClick={() => setRetentionOpen(false)}
              >
                닫기
              </button>
            </div>
            <p className="field-hint">
              메시지 본문과 첨부 파일은 서로 다른 기간으로 보존됩니다.
            </p>
            {retentionLoading ? (
              <p className="field-hint" role="status">
                정책을 불러오는 중…
              </p>
            ) : retentionPolicy ? (
              <>
                <p className="field-hint">
                  현재 본문 {retentionPolicy.messageDays}일 · 첨부{' '}
                  {retentionPolicy.fileDays}일
                </p>
                <form
                  className="retention-form"
                  onSubmit={(event) => void handleSaveRetention(event)}
                >
                  <label>
                    메시지 본문 보존 기간(일)
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={messageDays}
                      onChange={(event) => setMessageDays(event.target.value)}
                    />
                  </label>
                  <label>
                    첨부 파일 보존 기간(일)
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={fileDays}
                      onChange={(event) => setFileDays(event.target.value)}
                    />
                  </label>
                  <button
                    className="primary-button full-width"
                    type="submit"
                    disabled={retentionSaving}
                  >
                    {retentionSaving ? '저장 중…' : '정책 저장'}
                  </button>
                </form>
              </>
            ) : null}
            {retentionError && (
              <p className="error-message" role="alert">
                {retentionError}
              </p>
            )}
          </section>
        )}
        {createOpen && (
          <form
            className="create-form"
            onSubmit={(event) => void handleCreateConversation(event)}
          >
            <fieldset>
              <legend>대화 종류</legend>
              <label>
                <input
                  type="radio"
                  checked={conversationKind === 'direct'}
                  onChange={() => setConversationKind('direct')}
                />{' '}
                개인
              </label>
              <label>
                <input
                  type="radio"
                  checked={conversationKind === 'group'}
                  onChange={() => setConversationKind('group')}
                />{' '}
                그룹
              </label>
            </fieldset>
            {conversationKind === 'group' && (
              <label>
                그룹 이름
                <input
                  value={groupTitle}
                  maxLength={200}
                  onChange={(event) => setGroupTitle(event.target.value)}
                  placeholder="선택 사항"
                />
              </label>
            )}
            <label>
              참여자
              <select
                aria-label="참여자"
                multiple
                value={memberIds}
                onChange={(event) =>
                  setMemberIds(
                    Array.from(
                      event.currentTarget.selectedOptions,
                      (option) => option.value as DecimalId,
                    ),
                  )
                }
                size={Math.min(4, Math.max(2, snapshot.users.length))}
              >
                {snapshot.users
                  .filter((user) => user.id !== snapshot.user?.id)
                  .map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.displayName}
                    </option>
                  ))}
              </select>
            </label>
            <p className="field-hint">
              개인은 한 명, 그룹은 한 명 이상 선택하세요.
            </p>
            <button
              className="primary-button full-width"
              type="submit"
              disabled={
                actionBusy ||
                memberIds.length === 0 ||
                (conversationKind === 'direct' && memberIds.length !== 1)
              }
            >
              {actionBusy ? '만드는 중…' : '대화 시작'}
            </button>
          </form>
        )}
        <nav className="conversation-list" aria-label="참여 대화 목록">
          {snapshot.conversations.length === 0 ? (
            <p className="empty-list">
              아직 대화가 없습니다.
              <br />＋ 버튼으로 대화를 시작하세요.
            </p>
          ) : (
            snapshot.conversations.map((conversation) => {
              const title =
                conversation.title ||
                conversation.memberIds
                  .map(
                    (id) =>
                      snapshot.users.find((user) => user.id === id)
                        ?.displayName,
                  )
                  .filter(Boolean)
                  .join(', ') ||
                '개인 대화';
              const lastMessage = snapshot.messages
                .filter((message) => message.conversationId === conversation.id)
                .at(-1);
              return (
                <button
                  key={conversation.id}
                  type="button"
                  className={`conversation-item ${selectedConversationId === conversation.id ? 'selected' : ''}`}
                  onClick={() => {
                    setHasOlderMessages(
                      snapshot.messages.filter(
                        (message) => message.conversationId === conversation.id,
                      ).length >= 50,
                    );
                    setSelectedConversationId(conversation.id);
                    setError('');
                    setNotice('');
                  }}
                >
                  <span className="avatar conversation-avatar">
                    {title.slice(0, 1)}
                  </span>
                  <span className="conversation-copy">
                    <strong>{title}</strong>
                    <span>
                      {lastMessage?.text === null
                        ? '보존 기간이 지난 메시지입니다.'
                        : (lastMessage?.text ?? '대화를 시작해 보세요.')}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </nav>
      </aside>

      <section className="chat-panel" aria-label="대화 내용">
        {!currentConversation ? (
          <div className="welcome-panel">
            <div className="welcome-icon" aria-hidden="true">
              ✦
            </div>
            <h1>대화를 선택하세요</h1>
            <p>대화 목록에서 기록을 열거나 새 대화를 시작할 수 있습니다.</p>
          </div>
        ) : (
          <>
            <header className="chat-header">
              <button
                className="back-button"
                type="button"
                onClick={() => setSelectedConversationId(null)}
                aria-label="대화 목록으로"
              >
                ‹
              </button>
              <div>
                <h1>
                  {currentConversation.title ||
                    currentConversation.memberIds
                      .map(
                        (id) =>
                          snapshot.users.find((user) => user.id === id)
                            ?.displayName,
                      )
                      .filter(Boolean)
                      .join(', ') ||
                    '개인 대화'}
                </h1>
                <p>
                  {currentConversation.kind === 'group'
                    ? `${currentConversation.memberIds.length}명 참여`
                    : '개인 대화'}
                </p>
              </div>
              <button
                type="button"
                className="icon-button mobile-logout"
                aria-label="로그아웃"
                onClick={() => void handleLogout()}
                disabled={actionBusy}
              >
                ↗
              </button>
            </header>
            <div
              className="message-scroll"
              aria-label="메시지 기록"
              ref={messageScrollRef}
            >
              {hasOlderMessages && (
                <button
                  className="history-button"
                  type="button"
                  onClick={() => void handleLoadOlder()}
                  disabled={historyBusy}
                >
                  {historyBusy ? '불러오는 중…' : '이전 메시지 불러오기'}
                </button>
              )}
              {messages.length === 0 && pending.length === 0 ? (
                <div className="empty-chat">
                  <span aria-hidden="true">☁</span>
                  <p>첫 메시지를 보내 대화를 시작해 보세요.</p>
                </div>
              ) : (
                <ol className="message-list">
                  {messages.map((message) => (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      mine={message.senderId === snapshot.user?.id}
                      sender={
                        message.senderId === snapshot.user?.id
                          ? '나'
                          : (snapshot.users.find(
                              (user) => user.id === message.senderId,
                            )?.displayName ?? '참여자')
                      }
                      onDownload={handleDownload}
                    />
                  ))}
                  {pending.map((item) => (
                    <li className="message-row mine" key={item.clientMessageId}>
                      <article className="message-bubble pending-bubble">
                        <p>{item.text}</p>
                        <span className="message-meta">
                          {item.state === 'failed'
                            ? '전송 실패'
                            : '전송 대기 중'}
                        </span>
                        {item.state === 'failed' && (
                          <button
                            type="button"
                            className="text-button"
                            onClick={() =>
                              void handleRetry(item.clientMessageId)
                            }
                          >
                            다시 보내기
                          </button>
                        )}
                      </article>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div className="composer-wrap">
              {notice && (
                <p className="success-note" role="status">
                  {notice}
                </p>
              )}
              {error && (
                <p className="error-message inline-error" role="alert">
                  {error}
                </p>
              )}
              {selectedFiles.length > 0 && (
                <ul className="attachment-staging" aria-label="보낼 첨부 파일">
                  {selectedFiles.map((file) => (
                    <li key={file.id}>
                      {file.name}
                      <button
                        type="button"
                        aria-label={`${file.name} 첨부 취소`}
                        onClick={() =>
                          setSelectedFiles((items) =>
                            items.filter((item) => item.id !== file.id),
                          )
                        }
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <form
                className="composer"
                onSubmit={(event) => void handleSend(event)}
              >
                {snapshot.user.enabledFeatures['files'] &&
                  (files ? (
                    <button
                      className="attach-button"
                      type="button"
                      aria-label="파일 첨부"
                      disabled={uploadBusy || sendBusy}
                      onClick={() => {
                        void files
                          .pickFile()
                          .then(handleFile)
                          .catch((reason: unknown) =>
                            setError(errorText(reason)),
                          );
                      }}
                    >
                      ＋
                    </button>
                  ) : (
                    <label className="attach-button" aria-label="파일 첨부">
                      ＋
                      <input
                        type="file"
                        accept=".png,.jpg,.jpeg,.webp,.pdf,.txt,.csv,.docx,.xlsx,.zip"
                        onChange={(event) => {
                          void handleFiles(event.currentTarget.files);
                          event.currentTarget.value = '';
                        }}
                        disabled={uploadBusy || sendBusy}
                      />
                    </label>
                  ))}
                <textarea
                  aria-label="메시지 입력"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  maxLength={5000}
                  placeholder="메시지를 입력하세요"
                  rows={1}
                  disabled={sendBusy}
                />
                <span
                  className={`char-count ${messageLength(draft) > 4000 ? 'over-limit' : ''}`}
                  aria-live="polite"
                >
                  {messageLength(draft)}/4000
                </span>
                <button
                  className="primary-button send-button"
                  type="submit"
                  disabled={
                    sendBusy || uploadBusy || !isValidMessageText(draft)
                  }
                >
                  {sendBusy ? '전송 중…' : '전송'}
                </button>
              </form>
              {uploadBusy && (
                <p className="field-hint">파일을 준비하고 있습니다…</p>
              )}
            </div>
          </>
        )}
      </section>
    </main>
  );
}

function MessageBubble({
  message,
  mine,
  sender,
  onDownload,
}: {
  message: MessageOutput;
  mine: boolean;
  sender: string;
  onDownload: (id: Uuid) => void;
}) {
  return (
    <li
      className={`message-row ${mine ? 'mine' : ''}`}
      data-message-id={message.id}
    >
      <article className="message-bubble">
        {!mine && <span className="sender-name">{sender}</span>}
        {message.contentExpired || message.text === null ? (
          <p className="expired-message">보존 기간이 지난 메시지입니다.</p>
        ) : (
          <p className="message-text">{message.text}</p>
        )}
        {message.fileIds.length > 0 && (
          <ul className="message-files" aria-label="첨부 파일">
            {message.fileIds.map((fileId) => (
              <li key={fileId}>
                <button
                  type="button"
                  className="file-download"
                  onClick={() => onDownload(fileId)}
                >
                  <span aria-hidden="true">↓</span> 첨부 파일 다운로드{' '}
                  <small>{fileId.slice(0, 8)}</small>
                </button>
              </li>
            ))}
          </ul>
        )}
        <time className="message-meta" dateTime={message.createdAt}>
          {DATE_FORMAT.format(new Date(message.createdAt))}
        </time>
      </article>
    </li>
  );
}
