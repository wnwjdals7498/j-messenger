# STATE
goal: Phase 1 batch W: demo web UI, spec docs/tasks/web.md T1-T31
updated: 2026-09-23 16:50

## now
task: -
status: idle
did: -
next: -
fails: 0
blocked: -

## notes
- Shell: WSL bash at repo root /mnt/d/workspace/test-space/github/j-messenger. Use python3, never python (it is a Windows shim).
- Each task spec: docs/tasks/web.md section "## T<n>" plus its Common rules. Decisions: docs/plan.md. Environment: docs/env.md.
- Port 3001 is freellmapi (the model gateway): never bind, kill or call it. Web dev server port is 5173.
- Never sudo, never ssh jm-vm-admin, never npm install <package>. Impl tasks never edit files under web/test/.
- Local imports end in .ts. No enum, namespace, any, innerHTML. UI code builds DOM via root.ownerDocument.
