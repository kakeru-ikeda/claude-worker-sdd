#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { getAdapter } from "./adapters/index.js";
import {
  acquireLock,
  ensurePlanState,
  isLockStale,
  loadCurrentPlan,
  loadProgressFor,
  migrateLegacyLayout,
  migrateStateRoot,
  normalizePlanPath,
  planSlug,
  prepareReview,
  prepareTask,
  progressPath,
  releaseLock,
  saveCurrentPlan,
  saveProgress,
  taskPathForProgress,
} from "./artifacts.js";
import {
  getPath,
  loadProjectConfig,
  loadUserConfig,
  resolveEffective,
  saveUserConfig,
  setPath,
  type EffectiveEngine,
  type SddConfig,
} from "./config.js";
import { ensureDir, readText, readYaml, writeText, writeYaml } from "./fsutil.js";
import { captureCommand, runShell } from "./shell.js";
import { getModelCatalog } from "./models.js";
import { countPlanTasks, findTaskBriefScript, findWorkspace, taskId } from "./plan.js";
import type { AgentName, EngineName, Progress, TaskSpec } from "./types.js";

const COMMAND_FLAGS: Record<string, readonly string[]> = {
  run: ["task", "engine", "model", "agent", "verify", "net", "force", "dry-run"],
  next: ["plan", "engine", "model", "agent", "verify", "net", "force", "dry-run"],
  "one-shot": ["task", "engine", "model", "agent", "verify", "net", "force"],
  review: ["plan", "engine", "model"],
  retry: ["plan", "engine", "model", "net"],
  accept: ["plan", "note"],
  set: ["plan"],
  config: ["project"],
  status: ["plan"],
  help: [],
  "--help": [],
  guide: [],
  doctor: [],
  models: ["engine", "refresh"],
};

function parseArgs(argv: string[]): { command: string; rest: string[]; flags: Record<string, string | true> } {
  const [command = "help", ...raw] = argv;
  const rest: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (item.startsWith("--")) {
      const key = item.slice(2);
      const next = raw[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      rest.push(item);
    }
  }
  return { command, rest, flags };
}

function asEngine(value: unknown): EngineName | undefined {
  return value === "codex" || value === "opencode" || value === "gemini" ? value : undefined;
}

function asAgent(value: unknown): AgentName | undefined {
  return value === "executor" ||
    value === "reviewer" ||
    value === "explorer" ||
    value === "thinker" ||
    value === "test-writer" ||
    value === "operator"
    ? value
    : undefined;
}

// Engines write report statuses loosely ("completed", "success", ...). Normalize
// instead of gating on exact enum strings — the executable verify is the real gate.
function normalizeReportStatus(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (["DONE", "COMPLETE", "COMPLETED", "SUCCESS", "SUCCEEDED", "FINISHED", "OK"].includes(s)) {
    return "DONE";
  }
  if (["DONE_WITH_CONCERNS", "COMPLETED_WITH_CONCERNS", "CONCERNS"].includes(s)) {
    return "DONE_WITH_CONCERNS";
  }
  if (["BLOCKED", "BLOCKING"].includes(s)) return "BLOCKED";
  if (["NEEDS_CONTEXT", "NEED_CONTEXT", "NEEDS_INFO", "QUESTION"].includes(s)) {
    return "NEEDS_CONTEXT";
  }
  return s;
}

function flagArgs(flags: Record<string, string | true>, keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const value = flags[key];
    if (value === true) out.push(`--${key}`);
    else if (typeof value === "string") out.push(`--${key}`, value);
  }
  return out;
}

async function loadProgressReadOnly(workspace: string, slug: string): Promise<Progress | null> {
  const path = progressPath(workspace, slug);
  return existsSync(path) ? await readYaml<Progress>(path) : null;
}

type ProgressTask = Progress["tasks"][string];

function latestRunAttempt(item: ProgressTask | undefined): { engine?: EngineName; model?: string | null } | undefined {
  const record = [...(item?.attempts ?? [])]
    .reverse()
    .find((attempt) => attempt.type === "run");
  if (!record) return undefined;

  const engine = asEngine(record.engine);
  const model = typeof record.model === "string" || record.model === null ? record.model : undefined;
  if (engine === undefined && model === undefined) return undefined;
  return { engine, model };
}

async function loadStoredTask(
  workspace: string,
  item: ProgressTask | undefined,
): Promise<TaskSpec | undefined> {
  if (!item?.path) return undefined;
  const path = join(workspace, item.path, "task.yaml");
  if (!existsSync(path)) return undefined;
  return readYaml<TaskSpec>(path);
}

function taskResolutionInput(task: TaskSpec | undefined): {
  engine?: EngineName;
  model?: string | null;
  effort?: string | null;
} | undefined {
  if (!task) return undefined;
  return {
    engine: asEngine(task.engine?.name),
    model: typeof task.engine?.model === "string" || task.engine?.model === null ? task.engine.model : undefined,
    effort: typeof task.engine?.effort === "string" || task.engine?.effort === null ? task.engine.effort : undefined,
  };
}

async function resolveDispatchEngine(input: {
  workspace: string;
  agent: AgentName;
  flags: Record<string, string | true>;
  task?: TaskSpec;
  progressTask?: ProgressTask;
}): Promise<EffectiveEngine> {
  const cli: { engine?: EngineName; model?: string } = {};
  if (typeof input.flags.engine === "string") cli.engine = asEngine(input.flags.engine);
  if (typeof input.flags.model === "string") cli.model = input.flags.model;
  return resolveEffective({
    workspace: input.workspace,
    agent: input.agent,
    cli,
    task: taskResolutionInput(input.task),
    attempt: latestRunAttempt(input.progressTask),
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeConfigValues(base: unknown, override: unknown): unknown {
  if (!isObject(base) || !isObject(override)) return override;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = key in merged ? mergeConfigValues(merged[key], value) : value;
  }
  return merged;
}

function flattenConfig(
  value: unknown,
  source: "user" | "project",
  prefix = "",
  entries = new Map<string, { value: unknown; source: "user" | "project" }>(),
): Map<string, { value: unknown; source: "user" | "project" }> {
  if (isObject(value) && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) {
      flattenConfig(child, source, prefix ? `${prefix}.${key}` : key, entries);
    }
  } else if (prefix) {
    entries.set(prefix, { value, source });
  }
  return entries;
}

function displayConfigValue(value: unknown): string {
  const rendered = YAML.stringify(value).trim();
  return rendered.replace(/\n/g, " ") || "null";
}

async function runConfigCommand(
  workspace: string,
  rest: string[],
  flags: Record<string, string | true>,
): Promise<number> {
  const [subcommand, path] = rest;
  if (!subcommand || !["list", "get", "set"].includes(subcommand)) {
    throw new Error("Usage: config list | config get <dotted.path> | config set <dotted.path> <value> [--project]");
  }

  const user = await loadUserConfig();
  const project = await loadProjectConfig(workspace);

  if (subcommand === "list") {
    const entries = flattenConfig(user, "user");
    flattenConfig(project, "project", "", entries);
    if (entries.size === 0) {
      console.log("No user or project config values are set.");
      return 0;
    }
    for (const [key, entry] of [...entries.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`${key} = ${displayConfigValue(entry.value)} (${entry.source})`);
    }
    return 0;
  }

  if (!path) throw new Error(`Usage: config ${subcommand} <dotted.path>${subcommand === "set" ? " <value>" : ""}`);
  if (subcommand === "get") {
    const value = getPath(mergeConfigValues(user, project), path);
    if (value === undefined) throw new Error(`config path not found: ${path}`);
    console.log(displayConfigValue(value));
    return 0;
  }

  const rawValue = rest.slice(2).join(" ");
  if (!rawValue) throw new Error("config set requires a value");
  const value = YAML.parse(rawValue);
  const target = flags.project === true ? project : user;
  setPath(target as unknown as Record<string, unknown>, path, value);
  if (flags.project === true) {
    await writeYaml(join(workspace, ".sdd", "config.yaml"), target);
    console.log(`set ${path} in project config`);
  } else {
    await saveUserConfig(target as SddConfig);
    console.log(`set ${path} in user config`);
  }
  return 0;
}

function configuredEngines(value: unknown): EngineName[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const engines = value.filter((item): item is EngineName => asEngine(item) !== undefined);
  return engines.length > 0 ? [...new Set(engines)] : [];
}

async function enabledModelEngines(workspace: string): Promise<EngineName[]> {
  const [project, user] = await Promise.all([loadProjectConfig(workspace), loadUserConfig()]);
  return configuredEngines(project.adapters?.enabled) ??
    configuredEngines(user.adapters?.enabled) ??
    ["codex", "opencode"];
}

async function runModelsCommand(
  workspace: string,
  flags: Record<string, string | true>,
): Promise<number> {
  const requested = typeof flags.engine === "string" ? asEngine(flags.engine) : undefined;
  if (typeof flags.engine === "string" && !requested) {
    throw new Error(`unknown engine: ${flags.engine}`);
  }

  const engines = requested ? [requested] : await enabledModelEngines(workspace);
  for (const [index, engine] of engines.entries()) {
    if (index > 0) console.log("");
    const catalog = await getModelCatalog(engine, { refresh: flags.refresh === true });
    console.log(`engine: ${engine}`);
    console.log(`source: ${catalog.source}`);
    console.log(`fetched_at: ${catalog.fetched_at}`);
    console.log("models:");
    if (catalog.models.length === 0) console.log("  (none)");
    else for (const model of catalog.models) console.log(`  - ${model}`);
  }
  return 0;
}

async function resolveActivePlan(
  workspace: string,
  flags: Record<string, string | true>,
): Promise<{ plan: string; slug: string }> {
  await migrateLegacyLayout(workspace);
  if (typeof flags.plan === "string") {
    const plan = normalizePlanPath(workspace, flags.plan);
    return { plan, slug: planSlug(plan) };
  }
  const current = await loadCurrentPlan(workspace);
  if (current) return current;
  throw new Error("No active plan. Pass --plan <plan.md> or dispatch a task with `run <plan.md>` first.");
}

async function run(argv: string[]): Promise<number> {
  const { command, rest, flags } = parseArgs(argv);
  if (command in COMMAND_FLAGS) {
    const allowed = COMMAND_FLAGS[command];
    const unknown = Object.keys(flags).find((key) => !allowed.includes(key));
    if (unknown) {
      throw new Error(
        `unknown flag --${unknown} for command "${command}" (allowed: ${allowed.length ? allowed.map((key) => `--${key}`).join(", ") : "none"})`,
      );
    }
  }
  const workspace = await findWorkspace();
  await migrateStateRoot(workspace);

  if (command === "help" || command === "--help") {
    console.log("Usage: sdd-worker run <plan.md> [--task TASK-001] [--engine codex] [--model gpt-5.4] [--verify '<test cmd>'] [--net] [--force] [--dry-run]");
    console.log("       (--dry-run: preview the dispatch without locking or writing state)");
    console.log("       (--net: opt-in outbound network for that dispatch only; FS/.git protection stays)");
    console.log("       sdd-worker next [<plan.md>] [--engine codex] [--model gpt-5.4] [--dry-run]   dispatch first non-complete task");
    console.log("       (--verify persists as the plan default and gates every task's completion)");
    console.log("       sdd-worker one-shot \"<instruction>\" [--agent explorer] [--engine codex]");
    console.log("       sdd-worker review TASK-001 [--plan <plan.md>] [--engine codex] [--model gpt-5.5]");
    console.log("       sdd-worker retry TASK-001 [--plan <plan.md>] [--engine codex] [--model gpt-5.4]");
    console.log("       sdd-worker accept TASK-001 [--note \"why\"]              mark a failed task complete after manual review");
    console.log("       sdd-worker status [--plan <plan.md>]");
    console.log("       sdd-worker set <TASK-ID> engine|model <value> [--plan <plan.md>]");
    console.log("       sdd-worker config list|get <dotted.path>|set <dotted.path> <value> [--project]");
    console.log("       sdd-worker guide [<topic>]                    print playbook section on demand");
    console.log("       sdd-worker doctor                             check engine CLIs (setup debugging only)");
    console.log("       sdd-worker models [--engine codex] [--refresh] list available models");
    return 0;
  }

  if (command === "config") {
    return runConfigCommand(workspace, rest, flags);
  }

  if (command === "models") {
    return runModelsCommand(workspace, flags);
  }

  if (command === "doctor") {
    const checks: Array<{ bin: string; note: string; required: boolean }> = [
      { bin: "codex", note: "primary engine", required: true },
      { bin: "opencode", note: "optional engine", required: false },
      { bin: "git", note: "required for diff capture and commits", required: true },
    ];
    let failures = 0;
    for (const { bin, note, required } of checks) {
      const result = await captureCommand(bin, ["--version"], { cwd: workspace });
      if (result.code === 0) {
        console.log(`ok    ${bin}  ${result.stdout.trim().split("\n")[0]}`);
      } else {
        console.log(`${required ? "MISS" : "warn"}  ${bin}  (${note}) — not found or exits ${result.code}`);
        if (required) failures += 1;
      }
    }
    const brief = findTaskBriefScript();
    console.log(
      brief
        ? `ok    superpowers task-brief: ${brief}`
        : "warn  superpowers task-brief script not found — runner falls back to whole-plan briefs",
    );
    return failures > 0 ? 1 : 0;
  }

  if (command === "guide") {
    const here = dirname(fileURLToPath(import.meta.url));
    const docPath = join(here, "..", "..", "docs", "ORCHESTRATION.md");
    if (!existsSync(docPath)) throw new Error(`playbook not found: ${docPath}`);
    const sections = (await readText(docPath))
      .split(/^## /m)
      .slice(1)
      .map((section) => `## ${section.trimEnd()}`);
    const topic = rest[0]?.toLowerCase();
    if (!topic) {
      console.log("Playbook sections — print ONE with: sdd-worker guide <keyword>");
      console.log("(do not load the whole playbook into context)");
      for (const section of sections) {
        console.log(`  ${section.split("\n")[0].replace(/^## /, "")}`);
      }
      return 0;
    }
    const hit = sections.find((section) => section.split("\n")[0].toLowerCase().includes(topic));
    if (!hit) throw new Error(`no playbook section matches "${topic}" — run guide with no args to list`);
    console.log(hit);
    return 0;
  }

  if (command === "status") {
    await migrateLegacyLayout(workspace);
    let plan: string | null = null;
    let slug: string | null = null;
    if (typeof flags.plan === "string") {
      plan = normalizePlanPath(workspace, flags.plan);
      slug = planSlug(plan);
    } else {
      const current = await loadCurrentPlan(workspace);
      if (current) ({ plan, slug } = current);
    }
    if (!plan || !slug) {
      console.log("No active plan (no .sdd/current-plan.yaml). Pass --plan <plan.md>.");
      return 0;
    }
    console.log(`plan: ${plan} (slug: ${slug})`);
    const path = progressPath(workspace, slug);
    if (!existsSync(path)) {
      console.log("no progress yet — next: TASK-001");
      return 0;
    }
    const progress = await loadProgressFor(workspace, slug);
    if (progress.base_commit) console.log(`base_commit: ${progress.base_commit}`);
    const ids = Object.keys(progress.tasks).sort();
    for (const id of ids) {
      const t = progress.tasks[id];
      const engine = `${t.engine ?? "?"}${t.model ? `/${t.model}` : ""}`;
      const attempts = t.attempts?.length ?? 0;
      console.log(
        `${id}  ${t.status}  ${engine}  attempts=${attempts}${t.reviewed ? "  reviewed" : ""}`,
      );
    }
    const planFile = join(workspace, plan);
    const total = existsSync(planFile) ? countPlanTasks(await readText(planFile)) : null;
    if (total !== null) {
      let next: string | null = null;
      for (let i = 1; i <= total; i += 1) {
        if (progress.tasks[taskId(i)]?.status !== "complete") {
          next = taskId(i);
          break;
        }
      }
      console.log(next ? `next: ${next} (plan defines ${total} tasks)` : `all ${total} tasks complete`);
    }
    return 0;
  }

  if (command === "next") {
    await migrateLegacyLayout(workspace);
    const planArg =
      rest[0] ??
      (typeof flags.plan === "string" ? flags.plan : undefined) ??
      (await loadCurrentPlan(workspace))?.plan;
    if (!planArg) throw new Error("Usage: next [<plan.md>] — no active plan found");
    const planPath = normalizePlanPath(workspace, planArg);
    if (!existsSync(join(workspace, planPath))) throw new Error(`plan file not found: ${planPath}`);
    const total = countPlanTasks(await readText(join(workspace, planPath)));
    if (total === null) {
      throw new Error("no task headings found in plan (expected '### Task N: ...'); use run --task instead");
    }
    const dryRun = flags["dry-run"] === true;
    const slug = planSlug(planPath);
    const progress = dryRun
      ? await loadProgressReadOnly(workspace, slug) ?? { plan: planPath, base_commit: null, tasks: {} }
      : (await ensurePlanState(workspace, planPath)).progress;
    let nextIndex: number | null = null;
    for (let i = 1; i <= total; i += 1) {
      const state = progress.tasks[taskId(i)]?.status;
      if (state === "running") {
        if (dryRun) {
          console.log(`dry-run: ${taskId(i)} is marked running — 'next' will not dispatch while it is running`);
          return 0;
        }
        if (await isLockStale(workspace, slug)) {
          const item = progress.tasks[taskId(i)]!;
          if (!item.attempts) item.attempts = [];
          item.attempts.push({ type: "interrupted", detected_at: new Date().toISOString() });
          item.status = "failed";
          await saveProgress(workspace, slug, progress);
          console.log(
            `${taskId(i)} was marked running but its dispatch process is gone (stale lock) — recorded as interrupted, redispatching`,
          );
          nextIndex = i;
          break;
        }
        throw new Error(`${taskId(i)} is still running; wait for it before dispatching the next task`);
      }
      if (state !== "complete") {
        nextIndex = i;
        break;
      }
    }
    if (nextIndex === null) {
      console.log(`all ${total} tasks complete for ${planPath}`);
      return 0;
    }
    if (dryRun) {
      console.log(`dry-run: next task is ${taskId(nextIndex)} (plan defines ${total} tasks)`);
    } else {
      console.log(`dispatching ${taskId(nextIndex)} (plan defines ${total} tasks)`);
    }
    return run([
      "run",
      planPath,
      "--task",
      taskId(nextIndex),
      ...flagArgs(flags, ["engine", "model", "agent", "verify", "net", "force", "dry-run"]),
    ]);
  }

  if (command === "one-shot") {
    const first = rest[0];
    const asPlan = first ? normalizePlanPath(workspace, first) : undefined;
    if (asPlan && existsSync(join(workspace, asPlan)) && asPlan.endsWith(".md")) {
      return run(["run", asPlan, ...flagArgs(flags, ["task", "engine", "model", "agent", "force"])]);
    }
    const instruction = rest.join(" ").trim();
    if (!instruction) {
      throw new Error('Usage: one-shot "<instruction>" [--agent explorer] [--engine codex]');
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const adhocRel = join(".sdd", "adhoc", `adhoc-${stamp}.md`);
    const title = instruction.length > 80 ? `${instruction.slice(0, 77)}...` : instruction;
    await writeText(
      join(workspace, adhocRel),
      `# Ad-hoc worker task\n\n### Task 1: ${title}\n\n${instruction}\n`,
    );
    return run([
      "run",
      adhocRel,
      "--task",
      "TASK-001",
      ...flagArgs(flags, ["engine", "model", "agent", "verify", "net"]),
    ]);
  }

  if (command === "run") {
    const planPath = rest[0] ? normalizePlanPath(workspace, rest[0]) : undefined;
    if (!planPath) throw new Error("plan path is required");
    if (!existsSync(join(workspace, planPath))) {
      throw new Error(`plan file not found: ${planPath}`);
    }
    const index = flags.task && typeof flags.task === "string"
      ? Number(flags.task.replace(/^TASK-/, ""))
      : 1;
    if (!Number.isFinite(index) || index < 1) throw new Error("invalid task id/index");

    const totalTasks = countPlanTasks(await readText(join(workspace, planPath)));
    if (totalTasks !== null && index > totalTasks && flags.force !== true) {
      throw new Error(
        `plan defines ${totalTasks} tasks; ${taskId(index)} is out of range. ` +
          `If this is a new plan, its state starts fresh at TASK-001. Use --force only if the plan numbering is unusual.`,
      );
    }

    const id = taskId(index);
    if (flags["dry-run"] === true) {
      const slug = planSlug(planPath);
      const progress = await loadProgressReadOnly(workspace, slug);
      const progressTask = progress?.tasks[id];
      const storedTask = await loadStoredTask(workspace, progressTask);
      const agent = asAgent(flags.agent) ?? storedTask?.agent ?? progressTask?.agent ?? "executor";
      const resolved = await resolveDispatchEngine({
        workspace,
        agent,
        flags,
        task: storedTask,
        progressTask,
      });
      const state = progress?.tasks[id]?.status ?? "new";
      const storedVerify =
        progress?.defaults && typeof progress.defaults["verify_command"] === "string"
          ? progress.defaults["verify_command"]
          : undefined;
      const verifyCommand = typeof flags.verify === "string" ? flags.verify : storedVerify;

      console.log(`dry-run: would dispatch ${id} of ${planPath} (slug: ${slug})`);
      console.log(`  engine=${resolved.engine} model=${resolved.model ?? "(adapter default)"} agent=${agent}`);
      console.log(`  verify=${verifyCommand ?? "(none)"}`);
      console.log(`  current status: ${state}`);
      if (state === "complete") {
        console.log("  real dispatch would skip this task because it is complete");
      } else if (state === "running") {
        console.log("  real dispatch would refuse because this task is already running");
      }
      return 0;
    }

    const { slug, progress } = await ensurePlanState(workspace, planPath);
    await saveCurrentPlan(workspace, planPath, slug);
    if (progress.tasks[id]?.status === "complete") {
      console.log(`${id} already complete; skipping`);
      return 0;
    }
    if (progress.tasks[id]?.status === "running") {
      if (await isLockStale(workspace, slug)) {
        const item = progress.tasks[id]!;
        if (!item.attempts) item.attempts = [];
        item.attempts.push({ type: "interrupted", detected_at: new Date().toISOString() });
        item.status = "failed";
        await saveProgress(workspace, slug, progress);
        console.log(
          `${id} was marked running but its dispatch process is gone (stale lock) — recorded as interrupted, redispatching`,
        );
      } else {
        throw new Error(`${id} is already running in another process; wait for it to finish`);
      }
    }

    const previousTaskState = progress.tasks[id];
    const storedTask = await loadStoredTask(workspace, previousTaskState);
    const agent = asAgent(flags.agent) ?? storedTask?.agent ?? previousTaskState?.agent ?? "executor";
    const resolved = await resolveDispatchEngine({
      workspace,
      agent,
      flags,
      task: storedTask,
      progressTask: previousTaskState,
    });
    const engine = resolved.engine;
    const model = resolved.model ?? undefined;

    const isGitRepo = existsSync(join(workspace, ".git"));
    if (!progress.base_commit && isGitRepo) {
      const head = await captureCommand("git", ["rev-parse", "HEAD"], { cwd: workspace });
      if (head.code === 0) progress.base_commit = head.stdout.trim();
    }

    // --verify persists as the plan default: set it once on the first dispatch and
    // every later task (including retries) is gated on the same command.
    const storedVerify =
      progress.defaults && typeof progress.defaults["verify_command"] === "string"
        ? (progress.defaults["verify_command"] as string)
        : undefined;
    const verifyCommand = typeof flags.verify === "string" ? flags.verify : storedVerify;
    if (typeof flags.verify === "string") {
      progress.defaults = { ...(progress.defaults ?? {}), verify_command: flags.verify };
    }

    await acquireLock(workspace, slug, id);

    try {
      const { task, taskDir, dispatchPath } = await prepareTask({
        workspace,
        planPath,
        slug,
        index,
        engine,
        model,
        agent,
        resolved,
        verifyCommand,
        net: flags.net === true,
      });

      progress.tasks[id] = {
        status: "running",
        engine: task.engine.name,
        agent: task.agent,
        model: task.engine.model,
        path: taskPathForProgress(workspace, taskDir),
        reviewed: previousTaskState?.reviewed ?? false,
        attempts: previousTaskState?.attempts ?? [],
      };
      await saveProgress(workspace, slug, progress);

      const item = progress.tasks[id];
      if (!item.attempts) item.attempts = [];
      const attemptNumber = item.attempts.length + 1;
      const attemptSlug = String(attemptNumber).padStart(3, "0") + "-" + task.engine.name + (task.engine.model ? "-" + task.engine.model : "");
      const attemptDir = join(taskDir, "attempts", attemptSlug);
      await ensureDir(attemptDir);

      const adapter = getAdapter(task.engine.name);
      let result: { exitCode: number; command: string };
      try {
        result = await adapter.run({
          workspace,
          taskDir,
          task,
          dispatchPath,
          stdoutPath: join(attemptDir, "stdout.jsonl"),
          finalPath: join(attemptDir, "final.md"),
          mode: "run",
        });
      } catch (error: unknown) {
        // Never leave the task stuck in "running": adapter crashes become failed attempts.
        result = {
          exitCode: 1,
          command: `adapter ${task.engine.name} threw: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      // Exit code 0 alone is not success: the engine must also have written a
      // valid report claiming DONE. Anything else needs orchestrator attention.
      const reportFile = join(taskDir, "report.yaml");
      let reportStatus: string | null = null;
      let reportParseError = false;
      const reportPresent = existsSync(reportFile);
      if (reportPresent) {
        try {
          const report = await readYaml<{ status?: string }>(reportFile);
          reportStatus = report?.status ?? null;
        } catch {
          // Engines write markdown-flavored prose; a scalar starting with a
          // backtick is invalid YAML and kills strict parsing. The gate only
          // needs the status field — extract it line-wise instead of failing.
          reportParseError = true;
          const text = await readText(reportFile);
          const match = text.match(/^status:\s*["']?([A-Za-z_][A-Za-z_ -]*?)["']?\s*$/m);
          reportStatus = match ? match[1] : "INVALID_YAML";
        }
      }
      const engineOk = result.exitCode === 0;
      const reportNorm = normalizeReportStatus(reportStatus);
      const workerHalted = reportNorm === "BLOCKED" || reportNorm === "NEEDS_CONTEXT";
      const reportOk = reportNorm === "DONE" || reportNorm === "DONE_WITH_CONCERNS";

      // Capture the worker's diff before verify runs, so build/test side effects
      // do not pollute the reviewed patch.
      let untracked: string[] = [];
      if (isGitRepo) {
        const diff = await captureCommand("git", ["diff", "HEAD"], { cwd: workspace });
        if (diff.code === 0) {
          await writeText(join(attemptDir, "diff.patch"), diff.stdout);
          await writeText(join(taskDir, "diff.patch"), diff.stdout);
        }
        const porcelain = await captureCommand("git", ["status", "--porcelain"], { cwd: workspace });
        if (porcelain.code === 0) {
          untracked = porcelain.stdout
            .split("\n")
            .filter((line) => line.startsWith("??"))
            .map((line) => line.slice(3).trim());
        }
      }

      // Executable acceptance gate: verify is the ground truth and runs whenever the
      // engine finished and the worker did not halt itself — independently of report
      // wording, so a sloppy report string can never mask (or fake) the real result.
      let verifyExit: number | null = null;
      if (engineOk && !workerHalted && verifyCommand) {
        verifyExit = await runShell(verifyCommand, {
          cwd: workspace,
          logPath: join(attemptDir, "verify.log"),
        });
      }
      const verifyOk = !verifyCommand || verifyExit === 0;

      const succeeded = engineOk && reportOk && verifyOk;
      const failureReason = succeeded
        ? null
        : !engineOk
          ? result.exitCode === 127
            ? `engine binary not found (${task.engine.name}) — not installed or not on PATH`
            : `engine exited ${result.exitCode}`
          : workerHalted
            ? `report status is ${reportNorm}`
            : !verifyOk
              ? `verify failed (exit ${verifyExit}): ${verifyCommand}`
              : !reportPresent
                ? "engine exited 0 but report.yaml was not written"
                : `report status is ${reportStatus} (unrecognized)`;

      const status = {
        task_id: task.id,
        attempt: attemptSlug,
        engine: task.engine,
        command: result.command,
        exit_code: result.exitCode,
        status: succeeded ? "completed" : "failed",
        network_access: task.network ?? false,
        report_present: reportPresent,
        report_status: reportNorm,
        report_status_raw: reportStatus,
        report_parse_error: reportParseError,
        verify_command: verifyCommand ?? null,
        verify_exit: verifyExit,
        failure_reason: failureReason,
        untracked_files: untracked,
      };
      await writeYaml(join(attemptDir, "status.yaml"), status);
      await writeYaml(join(taskDir, "status.yaml"), status);

      item.attempts.push({
        type: "run",
        id: attemptSlug,
        engine: task.engine.name,
        model: task.engine.model ?? null,
        exit_code: result.exitCode,
        report_status: reportNorm,
        verify_exit: verifyExit,
        finished_at: new Date().toISOString(),
      });
      progress.tasks[id].status = succeeded ? "complete" : "failed";
      await saveProgress(workspace, slug, progress);

      // Just-in-time guidance: print the orchestrator's next action with the result,
      // so correct behavior does not depend on it having read the playbook.
      const attemptRel = relative(workspace, attemptDir);
      if (succeeded) {
        console.log(`${id} complete.`);
        console.log(
          `next: review ${relative(workspace, join(taskDir, "diff.patch"))} against the plan's acceptance criteria, ` +
            `commit yourself (engines cannot write .git; include untracked_files from status.yaml), ` +
            `then dispatch the next task with 'next'.`,
        );
      } else {
        console.error(`${id} failed: ${failureReason}`);
        if (!engineOk) {
          if (result.exitCode === 127) {
            console.error(
              `hint: run 'sdd-worker doctor'. Install the ${task.engine.name} CLI or switch engine ` +
                `(retry with --engine <other>). Do not preflight engines yourself before dispatches.`,
            );
          } else {
            console.error(
              `hint: tail -n 50 ${attemptRel}/stdout.jsonl. Change engine, model, or constraints before any retry ` +
                `(max 2 retries, never retry unchanged). Full tree: sdd-worker guide triage`,
            );
          }
        } else if (workerHalted) {
          console.error(
            "hint: read report.yaml (concerns field) — the worker is blocked or asking a question. Amend the task constraints to answer it, then retry. Do not retry unchanged.",
          );
        } else if (!verifyOk) {
          console.error(
            `hint: tail -n 50 ${attemptRel}/verify.log — trust verify over the report's claim. ` +
              `Fix trivially yourself (direct-edit rule) or retry with the failing output appended as a constraint.`,
          );
        } else if (!reportPresent) {
          console.error(
            `hint: verify passed but report.yaml is missing. Choose ONE (never both): review diff.patch and accept ` +
              `('sdd-worker accept ${id} --note "..."' then commit), OR retry. If the work looks right, accept — do not re-run it.`,
          );
        } else {
          console.error(
            `hint: report status "${reportStatus}" is unrecognized and verify passed. Choose ONE (never both): review diff.patch ` +
              `and accept ('sdd-worker accept ${id} --note "..."' then commit), OR retry.`,
          );
        }
      }
      return succeeded ? 0 : result.exitCode === 0 ? 1 : result.exitCode;
    } finally {
      await releaseLock(workspace, slug);
    }
  }

  if (command === "retry") {
    const id = rest[0];
    if (!id) throw new Error("Usage: retry <TASK-ID> [--plan <plan.md>] [--engine codex] [--model gpt-5.4]");
    const index = Number(id.replace(/^TASK-/, ""));
    if (!Number.isFinite(index) || index < 1) throw new Error("invalid task id");
    const active = await resolveActivePlan(workspace, flags);
    const progress = await loadProgressFor(workspace, active.slug);
    const item = progress.tasks[id];
    if (!item) throw new Error(`${id} not found in progress.yaml`);
    item.status = "needs_retry";
    const agent = item.agent ?? "executor";
    const engine = typeof flags.engine === "string" ? asEngine(flags.engine) : undefined;
    const model = typeof flags.model === "string" ? flags.model : undefined;
    if (!item.attempts) item.attempts = [];
    item.attempts.push({
      type: "retry_requested",
      engine: engine ?? null,
      model: model ?? null,
      requested_at: new Date().toISOString(),
    });
    await saveProgress(workspace, active.slug, progress);
    return run([
      "run",
      progress.plan,
      "--task",
      id,
      ...(engine ? ["--engine", engine] : []),
      ...(model ? ["--model", model] : []),
      "--agent",
      agent,
      ...(flags.net === true ? ["--net"] : []),
    ]);
  }

  if (command === "review") {
    const id = rest[0];
    if (!id) throw new Error("Usage: review <TASK-ID> [--plan <plan.md>] [--engine codex] [--model gpt-5.5]");
    const active = await resolveActivePlan(workspace, flags);
    const progress = await loadProgressFor(workspace, active.slug);
    const item = progress.tasks[id];
    if (!item) throw new Error(`${id} not found in progress.yaml`);
    const taskDir = join(workspace, item.path);
    const task = await readYaml<TaskSpec>(join(taskDir, "task.yaml"));
    // Reviewer must not inherit the executor's task.yaml/attempt model —
    // only CLI flags and config layers apply to a review dispatch.
    const resolved = await resolveDispatchEngine({
      workspace,
      agent: "reviewer",
      flags,
    });
    const { reviewTask, dispatchPath } = await prepareReview({
      workspace,
      task,
      taskDir,
      engine: resolved.engine,
      model: resolved.model ?? undefined,
      resolved,
    });
    if (!item.attempts) item.attempts = [];
    const attemptNumber = item.attempts.length + 1;
    const attemptSlug = String(attemptNumber).padStart(3, "0") + "-review-" + reviewTask.engine.name + (reviewTask.engine.model ? "-" + reviewTask.engine.model : "");
    const attemptDir = join(taskDir, "attempts", attemptSlug);
    await ensureDir(attemptDir);

    const adapter = getAdapter(reviewTask.engine.name);
    const result = await adapter.run({
      workspace,
      taskDir,
      task: reviewTask,
      dispatchPath,
      stdoutPath: join(attemptDir, "stdout.jsonl"),
      finalPath: join(attemptDir, "final.md"),
      mode: "review",
    });
    item.attempts.push({
      type: "review",
      id: attemptSlug,
      engine: reviewTask.engine.name,
      model: reviewTask.engine.model ?? null,
      exit_code: result.exitCode,
      reviewed_at: new Date().toISOString(),
    });
    item.reviewed = result.exitCode === 0 && existsSync(join(taskDir, "review.yaml"));
    await saveProgress(workspace, active.slug, progress);
    return result.exitCode;
  }

  if (command === "accept") {
    const id = rest[0];
    if (!id) throw new Error('Usage: accept <TASK-ID> [--note "why"] [--plan <plan.md>]');
    const active = await resolveActivePlan(workspace, flags);
    const progress = await loadProgressFor(workspace, active.slug);
    const item = progress.tasks[id];
    if (!item) throw new Error(`${id} not found in progress.yaml`);
    if (item.status === "complete") {
      console.log(`${id} is already complete`);
      return 0;
    }
    item.status = "complete";
    if (!item.attempts) item.attempts = [];
    item.attempts.push({
      type: "orchestrator-accept",
      note: typeof flags.note === "string" ? flags.note : "accepted manually after diff review",
      accepted_at: new Date().toISOString(),
    });
    await saveProgress(workspace, active.slug, progress);
    console.log(`${id} accepted (complete).`);
    console.log("next: commit the accepted work if not committed yet, then dispatch the next task with 'next'.");
    return 0;
  }

  if (command === "set") {
    const [id, key, value] = rest;
    if (!id || !key || !value) throw new Error("Usage: set <TASK-ID> engine|model <value> [--plan <plan.md>]");
    const active = await resolveActivePlan(workspace, flags);
    const progress = await loadProgressFor(workspace, active.slug);
    const item = progress.tasks[id];
    if (!item) throw new Error(`${id} not found in progress.yaml`);
    if (key === "engine") item.engine = asEngine(value) ?? item.engine;
    else if (key === "model") item.model = value;
    else throw new Error("key must be engine or model");
    await saveProgress(workspace, active.slug, progress);
    console.log(`updated ${id} ${key}=${value}`);
    return 0;
  }

  throw new Error(`unknown command: ${command}`);
}

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
