# AGENTS.md - Setup Guide for Claude Code

This repository installs a Superpowers-centered SDD workflow that can dispatch task-scoped work to Codex, OpenCode, and future engines.

## What This Repo Provides

- `claude/CLAUDE.md` - Claude Code orchestration guidance (two-layer delegation, iron rules).
- `claude/agents/planner.md` - Opus-class plan-drafting subagent definition.
- `claude/hooks/` - SessionStart boundary injection + PreToolUse block of Superpowers' execution chain.
- `skills/ask-worker/SKILL.md` - one-shot worker delegation.
- `skills/worker-sdd/SKILL.md` - Superpowers SDD loop backed by the runner.
- `skills/sdd-worker/SKILL.md` - engine-neutral worker control commands.
- `sdd/agents/*.yaml` - engine-independent agent role contracts.
- `sdd/adapters/*.yaml` - engine capabilities and command templates.
- `sdd/schemas/*.schema.json` - YAML/JSON contract schemas (resolved from the runner install).
- `runner/` - TypeScript runner (`sdd-worker` CLI via `npm link`).
- `docs/ORCHESTRATION.md` - orchestration playbook, retrieved per-section via `sdd-worker guide`.

## Setup Instructions

The recommended setup is handled by the published `sdd-worker` CLI. It is
interactive and should be run once from a terminal:

```bash
npm install -g sdd-worker
sdd-worker setup
sdd-worker doctor
```

`setup` configures the adapters and per-agent models, optionally installs the
skills, Node-based hooks, planner agent, and managed `CLAUDE.md` section, then
checks the Codex CLI. A successful setup writes the user `Ready` marker. The
dispatch commands (`run`, `next`, `one-shot`, `retry`, and `review`) are gated until
that marker exists; `doctor` can refresh it after required checks pass.

On native Windows, run the same commands from PowerShell or Windows Terminal;
Git Bash is optional. Verification commands use `bash -lc` when `bash` is on
`PATH`, otherwise `cmd.exe /d /s /c`. WSL users should install Node.js and
`sdd-worker` inside WSL. Node.js 20+ is required on every platform.

`setup` requires a TTY. For CI or another non-interactive environment, set the
needed values explicitly and run the checks:

```bash
sdd-worker config set agents.executor.model gpt-5.6-luna
sdd-worker config set agents.executor.effort xhigh
sdd-worker doctor
```

User settings are stored at `~/.config/sdd-worker/config.yaml` on macOS/Linux/WSL
and at `%APPDATA%\sdd-worker\config.yaml` on native Windows. Project defaults
belong in `.sdd/config.yaml`; use `sdd-worker config set ... --project` to write
them. Effective values resolve in this order:

`CLI override > task.yaml > progress.yaml attempt record > project config > user config > shipped YAML defaults`.

Use `sdd-worker models [--engine codex] [--refresh]` to inspect the dynamic model
catalog. `sdd-worker doctor` also reports the cache source/freshness and Claude Code
asset state. Gemini is a future stub and is shown as unavailable by setup/doctor.

After setup, reload Claude Code skills in an already-running session:

```text
/reload-skills
```

### Manual fallback for a source checkout

Use this only when the package cannot be used or while developing the runner.
Existing files with the same names are managed by this repo and may be overwritten
after review.

#### Install Claude skills

```bash
for skill in skills/*/; do
  name=$(basename "$skill")
  mkdir -p "$HOME/.claude/skills/$name"
  cp "$skill/SKILL.md" "$HOME/.claude/skills/$name/SKILL.md"
  echo "Installed: $name"
done
```

#### Install the planner agent

```bash
mkdir -p ~/.claude/agents
cp claude/agents/planner.md ~/.claude/agents/planner.md
```

`planner` runs on an Opus-class model and drafts worker-ready plan documents
(per-task file lists, acceptance criteria, and verify commands).

#### Install Node-based hooks

The hooks are required when the Superpowers plugin is enabled. The SessionStart
hook prints the SDD boundary, and the `PreToolUse` hook blocks
`superpowers:executing-plans`, `using-git-worktrees`, and
`finishing-a-development-branch` so implementation goes through worker-sdd.

```bash
mkdir -p ~/.claude/hooks
cp claude/hooks/sdd-boundary.md \
  claude/hooks/deny-superpowers-exec.mjs \
  claude/hooks/print-sdd-boundary.mjs ~/.claude/hooks/
```

Merge these entries into `~/.claude/settings.json` without replacing unrelated
settings. The `node` commands work on native Windows too when paths are adjusted
to the Windows Claude directory:

```json
"hooks": {
  "SessionStart": [
    { "hooks": [ { "type": "command", "command": "node \"$HOME/.claude/hooks/print-sdd-boundary.mjs\"" } ] }
  ],
  "PreToolUse": [
    { "matcher": "Skill", "hooks": [ { "type": "command", "command": "node \"$HOME/.claude/hooks/deny-superpowers-exec.mjs\"" } ] }
  ]
}
```

#### Install or merge Claude guidance

Do not overwrite an existing `~/.claude/CLAUDE.md` automatically. If missing, copy it. If present, merge the sections manually.

```bash
if [ ! -f ~/.claude/CLAUDE.md ]; then
  cp claude/CLAUDE.md ~/.claude/CLAUDE.md
  echo "Installed CLAUDE.md"
else
  echo "~/.claude/CLAUDE.md already exists - merge claude/CLAUDE.md manually if needed"
fi
```

#### Install runner dependencies and expose the CLI

```bash
cd runner
npm install
npm run build
npm link          # puts the `sdd-worker` bin on PATH
sdd-worker setup
```

## Engine Notes

Codex is the default engine for new tasks unless the task or CLI override selects another engine. OpenCode is supported through an adapter to preserve the current operating model. Gemini CLI is included as a future adapter stub.
