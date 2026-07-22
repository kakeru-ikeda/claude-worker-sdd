import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import {
  loadProjectConfig,
  loadUserConfig,
  resolveEffective,
  saveUserConfig,
  type SddConfig,
} from "./config.js";
import { captureCommand } from "./shell.js";
import { assetPath, claudeUserDir, modelsCachePath, userConfigPath } from "./paths.js";
import { findTaskBriefScript } from "./plan.js";
import type { AgentName, EngineName } from "./types.js";
import { t, type Lang } from "./i18n.js";

const REQUIRED_NODE_MAJOR = 20;
const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const READY_GATED_COMMANDS = new Set(["run", "next", "one-shot", "retry", "review"]);
const AGENTS: readonly AgentName[] = [
  "executor",
  "explorer",
  "operator",
  "test-writer",
  "reviewer",
  "thinker",
];
const HOOK_FILES = [
  "deny-superpowers-exec.mjs",
  "sdd-boundary.md",
  "print-sdd-boundary.mjs",
] as const;
const CLAUDE_BEGIN = "<!-- sdd-worker:begin -->";
const CLAUDE_END = "<!-- sdd-worker:end -->";

type CacheCatalog = {
  source?: unknown;
  fetched_at?: unknown;
};

type CacheDocument = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asEngine(value: unknown): value is EngineName {
  return value === "codex" || value === "opencode" || value === "gemini";
}

function configuredEngines(value: unknown): EngineName[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter(asEngine))];
}

function enabledEngines(project: SddConfig, user: SddConfig): EngineName[] {
  return configuredEngines(project.adapters?.enabled) ??
    configuredEngines(user.adapters?.enabled) ??
    ["codex", "opencode"];
}

function statusLine(status: "ok" | "fail" | "warn", category: string, message: string): void {
  const prefix = status === "ok" ? "[✓]" : status === "fail" ? "[✗]" : "[!]";
  console.log(`${prefix} [${category}] ${message}`);
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? "";
}

function cacheEntry(value: unknown): CacheCatalog | null {
  if (!isObject(value)) return null;
  if (
    (value.source !== "cli" && value.source !== "api" && value.source !== "fallback") ||
    typeof value.fetched_at !== "string" ||
    !Number.isFinite(Date.parse(value.fetched_at))
  ) {
    return null;
  }
  return { source: value.source, fetched_at: value.fetched_at };
}

async function readCachedCatalogs(path: string): Promise<CacheDocument> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = YAML.parse(await readFile(path, "utf8"));
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function cachedCatalog(document: CacheDocument, engine: EngineName): CacheCatalog | null {
  const direct = cacheEntry(document[engine]);
  if (direct) return direct;
  const nested = document.engines;
  return isObject(nested) ? cacheEntry(nested[engine]) : null;
}

function formatReady(ready: SddConfig["ready"], lang: Lang): string {
  if (!isObject(ready)) return t(lang, "doctor_not_set");
  const engine = typeof ready.engine === "string"
    ? ready.engine
    : t(lang, "doctor_unknown_engine");
  const checkedAt = typeof ready.checked_at === "string"
    ? ready.checked_at
    : t(lang, "doctor_unknown_time");
  return t(lang, "doctor_ready_detail", { engine, checkedAt });
}

async function inspectEnvironment(workspace: string, lang: Lang): Promise<number> {
  let failures = 0;
  const category = t(lang, "doctor_category_environment");
  const nodeMajor = Number.parseInt(process.versions.node.split(".", 1)[0] ?? "0", 10);
  if (nodeMajor >= REQUIRED_NODE_MAJOR) {
    statusLine("ok", category, t(lang, "doctor_node_ok", {
      version: process.versions.node,
      required: REQUIRED_NODE_MAJOR,
    }));
  } else {
    statusLine("fail", category, t(lang, "doctor_node_fail", {
      version: process.versions.node,
      required: REQUIRED_NODE_MAJOR,
    }));
    failures += 1;
  }
  statusLine("ok", category, t(lang, "doctor_os", {
    platform: process.platform,
    arch: process.arch,
  }));

  const git = await captureCommand("git", ["--version"], { cwd: workspace });
  if (git.code === 0) {
    statusLine("ok", category, t(lang, "doctor_git_ok", { version: firstLine(git.stdout) }));
  } else {
    statusLine("fail", category, t(lang, "doctor_git_fail", { code: git.code }));
    failures += 1;
  }

  const brief = findTaskBriefScript();
  statusLine(
    brief ? "ok" : "warn",
    category,
    brief
      ? t(lang, "doctor_task_brief_ok", { path: brief })
      : t(lang, "doctor_task_brief_missing"),
  );
  return failures;
}

async function inspectEngines(
  workspace: string,
  engines: EngineName[],
  lang: Lang,
): Promise<number> {
  let failures = 0;
  const category = t(lang, "doctor_category_engine");
  const codex = await captureCommand("codex", ["--version"], { cwd: workspace });
  if (codex.code === 0) {
    statusLine("ok", category, t(lang, "doctor_codex_ok", {
      version: firstLine(codex.stdout) || t(lang, "doctor_available"),
    }));
  } else {
    statusLine("fail", category, t(lang, "doctor_codex_fail", { code: codex.code }));
    failures += 1;
  }

  if (engines.includes("opencode")) {
    const opencode = await captureCommand("opencode", ["--version"], { cwd: workspace });
    statusLine(
      opencode.code === 0 ? "ok" : "warn",
      category,
      opencode.code === 0
        ? t(lang, "doctor_opencode_ok", {
          version: firstLine(opencode.stdout) || t(lang, "doctor_available"),
        })
        : t(lang, "doctor_opencode_fail", { code: opencode.code }),
    );
  } else {
    statusLine("warn", category, t(lang, "doctor_opencode_disabled"));
  }

  statusLine("warn", category, t(lang, "doctor_gemini_stub"));
  return failures;
}

async function inspectConfig(workspace: string, lang: Lang): Promise<void> {
  const configPath = userConfigPath();
  const projectPath = join(workspace, ".sdd", "config.yaml");
  const category = t(lang, "doctor_category_config");
  statusLine(
    existsSync(configPath) ? "ok" : "warn",
    category,
    t(lang, "doctor_user_config", {
      state: t(lang, existsSync(configPath) ? "doctor_present" : "doctor_not_found"),
      path: configPath,
    }),
  );
  statusLine(
    existsSync(projectPath) ? "ok" : "warn",
    category,
    t(lang, "doctor_project_config", {
      state: t(lang, existsSync(projectPath) ? "doctor_present" : "doctor_not_found"),
      path: projectPath,
    }),
  );

  await Promise.all(AGENTS.map(async (agent) => {
    const effective = await resolveEffective({ workspace, agent });
    statusLine(
      "ok",
      category,
      t(lang, "doctor_agent_config", {
        agent,
        engine: effective.engine,
        model: effective.model ?? t(lang, "doctor_engine_default"),
      }),
    );
  }));
}

async function inspectModelCatalogs(engines: EngineName[], lang: Lang): Promise<void> {
  const path = modelsCachePath();
  const document = await readCachedCatalogs(path);
  const category = t(lang, "doctor_category_model_catalog");
  for (const engine of engines) {
    const catalog = cachedCatalog(document, engine);
    if (!catalog) {
      statusLine("warn", category, t(lang, "doctor_cache_missing", { engine, path }));
      continue;
    }

    const stale = Date.now() - Date.parse(catalog.fetched_at as string) >= MODEL_CACHE_TTL_MS;
    statusLine(
      stale ? "warn" : "ok",
      category,
      t(lang, "doctor_cache_detail", {
        engine,
        fetchedAt: catalog.fetched_at as string,
        source: catalog.source as string,
        stale: stale ? t(lang, "doctor_stale") : "",
      }),
    );
  }
}

async function expectedSkills(): Promise<string[]> {
  try {
    const entries = await readdir(assetPath("skills"), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function inspectClaudeAssets(lang: Lang): Promise<void> {
  const root = claudeUserDir();
  const skills = await expectedSkills();
  const missingSkills = skills.filter((skill) => !existsSync(join(root, "skills", skill, "SKILL.md")));
  const category = t(lang, "doctor_category_claude_assets");
  statusLine(
    missingSkills.length === 0 && skills.length > 0 ? "ok" : "warn",
    category,
    missingSkills.length === 0 && skills.length > 0
      ? t(lang, "doctor_skills_installed", { count: skills.length })
      : t(lang, "doctor_skills_incomplete", {
        missing: missingSkills.length > 0
          ? t(lang, "doctor_missing_list", { items: missingSkills.join(", ") })
          : "",
      }),
  );

  const missingHooks = HOOK_FILES.filter((file) => !existsSync(join(root, "hooks", file)));
  statusLine(
    missingHooks.length === 0 ? "ok" : "warn",
    category,
    missingHooks.length === 0
      ? t(lang, "doctor_hooks_installed")
      : t(lang, "doctor_hooks_incomplete", { items: missingHooks.join(", ") }),
  );

  const planner = existsSync(join(root, "agents", "planner.md"));
  statusLine(planner ? "ok" : "warn", category, t(lang, "doctor_planner_state", {
    state: t(lang, planner ? "doctor_installed" : "doctor_not_installed"),
  }));

  let claudeText = "";
  try {
    claudeText = await readFile(join(root, "CLAUDE.md"), "utf8");
  } catch {
    // The missing file is reported below as an incomplete marker section.
  }
  const hasBlock = claudeText.includes(CLAUDE_BEGIN) && claudeText.includes(CLAUDE_END);
  statusLine(
    hasBlock ? "ok" : "warn",
    category,
    t(lang, "doctor_claude_md_state", {
      state: t(lang, hasBlock ? "doctor_installed" : "doctor_not_installed"),
    }),
  );
}

export async function isReady(configPath = userConfigPath()): Promise<boolean> {
  try {
    const config = await loadUserConfig(configPath);
    return config.ready !== undefined && config.ready !== null;
  } catch {
    return false;
  }
}

export function readyGateError(lang: Lang = "en"): string {
  return t(lang, "ready_gate_error");
}

export async function shouldGateCommand(
  command: string,
  configPath = userConfigPath(),
): Promise<boolean> {
  return READY_GATED_COMMANDS.has(command) && !(await isReady(configPath));
}

export async function runDoctor(workspace: string, lang: Lang = "en"): Promise<number> {
  const configPath = userConfigPath();
  const [user, project] = await Promise.all([
    loadUserConfig(configPath),
    loadProjectConfig(workspace),
  ]);
  const engines = enabledEngines(project, user);
  let failures = await inspectEnvironment(workspace, lang);
  failures += await inspectEngines(workspace, engines, lang);
  await inspectConfig(workspace, lang);
  await inspectModelCatalogs(engines, lang);
  await inspectClaudeAssets(lang);

  statusLine(
    await isReady(configPath) ? "ok" : "warn",
    t(lang, "doctor_category_ready"),
    t(lang, "doctor_user_ready", { ready: formatReady(user.ready, lang) }),
  );

  if (failures > 0) {
    statusLine(
      "fail",
      t(lang, "doctor_category_ready"),
      t(lang, "doctor_required_checks_failed"),
    );
    return 1;
  }

  const ready = { engine: "codex", checked_at: new Date().toISOString() };
  await saveUserConfig({ ...user, ready });
  statusLine(
    "ok",
    t(lang, "doctor_category_ready"),
    t(lang, "doctor_ready_updated", { ready: formatReady(ready, lang) }),
  );
  return 0;
}
