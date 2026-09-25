import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EXPERIMENT_LIMITS } from "./config.js";

const frozenFiles = [
  "src/budget.ts",
  "src/company-server.ts",
  "src/config.ts",
  "src/database.ts",
  "src/evaluation.ts",
  "src/freeze.ts",
  "src/prompts.ts",
  "src/factory.ts",
  "src/manual-manifest.ts",
  "src/verifier.ts",
  "src/scenario.ts",
  "src/manifest.ts",
  "src/model-gateway.ts",
  "src/registry.ts",
  "src/runtime.ts",
  "src/task-state.ts",
  "src/tool-host.ts",
  "src/trace.ts",
  "src/worker.ts",
  "pnpm-lock.yaml",
] as const;

export interface FreezeRecord {
  schemaVersion: "1";
  createdAt: string;
  commitSha: string;
  dependencyLockHash: string;
  promptHash: string;
  generatorHash: string;
  verifierHash: string;
  scenarioGeneratorHash: string;
  manifestSchemaHash: string;
  files: Record<string, string>;
  limits: typeof EXPERIMENT_LIMITS;
}

function hashFile(filename: string): string {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

export function assertCleanRepository(): void {
  if (git("status", "--porcelain")) {
    throw new Error("Evaluation freeze requires a clean committed repository");
  }
}

export function createFreezeRecord(artifactsDirectory: string): FreezeRecord {
  assertCleanRepository();
  const record: FreezeRecord = {
    schemaVersion: "1",
    createdAt: new Date().toISOString(),
    commitSha: git("rev-parse", "HEAD"),
    dependencyLockHash: hashFile("pnpm-lock.yaml"),
    promptHash: hashFile("src/prompts.ts"),
    generatorHash: hashFile("src/factory.ts"),
    verifierHash: hashFile("src/verifier.ts"),
    scenarioGeneratorHash: hashFile("src/scenario.ts"),
    manifestSchemaHash: hashFile("src/manifest.ts"),
    files: Object.fromEntries(frozenFiles.map((filename) => [filename, hashFile(filename)])),
    limits: EXPERIMENT_LIMITS,
  };
  const directory = path.join(artifactsDirectory, "freezes");
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, `${record.createdAt.replaceAll(/[:.]/g, "-")}.json`);
  fs.writeFileSync(filename, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(directory, "latest.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

export function verifyLatestFreeze(artifactsDirectory: string): FreezeRecord {
  assertCleanRepository();
  const filename = path.join(artifactsDirectory, "freezes", "latest.json");
  if (!fs.existsSync(filename)) throw new Error("No evaluation freeze exists");
  const record = JSON.parse(fs.readFileSync(filename, "utf8")) as FreezeRecord;
  if (record.commitSha !== git("rev-parse", "HEAD")) throw new Error("Commit does not match the evaluation freeze");
  for (const [file, expectedHash] of Object.entries(record.files)) {
    if (hashFile(file) !== expectedHash) throw new Error(`Frozen file changed: ${file}`);
  }
  if (JSON.stringify(record.limits) !== JSON.stringify(EXPERIMENT_LIMITS)) {
    throw new Error("Experiment limits changed after the freeze");
  }
  return record;
}
