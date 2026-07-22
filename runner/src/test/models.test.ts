import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { getModelCatalog, MODEL_CACHE_TTL_MS } from "../models.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "sdd-worker-models-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("uses a successful adapter result and reuses it within the TTL", async () => {
  const root = await temporaryDirectory();
  const cachePath = join(root, "models-cache.yaml");
  const now = new Date("2026-07-22T00:00:00.000Z");
  let calls = 0;
  const adapter = {
    listModels: async () => {
      calls += 1;
      return { models: ["cli-model"], source: "cli" as const };
    },
  };

  const first = await getModelCatalog("codex", { cachePath, now: () => now, adapter });
  const second = await getModelCatalog("codex", { cachePath, now: () => new Date(now.getTime() + 1_000), adapter });

  assert.deepEqual(first, {
    models: ["cli-model"],
    source: "cli",
    fetched_at: now.toISOString(),
  });
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
  assert.match(await readFile(cachePath, "utf8"), /cli-model/);
});

test("refresh and TTL expiry force a new adapter lookup", async () => {
  const root = await temporaryDirectory();
  const cachePath = join(root, "models-cache.yaml");
  const initialTime = new Date("2026-07-22T00:00:00.000Z");
  let calls = 0;
  const adapter = {
    listModels: async () => ({ models: [`model-${++calls}`], source: "cli" as const }),
  };

  await getModelCatalog("codex", { cachePath, now: () => initialTime, adapter });
  const refreshed = await getModelCatalog("codex", {
    cachePath,
    refresh: true,
    now: () => new Date(initialTime.getTime() + 1_000),
    adapter,
  });
  const expired = await getModelCatalog("codex", {
    cachePath,
    now: () => new Date(initialTime.getTime() + MODEL_CACHE_TTL_MS + 1_000),
    adapter,
  });

  assert.deepEqual(refreshed.models, ["model-2"]);
  assert.deepEqual(expired.models, ["model-3"]);
  assert.equal(calls, 3);
});

test("falls back to shipped adapter metadata when discovery is unavailable", async () => {
  const root = await temporaryDirectory();
  const catalog = await getModelCatalog("codex", {
    cachePath: join(root, "models-cache.yaml"),
    now: () => new Date("2026-07-22T00:00:00.000Z"),
    adapter: { listModels: async () => null },
  });

  assert.equal(catalog.source, "fallback");
  assert.ok(catalog.models.includes("gpt-5.6-luna"));
});
