# Batch W: web demo UI (T1-T31)

Executor: read ONLY the `## T<n>` section of your current task, plus the files it names.
Everything here is decided. Do not ask questions. If something is impossible, set the task blocked.

## Common rules for every task

- Run all commands from the repo root `/mnt/d/workspace/test-space/github/j-messenger`.
- Code style: TypeScript strict, ES modules, 2-space indent, single quotes, semicolons, LF.
- Import local files with the `.ts` extension, e.g. `import { formatTime } from '../lib/format.ts';`.
- Type-only imports use `import type { Message } from '../types.ts';`.
- Forbidden: `enum`, `namespace`, constructor parameter properties, decorators, `any` (use `unknown`),
  `innerHTML`, `outerHTML`, `insertAdjacentHTML`, new npm packages, global `document`/`window`
  outside `web/src/main.ts`.
- DOM code creates elements with `root.ownerDocument.createElement(...)` and sets text with `textContent`.
- UI strings are Korean exactly as written in this spec. Code, comments and commit messages are English.

### Test file rules (tasks named "Test: ...")

- Start every test file with:
  ```ts
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  ```
- Every test is a top-level call starting at column 0: `test('name', () => { ... });`
  or `test('name', async () => { ... });`. No `describe`, no nested tests.
  The name is in single quotes: the verify command counts lines starting with `test('`.
- Use `assert.equal`, `assert.deepEqual`, `assert.ok`, `assert.rejects` only.
- DOM tests: `import { createDom, tick, settle, keydown } from './helpers/dom.ts';` then
  `const { window, document, root } = createDom();` inside each test.
- Write exactly the tests listed, with the listed names. You may add more assertions, never fewer.
- The module under test may not exist yet. That is expected. Do not create it.

### Implementation rules (tasks named "Impl: ...")

- Make the named test file pass. Never edit any file under `web/test/`.
- Export exactly the listed names and signatures. Extra private helpers are fine.

---

## T1 Scaffold the web project

Files: `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html`, `web/src/main.ts`, `web/package-lock.json`

Create these files with exactly this content, then run `npm --prefix web install --no-audit --no-fund`
(this creates `web/package-lock.json` and `web/node_modules/`; node_modules is git-ignored).

`web/package.json`:
```json
{
  "name": "j-messenger-web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "engines": {
    "node": ">=22.18.0"
  },
  "scripts": {
    "dev": "vite --host 127.0.0.1 --port 5173 --strictPort",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "build": "tsc --noEmit -p tsconfig.json && vite build",
    "test": "node --test --test-reporter=spec \"test/**/*.test.ts\"",
    "check": "tsc --noEmit -p tsconfig.json && node --test --test-reporter=spec"
  },
  "devDependencies": {
    "happy-dom": "20.14.5",
    "typescript": "5.9.3",
    "vite": "7.3.6"
  }
}
```

`web/tsconfig.json` (tests are not type-checked; Node strips their types at run time):
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "isolatedModules": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["src"]
}
```

`web/vite.config.ts`:
```ts
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
```

`web/index.html`:
```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>j-messenger</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`web/src/main.ts` (temporary; T30 replaces it):
```ts
// Placeholder until T30 wires the app.
const root = document.getElementById('app');
if (root) {
  root.textContent = 'j-messenger';
}
```

Verify: install succeeds, build succeeds, `web/package-lock.json` and `web/dist/index.html` exist.

## T2 Shared types

Files: `web/src/types.ts`

Create `web/src/types.ts` with exactly this content. Later tasks import it. Nobody edits it after T2.

```ts
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
 * an HTTP client implements the same interface later.
 * List methods reject with Error('not_logged_in') before login.
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
```

## T3 DOM test helper and smoke test

Files: `web/test/helpers/dom.ts`, `web/test/smoke.test.ts`

`web/test/helpers/dom.ts`, exactly:
```ts
// Test helper. Creates an isolated happy-dom document for one test.
import { Window } from 'happy-dom';

export function createDom() {
  const window = new Window({ url: 'http://localhost:5173/' });
  const document = window.document as unknown as Document;
  const root = document.createElement('div');
  root.id = 'app';
  document.body.appendChild(root);
  return { window, document, root };
}

/** Wait one macrotask so pending promises and setTimeout(0) callbacks run. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Wait several macrotasks; use after actions that chain awaits. */
export async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}

/** Dispatch a bubbling, cancelable keydown on target and return the event. */
export function keydown(window: Window, target: EventTarget, init: Record<string, unknown> = {}) {
  const event = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event as unknown as Event);
  return event;
}
```

`web/test/smoke.test.ts` with these tests:
- `test('createDom gives a connected root')`: `root.id` is `'app'`; `root.parentElement === document.body`.
- `test('textContent never parses HTML')`: create a `p`, set `textContent = '<b>x</b>'`; `p.querySelector('b')` is `null`; `p.textContent` is `'<b>x</b>'`.
- `test('keydown helper reports isComposing and preventDefault')`: add a `keydown` listener on `root` that calls `event.preventDefault()`; `const ev = keydown(window, root, { key: 'Enter', isComposing: true })`; `ev.isComposing === true`; `ev.defaultPrevented === true`.

## T4 Test: format

Files: `web/test/format.test.ts`

Imports: `import { formatTime, formatDateLabel, isSameDay } from '../src/lib/format.ts';` and `const TZ = 'Asia/Seoul';`

- `test('formatTime returns 24-hour HH:mm in the given time zone')`:
  `formatTime('2026-09-23T05:07:00Z', TZ)` → `'14:07'`; `formatTime('2026-09-23T15:30:00Z', TZ)` → `'00:30'`;
  `formatTime('2026-09-23T15:30:00Z', 'UTC')` → `'15:30'`; `formatTime('2026-09-23T15:30:00.123Z', 'UTC')` → `'15:30'`.
- `test('formatTime returns an empty string for invalid input')`: `formatTime('not-a-date', TZ)` → `''`; `formatTime('', TZ)` → `''`.
- `test('formatDateLabel returns YYYY-MM-DD in the given time zone')`:
  `formatDateLabel('2026-09-23T14:59:00Z', TZ)` → `'2026-09-23'`; `formatDateLabel('2026-09-23T15:00:00Z', TZ)` → `'2026-09-24'`;
  `formatDateLabel('2026-01-05T00:00:00Z', 'UTC')` → `'2026-01-05'`.
- `test('formatDateLabel returns an empty string for invalid input')`: `formatDateLabel('garbage', TZ)` → `''`.
- `test('isSameDay compares calendar days in the given time zone')`:
  `isSameDay('2026-09-23T00:00:00Z', '2026-09-23T14:59:00Z', TZ)` → `true`;
  `isSameDay('2026-09-23T14:59:00Z', '2026-09-23T15:00:00Z', TZ)` → `false`;
  `isSameDay('2026-09-23T14:59:00Z', '2026-09-23T15:00:00Z', 'UTC')` → `true`.
- `test('isSameDay is false when either value is invalid')`: `isSameDay('bad', 'bad', TZ)` → `false`; `isSameDay('2026-09-23T00:00:00Z', 'bad', TZ)` → `false`.

## T5 Impl: format

Files: `web/src/lib/format.ts`

Export:
- `formatTime(iso: string, timeZone: string): string`
- `formatDateLabel(iso: string, timeZone: string): string`
- `isSameDay(aIso: string, bIso: string, timeZone: string): boolean`

Rules:
- Parse with `new Date(iso)`. If `Number.isNaN(date.getTime())` return `''` (or `false` for isSameDay).
- formatTime: `new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(date)`.
- formatDateLabel: `new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(date)` (gives `YYYY-MM-DD`).
- isSameDay: both labels non-empty and equal.

Make `web/test/format.test.ts` pass.

## T6 Test: validate

Files: `web/test/validate.test.ts`

Imports: `validateMessageText`, `validateLogin` from `'../src/lib/validate.ts'`; `MESSAGE_MAX_LENGTH` from `'../src/types.ts'`.

- `test('validateMessageText trims surrounding whitespace')`: `'  hi \n'` → `{ ok: true, value: 'hi' }`.
- `test('validateMessageText keeps inner newlines')`: `'a\nb'` → `{ ok: true, value: 'a\nb' }`.
- `test('validateMessageText rejects empty or whitespace-only text')`: `''` and `'   \n\t'` → `{ ok: false, error: 'empty' }`.
- `test('validateMessageText limits length after trimming')`: `MESSAGE_MAX_LENGTH` equals `4000`;
  `'x'.repeat(4000)` → ok with the same value; `' ' + 'x'.repeat(4000) + ' '` → ok with `'x'.repeat(4000)`;
  `'x'.repeat(4001)` → `{ ok: false, error: 'too_long' }`.
- `test('validateLogin checks server, then username, then password')`:
  `{ serverId: '', username: '', password: '' }` → `{ ok: false, error: 'server_required' }`;
  `{ serverId: '', username: 'a', password: 'p' }` → `server_required`;
  `{ serverId: 'mail-a', username: '  ', password: 'p' }` → `{ ok: false, error: 'username_required' }`;
  `{ serverId: 'mail-a', username: 'alice', password: '' }` → `{ ok: false, error: 'password_required' }`.
- `test('validateLogin trims the username but never the password')`:
  `{ serverId: 'mail-a', username: ' alice ', password: ' p ' }` → `{ ok: true, value: { serverId: 'mail-a', username: 'alice', password: ' p ' } }`;
  `{ serverId: 'mail-a', username: 'bob', password: '   ' }` → ok with password `'   '` unchanged.

## T7 Impl: validate

Files: `web/src/lib/validate.ts`

Export:
- `validateMessageText(raw: string): Result<string>`: `const text = raw.trim()`. Empty → `{ ok: false, error: 'empty' }`.
  `text.length > MESSAGE_MAX_LENGTH` → `{ ok: false, error: 'too_long' }`. Else `{ ok: true, value: text }`.
- `validateLogin(input: LoginInput): Result<LoginInput>`: check in this order:
  `input.serverId === ''` → `server_required`; `input.username.trim() === ''` → `username_required`;
  `input.password === ''` → `password_required`.
  Else `{ ok: true, value: { serverId: input.serverId, username: input.username.trim(), password: input.password } }`.

Import `MESSAGE_MAX_LENGTH`, `type Result`, `type LoginInput` from `'../types.ts'`.
Make `web/test/validate.test.ts` pass.

## T8 Test: demo data

Files: `web/test/demo-data.test.ts`

Imports: `DEMO_SERVERS`, `DEMO_USERS`, `DEMO_CONVERSATIONS`, `DEMO_MESSAGES` from `'../src/demo/demo-data.ts'`; `MESSAGE_MAX_LENGTH` from `'../src/types.ts'`.
Helper inside the test file: `const seoulDate = (iso: string) => new Date(Date.parse(iso) + 9 * 3600 * 1000).toISOString().slice(0, 10);`

- `test('servers are mail-a and mail-b')`: `DEMO_SERVERS.map(s => s.id)` deep-equals `['mail-a', 'mail-b']`; names `['A사 메일', 'B사 메일']`.
- `test('users are the fixed demo accounts')`: `DEMO_USERS.map(u => [u.id, u.serverId, u.username, u.displayName])` deep-equals
  `[['u-alice','mail-a','alice','앨리스'], ['u-bob','mail-a','bob','밥'], ['u-carol','mail-a','carol','캐럴'], ['u-dave','mail-b','dave','데이브'], ['u-erin','mail-b','erin','에린']]`.
- `test('conversations are the fixed demo conversations')`: `DEMO_CONVERSATIONS.map(c => [c.id, c.serverId, c.title, c.memberIds])` deep-equals
  `[['c-alice-bob','mail-a','앨리스, 밥',['u-alice','u-bob']], ['c-team','mail-a','팀 채널',['u-alice','u-bob','u-carol']], ['c-b-chat','mail-b','데이브, 에린',['u-dave','u-erin']]]`.
- `test('every member belongs to the conversation server')`: for each conversation, every member id is a user whose `serverId` equals the conversation `serverId`.
- `test('messages reference existing conversations and member senders')`: for each message, its conversation exists and `memberIds` includes `senderId`.
- `test('messages are unique, valid and sorted oldest first')`: 7 messages; ids unique; every `createdAt` matches `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/`; every `createdAt` < `'2026-09-23T00:00:00Z'` (string compare); list sorted ascending by `createdAt`; `senderId + ':' + clientMessageId` unique; every text is non-empty and `length <= MESSAGE_MAX_LENGTH`.
- `test('lastMessageAt equals the newest message of each conversation')`: for each conversation, `lastMessageAt` equals the max `createdAt` of its messages.
- `test('team conversation spans two Seoul dates and contains HTML-like text')`: messages of `c-team` have exactly 2 distinct `seoulDate` values; some message in `c-team` has a text that includes `'<b>'`.
- `test('team conversation is the newest on mail-a')`: `c-team.lastMessageAt > c-alice-bob.lastMessageAt`.

## T9 Impl: demo data

Files: `web/src/demo/demo-data.ts`

Export typed constants (import types from `'../types.ts'`): `DEMO_SERVERS: MailServer[]`, `DEMO_USERS: User[]`,
`DEMO_CONVERSATIONS: Conversation[]`, `DEMO_MESSAGES: Message[]`. Use exactly this data, in this order.

Servers: `{ id: 'mail-a', name: 'A사 메일' }`, `{ id: 'mail-b', name: 'B사 메일' }`.

Users (id, serverId, username, displayName):
| id | serverId | username | displayName |
| --- | --- | --- | --- |
| u-alice | mail-a | alice | 앨리스 |
| u-bob | mail-a | bob | 밥 |
| u-carol | mail-a | carol | 캐럴 |
| u-dave | mail-b | dave | 데이브 |
| u-erin | mail-b | erin | 에린 |

Conversations (id, serverId, title, memberIds, lastMessageAt):
| id | serverId | title | memberIds | lastMessageAt |
| --- | --- | --- | --- | --- |
| c-alice-bob | mail-a | 앨리스, 밥 | u-alice, u-bob | 2026-09-21T02:05:00Z |
| c-team | mail-a | 팀 채널 | u-alice, u-bob, u-carol | 2026-09-22T05:40:00Z |
| c-b-chat | mail-b | 데이브, 에린 | u-dave, u-erin | 2026-09-22T03:00:00Z |

Messages (id, conversationId, senderId, clientMessageId, text, createdAt):
| id | conversationId | senderId | clientMessageId | text | createdAt |
| --- | --- | --- | --- | --- | --- |
| m-1 | c-alice-bob | u-alice | k-1 | 밥, 점심 같이 먹을래? | 2026-09-21T02:00:00Z |
| m-2 | c-alice-bob | u-bob | k-2 | 좋아요. 12시에 봐요. | 2026-09-21T02:05:00Z |
| m-3 | c-team | u-carol | k-3 | 주간 회의는 목요일 10시입니다. | 2026-09-21T09:30:00Z |
| m-4 | c-b-chat | u-dave | k-4 | 에린, 자료 받았어요? | 2026-09-21T10:00:00Z |
| m-5 | c-team | u-bob | k-5 | `<b>굵게</b> 보이면 안 됩니다` | 2026-09-22T01:15:00Z |
| m-6 | c-b-chat | u-erin | k-6 | 네, 받았습니다. | 2026-09-22T03:00:00Z |
| m-7 | c-team | u-alice | k-7 | `확인했습니다.\n자료는 내일 공유할게요.` (a real newline, write `'...\n...'` in TS) | 2026-09-22T05:40:00Z |

Make `web/test/demo-data.test.ts` pass.

## T10 Test: demo api

Files: `web/test/demo-api.test.ts`

Imports: `createDemoApi` from `'../src/demo/demo-api.ts'`.
In the file: `const now = () => new Date('2026-09-23T06:00:00Z');` and
`async function loggedIn(username: string, serverId = 'mail-a') { const api = createDemoApi({ now }); const r = await api.login({ serverId, username, password: 'pw' }); assert.equal(r.ok, true); return api; }`

- `test('listServers returns both demo servers')`: ids `['mail-a', 'mail-b']` (no login needed).
- `test('login rejects unknown user, wrong server and empty password')`: each returns `{ ok: false, error: 'invalid_credentials' }`:
  `{ serverId: 'mail-a', username: 'nobody', password: 'x' }`, `{ serverId: 'mail-a', username: 'dave', password: 'x' }`, `{ serverId: 'mail-a', username: 'alice', password: '' }`.
- `test('login returns the matching user')`: `{ serverId: 'mail-a', username: 'alice', password: 'x' }` → `ok: true`, `value.id === 'u-alice'`, `value.displayName === '앨리스'`.
- `test('list methods require login')`: fresh api: `listUsers()`, `listConversations()`, `listMessages('c-team')` each reject with `/not_logged_in/`; `sendMessage('c-team', 'hi', 'k')` resolves to `{ ok: false, error: 'not_logged_in' }`.
- `test('listUsers returns only users of the same server')`: alice → ids `['u-alice', 'u-bob', 'u-carol']`; dave (serverId `'mail-b'`) → `['u-dave', 'u-erin']`.
- `test('listConversations returns member conversations newest first')`: alice → ids `['c-team', 'c-alice-bob']`; carol → `['c-team']`; dave (mail-b) → `['c-b-chat']`.
- `test('listMessages returns oldest first and hides other conversations')`: alice `listMessages('c-team')` → ids `['m-3', 'm-5', 'm-7']`; alice `listMessages('c-b-chat')` rejects `/not_found/`; alice `listMessages('nope')` rejects `/not_found/`.
- `test('sendMessage stores a trimmed message with backend time')`: alice `sendMessage('c-alice-bob', '  hello  ', 'k-new')` → ok; value deep-equals
  `{ id: 'm-8', conversationId: 'c-alice-bob', senderId: 'u-alice', clientMessageId: 'k-new', text: 'hello', createdAt: '2026-09-23T06:00:00.000Z' }`;
  then `listMessages('c-alice-bob')` ids `['m-1', 'm-2', 'm-8']`; `listConversations()` ids `['c-alice-bob', 'c-team']` and first `lastMessageAt === '2026-09-23T06:00:00.000Z'`.
- `test('sendMessage validates text')`: alice: `'   '` → `{ ok: false, error: 'empty' }`; `'x'.repeat(4001)` → `{ ok: false, error: 'too_long' }`.
- `test('sendMessage returns the existing message for a repeated clientMessageId')`: alice sends `'a'` with `'k-dup'` twice; both values have the same `id`; `listMessages('c-team')` has 4 messages.
- `test('sendMessage rejects conversations the user is not in')`: alice `sendMessage('c-b-chat', 'x', 'k')` → `{ ok: false, error: 'not_found' }`.
- `test('logout ends the session')`: alice logs out; `listConversations()` rejects `/not_logged_in/`.
- `test('each api instance has its own copy of the data')`: api1 = alice, sends `'only here'` to `c-team`; api2 = alice; api2 `listMessages('c-team')` has 3 messages.
- `test('returned objects are copies')`: alice `listConversations()`, set `list[0].title = 'changed'`; a second `listConversations()` still has title `'팀 채널'` first.

## T11 Impl: demo api

Files: `web/src/demo/demo-api.ts`

Export `createDemoApi(options: { now?: () => Date } = {}): MessengerApi`.

- Keep private state per call: `servers`, `users`, `conversations`, `messages` = `structuredClone` of the constants from `'./demo-data.ts'`; `currentUser: User | null = null`; `now = options.now ?? (() => new Date())`.
- Every returned object or array is a `structuredClone` (callers may mutate it).
- `listServers()`: all servers.
- `login(input)`: find a user with `serverId === input.serverId` and `username === input.username.trim()`. If none, or `input.password === ''`: set `currentUser = null`, return `{ ok: false, error: 'invalid_credentials' }`. Else set `currentUser`, return `{ ok: true, value: user }`.
- `logout()`: `currentUser = null`.
- Before login, `listUsers`, `listConversations`, `listMessages` throw `new Error('not_logged_in')` (async functions, so the promise rejects); `sendMessage` returns `{ ok: false, error: 'not_logged_in' }`.
- `listUsers()`: users with the current user's `serverId`, in data order.
- Visible conversation = `memberIds` includes current user id.
- `listConversations()`: visible conversations sorted by `lastMessageAt` descending; `null` last; ties by `id` ascending.
- `listMessages(id)`: not visible → throw `new Error('not_found')`; else its messages sorted by `createdAt` ascending.
- `sendMessage(conversationId, text, clientMessageId)`, in this order:
  1. not logged in → `not_logged_in`; 2. conversation not visible → `{ ok: false, error: 'not_found' }`;
  3. `validateMessageText(text)` from `'../lib/validate.ts'`; error → return it;
  4. an existing message with the same `senderId` and `clientMessageId` → return `{ ok: true, value: copy of it }`;
  5. create `{ id: 'm-' + (messages.length + 1), conversationId, senderId: currentUser.id, clientMessageId, text: validated value, createdAt: now().toISOString() }`, push it, set the conversation `lastMessageAt = createdAt`, return ok with a copy.

Make `web/test/demo-api.test.ts` pass.

## T12 Test: dom helper

Files: `web/test/dom.test.ts`

Imports: `el`, `clear` from `'../src/ui/dom.ts'`.

- `test('el creates an element with class, text and attributes')`: `const b = el(document, 'button', { className: 'x y', text: '<b>hi</b>', attrs: { type: 'button', 'data-id': 'c1' } })`;
  `b.tagName === 'BUTTON'`; `b.className === 'x y'`; `b.textContent === '<b>hi</b>'`; `b.querySelector('b') === null`; `b.getAttribute('type') === 'button'`; `b.getAttribute('data-id') === 'c1'`.
- `test('el appends children in order')`: `el(document, 'ul', {}, [el(document, 'li', { text: '1' }), el(document, 'li', { text: '2' })])`; `children.length === 2`; texts `'1'`, `'2'` in order.
- `test('el works without props')`: `el(document, 'div')` has `className === ''` and `childNodes.length === 0`.
- `test('clear removes every child')`: div with 3 children and a text node; after `clear(div)` → `childNodes.length === 0`.

## T13 Impl: dom helper

Files: `web/src/ui/dom.ts`

Export:
```ts
export interface ElProps {
  className?: string;
  text?: string;
  attrs?: Record<string, string>;
}
export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document, tag: K, props?: ElProps, children?: Node[],
): HTMLElementTagNameMap[K];
export function clear(node: Element): void;
```
`el`: `doc.createElement(tag)`; set `className` if given; set `textContent` if `text` given; `setAttribute` for each attr; `append` each child. `clear`: remove children until `firstChild` is null.
Make `web/test/dom.test.ts` pass.

## T14 Test: sidebar

Files: `web/test/sidebar.test.ts`

Imports: `renderSidebar` from `'../src/ui/sidebar.ts'`.
Fixture: three conversations `c1` title `'첫 대화'`, `c2` title `'<i>둘</i>'`, `c3` title `'셋'` (serverId `'s'`, memberIds `['a','b']`, lastMessageAt `null`).

- `test('renders one button per conversation inside a list')`: `renderSidebar(root, convs, null, () => {})`;
  `root.querySelectorAll('ul.conversation-list > li > button.conversation')` has 3; their `data-id` are `c1, c2, c3`; `textContent` equals titles; `root.querySelector('i') === null`; each button `type === 'button'`.
- `test('marks only the selected conversation')`: selected `'c2'`: button c2 has `aria-current === 'true'` and class `is-selected`; c1 and c3 have `getAttribute('aria-current') === null` and no `is-selected`.
- `test('clicking a conversation calls onSelect with its id')`: click button c3 → onSelect called once with `'c3'`.
- `test('rendering again replaces the previous list')`: render twice → still 3 buttons, 1 `ul`.
- `test('an empty list shows a message')`: `renderSidebar(root, [], null, () => {})` → `root.querySelector('p.empty').textContent === '대화가 없습니다'`; no `ul`.
- `test('arrow keys move focus between conversations')`: buttons `[b1, b2, b3]`; `b1.focus()`; `keydown(window, b1, { key: 'ArrowDown' })` → `document.activeElement === b2`; `keydown(window, b2, { key: 'ArrowUp' })` → `b1`; ArrowUp on b1 → stays `b1`; `b3.focus()`, ArrowDown on b3 → stays `b3`.

## T15 Impl: sidebar

Files: `web/src/ui/sidebar.ts`

Export `renderSidebar(root: HTMLElement, conversations: Conversation[], selectedId: string | null, onSelect: (id: string) => void): void`.
- `clear(root)` (from `'./dom.ts'`). Empty list → append `<p class="empty">대화가 없습니다</p>` and return.
- Else append `<ul class="conversation-list">`; per conversation `<li><button type="button" class="conversation" data-id="{id}">{title}</button></li>`.
- Selected button: `aria-current="true"` and class `conversation is-selected`. Others: no `aria-current` attribute.
- Click → `onSelect(id)`.
- `keydown` on a button: `ArrowDown` focuses the next button, `ArrowUp` the previous; no wrap; call `preventDefault()` when handled.
Use `el`/`clear` from `'./dom.ts'`. Make `web/test/sidebar.test.ts` pass.

## T16 Test: message list

Files: `web/test/message-list.test.ts`

Imports: `renderMessageList` from `'../src/ui/message-list.ts'`. `const TZ = 'Asia/Seoul';`
Fixture users: `u1` displayName `'앨리스'`, `u2` displayName `'밥'` (serverId `'s'`, usernames `'a'`, `'b'`).
Fixture messages (conversationId `'c'`):
`m1` sender `u1` text `'안녕'` at `'2026-09-22T01:00:00Z'`; `m2` sender `u2` text `'<b>굵게 아님</b>'` at `'2026-09-22T02:30:00Z'`;
`m3` sender `u9` (unknown) text `'줄1\n줄2'` at `'2026-09-22T15:10:00Z'`. clientMessageIds `k1..k3`.
Call `renderMessageList(root, msgs, users, 'u1', TZ)` unless stated.

- `test('renders one article per message in order')`: `root.querySelectorAll('article.message')` data-ids `m1, m2, m3`.
- `test('inserts a date separator whenever the local date changes')`: `Array.from(root.children).map(c => c.classList[0])` deep-equals `['date-separator', 'message', 'message', 'date-separator', 'message']`; separator texts `'2026-09-22'`, `'2026-09-23'`.
- `test('shows sender name and local HH:mm time')`: m1 `.sender` text `'앨리스'`; m1 `time` text `'10:00'` and attribute `datetime === '2026-09-22T01:00:00Z'`.
- `test('unknown sender falls back to the sender id')`: m3 `.sender` text `'u9'`.
- `test('marks my messages with is-mine')`: m1 has class `is-mine`; m2 does not.
- `test('message text is not parsed as HTML and keeps newlines')`: m2 `.text` textContent `'<b>굵게 아님</b>'` and `root.querySelector('b') === null`; m3 `.text` textContent `'줄1\n줄2'`.
- `test('an empty list shows a message')`: `renderMessageList(root, [], users, 'u1', TZ)` → `p.empty` text `'메시지가 없습니다'`.
- `test('rendering again replaces the previous content')`: render twice → 3 articles.

## T17 Impl: message list

Files: `web/src/ui/message-list.ts`

Export `renderMessageList(root: HTMLElement, messages: Message[], users: User[], meId: string, timeZone: string): void`.
- `clear(root)`. Empty → `<p class="empty">메시지가 없습니다</p>`.
- Keep the given order. Before a message whose `formatDateLabel(createdAt, timeZone)` differs from the previous message's (or for the first message) append `<div class="date-separator">{label}</div>`.
- Each message is a direct child of root:
  `<article class="message[ is-mine]" data-id="{id}"><header><span class="sender">{displayName or senderId}</span><time datetime="{createdAt}">{formatTime}</time></header><p class="text">{text}</p></article>`.
  `is-mine` when `senderId === meId`.
Use `'./dom.ts'` and `'../lib/format.ts'`. Make `web/test/message-list.test.ts` pass.

## T18 Test: composer

Files: `web/test/composer.test.ts`

Imports: `mountComposer` from `'../src/ui/composer.ts'`.
Setup function in the file: `function setup(onSend) { const dom = createDom(); mountComposer(dom.root, onSend); const form = dom.root.querySelector('form.composer'); return { ...dom, form, textarea: form.querySelector('textarea[name="text"]'), button: form.querySelector('button[type="submit"]'), error: form.querySelector('.composer-error') }; }`
Record calls with `const calls: string[] = []`.

- `test('renders textarea, send button and error area')`: textarea `getAttribute('maxlength') === '4000'`, `getAttribute('aria-label') === '메시지 입력'`; button text `'보내기'`; error exists and has `aria-live === 'polite'`.
- `test('clicking send sends trimmed text and clears the box')`: onSend pushes text, resolves `true`; `textarea.value = '  안녕  '`; `button.click()`; `await settle()`; calls `['안녕']`; `textarea.value === ''`.
- `test('Enter sends and Shift+Enter does not')`: value `'a'`; `keydown(window, textarea, { key: 'Enter', shiftKey: true })` → no call and event not defaultPrevented; `const ev = keydown(window, textarea, { key: 'Enter' })`; `await settle()` → calls `['a']`, `ev.defaultPrevented === true`.
- `test('Enter while composing Korean text does not send')`: value `'가'`; `keydown(..., { key: 'Enter', isComposing: true })`; `await settle()` → no calls.
- `test('empty text shows an error and does not send')`: value `'   '`; click; settle → no calls; error text `'메시지를 입력하세요'`.
- `test('too long text shows an error and does not send')`: value `'x'.repeat(4001)`; click; settle → no calls; error text `'4000자 이하로 입력하세요'`.
- `test('ignores new submits while a send is pending')`: onSend returns a promise resolved later (`let resolve; new Promise(r => { resolve = r; })`), pushes text; value `'a'`; click; click; Enter; `await settle()` → 1 call; `button.disabled === true`; `resolve(true)`; `await settle()` → `button.disabled === false`, `textarea.value === ''`.
- `test('a failed send keeps the text and shows an error')`: onSend resolves `false`; value `'a'`; click; settle → `textarea.value === 'a'`; error `'전송하지 못했습니다'`; `button.disabled === false`.
- `test('a rejected send behaves like a failed send')`: onSend returns `Promise.reject(new Error('x'))`; same checks as previous.
- `test('a successful send clears an earlier error')`: value `'   '`, click, settle (error shown); onSend resolves true; value `'b'`, click, settle → error text `''`.

## T19 Impl: composer

Files: `web/src/ui/composer.ts`

Export `mountComposer(root: HTMLElement, onSend: (text: string) => Promise<boolean>): void`.
- `clear(root)`, then append:
  `<form class="composer"><textarea name="text" rows="2" maxlength="4000" aria-label="메시지 입력" placeholder="메시지를 입력하세요"></textarea><button type="submit">보내기</button><p class="composer-error" aria-live="polite"></p></form>`.
- One `submit()` function used by the form `submit` event (call `event.preventDefault()`) and by Enter:
  1. pending → return. 2. `validateMessageText(textarea.value)`; `'empty'` → error `'메시지를 입력하세요'`; `'too_long'` → `'4000자 이하로 입력하세요'`; return.
  3. pending = true, `button.disabled = true`, error `''`. 4. `await onSend(value)` inside try/catch (throw counts as `false`).
  5. true → `textarea.value = ''`, error `''`; false → error `'전송하지 못했습니다'`. 6. pending = false, `button.disabled = false`.
- textarea `keydown`: `key === 'Enter' && !shiftKey && !isComposing` → `preventDefault()` then `submit()`. Anything else: do nothing.
Make `web/test/composer.test.ts` pass.

## T20 Test: login

Files: `web/test/login.test.ts`

Imports: `mountLogin` from `'../src/ui/login.ts'`.
Fixture servers: `[{ id: 'mail-a', name: 'A사 메일' }, { id: 'mail-b', name: 'B사 메일' }]`; user `{ id: 'u-alice', serverId: 'mail-a', username: 'alice', displayName: '앨리스' }`.
Setup: `mountLogin(root, servers, onSubmit, onSuccess, { demo: true })`; grab `form.login`, `select[name="serverId"]`, `input[name="username"]`, `input[name="password"]`, `button[type="submit"]`, `.login-error`.

- `test('renders server choice, username, password and submit')`: option values `['', 'mail-a', 'mail-b']`, option texts `['선택하세요', 'A사 메일', 'B사 메일']`; username `autocomplete === 'username'`; password `type === 'password'` and `autocomplete === 'current-password'`; button text `'로그인'`; error has `role === 'alert'`.
- `test('demo notice appears only in demo mode')`: demo true → `.demo-notice` text includes `'데모'`; a second dom with `{ demo: false }` → no `.demo-notice`.
- `test('validation errors are shown in order and nothing is submitted')`: click with all empty → error `'메일 서버를 선택하세요'`; `select.value = 'mail-a'`, click → `'아이디를 입력하세요'`; username `'alice'`, click → `'비밀번호를 입력하세요'`; `await settle()`; onSubmit never called.
- `test('valid input submits a trimmed username and calls onSuccess')`: onSubmit resolves `{ ok: true, value: user }`; select `'mail-a'`, username `' alice '`, password `'pw'`; click; settle → onSubmit called once with `{ serverId: 'mail-a', username: 'alice', password: 'pw' }`; onSuccess called once with the user.
- `test('invalid credentials show a message and clear the password')`: onSubmit resolves `{ ok: false, error: 'invalid_credentials' }`; valid input; click; settle → error `'아이디 또는 비밀번호가 올바르지 않습니다'`; password `''`; username `'alice'` kept; onSuccess not called.
- `test('other failures show a generic message')`: onSubmit resolves `{ ok: false, error: 'boom' }` → `'로그인하지 못했습니다'`; then with onSubmit returning `Promise.reject(new Error('x'))` (new dom) → same text.
- `test('the button is disabled while submitting')`: onSubmit returns a pending promise; valid input; click; settle → `button.disabled === true`; resolve with ok; settle → `button.disabled === false`.

## T21 Impl: login

Files: `web/src/ui/login.ts`

Export `mountLogin(root: HTMLElement, servers: MailServer[], onSubmit: (input: LoginInput) => Promise<Result<User>>, onSuccess: (user: User) => void, options: { demo: boolean }): void`.
- `clear(root)`, append `<form class="login">` containing in order:
  demo only: `<p class="demo-notice">데모 모드: 실제 메일 서버에 연결하지 않습니다</p>`;
  `<label>메일 서버 <select name="serverId">` with `<option value="">선택하세요</option>` then one option per server (value id, text name);
  `<label>아이디 <input name="username" autocomplete="username"></label>`;
  `<label>비밀번호 <input name="password" type="password" autocomplete="current-password"></label>`;
  `<button type="submit">로그인</button>`; `<p class="login-error" role="alert"></p>`.
- On `submit` (`preventDefault()`): ignore while pending. `validateLogin({ serverId, username, password })`; errors map
  `server_required` → `'메일 서버를 선택하세요'`, `username_required` → `'아이디를 입력하세요'`, `password_required` → `'비밀번호를 입력하세요'`.
  Valid → pending, `button.disabled = true`, error `''`; `await onSubmit(value)` in try/catch (throw → generic).
  ok → `onSuccess(user)`. `invalid_credentials` → `'아이디 또는 비밀번호가 올바르지 않습니다'` and password `''`. Other → `'로그인하지 못했습니다'`.
  Finally pending false, `button.disabled = false`.
Make `web/test/login.test.ts` pass.

## T22 Test: app login and layout

Files: `web/test/helpers/app.ts`, `web/test/app-login.test.ts`

`web/test/helpers/app.ts` exports:
- `async function startDemo()`: `const dom = createDom(); const api = createDemoApi({ now: () => new Date('2026-09-23T06:00:00Z') }); await startApp(dom.root, api, { timeZone: 'Asia/Seoul', demo: true }); return { ...dom, api };`
- `async function login(root: HTMLElement, username: string, serverId = 'mail-a')`: in `form.login` set `select[name="serverId"].value = serverId`, `input[name="username"].value = username`, `input[name="password"].value = 'pw'`; click `button[type="submit"]`; `await settle()`.
- `async function startAndLogin(username = 'alice', serverId = 'mail-a')`: `startDemo()` then `login(...)`; return the startDemo result.
- `function sidebarIds(root: HTMLElement): string[]`: `data-id` of `.sidebar button.conversation` in order.
- `function messageIds(root: HTMLElement): string[]`: `data-id` of `.messages article.message` in order.
Imports: `createDom`, `settle` from `'./dom.ts'`; `startApp` from `'../../src/app.ts'`; `createDemoApi` from `'../../src/demo/demo-api.ts'`.

`web/test/app-login.test.ts` (import from `'./helpers/app.ts'`):
- `test('shows the login form first')`: after `startDemo()`: `root.dataset.view === 'login'`; `form.login` exists; select option values include `'mail-a'` and `'mail-b'`; `.demo-notice` exists.
- `test('alice sees the main layout with her conversations')`: `startAndLogin('alice')` → `root.dataset.view === 'main'`; `.app` has `data-pane === 'list'`; `.sidebar .me` text `'앨리스'`; `sidebarIds(root)` deep-equals `['c-team', 'c-alice-bob']`; `.messages p.empty` text `'대화를 선택하세요'`; `form.composer` exists inside `.composer-slot`; `.chat-title` text `''`.
- `test('dave sees only mail-b conversations')`: `startAndLogin('dave', 'mail-b')` → `sidebarIds` `['c-b-chat']`.
- `test('unknown user stays on the login form with an error')`: `startDemo()`, `login(root, 'nobody')` → view `'login'`; `.login-error` text `'아이디 또는 비밀번호가 올바르지 않습니다'`; no `.app`.

## T23 Impl: app login and layout

Files: `web/src/app.ts`

Export `startApp(root: HTMLElement, api: MessengerApi, options: { timeZone: string; demo: boolean }): Promise<void>`.
- `showLogin()`: `root.dataset.view = 'login'`; `mountLogin(root, servers, (input) => api.login(input), (user) => { void showMain(user); }, { demo: options.demo })`.
  `startApp` loads `servers = await api.listServers()` once, calls `showLogin()`, then returns.
- `showMain(user)`: `root.dataset.view = 'main'`; `clear(root)`; build exactly:
  ```html
  <div class="app" data-pane="list">
    <aside class="sidebar">
      <header class="sidebar-header"><span class="me">{displayName}</span><button type="button" class="logout">로그아웃</button></header>
      <nav class="conversations" aria-label="대화 목록"></nav>
    </aside>
    <main class="chat">
      <header class="chat-header"><button type="button" class="back" aria-label="대화 목록으로">←</button><h1 class="chat-title"></h1></header>
      <section class="messages" aria-live="polite"><p class="empty">대화를 선택하세요</p></section>
      <div class="composer-slot"></div>
    </main>
  </div>
  ```
  Then `users = await api.listUsers()`, `conversations = await api.listConversations()`,
  `renderSidebar(nav, conversations, null, select)` and `mountComposer(slot, send)`.
- In this task `select(id)` and `send(text)` are stubs: `select` does nothing; `send` returns `Promise.resolve(false)`. T25 and T27 fill them in.
- Keep `user`, `users`, `conversations`, `selectedId: string | null` in variables inside `startApp` (closure). No globals.
Use `'./ui/dom.ts'`, `'./ui/login.ts'`, `'./ui/sidebar.ts'`, `'./ui/composer.ts'`. Make `web/test/app-login.test.ts` pass.

## T24 Test: app conversation selection

Files: `web/test/app-select.test.ts`

Import helpers from `'./helpers/app.ts'`; `DEMO_MESSAGES` from `'../src/demo/demo-data.ts'`.
Click a conversation with `root.querySelector('.sidebar button.conversation[data-id="c-team"]').click(); await settle();`.

- `test('selecting a conversation shows only its messages')`: alice selects `c-team` → `.app` `data-pane === 'chat'`; `.chat-title` text `'팀 채널'`; `messageIds(root)` deep-equals `['m-3', 'm-5', 'm-7']`.
- `test('the selected conversation is marked in the sidebar')`: after selecting `c-team`, its button has `aria-current === 'true'`; `c-alice-bob` button has none.
- `test('switching conversations replaces the messages')`: select `c-team` then `c-alice-bob` → `messageIds` `['m-1', 'm-2']`; title `'앨리스, 밥'`.
- `test('the back button returns to the list pane')`: select `c-team`, click `.back` → `data-pane === 'list'`.
- `test('my messages are marked')`: select `c-team` → article `m-7` has class `is-mine`, `m-3` does not.

## T25 Impl: app conversation selection

Files: `web/src/app.ts`

Replace the `select` stub: `selectedId = id`; `app.dataset.pane = 'chat'`; `.chat-title` text = the conversation title;
re-render the sidebar with `selectedId`; `const messages = await api.listMessages(id)`;
`renderMessageList(messagesSection, messages, users, user.id, options.timeZone)`.
Back button click → `app.dataset.pane = 'list'`.
Import `renderMessageList` from `'./ui/message-list.ts'`. Do not change behaviour covered by T22 tests.

## T26 Test: app sending and logout

Files: `web/test/app-send.test.ts`

Import helpers from `'./helpers/app.ts'`.

- `test('sending adds my message to the open conversation')`: alice selects `c-team`; `form.composer textarea` value `'앱 테스트'`; click the composer submit button; `await settle()` → last `.messages article.message` has `.text` text `'앱 테스트'` and class `is-mine`; textarea value `''`; `messageIds(root).length === 4`.
- `test('the conversation I wrote to moves to the top and stays selected')`: alice selects `c-alice-bob`, sends `'위로'` → `sidebarIds(root)` deep-equals `['c-alice-bob', 'c-team']`; button `c-alice-bob` has `aria-current === 'true'`.
- `test('sending without a selected conversation fails')`: alice, no selection; textarea `'x'`; submit; settle → `.composer-error` text `'전송하지 못했습니다'`; `messageIds(root).length === 0`.
- `test('logout returns to the login form')`: alice; click `.logout`; settle → `root.dataset.view === 'login'`; `form.login` exists; no `.app`.
- `test('after logout another user can log in')`: alice logs out, then `login(root, 'carol')` → `sidebarIds` `['c-team']`; `.me` text `'캐럴'`.

## T27 Impl: app sending and logout

Files: `web/src/app.ts`

- Replace the `send` stub: no `selectedId` → return `false`.
  `const r = await api.sendMessage(selectedId, text, crypto.randomUUID())`; not ok → `false`.
  Ok → reload `conversations = await api.listConversations()`, re-render the sidebar with `selectedId`,
  reload and re-render the messages of `selectedId`, return `true`.
- Logout button: `await api.logout()`; reset `selectedId = null`; `showLogin()`.
Do not change behaviour covered by T22 and T24 tests.

## T28 Test: styles

Files: `web/test/styles.test.ts`

Read the CSS: `import { readFileSync } from 'node:fs'; const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');` at the top level.
Helper in the file: `function block(start: string): string` returns the text from `css.indexOf(start)` through its matching closing `}` (count `{`/`}`); returns `''` if not found.

- `test('defines the color variables')`: `block(':root')` contains `--color-bg`, `--color-surface`, `--color-text`, `--color-muted`, `--color-accent`, `--color-mine`, `--color-border`.
- `test('styles every UI part')`: css contains each of `.app`, `.sidebar`, `.chat`, `.conversation`, `.conversation.is-selected`, `.message`, `.message.is-mine`, `.date-separator`, `.composer`, `.composer-error`, `.login`, `.login-error`, `.demo-notice`, `.empty`, `:focus-visible`.
- `test('message text keeps line breaks')`: css matches `/\.text\s*\{[^}]*white-space:\s*pre-wrap/`.
- `test('narrow screens show one pane at a time')`: `const m = block('@media (max-width: 640px)')`; `m` contains `[data-pane="list"] .chat` and `[data-pane="chat"] .sidebar` and `display: none`.
- `test('supports dark mode')`: `block('@media (prefers-color-scheme: dark)')` contains `--color-bg`.
- `test('never hides focus outlines')`: css does not match `/outline:\s*(none|0)\b/`.

## T29 Impl: styles

Files: `web/src/styles.css`

Write plain CSS (no preprocessors) that passes `web/test/styles.test.ts`, following this design:
- `:root` variables: `--color-bg: #f5f6f8; --color-surface: #ffffff; --color-text: #1d2026; --color-muted: #6b7280; --color-accent: #2563eb; --color-mine: #dbeafe; --color-border: #d9dce1;`
  and `font-family: system-ui, 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; font-size: 16px;`.
  Dark mode `@media (prefers-color-scheme: dark) { :root { --color-bg: #111318; --color-surface: #1b1e24; --color-text: #e6e8eb; --color-muted: #9aa1ab; --color-accent: #60a5fa; --color-mine: #1e3a5f; --color-border: #2c313a; } }`.
- `html, body { margin: 0; height: 100%; background: var(--color-bg); color: var(--color-text); }` and `#app { height: 100%; }`.
- `.app`: `display: grid; grid-template-columns: 280px 1fr; height: 100%;`. `.sidebar`: surface background, right border, column flex, `overflow-y: auto`.
  `.chat`: column flex, `min-width: 0`; `.messages`: `flex: 1; overflow-y: auto; padding: 16px;`.
- `.conversation-list`: no bullets, no margin/padding. `.conversation`: full-width button, left-aligned, `padding: 12px 16px`, transparent background, no border, inherits font and color, `cursor: pointer`.
  `.conversation.is-selected`: `background: var(--color-mine); font-weight: 600;`.
- `.message`: `max-width: 75%; margin: 8px 0; padding: 8px 12px; border-radius: 12px; background: var(--color-surface); border: 1px solid var(--color-border);`.
  `.message.is-mine`: `margin-left: auto; background: var(--color-mine);`. `.message header`: small muted text with gap. `.text { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }`.
- `.date-separator`: centered muted small text, `margin: 16px 0 8px`.
- `.composer`: grid `1fr auto` with gap 8px, `padding: 12px`, top border. textarea: `resize: none`, inherits font, `padding: 8px`, border radius 8px. `.composer-error` spans both columns, small, `color: #dc2626`, `margin: 0`, `min-height: 1em`.
- `.login`: centered card, `max-width: 360px; margin: 10vh auto; padding: 24px;` surface background, border, radius 12px, column flex gap 12px; labels column flex gap 4px; inputs/select `padding: 8px`, inherit font. `.login-error`: red, `min-height: 1em`. `.demo-notice`: muted small text, dashed border, `padding: 8px`.
- `.chat-header`: flex row, gap 8px, `padding: 12px 16px`, bottom border; `.chat-title { font-size: 1.1rem; margin: 0; }`; `.back { display: none; }`.
- `.empty`: muted, centered. `button:disabled { opacity: 0.6; cursor: default; }`.
- `:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }`. Never write `outline: none` or `outline: 0`.
- `@media (max-width: 640px)`: `.app { grid-template-columns: 1fr; }`, `.back { display: inline-block; }`,
  `[data-pane="list"] .chat { display: none; }`, `[data-pane="chat"] .sidebar { display: none; }`, `.message { max-width: 90%; }`.

Verify also builds the app (the build fails if CSS is broken only in rare cases; the test is the main check).

## T30 Wire the app entry point

Files: `web/src/main.ts`

Replace the file with exactly:
```ts
import './styles.css';
import { startApp } from './app.ts';
import { createDemoApi } from './demo/demo-api.ts';

const root = document.getElementById('app');
if (!root) {
  throw new Error('Missing #app element');
}
void startApp(root, createDemoApi(), { timeZone: 'Asia/Seoul', demo: true });
```

## T31 Web README and full check

Files: `web/README.md`

Write `web/README.md` in Korean with these sections, then the verify runs every test and the build:
1. `# j-messenger 웹` and one sentence: 데모 모드는 브라우저 메모리의 표본 데이터로 동작하고 서버에 연결하지 않는다.
2. `## 실행 (WSL)`: code block with `cd /mnt/d/workspace/test-space/github/j-messenger`, `npm --prefix web install`, `npm --prefix web run dev`; then the sentence: Windows 브라우저에서 `http://localhost:5173` 을 연다.
3. `## 데모 계정`: table of server / 아이디 (`A사 메일`: alice, bob, carol; `B사 메일`: dave, erin) and the sentence: 비밀번호는 비어 있지 않은 아무 값.
4. `## 확인 절차`: numbered list: alice로 로그인 → `팀 채널` 선택 → 메시지 3개와 날짜 구분선 2개 확인 → 메시지 전송 → 목록 맨 위로 이동 확인 → 브라우저 폭 360px에서 목록↔대화 전환(← 버튼) 확인 → 로그아웃.
5. `## 명령`: `npm --prefix web test` (전체 테스트), `npm --prefix web run build` (타입 검사 + 빌드, 결과는 web/dist).
