import { existsSync } from "node:fs";
import { join } from "node:path";
import { assetPath, userConfigPath as defaultUserConfigPath } from "./paths.js";
import { readYaml, writeYaml } from "./fsutil.js";
import type { AgentName, EngineName } from "./types.js";

export interface AgentModelConfig {
  engine?: EngineName;
  model?: string;
  effort?: string;
}

export interface SddConfig {
  adapters?: { enabled?: string[] };
  agents?: Partial<Record<AgentName, AgentModelConfig>>;
  ready?: { engine: string; checked_at: string } | null;
}

export interface EffectiveEngine {
  engine: EngineName;
  model: string | null;
  effort: string | null;
  source: {
    engine: string;
    model: string;
    effort: string;
  };
}

export interface ShippedAgentDefaults {
  default_model?: Record<string, string>;
  default_effort?: Record<string, string>;
}

export interface ShippedAdapterMeta {
  name?: string;
  status?: string;
  default_runner?: string;
  capabilities?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  command?: Record<string, unknown>;
  models?: string[];
  models_updated?: string;
  [key: string]: unknown;
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const entries = Object.entries(value).filter((entry): entry is [string, string] => {
    return typeof entry[1] === "string";
  });
  return entries.length > 0 ? Object.fromEntries(entries) : {};
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

async function readOptionalYaml(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {};
  return asObject(await readYaml<unknown>(path));
}

export async function loadShippedAgentDefaults(
  agent: AgentName,
): Promise<ShippedAgentDefaults> {
  const document = await readOptionalYaml(assetPath("sdd", "agents", `${agent}.yaml`));
  const defaults: ShippedAgentDefaults = {};
  const defaultModel = asStringMap(document.default_model);
  const defaultEffort = asStringMap(document.default_effort);

  if (defaultModel !== undefined) defaults.default_model = defaultModel;
  if (defaultEffort !== undefined) defaults.default_effort = defaultEffort;
  return defaults;
}

export async function loadShippedAdapterMeta(engine: EngineName): Promise<ShippedAdapterMeta> {
  return readOptionalYaml(assetPath("sdd", "adapters", `${engine}.yaml`));
}

export async function loadUserConfig(path = defaultUserConfigPath()): Promise<SddConfig> {
  return (await readOptionalYaml(path)) as SddConfig;
}

export async function saveUserConfig(
  config: SddConfig,
  path = defaultUserConfigPath(),
): Promise<void> {
  await writeYaml(path, config);
}

export async function loadProjectConfig(workspace: string): Promise<SddConfig> {
  return (await readOptionalYaml(join(workspace, ".sdd", "config.yaml"))) as SddConfig;
}

function isEngineName(value: unknown): value is EngineName {
  return value === "codex" || value === "opencode" || value === "gemini";
}

function choose<T>(
  candidates: Array<{ value: T | null | undefined; source: string }>,
  fallback: T,
): { value: T; source: string } {
  const candidate = candidates.find((item) => item.value !== undefined && item.value !== null);
  return candidate ? { value: candidate.value as T, source: candidate.source } : { value: fallback, source: "shipped" };
}

export async function resolveEffective(input: {
  workspace: string;
  agent: AgentName;
  cli?: { engine?: EngineName; model?: string };
  task?: { engine?: EngineName; model?: string | null; effort?: string | null };
  attempt?: { engine?: EngineName; model?: string | null };
  userConfigPath?: string;
}): Promise<EffectiveEngine> {
  const [project, user, shipped] = await Promise.all([
    loadProjectConfig(input.workspace),
    loadUserConfig(input.userConfigPath),
    loadShippedAgentDefaults(input.agent),
  ]);
  const projectAgent = project.agents?.[input.agent];
  const userAgent = user.agents?.[input.agent];

  const engine = choose<EngineName>(
    [
      { value: input.cli?.engine, source: "cli" },
      { value: input.task?.engine, source: "task" },
      { value: input.attempt?.engine, source: "attempt" },
      { value: isEngineName(projectAgent?.engine) ? projectAgent.engine : undefined, source: "project" },
      { value: isEngineName(userAgent?.engine) ? userAgent.engine : undefined, source: "user" },
    ],
    "codex",
  );

  const model = choose<string | null>(
    [
      { value: input.cli?.model, source: "cli" },
      { value: input.task?.model, source: "task" },
      { value: input.attempt?.model, source: "attempt" },
      { value: projectAgent?.model, source: "project" },
      { value: userAgent?.model, source: "user" },
      { value: shipped.default_model?.[engine.value], source: "shipped" },
    ],
    null,
  );

  const effort = choose<string | null>(
    [
      { value: input.task?.effort, source: "task" },
      { value: projectAgent?.effort, source: "project" },
      { value: userAgent?.effort, source: "user" },
      { value: shipped.default_effort?.[engine.value], source: "shipped" },
    ],
    null,
  );

  return {
    engine: engine.value,
    model: model.value,
    effort: engine.value === "codex" ? effort.value : null,
    source: {
      engine: engine.source,
      model: model.source,
      effort: effort.source,
    },
  };
}
