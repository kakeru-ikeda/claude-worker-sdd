---
name: worker-sdd
description: Execute an approved Superpowers plan through external worker engines (Codex by default, OpenCode supported). Use whenever a plan document exists and implementation should start — this REPLACES superpowers:executing-plans and the git-worktree subagent flow for implementation.
---

# Worker SDD

Use this after `/superpowers:writing-plans` has produced a plan.

**This skill replaces `superpowers:executing-plans`.** Never implement plan tasks
with general-purpose subagents, `superpowers:using-git-worktrees`, or
`superpowers:finishing-a-development-branch` — implementation is dispatched to
worker engines through the runner below, and the orchestrator only reviews and
commits.

## Usage

```text
/worker-sdd docs/plans/<feature>.md
```

Optional overrides:

```text
/worker-sdd docs/plans/<feature>.md --engine codex --model gpt-5.4
/worker-sdd docs/plans/<feature>.md --task TASK-003 --engine opencode
```

## Workflow

The runner prints the next action after every run (success and each failure class) —
follow those hints. For deeper rules retrieve ONE playbook section on demand:
`sdd-worker guide` lists topics, `sdd-worker guide triage|commit|tokens|...` prints
one. Never read the whole playbook into context.

All runner state is namespaced per plan under `.superpowers/sdd/plans/<plan-slug>/`
(slug = plan filename without `.md`). A new plan always starts at TASK-001 with an
empty progress file — never continue numbering from another plan's progress; the
runner rejects task IDs beyond the plan's task count.

The loop (the runner does all bookkeeping — brief, task.yaml, dispatch.yaml,
progress updates, diff capture, report validation, single-run lock):

0. Before the first dispatch of a plan, set the executable acceptance gate once:
   `next <plan.md> --verify '<test command>'` — it persists and gates every task's
   completion (`complete` then requires exit 0 + report DONE + verify pass).
   Direct-edit exception: a change of ≤ 2 files / ≤ ~30 lines that you can specify
   exactly is cheaper to edit yourself (then run verify, commit) than to dispatch.
1. Dispatch **in the background** (see below): prefer `next <plan.md>` — it picks the
   first non-complete task; use `run <plan.md> --task TASK-N` only to override.
2. While it runs, keep orchestrating. Do not poll in a loop; the background job
   re-invokes you on exit.
3. On completion read, in order: `status.yaml` (verdict + `failure_reason`),
   `report.yaml`, `diff.patch`. Nothing else unless triaging (then
   `tail -n 50` of the latest `attempts/*/stdout.jsonl`).
4. Review the diff against the plan's acceptance criteria yourself. Optional:
   `sdd-worker review` for a second opinion on risky changes only.
5. Accept → the orchestrator commits (engine sandboxes cannot write `.git`), one
   commit per task, including `untracked_files` listed in status.yaml. Then loop.
6. Fail → the runner already printed the class-specific hint; follow it
   (deeper: `sdd-worker guide triage`). Max 2 retries per task, and never retry
   without changing something (constraints, model, or engine).
7. Stop when `next` prints "all N tasks complete"; run the plan's final verification
   (tests + build) once, directly.

Task artifacts must never be written directly into `.superpowers/sdd/`. The runner
auto-migrates any legacy flat layout into `plans/<slug>/` on its next invocation.

## Dispatch (non-blocking)

The runner spawns the engine (e.g. `codex exec`) and waits for it internally — a single
`codex exec` run can take many minutes. **Never run it in the foreground**, or the
orchestrator stalls and other work cannot proceed. Run it as a background shell job and
poll the task artifacts for completion — the same model the predecessor used.

Do not preflight the engine CLI (`which codex` etc.) — dispatch directly; a missing
binary fails fast with a "binary not found" reason and a recovery hint.

Run this command as a **background** job (Bash tool `run_in_background: true`):

```bash
sdd-worker run {{ARGUMENTS}}
```

(`sdd-worker` is put on PATH by `npm link` during setup; if missing, fall back to
`node <claude-worker-sdd repo>/runner/dist/index.js`.)

The runner records progress before and after the engine runs, so completion is observable
from artifacts (paths relative to the repo root; `<plan>` = `plans/<plan-slug>/`,
`task-N` = `tasks/task-<index>/`):

- `.superpowers/sdd/<plan>/progress.yaml` — task flips `status: running` → `complete` | `failed` (`complete` requires exit 0 **and** a report claiming DONE)
- `.superpowers/sdd/<plan>/tasks/task-N/status.yaml` — verdict, `exit_code`, `report_status`, `failure_reason`, `untracked_files`
- `.superpowers/sdd/<plan>/tasks/task-N/diff.patch` — auto-captured worktree diff vs HEAD; review this, not the files
- `.superpowers/sdd/<plan>/tasks/task-N/report.yaml` — the worker's report (required output)
- `.superpowers/sdd/<plan>/tasks/task-N/attempts/<NNN-engine-model>/stdout.jsonl` — live engine stream (tail sparingly; can be huge)

While the background job runs, the orchestrator is free to: answer the user, dispatch
read-only agents (`explorer` / `thinker` / `reviewer`) in parallel, and tail
`stdout.jsonl` to monitor. When the background job exits you are re-invoked
automatically; otherwise poll `status.yaml` / `progress.yaml`. Then read `report.yaml`
and the diff to review.

**One executor at a time:** do not background a second `executor` dispatch against the same
worktree while one is running (git conflicts). The runner enforces this with a per-plan
lock — a "another run is active" error means wait, not retry. Read-only dispatches may
run concurrently.

