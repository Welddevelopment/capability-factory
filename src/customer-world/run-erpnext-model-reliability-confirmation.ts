import "dotenv/config";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BudgetTracker } from "../budget.js";
import { requireApiKey } from "../config.js";
import type { CapabilityManifest } from "../manifest.js";
import { OpenAIModelGateway } from "../model-gateway.js";
import { TraceWriter } from "../trace.js";
import { StructuredManifestBuilder } from "../product/builder.js";
import type { CapabilityRequest, VerificationReceipt } from "../product/contracts.js";
import {
  CapabilityCoordinator,
  type RepairableCapabilityBuilder,
} from "../product/coordinator.js";
import { OpenAIStructuredManifestDraftGateway } from "../product/openai-draft-gateway.js";
import { CapabilityFactorySdk } from "../product/sdk.js";
import { FileTenantCapabilityStore } from "../product/store.js";
import { startRealErpNextProcurementWorld } from "./real-erpnext-procurement-world.js";
import {
  procurementEnvironmentPreflight,
  ProcurementProbingVerifier,
  procurementRequestFor,
  ProcurementRuntimeResolver,
  ProcurementWorkflow,
} from "./run-procurement-model-confirmation.js";

const PROTOCOL = "erpnext-model-reliability-v1";
const CASES = [
  {
    id: "procurement-exactly-once",
    probe: "campaign-a-probe",
    build: "campaign-a-build",
    reuse: "campaign-a-reuse",
    summary: "Ensure the exact approved material request ends with one linked draft purchase order and its reference recorded; reconcile an existing matching order before any create.",
  },
  {
    id: "procurement-minimum-write",
    probe: "campaign-b-probe",
    build: "campaign-b-build",
    reuse: "campaign-b-reuse",
    summary: "Take only the authorized steps needed to turn this approved request into the required supplier order, without duplicating a purchase order if an earlier attempt already committed.",
  },
  {
    id: "procurement-plain-operator",
    probe: "campaign-c-probe",
    build: "campaign-c-build",
    reuse: "campaign-c-reuse",
    summary: "Finish purchasing for this one approved material request: check whether its order already exists, create it once if needed, then save the order reference back on the request.",
  },
  {
    id: "procurement-reconcile-first",
    probe: "campaign-a-probe",
    build: "campaign-a-build",
    reuse: "campaign-a-reuse",
    summary: "Before creating anything, search for the unique purchase-order operation tied to this material request. Leave exactly one correct order and update only the source request with its reference.",
  },
] as const;
const FROZEN_FILES = [
  "scripts/erpnext/seed_procurement_confirmation.py",
  "src/runtime.ts",
  "src/model-gateway.ts",
  "src/product/builder.ts",
  "src/product/coordinator.ts",
  "src/product/openai-draft-gateway.ts",
  "src/product/sdk.ts",
  "src/product/store.ts",
  "src/customer-world/real-erpnext-procurement-world.ts",
  "src/customer-world/real-erpnext-procurement-execution.ts",
  "src/customer-world/run-procurement-model-confirmation.ts",
  "src/customer-world/run-erpnext-model-reliability-confirmation.ts",
] as const;

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function hash(filename: string): string {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

class CountingBuilder implements RepairableCapabilityBuilder {
  buildCalls = 0;
  repairCalls = 0;
  constructor(private readonly builder: StructuredManifestBuilder) {}
  build(request: CapabilityRequest): Promise<CapabilityManifest> {
    this.buildCalls += 1;
    return this.builder.build(request);
  }
  repair(request: CapabilityRequest, previous: CapabilityManifest, verification: VerificationReceipt): Promise<CapabilityManifest> {
    this.repairCalls += 1;
    return this.builder.repair(request, previous, verification);
  }
}

async function main(): Promise<void> {
  if (process.env.CF_ERPNEXT_RELIABILITY_ACK !== PROTOCOL) {
    throw new Error(`Set CF_ERPNEXT_RELIABILITY_ACK=${PROTOCOL} to authorize this bounded paid confirmation.`);
  }
  const startingCommit = git("rev-parse", "HEAD");
  if (git("status", "--porcelain", "--untracked-files=no") !== "") {
    throw new Error("Tracked source must be clean before the ERPNext reliability freeze.");
  }
  const campaignId = `${PROTOCOL}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  const directory = path.resolve("artifacts", "erpnext-model-reliability", campaignId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const sourceHashes = Object.fromEntries(FROZEN_FILES.map((filename) => [filename, hash(filename)]));
  const world = await startRealErpNextProcurementWorld({ repositoryRoot: process.cwd() });
  try {
    const preflight = await procurementEnvironmentPreflight(world);
    const freeze = {
      protocol: PROTOCOL,
      campaignId,
      gitCommit: startingCommit,
      frozenAt: new Date().toISOString(),
      model: "gpt-5.6-sol",
      reasoning: "low",
      cases: CASES,
      preflight,
      successRule: "All four isolated cases build and genuinely probe the capability, complete and directly verify one exact ERPNext outcome, then reuse the retained capability through a fresh SDK process with zero incorrect side effects.",
      budget: { maximumCases: 4, maximumPaidCalls: 20, additionalSpendCeilingUsd: 5 },
      sourceHashes,
      evidenceBoundary: "Fresh private local genuine-ERPNext development confirmation across new need phrasings; not a customer system, arbitrary workflow transfer, or production reliability.",
    };
    fs.writeFileSync(path.join(directory, "campaign-freeze.json"), `${JSON.stringify(freeze, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    if (!preflight.passed) throw new Error("ERPNext reliability preflight failed before any model call.");
    if (process.env.CF_ERPNEXT_RELIABILITY_DRY_RUN === "1") {
      console.log(JSON.stringify({ directory, dryRun: true, preflightPassed: true }));
      return;
    }

    const budget = new BudgetTracker(path.join(directory, "budget.json"), { warnUsd: 3, maxUsd: 5, maxRunUsd: 3 });
    const results: Array<Record<string, unknown>> = [];
    for (const testCase of CASES) {
      const caseDirectory = path.join(directory, testCase.id);
      fs.mkdirSync(caseDirectory, { recursive: true, mode: 0o700 });
      const gateway = new OpenAIModelGateway(requireApiKey(), budget, new TraceWriter(testCase.id, path.join(caseDirectory, "trace")));
      const resolver = new ProcurementRuntimeResolver(world);
      const builder = new CountingBuilder(new StructuredManifestBuilder({
        documentation: { resolve: async () => world.documentation },
        gateway: new OpenAIStructuredManifestDraftGateway(gateway),
        maxAttempts: 3,
      }));
      const registry = path.join(caseDirectory, "registry");
      const makeSdk = () => new CapabilityFactorySdk({
        coordinator: new CapabilityCoordinator({
          store: new FileTenantCapabilityStore(registry),
          builder,
          verifier: new ProcurementProbingVerifier(world, testCase.probe),
          runtimeResolver: resolver,
          maxVerificationRepairs: 2,
        }),
        runtimeResolver: resolver,
      });
      const result: Record<string, unknown> = { id: testCase.id, startedAt: new Date().toISOString() };
      try {
        world.reset(testCase.build);
        const build = await makeSdk().completeBlockedGoal(
          procurementRequestFor(world, testCase.id, testCase.build, `${campaignId}-${testCase.id}-build`, testCase.summary),
          new ProcurementWorkflow(world, testCase.build),
        );
        const buildDirect = world.verify(testCase.build);
        world.reset(testCase.reuse);
        const reuse = build.status === "completed"
          ? await makeSdk().completeBlockedGoal(
              procurementRequestFor(world, testCase.id, testCase.reuse, `${campaignId}-${testCase.id}-reuse`, testCase.summary),
              new ProcurementWorkflow(world, testCase.reuse),
            )
          : null;
        const reuseDirect = world.verify(testCase.reuse);
        Object.assign(result, {
          passed: build.status === "completed"
            && build.capabilitySource === "built"
            && buildDirect.passed
            && buildDirect.incorrectSideEffects === 0
            && reuse?.status === "completed"
            && reuse.capabilitySource === "reused"
            && reuseDirect.passed
            && reuseDirect.incorrectSideEffects === 0
            && builder.buildCalls === 1,
          build: { status: build.status, capabilitySource: build.status === "completed" ? build.capabilitySource : undefined, direct: buildDirect },
          reuse: { status: reuse?.status ?? "not-run", capabilitySource: reuse?.status === "completed" ? reuse.capabilitySource : undefined, direct: reuseDirect },
          builderCalls: builder.buildCalls,
          repairCalls: builder.repairCalls,
        });
      } catch (error) {
        Object.assign(result, { passed: false, error: error instanceof Error ? { name: error.name, message: error.message } : String(error) });
      }
      Object.assign(result, { modelCalls: gateway.callCount(), spentUsd: gateway.spentUsd(), completedAt: new Date().toISOString() });
      results.push(result);
      fs.writeFileSync(path.join(caseDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    }

    for (const [filename, expected] of Object.entries(sourceHashes)) {
      if (hash(filename) !== expected) throw new Error(`Frozen ERPNext reliability source changed: ${filename}`);
    }
    const totalCalls = results.reduce((sum, result) => sum + Number(result.modelCalls ?? 0), 0);
    const spentUsd = results.reduce((sum, result) => sum + Number(result.spentUsd ?? 0), 0);
    const sourceUnchanged = git("rev-parse", "HEAD") === startingCommit
      && git("status", "--porcelain", "--untracked-files=no") === "";
    const passed = sourceUnchanged
      && results.length === CASES.length
      && results.every((result) => result.passed === true)
      && totalCalls <= 20
      && spentUsd <= 5;
    const summary = {
      protocol: PROTOCOL,
      campaignId,
      passed,
      sourceUnchanged,
      casesPassed: results.filter((result) => result.passed === true).length,
      casesAttempted: results.length,
      totalCalls,
      spentUsd,
      results,
    };
    fs.writeFileSync(path.join(directory, "result.json"), `${JSON.stringify(summary, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    console.log(JSON.stringify({ directory, passed, casesPassed: summary.casesPassed, casesAttempted: summary.casesAttempted, totalCalls, spentUsd }, null, 2));
    if (!passed) process.exitCode = 1;
  } finally {
    await world.close();
  }
}

await main();
