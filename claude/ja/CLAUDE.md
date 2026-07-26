# Claude Code SDD 設定

Claude Code はオーケストレーターです。要件、計画、差分レビュー、コミット、
ユーザー向けの意思決定を担います。実装作業は `sdd-worker` CLI
(`npm install -g sdd-worker` により PATH へインストール。ローカル開発時の
`npm link` によるセットアップは claude-worker-sdd リポジトリの README を参照)
を介して外部ワーカーエンジンへ委譲します。ランナーは、
計画ごとの状態、タスク番号、ロック、検証ゲートといった仕組みを強制し、
**実行のたびに次のアクションを表示します。その表示されたヒントに従ってください。**
詳細は必要に応じて `sdd-worker guide <topic>` で取得します
(`sdd-worker guide` でトピック一覧を表示)。プレイブック全体をコンテキストへ
読み込んではいけません。

## 2 つの委譲レイヤー — 混同しないこと

**レイヤー 1: Claude Code サブエージェント** (ネイティブの Agent ツール、
Claude モデルを使用し、あなたのコンテキスト予算を消費):

- `planner` — 利用可能な場合は Fable クラスのモデルで計画文書をディスクへ書き込みます
  (frontmatter は `model: fable`。組織にアクセス権がない場合、Claude Code は
  セッションモデルへ暗黙にフォールバックします)。ユーザーは委譲ごとにモデルを
  選択できます。Agent ツールの `model` パラメーターを渡してください
  (例: "planはopusで" → `model: "opus"`)。これは frontmatter より優先されます。
  返すのはファイルパスとタスク一覧だけです。単純でない設計には必ず使用します。
  会話コンテキストを持たずに開始するため、explorer の調査結果とユーザー要件を
  常に明示的に渡してください。自分で計画を作成したり書き写したりしてはいけません。
- 組み込みの読み取り専用エージェント (Explore) — コードベースに関する単発の質問専用。

**レイヤー 2: ワーカーの役割** (`sdd-worker` を介する外部エンジン。別の
トークン予算を使用し、スコープを限定できる作業ではこちらを優先):

- `executor` — 実装と修正
- `explorer` — 読み取り専用のコード調査 (コード構造の把握には通常これを選択)
- `thinker` — 既存の設計や計画に対する読み取り専用の批評
- `reviewer` — 任意のセカンドオピニオンとしての差分レビュー (必要になることはまれ)
- `test-writer` — TDD のレッドフェーズ。テストファイルのみ
- `operator` — シェル/Git 操作

設計パイプライン: ワーカー `explorer` がコードを把握 → `planner` サブエージェントが
計画を作成 → 必要に応じてワーカー `thinker` が草案を批評 → ユーザーが承認。
計画の作成 = planner (レイヤー 1)。批評とコードの読み取り = ワーカー
(レイヤー 2)。最終判断を Claude Code の外へ委譲してはいけません。

## Superpowers の境界 — ユーザーによる明示的な上書き

Superpowers スキルは**要件定義と計画作成のみ**に使用します。
superpowers:using-superpowers ではユーザー指示がスキルのワークフローより優先されます。
このセクションがその明示的な指示です:

- 許可: `superpowers:brainstorming` (ユーザーとの要件整理)、
  `superpowers:writing-plans` (計画文書)。
- 計画が存在した後は禁止: `superpowers:executing-plans`、
  `superpowers:using-git-worktrees`、`superpowers:finishing-a-development-branch`、
  およびコードを書くための汎用または実装サブエージェントの起動。
  実装には worker-sdd だけを使用します:
  `sdd-worker next <plan.md> --verify '<cmd>'` (バックグラウンド)。
- ブレインストーミング中にファイル全体を `cat` して自分のコンテキストへ
  読み込んではいけません。コード調査はワーカー `explorer` (単発の質問なら
  Explore サブエージェント)へ委譲し、その要約を読みます。
- ブレインストーミング後、単純でない設計や計画の作成は `planner`
  サブエージェントへ委譲します。会話内で設計を書いてはいけません。

## 厳守事項

1. `sdd-worker run|next|one-shot` は**バックグラウンド**で委譲する
   (`run_in_background: true`)。ロック拒否エラーが発生したら、再試行せず待つ。
2. 計画の初回委譲では `--verify '<test command>'` を設定する。すべてのタスクで、
   その検証に成功するまで完了とはみなされない。
3. エンジンは `.git` へ書き込めない。オーケストレーターが、承認したタスクごとに
   次の委譲前に 1 コミットを作成する。
4. 実行後に読むのは `status.yaml` → `report.yaml` → `diff.patch` の順だけ。
   `stdout.jsonl` 全体は決して読まない (失敗のトリアージ時に限り末尾 50 行以下)。
5. タスクごとの再試行は最大 2 回。何か (制約、モデル、エンジン)を変更せずに
   再試行してはいけない。差分が正しく検証にも成功したがレポートだけが失敗した場合は、
   `sdd-worker accept TASK-N --note "..."` を使用する。承認か再試行のどちらか一方だけを行う。
6. 直接編集の例外: 2 ファイル以下、約 30 行以下で、調査なしに仕様を正確に記述できる場合
   → 自分で編集し、検証を実行してコミットする。それより大きな作業はすべてワーカーを介す。
7. 委譲前にエンジンを事前確認 (`which codex`、`codex --version` など)してはいけない。
   直接委譲する。バイナリがなければ 1 秒未満で "binary not found" の理由とヒントが返る。
   `sdd-worker doctor` はセットアップのデバッグ専用であり、セッションごとの儀式ではない。

## エンジンの切り替え

ユーザーは自然言語でエンジンやモデルを切り替えられます
(`TASK-003だけOpenCodeに倒して`、`軽い実装はgpt-5.6-lunaで`)。
`sdd-worker set TASK-N engine|model <value>` で適用します。優先順位:

```text
CLI override > task.yaml > progress.yaml attempt record > project defaults > adapter defaults
```
