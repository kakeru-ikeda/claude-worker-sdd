# AGENTS.md - Setup Guide for Claude Code

This repository installs a Superpowers-centered SDD workflow that can dispatch task-scoped work to Codex, OpenCode, and future engines.

## What This Repo Provides

- `claude/CLAUDE.md` - Claude Code orchestration guidance.
- `skills/ask-worker/SKILL.md` - one-shot worker delegation.
- `skills/worker-sdd/SKILL.md` - Superpowers SDD loop backed by `sdd-runner`.
- `skills/sdd-worker/SKILL.md` - engine-neutral worker commands.
- `sdd/agents/*.yaml` - engine-independent agent role contracts.
- `sdd/adapters/*.yaml` - engine capabilities and command templates.
- `sdd/schemas/*.schema.json` - YAML/JSON contract schemas.
- `runner/` - TypeScript runner.

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

### Step 3: Install runner dependencies

```bash
cd runner
npm install
npm run build
```

### Step 4: Reload Claude skills

```text
/reload-skills
```

## Engine Notes

Codex is the default engine for new tasks unless the task or CLI override selects another engine. OpenCode is supported through an adapter to preserve the current operating model. Gemini CLI is included as a future adapter stub.

