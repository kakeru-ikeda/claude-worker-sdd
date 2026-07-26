<SDD-BOUNDARY priority="user-override">
This machine runs worker-SDD. These are explicit user instructions and take
precedence over skill workflows (superpowers:using-superpowers honors this).

1. `superpowers:brainstorming` = requirements Q&A with the user ONLY. Never
   cat/Read whole source files into your own context while brainstorming —
   dispatch Agent(Explore) or `sdd-worker one-shot "..." --agent explorer`
   and read the returned summary instead.
2. Design documents and plans are WRITTEN TO DISK by the `planner` subagent
   (Agent tool, Opus-class) — it saves docs/plans/<date>-<slug>.md itself and
   returns only the path + task list. Feed it the explorer summary and the
   user's answers. Never write the design/plan yourself, inline or as a file;
   review the returned task list with the user, then dispatch.
3. Once a plan document exists, implementation goes through the `worker-sdd`
   skill ONLY: `sdd-worker next <plan.md> --verify '<test cmd>'` as a
   background job. `superpowers:executing-plans`,
   `superpowers:using-git-worktrees`, and
   `superpowers:finishing-a-development-branch` are blocked by hook on this
   machine — do not attempt them.
4. After every run, follow the runner's printed hints. The orchestrator
   reviews diff.patch against the plan and commits (one commit per task).
</SDD-BOUNDARY>
