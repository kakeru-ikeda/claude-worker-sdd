#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { getAdapter } from "./adapters/index.js";
import {
  acquireLock,
  ensurePlanState,
  loadCurrentPlan,
  loadProgressFor,
  migrateLegacyLayout,
  normalizePlanPath,
  planSlug,
  prepareReview,
  prepareTask,
  progressPath,
  releaseLock,
  saveCurrentPlan,
  saveProgress,
  taskPathForProgress,
} from "./artifacts.js";
import { ensureDir, readText, readYaml, writeText, writeYaml } from "./fsutil.js";
import { captureCommand, runShell } from "./shell.js";
import { countPlanTasks, findTaskBriefScript, findWorkspace, taskId } from "./superpowers.js";
import type { AgentName, EngineName, TaskSpec } from "./types.js";

function parseArgs(argv: string[]): { command: string; rest: string[]; flags: Record<string, string | true> } {
  const [command = "help", ...raw] = argv;
  const rest: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (item.startsWith("--")) {
      const key = item.slice(2);
      const next = raw[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      rest.push(item);
    }
  }
  return { command, rest, flags };
}

function asEngine(value: unknown): EngineName | undefined {
  return value === "codex" || value === "opencode" || value === "gemini" ? value : undefined;
}

function asAgent(value: unknown): AgentName | undefined {
  return value === "executor" ||
    value === "reviewer" ||
    value === "explorer" ||
    value === "thinker" ||
    value === "test-writer" ||
    value === "operator"
    ? value
    : undefined;
}

// Engines write report statuses loosely ("completed", "success", ...). Normalize
// instead of gating on exact enum strings — the executable verify is the real gate.
function normalizeReportStatus(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (["DONE", "COMPLETE", "COMPLETED", "SUCCESS", "SUCCEEDED", "FINISHED", "OK"].includes(s)) {
    return "DONE";
  }
  if (["DONE_WITH_CONCERNS", "COMPLETED_WITH_CONCERNS", "CONCERNS"].includes(s)) {
    return "DONE_WITH_CONCERNS";
  }
  if (["BLOCKED", "BLOCKING"].includes(s)) return "BLOCKED";
  if (["NEEDS_CONTEXT", "NEED_CONTEXT", "NEEDS_INFO", "QUESTION"].includes(s)) {
    return "NEEDS_CONTEXT";
  }
  return s;
}

function flagArgs(flags: Record<string, string | true>, keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const value = flags[key];
    if (value === true) out.push(`--${key}`);
    else if (typeof value === "string") out.push(`--${key}`, value);
  }
  return out;
}

async function resolveActivePlan(
  workspace: string,
  flags: Record<string, string | true>,
): Promise<{ plan: string; slug: string }> {
  await migrateLegacyLayout(workspace);
  if (typeof flags.plan === "string") {
    const plan = normalizePlanPath(workspace, flags.plan);
    return { plan, slug: planSlug(plan) };
  }
  const current = await loadCurrentPlan(workspace);
  if (current) return current;
  throw new Error("No active plan. Pass --plan <plan.md> or dispatch a task with `run <plan.md>` first.");
}

async function run(argv: string[]): Promise<number> {
  const { command, rest, flags } = parseArgs(argv);
  const workspace = await findWorkspace();

  if (command === "help" || command === "--help") {
    console.log("Usage: sdd-worker run <plan.md> [--task TASK-001] [--engine codex] [--model gpt-5.4] [--verify 'npm test'] [--force]");
    console.log("       sdd-worker next [<plan.md>] [--engine codex] [--model gpt-5.4]   dispatch first non-complete task");
    console.log("       (--verify persists as the plan default and gates every task's completion)");
    console.log("       sdd-worker one-shot \"<instruction>\" [--agent explorer] [--engine codex]");
    console.log("       sdd-worker review TASK-001 [--plan <plan.md>] [--engine codex] [--model gpt-5.5]");
    console.log("       sdd-worker retry TASK-001 [--plan <plan.md>] [--engine codex] [--model gpt-5.4]");
    console.log("       sdd-worker accept TASK-001 [--note \"why\"]              mark a failed task complete after manual review");
    console.log("       sdd-worker status [--plan <plan.md>]");
    console.log("       sdd-worker set <TASK-ID> engine|model <value> [--plan <plan.md>]");
    console.log("       sdd-worker guide [<topic>]                    print playbook section on demand");
    console.log("       sdd-worker doctor                             check engine CLIs (setup debugging only)");
    return 0;
  }

  if (command === "doctor") {
    const checks: Array<{ bin: string; note: string; required: boolean }> = [
      { bin: "codex", note: "primary engine", required: true },
      { bin: "opencode", note: "optional engine", required: false },
      { bin: "git", note: "required for diff capture and commits", required: true },
    ];
    let failures = 0;
    for (const { bin, note, required } of checks) {
      const result = await captureCommand(bin, ["--version"], { cwd: workspace });
      if (result.code === 0) {
        console.log(`ok    ${bin}  ${result.stdout.trim().split("\n")[0]}`);
      } else {
        console.log(`${required ? "MISS" : "warn"}  ${bin}  (${note}) — not found or exits ${result.code}`);
        if (required) failures += 1;
      }
    }
    const brief = findTaskBriefScript();
    console.log(
      brief
        ? `ok    superpowers task-brief: ${brief}`
        : "warn  superpowers task-brief script not found — runner falls back to whole-plan briefs",
    );
    return failures > 0 ? 1 : 0;
  }

  if (command === "guide") {
    const here = dirname(fileURLToPath(import.meta.url));
    const docPath = join(here, "..", "..", "docs", "ORCHESTRATION.md");
    if (!existsSync(docPath)) throw new Error(`playbook not found: ${docPath}`);
    const sections = (await readText(docPath))
      .split(/^## /m)
      .slice(1)
      .map((section) => `## ${section.trimEnd()}`);
    const topic = rest[0]?.toLowerCase();
    if (!topic) {
      console.log("Playbook sections — print ONE with: sdd-worker guide <keyword>");
      console.log("(do not load the whole playbook into context)");
      for (const section of sections) {
        console.log(`  ${section.split("\n")[0].replace(/^## /, "")}`);
      }
      return 0;
    }
    const hit = sections.find((section) => section.split("\n")[0].toLowerCase().includes(topic));
    if (!hit) throw new Error(`no playbook section matches "${topic}" — run guide with no args to list`);
    console.log(hit);
    return 0;
  }

  if (command === "status") {
    await migrateLegacyLayout(workspace);
    let plan: string | null = null;
    let slug: string | null = null;
    if (typeof flags.plan === "string") {
      plan = normalizePlanPath(workspace, flags.plan);
      slug = planSlug(plan);
    } else {
      const current = await loadCurrentPlan(workspace);
      if (current) ({ plan, slug } = current);
    }
    if (!plan || !slug) {
      console.log("No active plan (no .superpowers/sdd/current-plan.yaml). Pass --plan <plan.md>.");
      return 0;
    }
    console.log(`plan: ${plan} (slug: ${slug})`);
    const path = progressPath(workspace, slug);
    if (!existsSync(path)) {
      console.log("no progress yet — next: TASK-001");
      return 0;
    }
    const progress = await loadProgressFor(workspace, slug);
    if (progress.base_commit) console.log(`base_commit: ${progress.base_commit}`);
    const ids = Object.keys(progress.tasks).sort();
    for (const id of ids) {
      const t = progress.tasks[id];
      const engine = `${t.engine ?? "?"}${t.model ? `/${t.model}` : ""}`;
      const attempts = t.attempts?.length ?? 0;
      console.log(
        `${id}  ${t.status}  ${engine}  attempts=${attempts}${t.reviewed ? "  reviewed" : ""}`,
      );
    }
    const planFile = join(workspace, plan);
    const total = existsSync(planFile) ? countPlanTasks(await readText(planFile)) : null;
    if (total !== null) {
      let next: string | null = null;
      for (let i = 1; i <= total; i += 1) {
        if (progress.tasks[taskId(i)]?.status !== "complete") {
          next = taskId(i);
          break;
        }
      }
      console.log(next ? `next: ${next} (plan defines ${total} tasks)` : `all ${total} tasks complete`);
    }
    return 0;
  }

  if (command === "next") {
    await migrateLegacyLayout(workspace);
    const planArg =
      rest[0] ??
      (typeof flags.plan === "string" ? flags.plan : undefined) ??
      (await loadCurrentPlan(workspace))?.plan;
    if (!planArg) throw new Error("Usage: next [<plan.md>] — no active plan found");
    const planPath = normalizePlanPath(workspace, planArg);
    if (!existsSync(join(workspace, planPath))) throw new Error(`plan file not found: ${planPath}`);
    const total = countPlanTasks(await readText(join(workspace, planPath)));
    if (total === null) {
      throw new Error("no task headings found in plan (expected '### Task N: ...'); use run --task instead");
    }
    const { progress } = await ensurePlanState(workspace, planPath);
    let nextIndex: number | null = null;
    for (let i = 1; i <= total; i += 1) {
      const state = progress.tasks[taskId(i)]?.status;
      if (state === "running") {
        throw new Error(`${taskId(i)} is still running; wait for it before dispatching the next task`);
      }
      if (state !== "complete") {
        nextIndex = i;
        break;
      }
    }
    if (nextIndex === null) {
      console.log(`all ${total} tasks complete for ${planPath}`);
      return 0;
    }
    console.log(`dispatching ${taskId(nextIndex)} (plan defines ${total} tasks)`);
    return run([
      "run",
      planPath,
      "--task",
      taskId(nextIndex),
      ...flagArgs(flags, ["engine", "model", "agent", "verify", "force"]),
    ]);
  }

  if (command === "one-shot") {
    const first = rest[0];
    const asPlan = first ? normalizePlanPath(workspace, first) : undefined;
    if (asPlan && existsSync(join(workspace, asPlan)) && asPlan.endsWith(".md")) {
      return run(["run", asPlan, ...flagArgs(flags, ["task", "engine", "model", "agent", "force"])]);
    }
    const instruction = rest.join(" ").trim();
    if (!instruction) {
      throw new Error('Usage: one-shot "<instruction>" [--agent explorer] [--engine codex]');
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const adhocRel = join(".superpowers", "sdd", "adhoc", `adhoc-${stamp}.md`);
    const title = instruction.length > 80 ? `${instruction.slice(0, 77)}...` : instruction;
    await writeText(
      join(workspace, adhocRel),
      `# Ad-hoc worker task\n\n### Task 1: ${title}\n\n${instruction}\n`,
    );
    return run([
      "run",
      adhocRel,
      "--task",
      "TASK-001",
      ...flagArgs(flags, ["engine", "model", "agent", "verify"]),
    ]);
  }

  if (command === "run") {
    const planPath = rest[0] ? normalizePlanPath(workspace, rest[0]) : undefined;
    if (!planPath) throw new Error("plan path is required");
    if (!existsSync(join(workspace, planPath))) {
      throw new Error(`plan file not found: ${planPath}`);
    }
    const index = flags.task && typeof flags.task === "string"
      ? Number(flags.task.replace(/^TASK-/, ""))
      : 1;
    if (!Number.isFinite(index) || index < 1) throw new Error("invalid task id/index");

    const totalTasks = countPlanTasks(await readText(join(workspace, planPath)));
    if (totalTasks !== null && index > totalTasks && flags.force !== true) {
      throw new Error(
        `plan defines ${totalTasks} tasks; ${taskId(index)} is out of range. ` +
          `If this is a new plan, its state starts fresh at TASK-001. Use --force only if the plan numbering is unusual.`,
      );
    }

    const engine = asEngine(flags.engine) ?? "codex";
    const agent = asAgent(flags.agent) ?? "executor";
    const model = typeof flags.model === "string" ? flags.model : undefined;

    const { slug, progress } = await ensurePlanState(workspace, planPath);
    await saveCurrentPlan(workspace, planPath, slug);
    const id = taskId(index);
    if (progress.tasks[id]?.status === "complete") {
      console.log(`${id} already complete; skipping`);
      return 0;
    }

    const isGitRepo = existsSync(join(workspace, ".git"));
    if (!progress.base_commit && isGitRepo) {
      const head = await captureCommand("git", ["rev-parse", "HEAD"], { cwd: workspace });
      if (head.code === 0) progress.base_commit = head.stdout.trim();
    }

    // --verify persists as the plan default: set it once on the first dispatch and
    // every later task (including retries) is gated on the same command.
    const storedVerify =
      progress.defaults && typeof progress.defaults["verify_command"] === "string"
        ? (progress.defaults["verify_command"] as string)
        : undefined;
    const verifyCommand = typeof flags.verify === "string" ? flags.verify : storedVerify;
    if (typeof flags.verify === "string") {
      progress.defaults = { ...(progress.defaults ?? {}), verify_command: flags.verify };
    }

    await acquireLock(workspace, slug, id);

    try {
      const { task, taskDir, dispatchPath } = await prepareTask({
        workspace,
        planPath,
        slug,
        index,
        engine,
        model,
        agent,
        verifyCommand,
      });

      const previousTaskState = progress.tasks[id];
      progress.tasks[id] = {
        status: "running",
        engine: task.engine.name,
        agent: task.agent,
        model: task.engine.model,
        path: taskPathForProgress(workspace, taskDir),
        reviewed: previousTaskState?.reviewed ?? false,
        attempts: previousTaskState?.attempts ?? [],
      };
      await saveProgress(workspace, slug, progress);

      const item = progress.tasks[id];
      if (!item.attempts) item.attempts = [];
      const attemptNumber = item.attempts.length + 1;
      const attemptSlug = String(attemptNumber).padStart(3, "0") + "-" + task.engine.name + (task.engine.model ? "-" + task.engine.model : "");
      const attemptDir = join(taskDir, "attempts", attemptSlug);
      await ensureDir(attemptDir);

      const adapter = getAdapter(task.engine.name);
      let result: { exitCode: number; command: string };
      try {
        result = await adapter.run({
          workspace,
          taskDir,
          task,
          dispatchPath,
          stdoutPath: join(attemptDir, "stdout.jsonl"),
          finalPath: join(attemptDir, "final.md"),
          mode: "run",
        });
      } catch (error: unknown) {
        // Never leave the task stuck in "running": adapter crashes become failed attempts.
        result = {
          exitCode: 1,
          command: `adapter ${task.engine.name} threw: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      // Exit code 0 alone is not success: the engine must also have written a
      // valid report claiming DONE. Anything else needs orchestrator attention.
      const reportFile = join(taskDir, "report.yaml");
      let reportStatus: string | null = null;
      let reportParseError = false;
      const reportPresent = existsSync(reportFile);
      if (reportPresent) {
        try {
          const report = await readYaml<{ status?: string }>(reportFile);
          reportStatus = report?.status ?? null;
        } catch {
          // Engines write markdown-flavored prose; a scalar starting with a
          // backtick is invalid YAML and kills strict parsing. The gate only
          // needs the status field — extract it line-wise instead of failing.
          reportParseError = true;
          const text = await readText(reportFile);
          const match = text.match(/^status:\s*["']?([A-Za-z_][A-Za-z_ -]*?)["']?\s*$/m);
          reportStatus = match ? match[1] : "INVALID_YAML";
        }
      }
      const engineOk = result.exitCode === 0;
      const reportNorm = normalizeReportStatus(reportStatus);
      const workerHalted = reportNorm === "BLOCKED" || reportNorm === "NEEDS_CONTEXT";
      const reportOk = reportNorm === "DONE" || reportNorm === "DONE_WITH_CONCERNS";

      // Capture the worker's diff before verify runs, so build/test side effects
      // do not pollute the reviewed patch.
      let untracked: string[] = [];
      if (isGitRepo) {
        const diff = await captureCommand("git", ["diff", "HEAD"], { cwd: workspace });
        if (diff.code === 0) {
          await writeText(join(attemptDir, "diff.patch"), diff.stdout);
          await writeText(join(taskDir, "diff.patch"), diff.stdout);
        }
        const porcelain = await captureCommand("git", ["status", "--porcelain"], { cwd: workspace });
        if (porcelain.code === 0) {
          untracked = porcelain.stdout
            .split("\n")
            .filter((line) => line.startsWith("??"))
            .map((line) => line.slice(3).trim());
        }
      }

      // Executable acceptance gate: verify is the ground truth and runs whenever the
      // engine finished and the worker did not halt itself — independently of report
      // wording, so a sloppy report string can never mask (or fake) the real result.
      let verifyExit: number | null = null;
      if (engineOk && !workerHalted && verifyCommand) {
        verifyExit = await runShell(verifyCommand, {
          cwd: workspace,
          logPath: join(attemptDir, "verify.log"),
        });
      }
      const verifyOk = !verifyCommand || verifyExit === 0;

      const succeeded = engineOk && reportOk && verifyOk;
      const failureReason = succeeded
        ? null
        : !engineOk
          ? result.exitCode === 127
            ? `engine binary not found (${task.engine.name}) — not installed or not on PATH`
            : `engine exited ${result.exitCode}`
          : workerHalted
            ? `report status is ${reportNorm}`
            : !verifyOk
              ? `verify failed (exit ${verifyExit}): ${verifyCommand}`
              : !reportPresent
                ? "engine exited 0 but report.yaml was not written"
                : `report status is ${reportStatus} (unrecognized)`;

      const status = {
        task_id: task.id,
        attempt: attemptSlug,
        engine: task.engine,
        command: result.command,
        exit_code: result.exitCode,
        status: succeeded ? "completed" : "failed",
        report_present: reportPresent,
        report_status: reportNorm,
        report_status_raw: reportStatus,
        report_parse_error: reportParseError,
        verify_command: verifyCommand ?? null,
        verify_exit: verifyExit,
        failure_reason: failureReason,
        untracked_files: untracked,
      };
      await writeYaml(join(attemptDir, "status.yaml"), status);
      await writeYaml(join(taskDir, "status.yaml"), status);

      item.attempts.push({
        type: "run",
        id: attemptSlug,
        engine: task.engine.name,
        model: task.engine.model ?? null,
        exit_code: result.exitCode,
        report_status: reportNorm,
        verify_exit: verifyExit,
        finished_at: new Date().toISOString(),
      });
      progress.tasks[id].status = succeeded ? "complete" : "failed";
      await saveProgress(workspace, slug, progress);

      // Just-in-time guidance: print the orchestrator's next action with the result,
      // so correct behavior does not depend on it having read the playbook.
      const attemptRel = relative(workspace, attemptDir);
      if (succeeded) {
        console.log(`${id} complete.`);
        console.log(
          `next: review ${relative(workspace, join(taskDir, "diff.patch"))} against the plan's acceptance criteria, ` +
            `commit yourself (engines cannot write .git; include untracked_files from status.yaml), ` +
            `then dispatch the next task with 'next'.`,
        );
      } else {
        console.error(`${id} failed: ${failureReason}`);
        if (!engineOk) {
          if (result.exitCode === 127) {
            console.error(
              `hint: run 'sdd-worker doctor'. Install the ${task.engine.name} CLI or switch engine ` +
                `(retry with --engine <other>). Do not preflight engines yourself before dispatches.`,
            );
          } else {
            console.error(
              `hint: tail -n 50 ${attemptRel}/stdout.jsonl. Change engine, model, or constraints before any retry ` +
                `(max 2 retries, never retry unchanged). Full tree: sdd-worker guide triage`,
            );
          }
        } else if (workerHalted) {
          console.error(
            "hint: read report.yaml (concerns field) — the worker is blocked or asking a question. Amend the task constraints to answer it, then retry. Do not retry unchanged.",
          );
        } else if (!verifyOk) {
          console.error(
            `hint: tail -n 50 ${attemptRel}/verify.log — trust verify over the report's claim. ` +
              `Fix trivially yourself (direct-edit rule) or retry with the failing output appended as a constraint.`,
          );
        } else if (!reportPresent) {
          console.error(
            `hint: verify passed but report.yaml is missing. Choose ONE (never both): review diff.patch and accept ` +
              `('sdd-worker accept ${id} --note "..."' then commit), OR retry. If the work looks right, accept — do not re-run it.`,
          );
        } else {
          console.error(
            `hint: report status "${reportStatus}" is unrecognized and verify passed. Choose ONE (never both): review diff.patch ` +
              `and accept ('sdd-worker accept ${id} --note "..."' then commit), OR retry.`,
          );
        }
      }
      return succeeded ? 0 : result.exitCode === 0 ? 1 : result.exitCode;
    } finally {
      await releaseLock(workspace, slug);
    }
  }

  if (command === "retry") {
    const id = rest[0];
    if (!id) throw new Error("Usage: retry <TASK-ID> [--plan <plan.md>] [--engine codex] [--model gpt-5.4]");
    const index = Number(id.replace(/^TASK-/, ""));
    if (!Number.isFinite(index) || index < 1) throw new Error("invalid task id");
    const active = await resolveActivePlan(workspace, flags);
    const progress = await loadProgressFor(workspace, active.slug);
    const item = progress.tasks[id];
    if (!item) throw new Error(`${id} not found in progress.yaml`);
    item.status = "needs_retry";
    const engine = asEngine(flags.engine) ?? item.engine ?? "codex";
    const model = typeof flags.model === "string" ? flags.model : item.model ?? undefined;
    const agent = item.agent ?? "executor";
    if (!item.attempts) item.attempts = [];
    item.attempts.push({
      type: "retry_requested",
      engine,
      model: model ?? null,
      requested_at: new Date().toISOString(),
    });
    await saveProgress(workspace, active.slug, progress);
    return run([
      "run",
      progress.plan,
      "--task",
      id,
      "--engine",
      engine,
      ...(model ? ["--model", model] : []),
      "--agent",
      agent,
    ]);
  }

  if (command === "review") {
    const id = rest[0];
    if (!id) throw new Error("Usage: review <TASK-ID> [--plan <plan.md>] [--engine codex] [--model gpt-5.5]");
    const active = await resolveActivePlan(workspace, flags);
    const progress = await loadProgressFor(workspace, active.slug);
    const item = progress.tasks[id];
    if (!item) throw new Error(`${id} not found in progress.yaml`);
    const taskDir = join(workspace, item.path);
    const task = await readYaml<TaskSpec>(join(taskDir, "task.yaml"));
    const engine = asEngine(flags.engine) ?? item.engine ?? task.engine.name;
    const model = typeof flags.model === "string" ? flags.model : undefined;
    const { reviewTask, dispatchPath } = await prepareReview({ workspace, task, taskDir, engine, model });
    if (!item.attempts) item.attempts = [];
    const attemptNumber = item.attempts.length + 1;
    const attemptSlug = String(attemptNumber).padStart(3, "0") + "-review-" + reviewTask.engine.name + (reviewTask.engine.model ? "-" + reviewTask.engine.model : "");
    const attemptDir = join(taskDir, "attempts", attemptSlug);
    await ensureDir(attemptDir);

    const adapter = getAdapter(reviewTask.engine.name);
    const result = await adapter.run({
      workspace,
      taskDir,
      task: reviewTask,
      dispatchPath,
      stdoutPath: join(attemptDir, "stdout.jsonl"),
      finalPath: join(attemptDir, "final.md"),
      mode: "review",
    });
    item.attempts.push({
      type: "review",
      id: attemptSlug,
      engine: reviewTask.engine.name,
      model: reviewTask.engine.model ?? null,
      exit_code: result.exitCode,
      reviewed_at: new Date().toISOString(),
    });
    item.reviewed = result.exitCode === 0 && existsSync(join(taskDir, "review.yaml"));
    await saveProgress(workspace, active.slug, progress);
    return result.exitCode;
  }

  if (command === "accept") {
    const id = rest[0];
    if (!id) throw new Error('Usage: accept <TASK-ID> [--note "why"] [--plan <plan.md>]');
    const active = await resolveActivePlan(workspace, flags);
    const progress = await loadProgressFor(workspace, active.slug);
    const item = progress.tasks[id];
    if (!item) throw new Error(`${id} not found in progress.yaml`);
    if (item.status === "complete") {
      console.log(`${id} is already complete`);
      return 0;
    }
    item.status = "complete";
    if (!item.attempts) item.attempts = [];
    item.attempts.push({
      type: "orchestrator-accept",
      note: typeof flags.note === "string" ? flags.note : "accepted manually after diff review",
      accepted_at: new Date().toISOString(),
    });
    await saveProgress(workspace, active.slug, progress);
    console.log(`${id} accepted (complete).`);
    console.log("next: commit the accepted work if not committed yet, then dispatch the next task with 'next'.");
    return 0;
  }

  if (command === "set") {
    const [id, key, value] = rest;
    if (!id || !key || !value) throw new Error("Usage: set <TASK-ID> engine|model <value> [--plan <plan.md>]");
    const active = await resolveActivePlan(workspace, flags);
    const progress = await loadProgressFor(workspace, active.slug);
    const item = progress.tasks[id];
    if (!item) throw new Error(`${id} not found in progress.yaml`);
    if (key === "engine") item.engine = asEngine(value) ?? item.engine;
    else if (key === "model") item.model = value;
    else throw new Error("key must be engine or model");
    await saveProgress(workspace, active.slug, progress);
    console.log(`updated ${id} ${key}=${value}`);
    return 0;
  }

  throw new Error(`unknown command: ${command}`);
}

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);

