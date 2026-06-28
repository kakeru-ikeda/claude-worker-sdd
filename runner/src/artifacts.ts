import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { AgentName, EngineName, Progress, TaskSpec } from "./types.js";
import { ensureDir, readYaml, writeText, writeYaml } from "./fsutil.js";
import { defaultTitle, taskDirName, taskId, writeBrief } from "./superpowers.js";

const DEFAULT_ENGINE: EngineName = "codex";

export function sddRoot(workspace: string): string {
  return join(workspace, ".superpowers", "sdd");
}

export function progressPath(workspace: string): string {
  return join(sddRoot(workspace), "progress.yaml");
}

export async function loadProgress(workspace: string, planPath: string): Promise<Progress> {
  const path = progressPath(workspace);
  if (existsSync(path)) return readYaml<Progress>(path);
  return { plan: planPath, base_commit: null, tasks: {} };
}

export async function saveProgress(workspace: string, progress: Progress): Promise<void> {
  await writeYaml(progressPath(workspace), progress);
}

export async function prepareTask(input: {
  workspace: string;
  planPath: string;
  index: number;
  engine?: EngineName;
  model?: string;
  agent?: AgentName;
}): Promise<{ task: TaskSpec; taskDir: string; dispatchPath: string }> {
  const id = taskId(input.index);
  const dir = join(sddRoot(input.workspace), "tasks", taskDirName(input.index));
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
      model: input.model ?? (input.engine === "codex" || !input.engine ? "gpt-5.4" : null),
      agent: input.engine === "opencode" ? input.agent ?? "executor" : null,
    },
    worktree: { enabled: false, base: null, path: null },
    acceptance: ["Complete the scoped task brief", "Write the required YAML report"],
    constraints: [
      "Implement only this task",
      "Do not redesign architecture",
      "Ask/block if requirements are ambiguous",
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
      summary: "Read task.yaml and brief.md, execute the scoped task, then write report.yaml.",
      report_schema: resolve(input.workspace, "sdd/schemas/report.schema.json"),
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
      model: input.model ?? (input.engine === "codex" || !input.engine ? "gpt-5.5" : null),
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
      review_schema: resolve(input.workspace, "sdd/schemas/review.schema.json"),
    },
  });

  return { reviewTask, dispatchPath };
}

export function taskPathForProgress(workspace: string, taskDir: string): string {
  return relative(workspace, taskDir);
}

