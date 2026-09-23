# j-messenger agent rules

These rules apply to every request in this repository. They override the global AGENTS.md where they differ.

## 1. First action of every request (mandatory)

1. If the skill `ctx-relay` is in your available skills, load it with the skill tool **before anything else**, even for a short request. Then follow its Executor loop.
2. If the skill is not available, follow the ctx-relay block at the end of this file. It is the same loop.
3. Always run `python3 .ctx/ctx.py check`. Never `python`: in this WSL it is a Windows pyenv shim.
4. This repository uses ctx-relay instead of the global `handoff` skill. Do not load `handoff` and do not create `.opencode/state/`. `.ctx/STATE.md` is the only state file.

## 2. Keep going, never ask

- All decisions are already made in `docs/plan.md` and the task specs. Do not ask the user questions and do not wait for confirmation.
- After a task is verified and committed, take the next `- [ ]` task in the same reply. Continue until no `- [ ]` is left.
- The only reasons to stop: every task is done, `status: blocked`, or the ctx-relay blocked rule fires (unclear `do:`, a needed file outside `files:`, or `fails` reaches 2). Write the cause in STATE `blocked:` so the planner can fix it.
- Reply to the user in Korean. Per finished task, one line: task id, verify result, commit hash.

## 3. Environment (fixed; details in docs/env.md)

- Shell: bash in WSL Ubuntu 22.04, user `jjm`. Run every command from the repo root `/mnt/d/workspace/test-space/github/j-messenger`.
- Node 22 runs `.ts` files directly (type stripping). Do not add ts-node, tsx, Babel or build steps.
- Ports: 5173 web dev server, 3000 server dev. **3001 is freellmapi, the model gateway you are running on: never bind, kill or call it.**
- VM: `ssh jm-vm` (user `jmsg`, no sudo, 10.77.0.10). Use it only when a task's `do:` says so.
- Never run `sudo`, never use `ssh jm-vm-admin`, never change Windows, WSL or VM system settings. Infrastructure belongs to the planner.

## 4. Code rules

- Follow the "Common rules" at the top of the current spec file (for batch W: `docs/tasks/web.md`).
- TypeScript strict, ES modules. Local imports end in `.ts`. Type-only imports use `import type`.
- Only erasable TypeScript: no `enum`, `namespace`, constructor parameter properties or decorators. No `any`.
- Never add dependencies. Never run `npm install <package>`. Only `npm --prefix web install` with the committed package.json.
- Files under `web/test/` are written only by "Test:" tasks. Implementation tasks must not edit them, even when a test looks wrong: set blocked instead.
- UI text is Korean exactly as the spec writes it. Code, comments, commit messages and `.ctx` files are English.
- LF line endings, UTF-8, 2-space indent, single quotes, semicolons.

## 5. Where things are

| What | Where |
| --- | --- |
| Current tasks and state | `.ctx/TASKS.md`, `.ctx/STATE.md` |
| Spec of the current batch | `docs/tasks/web.md` (read only your `## T<n>` section and Common rules) |
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
