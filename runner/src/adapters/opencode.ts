import { runCommand } from "../shell.js";
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
};

