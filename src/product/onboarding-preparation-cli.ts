import fs from "node:fs";
import path from "node:path";
import {
  DurableOnboardingPreparationWorkflow,
  type ConfirmOnboardingPreparationInput,
  type OnboardingPreparationSnapshot,
  type StartOnboardingPreparationInput,
} from "./onboarding-preparation-workflow.js";

export interface OnboardingPreparationCliIo {
  stdout: { write(value: string): unknown };
  stderr: { write(value: string): unknown };
}

interface ParsedArguments {
  command: "start" | "status" | "review" | "events";
  statePath: string;
  inputPath?: string;
  sessionId?: string;
  includeArtifacts: boolean;
}

function parseArguments(argv: string[]): ParsedArguments {
  const [commandValue, ...rest] = argv;
  if (!(["start", "status", "review", "events"] as const).includes(commandValue as ParsedArguments["command"])) {
    throw new Error("Usage: product:onboarding:prepare <start|status|review|events> --state <customer-local.sqlite> [--input <json>] [--session <id>] [--include-artifacts]");
  }
  const values = new Map<string, string>();
  let includeArtifacts = false;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--include-artifacts") {
      if (includeArtifacts) throw new Error("--include-artifacts may be supplied only once.");
      includeArtifacts = true;
      continue;
    }
    if (!token?.startsWith("--")) throw new Error(`Unexpected argument ${token ?? "<missing>"}.`);
    if (values.has(token)) throw new Error(`${token} may be supplied only once.`);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
    values.set(token, value);
    index += 1;
  }
  const known = new Set(["--state", "--input", "--session"]);
  for (const key of values.keys()) if (!known.has(key)) throw new Error(`Unknown option ${key}.`);
  const statePath = values.get("--state");
  if (!statePath) throw new Error("--state is required and must identify a customer-local SQLite file.");
  const command = commandValue as ParsedArguments["command"];
  const inputPath = values.get("--input");
  const sessionId = values.get("--session");
  if ((command === "start" || command === "review") && !inputPath) throw new Error(`${command} requires --input.`);
  if ((command === "status" || command === "events") && !sessionId) throw new Error(`${command} requires --session.`);
  if ((command === "start" || command === "review") && sessionId) throw new Error(`${command} takes its stable session identity from the integrity-bound input file.`);
  if ((command === "status" || command === "events") && inputPath) throw new Error(`${command} does not accept --input.`);
  return {
    command,
    statePath: path.resolve(statePath),
    ...(inputPath ? { inputPath: path.resolve(inputPath) } : {}),
    ...(sessionId ? { sessionId } : {}),
    includeArtifacts,
  };
}

function readJson(filePath: string): unknown {
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) throw new Error(`Input path is not a regular file: ${filePath}`);
  if (stats.size > 10_000_000) throw new Error("Onboarding input exceeds the 10 MB customer-local ceiling.");
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function projectSnapshot(snapshot: OnboardingPreparationSnapshot, includeArtifacts: boolean): unknown {
  if (includeArtifacts) return snapshot;
  return {
    schemaVersion: snapshot.schemaVersion,
    sessionId: snapshot.sessionId,
    tenantId: snapshot.tenantId,
    adapterId: snapshot.adapterId,
    adapterVersion: snapshot.adapterVersion,
    status: snapshot.status,
    activation: snapshot.activation,
    inputDigest: snapshot.inputDigest,
    revision: snapshot.revision,
    snapshotDigest: snapshot.snapshotDigest,
    blockers: snapshot.blockers,
    receipt: snapshot.receipt,
    acceptancePlan: snapshot.acceptancePlan
      ? {
        planId: snapshot.acceptancePlan.planId,
        status: snapshot.acceptancePlan.status,
        executable: snapshot.acceptancePlan.executable,
        passed: snapshot.acceptancePlan.passed,
        declaredCases: snapshot.acceptancePlan.cases.length,
        blockers: snapshot.acceptancePlan.blockers,
      }
      : undefined,
    artifactExportHint: "Repeat with --include-artifacts only inside the customer-local trusted environment when exact review artifacts are required.",
  };
}

export async function runOnboardingPreparationCli(
  argv: string[],
  io: OnboardingPreparationCliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  let workflow: DurableOnboardingPreparationWorkflow | undefined;
  try {
    const args = parseArguments(argv);
    workflow = new DurableOnboardingPreparationWorkflow(args.statePath);
    let result: unknown;
    if (args.command === "start") {
      result = projectSnapshot(workflow.start(readJson(args.inputPath!) as StartOnboardingPreparationInput), args.includeArtifacts);
    } else if (args.command === "review") {
      result = projectSnapshot(workflow.confirmReview(readJson(args.inputPath!) as ConfirmOnboardingPreparationInput), args.includeArtifacts);
    } else if (args.command === "status") {
      result = projectSnapshot(workflow.read(args.sessionId!), args.includeArtifacts);
    } else {
      result = { sessionId: args.sessionId, events: workflow.events(args.sessionId!) };
    }
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : "Onboarding preparation command failed."}\n`);
    return 1;
  } finally {
    workflow?.close();
  }
}
