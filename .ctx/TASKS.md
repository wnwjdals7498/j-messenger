# TASKS
plan: Batch WF (fix web, T32-T41, docs/tasks/web-fix.md) then batch S (server, T42-T73, docs/tasks/server.md). Verify: node scripts/verify.mjs <id>.

- [ ] T32 Remove the stray debug test
  files: web/test/composer-test-debug.ts
  do: Do section "## T32" of docs/tasks/web-fix.md.
  verify: node scripts/verify.mjs T32
- [ ] T33 Test: restore the styles test
  files: web/test/styles.test.ts
  do: Do section "## T33" of docs/tasks/web-fix.md. One test must fail until T34.
  verify: node scripts/verify.mjs T33
- [ ] T34 Impl: fix the narrow-screen selectors
  files: web/src/styles.css
  do: Do section "## T34" of docs/tasks/web-fix.md.
  verify: node scripts/verify.mjs T34
- [ ] T35 Test: restore the composer test
  files: web/test/composer.test.ts
  do: Do section "## T35" of docs/tasks/web-fix.md. One test must fail until T36.
  verify: node scripts/verify.mjs T35
- [ ] T36 Impl: composer form skips browser validation
  files: web/src/ui/composer.ts
  do: Do section "## T36" of docs/tasks/web-fix.md.
  verify: node scripts/verify.mjs T36
- [ ] T37 Test: restore sidebar and dom assertions
  files: web/test/sidebar.test.ts, web/test/dom.test.ts
  do: Do section "## T37" of docs/tasks/web-fix.md.
  verify: node scripts/verify.mjs T37
- [ ] T38 Test: restore login assertions
  files: web/test/login.test.ts
  do: Do section "## T38" of docs/tasks/web-fix.md.
  verify: node scripts/verify.mjs T38
- [ ] T39 Test: restore the app helpers and app tests
  files: web/test/helpers/app.ts, web/test/app-login.test.ts, web/test/app-send.test.ts, web/test/app-select.test.ts
  do: Do section "## T39" of docs/tasks/web-fix.md. One app-select test must fail until T40.
  verify: node scripts/verify.mjs T39
- [ ] T40 Impl: app.ts back to the spec
  files: web/src/app.ts
  do: Do section "## T40" of docs/tasks/web-fix.md.
  verify: node scripts/verify.mjs T40
- [ ] T41 Web README for Windows
  files: web/README.md
  do: Do section "## T41" of docs/tasks/web-fix.md. Use the file edit tool, not PowerShell.
  verify: node scripts/verify.mjs T41
- [ ] T42 Scaffold the server package
  files: server/package.json, server/tsconfig.json, server/src/version.ts, server/package-lock.json
  do: Do section "## T42" of docs/tasks/server.md (copy the files, then npm install).
  verify: node scripts/verify.mjs T42
- [ ] T43 Test: config
  files: server/test/config.test.ts
  do: Do section "## T43" of docs/tasks/server.md. Do not create server/src/config.ts.
  verify: node scripts/verify.mjs T43
- [ ] T44 Impl: config
  files: server/src/config.ts
  do: Do section "## T44" of docs/tasks/server.md.
  verify: node scripts/verify.mjs T44
- [ ] T45 Database migrations
  files: server/src/migrations.ts
  do: Do section "## T45" of docs/tasks/server.md (copy the file content).
  verify: node scripts/verify.mjs T45
- [ ] T46 Test: db
  files: server/test/db.test.ts
  do: Do section "## T46" of docs/tasks/server.md. Do not create server/src/db.ts.
  verify: node scripts/verify.mjs T46
- [ ] T47 Impl: db
  files: server/src/db.ts
  do: Do section "## T47" of docs/tasks/server.md.
  verify: node scripts/verify.mjs T47
- [ ] T48 Test: http-util
  files: server/test/http-util.test.ts
  do: Do section "## T48" of docs/tasks/server.md. Do not create server/src/http-util.ts.
  verify: node scripts/verify.mjs T48
- [ ] T49 Impl: http-util
  files: server/src/http-util.ts
  do: Do section "## T49" of docs/tasks/server.md.
  verify: node scripts/verify.mjs T49
- [ ] T50 Test: router
  files: server/test/router.test.ts
  do: Do section "## T50" of docs/tasks/server.md. Do not create server/src/router.ts.
  verify: node scripts/verify.mjs T50
- [ ] T51 Impl: router
  files: server/src/router.ts
  do: Do section "## T51" of docs/tasks/server.md.
  verify: node scripts/verify.mjs T51
- [ ] T52 Auth provider contract
  files: server/src/auth/provider.ts
  do: Do section "## T52" of docs/tasks/server.md (copy the file content).
  verify: node scripts/verify.mjs T52
- [ ] T53 Test: dev auth
  files: server/test/dev-auth.test.ts
  do: Do section "## T53" of docs/tasks/server.md. Do not create server/src/auth/dev.ts.
  verify: node scripts/verify.mjs T53
- [ ] T54 Impl: dev auth
  files: server/src/auth/dev.ts
  do: Do section "## T54" of docs/tasks/server.md.
  verify: node scripts/verify.mjs T54
- [ ] T55 Test: users
  files: server/test/users.test.ts
  do: Do section "## T55" of docs/tasks/server.md. Do not create server/src/users.ts.
  verify: node scripts/verify.mjs T55
- [ ] T56 Impl: users
  files: server/src/users.ts
  do: Do section "## T56" of docs/tasks/server.md.
  verify: node scripts/verify.mjs T56
- [ ] T57 Test: sessions
  files: server/test/sessions.test.ts
  do: Do section "## T57" of docs/tasks/server.md. Do not create server/src/sessions.ts.
  verify: node scripts/verify.mjs T57
- [ ] T58 Impl: sessions
  files: server/src/sessions.ts
  do: Do section "## T58" of docs/tasks/server.md.
  verify: node scripts/verify.mjs T58
- [ ] T59 Test: conversations
  files: server/test/conversations.test.ts
  do: Do section "## T59" of docs/tasks/server.md. Do not create server/src/conversations.ts.
  verify: node scripts/verify.mjs T59
- [ ] T60 Impl: conversations
  files: server/src/conversations.ts
  do: Do section "## T60" of docs/tasks/server.md.
  verify: node scripts/verify.mjs T60
- [ ] T61 Test: messages
  files: server/test/messages.test.ts
  do: Do section "## T61" of docs/tasks/server.md. Do not create server/src/messages.ts.
  verify: node scripts/verify.mjs T61
- [ ] T62 Impl: messages
  files: server/src/messages.ts
  do: Do section "## T62" of docs/tasks/server.md.
  verify: node scripts/verify.mjs T62
- [ ] T63 Test: events
  files: server/test/events.test.ts
  do: Do section "## T63" of docs/tasks/server.md. Do not create server/src/events.ts.
  verify: node scripts/verify.mjs T63
- [ ] T64 Impl: events
  files: server/src/events.ts
  do: Do section "## T64" of docs/tasks/server.md.
  verify: node scripts/verify.mjs T64
- [ ] T65 Test: app core
  files: server/test/helpers/server.ts, server/test/app-core.test.ts
  do: Do section "## T65" of docs/tasks/server.md. Do not create server/src/app.ts.
  verify: node scripts/verify.mjs T65
- [ ] T66 Impl: app core
  files: server/src/app.ts
  do: Do section "## T66" of docs/tasks/server.md.
  verify: node scripts/verify.mjs T66
- [ ] T67 Test: app data routes
  files: server/test/app-data.test.ts
  do: Do section "## T67" of docs/tasks/server.md. Tests fail until T68; that is expected.
  verify: node scripts/verify.mjs T67
- [ ] T68 Impl: app data routes
  files: server/src/app.ts
  do: Do section "## T68" of docs/tasks/server.md.
  verify: node scripts/verify.mjs T68
- [ ] T69 Test: app events
  files: server/test/app-events.test.ts
  do: Do section "## T69" of docs/tasks/server.md. Tests fail until T70; that is expected.
  verify: node scripts/verify.mjs T69
- [ ] T70 Impl: app events
  files: server/src/app.ts
  do: Do section "## T70" of docs/tasks/server.md.
  verify: node scripts/verify.mjs T70
- [ ] T71 Test: server entry point
  files: server/test/index.test.ts
  do: Do section "## T71" of docs/tasks/server.md. Do not create server/src/index.ts.
  verify: node scripts/verify.mjs T71
- [ ] T72 Impl: server entry point
  files: server/src/index.ts
  do: Do section "## T72" of docs/tasks/server.md.
  verify: node scripts/verify.mjs T72
- [ ] T73 Server README and full check
  files: server/README.md
  do: Do section "## T73" of docs/tasks/server.md. Use the file edit tool, not PowerShell.
  verify: node scripts/verify.mjs T73
