import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

interface StageResult {
  id: string;
  command: string[];
  exitCode: number;
  durationMs: number;
  log: string;
  summary?: string;
}

function git(...args: string[]): string {
  const result = spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed.`);
  return result.stdout.trim();
}

function trackedCandidateFiles(): string[] {
  return git("ls-files")
    .split("\n")
    .filter(Boolean)
    .filter((filename) =>
      filename.startsWith("src/")
      || filename.startsWith("test/")
      || filename.startsWith("apps/console/")
      || ["package.json", "pnpm-lock.yaml", "tsconfig.json"].includes(filename),
    )
    .sort();
}

function hashFiles(files: string[]): Record<string, string> {
  return Object.fromEntries(files.map((filename) => [
    filename,
    createHash("sha256").update(readFileSync(path.resolve(filename))).digest("hex"),
  ]));
}

function stripAnsi(value: string): string {
  return value.replaceAll(/\u001b\[[0-9;]*m/g, "");
}

function stage(
  artifactDirectory: string,
  id: string,
  command: string[],
  environment: NodeJS.ProcessEnv = process.env,
): StageResult {
  const startedAt = Date.now();
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(output);
  const log = path.join(artifactDirectory, `${id}.log`);
  writeFileSync(log, output, { mode: 0o600 });
  const clean = stripAnsi(output);
  const testSummary = clean.match(/Test Files\s+([^\n]+)\n\s*Tests\s+([^\n]+)/);
  const stageResult: StageResult = {
    id,
    command,
    exitCode: result.status ?? 1,
    durationMs: Date.now() - startedAt,
    log,
    ...(testSummary ? { summary: `Test files ${testSummary[1]!.trim()}; tests ${testSummary[2]!.trim()}` } : {}),
  };
  if (stageResult.exitCode !== 0) throw new Error(`Final confirmation stage ${id} failed. See ${log}.`);
  return stageResult;
}

const dirty = git("status", "--porcelain");
if (dirty) throw new Error("Final confirmation requires a clean committed worktree.");
const candidateCommit = git("rev-parse", "HEAD");
const branch = git("branch", "--show-current");
const runId = `pilot-confirmation-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const artifactDirectory = path.resolve("artifacts", "final-pilot-confirmation", runId);
mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
const files = trackedCandidateFiles();
const beforeHashes = hashFiles(files);
writeFileSync(path.join(artifactDirectory, "candidate-hashes.json"), `${JSON.stringify(beforeHashes, null, 2)}\n`, { mode: 0o600 });

const node = process.execPath;
const stages: StageResult[] = [];
stages.push(stage(artifactDirectory, "01-typecheck", [node, "node_modules/typescript/bin/tsc", "--noEmit"]));
stages.push(stage(artifactDirectory, "02-console-javascript", [node, "--check", "apps/console/frontend/app.js"]));
stages.push(stage(artifactDirectory, "03-ordinary-suite", [node, "node_modules/vitest/vitest.mjs", "run"]));
stages.push(stage(
  artifactDirectory,
  "04-genuine-local-systems",
  [
    node,
    "node_modules/vitest/vitest.mjs",
    "run",
    "--no-file-parallelism",
    "test/real-erpnext-integration.test.ts",
    "test/real-erpnext-product.test.ts",
    "test/real-erpnext-procurement-confirmation.test.ts",
    "test/real-erpnext-sidecar-pilot.test.ts",
    "test/real-gitea-integration.test.ts",
  ],
  { ...process.env, CF_REAL_ERPNEXT: "1", CF_REAL_GITEA: "1" },
));
const simulatedPilotRoot = path.join(artifactDirectory, "simulated-controlled-pilot");
stages.push(stage(
  artifactDirectory,
  "05-simulated-controlled-pilot",
  [node, "--import", "tsx", "src/product/run-simulated-pilot-cli.ts"],
  { ...process.env, CF_SIMULATED_PILOT_ROOT: simulatedPilotRoot },
));

const afterCommit = git("rev-parse", "HEAD");
const afterDirty = git("status", "--porcelain");
const afterHashes = hashFiles(files);
const changedFiles = files.filter((filename) => beforeHashes[filename] !== afterHashes[filename]);
const passed = afterCommit === candidateCommit && !afterDirty && changedFiles.length === 0 && stages.every((item) => item.exitCode === 0);
const report = {
  schemaVersion: "1.0",
  runId,
  candidateCommit,
  branch,
  startedFromCleanWorktree: true,
  sourceFilesFrozen: files.length,
  sourceHashesUnchanged: changedFiles.length === 0,
  commitUnchanged: afterCommit === candidateCommit,
  worktreeCleanAfter: !afterDirty,
  modelCalls: 0,
  paidApiSpendUsd: 0,
  stages,
  simulatedPilotReport: path.join(simulatedPilotRoot, "simulated-pilot-report.json"),
  changedFiles,
  passed,
  boundary: "Private local development confirmation. Not a customer system, production reliability proof, security certification, commercial validation, or formal final green verdict.",
  completedAt: new Date().toISOString(),
};
writeFileSync(path.join(artifactDirectory, "confirmation-report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!passed) process.exitCode = 1;
