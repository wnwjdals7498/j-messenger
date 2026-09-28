import { el, clear } from './dom.ts';
import { validateMessageText } from '../lib/validate.ts';

export function mountComposer(
  root: HTMLElement,
  onSend: (text: string) => Promise<boolean>
): void {
  clear(root);
  const doc = root.ownerDocument as Document;

  const form = el(doc, 'form', { className: 'composer' });
  const textarea = el(doc, 'textarea', {
    attrs: { name: 'text', rows: '2', maxlength: '4000', 'aria-label': '메시지 입력', placeholder: '메시지를 입력하세요' }
  });
  const button = el(doc, 'button', { text: '보내기', attrs: { type: 'submit' } });
  const error = el(doc, 'p', { className: 'composer-error', attrs: { 'aria-live': 'polite' } });

  form.appendChild(textarea);
  form.appendChild(button);
  form.appendChild(error);
  root.appendChild(form);

  let pending = false;

  const submit = async () => {
    if (pending) return;
    const text = textarea.value;
    const validation = validateMessageText(text);
    if (!validation.ok) {
      error.textContent = validation.error === 'empty' ? '메시지를 입력하세요' : '4000자 이하로 입력하세요';
      return;
    }
    pending = true;
    button.disabled = true;
    error.textContent = '';
    try {
      const ok = await onSend(validation.value);
      if (ok) {
        textarea.value = '';
        error.textContent = '';
      } else {
        error.textContent = '전송하지 못했습니다';
      }
    } catch {
      error.textContent = '전송하지 못했습니다';
    } finally {
      pending = false;
      button.disabled = false;
    }
  };

  form.addEventListener('submit', (e: Event) => {
    e.preventDefault();
    void submit();
  });

  textarea.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void submit();
    }
  });
}
