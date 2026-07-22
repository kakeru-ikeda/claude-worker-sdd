import { existsSync } from "node:fs";
import { homedir } from "node:os";
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
    join(homedir(), ".claude/plugins/cache/claude-plugins-official/superpowers"),
  ];

  // Treat the plugin script as an optional candidate; the runner has a
  // self-contained fallback when it is not installed or discoverable.
  for (const root of candidates) {
    const direct = join(root, "scripts/task-brief");
    if (existsSync(direct)) return direct;
  }
  return null;
}

export function extractBriefSections(
  planText: string,
  index: number,
): { preamble: string; taskSection: string | null; otherTaskTitles: string[] } {
  const headingRe = /^(#{1,4})\s*(?:Task\s+(\d+)\b|TASK-(\d+)\b)(.*)$/gim;
  const headings: Array<{
    offset: number;
    level: number;
    number: number;
    line: string;
    title: string;
  }> = [];

  for (const match of planText.matchAll(headingRe)) {
    const number = Number(match[2] ?? match[3]);
    if (!Number.isFinite(number)) continue;

    headings.push({
      offset: match.index ?? 0,
      level: match[1].length,
      number,
      line: match[0],
      title: match[4].replace(/^\s*:\s*/, "").trim(),
    });
  }

  const firstHeadingOffset = headings[0]?.offset;
  const preamble = firstHeadingOffset === undefined
    ? ""
    : planText.slice(0, firstHeadingOffset).trim();
  const selected = headings.find((heading) => heading.number === index);

  let taskSection: string | null = null;
  if (selected) {
    const nextHeadingRe = new RegExp(`^#{1,${selected.level}}\\s`, "gm");
    nextHeadingRe.lastIndex = selected.offset + selected.line.length;
    const nextHeading = nextHeadingRe.exec(planText);
    const end = nextHeading?.index ?? planText.length;
    taskSection = planText.slice(selected.offset, end).trim();
  }

  const otherTaskTitles = headings
    .filter((heading) => heading.number !== index)
    .map((heading) => `${taskId(heading.number)}: ${heading.title}`);

  return { preamble, taskSection, otherTaskTitles };
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
  const sections = extractBriefSections(plan, input.index);
  if (sections.taskSection !== null) {
    const otherTasks = sections.otherTaskTitles.length > 0
      ? [
          "",
          "Other tasks in this plan (do NOT implement):",
          ...sections.otherTaskTitles.map((title) => `- ${title}`),
        ]
      : [];

    await writeText(
      input.outPath,
      [
        `# ${taskId(input.index)} Brief`,
        "",
        `Source plan: ${input.planPath}`,
        "",
        "Optional external task-brief script was not found; this fallback brief is scoped to this task.",
        "It contains the plan preamble (shared context) and this task's section ONLY.",
        "Other tasks are listed by title for orientation and are OUT OF SCOPE — do not implement them.",
        "",
        "```md",
        sections.preamble,
        "",
        sections.taskSection,
        "```",
        ...otherTasks,
        "",
      ].join("\n"),
    );
    return;
  }

  await writeText(
    input.outPath,
    [
      `# ${taskId(input.index)} Brief`,
      "",
      `Source plan: ${input.planPath}`,
      "",
      "Optional external task-brief script was not found, and the task heading could not be located; this fallback includes the whole plan as a last resort.",
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
