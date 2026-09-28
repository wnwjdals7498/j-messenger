# Batch S: messenger server (T42-T73)

Executor: read ONLY the `## T<n>` section of your current task, the Common rules below and the files
the section names. Everything is decided. Do not ask questions. If something is impossible, set blocked.

## Common rules

- Work in `D:\workspace\test-space\github\j-messenger`. Code lives in `server/`.
- Write files only with your file edit/patch tool, never through PowerShell strings.
- Verify every task with `node scripts/verify.mjs T<n>`. It fails when anything outside the task's
  `files:` (except `.ctx/`) differs from the last commit, so commit every finished task.
- TypeScript strict, ES modules, 2-space indent, single quotes, semicolons. Local imports end in `.ts`;
  type-only imports use `import type`. No `enum`, `namespace`, constructor parameter properties,
  decorators or `any` (use `unknown` and narrow). Node built-ins are imported with the `node:` prefix.
- Allowed packages: only what `server/package.json` (T42) lists. Never `npm install <package>`.
- Time: functions that need the current time take `now: Date`. Store and return ISO strings
  (`date.toISOString()`). Never call `new Date()` inside `server/src/` except in `index.ts` and `app.ts`.
- Database: `DatabaseSync` from `node:sqlite`. Always use `?` placeholders, never build SQL from input.
  `prepare(sql).run(...)` returns `{ changes, lastInsertRowid }`; `.get(...)` returns one row or `undefined`;
  `.all(...)` returns an array. Rows use the SQL column names; map them to camelCase objects.
- IDs are INTEGER in SQLite and **strings** in every API object (`String(row.id)`).
- Errors meant for clients are `HttpError` from `server/src/http-util.ts` (T49). Codes and statuses:
  bad_request 400, unauthorized 401, forbidden 403, not_found 404, method_not_allowed 405,
  conflict 409, too_large 413, internal 500, unavailable 503.
- UI-facing strings are English in the server (the web app shows its own Korean text).

### Test file rules ("Test:" tasks)

- Start with `import { test } from 'node:test';` and `import assert from 'node:assert/strict';`.
- Every test is a top-level call at column 0 with the name in single quotes: `test('name', () => {...});`
  or `test('name', async () => {...});`. No `describe`, no nesting. Write exactly the listed tests.
- To check a thrown `HttpError`: `assert.throws(() => fn(), (e) => e instanceof HttpError && e.status === 400);`
  (async: `await assert.rejects(promise, (e) => ...)`).
- In-memory database for unit tests: `const db = openDb(':memory:');` (from `../src/db.ts`).
- The module under test may not exist yet. That is expected. Never create it in a Test task.

### Impl rules ("Impl:" tasks)

- Make the named test file pass without editing anything under `server/test/`.
- Export exactly the listed names and signatures. Private helpers are fine.

---

## T42 Scaffold the server package

Files: `server/package.json`, `server/tsconfig.json`, `server/src/version.ts`, `server/package-lock.json`

Create the three files with exactly this content, then run `npm --prefix server install --no-audit --no-fund`
(it creates `server/package-lock.json`; `server/node_modules/` is git-ignored).

`server/src/version.ts` (TypeScript needs at least one input file):
```ts
export const SERVER_VERSION = '0.1.0';
```

`server/package.json`:
```json
{
  "name": "j-messenger-server",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "engines": {
    "node": ">=22.18.0"
  },
  "scripts": {
    "start": "node --disable-warning=ExperimentalWarning src/index.ts",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "node --disable-warning=ExperimentalWarning --test --test-reporter=spec \"test/**/*.test.ts\"",
    "check": "tsc --noEmit -p tsconfig.json && node --disable-warning=ExperimentalWarning --test --test-reporter=spec"
  },
  "dependencies": {
    "ws": "8.21.3"
  },
  "devDependencies": {
    "@types/node": "22.20.4",
    "@types/ws": "8.18.1",
    "typescript": "5.9.3"
  }
}
```

`server/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "isolatedModules": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

## T43 Test: config

Files: `server/test/config.test.ts`

Import `loadConfig` from `'../src/config.ts'`. Each test calls `loadConfig({...})` with a plain object.

- `test('development defaults')`: `loadConfig({})` deep-equals
  `{ nodeEnv: 'development', host: '127.0.0.1', port: 3000, dbPath: 'data/j-messenger.sqlite', webDist: null, authMode: 'dev', mailServers: [{ id: 'mail-a', name: 'A사 메일', imapHost: '127.0.0.1', imapPort: 993 }, { id: 'mail-b', name: 'B사 메일', imapHost: '127.0.0.1', imapPort: 993 }], sessionDays: 7, secureCookies: false }`.
- `test('NODE_ENV must be development, production or test')`: `{ NODE_ENV: 'staging' }` throws `/^config: NODE_ENV/`; `{ NODE_ENV: 'test' }` gives `nodeEnv: 'test'`.
- `test('PORT must be an integer from 0 to 65535')`: `'abc'`, `'-1'`, `'65536'`, `'3.5'` each throw `/^config: PORT/`; `'0'` gives `port: 0`; `'8080'` gives `8080`.
- `test('HOST, DB_PATH and WEB_DIST are read')`: `{ HOST: '0.0.0.0', DB_PATH: '/tmp/x.sqlite', WEB_DIST: '/srv/web' }` gives those values; `{ WEB_DIST: '' }` gives `webDist: null`.
- `test('production requires DB_PATH')`: `{ NODE_ENV: 'production', MAIL_SERVERS: validJson }` throws `/^config: DB_PATH/`.
- `test('dev auth is refused in production')`: `{ NODE_ENV: 'production', DB_PATH: 'x', AUTH_MODE: 'dev' }` throws `/^config: AUTH_MODE=dev/`.
- `test('production defaults to imap and requires MAIL_SERVERS')`: `{ NODE_ENV: 'production', DB_PATH: 'x' }` throws `/^config: MAIL_SERVERS/`;
  `{ NODE_ENV: 'production', DB_PATH: 'x', MAIL_SERVERS: validJson }` gives `authMode: 'imap'`.
- `test('MAIL_SERVERS is parsed and validated')`: `validJson` gives `mailServers` deep-equal to the parsed array;
  each of these throws `/^config: MAIL_SERVERS/`: `'{}'`, `'[]'`, `'[{"id":"A!","name":"x","imapHost":"h","imapPort":993}]'`,
  `'[{"id":"a","name":"","imapHost":"h","imapPort":993}]'`, `'[{"id":"a","name":"x","imapHost":"h","imapPort":0}]'`,
  a duplicated id, and `'not json'`.
- `test('SESSION_DAYS and COOKIE_SECURE')`: `{ SESSION_DAYS: '30', COOKIE_SECURE: 'true' }` gives `sessionDays: 30, secureCookies: true`;
  `SESSION_DAYS` `'0'` and `'91'` throw `/^config: SESSION_DAYS/`; `COOKIE_SECURE: 'yes'` throws `/^config: COOKIE_SECURE/`.

In the file: `const validJson = JSON.stringify([{ id: 'corp', name: 'Corp Mail', imapHost: 'imap.corp.test', imapPort: 993 }]);`

## T44 Impl: config

Files: `server/src/config.ts`

```ts
export interface MailServerConfig { id: string; name: string; imapHost: string; imapPort: number; }
export interface Config {
  nodeEnv: 'development' | 'production' | 'test';
  host: string;
  port: number;
  dbPath: string;
  webDist: string | null;
  authMode: 'dev' | 'imap';
  mailServers: MailServerConfig[];
  sessionDays: number;
  secureCookies: boolean;
}
export function loadConfig(env: Record<string, string | undefined>): Config;
```
Rules, checked in this order (every error is `new Error('config: ' + detail)`, detail starts with the variable name):
- `NODE_ENV`: default `development`; must be `development`, `production` or `test`.
- `HOST`: default `127.0.0.1`. `PORT`: default `3000`; must match `/^\d+$/` and be 0..65535.
- `DB_PATH`: required when production; otherwise default `data/j-messenger.sqlite`.
- `WEB_DIST`: empty or missing → `null`.
- `AUTH_MODE`: `dev` or `imap`; default `imap` in production, `dev` otherwise. `dev` in production → `config: AUTH_MODE=dev is not allowed in production`.
- `MAIL_SERVERS`: JSON array, non-empty, each `{ id, name, imapHost, imapPort }` with id matching `/^[a-z0-9-]{1,32}$/`
  and unique, non-empty string name and imapHost, integer imapPort 1..65535. Only these four keys are kept.
  Missing: required when `authMode` is `imap`; otherwise the two defaults shown in T43.
- `SESSION_DAYS`: default 7; integer 1..90. `COOKIE_SECURE`: `true`/`false`, default `false`.

## T45 Database migrations (contract)

Files: `server/src/migrations.ts`

Create exactly:
```ts
// Database schema. Append new migrations; never edit an applied one.
export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (server_id, username)
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  last_message_at TEXT
);
CREATE TABLE members (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX members_user ON members(user_id);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  client_message_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (sender_id, client_message_id)
);
CREATE INDEX messages_conversation ON messages(conversation_id, id);
`,
  },
];
```

## T46 Test: db

Files: `server/test/db.test.ts`

Imports: `openDb`, `migrate` from `'../src/db.ts'`; `mkdtempSync`, `existsSync`, `rmSync` from `'node:fs'`; `tmpdir` from `'node:os'`; `join` from `'node:path'`.

- `test('openDb in memory applies every migration')`: table names from `SELECT name FROM sqlite_master WHERE type = 'table'` include
  `users, sessions, conversations, members, messages, schema_version`; `SELECT MAX(version) AS v FROM schema_version` gives `v === 1`.
- `test('foreign keys are enforced')`: `PRAGMA foreign_keys` gives `foreign_keys === 1`; inserting a session with `user_id = 999` throws.
- `test('migrate is idempotent')`: `migrate(db)` returns `1` twice; `SELECT COUNT(*) AS n FROM schema_version` gives `n === 1`.
- `test('file database uses WAL and creates the parent directory')`: `const dir = mkdtempSync(join(tmpdir(), 'jm-db-'))`;
  `const db = openDb(join(dir, 'nested', 'a.sqlite'))`; `PRAGMA journal_mode` gives `journal_mode === 'wal'`; the file exists;
  `db.close()`; `rmSync(dir, { recursive: true, force: true })`.
- `test('one sender cannot reuse a clientMessageId')`: insert a user, a conversation and a message with raw SQL, then the same
  `(sender_id, client_message_id)` again throws `/UNIQUE/`.

## T47 Impl: db

Files: `server/src/db.ts`

```ts
import { DatabaseSync } from 'node:sqlite';
export function openDb(path: string): DatabaseSync;
export function migrate(db: DatabaseSync): number;
```
- `openDb`: if `path !== ':memory:'`, create the parent directory (`mkdirSync(dirname(path), { recursive: true })`).
  Open, then `PRAGMA foreign_keys = ON`, `PRAGMA busy_timeout = 5000`, and for files `PRAGMA journal_mode = WAL`.
  Call `migrate(db)` and return the database.
- `migrate`: `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`. Current = `MAX(version)` or 0.
  For each migration in `MIGRATIONS` (from `'./migrations.ts'`) with a higher version, in order:
  `BEGIN`, `db.exec(sql)`, insert the version, `COMMIT` (on error `ROLLBACK` and rethrow). Return the final version.

## T48 Test: http-util

Files: `server/test/http-util.test.ts`

Imports from `'../src/http-util.ts'`: `HttpError`, `sendJson`, `sendError`, `readJson`, `parseCookies`,
`serializeSessionCookie`, `clearSessionCookie`. Also `Readable` from `'node:stream'`.
Helpers in the file:
```ts
function fakeRes() {
  const headers: Record<string, string> = {};
  return {
    statusCode: 0, headers, body: '',
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
    end(chunk?: string) { this.body = chunk ?? ''; },
  };
}
function fakeReq(text: string, contentType = 'application/json') {
  return Object.assign(Readable.from([Buffer.from(text)]), { headers: { 'content-type': contentType } });
}
```
Pass them to the functions with `as never`.

- `test('parseCookies reads name=value pairs')`: `'a=1; jm_session=xyz'` → `{ a: '1', jm_session: 'xyz' }`; `' b = 2 '` → `{ b: '2' }`.
- `test('parseCookies ignores empty and malformed input')`: `undefined` → `{}`; `''` → `{}`; `'novalue; c=3'` → `{ c: '3' }`.
- `test('serializeSessionCookie builds the session cookie')`: `serializeSessionCookie('tok', 604800, false)` ===
  `'jm_session=tok; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800'`; with `true` the same plus `'; Secure'`.
- `test('clearSessionCookie expires the cookie')`: `clearSessionCookie(false)` === `'jm_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'`.
- `test('sendJson writes status, headers and JSON')`: `sendJson(res, 201, { a: 1 })` → `statusCode 201`,
  `headers['content-type'] === 'application/json; charset=utf-8'`, `headers['cache-control'] === 'no-store'`, `body === '{"a":1}'`.
- `test('sendError uses HttpError status and code')`: `new HttpError(404, 'not_found', 'Conversation not found')` →
  404 and body `{"error":{"code":"not_found","message":"Conversation not found"}}`.
- `test('sendError hides other errors')`: `new Error('secret path /x')` → 500, body `{"error":{"code":"internal","message":"Internal server error"}}`.
- `test('HttpError keeps status, code and message')`: fields `status`, `code`, `message`, `name === 'HttpError'`, and `instanceof Error`.
- `test('readJson parses a JSON body')`: `fakeReq('{"a":[1,2]}', 'application/json; charset=utf-8')` → `{ a: [1, 2] }`.
- `test('readJson rejects other content types and bad JSON')`: `'text/plain'` rejects with an HttpError `status 400`, `code 'bad_request'`;
  body `'{bad'` rejects with status 400.
- `test('readJson enforces the size limit')`: a body of 20 bytes with `readJson(req, 10)` rejects with status 413 and code `'too_large'`.

## T49 Impl: http-util

Files: `server/src/http-util.ts`

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string); // set this.status, this.code, this.name = 'HttpError'
}
export function sendJson(res: ServerResponse, status: number, body: unknown): void;
export function sendError(res: ServerResponse, error: unknown): void;
export function readJson(req: IncomingMessage, limitBytes?: number): Promise<unknown>; // default 65536
export function parseCookies(header: string | undefined): Record<string, string>;
export function serializeSessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string;
export function clearSessionCookie(secure: boolean): string;
```
- `sendJson`: `res.statusCode = status`; `res.setHeader('content-type', 'application/json; charset=utf-8')`;
  `res.setHeader('cache-control', 'no-store')`; `res.end(JSON.stringify(body))`. `status === 204` → no content-type, `res.end()`.
- `sendError`: HttpError → `sendJson(res, e.status, { error: { code: e.code, message: e.message } })`; anything else →
  `console.error(error)` and 500 `internal` / `Internal server error`.
- `readJson`: content-type must start with `application/json` (else 400 `bad_request` "Expected application/json").
  Collect chunks with `for await`; over `limitBytes` → 413 `too_large` "Request body too large". Empty or invalid JSON → 400 `bad_request` "Invalid JSON".
- `parseCookies`: split on `;`, split each part at the first `=`, trim both sides, skip parts without `=` or with empty name;
  decode the value with `decodeURIComponent`, keeping the raw value if decoding throws.

## T50 Test: router

Files: `server/test/router.test.ts`

Import `createRouter` from `'../src/router.ts'`. Handlers are marker functions, e.g. `const h1 = () => {};`.

- `test('matches exact paths')`: add `GET /health` → `match('GET', '/health')` has `handler === h1` and `params` `{}`.
- `test('captures and decodes params')`: add `GET /api/conversations/:id/messages` → `match('GET', '/api/conversations/12/messages').params` is `{ id: '12' }`;
  add `GET /a/:name` → `match('GET', '/a/%ED%95%9C').params` is `{ name: '한' }`.
- `test('distinguishes methods on one path')`: `GET /x` → h1, `POST /x` → h2; each match returns its handler.
- `test('reports allowed methods for a known path')`: with GET and POST on `/x`, `match('DELETE', '/x')` deep-equals `{ allowed: ['GET', 'POST'] }`.
- `test('returns null for unknown paths and trailing slashes')`: `/nope` → `null`; `/health/` → `null`.
- `test('an empty segment never matches a param')`: `/api/conversations//messages` → `null`.

## T51 Impl: router

Files: `server/src/router.ts`

```ts
export type Params = Record<string, string>;
export type Handler<C> = (ctx: C, params: Params) => unknown;
export type Match<C> = { handler: Handler<C>; params: Params } | { allowed: string[] } | null;
export interface Router<C> {
  add(method: string, pattern: string, handler: Handler<C>): void;
  match(method: string, path: string): Match<C>;
}
export function createRouter<C>(): Router<C>;
```
Split pattern and path on `/`. Same number of segments required. Literal segments compare exactly; `:name`
segments match any non-empty segment and store `decodeURIComponent(segment)` (a decode error means no match).
If the path matches routes but none with this method → `{ allowed }` with those methods in the order added.

## T52 Auth provider contract

Files: `server/src/auth/provider.ts`

Create exactly:
```ts
// Contract for login back ends. dev.ts implements it now; an IMAP adapter follows in batch A.
export interface AuthUser {
  username: string;
  displayName: string;
}

export type AuthResult =
  | { ok: true; user: AuthUser }
  | { ok: false; reason: 'invalid' | 'unavailable' };

export interface AuthProvider {
  authenticate(serverId: string, username: string, password: string): Promise<AuthResult>;
}
```

## T53 Test: dev auth

Files: `server/test/dev-auth.test.ts`

Imports: `createDevAuthProvider`, `DEV_USERS`, `DEV_PASSWORD` from `'../src/auth/dev.ts'`.

- `test('accepts every dev user with the dev password')`: `DEV_PASSWORD === 'dev'`; `DEV_USERS.map(u => [u.serverId, u.username, u.displayName])` deep-equals
  `[['mail-a','alice','앨리스'], ['mail-a','bob','밥'], ['mail-a','carol','캐럴'], ['mail-b','dave','데이브'], ['mail-b','erin','에린']]`;
  for each, `authenticate(serverId, username, 'dev')` → `{ ok: true, user: { username, displayName } }`.
- `test('rejects a wrong password')`: `('mail-a', 'alice', 'x')` → `{ ok: false, reason: 'invalid' }`.
- `test('rejects users of another server')`: `('mail-a', 'dave', 'dev')` → invalid.
- `test('rejects unknown users and servers')`: `('mail-c', 'alice', 'dev')` and `('mail-a', 'zed', 'dev')` → invalid.

## T54 Impl: dev auth

Files: `server/src/auth/dev.ts`

Export `DEV_PASSWORD = 'dev'`, `DEV_USERS: readonly { serverId: string; username: string; displayName: string }[]`
(the five users of T53 in that order) and `createDevAuthProvider(): AuthProvider` (type from `'./provider.ts'`).
Match `serverId` and `username` exactly and the password exactly; anything else → `{ ok: false, reason: 'invalid' }`.

## T55 Test: users

Files: `server/test/users.test.ts`

Imports: `upsertUser`, `findUserById`, `findUsersByUsernames`, `listUsersOnServer` from `'../src/users.ts'`; `openDb`. `const now = new Date('2026-09-29T00:00:00Z');`

- `test('upsertUser inserts once and updates the display name')`: two calls for `('mail-a', 'alice', ...)` return the same `id`;
  the second display name `'Alice 2'` is returned and stored. Result shape `{ id: number, serverId, username, displayName }`.
- `test('users are unique per server, not globally')`: alice on mail-a and on mail-b get different ids.
- `test('findUserById returns the user or null')`: known id → the user; `999` → `null`.
- `test('listUsersOnServer returns only that server sorted by username')`: insert carol, alice, bob on mail-a and dave on mail-b →
  usernames `['alice', 'bob', 'carol']`.
- `test('findUsersByUsernames matches one server only')`: with alice(mail-a) and alice(mail-b), `findUsersByUsernames(db, 'mail-b', ['alice', 'nobody'])`
  returns one user whose serverId is `'mail-b'`.

## T56 Impl: users

Files: `server/src/users.ts`

```ts
import type { DatabaseSync } from 'node:sqlite';
export interface UserRow { id: number; serverId: string; username: string; displayName: string; }
export function upsertUser(db: DatabaseSync, serverId: string, username: string, displayName: string, now: Date): UserRow;
export function findUserById(db: DatabaseSync, id: number): UserRow | null;
export function findUsersByUsernames(db: DatabaseSync, serverId: string, usernames: string[]): UserRow[];
export function listUsersOnServer(db: DatabaseSync, serverId: string): UserRow[];
```
`upsertUser`: `INSERT INTO users (server_id, username, display_name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (server_id, username) DO UPDATE SET display_name = excluded.display_name`,
then select the row. `findUsersByUsernames`: one query per name is fine; order by username.

## T57 Test: sessions

Files: `server/test/sessions.test.ts`

Imports: `createSession`, `getSessionUser`, `deleteSession`, `hashToken` from `'../src/sessions.ts'`; `upsertUser`; `openDb`.
Setup per test: memory db, `alice = upsertUser(db, 'mail-a', 'alice', '앨리스', now)`, `now = new Date('2026-09-29T00:00:00Z')`.

- `test('createSession returns a base64url token and the expiry')`: token matches `/^[A-Za-z0-9_-]{43}$/`;
  `expiresAt === '2026-10-06T00:00:00.000Z'` for `days = 7`.
- `test('only the token hash is stored')`: the row's `token_hash === hashToken(token)`, which matches `/^[0-9a-f]{64}$/`;
  `SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?` with the raw token gives 0.
- `test('getSessionUser returns the user for a valid token')`: result `id === alice.id`, `username === 'alice'`.
- `test('expired sessions return null and are deleted')`: at `new Date('2026-10-06T00:00:00.001Z')` → `null`; session count 0.
- `test('deleteSession ends the session')`: after `deleteSession(db, token)`, `getSessionUser` → `null`.
- `test('unknown tokens return null')`: `getSessionUser(db, 'nope', now)` → `null`.

## T58 Impl: sessions

Files: `server/src/sessions.ts`

```ts
export function hashToken(token: string): string; // sha256 hex
export function createSession(db: DatabaseSync, userId: number, now: Date, days: number): { token: string; expiresAt: string };
export function getSessionUser(db: DatabaseSync, token: string, now: Date): UserRow | null;
export function deleteSession(db: DatabaseSync, token: string): void;
```
Token: `randomBytes(32).toString('base64url')`. Store `hashToken(token)`, `created_at`, `expires_at = now + days * 86400000 ms`.
`getSessionUser`: row with the hash; `expires_at <= now.toISOString()` → delete it and return null; else the user (via `findUserById`).

## T59 Test: conversations

Files: `server/test/conversations.test.ts`

Imports: `createConversation`, `listConversationsFor`, `getConversationFor` from `'../src/conversations.ts'`; `HttpError`; `upsertUser`; `openDb`.
Setup per test: memory db; `alice`, `bob`, `carol` on mail-a and `dave` on mail-b via `upsertUser`; `now = new Date('2026-09-29T00:00:00Z')`.

- `test('createConversation stores the creator and the members')`: `createConversation(db, alice, { title: '팀', memberUsernames: ['bob', 'carol'] }, now)` →
  `serverId 'mail-a'`, `title '팀'`, `lastMessageAt null`, `id` matching `/^\d+$/`,
  `memberIds` deep-equal to `[alice.id, bob.id, carol.id].map(String)` (ascending numeric order).
- `test('the title is trimmed and must be 1 to 100 characters')`: `'  x  '` → `'x'`; `''` and `'y'.repeat(101)` throw HttpError 400.
- `test('members must exist on the same server')`: `['dave']` and `['nobody']` throw HttpError 400 whose message includes the name.
- `test('the creator and duplicates are ignored in the member list')`: `['alice', 'bob', 'bob']` → 2 memberIds.
- `test('at least one other member is required')`: `[]` and `['alice']` throw HttpError 400.
- `test('at most 49 other members are allowed')`: 50 different names throw HttpError 400.
- `test('listConversationsFor returns only my conversations')`: alice creates A with bob; bob creates B with carol → alice sees `[A]`, bob sees both, carol sees `[B]`.
- `test('the list is newest first, then by id')`: three conversations of alice; set `last_message_at` with SQL to `'2026-09-29T01:00:00.000Z'` on the second, `NULL` on the others →
  order is second, first, third.
- `test('getConversationFor hides conversations of other users')`: carol → `null` for alice's conversation with bob; bob → the conversation.

## T60 Impl: conversations

Files: `server/src/conversations.ts`

```ts
export interface ConversationView { id: string; serverId: string; title: string; memberIds: string[]; lastMessageAt: string | null; }
export function createConversation(db: DatabaseSync, user: UserRow, input: { title: string; memberUsernames: string[] }, now: Date): ConversationView;
export function listConversationsFor(db: DatabaseSync, user: UserRow): ConversationView[];
export function getConversationFor(db: DatabaseSync, user: UserRow, conversationId: number): ConversationView | null;
```
- Title: trim; length 1..100 else `HttpError(400, 'bad_request', 'title must be 1-100 characters')`.
- Members: trim names, drop empty, drop the creator's username, drop duplicates. 0 → 400 "at least one member is required";
  more than 49 → 400 "at most 49 members". Look them up on the creator's server; the first missing →
  400 `unknown member: <name>`.
- Insert the conversation (`created_by`, `created_at`, `last_message_at NULL`) and all members (creator included) in one transaction (`BEGIN`/`COMMIT`, `ROLLBACK` on error).
- `memberIds`: member user ids ascending, as strings. List order: `last_message_at` descending with NULL last, then id ascending.
- `getConversationFor`: null unless the user is a member.

## T61 Test: messages

Files: `server/test/messages.test.ts`

Imports: `createMessageFor`, `listMessagesFor`, `MESSAGE_MAX_LENGTH` from `'../src/messages.ts'`; `createConversation`, `getConversationFor`; `HttpError`; `upsertUser`; `openDb`.
Setup per test: alice, bob, carol on mail-a; `c1` = alice+bob, `c3` = alice+carol (both created by alice); `now = new Date('2026-09-29T00:00:00Z')`; `cid = Number(c1.id)`.

- `test('createMessageFor stores a trimmed message')`: `createMessageFor(db, alice, cid, { clientMessageId: 'k1', text: '  hi  ' }, now)` →
  `created true`; message `{ id: /^\d+$/, conversationId: c1.id, senderId: String(alice.id), clientMessageId: 'k1', text: 'hi', createdAt: '2026-09-29T00:00:00.000Z' }`.
- `test('text must not be empty')`: `'   '` throws HttpError 400.
- `test('text is limited to 4000 characters')`: `MESSAGE_MAX_LENGTH === 4000`; 4000 x's ok; 4001 throws 400.
- `test('clientMessageId is 1 to 100 letters, digits, - or _')`: `''`, `'a b'`, 101 x's throw 400; `crypto.randomUUID()` is accepted.
- `test('repeating a clientMessageId returns the stored message')`: second call with `'k1'` and other text → `created false`, same message id and text `'hi'`; one row.
- `test('reusing a clientMessageId in another conversation is a conflict')`: `'k1'` in c1 then `'k1'` in c3 → HttpError 409.
- `test('non-members cannot send')`: carol in c1 → HttpError 404.
- `test('sending updates lastMessageAt')`: `getConversationFor(db, alice, cid).lastMessageAt === '2026-09-29T00:00:00.000Z'`.
- `test('listMessagesFor returns oldest first')`: three messages k1..k3 → texts in that order.
- `test('listMessagesFor pages with before and limit')`: five messages m1..m5 (ids i1..i5):
  `{ limit: 2 }` → `[m4, m5]`; `{ before: Number(i4), limit: 2 }` → `[m2, m3]`; `{}` returns all five.
- `test('limit must be 1 to 100')`: `{ limit: 0 }` and `{ limit: 101 }` throw 400.
- `test('non-members cannot list')`: carol → HttpError 404.

## T62 Impl: messages

Files: `server/src/messages.ts`

```ts
export const MESSAGE_MAX_LENGTH = 4000;
export interface MessageView { id: string; conversationId: string; senderId: string; clientMessageId: string; text: string; createdAt: string; }
export function createMessageFor(db: DatabaseSync, user: UserRow, conversationId: number, input: { clientMessageId: string; text: string }, now: Date): { message: MessageView; created: boolean };
export function listMessagesFor(db: DatabaseSync, user: UserRow, conversationId: number, options: { before?: number; limit?: number }): MessageView[];
```
- Membership first (via `getConversationFor`): not a member → `HttpError(404, 'not_found', 'Conversation not found')`.
- `clientMessageId` must match `/^[A-Za-z0-9_-]{1,100}$/` else 400. Text: trim; empty → 400 "text is empty"; longer than 4000 → 400 "text is too long".
- Existing row for `(sender_id, client_message_id)`: same conversation → `{ message, created: false }`; other conversation → `HttpError(409, 'conflict', 'clientMessageId already used')`.
- Insert and `UPDATE conversations SET last_message_at = ?` in one transaction.
- List: `limit` default 50, integer 1..100 else 400. Select `WHERE conversation_id = ? [AND id < before] ORDER BY id DESC LIMIT ?`, then reverse (oldest first).

## T63 Test: events

Files: `server/test/events.test.ts`

Import `createEventHub` from `'../src/events.ts'`. Sinks are `{ send(data: string) { received.push(data); } }`.

- `test('publish sends one JSON string to every sink of the listed users')`: users 1 (two sinks) and 2 (one sink); `publish([1, 2], { type: 'x', n: 1 })` → every sink got `['{"type":"x","n":1}']`.
- `test('users not listed receive nothing')`: sink of user 3 got `[]` after `publish([1], ...)`.
- `test('unsubscribe stops delivery and updates count')`: `count()` is 2 after two subscribes; call the first unsubscribe → `count()` 1 and that sink receives nothing more.
- `test('a failing sink does not stop the others')`: a sink whose `send` throws, subscribed before a normal sink of the same user → the normal sink still receives the event.

## T64 Impl: events

Files: `server/src/events.ts`

```ts
export interface EventSink { send(data: string): void; }
export interface EventHub {
  subscribe(userId: number, sink: EventSink): () => void;
  publish(userIds: number[], event: unknown): void;
  count(): number;
}
export function createEventHub(): EventHub;
```
Keep a `Map<number, Set<EventSink>>`. `publish` stringifies once and calls every sink inside `try/catch` (ignore errors).
`count()` = total sinks.

## T65 Test: app core

Files: `server/test/helpers/server.ts`, `server/test/app-core.test.ts`

`server/test/helpers/server.ts` exports:
```ts
// startTestServer(): in-memory db, dev auth, app on 127.0.0.1 port 0.
export async function startTestServer(): Promise<{ base: string; db: DatabaseSync; close: () => Promise<void> }>;
// request(): JSON in, JSON out. 204 and empty bodies give body null.
export async function request(base: string, method: string, path: string,
  options?: { cookie?: string; body?: unknown; rawBody?: string; contentType?: string }): Promise<{ status: number; body: any; headers: Headers }>;
// loginAs(): POST /api/session with password 'dev', returns the 'jm_session=...' pair from set-cookie.
export async function loginAs(base: string, username: string, serverId?: string): Promise<string>;
```
`startTestServer` uses `loadConfig({ NODE_ENV: 'test', DB_PATH: ':memory:' })`, `openDb(':memory:')`,
`createDevAuthProvider()`, `createApp(config, { db, auth })`, then `app.server.listen(0, '127.0.0.1')`;
`base = 'http://127.0.0.1:' + port`; `close` calls `app.close()` then `db.close()`.
`request` sends `body` as JSON with `content-type: application/json`, or `rawBody` with `contentType`, plus `cookie` when given.
(Helper files are not type-checked, so `body: any` is allowed here only.)

`server/test/app-core.test.ts` — every test starts its own server and closes it at the end (`try/finally`):
- `test('GET /health returns ok')`: 200, body `{ status: 'ok' }`.
- `test('GET /api/servers lists the mail servers without IMAP details')`: 200, body `{ servers: [{ id: 'mail-a', name: 'A사 메일' }, { id: 'mail-b', name: 'B사 메일' }] }`.
- `test('unknown paths return 404 JSON')`: `GET /nope` → 404, `body.error.code === 'not_found'`.
- `test('a wrong method returns 405')`: `DELETE /health` → 405, `body.error.code === 'method_not_allowed'`.
- `test('login with dev credentials sets the session cookie')`: `POST /api/session` `{ serverId: 'mail-a', username: 'alice', password: 'dev' }` → 200,
  `body.user` has `id` matching `/^\d+$/`, `serverId 'mail-a'`, `username 'alice'`, `displayName '앨리스'`; `set-cookie` starts with `jm_session=` and contains
  `HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age=604800` and not `Secure`.
- `test('bad credentials give the same 401 for every reason')`: wrong password and unknown user both → 401 with body
  `{ error: { code: 'unauthorized', message: 'Invalid credentials' } }` (deep-equal).
- `test('an unknown serverId is a bad request')`: `'mail-z'` → 400 `bad_request`.
- `test('login needs a JSON body with three non-empty strings')`: `rawBody 'x'` with `text/plain` → 400; `{ serverId: 'mail-a', username: 'alice' }` → 400; password `''` → 400.
- `test('GET /api/me needs a session')`: no cookie → 401 `unauthorized`; with `loginAs` cookie → 200 `body.user.username === 'alice'`.
- `test('logout ends the session and clears the cookie')`: `POST /api/logout` with cookie → 204; `set-cookie` contains `Max-Age=0`; then `/api/me` with the old cookie → 401.
- `test('logout without a session is still 204')`: `POST /api/logout` without cookie → 204.

## T66 Impl: app core

Files: `server/src/app.ts`

```ts
export interface App { server: Server; hub: EventHub; close(): Promise<void>; }
export function createApp(config: Config, deps: { db: DatabaseSync; auth: AuthProvider; now?: () => Date }): App;
```
- `now = deps.now ?? (() => new Date())`. When `config.authMode === 'dev'`, upsert every `DEV_USERS` entry at startup (so conversations can include users who never logged in).
- `http.createServer`; per request build `ctx = { req, res, url: new URL(req.url, 'http://local'), user: UserRow | null }`, look up the route with the router (T51):
  `null` → 404 `not_found` "Not found"; `{ allowed }` → set header `allow` and 405 `method_not_allowed`. Wrap every handler in `try/catch` → `sendError`.
- Session: read cookie `jm_session` with `parseCookies`; `getSessionUser(db, token, now())`. Routes marked "session" answer 401 `unauthorized` "Login required" without a user.
- Routes in this task:
  - `GET /health` → 200 `{ status: 'ok' }`.
  - `GET /api/servers` → 200 `{ servers: config.mailServers.map(({ id, name }) => ({ id, name })) }`.
  - `POST /api/session` → `readJson`; `serverId`, `username`, `password` must be non-empty strings (400 `bad_request`); serverId must be in `config.mailServers` (400).
    `auth.authenticate(...)`: `invalid` → 401 `unauthorized` "Invalid credentials"; `unavailable` → 503 `unavailable` "Mail server unavailable".
    Ok → `upsertUser`, `createSession(db, user.id, now(), config.sessionDays)`, header `set-cookie: serializeSessionCookie(token, days * 86400, config.secureCookies)`,
    200 `{ user: { id: String(id), serverId, username, displayName } }`.
  - `GET /api/me` (session) → 200 `{ user }` (same shape).
  - `POST /api/logout` → delete the session if the cookie has one, `set-cookie: clearSessionCookie(config.secureCookies)`, 204.
- `hub = createEventHub()`. `close()` closes the server (and, from T70, every WebSocket) and resolves when done.
- Put the user-to-JSON mapping in one private function `userJson(user)`.

## T67 Test: app data routes

Files: `server/test/app-data.test.ts`

Uses the helpers. Each test: `startTestServer()`, `loginAs` as needed, `try/finally close()`.
- `test('GET /api/users lists users of my server')`: alice → 200, `body.users.map(u => u.username)` is `['alice', 'bob', 'carol']`; each has `id`, `serverId`, `username`, `displayName`.
- `test('data routes need a session')`: without cookie these are 401: `GET /api/users`, `GET /api/conversations`, `POST /api/conversations`, `GET /api/conversations/1/messages`, `POST /api/conversations/1/messages`.
- `test('POST /api/conversations creates a conversation')`: alice `{ title: '팀', memberUsernames: ['bob'] }` → 201, `body.conversation.title '팀'`, `memberIds.length 2`.
- `test('a member from another server is rejected')`: `['dave']` → 400.
- `test('GET /api/conversations lists only mine')`: after alice creates one with bob: bob sees 1, carol sees 0 (`body.conversations`).
- `test('POST messages creates a message')`: alice posts `{ clientMessageId: 'k1', text: '  안녕  ' }` to `/api/conversations/<id>/messages` → 201, `body.message.text '안녕'`, `senderId` = alice's id.
- `test('repeating a clientMessageId returns 200 and the same message')`: same post twice → second 200, same `body.message.id`.
- `test('non-members get 404 for messages')`: carol GET and POST on alice+bob's conversation → 404.
- `test('GET messages pages with before and limit')`: five posts; `?limit=2` → last two in order; `?before=<id of 4th>&limit=2` → 2nd and 3rd.
- `test('an invalid limit is a bad request')`: `?limit=0` and `?limit=abc` → 400.
- `test('a non-numeric conversation id is not found')`: `GET /api/conversations/abc/messages` → 404.
- `test('sending moves the conversation to the top')`: alice creates A then B; posts to A → `GET /api/conversations` first id is A's.

## T68 Impl: app data routes

Files: `server/src/app.ts`

Add these session routes (all JSON bodies via `readJson`):
- `GET /api/users` → 200 `{ users: listUsersOnServer(db, user.serverId).map(userJson) }`.
- `GET /api/conversations` → 200 `{ conversations: listConversationsFor(db, user) }`.
- `POST /api/conversations` → body `{ title: string, memberUsernames: string[] }` (wrong types → 400) → 201 `{ conversation }`.
- `GET /api/conversations/:id/messages` → `id` must match `/^[1-9]\d*$/` else 404 `not_found`; query `before` (same pattern, else 400) and `limit`
  (`/^\d+$/` else 400) → 200 `{ messages }`.
- `POST /api/conversations/:id/messages` → body `{ clientMessageId: string, text: string }` → created 201 / existing 200, body `{ message }`.
  When `created`, publish `{ type: 'message', message }` to every member id of the conversation (`hub.publish(memberIds.map(Number), ...)`).

## T69 Test: app events (WebSocket)

Files: `server/test/app-events.test.ts`

Uses the helpers and Node's global `WebSocket`. Connect with the cookie header:
`new WebSocket(base.replace('http', 'ws') + '/events', { headers: { cookie } } as never)`.
Helper in the file: `function nextMessage(ws, ms = 2000): Promise<string | null>` resolves with the next `message` event data or `null` after `ms`.
Wait for `open` before posting. Close sockets in `finally`.

- `test('/events refuses connections without a session')`: without cookie the socket never opens: an `error` or `close` event happens and `open` does not (wait up to 2 s).
- `test('members receive new messages')`: bob connects; alice creates a conversation with bob and posts `'이벤트'` → bob's next message parses to `{ type: 'message', message: {...} }` with `message.text '이벤트'`.
- `test('non-members receive nothing')`: carol connects; alice posts in alice+bob → `nextMessage(carolWs, 500)` is `null`.
- `test('a repeated clientMessageId is published once')`: bob connects; alice posts the same body twice → first `nextMessage` is an event, the next `nextMessage(ws, 500)` is `null`.
- `test('the event arrives after the message is stored')`: when bob gets the event, `GET` messages as bob contains that message id.

## T70 Impl: app events

Files: `server/src/app.ts`

- `const wss = new WebSocketServer({ noServer: true })` from `'ws'`. On `server.on('upgrade', (req, socket, head) => ...)`:
  path other than `/events` → write `'HTTP/1.1 404 Not Found\r\n\r\n'` and `socket.destroy()`.
  No valid session → `'HTTP/1.1 401 Unauthorized\r\n\r\n'` and destroy.
  Else `wss.handleUpgrade(req, socket, head, (ws) => { const off = hub.subscribe(user.id, { send: (d) => ws.send(d) }); ws.on('close', off); })`.
- `close()` also closes every client (`for (const c of wss.clients) c.terminate()`) and `wss.close()`.

## T71 Test: server entry point

Files: `server/test/index.test.ts`

Start the real entry with `spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: <server dir>, env: { ...process.env, ...extra } })`
where `<server dir>` is `fileURLToPath(new URL('..', import.meta.url))`. Helper `waitForPort(child)` resolves with the port from the stdout line
`listening on http://127.0.0.1:<port>`; it rejects after 10 s or as soon as the child exits before printing it.
Helper `waitForExit(child)` resolves with `{ code, stderr }`. Kill children in `finally` (`child.kill()`).
`src/index.ts` does not exist yet, so every test fails now; that is expected.
Use a temp DB path: `join(mkdtempSync(join(tmpdir(), 'jm-idx-')), 'db.sqlite')`.

- `test('starts on the given port and answers /health')`: env `{ NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0', DB_PATH: tmpDb }` → `GET /health` 200.
- `test('exits with code 1 on a bad config')`: `PORT: 'abc'` → exit code 1 and stderr contains `config: PORT`.
- `test('refuses imap auth until batch A')`: `{ NODE_ENV: 'production', DB_PATH: tmpDb, MAIL_SERVERS: JSON.stringify([{ id: 'corp', name: 'Corp', imapHost: 'imap.corp.test', imapPort: 993 }]) }` →
  exit code 1 and stderr contains `imap auth is not implemented yet`.
- `test('messages survive a restart')`: start, login alice, create a conversation with bob, post `'재시작'`, kill, wait for exit;
  start again with the same `DB_PATH`, login alice again, `GET` messages of that conversation → contains `'재시작'`.

## T72 Impl: server entry point

Files: `server/src/index.ts`

1. `loadConfig(process.env)` inside try/catch: on error print `error.message` to stderr and `process.exit(1)`.
2. `authMode === 'imap'` → stderr `imap auth is not implemented yet (batch A)`, `process.exit(1)`.
3. `const db = openDb(config.dbPath)`; `const app = createApp(config, { db, auth: createDevAuthProvider() })`.
4. `app.server.listen(config.port, config.host, ...)` then print exactly `listening on http://${config.host}:${actualPort}` (actual port from `server.address()`).
5. On `SIGINT` and `SIGTERM`: `await app.close()`, `db.close()`, `process.exit(0)`.

## T73 Server README and full check

Files: `server/README.md`

Write `server/README.md` in Korean with your file edit tool:
1. `# j-messenger 서버` and one sentence: Node 22+ 단일 프로세스, SQLite(`node:sqlite`), HTTP API와 WebSocket `/events`.
2. `## 실행 (개발)`: a ```` ```powershell ```` block with `cd D:\workspace\test-space\github\j-messenger`, `npm --prefix server install`, `npm --prefix server start`;
   then the sentence: 확인: `curl http://127.0.0.1:3000/health` → `{"status":"ok"}`.
3. `## 개발 계정`: servers mail-a (alice, bob, carol) and mail-b (dave, erin), 비밀번호 `dev`. 개발 모드(`NODE_ENV`가 production이 아닐 때)에서만 동작.
4. `## 환경 변수`: a table of `NODE_ENV, HOST, PORT, DB_PATH, WEB_DIST, AUTH_MODE, MAIL_SERVERS, SESSION_DAYS, COOKIE_SECURE` with default and meaning (from T44).
5. `## API`: a table of every route from T66, T68 and `/events` (T70) with method, path, session needed, response body.
6. `## 명령`: `npm --prefix server test` (전체 테스트), `npm --prefix server run typecheck`.
