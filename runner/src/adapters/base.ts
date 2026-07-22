import type { AdapterRunInput, AdapterRunResult, EngineName } from "../types.js";

export interface EngineAdapter {
  name: EngineName;
  run(input: AdapterRunInput): Promise<AdapterRunResult>;
  listModels?(): Promise<{ models: string[]; source: "cli" | "api" } | null>;
}
