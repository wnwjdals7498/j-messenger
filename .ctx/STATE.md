# STATE
goal: Fix batch W (T32-T41) then build the server (T42-T73)
updated: 2026-09-29 12:00

## now
task: -
status: idle
did: -
next: -
fails: 0
blocked: -

## notes
- Windows PowerShell at D:\workspace\test-space\github\j-messenger. Write files only with the edit tool, never via PowerShell strings.
- Verify: node scripts/verify.mjs T<n>. Commit every finished task: git add <files> .ctx; git commit -m "T<n>: <title>".
- Specs: T32-T41 docs/tasks/web-fix.md, T42-T73 docs/tasks/server.md. Read only your section and Common rules.
- Never edit docs/, AGENTS.md, scripts/verify.mjs; Impl tasks never edit tests. No npm install <pkg>, no sudo, no ssh.
- Code must run on Node 22 (VM) and 24 (Windows). Local imports end in .ts. No enum, namespace or any.
