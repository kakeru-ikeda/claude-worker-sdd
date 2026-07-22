import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, test } from "node:test";
import { saveUserConfig } from "../config.js";
import { isReady, readyGateError, shouldGateCommand } from "../doctor.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "sdd-worker-ready-gate-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("dispatch commands are gated until injected user config has ready", async () => {
  const root = await temporaryDirectory();
  const configPath = join(root, "config.yaml");

  assert.equal(await isReady(configPath), false);
  assert.equal(await shouldGateCommand("next", configPath), true);

  await saveUserConfig({ ready: { engine: "codex", checked_at: "2026-07-23T00:00:00.000Z" } }, configPath);

  assert.equal(await isReady(configPath), true);
  assert.equal(await shouldGateCommand("next", configPath), false);
});

test("non-dispatch commands bypass the Ready gate", async () => {
  const root = await temporaryDirectory();
  const configPath = join(root, "config.yaml");

  assert.equal(await shouldGateCommand("doctor", configPath), false);
  assert.equal(await shouldGateCommand("status", configPath), false);
  assert.equal(readyGateError(), "Not ready. Run `sdd-worker setup` first.");
});
