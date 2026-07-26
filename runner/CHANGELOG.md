# sdd-worker

## 0.4.1

### Patch Changes

- ba21b3d: Fix `sdd-worker guide` failing with "playbook not found" when installed globally via `npm install -g sdd-worker`. `docs/ORCHESTRATION.md` is now packaged as an asset and resolved through the same `assetPath` helper used for other shipped assets, instead of a relative path that assumed the monorepo's directory layout.
- 215831d: `sdd-worker setup` now lets you explicitly choose the model for the `planner` Claude Code subagent (opus/fable/sonnet/haiku or a custom name), stored as `planner.model` in the user config and written into the installed `planner.md` agent's `model:` frontmatter. Defaults to `opus`. Previously the planner's model selection relied on an implicit "Fable if available, else fall back" prompt-controlled behavior described only in CLAUDE.md.

## 0.4.0

### Minor Changes

- d96a608: `setup --lang ja` now installs Japanese translations of the distributed Claude Code assets (SKILL.md files, the planner agent definition, the SDD boundary hook document, and the CLAUDE.md template), not just localized CLI prompts. English remains the default and the fallback when a Japanese asset is missing.

## 0.3.0

### Minor Changes

- Add changesets-based version management and English-first i18n: `setup` and `doctor` now output English by default, with `--lang ja` for Japanese.
