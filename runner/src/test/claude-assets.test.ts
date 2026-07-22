import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, test } from "node:test";
import { assetPath } from "../paths.js";
import { installAll } from "../claude-assets.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "sdd-worker-claude-assets-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("installAll is idempotent and preserves existing settings and CLAUDE.md content", async () => {
  const targetDir = await temporaryDirectory();
  const existingSettings = {
    permissions: { allow: ["Read"] },
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "existing-command" }] }],
    },
  };
  await mkdir(dirname(join(targetDir, "settings.json")), { recursive: true });
  await writeFile(join(targetDir, "settings.json"), `${JSON.stringify(existingSettings)}\n`);
  await writeFile(join(targetDir, "CLAUDE.md"), "# Existing guidance\n");

  await installAll(targetDir);
  const firstSettings = await readJson(join(targetDir, "settings.json"));
  const firstClaude = await readFile(join(targetDir, "CLAUDE.md"), "utf8");

  await installAll(targetDir);
  const secondSettings = await readJson(join(targetDir, "settings.json"));
  const secondClaude = await readFile(join(targetDir, "CLAUDE.md"), "utf8");

  assert.deepEqual(secondSettings, firstSettings);
  assert.equal(secondClaude, firstClaude);
  assert.deepEqual(secondSettings.permissions, existingSettings.permissions);
  assert.deepEqual(secondSettings.hooks.SessionStart, existingSettings.hooks.SessionStart);
  assert.equal(
    countOccurrences(secondClaude, "<!-- sdd-worker:begin -->"),
    1,
  );
  assert.equal(
    countOccurrences(secondClaude, "<!-- sdd-worker:end -->"),
    1,
  );
  assert.match(secondClaude, /# Existing guidance/);
  assert.ok(await readFile(join(targetDir, "skills", "worker-sdd", "SKILL.md"), "utf8"));
  assert.ok(await readFile(join(targetDir, "agents", "planner.md"), "utf8"));

  const hookCommand = `node ${join(targetDir, "hooks", "deny-superpowers-exec.mjs")}`;
  const preToolUse = secondSettings.hooks.PreToolUse as Array<Record<string, unknown>>;
  assert.equal(
    preToolUse.filter((entry) =>
      Array.isArray(entry.hooks) &&
      (entry.hooks as Array<Record<string, unknown>>).some((hook) => hook.command === hookCommand),
    ).length,
    1,
  );
});

test("the Node hook is a standalone Node asset with the expected blocked skills", async () => {
  const hookPath = assetPath("claude", "hooks", "deny-superpowers-exec.mjs");
  const hook = await readFile(hookPath, "utf8");
  assert.match(hook, /^#!\/usr\/bin\/env node/);
  assert.match(hook, /superpowers:executing-plans/);
  assert.match(hook, /process\.exitCode = 2/);
});

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
