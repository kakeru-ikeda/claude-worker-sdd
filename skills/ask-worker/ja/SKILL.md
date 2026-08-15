---
name: ask-worker
description: 共有 YAML コントラクトを通じて、選択したワーカーエンジンに単発のスコープ限定タスクを委譲します。
---

# Ask Worker

Superpowers プランの一部ではない、スコープを限定した単発の調査、実装、または
シェル/Git 操作に使用します。

## 使用方法

```text
/ask-worker "implement the small fix from the current design"
/ask-worker --agent explorer --engine codex "map auth-related files"
```

## ルール

- 指示は自由記述のテキストとして渡します。runner は `.sdd/adhoc/` 以下にアドホックな
  1 タスクのプランを書き込み、その状態を `.sdd/plans/adhoc-<timestamp>/` 以下に
  自動的に分離します。
- エージェントロールは `sdd/agents/` から (`--agent`)、エンジンは
  `sdd/adapters/` から (`--engine`) 選択します。
- プランタスクと同様に、**バックグラウンドで**ディスパッチします
  (Bash `run_in_background: true`)。
- **ディスパッチしたらそのターンを終了してユーザーに返します。** ジョブの終了時に自動的に
  再度呼び出されます。`TaskOutput` のブロッキング呼び出し、`sleep` / `until` ループ、
  完了待ちのための Monitor は使わないでください。
- 完了通知を受け取ってから同じ成果物 `status.yaml`、`report.yaml`、`diff.patch` を
  読みます。
- ワーカーによるスコープ拡大や後続タスクのオーケストレーションを許可しないでください。

## コマンド

```bash
sdd-worker one-shot {{ARGUMENTS}}
```

(`sdd-worker` はセットアップ時に `npm link` によって PATH に配置されます。見つからない場合は
`node <claude-worker-sdd repo>/runner/dist/index.js` にフォールバックしてください。)
