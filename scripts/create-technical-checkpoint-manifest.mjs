import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = path.resolve(root, process.argv[2] ?? "reports/technical-checkpoint-manifest.json");

const includeRoots = [
  "apps/console",
  "coordination",
  "src",
  "test",
  "validation/under-one-day-onboarding-v1",
];

const includeFiles = [
  ".gitignore",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "vitest.config.ts",
  "docs/CAPABILITY_RESOLUTION_COMPILER_PLAN_2026-08-05.md",
  "docs/CF_ONBOARDING_CLAIM_AND_RESPONSIBILITY_LEDGER_2026-08-12.md",
  "docs/CF_UNDER_ONE_DAY_ONBOARDING_VALIDATION_PLAN_2026-08-12.md",
  "docs/CONTINUOUS_ENGINEERING_QUEUE_2026-08-14.md",
  "reports/cf-onboarding-observer-and-fresh-execution-checkpoint-2026-08-12.md",
  "reports/cf-onboarding-zero-spend-checkpoint-2026-08-12.md",
  "reports/effective-universality-compiler-and-mode-parity-checkpoint-2026-08-12.md",
  "scripts/create-technical-checkpoint-manifest.mjs",
  "scripts/validate-coordination.mjs",
];

const includeGeneratedRoots = ["reports/fresh-onboarding-http-execution-2026-08-12"];
const forbiddenNames = new Set([".DS_Store", ".env", "node_modules"]);
const forbiddenExtensions = new Set([".sqlite", ".sqlite-shm", ".sqlite-wal", ".png", ".jpg", ".jpeg", ".pdf"]);

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function assertInsideRoot(file) {
  const value = relative(file);
  if (value.startsWith("../") || path.isAbsolute(value)) throw new Error(`Path escapes repository: ${file}`);
  return value;
}

function excluded(file) {
  const base = path.basename(file);
  if (forbiddenNames.has(base)) return true;
  for (const extension of forbiddenExtensions) if (base.endsWith(extension)) return true;
  return false;
}

async function collect(target) {
  const absolute = path.resolve(root, target);
  const stat = await fs.stat(absolute);
  if (stat.isFile()) return excluded(absolute) ? [] : [absolute];
  const files = [];
  for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
    if (forbiddenNames.has(entry.name)) continue;
    files.push(...await collect(path.join(target, entry.name)));
  }
  return files;
}

const files = [];
for (const target of [...includeRoots, ...includeGeneratedRoots, ...includeFiles]) {
  try {
    files.push(...await collect(target));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const unique = [...new Set(files.map((file) => path.resolve(file)))].sort();
const records = [];
for (const file of unique) {
  const contents = await fs.readFile(file);
  records.push({ path: assertInsideRoot(file), bytes: contents.byteLength, sha256: digest(contents) });
}

const manifestCore = {
  schemaVersion: "cf.technical-checkpoint-manifest.v1",
  createdAt: new Date().toISOString(),
  purpose: "Reproduce the reviewed local onboarding and effective-universality technical checkpoint without runtime databases, credentials, private application artifacts, or binary media.",
  fileCount: records.length,
  files: records,
  exclusions: [
    "runtime SQLite files and journals",
    "environment and credential files",
    "node_modules and build output",
    "private application, outreach, and demo-recording artifacts",
    "binary images and PDFs",
  ],
  claimBoundary: "This manifest records local technical source and deterministic evidence only. It does not establish customer use, production readiness, universal capability acquisition, or a formal final verdict.",
};

const manifest = { ...manifestCore, manifestSha256: digest(Buffer.from(JSON.stringify(manifestCore))) };
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "w", mode: 0o600 });
process.stdout.write(`Wrote ${relative(output)} with ${records.length} files (${manifest.manifestSha256}).\n`);
