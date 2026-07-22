#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const boundaryPath = join(dirname(fileURLToPath(import.meta.url)), "sdd-boundary.md");
process.stdout.write(await readFile(boundaryPath, "utf8"));
