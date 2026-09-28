import type { Conversation } from '../types.ts';
import { el, clear } from './dom.ts';

export function renderSidebar(
  root: HTMLElement,
  conversations: Conversation[],
  selectedId: string | null,
  onSelect: (id: string) => void
): void {
  clear(root);
  const doc = root.ownerDocument;
  if (conversations.length === 0) {
    const p = el(doc, 'p', { className: 'empty', text: '대화가 없습니다' });
    root.appendChild(p);
    return;
  }
  const ul = el(doc, 'ul', { className: 'conversation-list' });
  for (const conv of conversations) {
    const li = doc.createElement('li');
    const btn = el(doc, 'button', {
      className: 'conversation' + (conv.id === selectedId ? ' is-selected' : ''),
      text: conv.title,
      attrs: { type: 'button', 'data-id': conv.id }
    });
    if (conv.id === selectedId) {
      btn.setAttribute('aria-current', 'true');
    }
    btn.addEventListener('click', () => onSelect(conv.id));
    btn.addEventListener('keydown', (e: KeyboardEvent) => {
      const buttons = Array.from(ul.querySelectorAll('button.conversation')) as HTMLButtonElement[];
      const idx = buttons.indexOf(e.currentTarget as HTMLButtonElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (idx < buttons.length - 1) buttons[idx + 1].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (idx > 0) buttons[idx - 1].focus();
      }
    });
    li.appendChild(btn);
    ul.appendChild(li);
  }
  root.appendChild(ul);
}
