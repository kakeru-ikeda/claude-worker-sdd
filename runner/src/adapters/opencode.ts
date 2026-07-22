import { captureCommand, runCommand } from "../shell.js";
import type { EngineAdapter } from "./base.js";

export const opencodeAdapter: EngineAdapter = {
  name: "opencode",
  async run(input) {
    const agent = input.task.engine.agent ?? input.task.agent;
    const args = [
      "run",
      `Read ${input.dispatchPath} and execute it completely. Write the required YAML output file before finishing.`,
      "--agent",
      agent,
      "--file",
      input.dispatchPath,
      "--dangerously-skip-permissions",
    ];

    const exitCode = await runCommand("opencode", args, {
      cwd: input.workspace,
      stdoutPath: input.stdoutPath,
      stderrToStdout: true,
    });

    return { exitCode, command: ["opencode", ...args].join(" ") };
  },
  async listModels() {
    const result = await captureCommand("opencode", ["models"], { cwd: process.cwd() });
    if (result.code !== 0) return null;

    const models = [...new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
    return { models, source: "cli" as const };
  },
};
