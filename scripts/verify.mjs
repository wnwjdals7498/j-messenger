#!/usr/bin/env node
// Planner-owned task verifier. Executors run `node scripts/verify.mjs <task id>` and never edit this file.
// Every task first passes the scope check: the working tree may differ from HEAD only in the task's
// `files:` and `.ctx/`. That forces the previous task to be committed and keeps tests read-only.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const id = process.argv[2];

// Checks per task. Types:
//   absent {path}                      file must not exist
//   contains / lacks {path, text}      file must (not) contain text
//   testFirst {file, min, missing}     >= min top-level tests; running fails only because `missing` is absent
//   registered {file, min, failing,    >= min tests register; failing: true = at least one must fail now;
//               failingName}           failingName = that exact test must be among the failing ones
//   npm {pkg, script, args}            `npm --prefix <pkg> run <script> -- <args>` exits 0
//   dist {pkg, containsAny, lacks}     built assets under <pkg>/dist/assets contain one of containsAny, not lacks
const T = {
  T32: [{ absent: 'web/test/composer-test-debug.ts' }],
  T33: [
    { registered: 'web/test/styles.test.ts', min: 6, failing: true, failingName: 'narrow screens show one pane at a time' },
    { contains: 'web/test/styles.test.ts', text: '[data-pane="list"] .chat' },
    { contains: 'web/test/styles.test.ts', text: '[data-pane="chat"] .sidebar' },
    { contains: 'web/test/styles.test.ts', text: 'white-space:\\s*pre-wrap/' },
  ],
  T34: [
    { lacks: 'web/src/styles.css', text: '\\"' },
    { npm: 'web', script: 'check', args: ['test/styles.test.ts'] },
    { npm: 'web', script: 'build' },
    { dist: 'web', containsAny: ['[data-pane=list] .chat', '[data-pane="list"] .chat'], lacks: `'"list"'` },
  ],
  T35: [
    { registered: 'web/test/composer.test.ts', min: 10, failing: true, failingName: 'too long text shows an error and does not send' },
    { lacks: 'web/test/composer.test.ts', text: 'removeAttribute' },
    { contains: 'web/test/composer.test.ts', text: 'shiftKey: true' },
    { contains: 'web/test/composer.test.ts', text: 'defaultPrevented, false' },
  ],
  T36: [
    { contains: 'web/src/ui/composer.ts', text: 'novalidate' },
    { npm: 'web', script: 'check', args: ['test/composer.test.ts'] },
  ],
  T37: [
    { registered: 'web/test/sidebar.test.ts', min: 6 },
    { registered: 'web/test/dom.test.ts', min: 4 },
    { contains: 'web/test/sidebar.test.ts', text: "deepEqual(selected, ['c3'])" },
    { npm: 'web', script: 'check', args: ['test/sidebar.test.ts', 'test/dom.test.ts'] },
  ],
  T38: [
    { contains: 'web/test/login.test.ts', text: 'submitted.length, 1' },
    { contains: 'web/test/login.test.ts', text: 'succeeded.length, 1' },
    { lacks: 'web/test/login.test.ts', text: '\\"' },
    { lacks: 'web/test/login.test.ts', text: 'strictEqual' },
    { npm: 'web', script: 'check', args: ['test/login.test.ts'] },
  ],
  T39: [
    { lacks: 'web/test/helpers/app.ts', text: '__get' },
    { lacks: 'web/test/helpers/app.ts', text: 'as any' },
    { lacks: 'web/test/helpers/app.ts', text: 'import(' },
    { contains: 'web/test/app-login.test.ts', text: '.composer-slot form.composer' },
    { contains: 'web/test/app-send.test.ts', text: "'.text'" },
    { contains: 'web/test/app-select.test.ts', text: 'after going back' },
    { registered: 'web/test/app-select.test.ts', min: 6, failing: true, failingName: 'sending still works after going back to the list' },
  ],
  T40: [
    { lacks: 'web/src/app.ts', text: '__get' },
    { lacks: 'web/src/app.ts', text: 'as any' },
    { lacks: 'web/src/app.ts', text: 'showMainPromises' },
    { lacks: 'web/src/app.ts', text: 'pendingSelect' },
    { npm: 'web', script: 'check', args: ['test/app-login.test.ts', 'test/app-select.test.ts', 'test/app-send.test.ts'] },
  ],
  T41: [
    { contains: 'web/README.md', text: '```powershell\ncd D:\\workspace\\test-space\\github\\j-messenger\nnpm --prefix web install\nnpm --prefix web run dev\n```' },
    { lacks: 'web/README.md', text: '\b' },
    { contains: 'web/README.md', text: '`npm --prefix web test`' },
    { contains: 'web/README.md', text: '비밀번호는 비어 있지 않은 아무 값.' },
    { npm: 'web', script: 'test' },
    { npm: 'web', script: 'build' },
  ],
};

// Server batch checks are generated from one table: [test task, impl task, test file, min tests, module].
const serverPairs = [
  ['T43', 'T44', 'test/config.test.ts', 9, 'src/config.ts'],
  ['T46', 'T47', 'test/db.test.ts', 5, 'src/db.ts'],
  ['T48', 'T49', 'test/http-util.test.ts', 11, 'src/http-util.ts'],
  ['T50', 'T51', 'test/router.test.ts', 6, 'src/router.ts'],
  ['T53', 'T54', 'test/dev-auth.test.ts', 4, 'src/auth/dev.ts'],
  ['T55', 'T56', 'test/users.test.ts', 5, 'src/users.ts'],
  ['T57', 'T58', 'test/sessions.test.ts', 6, 'src/sessions.ts'],
  ['T59', 'T60', 'test/conversations.test.ts', 9, 'src/conversations.ts'],
  ['T61', 'T62', 'test/messages.test.ts', 12, 'src/messages.ts'],
  ['T63', 'T64', 'test/events.test.ts', 4, 'src/events.ts'],
  ['T65', 'T66', 'test/app-core.test.ts', 11, 'src/app.ts'],
];
for (const [testId, implId, file, min, module] of serverPairs) {
  T[testId] = [{ testFirst: `server/${file}`, min, missing: `server/${module}` }];
  T[implId] = [{ npm: 'server', script: 'check', args: [file] }];
}
T.T42 = [
  { contains: 'server/package.json', text: '"ws": "8.21.3"' },
  { contains: 'server/package-lock.json', text: '"node_modules/ws"' },
  { npm: 'server', script: 'typecheck' },
];
T.T45 = [
  { contains: 'server/src/migrations.ts', text: 'UNIQUE (sender_id, client_message_id)' },
  { npm: 'server', script: 'typecheck' },
];
T.T52 = [
  { contains: 'server/src/auth/provider.ts', text: 'export interface AuthProvider' },
  { npm: 'server', script: 'typecheck' },
];
T.T67 = [{ registered: 'server/test/app-data.test.ts', min: 12, failing: true }];
T.T68 = [{ npm: 'server', script: 'check', args: ['test/app-core.test.ts', 'test/app-data.test.ts'] }];
T.T69 = [{ registered: 'server/test/app-events.test.ts', min: 5, failing: true }];
T.T70 = [{ npm: 'server', script: 'check', args: ['test/app-core.test.ts', 'test/app-data.test.ts', 'test/app-events.test.ts'] }];
T.T71 = [
  { absent: 'server/src/index.ts' },
  { registered: 'server/test/index.test.ts', min: 4, failing: true },
];
T.T72 = [{ npm: 'server', script: 'check', args: ['test/index.test.ts'] }];
T.T73 = [
  { contains: 'server/README.md', text: 'npm --prefix server start' },
  { contains: 'server/README.md', text: 'curl http://127.0.0.1:3000/health' },
  { lacks: 'server/README.md', text: '\b' },
  { npm: 'server', script: 'test' },
  { npm: 'server', script: 'typecheck' },
];

// ---------------------------------------------------------------------------

const results = [];
const pass = (msg) => results.push(`PASS ${msg}`);
const fail = (msg) => results.push(`FAIL ${msg}`);
const read = (p) => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');
const slash = (s) => s.replace(/\\/g, '/');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
  return { code: r.status ?? 1, out: slash(`${r.stdout ?? ''}${r.stderr ?? ''}`) };
}

function taskFiles(taskId) {
  const text = read('.ctx/TASKS.md');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^- \\[.\\] ${taskId} `).test(l));
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length && /^\s/.test(lines[i]); i++) {
    const m = lines[i].match(/^\s+files:\s*(.*)$/);
    if (m) return m[1].split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function scopeCheck(taskId) {
  const files = taskFiles(taskId);
  if (!files) return fail(`${taskId} is not in .ctx/TASKS.md`);
  const r = run('git', ['status', '--porcelain', '--untracked-files=all']);
  const outside = r.out.split('\n').filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop())
    .filter((p) => !p.startsWith('.ctx/') && !files.includes(p));
  if (outside.length === 0) return pass('scope: only files: and .ctx/ changed');
  fail(`scope: changed outside files: ${outside.join(', ')}. If these belong to the previous task, ` +
    'that task was not committed: commit it first. Otherwise restore them with git checkout/git clean.');
}

function countTests(file) {
  return read(file).split('\n').filter((l) => l.startsWith("test('")).length;
}

function check(c) {
  if (c.absent) return existsSync(join(root, c.absent)) ? fail(`${c.absent} must not exist`) : pass(`${c.absent} absent`);
  if (c.dist) {
    const dir = join(root, c.dist, 'dist', 'assets');
    const css = existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n') : '';
    if (!c.containsAny.some((s) => css.includes(s))) return fail(`built ${c.dist}/dist must contain one of ${c.containsAny.join(' | ')}`);
    if (c.lacks && css.includes(c.lacks)) return fail(`built ${c.dist}/dist must not contain ${c.lacks}`);
    return pass(`built ${c.dist}/dist selectors ok`);
  }
  if (c.contains || c.lacks) {
    const path = c.contains ?? c.lacks;
    if (!existsSync(join(root, path))) return fail(`${path} missing`);
    const has = read(path).includes(c.text);
    if (c.contains) return has ? pass(`${path} contains ${JSON.stringify(c.text)}`) : fail(`${path} must contain ${JSON.stringify(c.text)}`);
    return has ? fail(`${path} must not contain ${JSON.stringify(c.text)}`) : pass(`${path} lacks ${JSON.stringify(c.text)}`);
  }
  if (c.testFirst) {
    if (!existsSync(join(root, c.testFirst))) return fail(`${c.testFirst} missing`);
    const n = countTests(c.testFirst);
    if (n < c.min) return fail(`${c.testFirst} has ${n} lines starting with test(' , need >= ${c.min}`);
    if (existsSync(join(root, c.missing))) return fail(`${c.missing} must not exist yet (Test tasks never create it)`);
    const r = run('node', ['--test', c.testFirst]);
    const needle = `Cannot find module`;
    return r.out.includes(needle) && r.out.includes(c.missing)
      ? pass(`${c.testFirst}: ${n} tests, fails only because ${c.missing} is missing`)
      : fail(`${c.testFirst} must fail with "Cannot find module ... ${c.missing}". Output:\n${r.out.slice(0, 1500)}`);
  }
  if (c.registered) {
    if (!existsSync(join(root, c.registered))) return fail(`${c.registered} missing`);
    const r = run('node', ['--disable-warning=ExperimentalWarning', '--test', '--test-reporter=tap', c.registered]);
    const tests = Number((r.out.match(/^# tests (\d+)$/m) ?? [])[1] ?? 0);
    const failed = Number((r.out.match(/^# fail (\d+)$/m) ?? [])[1] ?? 0);
    if (tests < c.min) return fail(`${c.registered}: ${tests} tests registered, need >= ${c.min}. Output:\n${r.out.slice(0, 1500)}`);
    if (c.failing && failed === 0) return fail(`${c.registered}: expected at least one failing test before the Impl task, all passed`);
    if (c.failingName) {
      const failedNames = [...r.out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
      if (!failedNames.includes(c.failingName)) {
        return fail(`${c.registered}: test '${c.failingName}' must fail before the Impl task (it catches the bug being fixed). Failing now: ${failedNames.join(', ') || 'none'}`);
      }
    }
    return pass(`${c.registered}: ${tests} tests registered, ${failed} failing${c.failing ? ' (expected)' : ''}`);
  }
  if (c.npm) {
    const args = ['--prefix', c.npm, 'run', c.script];
    if (c.args?.length) args.push('--', ...c.args);
    const r = run('npm', args);
    return r.code === 0 ? pass(`npm ${args.join(' ')}`) : fail(`npm ${args.join(' ')} exited ${r.code}. Output tail:\n${r.out.slice(-2500)}`);
  }
  return fail(`unknown check ${JSON.stringify(c)}`);
}

if (!id || !T[id]) {
  console.log(`usage: node scripts/verify.mjs <task id>. Known: ${Object.keys(T).join(' ')}`);
  process.exit(2);
}
scopeCheck(id);
for (const c of T[id]) {
  if (results.some((r) => r.startsWith('FAIL'))) break;
  check(c);
}
console.log(results.join('\n'));
const ok = !results.some((r) => r.startsWith('FAIL'));
console.log(ok ? `VERIFY ${id} OK` : `VERIFY ${id} FAILED`);
process.exit(ok ? 0 : 1);
