#!/usr/bin/env node

const blockedSkills = new Set([
  "superpowers:executing-plans",
  "superpowers:using-git-worktrees",
  "superpowers:finishing-a-development-branch",
]);

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
}

let skill;
try {
  const parsed = JSON.parse(input);
  skill = parsed?.tool_input?.skill;
} catch {
  skill = undefined;
}

if (typeof skill === "string" && blockedSkills.has(skill)) {
  process.stderr.write(
    `BLOCKED on this machine: '${skill}' is replaced by worker-SDD. Implement an approved plan by invoking the 'worker-sdd' skill: run 'sdd-worker next <plan.md> --verify "<test cmd>"' as a background job (run_in_background: true), then follow the runner's printed hints. The orchestrator reviews diff.patch and commits.\n`,
  );
  process.exitCode = 2;
}
