import { StrictMode, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  ClientError,
  createMessengerClient,
  type ClientSocket,
} from '@j-messenger/client-core';
import {
  MessengerApp,
  type MessengerFileBridge,
} from '@j-messenger/client-react';

const SETTINGS_KEY = 'j-messenger.desktop.server';
const DEFAULT_ORIGIN = 'http://127.0.0.1:3000';
type ServerSetting = { origin: string; allowInsecureHttp: boolean };
type NativeResponse = {
  status: number;
  headers: Record<string, string>;
  body: number[];
};
type NativeBody =
  | { kind: 'json'; text: string }
  | { kind: 'file'; filename: string; contentType: string; bytes: number[] };

function nativeError(error: unknown) {
  const code = typeof error === 'string' ? error : '';
  if (code === 'too_large') return new ClientError('too_large');
  if (code === 'bad_request') return new ClientError('bad_request');
  return new ClientError('network');
}

function storedSetting(): ServerSetting | null {
  try {
    const value = localStorage.getItem(SETTINGS_KEY);
    return value ? (JSON.parse(value) as ServerSetting) : null;
  } catch {
    return null;
  }
}

async function nativeFetch(input: RequestInfo | URL, init?: RequestInit) {
  const request = input instanceof Request ? input : null;
  const url = request ? request.url : String(input);
  const headers = new Headers(request?.headers);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  let body: NativeBody | undefined;
  const requestBody =
    init?.body ?? (request ? await request.clone().text() : undefined);
  if (requestBody instanceof FormData) {
    const file = requestBody.get('file');
    if (!(file instanceof File)) throw new ClientError('bad_request');
    body = {
      kind: 'file',
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
    };
  } else if (typeof requestBody === 'string') {
    body = { kind: 'json', text: requestBody };
  } else if (requestBody instanceof Blob) {
    body = {
      kind: 'file',
      filename: 'attachment',
      contentType: requestBody.type || 'application/octet-stream',
      bytes: Array.from(new Uint8Array(await requestBody.arrayBuffer())),
    };
  }
  let response: NativeResponse;
  try {
    response = await invoke<NativeResponse>('native_fetch', {
      request: {
        url,
        method: init?.method ?? request?.method ?? 'GET',
        headers: Object.fromEntries(headers.entries()),
        ...(body ? { body } : {}),
      },
    });
  } catch (error) {
    throw nativeError(error);
  }
  return new Response(
    response.status === 204 ? null : new Uint8Array(response.body),
    { status: response.status, headers: response.headers },
  );
}

function nativeSocketFactory(url: string): ClientSocket {
  const id = crypto.randomUUID();
  const messageHandlers = new Set<(value: unknown) => void>();
  const closeHandlers = new Set<() => void>();
  let closed = false;
  const setup = Promise.all([
    listen<string>(`native-ws-${id}-message`, (event) => {
      try {
        const value: unknown = JSON.parse(event.payload);
        for (const handler of messageHandlers) handler(value);
      } catch {
        // The shared client recovers malformed frames by syncing its cursor.
      }
    }),
    listen(`native-ws-${id}-close`, () => {
      closed = true;
      for (const handler of closeHandlers) handler();
    }),
  ]).then(() =>
    closed ? undefined : invoke('native_ws_open', { socketId: id, url }),
  );
  void setup.catch(() => {
    closed = true;
    for (const handler of closeHandlers) handler();
  });
  return {
    send(value) {
      if (!closed)
        void setup
          .then(() =>
            invoke('native_ws_send', {
              socketId: id,
              text: JSON.stringify(value),
            }),
          )
          .catch(() => undefined);
    },
    close() {
      closed = true;
      void invoke('native_ws_close', { socketId: id }).catch(() => undefined);
    },
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
  };
}

const nativeFiles: MessengerFileBridge = {
  async pickFile() {
    let selected: { filename: string; bytes: number[] } | null;
    try {
      selected = await invoke('native_pick_file');
    } catch (error) {
      throw nativeError(error);
    }
    if (!selected) return null;
    return new File([new Uint8Array(selected.bytes)], selected.filename);
  },
  async saveFile(blob, suggestedName) {
    try {
      return await invoke<boolean>('native_save_file', {
        filename: suggestedName,
        bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
      });
    } catch (error) {
      throw nativeError(error);
    }
  },
};

function App() {
  const [setting, setSetting] = useState<ServerSetting | null>(storedSetting);
  const [origin, setOrigin] = useState(setting?.origin ?? DEFAULT_ORIGIN);
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(
    setting?.allowInsecureHttp ?? true,
  );
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!setting) return;
    let alive = true;
    void invoke<string>('configure_server', {
      origin: setting.origin,
      allowInsecureHttp: setting.allowInsecureHttp,
    })
      .then(() => alive && setReady(true))
      .catch(() => {
        if (!alive) return;
        setError(
          '서버 주소를 확인해 주세요. HTTPS 또는 허용한 개발 HTTP 주소를 입력하세요.',
        );
        setSetting(null);
      });
    return () => {
      alive = false;
    };
  }, [setting]);

  async function connect(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      const canonical = await invoke<string>('configure_server', {
        origin,
        allowInsecureHttp,
      });
      const next = { origin: canonical, allowInsecureHttp };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      setReady(true);
      setSetting(next);
    } catch {
      setError(
        '주소에는 https:// 또는 개발용 http:// 서버의 origin만 입력할 수 있습니다.',
      );
    }
  }

  if (!ready || !setting) {
    return (
      <main className="login-page">
        <section className="login-card" aria-labelledby="server-title">
          <div className="brand-mark" aria-hidden="true">
            J
          </div>
          <p className="eyebrow">PRIVATE MESSENGER</p>
          <h1 id="server-title">서버 연결</h1>
          <p className="muted">사용할 메신저 서버의 주소를 입력하세요.</p>
          <form
            className="login-form"
            onSubmit={(event) => void connect(event)}
          >
            <label>
              서버 주소
              <input
                value={origin}
                onChange={(event) => setOrigin(event.target.value)}
                autoComplete="url"
                spellCheck={false}
                required
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={allowInsecureHttp}
                onChange={(event) => setAllowInsecureHttp(event.target.checked)}
              />
              개발 서버의 HTTP 연결 허용
            </label>
            <p className="field-hint">
              HTTPS에서는 서버 인증서를 확인합니다. 토큰은 Windows 자격 증명
              관리자에만 보관합니다.
            </p>
            {error && (
              <p role="alert" className="error-message">
                {error}
              </p>
            )}
            <button className="primary-button full-width" type="submit">
              서버 연결
            </button>
          </form>
        </section>
      </main>
    );
  }

  return <ConnectedMessenger setting={setting} />;
}

function ConnectedMessenger({ setting }: { setting: ServerSetting }) {
  const [client] = useState(() =>
    createMessengerClient({
      baseUrl: setting.origin,
      fetch: nativeFetch,
      socketFactory: nativeSocketFactory,
    }),
  );
  useEffect(() => {
    void client.resumeSession().catch(() => undefined);
    return () => client.dispose();
  }, [client]);
  return <MessengerApp client={client} files={nativeFiles} />;
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('앱을 표시할 영역을 찾을 수 없습니다.');
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
