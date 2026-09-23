# TASKS
plan: Batch W demo web UI. Spec: docs/tasks/web.md. Read only your task section and Common rules.

- [ ] T1 Scaffold the web project
  files: web/package.json, web/tsconfig.json, web/vite.config.ts, web/index.html, web/src/main.ts, web/package-lock.json
  do: Do section "## T1" of docs/tasks/web.md exactly (copy the file contents, then npm install).
  verify: npm --prefix web install --no-audit --no-fund && npm --prefix web run build && test -f web/package-lock.json && test -f web/dist/index.html
- [ ] T2 Shared types
  files: web/src/types.ts
  do: Do section "## T2" of docs/tasks/web.md exactly (copy the file content).
  verify: npm --prefix web run typecheck && grep -q 'export interface MessengerApi' web/src/types.ts && grep -q 'MESSAGE_MAX_LENGTH = 4000' web/src/types.ts
- [ ] T3 DOM test helper and smoke test
  files: web/test/helpers/dom.ts, web/test/smoke.test.ts
  do: Do section "## T3" of docs/tasks/web.md.
  verify: npm --prefix web run check -- test/smoke.test.ts
- [ ] T4 Test: format
  files: web/test/format.test.ts
  do: Do section "## T4" of docs/tasks/web.md. Do not create web/src/lib/format.ts.
  verify: [ "$(grep -c "^test('" web/test/format.test.ts)" -ge 6 ] && node --test web/test/format.test.ts 2>&1 | grep -q 'Cannot find module .*web/src/lib/format.ts'
- [ ] T5 Impl: format
  files: web/src/lib/format.ts
  do: Do section "## T5" of docs/tasks/web.md.
  verify: npm --prefix web run check -- test/format.test.ts
- [ ] T6 Test: validate
  files: web/test/validate.test.ts
  do: Do section "## T6" of docs/tasks/web.md. Do not create web/src/lib/validate.ts.
  verify: [ "$(grep -c "^test('" web/test/validate.test.ts)" -ge 6 ] && node --test web/test/validate.test.ts 2>&1 | grep -q 'Cannot find module .*web/src/lib/validate.ts'
- [ ] T7 Impl: validate
  files: web/src/lib/validate.ts
  do: Do section "## T7" of docs/tasks/web.md.
  verify: npm --prefix web run check -- test/validate.test.ts
- [ ] T8 Test: demo data
  files: web/test/demo-data.test.ts
  do: Do section "## T8" of docs/tasks/web.md. Do not create web/src/demo/demo-data.ts.
  verify: [ "$(grep -c "^test('" web/test/demo-data.test.ts)" -ge 9 ] && node --test web/test/demo-data.test.ts 2>&1 | grep -q 'Cannot find module .*web/src/demo/demo-data.ts'
- [ ] T9 Impl: demo data
  files: web/src/demo/demo-data.ts
  do: Do section "## T9" of docs/tasks/web.md.
  verify: npm --prefix web run check -- test/demo-data.test.ts
- [ ] T10 Test: demo api
  files: web/test/demo-api.test.ts
  do: Do section "## T10" of docs/tasks/web.md. Do not create web/src/demo/demo-api.ts.
  verify: [ "$(grep -c "^test('" web/test/demo-api.test.ts)" -ge 14 ] && node --test web/test/demo-api.test.ts 2>&1 | grep -q 'Cannot find module .*web/src/demo/demo-api.ts'
- [ ] T11 Impl: demo api
  files: web/src/demo/demo-api.ts
  do: Do section "## T11" of docs/tasks/web.md.
  verify: npm --prefix web run check -- test/demo-data.test.ts test/demo-api.test.ts
- [ ] T12 Test: dom helper
  files: web/test/dom.test.ts
  do: Do section "## T12" of docs/tasks/web.md. Do not create web/src/ui/dom.ts.
  verify: [ "$(grep -c "^test('" web/test/dom.test.ts)" -ge 4 ] && node --test web/test/dom.test.ts 2>&1 | grep -q 'Cannot find module .*web/src/ui/dom.ts'
- [ ] T13 Impl: dom helper
  files: web/src/ui/dom.ts
  do: Do section "## T13" of docs/tasks/web.md.
  verify: npm --prefix web run check -- test/dom.test.ts
- [ ] T14 Test: sidebar
  files: web/test/sidebar.test.ts
  do: Do section "## T14" of docs/tasks/web.md. Do not create web/src/ui/sidebar.ts.
  verify: [ "$(grep -c "^test('" web/test/sidebar.test.ts)" -ge 6 ] && node --test web/test/sidebar.test.ts 2>&1 | grep -q 'Cannot find module .*web/src/ui/sidebar.ts'
- [ ] T15 Impl: sidebar
  files: web/src/ui/sidebar.ts
  do: Do section "## T15" of docs/tasks/web.md.
  verify: npm --prefix web run check -- test/sidebar.test.ts
- [ ] T16 Test: message list
  files: web/test/message-list.test.ts
  do: Do section "## T16" of docs/tasks/web.md. Do not create web/src/ui/message-list.ts.
  verify: [ "$(grep -c "^test('" web/test/message-list.test.ts)" -ge 8 ] && node --test web/test/message-list.test.ts 2>&1 | grep -q 'Cannot find module .*web/src/ui/message-list.ts'
- [ ] T17 Impl: message list
  files: web/src/ui/message-list.ts
  do: Do section "## T17" of docs/tasks/web.md.
  verify: npm --prefix web run check -- test/message-list.test.ts
- [ ] T18 Test: composer
  files: web/test/composer.test.ts
  do: Do section "## T18" of docs/tasks/web.md. Do not create web/src/ui/composer.ts.
  verify: [ "$(grep -c "^test('" web/test/composer.test.ts)" -ge 10 ] && node --test web/test/composer.test.ts 2>&1 | grep -q 'Cannot find module .*web/src/ui/composer.ts'
- [ ] T19 Impl: composer
  files: web/src/ui/composer.ts
  do: Do section "## T19" of docs/tasks/web.md.
  verify: npm --prefix web run check -- test/composer.test.ts
- [ ] T20 Test: login
  files: web/test/login.test.ts
  do: Do section "## T20" of docs/tasks/web.md. Do not create web/src/ui/login.ts.
  verify: [ "$(grep -c "^test('" web/test/login.test.ts)" -ge 7 ] && node --test web/test/login.test.ts 2>&1 | grep -q 'Cannot find module .*web/src/ui/login.ts'
- [ ] T21 Impl: login
  files: web/src/ui/login.ts
  do: Do section "## T21" of docs/tasks/web.md.
  verify: npm --prefix web run check -- test/login.test.ts
- [ ] T22 Test: app login and layout
  files: web/test/helpers/app.ts, web/test/app-login.test.ts
  do: Do section "## T22" of docs/tasks/web.md. Do not create web/src/app.ts.
  verify: [ "$(grep -c "^test('" web/test/app-login.test.ts)" -ge 4 ] && node --test web/test/app-login.test.ts 2>&1 | grep -q 'Cannot find module .*web/src/app.ts'
- [ ] T23 Impl: app login and layout
  files: web/src/app.ts
  do: Do section "## T23" of docs/tasks/web.md.
  verify: npm --prefix web run check -- test/app-login.test.ts
- [ ] T24 Test: app conversation selection
  files: web/test/app-select.test.ts
  do: Do section "## T24" of docs/tasks/web.md. Some of these tests fail until T25; that is expected.
  verify: [ "$(grep -c "^test('" web/test/app-select.test.ts)" -ge 5 ] && node --test --test-reporter=tap web/test/app-select.test.ts 2>&1 | grep -qE '^# tests ([5-9]|[1-9][0-9])$'
- [ ] T25 Impl: app conversation selection
  files: web/src/app.ts
  do: Do section "## T25" of docs/tasks/web.md.
  verify: npm --prefix web run check -- test/app-login.test.ts test/app-select.test.ts
- [ ] T26 Test: app sending and logout
  files: web/test/app-send.test.ts
  do: Do section "## T26" of docs/tasks/web.md. Some of these tests fail until T27; that is expected.
  verify: [ "$(grep -c "^test('" web/test/app-send.test.ts)" -ge 5 ] && node --test --test-reporter=tap web/test/app-send.test.ts 2>&1 | grep -qE '^# tests ([5-9]|[1-9][0-9])$'
- [ ] T27 Impl: app sending and logout
  files: web/src/app.ts
  do: Do section "## T27" of docs/tasks/web.md.
  verify: npm --prefix web run check -- test/app-login.test.ts test/app-select.test.ts test/app-send.test.ts
- [ ] T28 Test: styles
  files: web/test/styles.test.ts
  do: Do section "## T28" of docs/tasks/web.md. Do not create web/src/styles.css.
  verify: [ "$(grep -c "^test('" web/test/styles.test.ts)" -ge 6 ] && node --test web/test/styles.test.ts 2>&1 | grep -q 'ENOENT.*web/src/styles.css'
- [ ] T29 Impl: styles
  files: web/src/styles.css
  do: Do section "## T29" of docs/tasks/web.md.
  verify: npm --prefix web run check -- test/styles.test.ts && npm --prefix web run build
- [ ] T30 Wire the app entry point
  files: web/src/main.ts
  do: Do section "## T30" of docs/tasks/web.md exactly (copy the file content).
  verify: npm --prefix web run build && grep -q 'createDemoApi()' web/src/main.ts && ! grep -q 'Placeholder' web/src/main.ts
- [ ] T31 Web README and full check
  files: web/README.md
  do: Do section "## T31" of docs/tasks/web.md.
  verify: grep -q 'npm --prefix web run dev' web/README.md && grep -q 'http://localhost:5173' web/README.md && grep -q 'alice' web/README.md && npm --prefix web test && npm --prefix web run build
