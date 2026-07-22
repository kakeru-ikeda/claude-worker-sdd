import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  loadProjectConfig,
  loadShippedAdapterMeta,
  loadShippedAgentDefaults,
  loadUserConfig,
  resolveEffective,
  saveUserConfig,
} from "../config.js";
import { writeYaml } from "../fsutil.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "sdd-worker-config-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("loads shipped agent and adapter YAML metadata", async () => {
  const executor = await loadShippedAgentDefaults("executor");
  assert.deepEqual(executor, {
    default_model: { codex: "gpt-5.6-luna" },
    default_effort: { codex: "xhigh" },
  });

  const codex = await loadShippedAdapterMeta("codex");
  assert.equal(codex.name, "codex");
});

test("loads and saves user config through an injected path", async () => {
  const root = await temporaryDirectory();
  const path = join(root, "user", "config.yaml");
  const config = { agents: { executor: { engine: "opencode" as const, model: "user-model" } } };

  assert.deepEqual(await loadUserConfig(path), {});
  await saveUserConfig(config, path);
  assert.deepEqual(await loadUserConfig(path), config);
});

test("resolves cli over task, attempt, project, user, and shipped values", async () => {
  const workspace = await temporaryDirectory();
  const userPath = join(workspace, "user-config.yaml");
  await saveUserConfig(
    {
      agents: {
        executor: { engine: "opencode", model: "user-model", effort: "user-effort" },
      },
    },
    userPath,
  );
  await writeYaml(join(workspace, ".sdd", "config.yaml"), {
    agents: {
      executor: { engine: "gemini", model: "project-model", effort: "project-effort" },
    },
  });

  const result = await resolveEffective({
    workspace,
    agent: "executor",
    userConfigPath: userPath,
    cli: { engine: "codex", model: "cli-model" },
    task: { engine: "opencode", model: "task-model", effort: "task-effort" },
    attempt: { engine: "gemini", model: "attempt-model" },
  });

  assert.deepEqual(result, {
    engine: "codex",
    model: "cli-model",
    effort: "task-effort",
    source: { engine: "cli", model: "cli", effort: "task" },
  });
});

test("resolves project config ahead of user config", async () => {
  const workspace = await temporaryDirectory();
  const userPath = join(workspace, "user-config.yaml");
  await saveUserConfig(
    {
      agents: {
        executor: { engine: "opencode", model: "user-model", effort: "user-effort" },
      },
    },
    userPath,
  );
  await writeYaml(join(workspace, ".sdd", "config.yaml"), {
    agents: {
      executor: { engine: "codex", model: "project-model", effort: "project-effort" },
    },
  });

  const result = await resolveEffective({ workspace, agent: "executor", userConfigPath: userPath });

  assert.deepEqual(result, {
    engine: "codex",
    model: "project-model",
    effort: "project-effort",
    source: { engine: "project", model: "project", effort: "project" },
  });
});

test("uses shipped defaults for executor and reviewer when no overrides exist", async () => {
  const workspace = await temporaryDirectory();

  assert.deepEqual(await resolveEffective({ workspace, agent: "executor", userConfigPath: join(workspace, "missing.yaml") }), {
    engine: "codex",
    model: "gpt-5.6-luna",
    effort: "xhigh",
    source: { engine: "shipped", model: "shipped", effort: "shipped" },
  });
  assert.deepEqual(await resolveEffective({ workspace, agent: "reviewer", userConfigPath: join(workspace, "missing.yaml") }), {
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "medium",
    source: { engine: "shipped", model: "shipped", effort: "shipped" },
  });
});

test("does not expose codex effort for another engine", async () => {
  const workspace = await temporaryDirectory();
  const result = await resolveEffective({
    workspace,
    agent: "executor",
    task: { engine: "opencode", effort: "task-effort" },
    userConfigPath: join(workspace, "missing.yaml"),
  });

  assert.equal(result.engine, "opencode");
  assert.equal(result.effort, null);
  assert.equal(result.source.effort, "task");
});
