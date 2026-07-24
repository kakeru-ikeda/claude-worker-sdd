---
name: worker-sdd
description: 承認済みの Superpowers プランを外部ワーカーエンジン (デフォルトは Codex、OpenCode も対応) で実行します。プラン文書が存在し、実装を開始する場合は必ず使用してください。これは実装用の superpowers:executing-plans および git-worktree サブエージェントフローを置き換えます。
---

# Worker SDD

`/superpowers:writing-plans` がプランを生成した後に使用します。

**このスキルは `superpowers:executing-plans` を置き換えます。** 汎用サブエージェント、
`superpowers:using-git-worktrees`、または
`superpowers:finishing-a-development-branch` でプランタスクを実装しないでください。
実装は以下の runner を通じてワーカーエンジンへディスパッチし、オーケストレーターは
レビューとコミットのみを行います。

## 使用方法

```text
/worker-sdd docs/plans/<feature>.md
```

任意のオーバーライド:

```text
/worker-sdd docs/plans/<feature>.md --engine codex --model gpt-5.6-luna
/worker-sdd docs/plans/<feature>.md --task TASK-003 --engine opencode
```

## ワークフロー

runner は実行のたびに (成功時および各失敗分類時に) 次のアクションを表示します。
その案内に従ってください。より詳しいルールが必要な場合は、オンデマンドでプレイブックの
1 セクションだけを取得してください。`sdd-worker guide` はトピックを一覧表示し、
`sdd-worker guide triage|commit|tokens|...` は 1 セクションを表示します。
プレイブック全体をコンテキストに読み込まないでください。

runner のすべての状態は、プランごとに `.sdd/plans/<plan-slug>/` 以下で名前空間が
分けられます (`slug` = `.md` を除いたプランのファイル名)。新しいプランは常に、
空の進捗ファイルと TASK-001 から開始します。別のプランの進捗から番号を継続しては
なりません。runner はプランのタスク数を超えるタスク ID を拒否します。
最初の実行時に、runner は既存の旧 Superpowers 状態ツリーを `.sdd` へ一度だけ
自動移行します。`.superpowers/` に他の内容が含まれる場合は、そのまま残されます。

ループ (runner が brief、task.yaml、dispatch.yaml、進捗更新、diff 取得、
report 検証、単一実行ロックのすべての記録管理を行います):

0. プランの最初のディスパッチ前に、実行可能な受け入れゲートを一度設定します。
   `next <plan.md> --verify '<test command>'` — 設定は永続化され、すべてのタスクの
   完了を判定します (`complete` には終了コード 0 + report DONE + verify 成功が必要)。
   `npm test`、`bundle exec rspec`、`mvn -q test`、`pytest`、`cargo test`、
   `go test ./...` など、プロジェクト固有のツールチェーンを使用してください。
   直接編集の例外: 変更が 2 ファイル以下 / 約 30 行以下で、内容を正確に指定できる場合は、
   ディスパッチするより自分で編集するほうが低コストです (その後 verify を実行し、コミット)。
1. タスクをディスパッチする前に、その "New dependencies" 行に記載されたパッケージを、
   プロジェクト固有のパッケージマネージャー (npm/pnpm、bundler、maven/
   gradle、pip/uv、cargo、go mod、...) でインストールします。ワーカーはネットワークを
   使用できません。外部ネットワークが本当に必要なタスク (外部 API へのアクセスなど) では、
   そのディスパッチだけに `--net` を追加してください。FS/.git の保護は維持されます。
2. **バックグラウンドで**ディスパッチします (下記参照)。最初の未完了タスクを選択する
   `next <plan.md>` を優先し、オーバーライドする場合のみ
   `run <plan.md> --task TASK-N` を使用します。
3. 実行中もオーケストレーションを続けます。ループでポーリングしないでください。
   バックグラウンドジョブは終了時にあなたを再度呼び出します。
4. 完了時は `status.yaml` (判定 + `failure_reason`)、`report.yaml`、`diff.patch` の
   順に読みます。トリアージ時を除き、それ以外は読みません (トリアージ時は最新の
   `attempts/*/stdout.jsonl` または `verify.log` の末尾 50 行)。
5. プランの受け入れ基準に照らして、自分で diff をレビューします。任意:
   リスクの高い変更に限り、セカンドオピニオンとして `sdd-worker review` を使用します。
6. 受け入れ → オーケストレーターがタスクごとに 1 コミットを作成します
   (エンジンのサンドボックスは `.git` に書き込めません)。
   `status.yaml` に記載された `untracked_files` も含め、その後ループします。
   report の形式だけが原因でタスクが失敗したものの、diff が正しく verify も成功した場合は、
   再実行の代わりに `sdd-worker accept TASK-N --note "..."` を使用します。
7. 失敗 → runner がすでに表示した失敗分類固有の案内に従います
   (詳細: `sdd-worker guide triage`)。タスクごとの再試行は最大 2 回とし、
   何か (制約、モデル、またはエンジン) を変更せずに再試行してはなりません。
   受け入れか再試行のどちらか一方にし、両方は行わないでください。
8. `next` が "all N tasks complete" と表示したら停止し、プランの最終検証
   (テスト + ビルド) を直接 1 回実行します。

タスク成果物を `.sdd/` 直下へ直接書き込んではなりません。runner は次回の呼び出し時に、
旧フラットレイアウトを `plans/<slug>/` へ自動移行します。

## ディスパッチ (ノンブロッキング)

runner はエンジン (例: `codex exec`) を起動し、内部で終了を待ちます。1 回の
`codex exec` 実行には数分かかることがあります。**フォアグラウンドでは絶対に実行しないで
ください。** オーケストレーターが停止し、他の作業を進められなくなります。
バックグラウンドのシェルジョブとして実行し、完了するまでタスク成果物をポーリングします。
これは前身が使用していたものと同じモデルです。

エンジン CLI の事前確認 (`which codex` など) は行わず、直接ディスパッチしてください。
バイナリが見つからない場合は "binary not found" の理由と復旧案内を伴ってすぐに失敗します。

このコマンドを**バックグラウンド**ジョブとして実行します
(Bash ツール `run_in_background: true`):

```bash
sdd-worker run {{ARGUMENTS}}
```

(`sdd-worker` はセットアップ時に `npm link` によって PATH に配置されます。見つからない場合は
`node <claude-worker-sdd repo>/runner/dist/index.js` にフォールバックしてください。)

runner はエンジンの実行前後に進捗を記録するため、成果物から完了を確認できます
(リポジトリルートからの相対パス。`<plan>` = `plans/<plan-slug>/`、
`task-N` = `tasks/task-<index>/`):

- `.sdd/<plan>/progress.yaml` — タスクの `status: running` が `complete` | `failed` へ
  変わります (`complete` = エンジン終了コード 0 + report DONE 相当 + verify コマンド成功)
- `.sdd/<plan>/tasks/task-N/status.yaml` — 判定、`exit_code`、`report_status` (正規化済み)、
  `verify_exit`、`failure_reason`、`untracked_files`
- `.sdd/<plan>/tasks/task-N/diff.patch` — HEAD に対する worktree の diff を自動取得。
  ファイルではなく、これをレビューしてください
- `.sdd/<plan>/tasks/task-N/report.yaml` — ワーカーの report (必須出力)
- `.sdd/<plan>/tasks/task-N/attempts/<NNN-engine-model>/stdout.jsonl` — エンジンの
  ライブストリーム (量が膨大になる可能性があるため、末尾だけを控えめに確認)

バックグラウンドジョブの実行中、オーケストレーターは自由に次のことを行えます。
ユーザーへの回答、読み取り専用エージェント (`explorer` / `thinker` / `reviewer`) の
並列ディスパッチ、`stdout.jsonl` の末尾を確認するモニタリングです。
バックグラウンドジョブの終了時に自動的に再度呼び出されます。そうでなければ
`status.yaml` / `progress.yaml` をポーリングしてください。その後 `report.yaml` と
diff を読み、レビューします。

**一度に 1 つの executor:** 1 つの実行中に、同じ worktree に対して 2 つ目の
`executor` ディスパッチをバックグラウンドで行わないでください (git の競合)。
runner はプランごとのロックでこれを強制します。"another run is active" エラーは
再試行ではなく待機を意味します。読み取り専用ディスパッチは並行実行できます。
