---
"sdd-worker": patch
---

`sdd-worker setup` now lets you explicitly choose the model for the `planner` Claude Code subagent (fable/opus/sonnet/haiku or a custom name), stored as `planner.model` in the user config and written into the installed `planner.md` agent's `model:` frontmatter. Previously the planner's model selection relied on an implicit "Fable if available, else fall back" prompt-controlled behavior described only in CLAUDE.md.
