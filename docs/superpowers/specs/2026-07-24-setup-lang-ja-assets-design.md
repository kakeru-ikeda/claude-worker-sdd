# setup --lang ja: 配布資産の日本語化

## 背景

`sdd-worker setup --lang ja` は既に CLI のプロンプト・メッセージ (`runner/src/i18n.ts`) を日本語化しているが、
setup が `~/.claude` にコピーする資産ファイル自体(スキル定義・エージェント定義・CLAUDE.md テンプレート等)は
常に英語のまま配布される。`lang: ja` を指定したユーザーにとって、CLI操作は日本語なのにインストールされる
資産(Claude Code が読むプロンプト)が英語のみ、という非対称が生じている。

## 目的

`setup --lang ja` を実行した場合、setup が配布する資産ファイルについても日本語訳を `~/.claude` にインストールする。

## スコープ

setup (`configureClaudeAssets`) が実際にコピーする資産のみを対象とする。

| # | ファイル | インストール先 |
|---|---|---|
| 1 | `skills/ask-worker/SKILL.md` | `~/.claude/skills/ask-worker/SKILL.md` |
| 2 | `skills/sdd-worker/SKILL.md` | `~/.claude/skills/sdd-worker/SKILL.md` |
| 3 | `skills/worker-sdd/SKILL.md` | `~/.claude/skills/worker-sdd/SKILL.md` |
| 4 | `claude/agents/planner.md` | `~/.claude/agents/planner.md` |
| 5 | `claude/hooks/sdd-boundary.md` | `~/.claude/hooks/sdd-boundary.md` |
| 6 | `claude/CLAUDE.md` | `~/.claude/CLAUDE.md` (マーカーブロック追記 or 上書き) |

### 範囲外(明示的に対象外)

- `sdd/agents/*.yaml` の `role_contract` — これは Codex 等の worker エンジンに渡すプロンプトであり、
  Claude Code 向け資産ではないため対象外。
- `claude/hooks/deny-superpowers-exec.mjs` / `claude/hooks/print-sdd-boundary.mjs` — コードであり、
  ハードコードされたメッセージ文字列の言語分岐は今回のスコープに含めない。
  `print-sdd-boundary.mjs` は隣接する `sdd-boundary.md` を読んで出力するだけなので、
  `sdd-boundary.md` を日本語版に差し替えれば自動的に日本語で出力される。

## アーキテクチャ

### 1. リポジトリ構成: `ja/` ミラーディレクトリ

リポジトリルートに、対象6ファイルと同じ相対パス構造を持つ `ja/` ディレクトリを新設する。

```text
ja/
  claude/
    CLAUDE.md
    agents/planner.md
    hooks/sdd-boundary.md
  skills/
    ask-worker/SKILL.md
    sdd-worker/SKILL.md
    worker-sdd/SKILL.md
```

翻訳方針:
- frontmatter の `name:` はスキル/エージェント検索キーのため不変。
- `description:` を含むプローズ・説明文は日本語に翻訳する。
- コードブロック・コマンド例・YAMLキー・ファイルパスは英語のまま保持する。

### 2. アセットのビルド同梱: `runner/scripts/copy-assets.mjs`

現在 `["sdd", "skills", "claude"]` をリポジトリルートから `runner/assets/` にコピーしている処理に `"ja"` を追加する。

```js
for (const assetName of ["sdd", "skills", "claude", "ja"]) {
  await cp(join(repositoryRoot, assetName), join(assetsRoot, assetName), { recursive: true });
}
```

### 3. パス解決: `runner/src/paths.ts`

既存の `assetPath(...segs)` はそのまま(言語非依存の呼び出し `sdd/adapters`, `sdd/schemas` 等に影響させない)。
新規に `localizedAssetPath(lang, ...segs)` を追加する:

```ts
export function localizedAssetPath(lang: Lang, ...segs: string[]): string {
  if (lang === "ja") {
    const jaPath = assetPath("ja", ...segs);
    if (existsSync(jaPath)) return jaPath;
  }
  return assetPath(...segs);
}
```

`lang === "ja"` かつ対応する `ja/` 配下のファイルが存在すればそれを、存在しなければ英語版に
フォールバックする(将来ファイルが未翻訳のまま追加された場合の安全策)。

### 4. インストーラ: `runner/src/claude-assets.ts`

以下の関数に `lang: Lang = "en"` を追加し、対象の `assetPath(...)` 呼び出しを `localizedAssetPath(lang, ...)` に置換する。

- `installSkills(targetDir, lang)` — 3つの `SKILL.md`
- `installPlannerAgent(targetDir, lang)` — `planner.md`
- `installHooks(targetDir, lang)` — `sdd-boundary.md` のみ言語分岐。`deny-superpowers-exec.mjs` / `print-sdd-boundary.mjs` は常に `assetPath(...)`(英語=コード)のまま。
- `appendClaudeMdTemplate(targetDir, mode, lang)` — `CLAUDE.md`
- `installAll(targetDir, lang)` — 上記全てに `lang` を伝播(対称性のため)

デフォルト値 `"en"` により、既存の呼び出し元(テスト等)は無変更で動作する。

### 5. 呼び出し元: `runner/src/setup.ts`

`configureClaudeAssets(lang)` は既に `lang` を受け取っているので、内部の4つの install 呼び出しに
`lang` を渡すよう変更するのみ。

## テスト方針

`runner/src/test/setup.test.ts`(または `claude-assets` 用テストファイル)に以下を追加する:

1. `lang: "ja"` で `installSkills` / `installPlannerAgent` / `appendClaudeMdTemplate` / `installHooks` を実行し、
   コピーされた `SKILL.md` / `planner.md` / `CLAUDE.md` / `sdd-boundary.md` の内容が `ja/` ソースと一致すること
   (例: 日本語文字列を含むことを確認)。
2. `installHooks(targetDir, "ja")` 実行後も、`deny-superpowers-exec.mjs` と `print-sdd-boundary.mjs` の内容が
   英語版ソースとバイト同一であること。
3. `lang: "en"`(デフォルト)またはlang省略時は従来どおり英語版がコピーされること(回帰確認)。
4. `ja/` に対応ファイルが存在しないケースを想定し、`localizedAssetPath` が英語版にフォールバックすること
   (`paths.test.ts` があればそこに追加)。

## 影響を受けないもの

- `runner/src/i18n.ts` の CLIメッセージ翻訳ロジックは変更なし。
- `sdd/` 配下の worker 向けエージェント定義・アダプタ定義・スキーマは変更なし。
- `doctor` コマンド等、他の `assetPath` 呼び出し元は変更なし。
