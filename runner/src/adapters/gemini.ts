import type { EngineAdapter } from "./base.js";

export const geminiAdapter: EngineAdapter = {
  name: "gemini",
  async run() {
    throw new Error("gemini adapter is a future stub and is not implemented");
  },
};

