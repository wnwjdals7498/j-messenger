import type { MessengerApi, User, Conversation, Message } from './types.ts';
import { el, clear } from './ui/dom.ts';
import { mountLogin } from './ui/login.ts';
import { renderSidebar } from './ui/sidebar.ts';
import { renderMessageList } from './ui/message-list.ts';
import { mountComposer } from './ui/composer.ts';

const showMainPromises: Promise<void>[] = [];

export async function startApp(
  root: HTMLElement,
  api: MessengerApi,
  options: { timeZone: string; demo: boolean }
): Promise<void> {
  const servers = await api.listServers();
  let user: User | null = null;
  let users: User[] = [];
  let conversations: Conversation[] = [];
  let selectedId: string | null = null;
  let pendingSelect = false;
  let pendingSend = false;
  let messagesSection: HTMLElement | null = null;
  let chatTitleEl: HTMLElement | null = null;
  let nav: HTMLElement | null = null;
  let appDiv: HTMLElement | null = null;

  let showMainResolve: (() => void) | null = null;
  let showMainPromise = Promise.resolve();

  const getSortedConversations = (): Conversation[] => {
    return [...conversations].sort((a, b) => {
      if (!a.lastMessageAt && !b.lastMessageAt) return a.id.localeCompare(b.id);
      if (!a.lastMessageAt) return 1;
      if (!b.lastMessageAt) return -1;
      if (b.lastMessageAt !== a.lastMessageAt) {
        return b.lastMessageAt > a.lastMessageAt ? 1 : -1;
      }
      return a.id.localeCompare(b.id);
    });
  };

  const showMain = async (currentUser: User) => {
    showMainPromise = new Promise((resolve) => {
      showMainResolve = resolve;
    });
    showMainPromises.push(showMainPromise);

    user = currentUser;
    root.dataset.view = 'main';
    clear(root);
    const doc = root.ownerDocument as Document;

    appDiv = el(doc, 'div', { className: 'app', attrs: { 'data-pane': 'list' } });
    const aside = el(doc, 'aside', { className: 'sidebar' });
    const sidebarHeader = el(doc, 'header', { className: 'sidebar-header' });
    const meSpan = el(doc, 'span', { className: 'me', text: user?.displayName ?? '' });
    const logoutBtn = el(doc, 'button', { className: 'logout', text: '로그아웃', attrs: { type: 'button' } });
    sidebarHeader.appendChild(meSpan);
    sidebarHeader.appendChild(logoutBtn);
    aside.appendChild(sidebarHeader);

    nav = el(doc, 'nav', { className: 'conversations', attrs: { 'aria-label': '대화 목록' } });
    aside.appendChild(nav);
    appDiv.appendChild(aside);

    const main = el(doc, 'main', { className: 'chat' });
    const chatHeader = el(doc, 'header', { className: 'chat-header' });
    const backBtn = el(doc, 'button', { className: 'back', text: '←', attrs: { type: 'button', 'aria-label': '대화 목록으로' } });
    chatTitleEl = el(doc, 'h1', { className: 'chat-title' });
    chatHeader.appendChild(backBtn);
    chatHeader.appendChild(chatTitleEl);
    main.appendChild(chatHeader);

    messagesSection = el(doc, 'section', { className: 'messages', attrs: { 'aria-live': 'polite' } });
    const emptyP = el(doc, 'p', { className: 'empty', text: '대화를 선택하세요' });
    messagesSection.appendChild(emptyP);
    main.appendChild(messagesSection);

    const composerSlot = el(doc, 'div', { className: 'composer-slot' });
    main.appendChild(composerSlot);

    appDiv.appendChild(main);
    root.appendChild(appDiv);

    users = await api.listUsers();
    conversations = await api.listConversations();

    const selectConversation = async (id: string) => {
      if (pendingSelect) return;
      pendingSelect = true;
      selectedId = id;
      appDiv!.dataset.pane = 'chat';
      const conv = conversations.find(c => c.id === id);
      if (chatTitleEl && conv) chatTitleEl.textContent = conv.title;
      renderSidebar(nav!, getSortedConversations(), selectedId, selectConversation);
      const messages = await api.listMessages(id);
      renderMessageList(messagesSection!, messages, users, user!.id, options.timeZone);
      pendingSelect = false;
    };

    backBtn.addEventListener('click', () => {
      appDiv!.dataset.pane = 'list';
      selectedId = null;
      if (chatTitleEl) chatTitleEl.textContent = '';
      renderSidebar(nav!, getSortedConversations(), null, selectConversation);
      clear(messagesSection!);
      const emptyP = el(messagesSection!.ownerDocument as Document, 'p', { className: 'empty', text: '대화를 선택하세요' });
      messagesSection!.appendChild(emptyP);
    });

    renderSidebar(nav, getSortedConversations(), null, selectConversation);

    const sendMessage = async (text: string): Promise<boolean> => {
      if (pendingSend || !selectedId) return false;
      pendingSend = true;
      const validation = await api.sendMessage(selectedId, text, crypto.randomUUID());
      pendingSend = false;
      if (validation.ok) {
        // Update the conversation's lastMessageAt from the returned message
        const conv = conversations.find(c => c.id === selectedId);
        if (conv) {
          // Get the newly sent message to get its createdAt
          const messages = await api.listMessages(selectedId);
          if (messages.length > 0) {
            const lastMsg = messages[messages.length - 1];
            conv.lastMessageAt = lastMsg.createdAt;
          }
        }
        if (messagesSection) {
          const messages = await api.listMessages(selectedId);
          renderMessageList(messagesSection, messages, users, user!.id, options.timeZone);
        }
        // Re-render sidebar with updated order
        renderSidebar(nav!, getSortedConversations(), selectedId, selectConversation);
      }
      return validation.ok;
    };

    mountComposer(composerSlot!, sendMessage);

    logoutBtn.addEventListener('click', () => {
      user = null;
      selectedId = null;
      api.logout();
      showLogin();
    });

    showMainResolve?.();
  };

  const showLogin = () => {
    root.dataset.view = 'login';
    mountLogin(root, servers, async (input) => {
      return await api.login(input);
    }, (currentUser) => {
      void showMain(currentUser);
    }, { demo: options.demo });
  };

  // Export for testing
  (startApp as any).__getShowMainPromise = () => showMainPromise;
  (startApp as any).__getAllShowMainPromises = () => showMainPromises;

  showLogin();
}
