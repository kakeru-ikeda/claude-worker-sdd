import { runCommand } from "../shell.js";
import type { EngineAdapter } from "./base.js";

export const codexAdapter: EngineAdapter = {
  name: "codex",
  async run(input) {
    const sandbox = input.mode === "review" ? "read-only" : "workspace-write";
    const args = [
      "exec",
      "--sandbox",
      sandbox,
      "--ask-for-approval",
      "never",
      "--json",
      "-o",
      input.finalPath,
    ];

    if (input.task.engine.model) {
      args.push("--model", input.task.engine.model);
    }

    args.push(
      `Read ${input.dispatchPath} and execute it completely. Write the required YAML output file before finishing.`,
    );

    const exitCode = await runCommand("codex", args, {
      cwd: input.workspace,
      stdoutPath: input.stdoutPath,
      stderrToStdout: true,
    });

    return { exitCode, command: ["codex", ...args].join(" ") };
  },
};

