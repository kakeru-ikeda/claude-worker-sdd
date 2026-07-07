# Claude Code SDD Configuration

Claude Code is the orchestrator: it owns requirements, plans, diff review, commits,
and user-facing decisions. Implementation work is dispatched to external worker
engines via the `sdd-worker` CLI (installed on PATH by `npm link`; see the
claude-worker-sdd repo's AGENTS.md). The runner enforces the mechanics — per-plan
state, task numbering, locking, verify gates — and **prints the next action after
every run: follow those printed hints.** Details are retrieved on demand with
`sdd-worker guide <topic>` (run `sdd-worker guide` to list topics); never load the
whole playbook into context.

## Two delegation layers — do not confuse them

**Layer 1: Claude Code subagents** (native Agent tool, Claude models, spends your
context budget):

- `planner` — drafts plan documents on an Opus-class model. Use for any non-trivial
  design. It starts with zero conversation context: always pass it the explorer
  findings and the user's requirements explicitly.
- Built-in read-only agents (Explore) — one-off codebase questions only.

**Layer 2: worker roles** (external engines via `sdd-worker`, separate token budget,
prefer for anything scoped):

- `executor` — implementation and fixes
- `explorer` — read-only code investigation (default choice for mapping code)
- `thinker` — read-only critique of an existing design or plan
- `reviewer` — optional second-opinion diff review (rarely needed)
- `test-writer` — TDD red phase, test files only
- `operator` — shell/Git operations

Design pipeline: worker `explorer` maps the code → `planner` subagent drafts the plan
→ optionally worker `thinker` critiques the draft → the user approves. Authoring
plans = planner (Layer 1). Critique and code reading = workers (Layer 2). Final
decisions never leave Claude Code.

## Iron rules

1. Dispatch `sdd-worker run|next|one-shot` **in the background**
   (`run_in_background: true`). A lock-refusal error means wait, not retry.
2. First dispatch of a plan: set `--verify '<test command>'`. Completion is gated on
   it for every task.
3. Engines cannot write `.git`: the orchestrator commits — one commit per accepted
   task, before the next dispatch.
4. After a run, read only `status.yaml` → `report.yaml` → `diff.patch`. Never a full
   `stdout.jsonl` (tail ≤ 50 lines, and only when triaging a failure).
5. Max 2 retries per task, and never retry without changing something (constraints,
   model, or engine).
6. Direct-edit exception: ≤ 2 files, ≤ ~30 lines, exactly specifiable without
   exploration → edit it yourself, run verify, commit. Everything larger goes
   through a worker.
7. Never preflight engines (`which codex`, `codex --version`, …) before a dispatch —
   dispatch directly. A missing binary fails in under a second with a
   "binary not found" reason and a hint. `sdd-worker doctor` exists for setup
   debugging only, not as a per-session ritual.

## Engine switching

The user can switch engines/models in natural language
(`TASK-003だけOpenCodeに倒して`, `軽い実装はgpt-5.4で`) — apply with
`sdd-worker set TASK-N engine|model <value>`. Priority:

```text
CLI override > task.yaml > progress.yaml attempt record > project defaults > adapter defaults
```
