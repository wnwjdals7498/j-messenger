// Shared web types. Contract between UI modules and backends.

/** Longest message text accepted after trimming, in UTF-16 code units (string.length). */
export const MESSAGE_MAX_LENGTH = 4000;

/** A mail server the administrator allows for login. Users only talk inside one server. */
export interface MailServer {
  id: string;
  name: string;
}

export interface User {
  id: string;
  serverId: string;
  /** Login name on the mail server, e.g. "alice". */
  username: string;
  displayName: string;
}

export interface Conversation {
  id: string;
  serverId: string;
  title: string;
  memberIds: string[];
  /** ISO 8601 UTC time of the newest message, or null when there is none. */
  lastMessageAt: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  /** Random id chosen by the sending client; one sender never gets two messages with one id. */
  clientMessageId: string;
  text: string;
  /** ISO 8601 UTC time ending in "Z", assigned by the backend. */
  createdAt: string;
}

export interface LoginInput {
  serverId: string;
  username: string;
  password: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Everything the UI needs from a backend. createDemoApi() implements it in memory;
 * an HTTP client implements the same interface later. List methods reject with Error('not_logged_in') before login.
 */
export interface MessengerApi {
  listServers(): Promise<MailServer[]>;
  login(input: LoginInput): Promise<Result<User>>;
  logout(): Promise<void>;
  /** Users on the logged-in user's server, including the logged-in user. */
  listUsers(): Promise<User[]>;
  /** Conversations the logged-in user belongs to, newest lastMessageAt first, null last. */
  listConversations(): Promise<Conversation[]>;
  /** Messages of one visible conversation, oldest first. Rejects with Error('not_found') otherwise. */
  listMessages(conversationId: string): Promise<Message[]>;
  sendMessage(conversationId: string, text: string, clientMessageId: string): Promise<Result<Message>>;
}
