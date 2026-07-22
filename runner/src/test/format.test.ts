import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatDispatchLine } from "../index.js";

const baseEngine = {
  engine: "codex" as const,
  source: { engine: "cli", model: "cli", effort: "task" },
};

test("formats dispatch details with model and effort", () => {
  assert.equal(
    formatDispatchLine(
      "TASK-003",
      { ...baseEngine, model: "gpt-5.6-luna", effort: "xhigh" },
      "executor",
    ),
    "TASK-003 → codex / gpt-5.6-luna (xhigh) / executor",
  );
});

test("omits the effort when it is null", () => {
  assert.equal(
    formatDispatchLine(
      "TASK-003",
      { ...baseEngine, model: "gpt-5.6-luna", effort: null },
      "reviewer",
    ),
    "TASK-003 → codex / gpt-5.6-luna / reviewer",
  );
});

test("shows the engine default when the model is null", () => {
  assert.equal(
    formatDispatchLine(
      "TASK-003",
      { ...baseEngine, model: null, effort: null },
      "explorer",
    ),
    "TASK-003 → codex / engine default / explorer",
  );
});
