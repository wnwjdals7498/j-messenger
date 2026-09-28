import type { Message, User } from '../types.ts';
import { el, clear } from './dom.ts';
import { formatDateLabel, formatTime } from '../lib/format.ts';

export function renderMessageList(
  root: HTMLElement,
  messages: Message[],
  users: User[],
  meId: string,
  timeZone: string
): void {
  clear(root);
  const doc = root.ownerDocument as Document;
  if (messages.length === 0) {
    const p = el(doc, 'p', { className: 'empty', text: '메시지가 없습니다' });
    root.appendChild(p);
    return;
  }

  const usersById = new Map(users.map(u => [u.id, u]));
  let prevDateLabel = '';

  for (const msg of messages) {
    const dateLabel = formatDateLabel(msg.createdAt, timeZone);
    if (dateLabel !== prevDateLabel) {
      const sep = el(doc, 'div', { className: 'date-separator', text: dateLabel });
      root.appendChild(sep);
      prevDateLabel = dateLabel;
    }

    const user = usersById.get(msg.senderId);
    const senderName = user ? user.displayName : msg.senderId;
    const isMine = msg.senderId === meId;

    const article = el(doc, 'article', {
      className: 'message' + (isMine ? ' is-mine' : ''),
      attrs: { 'data-id': msg.id }
    });

    const header = doc.createElement('header');
    const senderSpan = el(doc, 'span', { className: 'sender', text: senderName });
    const timeEl = el(doc, 'time', {
      text: formatTime(msg.createdAt, timeZone),
      attrs: { datetime: msg.createdAt }
    });
    header.appendChild(senderSpan);
    header.appendChild(timeEl);
    article.appendChild(header);

    const textP = el(doc, 'p', { className: 'text', text: msg.text });
    article.appendChild(textP);

    root.appendChild(article);
  }
}
