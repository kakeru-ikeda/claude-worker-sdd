import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import YAML from "yaml";

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function writeText(path: string, text: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, text, "utf8");
}

export async function readYaml<T>(path: string): Promise<T> {
  return YAML.parse(await readText(path)) as T;
}

export async function writeYaml(path: string, value: unknown): Promise<void> {
  await writeText(path, YAML.stringify(value));
}

export function abs(workspace: string, path: string): string {
  return resolve(workspace, path);
}

