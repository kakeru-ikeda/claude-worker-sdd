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
import { t, type Lang, type MessageKey } from "./i18n.js";

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

const AGENT_DESCRIPTION_KEYS: Record<AgentName, MessageKey> = {
  executor: "agent_desc_executor",
  explorer: "agent_desc_explorer",
  operator: "agent_desc_operator",
  "test-writer": "agent_desc_test_writer",
  reviewer: "agent_desc_reviewer",
  thinker: "agent_desc_thinker",
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

function modelChoices(models: string[], current: string, lang: Lang): PromptChoice<string>[] {
  const prioritized = ["gpt-5.6-luna", "gpt-5.6-sol", ...models];
  const unique = [...new Set(prioritized.filter((model) => model.trim().length > 0))];
  if (current && !unique.includes(current)) {
    unique.push(current);
  }

  return [
    ...unique.map((model) => ({
      name: model,
      value: model,
      description: model === current ? t(lang, "setup_currently_configured") : undefined,
    })),
    { name: t(lang, "setup_custom_model_choice"), value: CUSTOM_MODEL },
  ];
}

function effortChoices(current: string, lang: Lang): PromptChoice<string>[] {
  const values = [...EFFORTS];
  if (current && !values.includes(current as (typeof EFFORTS)[number])) {
    return [
      ...values.map((effort) => ({ name: effort, value: effort })),
      { name: current, value: current, description: t(lang, "setup_currently_configured") },
    ];
  }
  return values.map((effort) => ({
    name: effort,
    value: effort,
    description: effort === current ? t(lang, "setup_currently_configured") : undefined,
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

async function configureAgents(config: SddConfig, models: string[], lang: Lang): Promise<void> {
  config.agents ??= {};

  for (const agent of AGENTS) {
    const existing = config.agents[agent] ?? {};
    const defaults = DEFAULTS[agent];
    const currentModel = existing.model ?? defaults.model;
    const selectedModel = await select({
      message: t(lang, "setup_model_select", {
        agent,
        description: t(lang, AGENT_DESCRIPTION_KEYS[agent]),
      }),
      choices: modelChoices(models, currentModel, lang),
      default: currentModel,
    });
    const model = selectedModel === CUSTOM_MODEL
      ? await input({
          message: t(lang, "setup_custom_model_prompt", { agent }),
          default: currentModel,
          required: true,
          validate: (value) => value.trim().length > 0 || t(lang, "setup_custom_model_required"),
        })
      : selectedModel;
    const currentEffort = existing.effort ?? defaults.effort;
    const effort = await select({
      message: t(lang, "setup_effort_prompt", { agent }),
      choices: effortChoices(currentEffort, lang),
      default: currentEffort,
    });

    saveAgentSelection(config, agent, model, effort);
  }
}

async function configureClaudeAssets(lang: Lang): Promise<void> {
  const targetDir = claudeUserDir();

  if (await confirm({
    message: t(lang, "setup_install_skills_confirm"),
    default: true,
  })) {
    await installSkills(targetDir, lang);
    console.log(t(lang, "setup_install_skills_success"));
  }

  if (await confirm({
    message: t(lang, "setup_install_hooks_confirm"),
    default: true,
  })) {
    await installHooks(targetDir, lang);
    console.log(t(lang, "setup_install_hooks_success"));
  }

  if (await confirm({
    message: t(lang, "setup_install_planner_confirm"),
    default: true,
  })) {
    await installPlannerAgent(targetDir, lang);
    console.log(t(lang, "setup_install_planner_success"));
  }

  if (await confirm({
    message: t(lang, "setup_install_claude_md_confirm"),
    default: true,
  })) {
    const mode = await select<ClaudeMdInstallMode | "skip">({
      message: t(lang, "setup_claude_md_mode"),
      choices: [
        {
          name: t(lang, "setup_claude_md_marker"),
          value: "marker",
        },
        { name: t(lang, "setup_claude_md_overwrite"), value: "overwrite" },
        { name: t(lang, "setup_claude_md_skip"), value: "skip" },
      ],
      default: "marker",
    });
    if (mode !== "skip") {
      await appendClaudeMdTemplate(targetDir, mode, lang);
      console.log(t(lang, "setup_claude_md_success"));
    }
  }
}

async function configureAdapters(config: SddConfig, lang: Lang): Promise<void> {
  const configured = configuredAdapters(config);
  const enabled = await checkbox<EngineName>({
    message: t(lang, "setup_adapter_prompt"),
    required: true,
    choices: [
      {
        name: "codex",
        value: "codex",
        checked: configured.length === 0 || configured.includes("codex"),
        disabled: t(lang, "setup_adapter_required"),
      },
      {
        name: "opencode",
        value: "opencode",
        checked: configured.includes("opencode"),
      },
      {
        name: `gemini (${t(lang, "setup_adapter_future")})`,
        value: "gemini",
        checked: false,
        disabled: t(lang, "setup_adapter_future"),
      },
    ],
  });

  config.adapters = {
    ...(config.adapters ?? {}),
    enabled: ["codex", ...enabled.filter((engine) => engine !== "codex")],
  };
}

function printNonInteractiveMessage(lang: Lang): void {
  console.error(t(lang, "setup_non_interactive"));
}

export async function runSetup(workspace: string, lang: Lang = "en"): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    printNonInteractiveMessage(lang);
    return 1;
  }

  const config = await loadUserConfig();
  await configureAdapters(config, lang);

  const catalog = await getModelCatalog("codex");
  console.log(t(lang, "setup_model_catalog", { source: catalog.source, count: catalog.models.length }));
  await configureAgents(config, catalog.models, lang);

  await configureClaudeAssets(lang);

  // Persist the choices before checking the executable so a failed setup can
  // be resumed with the values just entered. A failed check must not leave a
  // stale Ready marker from a previous setup run.
  delete config.ready;
  await saveUserConfig(config);

  const codex = await captureCommand(resolveExecutable("codex"), ["--version"], {
    cwd: workspace,
  });
  if (codex.code !== 0) {
    console.error(t(lang, "setup_codex_failure"));
    return 1;
  }

  config.ready = { engine: "codex", checked_at: new Date().toISOString() };
  await saveUserConfig(config);
  console.log(t(lang, "setup_ready", {
    version: codex.stdout.trim().split(/\r?\n/)[0] || t(lang, "setup_available"),
  }));
  return 0;
}
