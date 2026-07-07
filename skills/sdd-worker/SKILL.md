---
name: sdd-worker
description: Engine-neutral worker control commands for status, retry, optional second-opinion review, and engine/model overrides.
---

# SDD Worker

Use this for operational controls around the shared SDD runner.

## Usage

```text
/sdd-worker status                     per-task table + next pending task
/sdd-worker next [docs/plans/x.md]     dispatch first non-complete task (background!)
/sdd-worker set TASK-003 engine opencode
/sdd-worker set TASK-003 model gpt-5.5
/sdd-worker retry TASK-003 --engine codex --model gpt-5.4
/sdd-worker review TASK-003 --engine codex --model gpt-5.5  (optional second opinion)
```

Use `status` instead of reading `progress.yaml` — it is cheaper and already computes
the next pending task.

Task IDs resolve against the active plan recorded in `.superpowers/sdd/current-plan.yaml`
(set by the last `run`). Pass `--plan <plan.md>` to target a different plan's tasks.

## Command

```bash
sdd-worker {{ARGUMENTS}}
```

(`sdd-worker` is put on PATH by `npm link` during setup; if missing, fall back to
`node <claude-worker-sdd repo>/runner/dist/index.js`.)

