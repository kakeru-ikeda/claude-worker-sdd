# Claude Code SDD Configuration

## Development Workflow

For implementation tasks, use this flow:

1. Clarify requirements and ask the user when intent or constraints are ambiguous.
2. Use `/superpowers:writing-plans` to create design and implementation plan documents.
3. Treat the Superpowers plan as the source of truth.
4. Dispatch scoped implementation work through `worker-sdd` or `sdd-worker`.
5. Review reports, diffs, and acceptance results before moving to the next task.

## Worker Integration

Claude Code is the orchestrator. Worker engines are subagents.

Supported engine targets:

| Engine | Status | Use |
|---|---|---|
| `codex` | primary | Default implementation, exploration, and fixes |
| `opencode` | supported | Compatibility with the existing OpenCode SDD workflow |
| `gemini` | future | Stub adapter, not implemented |

## Agent Roster

| Agent | When to use |
|---|---|
| `executor` | Implementation and bug fixes |
| `reviewer` | Optional read-only second-opinion review |
| `thinker` | Read-only design critique, alternative approaches, risk analysis |
| `test-writer` | TDD red phase, test files only |
| `operator` | Shell/Git operations only |
| `explorer` | Read-only code investigation and structure mapping |

Design, planning, and final decisions stay with Claude Code.

## Delegation Rules

Code investigation should normally be delegated to `explorer` so Claude Code preserves context for orchestration. Minimal direct checks are acceptable when validating worker output or when the user explicitly asks Claude Code to inspect something directly.

Use the Explorer to Thinker pipeline when design needs code context:

1. Ask `explorer` to map the relevant code.
2. Pass the findings to `thinker`.
3. Use Thinker's analysis to finalize the Superpowers plan.

Read-only agents may run in parallel. Write-capable `executor` tasks run one at a time unless `worktree.enabled: true`.

## Non-Blocking Dispatch

The worker runner spawns the engine (e.g. `codex exec`) and waits for it internally; a run can take many minutes. **Always dispatch the runner as a background shell job** (Bash `run_in_background: true`) — never in the foreground, or the orchestrator stalls and other work cannot proceed. This mirrors the predecessor, where the worker ran as a detached process and Claude Code only watched its artifacts.

While a dispatch runs in the background:

- The orchestrator stays free: answer the user, run read-only agents (`explorer` / `thinker` / `reviewer`) in parallel, and tail the engine stream to monitor.
- Completion is observed from artifacts, not by blocking: `progress.yaml` flips `running` → `complete`/`failed`, and `tasks/task-N/status.yaml` carries the `exit_code`. The background job also re-invokes you on exit.
- Still one `executor` at a time per worktree — background does not relax the single-writer rule.

## Engine Switching

The user can switch engines/models in natural language, for example:

- `TASK-003だけOpenCodeに倒して`
- `軽い実装はgpt-5.4で`

Reflect those choices in the task YAML. Priority:

```text
CLI override > task.yaml > progress.yaml attempt record > project defaults > adapter defaults
```

