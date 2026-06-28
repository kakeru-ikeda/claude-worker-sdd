---
name: ask-worker
description: Delegate a one-shot scoped task to a selected worker engine through the shared YAML contract.
---

# Ask Worker

Use for a single scoped investigation, implementation, review, or shell/Git operation.

## Usage

```text
/ask-worker "implement the small fix from the current design"
/ask-worker --agent explorer --engine codex "map auth-related files"
/ask-worker --agent reviewer --engine opencode "review the current diff"
```

## Rules

- Write a task-specific YAML spec before dispatch.
- Pick the agent role from `sdd/agents/`.
- Pick the engine from `sdd/adapters/`.
- Store artifacts under `.superpowers/sdd/tasks/<task-id>/`.
- Do not let the worker expand scope or orchestrate follow-up tasks.

## Command

```bash
node "$HOME/github/claude-worker-sdd/runner/dist/index.js" one-shot {{ARGUMENTS}}
```

