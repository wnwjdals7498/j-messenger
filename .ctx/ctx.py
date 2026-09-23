#!/usr/bin/env python3
"""ctx-relay: set up and check the per-repo .ctx/ work relay.

Usage:
  python ctx.py init [--root DIR] [--goal TEXT]
  python ctx.py check [--root DIR]

Stdlib only, Python 3.6+. Messages are ASCII so any console can print them.
Exit codes: 0 ok (warnings allowed), 1 check failed, 2 no .ctx/ found.
"""
import argparse
import datetime
import re
import shutil
import subprocess
import sys
from pathlib import Path

STATE_MAX = 3000
TASKS_MAX = 12000
FIELD_MAX = 300
NOTE_MAX = 200
NOTES_MAX = 5
MAX_FAILS = 2

TOP_KEYS = ("goal", "updated")
NOW_KEYS = ("task", "status", "did", "next", "fails", "blocked")
STATUSES = ("idle", "active", "blocked")
TASK_KEYS = ("files", "do", "verify")

TASK_RE = re.compile(r"^- \[( |x|!)\] (T\d+) (\S.*)$")
TASK_LIKE_RE = re.compile(r"^[-*] ?\[")
KEY_RE = re.compile(r"^([a-z][a-z_-]*):(.*)$")
TASK_ID_RE = re.compile(r"^T\d+$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$")
COMMENT_RE = re.compile(r"<!--.*?-->", re.S)

MARK_START = "<!-- ctx-relay:start -->"
MARK_END = "<!-- ctx-relay:end -->"

STATE_TEMPLATE = """# STATE
goal: {goal}
updated: {date}

## now
task: -
status: idle
did: -
next: -
fails: 0
blocked: -

## notes
"""

TASKS_TEMPLATE = """# TASKS
plan: {goal}

<!-- Planner (big model) writes tasks. Executor only flips [ ] to [x] or [!].
- [ ] T1 Short title
  files: path/edit-or-create.ts, path/other.ts
  do: Exact, self-contained instructions. Continuation lines stay indented.
  verify: one shell command; exit 0 means done
-->
"""

LOG_TEMPLATE = """# LOG
<!-- Append one line per finished or blocked task. Newest last. Not read by default.
2026-01-31 14:10 | T3 | done | verify exit 0 | model: ? | short note
-->
"""

AGENTS_BLOCK = """## ctx-relay (do this before every task)
Work state lives in `.ctx/`. You remember nothing from earlier turns; these files are the only truth. Load skill `ctx-relay` if you can.
1. Run `python .ctx/ctx.py check` (`python3` if `python` is missing). Then read `.ctx/STATE.md` and `.ctx/TASKS.md`.
2. `status: blocked` -> report the `blocked:` line and stop. `status: idle` -> take the first `- [ ]` task: set `task`, `status: active`, `fails: 0`.
3. Edit or create only the paths in the task's `files:`. Unclear `do:` or another file needed -> set blocked. Do not guess.
4. After every edit or command, rewrite STATE `did`, `next`, `updated`, then run check. Always do this before ending a reply.
5. Run the task's `verify:`. Exit 0 -> mark `- [x]`, append a LOG.md line, STATE `task: -`, `status: idle`. Otherwise `fails` +1; at 2 -> mark `- [!]`, `status: blocked`, `blocked: <cause>`, stop.
6. Never mark `[x]` without exit 0 from `verify:` in this session. Never edit `do:`, `files:` or `verify:`. Never push."""


def strip_comments(text):
    """Blank out HTML comments but keep line numbers."""
    return COMMENT_RE.sub(lambda m: "\n" * m.group(0).count("\n"), text)


def read(path):
    with path.open(encoding="utf-8") as f:
        return f.read()


def write(path, text):
    with path.open("w", encoding="utf-8", newline="\n") as f:
        f.write(text)


class Report(object):
    def __init__(self):
        self.fails = []
        self.warns = []

    def fail(self, where, msg):
        self.fails.append("FAIL %s: %s" % (where, msg))

    def warn(self, where, msg):
        self.warns.append("WARN %s: %s" % (where, msg))


def parse_tasks(text, rep):
    """Return list of (line_no, mark, task_id, title, keys) and record format errors."""
    where = ".ctx/TASKS.md"
    if len(text) > TASKS_MAX:
        rep.fail(where, "%d chars, max %d. Planner: delete [x] tasks (LOG.md keeps history)"
                 % (len(text), TASKS_MAX))
    lines = strip_comments(text).splitlines()
    if not lines or lines[0].strip() != "# TASKS":
        rep.fail(where + ":1", 'first line must be "# TASKS"')
    tasks = []
    seen = {}
    cur = None
    has_plan = False
    for no, raw in enumerate(lines[1:], 2):
        line = raw.rstrip()
        if not line.strip():
            continue
        loc = "%s:%d" % (where, no)
        if line[0] in " \t":
            if cur is None:
                rep.fail(loc, "indented line outside a task")
                continue
            m = KEY_RE.match(line.strip())
            if m and m.group(1) in TASK_KEYS:
                if m.group(1) in cur[4]:
                    rep.fail(loc, 'duplicate "%s:" in %s' % (m.group(1), cur[2]))
                cur[4][m.group(1)] = m.group(2).strip()
            continue
        m = TASK_RE.match(line)
        if m:
            cur = (no, m.group(1), m.group(2), m.group(3), {})
            if cur[2] in seen:
                rep.fail(loc, "duplicate task id %s (first at line %d)" % (cur[2], seen[cur[2]]))
            seen.setdefault(cur[2], no)
            tasks.append(cur)
            continue
        if TASK_LIKE_RE.match(line):
            rep.fail(loc, 'malformed task line. Use "- [ ] T<n> Title" with [ ], [x] or [!]')
            cur = None
            continue
        if line.startswith("#"):
            cur = None
            continue
        if not tasks and line.startswith("plan:"):
            has_plan = bool(line[5:].strip())
            continue
        if tasks:
            rep.fail(loc, "unexpected top-level text after tasks. Indent it under a task or remove it")
    if not has_plan:
        rep.fail(where, 'missing "plan: <one line>" before the first task')
    for no, _mark, tid, _title, keys in tasks:
        for key in TASK_KEYS:
            if not keys.get(key):
                rep.fail("%s:%d" % (where, no), '%s has no "%s:" line' % (tid, key))
    return tasks


def check_state(text, tasks, rep):
    where = ".ctx/STATE.md"
    if len(text) > STATE_MAX:
        rep.fail(where, "%d chars, max %d. Shorten did/next/notes" % (len(text), STATE_MAX))
    lines = strip_comments(text).splitlines()
    if not lines or lines[0].strip() != "# STATE":
        rep.fail(where + ":1", 'first line must be "# STATE"')
    section = None
    sections = set()
    top, now, notes = {}, {}, []
    for no, raw in enumerate(lines[1:], 2):
        line = raw.rstrip()
        if not line.strip():
            continue
        loc = "%s:%d" % (where, no)
        if line.startswith("#"):
            name = line.lstrip("#").strip()
            if not line.startswith("## ") or name not in ("now", "notes"):
                rep.fail(loc, 'unknown heading "%s". Only "## now" and "## notes" are allowed' % line)
            elif name in sections:
                rep.fail(loc, 'duplicate "## %s"' % name)
            else:
                sections.add(name)
                section = name
            continue
        if section == "notes":
            if not line.startswith("- "):
                rep.fail(loc, 'notes lines must start with "- "')
            else:
                notes.append((no, line[2:].strip()))
            continue
        m = KEY_RE.match(line)
        if not m:
            rep.fail(loc, 'expected "key: value"')
            continue
        key, val = m.group(1), m.group(2).strip()
        target, allowed = (now, NOW_KEYS) if section == "now" else (top, TOP_KEYS)
        if key not in allowed:
            rep.fail(loc, 'unknown key "%s" here. Allowed: %s' % (key, ", ".join(allowed)))
        elif key in target:
            rep.fail(loc, 'duplicate key "%s"' % key)
        else:
            target[key] = (no, val)

    for name in ("now", "notes"):
        if name not in sections:
            rep.fail(where, 'missing "## %s" section' % name)
    for keys, group in ((TOP_KEYS, top), (NOW_KEYS, now)):
        for key in keys:
            if key not in group:
                rep.fail(where, 'missing "%s:" line' % key)
            elif not group[key][1]:
                rep.fail("%s:%d" % (where, group[key][0]), '"%s:" is empty. Use "-" for none' % key)
            elif len(group[key][1]) > FIELD_MAX:
                rep.fail("%s:%d" % (where, group[key][0]),
                         '"%s:" is %d chars, max %d' % (key, len(group[key][1]), FIELD_MAX))
    if len(notes) > NOTES_MAX:
        rep.fail(where, "%d notes, max %d" % (len(notes), NOTES_MAX))
    for no, note in notes:
        if len(note) > NOTE_MAX:
            rep.fail("%s:%d" % (where, no), "note is %d chars, max %d" % (len(note), NOTE_MAX))
    if "updated" in top and top["updated"][1] and not DATE_RE.match(top["updated"][1]):
        rep.fail("%s:%d" % (where, top["updated"][0]), 'use "YYYY-MM-DD HH:MM"')

    val = dict((k, v[1]) for k, v in now.items())
    status, task = val.get("status"), val.get("task")
    fails = None
    if "fails" in val:
        if val["fails"].isdigit():
            fails = int(val["fails"])
        else:
            rep.fail("%s:%d" % (where, now["fails"][0]), '"fails:" must be a whole number')
    if status is not None and status not in STATUSES:
        rep.fail("%s:%d" % (where, now["status"][0]),
                 'status "%s" invalid. Use %s' % (status, ", ".join(STATUSES)))
        status = None
    marks = dict((t[2], t[1]) for t in tasks)
    if status == "idle":
        if task != "-":
            rep.fail(where, 'status is idle, so "task:" must be "-"')
    elif status in ("active", "blocked") and task is not None:
        if not TASK_ID_RE.match(task):
            rep.fail(where, '"task:" must be a task id like T3')
        elif task not in marks:
            rep.fail(where, "task %s is not in TASKS.md" % task)
        elif status == "active" and marks[task] != " ":
            rep.fail(where, "STATE says %s is active but TASKS marks it [%s]. Make them agree"
                     % (task, marks[task]))
        elif status == "blocked" and marks[task] != "!":
            rep.fail(where, "STATE says %s is blocked, so TASKS must mark it [!]" % task)
    if status == "blocked" and val.get("blocked") == "-":
        rep.fail(where, 'status is blocked, so "blocked:" must say why')
    if status == "active" and fails is not None and fails >= MAX_FAILS:
        rep.fail(where, "fails reached %d. Set status: blocked, blocked: <cause>, and mark the task [!]"
                 % MAX_FAILS)
    if status != "blocked" and any(m == "!" for m in marks.values()):
        rep.warn(".ctx/TASKS.md", "a task is marked [!] but STATE is not blocked. Planner should resolve it")
    return status, task


def find_root(arg):
    if arg:
        return Path(arg).resolve()
    here = Path(__file__).resolve().parent
    if here.name == ".ctx":
        return here.parent
    cur = Path.cwd().resolve()
    for p in [cur] + list(cur.parents):
        if (p / ".ctx").is_dir():
            return p
    return None


def git_root():
    try:
        proc = subprocess.run(["git", "rev-parse", "--show-toplevel"], stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, universal_newlines=True)
    except OSError:
        return None
    out = proc.stdout.strip()
    return Path(out).resolve() if proc.returncode == 0 and out else None


def cmd_check(root):
    ctx = root / ".ctx"
    rep = Report()
    missing = [n for n in ("STATE.md", "TASKS.md", "LOG.md") if not (ctx / n).is_file()]
    for name in missing:
        rep.fail(".ctx/" + name, "missing. Run: python <skill-dir>/scripts/ctx.py init")
    tasks = []
    if "TASKS.md" not in missing:
        tasks = parse_tasks(read(ctx / "TASKS.md"), rep)
    status, task = None, None
    if "STATE.md" not in missing:
        status, task = check_state(read(ctx / "STATE.md"), tasks, rep)
    agents = root / "AGENTS.md"
    if not agents.is_file() or MARK_START not in read(agents):
        rep.warn("AGENTS.md", "ctx-relay block missing. Run: python <skill-dir>/scripts/ctx.py init")
    for line in rep.fails + rep.warns:
        print(line)
    if rep.fails:
        print("ctx check: %d fail, %d warn. Fix each FAIL line, then run check again"
              % (len(rep.fails), len(rep.warns)))
        return 1
    count = lambda mark: sum(1 for t in tasks if t[1] == mark)
    print("ctx check: OK | status %s | task %s | open %d | done %d | blocked %d"
          % (status, task, count(" "), count("x"), count("!")))
    return 0


def update_agents(root):
    path = root / "AGENTS.md"
    block = MARK_START + "\n" + AGENTS_BLOCK + "\n" + MARK_END
    text = read(path) if path.is_file() else ""
    if MARK_START in text and MARK_END in text:
        new = text.split(MARK_START, 1)[0] + block + text.split(MARK_END, 1)[1]
    elif text.strip():
        new = text.rstrip("\n") + "\n\n" + block + "\n"
    else:
        new = block + "\n"
    if new != text:
        write(path, new)
        return True
    return False


def cmd_init(root, goal):
    ctx = root / ".ctx"
    ctx.mkdir(exist_ok=True)
    date = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    for name, template in (("STATE.md", STATE_TEMPLATE), ("TASKS.md", TASKS_TEMPLATE),
                           ("LOG.md", LOG_TEMPLATE)):
        path = ctx / name
        if path.exists():
            print("kept    .ctx/" + name)
        else:
            write(path, template.replace("{goal}", goal).replace("{date}", date))
            print("created .ctx/" + name)
    src, dst = Path(__file__).resolve(), ctx / "ctx.py"
    if not dst.exists() or src != dst.resolve():
        shutil.copyfile(str(src), str(dst))
        print("copied  .ctx/ctx.py")
    print(("updated " if update_agents(root) else "kept    ") + "AGENTS.md ctx-relay block")
    return cmd_check(root)


def main(argv=None):
    parser = argparse.ArgumentParser(description="ctx-relay .ctx/ setup and checker")
    sub = parser.add_subparsers(dest="cmd")
    p_init = sub.add_parser("init", help="create .ctx/, copy this script, add AGENTS.md block")
    p_init.add_argument("--root", help="repo root (default: git top level or cwd)")
    p_init.add_argument("--goal", default="-", help="one-line end goal")
    p_check = sub.add_parser("check", help="validate .ctx/ size, keys and consistency")
    p_check.add_argument("--root", help="repo root (default: nearest dir with .ctx/)")
    args = parser.parse_args(argv)
    if args.cmd == "init":
        root = Path(args.root).resolve() if args.root else (find_root(None) or git_root() or Path.cwd())
        return cmd_init(root, " ".join(args.goal.split()) or "-")
    if args.cmd == "check":
        root = find_root(args.root)
        if root is None or not (root / ".ctx").is_dir():
            print("FAIL: no .ctx/ found. Planner: run python <skill-dir>/scripts/ctx.py init")
            return 2
        return cmd_check(root)
    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
