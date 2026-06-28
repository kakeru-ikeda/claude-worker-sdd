---
name: worker-sdd
description: Run Superpowers SDD tasks through an engine-neutral worker runner. Supports Codex by default, OpenCode compatibility, and future engine adapters.
---

# Worker SDD

Use this after `/superpowers:writing-plans` has produced a plan.

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

1. Locate the Superpowers SDD scripts.
2. Read `.superpowers/sdd/progress.yaml`.
3. Generate a per-task child directory under `.superpowers/sdd/tasks/task-N/`.
4. Write `task.yaml` and `dispatch.yaml`.
5. Dispatch the selected engine adapter **in the background** (see below). Do not block the foreground waiting for it.
6. While it runs, keep orchestrating; the runner writes `report.yaml` and `status.yaml` when done.
7. Claude Code reviews the worker report, status, and diff. Optional: run `sdd-worker review` only for a second opinion.
8. Update `progress.yaml`.

Task artifacts must never be written directly into `.superpowers/sdd/`.

## Dispatch (non-blocking)

The runner spawns the engine (e.g. `codex exec`) and waits for it internally — a single
`codex exec` run can take many minutes. **Never run it in the foreground**, or the
orchestrator stalls and other work cannot proceed. Run it as a background shell job and
poll the task artifacts for completion — the same model the predecessor used.

Run this command as a **background** job (Bash tool `run_in_background: true`):

```bash
node "$HOME/github/claude-worker-sdd/runner/dist/index.js" run {{ARGUMENTS}}
```

The runner records progress before and after the engine runs, so completion is observable
from artifacts (paths relative to the repo root; `task-N` = `tasks/task-<index>/`):

- `.superpowers/sdd/progress.yaml` — task flips `status: running` → `complete` | `failed`
- `.superpowers/sdd/tasks/task-N/status.yaml` — written after the engine exits; carries `exit_code`
- `.superpowers/sdd/tasks/task-N/attempts/<NNN-engine-model>/stdout.jsonl` — live engine stream (tail to monitor)
- `.superpowers/sdd/tasks/task-N/report.yaml` — the worker's report (required output)

While the background job runs, the orchestrator is free to: answer the user, dispatch
read-only agents (`explorer` / `thinker` / `reviewer`) in parallel, and tail
`stdout.jsonl` to monitor. When the background job exits you are re-invoked
automatically; otherwise poll `status.yaml` / `progress.yaml`. Then read `report.yaml`
and the diff to review.

**One executor at a time:** do not background a second `executor` dispatch against the same
worktree while one is running (git conflicts). Read-only dispatches may run concurrently.

