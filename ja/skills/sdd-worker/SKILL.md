---
name: sdd-worker
description: ステータス、再試行、任意のセカンドオピニオンレビュー、エンジン/モデルのオーバーライドに使用する、エンジン非依存のワーカー制御コマンドです。
---

# SDD Worker

共有 SDD runner に関する操作制御に使用します。

## 使用方法

```text
/sdd-worker status                     per-task table + next pending task
/sdd-worker next [docs/plans/x.md]     dispatch first non-complete task (background!)
/sdd-worker set TASK-003 engine opencode
/sdd-worker set TASK-003 model gpt-5.6-sol
/sdd-worker accept TASK-003 --note "diff reviewed, correct"   mark failed task complete (instead of retry — never both)
/sdd-worker retry TASK-003 --engine codex --model gpt-5.6-luna [--net]
/sdd-worker review TASK-003 --engine codex --model gpt-5.6-sol  (optional second opinion)
/sdd-worker guide [<topic>]            print ONE playbook section on demand
/sdd-worker doctor                     engine CLI setup check (setup debugging only)
```

`progress.yaml` を読む代わりに `status` を使用してください。こちらのほうが低コストで、
次の保留中タスクもすでに算出されます。

タスク ID は `.sdd/current-plan.yaml` に記録されたアクティブなプラン
(最後の `run` によって設定)に対して解決されます。別のプランのタスクを対象にするには
`--plan <plan.md>` を渡してください。

## コマンド

```bash
sdd-worker {{ARGUMENTS}}
```

(`sdd-worker` はセットアップ時に `npm link` によって PATH に配置されます。見つからない場合は
`node <claude-worker-sdd repo>/runner/dist/index.js` にフォールバックしてください。)
