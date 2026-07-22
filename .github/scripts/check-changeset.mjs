import { execFileSync } from "node:child_process";

// runner/ に差分があるのに .changeset/*.md が無い PR を落とす。
// ドキュメントのみ・CI設定のみの PR は対象外にして自動 pass させる。
const baseRef = process.env.BASE_REF ?? "main";
execFileSync("git", ["fetch", "--depth=1", "origin", baseRef], { stdio: "inherit" });

const changedFiles = execFileSync(
  "git",
  ["diff", "--name-only", `origin/${baseRef}...HEAD`],
  { encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean);

const touchesRunner = changedFiles.some((file) => file.startsWith("runner/"));
if (!touchesRunner) {
  console.log("No changes under runner/; changeset not required.");
  process.exit(0);
}

const hasChangeset = changedFiles.some(
  (file) => file.startsWith(".changeset/") && file.endsWith(".md"),
);
if (!hasChangeset) {
  console.error(
    "runner/ was changed but no .changeset/*.md was added. Run `npx changeset` and commit the result.",
  );
  process.exit(1);
}

console.log("Changeset present.");
