import { DEMO_SERVERS, DEMO_USERS, DEMO_CONVERSATIONS, DEMO_MESSAGES } from './demo-data.ts';
import type { MessengerApi, User, Message, Conversation, MailServer, LoginInput, Result } from '../types.ts';
import { validateMessageText } from '../lib/validate.ts';

export function createDemoApi(options: { now?: () => Date } = {}): MessengerApi {
  let servers = structuredClone(DEMO_SERVERS);
  let users = structuredClone(DEMO_USERS);
  let conversations = structuredClone(DEMO_CONVERSATIONS);
  let messages = structuredClone(DEMO_MESSAGES);
  let currentUser: User | null = null;
  const now = options.now ?? (() => new Date());

  return {
    async listServers(): Promise<MailServer[]> {
      return structuredClone(servers);
    },

    async login(input: LoginInput): Promise<Result<User>> {
      const username = input.username.trim();
      const user = users.find(u => u.serverId === input.serverId && u.username === username);
      if (!user || input.password === '') {
        currentUser = null;
        return { ok: false, error: 'invalid_credentials' };
      }
      currentUser = structuredClone(user);
      return { ok: true, value: structuredClone(user) };
    },

    async logout(): Promise<void> {
      currentUser = null;
    },

    async listUsers(): Promise<User[]> {
      if (!currentUser) throw new Error('not_logged_in');
      const cu = currentUser;
      return structuredClone(users.filter(u => u.serverId === cu.serverId));
    },

    async listConversations(): Promise<Conversation[]> {
      if (!currentUser) throw new Error('not_logged_in');
      const cu = currentUser;
      const visible = conversations.filter(c => c.memberIds.includes(cu.id));
      const sorted = visible.sort((a, b) => {
        if (!a.lastMessageAt && !b.lastMessageAt) return a.id.localeCompare(b.id);
        if (!a.lastMessageAt) return 1;
        if (!b.lastMessageAt) return -1;
        if (b.lastMessageAt !== a.lastMessageAt) {
          return b.lastMessageAt > a.lastMessageAt ? 1 : -1;
        }
        return a.id.localeCompare(b.id);
      });
      return structuredClone(sorted);
    },

    async listMessages(conversationId: string): Promise<Message[]> {
      if (!currentUser) throw new Error('not_logged_in');
      const cu = currentUser;
      const conv = conversations.find(c => c.id === conversationId);
      if (!conv || !conv.memberIds.includes(cu.id)) throw new Error('not_found');
      const msgs = messages.filter(m => m.conversationId === conversationId);
      return structuredClone(msgs.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
    },

    async sendMessage(conversationId: string, text: string, clientMessageId: string): Promise<Result<Message>> {
      if (!currentUser) return { ok: false, error: 'not_logged_in' };
      const cu = currentUser;
      const conv = conversations.find(c => c.id === conversationId);
      if (!conv || !conv.memberIds.includes(cu.id)) return { ok: false, error: 'not_found' };
      
      const validation = validateMessageText(text);
      if (!validation.ok) return validation;
      
      const existing = messages.find(m => m.senderId === cu.id && m.clientMessageId === clientMessageId);
      if (existing) return { ok: true, value: structuredClone(existing) };
      
      const createdAt = now().toISOString();
      const newMessage: Message = {
        id: 'm-' + (messages.length + 1),
        conversationId,
        senderId: cu.id,
        clientMessageId,
        text: validation.value,
        createdAt
      };
      messages.push(newMessage);
      conv.lastMessageAt = createdAt;
      return { ok: true, value: structuredClone(newMessage) };
    }
  };
}
