import { el, clear } from './dom.ts';
import type { MailServer, User, LoginInput, Result } from '../types.ts';
import { validateLogin } from '../lib/validate.ts';

export function mountLogin(
  root: HTMLElement,
  servers: MailServer[],
  onSubmit: (input: LoginInput) => Promise<Result<User>>,
  onSuccess: (user: User) => void,
  options: { demo: boolean }
): void {
  clear(root);
  const doc = root.ownerDocument as Document;

  const form = el(doc, 'form', { className: 'login' });

  if (options.demo) {
    const notice = el(doc, 'p', { className: 'demo-notice', text: '데모 모드: 실제 메일 서버에 연결하지 않습니다' });
    form.appendChild(notice);
  }

  const serverLabel = el(doc, 'label');
  serverLabel.textContent = '메일 서버';
  const select = el(doc, 'select', { attrs: { name: 'serverId' } });
  const defaultOpt = el(doc, 'option', { attrs: { value: '' }, text: '선택하세요' });
  select.appendChild(defaultOpt);
  for (const s of servers) {
    const opt = el(doc, 'option', { attrs: { value: s.id }, text: s.name });
    select.appendChild(opt);
  }
  serverLabel.appendChild(select);
  form.appendChild(serverLabel);

  const usernameLabel = el(doc, 'label');
  usernameLabel.textContent = '아이디';
  const usernameInput = el(doc, 'input', { attrs: { name: 'username', autocomplete: 'username' } });
  usernameLabel.appendChild(usernameInput);
  form.appendChild(usernameLabel);

  const passwordLabel = el(doc, 'label');
  passwordLabel.textContent = '비밀번호';
  const passwordInput = el(doc, 'input', { attrs: { name: 'password', type: 'password', autocomplete: 'current-password' } });
  passwordLabel.appendChild(passwordInput);
  form.appendChild(passwordLabel);

  const button = el(doc, 'button', { text: '로그인', attrs: { type: 'submit' } });
  form.appendChild(button);

  const error = el(doc, 'p', { className: 'login-error', attrs: { role: 'alert' } });
  form.appendChild(error);

  root.appendChild(form);

  let pending = false;

  const handleSubmit = async () => {
    if (pending) return;
    const serverId = select.value;
    const username = usernameInput.value;
    const password = passwordInput.value;
    const validation = validateLogin({ serverId, username, password });
    if (!validation.ok) {
      const map: Record<string, string> = {
        server_required: '메일 서버를 선택하세요',
        username_required: '아이디를 입력하세요',
        password_required: '비밀번호를 입력하세요'
      };
      error.textContent = map[validation.error] || validation.error;
      return;
    }
    pending = true;
    button.disabled = true;
    error.textContent = '';
    try {
      const result = await onSubmit(validation.value);
      if (result.ok) {
        onSuccess(result.value);
      } else if (result.error === 'invalid_credentials') {
        error.textContent = '아이디 또는 비밀번호가 올바르지 않습니다';
        passwordInput.value = '';
      } else {
        error.textContent = '로그인하지 못했습니다';
      }
    } catch {
      error.textContent = '로그인하지 못했습니다';
    } finally {
      pending = false;
      button.disabled = false;
    }
  };

  form.addEventListener('submit', (e: Event) => {
    e.preventDefault();
    void handleSubmit();
  });
}
