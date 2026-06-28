---
name: sdd-worker
description: Engine-neutral worker control commands for status, retry, optional second-opinion review, and engine/model overrides.
---

# SDD Worker

Use this for operational controls around the shared SDD runner.

## Usage

```text
/sdd-worker status
/sdd-worker set TASK-003 engine opencode
/sdd-worker set TASK-003 model gpt-5.5
/sdd-worker retry TASK-003 --engine codex --model gpt-5.4
/sdd-worker review TASK-003 --engine codex --model gpt-5.5  (optional second opinion)
```

## Command

```bash
node "$HOME/github/claude-worker-sdd/runner/dist/index.js" {{ARGUMENTS}}
```

