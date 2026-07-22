import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../shell.js";
import type { EngineAdapter } from "./base.js";

function modelIds(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((item) => modelIds(item));
  }
  if (!value || typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  if (typeof record.id === "string") return [record.id];
  if (typeof record.slug === "string") return [record.slug];

  for (const key of ["models", "data"]) {
    if (key in record) return modelIds(record[key]);
  }
  return [];
}

function uniqueModels(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}

async function modelsFromCache(): Promise<string[] | null> {
  try {
    const text = await readFile(join(homedir(), ".codex", "models_cache.json"), "utf8");
    const parsed: unknown = JSON.parse(text);
    const models = uniqueModels(modelIds(parsed));
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

async function modelsFromApi(): Promise<string[] | null> {
  if (!process.env.OPENAI_API_KEY) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const body: unknown = await response.json();
    const models = uniqueModels(modelIds(body));
    return models.length > 0 ? models : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export const codexAdapter: EngineAdapter = {
  name: "codex",
  async run(input) {
    const sandbox = input.mode === "review" ? "read-only" : "workspace-write";
    const args = [
      "exec",
      "--sandbox",
      sandbox,
      "--json",
      "-o",
      input.finalPath,
    ];

    if (input.task.engine.model) {
      args.push("--model", input.task.engine.model);
    }

    if (input.task.engine.effort) {
      args.push("-c", `model_reasoning_effort="${input.task.engine.effort}"`);
    }

    // Opt-in per-task network (sdd-worker --net): outbound only, FS/.git
    // protections stay intact.
    if (input.task.network && input.mode === "run") {
      args.push("-c", "sandbox_workspace_write.network_access=true");
    }

    args.push(
      `Read ${input.dispatchPath} and execute it completely. Write the required YAML output file before finishing.`,
    );

    const exitCode = await runCommand("codex", args, {
      cwd: input.workspace,
      stdoutPath: input.stdoutPath,
      stderrToStdout: true,
    });

    return { exitCode, command: ["codex", ...args].join(" ") };
  },
  async listModels() {
    const cliModels = await modelsFromCache();
    if (cliModels) return { models: cliModels, source: "cli" as const };

    const apiModels = await modelsFromApi();
    if (apiModels) return { models: apiModels, source: "api" as const };

    return null;
  },
};
