---
"sdd-worker": patch
---

Fix `sdd-worker guide` failing with "playbook not found" when installed globally via `npm install -g sdd-worker`. `docs/ORCHESTRATION.md` is now packaged as an asset and resolved through the same `assetPath` helper used for other shipped assets, instead of a relative path that assumed the monorepo's directory layout.
