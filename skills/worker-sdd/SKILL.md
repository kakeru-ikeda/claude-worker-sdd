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
5. Dispatch the selected engine adapter.
6. Require `report.yaml`.
7. Claude Code reviews the worker report, status, and diff. Optional: run `sdd-worker review` only for a second opinion.
8. Update `progress.yaml`.

Task artifacts must never be written directly into `.superpowers/sdd/`.

## Command

```bash
node "$HOME/github/claude-worker-sdd/runner/dist/index.js" run {{ARGUMENTS}}
```

