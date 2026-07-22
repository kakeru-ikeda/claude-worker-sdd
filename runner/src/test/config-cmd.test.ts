import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { getPath, resolveEffective, saveUserConfig, setPath } from "../config.js";
import type { SddConfig } from "../config.js";
import { writeYaml } from "../fsutil.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "sdd-worker-config-cmd-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("getPath and setPath read and create nested dotted paths", () => {
  const config: Record<string, unknown> = {};

  setPath(config, "agents.reviewer.model", "configured-model");
  setPath(config, "agents.reviewer.effort", "medium");

  assert.equal(getPath(config, "agents.reviewer.model"), "configured-model");
  assert.equal(getPath(config, "agents.reviewer.effort"), "medium");
  assert.equal(getPath(config, "agents.executor.model"), undefined);
});

test("a config set value is used by resolveEffective", async () => {
  const workspace = await temporaryDirectory();
  const userConfigPath = join(workspace, "user", "config.yaml");
  const config: SddConfig = {};

  setPath(config as unknown as Record<string, unknown>, "agents.reviewer.model", "configured-model");
  await saveUserConfig(config, userConfigPath);

  const resolved = await resolveEffective({
    workspace,
    agent: "reviewer",
    userConfigPath,
  });

  assert.equal(resolved.model, "configured-model");
  assert.equal(resolved.source.model, "user");
});

test("project config remains ahead of a user config value", async () => {
  const workspace = await temporaryDirectory();
  const userConfigPath = join(workspace, "user", "config.yaml");
  const user: SddConfig = {};
  const project: SddConfig = {};

  setPath(user as unknown as Record<string, unknown>, "agents.executor.model", "user-model");
  setPath(project as unknown as Record<string, unknown>, "agents.executor.model", "project-model");
  await saveUserConfig(user, userConfigPath);
  await writeYaml(join(workspace, ".sdd", "config.yaml"), project);

  const resolved = await resolveEffective({
    workspace,
    agent: "executor",
    userConfigPath,
  });

  assert.equal(resolved.model, "project-model");
  assert.equal(resolved.source.model, "project");
});
