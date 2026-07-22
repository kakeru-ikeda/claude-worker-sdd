import { cp, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assetPath, claudeUserDir } from "./paths.js";
import { ensureDir } from "./fsutil.js";

const CLAUDE_BEGIN = "<!-- sdd-worker:begin -->";
const CLAUDE_END = "<!-- sdd-worker:end -->";
const HOOK_FILE = "deny-superpowers-exec.mjs";
const HOOK_COMMAND = (targetDir: string): string => `node ${join(targetDir, "hooks", HOOK_FILE)}`;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasHookCommand(value: unknown, command: string): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((entry) => {
    if (!isJsonObject(entry) || !Array.isArray(entry.hooks)) return false;
    return entry.hooks.some(
      (hook) => isJsonObject(hook) && hook.type === "command" && hook.command === command,
    );
  });
}

export async function installSkills(targetDir = claudeUserDir()): Promise<void> {
  const sourceRoot = assetPath("skills");
  const entries = await readdir(sourceRoot, { withFileTypes: true });

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const source = join(sourceRoot, entry.name, "SKILL.md");
        const destination = join(targetDir, "skills", entry.name, "SKILL.md");
        await ensureDir(join(targetDir, "skills", entry.name));
        await cp(source, destination);
      }),
  );
}

export async function installHooks(targetDir = claudeUserDir()): Promise<void> {
  const source = assetPath("claude", "hooks", HOOK_FILE);
  const hooksDir = join(targetDir, "hooks");
  const destination = join(hooksDir, HOOK_FILE);
  await ensureDir(hooksDir);
  await cp(source, destination);

  const settingsPath = join(targetDir, "settings.json");
  let settings: JsonObject = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
    if (isJsonObject(parsed)) settings = parsed;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const existingHooks = isJsonObject(settings.hooks) ? settings.hooks : {};
  const preToolUse = Array.isArray(existingHooks.PreToolUse) ? [...existingHooks.PreToolUse] : [];
  const command = HOOK_COMMAND(targetDir);
  if (!hasHookCommand(preToolUse, command)) {
    preToolUse.push({
      matcher: "Skill",
      hooks: [{ type: "command", command }],
    });
  }

  settings.hooks = { ...existingHooks, PreToolUse: preToolUse };
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export async function installPlannerAgent(targetDir = claudeUserDir()): Promise<void> {
  const source = assetPath("claude", "agents", "planner.md");
  const destination = join(targetDir, "agents", "planner.md");
  await ensureDir(join(targetDir, "agents"));
  await cp(source, destination);
}

export async function appendClaudeMdTemplate(targetDir = claudeUserDir()): Promise<void> {
  const source = assetPath("claude", "CLAUDE.md");
  const destination = join(targetDir, "CLAUDE.md");
  let existing = "";
  try {
    existing = await readFile(destination, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const template = (await readFile(source, "utf8")).trimEnd();
  const block = `${CLAUDE_BEGIN}\n${template}\n${CLAUDE_END}`;
  const markerBlock = new RegExp(`${escapeRegExp(CLAUDE_BEGIN)}[\\s\\S]*?${escapeRegExp(CLAUDE_END)}`);
  const content = markerBlock.test(existing)
    ? existing.replace(markerBlock, block)
    : existing.length > 0
      ? `${existing}${existing.endsWith("\n") ? "" : "\n"}\n${block}\n`
      : `${block}\n`;

  await ensureDir(targetDir);
  await writeFile(destination, content, "utf8");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function installAll(targetDir = claudeUserDir()): Promise<{ actions: string[] }> {
  await installSkills(targetDir);
  await installHooks(targetDir);
  await installPlannerAgent(targetDir);
  await appendClaudeMdTemplate(targetDir);

  return {
    actions: [
      "skills",
      `hooks/${HOOK_FILE}`,
      "settings.json",
      "agents/planner.md",
      "CLAUDE.md",
    ].map((action) => join(targetDir, action)),
  };
}
