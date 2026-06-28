# claude-worker-sdd

Claude Codeをオーケストレーター、外部CLIエージェントをsubagent workerとして使うSuperpowers SDDワークフロー。

## Core idea

Superpowers is the source of truth for design and planning.

```text
Claude Code
  -> /superpowers:writing-plans
  -> docs/design/*.md + docs/plans/*.md
  -> sdd-runner
  -> engine adapter: codex | opencode | gemini future
  -> task report YAML
  -> Claude review / next task
```

Claude Code owns requirements, design, task orchestration, review decisions, and user-facing judgment.
Worker engines execute scoped tasks only. Claude Code performs the standard task review; worker review is optional second opinion only.

## Non-goals

- Replace Superpowers.
- Make worker engines orchestrate the project.
- Use SQLite/agmsg for the MVP.
- Require any communication-compression skill.
- Require Gemini CLI today.

## Artifact layout

Task artifacts are always isolated in per-task directories to avoid second-run collisions.

```text
.superpowers/sdd/
  progress.yaml
  tasks/
    task-001/
      task.yaml
      brief.md
      dispatch.yaml
      report.yaml
      status.yaml
      stdout.jsonl
      diff.patch
      attempts/
        001-codex-gpt-5.4/
```

YAML is the agent-to-agent contract. Markdown is reserved for Superpowers plans, task briefs, and long human-facing notes.

## Engine switching

Each task can select its engine and model.

```yaml
engine:
  name: codex
  runner: exec
  model: gpt-5.4
```

OpenCode can be selected without changing task shape:

```yaml
engine:
  name: opencode
  runner: run
  agent: executor
  model: null
```

Gemini is included as a future adapter stub.

## Runner

The TypeScript runner lives in `runner/`.

```bash
cd runner
npm install
npm run build
node dist/index.js run docs/plans/example.md
```

The runner defaults to direct checkout writes. Use `worktree.enabled: true` in a task/default config when parallel write execution is needed.

