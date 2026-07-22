import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { SddConfig } from "../config.js";
import { saveAgentSelection } from "../setup.js";

test("saveAgentSelection stores the effort selected during setup", () => {
  const config: SddConfig = {
    agents: { executor: { engine: "codex", model: "old-model", effort: "low" } },
  };

  saveAgentSelection(config, "executor", "gpt-5.6-luna", "xhigh");

  assert.deepEqual(config.agents?.executor, {
    engine: "codex",
    model: "gpt-5.6-luna",
    effort: "xhigh",
  });
});
