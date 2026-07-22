import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { findTaskBriefScript } from "../plan.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "sdd-worker-plan-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function addTaskBrief(root: string, version: string): Promise<string> {
  const script = join(root, version, "scripts", "task-brief");
  await mkdir(join(root, version, "scripts"), { recursive: true });
  await writeFile(script, "#!/bin/sh\n");
  await chmod(script, 0o755);
  return script;
}

test("findTaskBriefScript searches version directories from newest to oldest", async () => {
  const root = await temporaryDirectory();
  await addTaskBrief(root, "5.9.0");
  const newest = await addTaskBrief(root, "5.10.0");
  await addTaskBrief(root, "5.10.0-beta.1");
  await addTaskBrief(root, "latest");

  assert.equal(findTaskBriefScript([root]), newest);
});

test("findTaskBriefScript keeps the direct plugin script as the first candidate", async () => {
  const root = await temporaryDirectory();
  await addTaskBrief(root, "5.10.0");
  const direct = join(root, "scripts", "task-brief");
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(direct, "#!/bin/sh\n");

  assert.equal(findTaskBriefScript([root]), direct);
});
