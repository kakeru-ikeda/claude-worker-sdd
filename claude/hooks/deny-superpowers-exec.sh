#!/usr/bin/env bash
# PreToolUse hook (matcher: Skill): blocks Superpowers' native implementation
# chain so plan execution can only go through worker-sdd. Exit 2 = deny, with
# the redirect reason fed back to the model on stderr.
input=$(cat)
skill=$(printf '%s' "$input" | jq -r '.tool_input.skill // empty' 2>/dev/null)

case "$skill" in
  superpowers:executing-plans|superpowers:using-git-worktrees|superpowers:finishing-a-development-branch)
    echo "BLOCKED on this machine: '$skill' is replaced by worker-SDD. Implement an approved plan by invoking the 'worker-sdd' skill: run 'sdd-worker next <plan.md> --verify \"<test cmd>\"' as a background job (run_in_background: true), then follow the runner's printed hints. The orchestrator reviews diff.patch and commits." >&2
    exit 2
    ;;
esac
exit 0
