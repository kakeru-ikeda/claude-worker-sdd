import crossSpawn from "cross-spawn";
import { createWriteStream, existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";

const WINDOWS_PATH_SEPARATOR = ";";
const WINDOWS_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];

function existingWindowsPath(candidate: string, platform: string): string | undefined {
  if (existsSync(candidate)) {
    return candidate;
  }

  // Windows path lookup is case-insensitive. This fallback also keeps tests
  // that simulate win32 on a case-sensitive host faithful to that behavior.
  if (platform !== "win32" || process.platform === "win32") {
    return undefined;
  }

  try {
    const candidateName = basename(candidate).toLowerCase();
    const match = readdirSync(dirname(candidate)).find((name) => name.toLowerCase() === candidateName);
    return match ? join(dirname(candidate), match) : undefined;
  } catch {
    return undefined;
  }
}

export function resolveExecutable(
  cmd: string,
  env = process.env,
  platform = process.platform,
): string {
  if (platform !== "win32" || /[\\/]/.test(cmd)) {
    return cmd;
  }

  const pathEntries = (env.PATH ?? "").split(WINDOWS_PATH_SEPARATOR);
  const pathExtensions = (env.PATHEXT ?? WINDOWS_PATHEXT.join(WINDOWS_PATH_SEPARATOR))
    .split(WINDOWS_PATH_SEPARATOR)
    .filter(Boolean);
  const hasExtension = /\.[^\\/.]+$/.test(cmd);

  for (const directory of pathEntries) {
    const directPath = resolvePath(directory || ".", cmd);
    const directMatch = existingWindowsPath(directPath, platform);
    if (directMatch) {
      return directMatch;
    }

    if (hasExtension) {
      continue;
    }

    for (const extension of pathExtensions) {
      const candidate = resolvePath(directory || ".", `${cmd}${extension}`);
      const match = existingWindowsPath(candidate, platform);
      if (match) {
        return match;
      }
    }
  }

  return cmd;
}

export function runCommand(
  command: string,
  args: string[],
  opts: { cwd: string; stdoutPath?: string; stderrToStdout?: boolean },
): Promise<number> {
  return new Promise((resolve) => {
    // cross-spawn: PATH/PATHEXT 解決と .cmd/.bat の cmd.exe ラップを担う。
    // Node 20+ は .cmd/.bat の shell:false spawn を EINVAL で拒否するため必須。
    const child = crossSpawn(command, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const out = opts.stdoutPath ? createWriteStream(opts.stdoutPath, { flags: "a" }) : null;
    child.stdout?.on("data", (chunk) => {
      process.stdout.write(chunk);
      out?.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
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
  if (process.platform === "win32") {
    const bash = resolveExecutable("bash");
    const shell = bash === "bash" ? "cmd.exe" : bash;
    const args = bash === "bash" ? ["/d", "/s", "/c", command] : ["-lc", command];
    return runCommand(shell, args, {
      cwd: opts.cwd,
      stdoutPath: opts.logPath,
      stderrToStdout: true,
    });
  }

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
    const child = crossSpawn(command, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let buf = "";
    child.stdout?.on("data", (chunk) => {
      buf += chunk;
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: buf }));
    child.on("error", () => resolve({ code: 127, stdout: "" }));
  });
}
