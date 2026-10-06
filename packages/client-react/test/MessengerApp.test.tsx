// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMessengerClient } from '@j-messenger/client-core';
import type { ConversationDto, MessageOutput } from '@j-messenger/contracts';
import { MessengerApp } from '../src/MessengerApp.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const me = {
  id: '1',
  serverId: 'lab',
  displayName: 'Alice',
  enabledFeatures: { files: true, receipts: true, adminRetention: false },
};
const bob = { id: '2', displayName: 'Bob' };
const conversation = {
  id: '9',
  kind: 'direct' as const,
  title: null,
  memberIds: ['1', '2'],
  createdAt: '2026-10-02T00:00:00.000Z',
  lastMessageAt: null,
};
const existingMessage = {
  id: '20',
  conversationId: '9',
  senderId: '2',
  clientMessageId: '00000000-0000-4000-8000-000000000020',
  text: '안녕하세요',
  contentExpired: false,
  fileIds: [],
  createdAt: '2026-10-02T00:00:00.000Z',
};
const attachmentExpired = {
  id: '21',
  conversationId: '9',
  senderId: '2',
  clientMessageId: '00000000-0000-4000-8000-000000000021',
  text: null,
  contentExpired: true,
  fileIds: ['00000000-0000-4000-8000-000000000021'],
  createdAt: '2026-10-02T00:00:00.000Z',
};
function json(body: unknown, status = 200) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'X-Request-Id': '00000000-0000-4000-8000-000000000099',
    },
  });
}
function setup({
  messages = [existingMessage],
  conversations = [conversation],
  currentUser = me,
  logoutStatus = 204,
}: {
  messages?: MessageOutput[];
  conversations?: ConversationDto[];
  currentUser?: typeof me;
  logoutStatus?: number;
} = {}) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  let messageGate: { promise: Promise<void>; release: () => void } | null =
    null;
  let retentionPolicy = { messageDays: 5, fileDays: 14, version: 1 };
  const holdNextMessagePage = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    messageGate = { promise, release };
    return release;
  };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    let body: unknown = null;
    if (request.body) {
      try {
        body = await request.clone().json();
      } catch {
        body = null;
      }
    }
    calls.push({ url: url.pathname, method: request.method, body });
    if (url.pathname.endsWith('/servers'))
      return json({ data: [{ id: 'lab', name: '테스트 서버', aliases: [] }] });
    if (url.pathname.endsWith('/session') && request.method === 'POST')
      return json(null, 204);
    if (url.pathname.endsWith('/session') && request.method === 'DELETE')
      return logoutStatus === 204
        ? json(null, 204)
        : json(
            {
              error: {
                code: 'unavailable',
                message: 'Unavailable',
                requestId: '00000000-0000-4000-8000-000000000099',
              },
            },
            logoutStatus,
          );
    if (url.pathname.endsWith('/me')) return json({ data: currentUser });
    if (url.pathname.endsWith('/users'))
      return json({
        data: [{ id: me.id, displayName: me.displayName }, bob],
        page: { nextCursor: null },
        snapshotCursor: 'users:opaque',
        snapshotPosition: '20',
      });
    if (url.pathname.endsWith('/conversations') && request.method === 'GET')
      return json({
        data: conversations,
        page: { nextCursor: null },
        snapshotCursor: 'conversations:opaque',
        snapshotPosition: '20',
      });
    if (
      /\/conversations\/[^/]+\/messages$/.test(url.pathname) &&
      request.method === 'GET'
    ) {
      const gate = messageGate;
      messageGate = null;
      if (gate) await gate.promise;
      return json({
        data: messages,
        page: { nextCursor: null },
        snapshotCursor: 'messages:opaque',
        snapshotPosition: '20',
      });
    }
    if (url.pathname.endsWith('/messages') && request.method === 'POST') {
      const input = body as {
        clientMessageId: string;
        text: string;
        fileIds?: string[];
      };
      return json({
        data: {
          id: '22',
          conversationId: '9',
          senderId: '1',
          clientMessageId: input.clientMessageId,
          text: input.text,
          contentExpired: false,
          fileIds: input.fileIds ?? [],
          createdAt: '2026-10-02T00:01:00.000Z',
        },
      });
    }
    if (
      /\/conversations\/[^/]+\/files$/.test(url.pathname) &&
      request.method === 'POST'
    )
      return json({
        data: {
          id: '00000000-0000-4000-8000-000000000040',
          filename: 'notes.txt',
          contentType: 'text/plain',
          sizeBytes: 4,
          status: 'ready',
        },
      });
    if (
      url.pathname.endsWith(
        '/files/00000000-0000-4000-8000-000000000021/content',
      )
    )
      return new Response(
        new Blob(['safe attachment'], { type: 'text/plain' }),
        {
          status: 200,
          headers: { 'X-Request-Id': '00000000-0000-4000-8000-000000000099' },
        },
      );
    if (url.pathname.endsWith('/conversations') && request.method === 'POST') {
      const input = body as {
        kind: 'direct' | 'group';
        memberIds: string[];
        title?: string;
      };
      return json({
        data: {
          ...conversation,
          id: '10',
          kind: input.kind,
          memberIds: ['1', ...input.memberIds],
          title: input.title ?? null,
        },
      });
    }
    if (url.pathname.endsWith('/admin/retention') && request.method === 'GET')
      return json({ data: retentionPolicy });
    if (url.pathname.endsWith('/admin/retention') && request.method === 'PUT') {
      const input = body as { messageDays: number; fileDays: number };
      retentionPolicy = { ...input, version: retentionPolicy.version + 1 };
      return json({ data: retentionPolicy });
    }
    return json({ data: [] });
  }) as typeof fetch;
  const client = createMessengerClient({
    baseUrl: 'http://test.local',
    fetch: fetcher,
    idFactory: { uuid: () => '00000000-0000-4000-8000-000000000030' as never },
  });
  return { client, calls, holdNextMessagePage };
}
async function login(user = userEvent.setup()) {
  await screen.findByRole('option', { name: '테스트 서버' });
  await user.type(screen.getByLabelText('사용자 이름'), 'alice');
  await user.type(screen.getByLabelText('비밀번호'), 'dev-only');
  await user.click(screen.getByRole('button', { name: '로그인' }));
  await screen.findByText('Alice', { selector: '.profile-card strong' });
  return user;
}

describe('MessengerApp', () => {
  it('stops read receipt retries after a failure until another visibility event', async () => {
    let notify: ((entries: IntersectionObserverEntry[]) => void) | undefined;
    let target: Element | undefined;
    class Observer {
      constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
        notify = callback;
      }
      observe(element: Element) {
        target = element;
      }
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', Observer);
    const { client } = setup();
    const advance = vi
      .fn<typeof client.advanceRead>()
      .mockRejectedValueOnce(new Error('rate_limited'))
      .mockImplementationOnce(() => new Promise(() => {}));
    render(<MessengerApp client={{ ...client, advanceRead: advance }} />);
    try {
      const user = await login();
      await user.click(screen.getByRole('button', { name: /Alice, Bob/ }));
      await screen.findByText('안녕하세요', { selector: 'p.message-text' });
      await waitFor(() => expect(target).toBeDefined());
      const visible = () =>
        notify?.([
          { isIntersecting: true, target } as IntersectionObserverEntry,
        ]);
      await act(async () => {
        visible();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(advance).toHaveBeenCalledTimes(1);
      await act(async () => {
        visible();
      });
      expect(advance).toHaveBeenCalledTimes(2);
    } finally {
      client.dispose();
    }
  });

  it('logs in, sends with Enter, preserves Shift+Enter and IME composition, and renders markup as text', async () => {
    const user = userEvent.setup();
    const { client, calls } = setup({ messages: [] });
    render(<MessengerApp client={client} />);
    await login(user);
    await user.click(screen.getByRole('button', { name: /Alice, Bob/ }));
    const composer = screen.getByRole('textbox', { name: '메시지 입력' });
    await user.type(composer, '<img src=x onerror=alert(1)>');
    fireEvent.keyDown(composer, { key: 'Enter', isComposing: true });
    expect(
      calls.filter(
        (call) => call.method === 'POST' && call.url.endsWith('/messages'),
      ),
    ).toHaveLength(0);
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect((composer as HTMLTextAreaElement).value).toBe(
      '<img src=x onerror=alert(1)>\n',
    );
    await user.keyboard('{Enter}');
    expect(
      await screen.findByText(
        (_, element) =>
          element?.tagName === 'P' &&
          element.textContent === '<img src=x onerror=alert(1)>',
      ),
    ).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(
      calls.filter(
        (call) => call.method === 'POST' && call.url.endsWith('/messages'),
      ),
    ).toHaveLength(1);
    expect(
      calls.find(
        (call) => call.method === 'POST' && call.url.endsWith('/messages'),
      )?.body,
    ).toMatchObject({
      clientMessageId: '00000000-0000-4000-8000-000000000030',
      text: '<img src=x onerror=alert(1)>',
    });
    client.dispose();
  });

  it('shows expired content and keeps its valid attachment downloadable', async () => {
    const { client } = setup({ messages: [attachmentExpired] });
    const createUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:test');
    const revokeUrl = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => undefined);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    render(<MessengerApp client={client} />);
    const user = await login();
    await user.click(screen.getByRole('button', { name: /Alice, Bob/ }));
    expect(
      screen.getByText('보존 기간이 지난 메시지입니다.', {
        selector: 'p.expired-message',
      }),
    ).toBeTruthy();
    expect(screen.getByText('26. 10. 2. 오전 9:00')).toBeTruthy();
    await user.click(
      screen.getByRole('button', { name: /첨부 파일 다운로드/ }),
    );
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(createUrl).toHaveBeenCalledOnce();
    expect(revokeUrl).toHaveBeenCalledOnce();
    client.dispose();
  });

  it('routes desktop attachment downloads through the OS save dialog bridge', async () => {
    const { client } = setup({ messages: [attachmentExpired] });
    const saveFile = vi.fn(async (_blob: Blob, _name: string) => true);
    render(
      <MessengerApp
        client={client}
        files={{ pickFile: async () => null, saveFile }}
      />,
    );
    const user = await login();
    await user.click(screen.getByRole('button', { name: /Alice, Bob/ }));
    await user.click(
      screen.getByRole('button', { name: /첨부 파일 다운로드/ }),
    );
    await waitFor(() => expect(saveFile).toHaveBeenCalledOnce());
    expect(saveFile.mock.calls[0]?.[1]).toBe(
      'attachment-00000000-0000-4000-8000-000000000021',
    );
    client.dispose();
  });

  it('uploads a file selected by the desktop OS picker bridge', async () => {
    const { client, calls } = setup({ messages: [] });
    const pickFile = vi.fn(
      async () => new File(['safe'], 'notes.txt', { type: 'text/plain' }),
    );
    render(
      <MessengerApp
        client={client}
        files={{ pickFile, saveFile: async () => true }}
      />,
    );
    const user = await login();
    await user.click(screen.getByRole('button', { name: /Alice, Bob/ }));
    await user.click(screen.getByRole('button', { name: '파일 첨부' }));
    expect(await screen.findByText('notes.txt')).toBeTruthy();
    expect(pickFile).toHaveBeenCalledOnce();
    expect(
      calls.some(
        (call) =>
          call.method === 'POST' && /\/conversations\/9\/files$/.test(call.url),
      ),
    ).toBe(true);
    client.dispose();
  });

  it('disables over-limit and whitespace-only messages and clears the draft on logout', async () => {
    const { client, calls } = setup({ messages: [] });
    render(<MessengerApp client={client} />);
    const user = await login();
    await user.click(screen.getByRole('button', { name: /Alice, Bob/ }));
    const composer = screen.getByRole('textbox', { name: '메시지 입력' });
    await user.type(composer, '   ');
    expect(
      (screen.getByRole('button', { name: '전송' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await user.clear(composer);
    fireEvent.change(composer, { target: { value: 'a'.repeat(4001) } });
    expect(
      (screen.getByRole('button', { name: '전송' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await user.clear(composer);
    await user.type(composer, '남아 있으면 안 되는 초안');
    await user.click(screen.getAllByRole('button', { name: '로그아웃' })[0]!);
    expect(
      await screen.findByRole('heading', { name: 'J 메신저' }),
    ).toBeTruthy();
    expect(screen.queryByDisplayValue('남아 있으면 안 되는 초안')).toBeNull();
    expect(
      calls.some(
        (call) => call.method === 'DELETE' && call.url.endsWith('/session'),
      ),
    ).toBe(true);
    client.dispose();
  });

  it('counts UTF-16 code units at the 4,000 limit and submits trimmed text', async () => {
    const { client, calls } = setup({ messages: [] });
    render(<MessengerApp client={client} />);
    const user = await login();
    await user.click(screen.getByRole('button', { name: /Alice, Bob/ }));
    const composer = screen.getByRole('textbox', {
      name: '메시지 입력',
    }) as HTMLTextAreaElement;
    fireEvent.change(composer, {
      target: { value: `  ${'😀'.repeat(2000)}  ` },
    });
    expect(composer.value.length).toBe(4004);
    expect(
      (screen.getByRole('button', { name: '전송' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    await user.click(screen.getByRole('button', { name: '전송' }));
    await waitFor(() =>
      expect(
        calls.find(
          (call) => call.method === 'POST' && call.url.endsWith('/messages'),
        )?.body,
      ).toMatchObject({ text: '😀'.repeat(2000) }),
    );

    fireEvent.change(composer, { target: { value: '😀'.repeat(2001) } });
    expect(
      (screen.getByRole('button', { name: '전송' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    client.dispose();
  });

  it('creates a group from same-server users and displays Korean Seoul time', async () => {
    const { client, calls } = setup({
      messages: [existingMessage],
      conversations: [],
    });
    render(<MessengerApp client={client} />);
    const user = await login();
    await user.click(screen.getByRole('button', { name: '새 대화 만들기' }));
    await user.click(screen.getByLabelText('그룹'));
    await user.type(screen.getByLabelText('그룹 이름'), '프로젝트 팀');
    const participants = screen.getByLabelText('참여자') as HTMLSelectElement;
    await user.selectOptions(participants, '2');
    await user.click(screen.getByRole('button', { name: '대화 시작' }));
    expect(
      await screen.findByRole('heading', { name: '프로젝트 팀' }),
    ).toBeTruthy();
    expect(
      calls.find(
        (call) => call.method === 'POST' && call.url.endsWith('/conversations'),
      )?.body,
    ).toMatchObject({ kind: 'group', memberIds: ['2'], title: '프로젝트 팀' });
    client.dispose();
  });

  it('shows and updates message and file retention as separate periods', async () => {
    const admin = {
      ...me,
      enabledFeatures: { ...me.enabledFeatures, adminRetention: true },
    };
    const { client, calls } = setup({ messages: [], currentUser: admin });
    render(<MessengerApp client={client} />);
    const user = await login();
    await user.click(screen.getByRole('button', { name: '보존 정책' }));
    expect(await screen.findByText('현재 본문 5일 · 첨부 14일')).toBeTruthy();
    await user.clear(screen.getByLabelText('메시지 본문 보존 기간(일)'));
    await user.type(screen.getByLabelText('메시지 본문 보존 기간(일)'), '6');
    await user.clear(screen.getByLabelText('첨부 파일 보존 기간(일)'));
    await user.type(screen.getByLabelText('첨부 파일 보존 기간(일)'), '2');
    await user.click(screen.getByRole('button', { name: '정책 저장' }));
    await screen.findByText('현재 본문 6일 · 첨부 2일');
    expect(
      calls.find(
        (call) =>
          call.url.endsWith('/admin/retention') && call.method === 'PUT',
      )?.body,
    ).toEqual({ messageDays: 6, fileDays: 2 });
    client.dispose();
  });

  it('clears UI-owned drafts when the client generation resets externally', async () => {
    const { client } = setup({ messages: [] });
    render(<MessengerApp client={client} />);
    const user = await login();
    await user.click(screen.getByRole('button', { name: /Alice, Bob/ }));
    const composer = screen.getByRole('textbox', { name: '메시지 입력' });
    await user.type(composer, '폐기할 임시 초안');
    await client.logout();
    await screen.findByRole('heading', { name: 'J 메신저' });
    expect(screen.queryByDisplayValue('폐기할 임시 초안')).toBeNull();
    client.dispose();
  });

  it('clears local UI and explains when server logout cannot be confirmed', async () => {
    const { client } = setup({ messages: [], logoutStatus: 503 });
    render(<MessengerApp client={client} />);
    const user = await login();
    await user.click(screen.getByRole('button', { name: /Alice, Bob/ }));
    await user.type(
      screen.getByRole('textbox', { name: '메시지 입력' }),
      '임시 초안',
    );
    await user.click(screen.getAllByRole('button', { name: '로그아웃' })[0]!);
    await screen.findByRole('heading', { name: 'J 메신저' });
    expect(
      await screen.findByText(/로그아웃 상태를 서버에서 확인하지 못했습니다/),
    ).toBeTruthy();
    expect(screen.queryByDisplayValue('임시 초안')).toBeNull();
    client.dispose();
  });

  it('does not show a delayed message page after logout resets the client', async () => {
    const history = Array.from({ length: 50 }, (_, index) => ({
      ...existingMessage,
      id: String(index + 1),
      clientMessageId: `00000000-0000-4000-8000-${String(index + 101).padStart(12, '0')}`,
      text: `기록 ${index + 1}`,
    }));
    const { client, calls, holdNextMessagePage } = setup({
      messages: history,
    });
    render(<MessengerApp client={client} />);
    const user = await login();
    const release = holdNextMessagePage();
    await user.click(screen.getByRole('button', { name: /Alice, Bob/ }));
    await user.click(
      screen.getByRole('button', { name: '이전 메시지 불러오기' }),
    );
    await waitFor(() =>
      expect(
        calls.filter(
          (call) => call.method === 'GET' && call.url.endsWith('/messages'),
        ).length,
      ).toBeGreaterThan(1),
    );
    await user.click(screen.getAllByRole('button', { name: '로그아웃' })[0]!);
    await screen.findByRole('heading', { name: 'J 메신저' });
    release();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.queryByText('기록 1')).toBeNull();
    client.dispose();
  });

  it('advances read position only after a message is visible', async () => {
    let observeMessage:
      ((entries: IntersectionObserverEntry[]) => void) | undefined;
    const observed: Element[] = [];
    class FakeIntersectionObserver {
      constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
        observeMessage = callback;
      }
      observe(target: Element) {
        observed.push(target);
      }
      disconnect() {
        observed.length = 0;
      }
      unobserve() {}
      takeRecords() {
        return [];
      }
      root = null;
      rootMargin = '0px';
      thresholds = [0.5];
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const { client, calls } = setup();
    render(<MessengerApp client={client} />);
    const user = await login();
    await user.click(screen.getByRole('button', { name: /Alice, Bob/ }));
    await screen.findByText('안녕하세요', { selector: 'p.message-text' });
    await waitFor(() => expect(observed.length).toBeGreaterThan(0));
    expect(
      calls.some((call) => call.method === 'PUT' && call.url.endsWith('/read')),
    ).toBe(false);
    observeMessage?.([
      {
        isIntersecting: true,
        target: observed[0]!,
      } as IntersectionObserverEntry,
    ]);
    await waitFor(() =>
      expect(
        calls.some(
          (call) => call.method === 'PUT' && call.url.endsWith('/read'),
        ),
      ).toBe(true),
    );
    expect(
      calls.find((call) => call.method === 'PUT' && call.url.endsWith('/read'))
        ?.body,
    ).toMatchObject({ lastReadMessageId: existingMessage.id });
    client.dispose();
  });
});
