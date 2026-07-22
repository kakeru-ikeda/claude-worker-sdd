import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("../../runner/package.json", import.meta.url), "utf8"),
);
const tag = `v${packageJson.version}`;

try {
  execSync(`git rev-parse --verify --quiet refs/tags/${tag}`, { stdio: "ignore" });
  console.log(`tag ${tag} already exists; skipping`);
  process.exit(0);
} catch (error) {
  if (error?.status !== 1) {
    throw error;
  }
}

execSync(`git tag ${tag}`, { stdio: "inherit" });
execSync(`git push origin ${tag}`, { stdio: "inherit" });
