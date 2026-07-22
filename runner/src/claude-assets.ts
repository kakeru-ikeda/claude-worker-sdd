import { cp, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assetPath, claudeUserDir } from "./paths.js";
import { ensureDir } from "./fsutil.js";

const CLAUDE_BEGIN = "<!-- sdd-worker:begin -->";
const CLAUDE_END = "<!-- sdd-worker:end -->";
const HOOK_FILE = "deny-superpowers-exec.mjs";
const BOUNDARY_FILE = "sdd-boundary.md";
const BOUNDARY_PRINTER_FILE = "print-sdd-boundary.mjs";
const HOOK_COMMAND = (targetDir: string, file: string): string =>
  `node "${join(targetDir, "hooks", file)}"`;
const LEGACY_HOOK_COMMAND = (targetDir: string): string =>
  `node ${join(targetDir, "hooks", HOOK_FILE)}`;

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

function ensureHookCommand(
  value: unknown,
  command: string,
  entry: JsonObject,
  legacyCommand?: string,
): unknown[] {
  const existing = Array.isArray(value) ? value : [];
  const hasCurrentCommand = hasHookCommand(existing, command);
  let replacedLegacyCommand = false;
  const normalized = existing.flatMap((candidate) => {
    if (!isJsonObject(candidate) || !Array.isArray(candidate.hooks)) return [candidate];

    const hooks = candidate.hooks.flatMap((hook) => {
      if (!isJsonObject(hook) || hook.type !== "command") return [hook];
      if (hook.command === command) return [hook];
      if (legacyCommand === undefined || hook.command !== legacyCommand) return [hook];
      if (hasCurrentCommand || replacedLegacyCommand) return [];

      replacedLegacyCommand = true;
      return [{ ...hook, command }];
    });

    if (hooks.length === 0 && candidate.hooks.length > 0) return [];
    return [{ ...candidate, hooks }];
  });

  if (!hasCurrentCommand && !replacedLegacyCommand) normalized.push(entry);
  return normalized;
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
  const hooksDir = join(targetDir, "hooks");
  await ensureDir(hooksDir);
  await Promise.all(
    [HOOK_FILE, BOUNDARY_FILE, BOUNDARY_PRINTER_FILE].map((file) =>
      cp(assetPath("claude", "hooks", file), join(hooksDir, file)),
    ),
  );

  const settingsPath = join(targetDir, "settings.json");
  let settings: JsonObject = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
    if (isJsonObject(parsed)) settings = parsed;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const existingHooks = isJsonObject(settings.hooks) ? settings.hooks : {};
  const preToolUse = ensureHookCommand(
    existingHooks.PreToolUse,
    HOOK_COMMAND(targetDir, HOOK_FILE),
    {
      matcher: "Skill",
      hooks: [{ type: "command", command: HOOK_COMMAND(targetDir, HOOK_FILE) }],
    },
    LEGACY_HOOK_COMMAND(targetDir),
  );
  const sessionStart = ensureHookCommand(
    existingHooks.SessionStart,
    HOOK_COMMAND(targetDir, BOUNDARY_PRINTER_FILE),
    { hooks: [{ type: "command", command: HOOK_COMMAND(targetDir, BOUNDARY_PRINTER_FILE) }] },
  );

  settings.hooks = { ...existingHooks, PreToolUse: preToolUse, SessionStart: sessionStart };
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export async function installPlannerAgent(targetDir = claudeUserDir()): Promise<void> {
  const source = assetPath("claude", "agents", "planner.md");
  const destination = join(targetDir, "agents", "planner.md");
  await ensureDir(join(targetDir, "agents"));
  await cp(source, destination);
}

export type ClaudeMdInstallMode = "marker" | "overwrite";

export async function appendClaudeMdTemplate(
  targetDir = claudeUserDir(),
  mode: ClaudeMdInstallMode = "marker",
): Promise<void> {
  const source = assetPath("claude", "CLAUDE.md");
  const destination = join(targetDir, "CLAUDE.md");
  const template = (await readFile(source, "utf8")).trimEnd();

  if (mode === "overwrite") {
    await ensureDir(targetDir);
    await writeFile(destination, `${template}\n`, "utf8");
    return;
  }

  let existing = "";
  try {
    existing = await readFile(destination, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

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
      `hooks/${BOUNDARY_FILE}`,
      `hooks/${BOUNDARY_PRINTER_FILE}`,
      "settings.json",
      "agents/planner.md",
      "CLAUDE.md",
    ].map((action) => join(targetDir, action)),
  };
}
