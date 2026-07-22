import { checkbox, confirm, input, select } from "@inquirer/prompts";
import type { AgentName, EngineName } from "./types.js";
import {
  appendClaudeMdTemplate,
  installHooks,
  installPlannerAgent,
  installSkills,
  type ClaudeMdInstallMode,
} from "./claude-assets.js";
import {
  loadUserConfig,
  saveUserConfig,
  type SddConfig,
} from "./config.js";
import { claudeUserDir } from "./paths.js";
import { getModelCatalog } from "./models.js";
import { captureCommand, resolveExecutable } from "./shell.js";

const AGENTS: readonly AgentName[] = [
  "executor",
  "explorer",
  "operator",
  "test-writer",
  "reviewer",
  "thinker",
];

const DEFAULTS: Record<AgentName, { model: string; effort: string }> = {
  executor: { model: "gpt-5.6-luna", effort: "xhigh" },
  explorer: { model: "gpt-5.6-luna", effort: "xhigh" },
  operator: { model: "gpt-5.6-luna", effort: "xhigh" },
  "test-writer": { model: "gpt-5.6-luna", effort: "xhigh" },
  reviewer: { model: "gpt-5.6-sol", effort: "medium" },
  thinker: { model: "gpt-5.6-sol", effort: "medium" },
};

const AGENT_DESCRIPTIONS: Record<AgentName, string> = {
  executor: "実装・修正の主担当 (推奨: gpt-5.6-luna xhigh)",
  explorer: "読み取り専用のコード調査 (推奨: gpt-5.6-luna)",
  operator: "シェル・Git操作",
  "test-writer": "TDDのテスト先行作成 (テストファイルのみ)",
  reviewer: "diffの二次レビュー (推奨: gpt-5.6-sol medium)",
  thinker: "設計・計画の批評 (読み取り専用、推奨: gpt-5.6-sol)",
};

const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

const CUSTOM_MODEL = "__sdd_worker_custom_model__";

type PromptChoice<T> = {
  name: string;
  value: T;
  description?: string;
  disabled?: boolean | string;
  checked?: boolean;
};

function configuredAdapters(config: SddConfig): EngineName[] {
  const configured = config.adapters?.enabled;
  const enabled = Array.isArray(configured)
    ? configured.filter((value): value is EngineName =>
        value === "codex" || value === "opencode" || value === "gemini",
      )
    : [];

  return [...new Set(enabled)];
}

function modelChoices(models: string[], current: string): PromptChoice<string>[] {
  const prioritized = ["gpt-5.6-luna", "gpt-5.6-sol", ...models];
  const unique = [...new Set(prioritized.filter((model) => model.trim().length > 0))];
  if (current && !unique.includes(current)) {
    unique.push(current);
  }

  return [
    ...unique.map((model) => ({
      name: model,
      value: model,
      description: model === current ? "currently configured" : undefined,
    })),
    { name: "その他 (フリー入力)", value: CUSTOM_MODEL },
  ];
}

function effortChoices(current: string): PromptChoice<string>[] {
  const values = [...EFFORTS];
  if (current && !values.includes(current as (typeof EFFORTS)[number])) {
    return [
      ...values.map((effort) => ({ name: effort, value: effort })),
      { name: current, value: current, description: "currently configured" },
    ];
  }
  return values.map((effort) => ({
    name: effort,
    value: effort,
    description: effort === current ? "currently configured" : undefined,
  }));
}

export function saveAgentSelection(
  config: SddConfig,
  agent: AgentName,
  model: string,
  effort: string,
): void {
  config.agents ??= {};
  config.agents[agent] = { ...config.agents[agent], model, effort };
}

async function configureAgents(config: SddConfig, models: string[]): Promise<void> {
  config.agents ??= {};

  for (const agent of AGENTS) {
    const existing = config.agents[agent] ?? {};
    const defaults = DEFAULTS[agent];
    const currentModel = existing.model ?? defaults.model;
    const selectedModel = await select({
      message: `${agent}: ${AGENT_DESCRIPTIONS[agent]}\nモデルを選択`,
      choices: modelChoices(models, currentModel),
      default: currentModel,
    });
    const model = selectedModel === CUSTOM_MODEL
      ? await input({
          message: `${agent} のモデル名を入力`,
          default: currentModel,
          required: true,
          validate: (value) => value.trim().length > 0 || "モデル名を入力してください",
        })
      : selectedModel;
    const currentEffort = existing.effort ?? defaults.effort;
    const effort = await select({
      message: `${agent} の effort`,
      choices: effortChoices(currentEffort),
      default: currentEffort,
    });

    saveAgentSelection(config, agent, model, effort);
  }
}

async function configureClaudeAssets(): Promise<void> {
  const targetDir = claudeUserDir();

  if (await confirm({
    message: "スキルを ~/.claude/skills にインストールする？ (worker-sdd等、SDD運用に必須)",
    default: true,
  })) {
    await installSkills(targetDir);
    console.log("スキルを更新しました。");
  }

  if (await confirm({
    message: "hooksとsettings.json統合を行う？ (Superpowers実装系skillのブロックとSDD境界の自動表示)",
    default: true,
  })) {
    await installHooks(targetDir);
    console.log("hooksとsettings.jsonを更新しました。");
  }

  if (await confirm({
    message: "plannerエージェント定義を ~/.claude/agents に置く？",
    default: true,
  })) {
    await installPlannerAgent(targetDir);
    console.log("plannerエージェント定義を更新しました。");
  }

  if (await confirm({
    message: "CLAUDE.mdにSDD設定を反映する？",
    default: true,
  })) {
    const mode = await select<ClaudeMdInstallMode | "skip">({
      message: "CLAUDE.mdの反映方法",
      choices: [
        {
          name: "マーカーブロックを追記/更新 (既存内容保持・推奨)",
          value: "marker",
        },
        { name: "ファイル全体を上書き", value: "overwrite" },
        { name: "スキップ", value: "skip" },
      ],
      default: "marker",
    });
    if (mode !== "skip") {
      await appendClaudeMdTemplate(targetDir, mode);
      console.log("CLAUDE.mdを更新しました。");
    }
  }
}

async function configureAdapters(config: SddConfig): Promise<void> {
  const configured = configuredAdapters(config);
  const enabled = await checkbox<EngineName>({
    message: "使用するアダプタを選択してください",
    required: true,
    choices: [
      {
        name: "codex",
        value: "codex",
        checked: configured.length === 0 || configured.includes("codex"),
        disabled: "必須",
      },
      {
        name: "opencode",
        value: "opencode",
        checked: configured.includes("opencode"),
      },
      {
        name: "gemini (future - not yet available)",
        value: "gemini",
        checked: false,
        disabled: "future - not yet available",
      },
    ],
  });

  config.adapters = {
    ...(config.adapters ?? {}),
    enabled: ["codex", ...enabled.filter((engine) => engine !== "codex")],
  };
}

function printNonInteractiveMessage(): void {
  console.error(
    "setup は対話専用。非対話環境では `sdd-worker config set` と `doctor` を使用してください。",
  );
}

export async function runSetup(workspace: string): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    printNonInteractiveMessage();
    return 1;
  }

  const config = await loadUserConfig();
  await configureAdapters(config);

  const catalog = await getModelCatalog("codex");
  console.log(`モデルカタログ: ${catalog.source} (${catalog.models.length} 件)`);
  await configureAgents(config, catalog.models);

  await configureClaudeAssets();

  // Persist the choices before checking the executable so a failed setup can
  // be resumed with the values just entered. A failed check must not leave a
  // stale Ready marker from a previous setup run.
  delete config.ready;
  await saveUserConfig(config);

  const codex = await captureCommand(resolveExecutable("codex"), ["--version"], {
    cwd: workspace,
  });
  if (codex.code !== 0) {
    console.error(
      "Codex の疎通チェックに失敗しました。Codex CLI をインストールしてログインし、`sdd-worker doctor` を実行してください。",
    );
    return 1;
  }

  config.ready = { engine: "codex", checked_at: new Date().toISOString() };
  await saveUserConfig(config);
  console.log(`Ready: codex ${codex.stdout.trim().split(/\r?\n/)[0] || "available"}`);
  return 0;
}
