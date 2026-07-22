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

function formatReady(ready: SddConfig["ready"]): string {
  if (!isObject(ready)) return "not set";
  const engine = typeof ready.engine === "string" ? ready.engine : "unknown engine";
  const checkedAt = typeof ready.checked_at === "string" ? ready.checked_at : "unknown time";
  return `${engine}, checked_at=${checkedAt}`;
}

async function inspectEnvironment(workspace: string): Promise<number> {
  let failures = 0;
  const nodeMajor = Number.parseInt(process.versions.node.split(".", 1)[0] ?? "0", 10);
  if (nodeMajor >= REQUIRED_NODE_MAJOR) {
    statusLine("ok", "環境", `Node ${process.versions.node} (>= ${REQUIRED_NODE_MAJOR})`);
  } else {
    statusLine("fail", "環境", `Node ${process.versions.node} (>= ${REQUIRED_NODE_MAJOR} required)`);
    failures += 1;
  }
  statusLine("ok", "環境", `OS ${process.platform} ${process.arch}`);

  const git = await captureCommand("git", ["--version"], { cwd: workspace });
  if (git.code === 0) {
    statusLine("ok", "環境", `git ${firstLine(git.stdout)}`);
  } else {
    statusLine("fail", "環境", `git not found or exits ${git.code}`);
    failures += 1;
  }

  const brief = findTaskBriefScript();
  statusLine(
    brief ? "ok" : "warn",
    "環境",
    brief
      ? `Superpowers task-brief ${brief}`
      : "Superpowers task-brief not found; using the built-in fallback",
  );
  return failures;
}

async function inspectEngines(workspace: string, engines: EngineName[]): Promise<number> {
  let failures = 0;
  const codex = await captureCommand("codex", ["--version"], { cwd: workspace });
  if (codex.code === 0) {
    statusLine("ok", "エンジン", `codex ${firstLine(codex.stdout) || "available"}`);
  } else {
    statusLine("fail", "エンジン", `codex not found or exits ${codex.code} (required)`);
    failures += 1;
  }

  if (engines.includes("opencode")) {
    const opencode = await captureCommand("opencode", ["--version"], { cwd: workspace });
    statusLine(
      opencode.code === 0 ? "ok" : "warn",
      "エンジン",
      opencode.code === 0
        ? `opencode ${firstLine(opencode.stdout) || "available"}`
        : `opencode not found or exits ${opencode.code} (optional)`,
    );
  } else {
    statusLine("warn", "エンジン", "opencode disabled (optional)");
  }

  statusLine("warn", "エンジン", "gemini stub (future; not available)");
  return failures;
}

async function inspectConfig(workspace: string): Promise<void> {
  const configPath = userConfigPath();
  const projectPath = join(workspace, ".sdd", "config.yaml");
  statusLine(
    existsSync(configPath) ? "ok" : "warn",
    "設定",
    `user config ${existsSync(configPath) ? "present" : "not found"}: ${configPath}`,
  );
  statusLine(
    existsSync(projectPath) ? "ok" : "warn",
    "設定",
    `project config ${existsSync(projectPath) ? "present" : "not found"}: ${projectPath}`,
  );

  await Promise.all(AGENTS.map(async (agent) => {
    const effective = await resolveEffective({ workspace, agent });
    statusLine(
      "ok",
      "設定",
      `agent ${agent}: ${effective.engine} / ${effective.model ?? "engine default"}`,
    );
  }));
}

async function inspectModelCatalogs(engines: EngineName[]): Promise<void> {
  const path = modelsCachePath();
  const document = await readCachedCatalogs(path);
  for (const engine of engines) {
    const catalog = cachedCatalog(document, engine);
    if (!catalog) {
      statusLine("warn", "モデルカタログ", `${engine}: cache not found (${path})`);
      continue;
    }

    const stale = Date.now() - Date.parse(catalog.fetched_at as string) >= MODEL_CACHE_TTL_MS;
    statusLine(
      stale ? "warn" : "ok",
      "モデルカタログ",
      `${engine}: fetched_at=${catalog.fetched_at}, source=${catalog.source}${stale ? " (stale)" : ""}`,
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

async function inspectClaudeAssets(): Promise<void> {
  const root = claudeUserDir();
  const skills = await expectedSkills();
  const missingSkills = skills.filter((skill) => !existsSync(join(root, "skills", skill, "SKILL.md")));
  statusLine(
    missingSkills.length === 0 && skills.length > 0 ? "ok" : "warn",
    "Claude Code資産",
    missingSkills.length === 0 && skills.length > 0
      ? `skills installed (${skills.length})`
      : `skills incomplete${missingSkills.length > 0 ? `; missing ${missingSkills.join(", ")}` : ""}`,
  );

  const missingHooks = HOOK_FILES.filter((file) => !existsSync(join(root, "hooks", file)));
  statusLine(
    missingHooks.length === 0 ? "ok" : "warn",
    "Claude Code資産",
    missingHooks.length === 0 ? "hooks installed" : `hooks incomplete; missing ${missingHooks.join(", ")}`,
  );

  const planner = existsSync(join(root, "agents", "planner.md"));
  statusLine(planner ? "ok" : "warn", "Claude Code資産", `planner.md ${planner ? "installed" : "not installed"}`);

  let claudeText = "";
  try {
    claudeText = await readFile(join(root, "CLAUDE.md"), "utf8");
  } catch {
    // The missing file is reported below as an incomplete marker section.
  }
  const hasBlock = claudeText.includes(CLAUDE_BEGIN) && claudeText.includes(CLAUDE_END);
  statusLine(
    hasBlock ? "ok" : "warn",
    "Claude Code資産",
    `CLAUDE.md managed section ${hasBlock ? "installed" : "not installed"}`,
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

export function readyGateError(): string {
  return "Not ready. Run `sdd-worker setup` first.";
}

export async function shouldGateCommand(
  command: string,
  configPath = userConfigPath(),
): Promise<boolean> {
  return READY_GATED_COMMANDS.has(command) && !(await isReady(configPath));
}

export async function runDoctor(workspace: string): Promise<number> {
  const configPath = userConfigPath();
  const [user, project] = await Promise.all([
    loadUserConfig(configPath),
    loadProjectConfig(workspace),
  ]);
  const engines = enabledEngines(project, user);
  let failures = await inspectEnvironment(workspace);
  failures += await inspectEngines(workspace, engines);
  await inspectConfig(workspace);
  await inspectModelCatalogs(engines);
  await inspectClaudeAssets();

  statusLine(
    await isReady(configPath) ? "ok" : "warn",
    "Ready",
    `user config ready: ${formatReady(user.ready)}`,
  );

  if (failures > 0) {
    statusLine("fail", "Ready", "required checks failed; ready was not updated");
    return 1;
  }

  const ready = { engine: "codex", checked_at: new Date().toISOString() };
  await saveUserConfig({ ...user, ready });
  statusLine("ok", "Ready", `updated: ${formatReady(ready)}`);
  return 0;
}
