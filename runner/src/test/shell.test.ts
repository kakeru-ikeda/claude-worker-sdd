import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { resolveExecutable } from "../shell.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("resolves a Windows executable using PATH and PATHEXT", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sdd-worker-shell-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "foo.cmd");
  await writeFile(executable, "@echo off\r\n");

  assert.equal(
    resolveExecutable("foo", { PATH: directory, PATHEXT: ".CMD" }, "win32"),
    executable,
  );
});

test("passes executable names through on non-Windows platforms", () => {
  assert.equal(resolveExecutable("foo", {}, "linux"), "foo");
  assert.equal(resolveExecutable("./foo", {}, "win32"), "./foo");
});
