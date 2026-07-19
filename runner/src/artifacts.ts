import { existsSync } from "node:fs";
import { rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentName, EngineName, Progress, TaskSpec } from "./types.js";
import { ensureDir, readYaml, writeText, writeYaml } from "./fsutil.js";
import { defaultTitle, taskDirName, taskId, writeBrief } from "./plan.js";

const DEFAULT_ENGINE: EngineName = "codex";

// Schemas ship with the runner, not with the consumer repo: resolve them
// relative to this module (dist/artifacts.js -> repo root -> sdd/schemas).
const RUNNER_REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function schemaPath(name: string): string {
  return join(RUNNER_REPO_ROOT, "sdd", "schemas", name);
}

export function sddRoot(workspace: string): string {
  return join(workspace, ".sdd");
}

export function planSlug(planPath: string): string {
  const base = basename(planPath).replace(/\.md$/i, "");
  const slug = base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "plan";
}

export function planRoot(workspace: string, slug: string): string {
  return join(sddRoot(workspace), "plans", slug);
}

export function progressPath(workspace: string, slug: string): string {
  return join(planRoot(workspace, slug), "progress.yaml");
}

export function normalizePlanPath(workspace: string, planPath: string): string {
  return relative(workspace, resolve(workspace, planPath)) || planPath;
}

export function currentPlanPointerPath(workspace: string): string {
  return join(sddRoot(workspace), "current-plan.yaml");
}

export async function saveCurrentPlan(workspace: string, plan: string, slug: string): Promise<void> {
  await writeYaml(currentPlanPointerPath(workspace), { plan, slug });
}

export async function loadCurrentPlan(
  workspace: string,
): Promise<{ plan: string; slug: string } | null> {
  const path = currentPlanPointerPath(workspace);
  if (!existsSync(path)) return null;
  return readYaml<{ plan: string; slug: string }>(path);
}

// Move the legacy state root to the neutral state root once per workspace.
export async function migrateStateRoot(workspace: string): Promise<void> {
  const oldRoot = join(workspace, ".superpowers", "sdd");
  const newRoot = sddRoot(workspace);
  if (existsSync(newRoot) || !existsSync(oldRoot)) return;

  await rename(oldRoot, newRoot);
  try {
    await rmdir(join(workspace, ".superpowers"));
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") throw error;
  }
}

// Pre-plans layout kept progress.yaml and tasks/ directly under the state root,
// so a second plan silently inherited the first plan's completed tasks. Move any
// legacy state into plans/<slug>/ before touching progress.
export async function migrateLegacyLayout(workspace: string): Promise<string | null> {
  const legacyProgressPath = join(sddRoot(workspace), "progress.yaml");
  if (!existsSync(legacyProgressPath)) return null;

  const legacy = await readYaml<Progress>(legacyProgressPath);
  const slug = planSlug(legacy.plan || "legacy");
  let dest = planRoot(workspace, slug);
  if (existsSync(dest)) {
    dest = `${dest}-legacy-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  }
  await ensureDir(dest);

  const destTasksRel = relative(workspace, join(dest, "tasks"));
  for (const item of Object.values(legacy.tasks ?? {})) {
    if (item.path) {
      item.path = item.path.replace(/^\.superpowers\/sdd\/tasks\//, `${destTasksRel}/`);
    }
  }
  await writeYaml(join(dest, "progress.yaml"), legacy);
  await rm(legacyProgressPath);

  const legacyTasks = join(sddRoot(workspace), "tasks");
  if (existsSync(legacyTasks)) await rename(legacyTasks, join(dest, "tasks"));
  return dest;
}

// Load (or initialize) the per-plan progress state. If the slug directory holds
// progress for a *different* plan file with the same basename, archive it and
// start fresh instead of inheriting its tasks.
export async function ensurePlanState(
  workspace: string,
  planPath: string,
): Promise<{ slug: string; progress: Progress }> {
  await migrateLegacyLayout(workspace);
  const slug = planSlug(planPath);
  const path = progressPath(workspace, slug);
  if (existsSync(path)) {
    const existing = await readYaml<Progress>(path);
    if (normalizePlanPath(workspace, existing.plan ?? "") === planPath) {
      return { slug, progress: existing };
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await rename(planRoot(workspace, slug), `${planRoot(workspace, slug)}-archived-${stamp}`);
  }
  return { slug, progress: { plan: planPath, base_commit: null, tasks: {} } };
}

export function lockPath(workspace: string, slug: string): string {
  return join(planRoot(workspace, slug), ".lock");
}

// Enforces the single-writer rule at the script level: one executor run per plan.
// A lock whose pid is no longer alive is treated as stale and replaced.
export async function acquireLock(workspace: string, slug: string, taskIdValue: string): Promise<void> {
  const path = lockPath(workspace, slug);
  if (existsSync(path)) {
    const lock = await readYaml<{ pid?: number; task_id?: string; started_at?: string }>(path);
    let alive = false;
    if (lock?.pid) {
      try {
        process.kill(lock.pid, 0);
        alive = true;
      } catch (error: unknown) {
        // EPERM = the process exists but belongs to another user: still alive.
        alive = (error as NodeJS.ErrnoException).code === "EPERM";
      }
    }
    if (alive) {
      throw new Error(
        `another run is active for this plan (${lock.task_id ?? "?"}, pid ${lock.pid}, since ${lock.started_at ?? "?"}). ` +
          `Wait for it to finish, or delete ${path} if it is stale.`,
      );
    }
  }
  await writeYaml(path, { pid: process.pid, task_id: taskIdValue, started_at: new Date().toISOString() });
}

export async function releaseLock(workspace: string, slug: string): Promise<void> {
  await rm(lockPath(workspace, slug), { force: true });
}

export async function loadProgressFor(workspace: string, slug: string): Promise<Progress> {
  const path = progressPath(workspace, slug);
  if (!existsSync(path)) {
    throw new Error(`No progress found for plan slug "${slug}" (${path})`);
  }
  return readYaml<Progress>(path);
}

export async function saveProgress(
  workspace: string,
  slug: string,
  progress: Progress,
): Promise<void> {
  await writeYaml(progressPath(workspace, slug), progress);
}

export async function prepareTask(input: {
  workspace: string;
  planPath: string;
  slug: string;
  index: number;
  engine?: EngineName;
  model?: string;
  agent?: AgentName;
  verifyCommand?: string;
  net?: boolean;
}): Promise<{ task: TaskSpec; taskDir: string; dispatchPath: string }> {
  const id = taskId(input.index);
  const dir = join(planRoot(input.workspace, input.slug), "tasks", taskDirName(input.index));
  await ensureDir(dir);

  const briefPath = join(dir, "brief.md");
  await writeBrief({
    workspace: input.workspace,
    planPath: input.planPath,
    index: input.index,
    outPath: briefPath,
  });

  const task: TaskSpec = {
    id,
    title: defaultTitle(input.planPath, input.index),
    source_plan: input.planPath,
    source_task_index: input.index,
    agent: input.agent ?? "executor",
    engine: {
      name: input.engine ?? DEFAULT_ENGINE,
      runner: input.engine === "opencode" ? "run" : "exec",
      model: input.model ?? (input.engine === "codex" || !input.engine ? "gpt-5.6-luna" : null),
      effort: input.engine === "codex" || !input.engine ? "xhigh" : null,
      agent: input.engine === "opencode" ? input.agent ?? "executor" : null,
    },
    worktree: { enabled: false, base: null, path: null },
    ...(input.net ? { network: true } : {}),
    ...(input.verifyCommand ? { verify: { commands: [input.verifyCommand] } } : {}),
    acceptance: ["Complete the scoped task brief", "Write the required YAML report"],
    constraints: [
      "Implement only this task",
      "Do not redesign architecture",
      "Ask/block if requirements are ambiguous",
      input.net
        ? "Outbound network access is ENABLED for this task only — install exactly the dependencies the task names, nothing else"
        : "The sandbox has no network access: if a new dependency is required, do NOT fake, vendor, or shim it — write report.yaml with status BLOCKED naming the package and stop",
      "Do not start dev servers or bind ports (the sandbox forbids it): browser/visual verification is the orchestrator's job via the plan's verify command outside the sandbox",
      "Never run git add/commit/push — .git is read-only for workers and the orchestrator commits; even if the plan text says to commit, skip that step silently and list the files in the report instead",
    ],
  };

  const taskPath = join(dir, "task.yaml");
  const dispatchPath = join(dir, "dispatch.yaml");
  const reportPath = join(dir, "report.yaml");

  await writeYaml(taskPath, task);
  await writeYaml(dispatchPath, {
    task_id: task.id,
    from: "claude-orchestrator",
    to_agent: task.agent,
    engine: task.engine,
    role_contract: {
      role: task.agent,
      rules: task.constraints,
    },
    inputs: {
      task_file: taskPath,
      brief_file: briefPath,
    },
    outputs: {
      report_file: reportPath,
      status_file: join(dir, "status.yaml"),
    },
    instructions: {
      summary:
        "Read task.yaml and brief.md, execute the scoped task, then write report.yaml. " +
        "The report's status field MUST be exactly one of: DONE, DONE_WITH_CONCERNS, BLOCKED, NEEDS_CONTEXT. " +
        "In report.yaml, double-quote any string value that starts with a backtick or other YAML-reserved character.",
      report_status_allowed: ["DONE", "DONE_WITH_CONCERNS", "BLOCKED", "NEEDS_CONTEXT"],
      report_schema: schemaPath("report.schema.json"),
    },
  });

  await writeText(join(dir, "README.md"), `# ${task.id}\n\nArtifacts for ${task.title}.\n`);

  return { task, taskDir: dir, dispatchPath };
}


export async function prepareReview(input: {
  workspace: string;
  task: TaskSpec;
  taskDir: string;
  engine?: EngineName;
  model?: string;
}): Promise<{ reviewTask: TaskSpec; dispatchPath: string }> {
  const reviewTask: TaskSpec = {
    ...input.task,
    agent: "reviewer",
    engine: {
      name: input.engine ?? input.task.engine.name,
      runner: input.engine === "opencode" ? "run" : "exec",
      model: input.model ?? (input.engine === "codex" || !input.engine ? "gpt-5.6-sol" : null),
      effort: input.engine === "codex" || !input.engine ? "medium" : null,
      agent: input.engine === "opencode" ? "reviewer" : null,
    },
  };

  const dispatchPath = join(input.taskDir, "review-dispatch.yaml");
  await writeYaml(dispatchPath, {
    task_id: input.task.id,
    from: "claude-orchestrator",
    to_agent: "reviewer",
    engine: reviewTask.engine,
    role_contract: {
      role: "reviewer",
      rules: [
        "You are a read-only reviewer",
        "Review spec compliance first, then code quality",
        "Do not edit files",
        "Do not implement fixes",
        "Write review.yaml",
      ],
    },
    inputs: {
      task_file: join(input.taskDir, "task.yaml"),
      brief_file: join(input.taskDir, "brief.md"),
      report_file: join(input.taskDir, "report.yaml"),
      status_file: join(input.taskDir, "status.yaml"),
    },
    outputs: {
      review_file: join(input.taskDir, "review.yaml"),
    },
    instructions: {
      summary: "Review this task implementation. Write review.yaml using the review schema.",
      review_schema: schemaPath("review.schema.json"),
    },
  });

  return { reviewTask, dispatchPath };
}

export function taskPathForProgress(workspace: string, taskDir: string): string {
  return relative(workspace, taskDir);
}
