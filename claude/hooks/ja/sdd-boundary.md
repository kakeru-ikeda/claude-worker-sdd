<SDD-BOUNDARY priority="user-override">
このマシンでは worker-SDD が動作します。以下はユーザーによる明示的な指示であり、
スキルのワークフローより優先されます
(superpowers:using-superpowers はこの優先順位に従います)。

1. `superpowers:brainstorming` = ユーザーとの要件に関する質疑応答だけに使用します。
   ブレインストーミング中、自分のコンテキストへソースファイル全体を
   cat/Read してはいけません。Agent(Explore) または
   `sdd-worker one-shot "..." --agent explorer` へ委譲し、返された要約を読みます。
2. 設計文書と計画は `planner` サブエージェント (Agent ツール、Opus クラス)が
   **ディスクへ書き込みます**。サブエージェント自身が
   docs/plans/<date>-<slug>.md を保存し、パスとタスク一覧だけを返します。
   explorer の要約とユーザーの回答を渡してください。設計や計画を自分で、
   会話内にもファイルにも書いてはいけません。返されたタスク一覧をユーザーと
   レビューしてから委譲します。
3. 計画文書が存在した後、実装には `worker-sdd` スキルだけを使用します:
   `sdd-worker next <plan.md> --verify '<test cmd>'` をバックグラウンドジョブとして
   実行します。このマシンでは `superpowers:executing-plans`、
   `superpowers:using-git-worktrees`、`superpowers:finishing-a-development-branch`
   がフックによってブロックされるため、実行を試みてはいけません。
4. 各実行後は、ランナーが表示するヒントに従います。オーケストレーターが
   計画に照らして diff.patch をレビューし、タスクごとに 1 コミットを作成します。
</SDD-BOUNDARY>
