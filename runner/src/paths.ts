import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Lang } from "./i18n.js";

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

export function localizedAssetPath(lang: Lang, ...segs: string[]): string {
  if (segs.length === 0) return assetPath();

  const localizedPath = assetPath(...segs.slice(0, -1), lang, segs.at(-1) as string);
  if (existsSync(localizedPath)) return localizedPath;

  const englishPath = assetPath(...segs.slice(0, -1), "en", segs.at(-1) as string);
  return existsSync(englishPath) ? englishPath : assetPath(...segs);
}
