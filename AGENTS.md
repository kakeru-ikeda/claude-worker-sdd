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

### Step 1: Install Claude skills

Copy skills into `~/.claude/skills/`. Existing files with the same names are managed by this repo and may be overwritten after review.

```bash
for skill in skills/*/; do
  name=$(basename "$skill")
  mkdir -p "$HOME/.claude/skills/$name"
  cp "$skill/SKILL.md" "$HOME/.claude/skills/$name/SKILL.md"
  echo "Installed: $name"
done
```

### Step 1b: Install subagents (optional, recommended)

```bash
mkdir -p ~/.claude/agents
cp claude/agents/planner.md ~/.claude/agents/planner.md
```

`planner` runs on an Opus-class model and drafts worker-ready plan documents
(per-task file lists, acceptance criteria, verify commands).

### Step 1c: Install hooks (required when the Superpowers plugin is enabled)

Static CLAUDE.md prose loses to Superpowers' hook-injected skill chain on weaker
models; these hooks fight at the same layer. `sdd-boundary.md` is injected as
context at every session start, and the PreToolUse script mechanically blocks
`superpowers:executing-plans` / `using-git-worktrees` /
`finishing-a-development-branch` so implementation can only go through worker-sdd.

```bash
mkdir -p ~/.claude/hooks
cp claude/hooks/sdd-boundary.md claude/hooks/deny-superpowers-exec.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/deny-superpowers-exec.sh
```

Then merge into `~/.claude/settings.json`:

```json
"hooks": {
  "SessionStart": [
    { "hooks": [ { "type": "command", "command": "cat \"$HOME/.claude/hooks/sdd-boundary.md\"" } ] }
  ],
  "PreToolUse": [
    { "matcher": "Skill", "hooks": [ { "type": "command", "command": "\"$HOME/.claude/hooks/deny-superpowers-exec.sh\"" } ] }
  ]
}
```

### Step 2: Install or merge Claude guidance

Do not overwrite an existing `~/.claude/CLAUDE.md` automatically. If missing, copy it. If present, merge the sections manually.

```bash
if [ ! -f ~/.claude/CLAUDE.md ]; then
  cp claude/CLAUDE.md ~/.claude/CLAUDE.md
  echo "Installed CLAUDE.md"
else
  echo "~/.claude/CLAUDE.md already exists - merge claude/CLAUDE.md manually if needed"
fi
```

### Step 3: Install runner dependencies and expose the CLI

```bash
cd runner
npm install
npm run build
npm link          # puts `sdd-worker` on PATH — skills and CLAUDE.md reference it by name
```

### Step 4: Reload Claude skills

```text
/reload-skills
```

## Engine Notes

Codex is the default engine for new tasks unless the task or CLI override selects another engine. OpenCode is supported through an adapter to preserve the current operating model. Gemini CLI is included as a future adapter stub.

