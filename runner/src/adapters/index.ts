import type { EngineName } from "../types.js";
import type { EngineAdapter } from "./base.js";
import { codexAdapter } from "./codex.js";
import { geminiAdapter } from "./gemini.js";
import { opencodeAdapter } from "./opencode.js";

const adapters: Record<EngineName, EngineAdapter> = {
  codex: codexAdapter,
  opencode: opencodeAdapter,
  gemini: geminiAdapter,
};

export function getAdapter(name: EngineName): EngineAdapter {
  return adapters[name];
}

