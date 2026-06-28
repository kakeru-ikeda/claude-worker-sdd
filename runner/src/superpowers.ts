import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { runCommand } from "./shell.js";
import { readText, writeText } from "./fsutil.js";

export function taskDirName(index: number): string {
  return `task-${String(index).padStart(3, "0")}`;
}

export function taskId(index: number): string {
  return `TASK-${String(index).padStart(3, "0")}`;
}

export async function findWorkspace(start = process.cwd()): Promise<string> {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = resolve(current, "..");
    if (parent === current) return resolve(start);
    current = parent;
  }
}

export function findTaskBriefScript(): string | null {
  const candidates = [
    join(process.env.HOME ?? "", ".claude/plugins/cache/claude-plugins-official/superpowers"),
  ];

  // Keep discovery conservative in the runner. Skills can still call official
  // Superpowers scripts directly when installed in a different location.
  for (const root of candidates) {
    const direct = join(root, "scripts/task-brief");
    if (existsSync(direct)) return direct;
  }
  return null;
}

export async function writeBrief(input: {
  workspace: string;
  planPath: string;
  index: number;
  outPath: string;
}): Promise<void> {
  const script = findTaskBriefScript();
  if (script) {
    const code = await runCommand(script, [input.planPath, String(input.index), input.outPath], {
      cwd: input.workspace,
      stderrToStdout: true,
    });
    if (code === 0 && existsSync(input.outPath)) return;
  }

  const plan = await readText(resolve(input.workspace, input.planPath));
  await writeText(
    input.outPath,
    [
      `# ${taskId(input.index)} Brief`,
      "",
      `Source plan: ${input.planPath}`,
      "",
      "Superpowers task-brief script was not found, so this fallback brief contains the whole plan.",
      "The orchestrator should replace this with a scoped brief before production use.",
      "",
      "```md",
      plan,
      "```",
      "",
    ].join("\n"),
  );
}

export function defaultTitle(planPath: string, index: number): string {
  return `${basename(planPath, ".md")} task ${index}`;
}

