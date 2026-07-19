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

  // Treat the plugin script as an optional candidate; the runner has a
  // self-contained fallback when it is not installed or discoverable.
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
      "Optional external task-brief script was not found, so this fallback brief contains the whole plan.",
      "The orchestrator should replace it with a scoped brief before production use.",
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

// Highest task number declared in the plan ("### Task 3: ..." or "TASK-003"
// headings), or null when the plan has no recognizable task headings.
export function countPlanTasks(planText: string): number | null {
  let max = 0;
  const headingRe = /^#{1,4}\s*(?:Task\s+(\d+)\b|TASK-(\d+)\b)/gim;
  for (const match of planText.matchAll(headingRe)) {
    const n = Number(match[1] ?? match[2]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max > 0 ? max : null;
}
