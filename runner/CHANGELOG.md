# sdd-worker

## 0.4.0

### Minor Changes

- d96a608: `setup --lang ja` now installs Japanese translations of the distributed Claude Code assets (SKILL.md files, the planner agent definition, the SDD boundary hook document, and the CLAUDE.md template), not just localized CLI prompts. English remains the default and the fallback when a Japanese asset is missing.

## 0.3.0

### Minor Changes

- Add changesets-based version management and English-first i18n: `setup` and `doctor` now output English by default, with `--lang ja` for Japanese.
