import type { MailServer, User, Conversation, Message } from '../types.ts';

export const DEMO_SERVERS: MailServer[] = [
  { id: 'mail-a', name: 'A사 메일' },
  { id: 'mail-b', name: 'B사 메일' }
];

export const DEMO_USERS: User[] = [
  { id: 'u-alice', serverId: 'mail-a', username: 'alice', displayName: '앨리스' },
  { id: 'u-bob', serverId: 'mail-a', username: 'bob', displayName: '밥' },
  { id: 'u-carol', serverId: 'mail-a', username: 'carol', displayName: '캐럴' },
  { id: 'u-dave', serverId: 'mail-b', username: 'dave', displayName: '데이브' },
  { id: 'u-erin', serverId: 'mail-b', username: 'erin', displayName: '에린' }
];

export const DEMO_CONVERSATIONS: Conversation[] = [
  { id: 'c-alice-bob', serverId: 'mail-a', title: '앨리스, 밥', memberIds: ['u-alice', 'u-bob'], lastMessageAt: '2026-09-21T02:05:00Z' },
  { id: 'c-team', serverId: 'mail-a', title: '팀 채널', memberIds: ['u-alice', 'u-bob', 'u-carol'], lastMessageAt: '2026-09-22T05:40:00Z' },
  { id: 'c-b-chat', serverId: 'mail-b', title: '데이브, 에린', memberIds: ['u-dave', 'u-erin'], lastMessageAt: '2026-09-22T03:00:00Z' }
];

export const DEMO_MESSAGES: Message[] = [
  { id: 'm-1', conversationId: 'c-alice-bob', senderId: 'u-alice', clientMessageId: 'k-1', text: '밥, 점심 같이 먹을래?', createdAt: '2026-09-21T02:00:00Z' },
  { id: 'm-2', conversationId: 'c-alice-bob', senderId: 'u-bob', clientMessageId: 'k-2', text: '좋아요. 12시에 봐요.', createdAt: '2026-09-21T02:05:00Z' },
  { id: 'm-3', conversationId: 'c-team', senderId: 'u-carol', clientMessageId: 'k-3', text: '주간 회의는 목요일 10시입니다.', createdAt: '2026-09-21T09:30:00Z' },
  { id: 'm-4', conversationId: 'c-b-chat', senderId: 'u-dave', clientMessageId: 'k-4', text: '에린, 자료 받았어요?', createdAt: '2026-09-21T10:00:00Z' },
  { id: 'm-5', conversationId: 'c-team', senderId: 'u-bob', clientMessageId: 'k-5', text: '<b>굵게</b> 보이면 안 됩니다', createdAt: '2026-09-22T01:15:00Z' },
  { id: 'm-6', conversationId: 'c-b-chat', senderId: 'u-erin', clientMessageId: 'k-6', text: '네, 받았습니다.', createdAt: '2026-09-22T03:00:00Z' },
  { id: 'm-7', conversationId: 'c-team', senderId: 'u-alice', clientMessageId: 'k-7', text: '확인했습니다.\n자료는 내일 공유할게요.', createdAt: '2026-09-22T05:40:00Z' }
];
