#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAdapter } from "./adapters/index.js";
import { loadProgress, prepareReview, prepareTask, saveProgress, taskPathForProgress } from "./artifacts.js";
import { ensureDir, readYaml, writeYaml } from "./fsutil.js";
import { findWorkspace, taskId } from "./superpowers.js";
import type { AgentName, EngineName, TaskSpec } from "./types.js";

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

async function run(argv: string[]): Promise<number> {
  const { command, rest, flags } = parseArgs(argv);
  const workspace = await findWorkspace();

  if (command === "help" || command === "--help") {
    console.log("Usage: sdd-worker run <plan.md> [--task TASK-001] [--engine codex] [--model gpt-5.4]");
    console.log("       sdd-worker review TASK-001 [--engine codex] [--model gpt-5.5]");
    console.log("       sdd-worker retry TASK-001 [--engine codex] [--model gpt-5.4]");
    console.log("       sdd-worker status");
    console.log("       sdd-worker set <TASK-ID> engine|model <value>");
    return 0;
  }

  if (command === "status") {
    const path = join(workspace, ".superpowers", "sdd", "progress.yaml");
    if (!existsSync(path)) {
      console.log("No .superpowers/sdd/progress.yaml found");
      return 0;
    }
    console.log(path);
    return 0;
  }

  if (command === "run" || command === "one-shot") {
    const planPath = rest[0];
    if (!planPath) throw new Error("plan path is required");
    const index = flags.task && typeof flags.task === "string"
      ? Number(flags.task.replace(/^TASK-/, ""))
      : 1;
    if (!Number.isFinite(index) || index < 1) throw new Error("invalid task id/index");

    const engine = asEngine(flags.engine) ?? "codex";
    const agent = asAgent(flags.agent) ?? "executor";
    const model = typeof flags.model === "string" ? flags.model : undefined;

    const progress = await loadProgress(workspace, planPath);
    const id = taskId(index);
    if (progress.tasks[id]?.status === "complete") {
      console.log(`${id} already complete; skipping`);
      return 0;
    }

    const { task, taskDir, dispatchPath } = await prepareTask({
      workspace,
      planPath,
      index,
      engine,
      model,
      agent,
    });

    const previousTaskState = progress.tasks[id];
    progress.tasks[id] = {
      status: "running",
      engine: task.engine.name,
      agent: task.agent,
      model: task.engine.model,
      path: taskPathForProgress(workspace, taskDir),
      reviewed: previousTaskState?.reviewed ?? false,
      attempts: previousTaskState?.attempts ?? [],
    };
    await saveProgress(workspace, progress);

    const item = progress.tasks[id];
    if (!item.attempts) item.attempts = [];
    const attemptNumber = item.attempts.length + 1;
    const attemptSlug = String(attemptNumber).padStart(3, "0") + "-" + task.engine.name + (task.engine.model ? "-" + task.engine.model : "");
    const attemptDir = join(taskDir, "attempts", attemptSlug);
    await ensureDir(attemptDir);

    const adapter = getAdapter(task.engine.name);
    const result = await adapter.run({
      workspace,
      taskDir,
      task,
      dispatchPath,
      stdoutPath: join(attemptDir, "stdout.jsonl"),
      finalPath: join(attemptDir, "final.md"),
      mode: "run",
    });

    const status = {
      task_id: task.id,
      attempt: attemptSlug,
      engine: task.engine,
      command: result.command,
      exit_code: result.exitCode,
      status: result.exitCode === 0 ? "completed" : "failed",
    };
    await writeYaml(join(attemptDir, "status.yaml"), status);
    await writeYaml(join(taskDir, "status.yaml"), status);

    item.attempts.push({
      type: "run",
      id: attemptSlug,
      engine: task.engine.name,
      model: task.engine.model ?? null,
      exit_code: result.exitCode,
      finished_at: new Date().toISOString(),
    });
    progress.tasks[id].status = result.exitCode === 0 ? "complete" : "failed";
    await saveProgress(workspace, progress);
    return result.exitCode;
  }

  if (command === "retry") {
    const id = rest[0];
    if (!id) throw new Error("Usage: retry <TASK-ID> [--engine codex] [--model gpt-5.4]");
    const index = Number(id.replace(/^TASK-/, ""));
    if (!Number.isFinite(index) || index < 1) throw new Error("invalid task id");
    const progress = await loadProgress(workspace, "");
    const item = progress.tasks[id];
    if (!item) throw new Error(`${id} not found in progress.yaml`);
    item.status = "needs_retry";
    const engine = asEngine(flags.engine) ?? item.engine ?? "codex";
    const model = typeof flags.model === "string" ? flags.model : item.model ?? undefined;
    const agent = item.agent ?? "executor";
    if (!item.attempts) item.attempts = [];
    item.attempts.push({
      type: "retry_requested",
      engine,
      model: model ?? null,
      requested_at: new Date().toISOString(),
    });
    await saveProgress(workspace, progress);
    return run([
      "run",
      progress.plan,
      "--task",
      id,
      "--engine",
      engine,
      ...(model ? ["--model", model] : []),
      "--agent",
      agent,
    ]);
  }

  if (command === "review") {
    const id = rest[0];
    if (!id) throw new Error("Usage: review <TASK-ID> [--engine codex] [--model gpt-5.5]");
    const progress = await loadProgress(workspace, "");
    const item = progress.tasks[id];
    if (!item) throw new Error(`${id} not found in progress.yaml`);
    const taskDir = join(workspace, item.path);
    const task = await readYaml<TaskSpec>(join(taskDir, "task.yaml"));
    const engine = asEngine(flags.engine) ?? item.engine ?? task.engine.name;
    const model = typeof flags.model === "string" ? flags.model : undefined;
    const { reviewTask, dispatchPath } = await prepareReview({ workspace, task, taskDir, engine, model });
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
    item.reviewed = result.exitCode === 0;
    await saveProgress(workspace, progress);
    return result.exitCode;
  }

  if (command === "set") {
    const [id, key, value] = rest;
    if (!id || !key || !value) throw new Error("Usage: set <TASK-ID> engine|model <value>");
    const progress = await loadProgress(workspace, "");
    const item = progress.tasks[id];
    if (!item) throw new Error(`${id} not found in progress.yaml`);
    if (key === "engine") item.engine = asEngine(value) ?? item.engine;
    else if (key === "model") item.model = value;
    else throw new Error("key must be engine or model");
    await saveProgress(workspace, progress);
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

