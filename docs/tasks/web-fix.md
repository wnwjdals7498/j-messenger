# Batch WF: fix batch W defects (T32-T41)

Planner review of batch W (2026-09-29) found weakened tests, a broken narrow-screen layout and
test-only hooks in `web/src/app.ts`. These tasks restore the tests to the spec and fix the code.

Executor: read ONLY the `## T<n>` section of your current task, plus the "Common rules" of
`docs/tasks/web.md` and the files the section names. Do not ask questions.

## Rules for this batch (in addition to docs/tasks/web.md Common rules)

- **Write files only with your file edit/patch tool.** Never write file content through PowerShell
  strings (`Set-Content`, `Out-File`, `echo >`, here-strings): PowerShell turns `` `b ``, `` `n `` and
  `` `" `` into control characters. That broke `web/README.md` in batch W.
- Never escape quotes inside CSS or TypeScript files: write `[data-pane="list"]`, not `[data-pane=\"list\"]`.
- A "Test:" task rewrites the test file so it matches the spec. It never touches `web/src/`.
- An "Impl:" task never touches `web/test/`. If a test looks wrong, set the task blocked.
- Verify with `node scripts/verify.mjs T<n>`. It also fails when anything outside the task's
  `files:` (except `.ctx/`) differs from the last commit, so commit every finished task.

## T32 Remove the stray debug test

Files: `web/test/composer-test-debug.ts`

Delete `web/test/composer-test-debug.ts`. It is not part of any task and has no assertions.

## T33 Test: restore the styles test

Files: `web/test/styles.test.ts`

Rewrite the file so it matches section T28 of `docs/tasks/web.md` exactly:
- Read the CSS at the top level with
  `const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');`
- Keep the `block(start)` helper from T28.
- `test('message text keeps line breaks')` must be exactly:
  `assert.ok(/\.text\s*\{[^}]*white-space:\s*pre-wrap/.test(css));`
- `test('narrow screens show one pane at a time')` must be exactly:
  ```ts
  const m = block('@media (max-width: 640px)');
  assert.ok(m.includes('[data-pane="list"] .chat'));
  assert.ok(m.includes('[data-pane="chat"] .sidebar'));
  assert.ok(m.includes('display: none'));
  ```
- The other four tests follow T28 as written.

The narrow-screen test must FAIL now: `web/src/styles.css` currently contains `[data-pane=\"list\"]`
with backslashes, which the browser never matches. T34 fixes the CSS. Do not change `web/src/styles.css` here.

## T34 Impl: fix the narrow-screen selectors

Files: `web/src/styles.css`

Inside `@media (max-width: 640px)` replace the two selectors that contain backslashes with exactly
`[data-pane="list"] .chat` and `[data-pane="chat"] .sidebar` (plain double quotes, no backslash).
The file must not contain the two characters `\"` anywhere. Keep everything else.

## T35 Test: restore the composer test

Files: `web/test/composer.test.ts`

Rewrite to match section T18 of `docs/tasks/web.md`, with these exact details:
- `test('Enter sends and Shift+Enter does not')`:
  ```ts
  textarea.value = 'a';
  const shifted = keydown(window, textarea, { key: 'Enter', shiftKey: true });
  await settle();
  assert.deepEqual(calls, []);
  assert.equal(shifted.defaultPrevented, false);
  const ev = keydown(window, textarea, { key: 'Enter' });
  await settle();
  assert.deepEqual(calls, ['a']);
  assert.equal(ev.defaultPrevented, true);
  ```
- `test('too long text shows an error and does not send')`: set `textarea.value = 'x'.repeat(4001)`
  **without** removing the `maxlength` attribute, click, `await settle()`, assert no calls and error
  text `'4000자 이하로 입력하세요'`.
- `test('a rejected send behaves like a failed send')`: onSend is `() => Promise.reject(new Error('x'))`.
- All other tests as in T18.

The too-long test must FAIL now: happy-dom (like browsers) refuses to submit a form whose field is longer
than `maxlength`. T36 fixes the form.

## T36 Impl: composer form skips browser validation

Files: `web/src/ui/composer.ts`

Add the `novalidate` attribute to the composer form (`form.setAttribute('novalidate', '')`), so the
form always submits and `validateMessageText` shows the Korean error. Change nothing else.

## T37 Test: restore sidebar and dom assertions

Files: `web/test/sidebar.test.ts`, `web/test/dom.test.ts`

- sidebar `test('clicking a conversation calls onSelect with its id')` must record calls and assert exactly once:
  ```ts
  const selected: string[] = [];
  renderSidebar(root, convs, null, (id) => selected.push(id));
  (root.querySelector('button[data-id="c3"]') as HTMLButtonElement).click();
  assert.deepEqual(selected, ['c3']);
  ```
- dom `test('clear removes every child')`: the div gets 3 element children and 1 text node before `clear(div)`,
  then `div.childNodes.length === 0`.
- Everything else as in T12 and T14. Both files must pass against the current code.

## T38 Test: restore login assertions

Files: `web/test/login.test.ts`

Rewrite the whole file to match section T20 of `docs/tasks/web.md`, using only `assert.equal`, `assert.deepEqual`,
`assert.ok` and `assert.rejects`, and no `\"` escapes (use `'button[type="submit"]'`). In addition,
in `test('valid input submits a trimmed username and calls onSuccess')` record every call:
```ts
const submitted: LoginInput[] = [];
const succeeded: User[] = [];
// onSubmit: (input) => { submitted.push(input); return Promise.resolve({ ok: true, value: user }); }
// onSuccess: (u) => { succeeded.push(u); }
assert.equal(submitted.length, 1);
assert.deepEqual(submitted[0], { serverId: 'mail-a', username: 'alice', password: 'pw' });
assert.equal(succeeded.length, 1);
assert.deepEqual(succeeded[0], user);
```
Import the types with `import type { LoginInput, User } from '../src/types.ts';`. All other tests as in T20.

## T39 Test: restore the app helpers and app tests

Files: `web/test/helpers/app.ts`, `web/test/app-login.test.ts`, `web/test/app-send.test.ts`, `web/test/app-select.test.ts`

- `web/test/helpers/app.ts` exactly as section T22 describes: static imports only, `login()` fills the
  form, clicks submit and does `await settle()`. No dynamic `import(`, no `as any`, no calls to hooks on
  `startApp`, no polling loops.
- `app-login.test.ts`, in `test('alice sees the main layout with her conversations')`:
  `assert.ok(root.querySelector('.composer-slot form.composer'));`
- `app-send.test.ts`, in `test('sending adds my message to the open conversation')`: take the last
  `.messages article.message`, assert `last.querySelector('.text').textContent === '앱 테스트'` (exact, not `includes`)
  and `last.classList.contains('is-mine')`.
- `app-select.test.ts`: keep the five T24 tests and add a sixth at the end:
  ```ts
  test('sending still works after going back to the list', async () => {
    const { root } = await startAndLogin('alice');
    (root.querySelector('.sidebar button.conversation[data-id="c-team"]') as HTMLButtonElement).click();
    await settle();
    (root.querySelector('.back') as HTMLButtonElement).click();
    await settle();
    assert.equal((root.querySelector('.app') as HTMLElement).dataset.pane, 'list');
    assert.equal(root.querySelector('.sidebar button.conversation[data-id="c-team"]')?.getAttribute('aria-current'), 'true');
    (root.querySelector('form.composer textarea') as HTMLTextAreaElement).value = '뒤로 간 뒤 전송';
    (root.querySelector('form.composer button[type="submit"]') as HTMLButtonElement).click();
    await settle();
    assert.equal(messageIds(root).length, 4);
  });
  ```
  Import `settle` from `'./helpers/dom.ts'`. This test must FAIL now (the back button currently clears the selection). T40 fixes it.

## T40 Impl: app.ts back to the spec

Files: `web/src/app.ts`

Make `web/src/app.ts` follow sections T23, T25 and T27 of `docs/tasks/web.md` exactly:
- Remove the module-level `showMainPromises` array, every `(startApp as any)...` hook and all `as any`.
  State lives only in variables inside `startApp`.
- Back button: only `app.dataset.pane = 'list'`. Keep `selectedId`, the title, the sidebar selection and the messages.
- `send(text)`: no selection → `false`. `const r = await api.sendMessage(selectedId, text, crypto.randomUUID())`;
  not ok → `false`. Ok → `conversations = await api.listConversations()`, re-render the sidebar with `selectedId`,
  `renderMessageList(...)` with `await api.listMessages(selectedId)`, return `true`. No `pendingSend` flag
  (the composer already blocks double submits).
- `select(id)`: no `pendingSelect` flag.
- Logout: `await api.logout()`, `selectedId = null`, then `showLogin()`.
- Remove unused imports.

## T41 Web README for Windows

Files: `web/README.md`

Rewrite `web/README.md` with your file edit tool (never through PowerShell). Content, in Korean:

1. `# j-messenger 웹` and the sentence: 데모 모드는 브라우저 메모리의 표본 데이터로 동작하고 서버에 연결하지 않는다.
2. `## 실행 (Windows PowerShell)` followed by exactly this block:
   ````text
   ```powershell
   cd D:\workspace\test-space\github\j-messenger
   npm --prefix web install
   npm --prefix web run dev
   ```
   ````
   then the sentence: 브라우저에서 `http://localhost:5173` 을 연다.
3. `## 데모 계정`: a table with columns `메일 서버 | 아이디`, rows `A사 메일 | alice, bob, carol` and
   `B사 메일 | dave, erin`, then the sentence: 비밀번호는 비어 있지 않은 아무 값.
4. `## 확인 절차`: numbered list: alice로 로그인 → `팀 채널` 선택 → 메시지 3개와 날짜 구분선 2개 확인 →
   메시지 전송 → 목록 맨 위로 이동 확인 → 브라우저 폭 360px에서 목록↔대화 전환(← 버튼) 확인 → 로그아웃.
5. `## 명령`: bullets `` `npm --prefix web test` `` (전체 테스트) and `` `npm --prefix web run build` `` (타입 검사 + 빌드, 결과는 web/dist).
