---
name: ask-worker
description: Delegate a one-shot scoped task to a selected worker engine through the shared YAML contract.
---

# Ask Worker

Use for a single scoped investigation, implementation, or shell/Git operation that is
not part of a Superpowers plan.

## Usage

```text
/ask-worker "implement the small fix from the current design"
/ask-worker --agent explorer --engine codex "map auth-related files"
```

## Rules

- Pass the instruction as free text: the runner writes an ad-hoc one-task plan under
  `.superpowers/sdd/adhoc/` and isolates its state under
  `.superpowers/sdd/plans/adhoc-<timestamp>/` automatically.
- Pick the agent role from `sdd/agents/` (`--agent`), the engine from `sdd/adapters/`
  (`--engine`).
- Dispatch **in the background** (Bash `run_in_background: true`), same as plan tasks.
- Read the same artifacts afterwards: `status.yaml`, `report.yaml`, `diff.patch`.
- Do not let the worker expand scope or orchestrate follow-up tasks.

## Command

```bash
sdd-worker one-shot {{ARGUMENTS}}
```

(`sdd-worker` is put on PATH by `npm link` during setup; if missing, fall back to
`node <claude-worker-sdd repo>/runner/dist/index.js`.)
