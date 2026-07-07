# Orchestration Playbook

Audience: the orchestrating model (Claude Code). This document encodes operating
knowledge so that orchestration quality does not depend on the model tier.

**This is a reference, not required reading.** Do not load it wholesale into a
session: the runner prints the next action after every run, and one section at a time
can be retrieved with `sdd-worker guide <topic>` (`sdd-worker guide` lists topics).
Follow the recipes literally; they are designed to minimize context/token consumption
and to make every decision observable from small YAML artifacts instead of large
streams.

Principle: **the runner enforces mechanics; you spend tokens only on judgment**
(plan fit, diff review, retry-vs-fix decisions). If you find yourself re-implementing
bookkeeping the runner already does, stop.

## 1. What the runner guarantees (do not re-verify)

- Per-plan state isolation under `.superpowers/sdd/plans/<plan-slug>/`. A new plan
  always starts at TASK-001. Never number tasks by looking at another plan's progress.
- `--task` beyond the plan's task count is rejected. If you hit this error, your task
  numbering is wrong — re-read the plan, do not `--force`.
- One run per plan at a time (`.lock`, stale-safe). A refused dispatch means one is
  still running: wait for the background job notification instead of retrying.
- `complete` in progress.yaml means: engine exit 0 **and** report.yaml present with
  status DONE / DONE_WITH_CONCERNS. Exit code alone is never trusted.
- `diff.patch` (worktree vs HEAD) and `untracked_files` are captured automatically
  after every run; `base_commit` is recorded on first dispatch.
- Legacy flat layouts are migrated automatically; adapter crashes are converted to
  `failed` attempts (tasks are never left stuck in `running`).
- **Engine availability**: never preflight (`which codex` etc.). A missing binary
  fails fast with `failure_reason: engine binary not found` plus a hint;
  `sdd-worker doctor` is for setup debugging only.
- **Executable acceptance**: pass `--verify '<command>'` on the first dispatch and it
  persists as the plan default — every task (and retry) only reaches `complete` if the
  command exits 0 after the engine run. Output goes to `attempts/<N>/verify.log`.
  Always set this when the repo has tests (`--verify 'npm test'` or equivalent);
  it converts diff-review judgment into mechanics.

## 2. The dispatch loop

```bash
# `sdd-worker` is on PATH via `npm link` (AGENTS.md setup). Fallback:
# node <claude-worker-sdd repo>/runner/dist/index.js

# 0. First dispatch of a plan: set the executable acceptance gate once
sdd-worker next docs/plans/<feature>.md --verify 'npm test'   # persists for all later tasks

# 1. Dispatch next task — ALWAYS as a background shell job (run_in_background: true)
sdd-worker next docs/plans/<feature>.md            # picks first non-complete task

# 2. While it runs: do other work. Do NOT poll in a loop; the background job
#    re-invokes you on exit. One tail of the stream is acceptable for a health check.

# 3. On completion, read exactly these (in order, stop as soon as you can decide):
#    - .superpowers/sdd/plans/<slug>/tasks/task-N/status.yaml   (~15 lines: verdict + failure_reason)
#    - .superpowers/sdd/plans/<slug>/tasks/task-N/report.yaml   (worker's claim)
#    - .superpowers/sdd/plans/<slug>/tasks/task-N/diff.patch    (the truth — review vs plan)

# 4. Accept → commit (see §4) → loop to step 1.
#    Reject → triage (see §5).

# 5. Terminate when `sdd-worker next` prints "all N tasks complete", then run the plan's
#    final verification (tests + build) once, directly.
```

`sdd-worker status` prints the whole plan state in ~N lines. Use it instead of reading
`progress.yaml`.

For a single scoped job outside a plan:

```bash
sdd-worker one-shot "map the auth-related files and list entry points" --agent explorer
```

### Direct-edit exception

Dispatch has a fixed cost (brief, engine spin-up, report/diff review, commit). Skip
the worker and edit directly when **all** of these hold:

- ≤ 2 files and ≤ ~30 changed lines,
- you can specify the exact change without exploration,
- the plan's verify command exists and you run it after editing.

Then commit as usual (one commit, noted as orchestrator-direct). When in doubt — or
when the constraint is conserving *orchestrator* tokens specifically — dispatch anyway.

## 3. Token budget rules

| Artifact | Read? | Notes |
|---|---|---|
| `status.yaml` | always | smallest signal: verdict + failure_reason |
| `report.yaml` | always | worker's claim; verify against diff |
| `diff.patch` | always | the only ground truth; review this, not the files |
| `sdd-worker status` output | when resuming / lost | replaces reading progress.yaml |
| `verify.log` | only when `failure_reason` says verify failed | `tail -n 50` first |
| `stdout.jsonl` | only on failure | `tail -n 50` max; never read whole file (can be MBs) |
| `final.md` | only if report missing | fallback narrative |
| `brief.md`, `task.yaml`, `dispatch.yaml` | never | you (via the runner) wrote them |
| changed source files | only if diff is ambiguous | prefer diff.patch |

Further rules:

- Delegate multi-file code investigation to a read-only worker (`--agent explorer`) or
  a read-only subagent; keep orchestrator context for decisions. Read-only dispatches
  may run in parallel with the executor.
- Do not re-read files you already have in context; do not re-verify what §1 guarantees.
- Keep your own summaries short; the artifacts are the record, not your prose.
- When relaying results to the user: verdict + deviations from plan + next action.
  Do not paste report/diff contents unless asked.

## 4. Commit protocol

- Engine sandboxes (codex `workspace-write`) cannot write `.git` — **the orchestrator
  commits**, one commit per accepted task, before dispatching the next task. Never let
  two tasks' changes mix in the worktree.
- Check `untracked_files` in status.yaml: engines create files that `git diff HEAD`
  does not show. `git add` them deliberately, never `git add -A` blindly
  (`.superpowers/` is gitignored but adapters may drop stray files).
- If the diff contains unrelated reformatting (engines sometimes re-indent whole
  files), either reject with a constraint ("do not reformat untouched lines") or
  accept explicitly and note it — never silently.

## 5. Failure triage (in order)

Read `status.yaml:failure_reason` first; it discriminates the cases:

1. **`engine exited N`** — engine/CLI-level failure. `tail -n 50` of
   `attempts/<latest>/stdout.jsonl`: auth error / missing binary / rate limit → fix
   environment, `sdd-worker retry TASK-N`. Model confusion → retry once on a stronger model:
   `sdd-worker retry TASK-N --model <stronger>`.
2. **`report.yaml was not written`** — engine finished but broke the contract.
   Retry once (the dispatch already says to write it). Second failure → switch engine
   or escalate to the user.
3. **`report status is BLOCKED / NEEDS_CONTEXT`** — the worker has a question. Read
   `report.yaml:concerns`, answer it by amending the task constraints (edit the task's
   `task.yaml` or the plan), then `sdd-worker retry TASK-N`. Do not retry unchanged.
4. **`verify failed (exit N)`** — engine claims DONE but the acceptance command
   disagrees. `tail -n 50` of `attempts/<latest>/verify.log`; retry with the failing
   output appended as a constraint, or fix directly if trivial (§ Direct-edit).
   Trust the verify command over the report, always.
5. **Report says DONE but diff is wrong** — plan mismatch. Decide by size:
   - trivial (≤ ~5 lines): fix directly yourself, note it, commit.
   - substantial: `sdd-worker retry TASK-N` after appending explicit corrective constraints.
6. **Tests fail after an accepted task** — the acceptance was wrong, not the next
   task. `git diff` against the last good commit; revert or fix before dispatching
   anything else.

Retry budget: 2 retries per task, then stop and report to the user with the
failure_reason and your hypothesis. Burning attempts without changing anything
(engine, model, constraints) is the classic weak-orchestrator failure mode.

## 6. Review policy

- Claude Code reviews every task itself (diff vs plan acceptance criteria). This is
  the default and is not optional.
- `sdd-worker review TASK-N` (worker second opinion) only for: security-sensitive changes,
  changes the orchestrator cannot judge (unfamiliar domain), or when the user asks.
- `reviewed: true` in progress means a review artifact exists — it does not mean the
  task is good. Your acceptance decision is separate.

## 7. Engine and model selection

Priority: `CLI override > task.yaml > progress.yaml attempt record > project defaults > adapter defaults`.

- Default: `codex` executor. Switch per user instruction (reflect it in the task via
  `sdd-worker set TASK-N engine|model <value>`).
- Escalate model, not engine, on capability failures; switch engine on tooling/CLI
  failures.
- `gemini` is a stub: dispatching it always fails (useful only for dry-testing the
  runner).

## 8. Plan quality and design delegation

Plan quality dominates every downstream outcome; rails cannot rescue a vague plan.
Spend tokens disproportionately at the plan stage:

- Run the Explorer → Thinker pipeline before writing the plan.
- Delegate design/plan drafting to the strongest available model via a Claude Code
  subagent (see `claude/agents/planner.md`, `model: opus`). Planning tokens are paid
  once; implementation cost multiplies by plan quality. Feed the subagent the
  explorer's findings — it starts with no conversation context.
- Every plan task must state: files to touch, files NOT to touch, acceptance
  criteria, and the verify command. A task the orchestrator cannot check mechanically
  is not ready to dispatch.
- Briefs inherit plan precision. The Claude → YAML → engine chain loses intent at
  each hop; exact file paths and signatures in the plan are what survive.

## 9. Known incidents (why these rules exist)

- **2026-07 second-plan collision**: flat `.superpowers/sdd/` state made plan #2
  inherit plan #1's nine completed tasks; the orchestrator filed new work as
  "Task 10". Fixed by per-plan slug dirs + task-count validation. Lesson: never infer
  task numbering from stored progress — the plan file is the source of truth.
- **2026-07 formatting drift**: an engine re-indented App.tsx from 4-space to 2-space
  while doing scoped work. Lesson: §4 unrelated-reformatting rule.
- **exit-0-without-report**: engines can exit 0 having done nothing. Lesson: report
  validation in the runner; never trust exit codes.
- **`.git` write denial**: codex sandbox cannot commit. Lesson: §4 orchestrator-commits
  protocol.
