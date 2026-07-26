import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { assetPath } from "../paths.js";

test("the orchestration guide is available as an asset", () => {
  assert.equal(existsSync(assetPath("docs", "ORCHESTRATION.md")), true);
});
