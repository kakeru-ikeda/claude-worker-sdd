import { cp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runnerRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(runnerRoot);
const assetsRoot = join(runnerRoot, "assets");

await rm(assetsRoot, { recursive: true, force: true });

for (const assetName of ["sdd", "skills", "claude"]) {
  await cp(join(repositoryRoot, assetName), join(assetsRoot, assetName), { recursive: true });
}
