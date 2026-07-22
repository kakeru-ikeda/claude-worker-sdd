import { strict as assert } from "node:assert";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assetPath,
  claudeUserDir,
  modelsCachePath,
  packageRoot,
  userConfigDir,
  userConfigPath,
} from "../paths.js";

test("userConfigDir uses APPDATA on Windows", () => {
  assert.equal(
    userConfigDir({ APPDATA: "C:/Users/test/AppData/Roaming" }, "win32"),
    join("C:/Users/test/AppData/Roaming", "sdd-worker"),
  );
});

test("userConfigDir uses XDG_CONFIG_HOME on non-Windows platforms", () => {
  assert.equal(
    userConfigDir({ XDG_CONFIG_HOME: "/tmp/test-config" }, "linux"),
    join("/tmp/test-config", "sdd-worker"),
  );
});

test("userConfigDir falls back to platform defaults", () => {
  assert.equal(
    userConfigDir({}, "win32"),
    join(homedir(), "AppData", "Roaming", "sdd-worker"),
  );
  assert.equal(
    userConfigDir({}, "darwin"),
    join(homedir(), ".config", "sdd-worker"),
  );
});

test("user config helper paths are rooted in userConfigDir", () => {
  const configDir = userConfigDir();
  assert.equal(userConfigPath(), join(configDir, "config.yaml"));
  assert.equal(modelsCachePath(), join(configDir, "models-cache.yaml"));
  assert.equal(claudeUserDir(), join(homedir(), ".claude"));
});

test("assetPath falls back to the repository root when an asset is not packaged", () => {
  const segments = ["sdd", "agents", "__missing_task_001_asset__.yaml"];
  assert.equal(assetPath(...segments), join(packageRoot(), "..", ...segments));
});
