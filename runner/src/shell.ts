import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

export function runCommand(
  command: string,
  args: string[],
  opts: { cwd: string; stdoutPath?: string; stderrToStdout?: boolean },
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const out = opts.stdoutPath ? createWriteStream(opts.stdoutPath, { flags: "a" }) : null;
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      out?.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      if (opts.stderrToStdout) out?.write(chunk);
    });
    child.on("close", (code) => {
      out?.end();
      resolve(code ?? 1);
    });
    child.on("error", () => {
      out?.end();
      resolve(127);
    });
  });
}

export function runShell(
  command: string,
  opts: { cwd: string; logPath?: string },
): Promise<number> {
  return runCommand("bash", ["-lc", command], {
    cwd: opts.cwd,
    stdoutPath: opts.logPath,
    stderrToStdout: true,
  });
}

export function captureCommand(
  command: string,
  args: string[],
  opts: { cwd: string },
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk;
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: buf }));
    child.on("error", () => resolve({ code: 127, stdout: "" }));
  });
}

