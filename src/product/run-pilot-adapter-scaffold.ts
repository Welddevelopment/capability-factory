import fs from "node:fs";
import path from "node:path";
import {
  createPilotAdapterScaffold,
  pilotAdapterIntakeSchema,
} from "./pilot-adapter-scaffold.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredFlag(name: string): string {
  const value = flag(name);
  if (!value) throw new Error(`Missing required --${name} value.`);
  return value;
}

function relativeImport(fromDirectory: string, target: string): string {
  const relative = path.relative(fromDirectory, target).replaceAll(path.sep, "/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

const inputFilename = path.resolve(requiredFlag("input"));
const outputDirectory = path.resolve(requiredFlag("output"));
const documentationRoot = path.resolve(flag("documentation-root") ?? path.dirname(inputFilename));
const intake = pilotAdapterIntakeSchema.parse(JSON.parse(fs.readFileSync(inputFilename, "utf8")) as unknown);
const productImport = relativeImport(outputDirectory, path.resolve("src/product/pilot-adapter.js"));
const result = createPilotAdapterScaffold({ intake, documentationRoot, outputDirectory, productImport });

process.stdout.write(`${JSON.stringify({
  adapterId: result.adapterId,
  outputDirectory: result.outputDirectory,
  documentationHash: result.documentationLock.aggregateSha256,
  files: result.files,
  checks: result.checks,
  nextStep: "Complete customer-input-checklist.md, then implement the fail-closed adapter wiring.",
}, null, 2)}\n`);
