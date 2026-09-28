# j-messenger agent rules

These rules apply to every request in this repository. They override global agent rules where they differ.

## 1. First action of every request (mandatory)

1. If the skill `ctx-relay` is in your available skills, load it **before anything else**, even for a short request. Then follow its Executor loop.
2. If the skill is not available, follow the ctx-relay block at the end of this file. It is the same loop.
3. Run `python .ctx/ctx.py check` (Windows). If `python` is missing, use `python3`.
4. This repository uses ctx-relay instead of any `handoff` skill. Do not create `.opencode/state/`. `.ctx/STATE.md` is the only state file.

## 2. Keep going, never ask

- All decisions are already made in `docs/plan.md` and the task specs. Do not ask the user questions and do not wait for confirmation.
- Per task: implement, run `node scripts/verify.mjs T<n>`, and when it prints `VERIFY T<n> OK`: mark `[x]`, append the LOG line,
  then **commit**: `git add <the task's files> .ctx` and `git commit -m "T<n>: <task title>"`. Then take the next `- [ ]` task in the same reply.
- `verify.mjs` fails when anything outside the task's `files:` differs from the last commit. If it names files of the previous task,
  that task was not committed: commit it. Never edit other files to make verify pass.
- The only reasons to stop: every task is done, `status: blocked`, or the ctx-relay blocked rule fires (unclear `do:`, a needed file outside
  `files:`, or `fails` reaches 2). Write the cause in STATE `blocked:` so the planner can fix it.
- Reply to the user in Korean. Per finished task, one line: task id, verify result, commit hash.

## 3. Environment (details in docs/env.md)

- Windows 11, PowerShell. Repo root `D:\workspace\test-space\github\j-messenger`. Run every command from the repo root.
- Node 24 on Windows; the server also runs on Node 22 on the VM, so use nothing newer than Node 22 offers.
  `.ts` files run directly with Node's type stripping. Do not add ts-node, tsx, Babel or build steps.
- **Write and edit files only with your file edit/patch tool.** Never write file content through PowerShell
  (`Set-Content`, `Out-File`, `>`, here-strings): PowerShell turns backticks into control characters and breaks files.
- Ports: 5173 web dev server, 3000 server. Port 3001 is the model gateway: never bind, kill or call it.
- No `sudo`, no `ssh`, no changes to Windows, WSL, Hyper-V or the VM. Infrastructure belongs to the planner.

## 4. Planner-owned files (never edit)

`AGENTS.md`, `docs/**`, `scripts/**`, `.gitignore`, `.gitattributes`, `web/src/types.ts`, and in Impl tasks every file under `web/test/` and `server/test/`.
If one of them looks wrong, set the task blocked and explain why.

## 5. Code rules

- Follow the "Common rules" at the top of the current spec file (`docs/tasks/web-fix.md` with `docs/tasks/web.md`, or `docs/tasks/server.md`).
- TypeScript strict, ES modules. Local imports end in `.ts`. Type-only imports use `import type`.
- Only erasable TypeScript: no `enum`, `namespace`, constructor parameter properties or decorators. No `any` in `src/`.
- Never add dependencies. Never run `npm install <package>`. Only `npm --prefix web install` / `npm --prefix server install` with the committed package.json.
- No test-only hooks in `src/` (no `__get...` functions, no exports that only tests use).
- UI text is Korean exactly as the spec writes it. Code, comments, commit messages and `.ctx` files are English.

## 6. Where things are

| What | Where |
| --- | --- |
| Current tasks and state | `.ctx/TASKS.md`, `.ctx/STATE.md` |
| Spec of the current tasks | `docs/tasks/web-fix.md` (T32-T41), `docs/tasks/server.md` (T42-T73); read only your `## T<n>` section and Common rules |
| Decisions | `docs/plan.md` |
| Environment, ports, accounts | `docs/env.md` |

<!-- ctx-relay:start -->
## ctx-relay (do this before every task)
Work state lives in `.ctx/`. You remember nothing from earlier turns; these files are the only truth. Load skill `ctx-relay` if you can.
1. Run `python .ctx/ctx.py check` (`python3` if `python` is missing). Then read `.ctx/STATE.md` and `.ctx/TASKS.md`.
2. `status: blocked` -> report the `blocked:` line and stop. `status: idle` -> take the first `- [ ]` task: set `task`, `status: active`, `fails: 0`.
3. Edit or create only the paths in the task's `files:`. Unclear `do:` or another file needed -> set blocked. Do not guess.
4. After every edit or command, rewrite STATE `did`, `next`, `updated`, then run check. Always do this before ending a reply.
5. Run the task's `verify:`. Exit 0 -> mark `- [x]`, append a LOG.md line, STATE `task: -`, `status: idle`. Otherwise `fails` +1; at 2 -> mark `- [!]`, `status: blocked`, `blocked: <cause>`, stop.
6. Never mark `[x]` without exit 0 from `verify:` in this session. Never edit `do:`, `files:` or `verify:`. Never push.
<!-- ctx-relay:end -->
