import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import YAML from "yaml";
import { getAdapter } from "./adapters/index.js";
import type { EngineAdapter } from "./adapters/base.js";
import { loadShippedAdapterMeta } from "./config.js";
import { modelsCachePath } from "./paths.js";
import type { EngineName } from "./types.js";

export const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

export type ModelCatalogSource = "cli" | "api" | "fallback";

export type ModelCatalog = {
  models: string[];
  source: ModelCatalogSource;
  fetched_at: string;
};

export type ModelCatalogOptions = {
  refresh?: boolean;
  cachePath?: string;
  now?: () => Date;
  /** Test seam for exercising discovery without invoking a real engine CLI or API. */
  adapter?: Pick<EngineAdapter, "listModels">;
};

type CacheEntry = {
  models?: unknown;
  source?: unknown;
  fetched_at?: unknown;
};

type CacheDocument = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanModels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((model): model is string => typeof model === "string").map((model) => model.trim()).filter(Boolean))];
}

function validSource(value: unknown): value is ModelCatalogSource {
  return value === "cli" || value === "api" || value === "fallback";
}

function cacheEntry(value: unknown): ModelCatalog | null {
  if (!isObject(value)) return null;
  const models = cleanModels(value.models);
  const source = value.source;
  const fetchedAt = value.fetched_at;
  if (!validSource(source) || typeof fetchedAt !== "string" || !Number.isFinite(Date.parse(fetchedAt))) {
    return null;
  }
  return { models, source, fetched_at: fetchedAt };
}

async function readCache(path: string, engine: EngineName): Promise<ModelCatalog | null> {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = YAML.parse(await readFile(path, "utf8"));
    if (!isObject(parsed)) return null;

    const direct = cacheEntry(parsed[engine]);
    if (direct) return direct;

    // Accept the nested form as well so users can carry forward an equivalent
    // cache written by an earlier development build.
    return cacheEntry(isObject(parsed.engines) ? parsed.engines[engine] : undefined);
  } catch {
    return null;
  }
}

async function writeCache(path: string, engine: EngineName, value: ModelCatalog): Promise<void> {
  let document: CacheDocument = {};
  try {
    if (existsSync(path)) {
      const parsed: unknown = YAML.parse(await readFile(path, "utf8"));
      if (isObject(parsed)) document = parsed;
    }
  } catch {
    document = {};
  }

  document[engine] = value;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, YAML.stringify(document), "utf8");
  } catch {
    // A read-only or unavailable user config directory must not hide a model
    // catalog that was successfully discovered in this invocation.
  }
}

function isFresh(value: ModelCatalog, now: Date): boolean {
  const age = now.getTime() - Date.parse(value.fetched_at);
  return age >= 0 && age < MODEL_CACHE_TTL_MS;
}

export async function getModelCatalog(
  engine: EngineName,
  opts: ModelCatalogOptions = {},
): Promise<ModelCatalog> {
  const now = opts.now ?? (() => new Date());
  const currentTime = now();
  const cachePath = opts.cachePath ?? modelsCachePath();

  if (!opts.refresh) {
    const cached = await readCache(cachePath, engine);
    if (cached && isFresh(cached, currentTime)) return cached;
  }

  const adapter = opts.adapter ?? getAdapter(engine);
  let discovered: { models: string[]; source: "cli" | "api" } | null = null;
  if (adapter.listModels) {
    try {
      discovered = await adapter.listModels();
    } catch {
      discovered = null;
    }
  }

  const dynamicModels = cleanModels(discovered?.models);
  const result: ModelCatalog = dynamicModels.length > 0 && discovered
    ? { models: dynamicModels, source: discovered.source, fetched_at: currentTime.toISOString() }
    : {
        models: cleanModels((await loadShippedAdapterMeta(engine)).models),
        source: "fallback",
        fetched_at: currentTime.toISOString(),
      };

  await writeCache(cachePath, engine, result);
  return result;
}
