import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function userConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "sdd-worker");
  }

  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "sdd-worker");
}

export function userConfigPath(): string {
  return join(userConfigDir(), "config.yaml");
}

export function modelsCachePath(): string {
  return join(userConfigDir(), "models-cache.yaml");
}

export function claudeUserDir(): string {
  return join(homedir(), ".claude");
}

export function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export function assetPath(...segs: string[]): string {
  const packagedPath = join(packageRoot(), "assets", ...segs);
  return existsSync(packagedPath)
    ? packagedPath
    : join(packageRoot(), "..", ...segs);
}
