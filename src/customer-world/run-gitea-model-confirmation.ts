import "dotenv/config";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BudgetTracker } from "../budget.js";
import { requireApiKey } from "../config.js";
import type { CapabilityManifest } from "../manifest.js";
import { OpenAIModelGateway } from "../model-gateway.js";
import { CapabilityRuntime } from "../runtime.js";
import { TraceWriter } from "../trace.js";
import { StructuredManifestBuilder } from "../product/builder.js";
import type { ActionReceipt, CapabilityRequest, OutcomeReceipt, VerificationReceipt } from "../product/contracts.js";
import {
  CapabilityCoordinator,
  manifestDigest,
  type CapabilityVerifier,
  type RepairableCapabilityBuilder,
  type RuntimeResolver,
} from "../product/coordinator.js";
import { OpenAIStructuredManifestDraftGateway } from "../product/openai-draft-gateway.js";
import { CapabilityFactorySdk, type CapabilityWorkflow } from "../product/sdk.js";
import { FileTenantCapabilityStore } from "../product/store.js";
import {
  executeReconciledGiteaIssue,
  startRealGiteaWorld,
  type RealGiteaWorld,
} from "./real-gitea-world.js";

const PROTOCOL = "gitea-model-confirmation-v2";
const FROZEN_FILES = [
  "src/config.ts",
  "src/manifest.ts",
  "src/model-gateway.ts",
  "src/runtime.ts",
  "src/product/builder.ts",
  "src/product/coordinator.ts",
  "src/product/openai-draft-gateway.ts",
  "src/product/sdk.ts",
  "src/product/store.ts",
  "src/customer-world/real-gitea-world.ts",
  "src/customer-world/run-gitea-model-confirmation.ts",
] as const;

const CASES = [
  {
    id: "incident-exactly-once",
    needSummary: "Leave the approved repository with exactly one issue for this bounded synthetic incident: look for its unique marker first, then file the correctly labelled issue only if it is absent.",
  },
  {
    id: "incident-minimum-action",
    needSummary: "Take the minimum authorized action needed to ensure this one incident is represented correctly in the allowed repository, without duplicating an existing matching record.",
  },
  {
    id: "incident-reconcile-first",
    needSummary: "Reconcile the supplied incident marker against issues in the approved repository before writing; when no exact match exists, create one issue with the supplied title, body, and single label.",
  },
  {
    id: "incident-plain-operator",
    needSummary: "Check whether the specified alert has already been logged in this repository. If it has not, log it once with the required details and label; otherwise leave it alone.",
  },
] as const;

function sha256(filename: string): string {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function requestFor(world: RealGiteaWorld, requestId: string, needSummary: string): CapabilityRequest {
  const secretAlias = world.secretAlias("full");
  return {
    context: {
      tenantId: "gitea-model-confirmation",
      requestId,
      workflowKey: "gitea-incident-intake",
      ordinaryGoal: "Ensure the bounded synthetic incident is filed exactly once in the approved repository.",
      blockedAt: new Date().toISOString(),
      blockedReason: "The configured agent has no issue-list or issue-create capability for this Gitea target.",
      visibility: "full",
    },
    need: {
      key: "gitea-issue-intake-v1",
      summary: needSummary,
      requiredActions: ["list_issues", "create_issue"],
      targetAliases: ["customer_system"],
      secretAliases: [secretAlias],
      documentationHash: world.documentation.sha256,
    },
    authority: {
      allowedTargetAliases: ["customer_system"],
      allowedSecretAliases: [secretAlias],
      allowedMethods: ["GET", "POST"],
      writeAuthority: "preauthorized",
      approvedWriteActions: [],
    },
    runtimeProfile: "full",
  };
}

class GiteaRuntimeResolver implements RuntimeResolver {
  constructor(private readonly world: RealGiteaWorld) {}
  resolve(): CapabilityRuntime {
    return new CapabilityRuntime(this.world.runtimeConfiguration("full"));
  }
}

class CountingBuilder implements RepairableCapabilityBuilder {
  buildCalls = 0;
  repairCalls = 0;
  constructor(private readonly underlying: StructuredManifestBuilder) {}
  async build(request: CapabilityRequest): Promise<CapabilityManifest> {
    this.buildCalls += 1;
    return this.underlying.build(request);
  }
  async repair(
    request: CapabilityRequest,
    previousManifest: CapabilityManifest,
    verification: VerificationReceipt,
  ): Promise<CapabilityManifest> {
    this.repairCalls += 1;
    return this.underlying.repair(request, previousManifest, verification);
  }
}

class GiteaProbingVerifier implements CapabilityVerifier {
  constructor(private readonly world: RealGiteaWorld) {}

  async verify(request: CapabilityRequest, manifest: CapabilityManifest, runtime: CapabilityRuntime) {
    const checks = [{
      id: "required-actions",
      passed: request.need.requiredActions.every((name) => manifest.actions.some((action) => action.name === name)),
      detail: "The candidate contains the exact list and create action set.",
    }];
    try {
      runtime.validateManifest(manifest);
      const state = await this.world.reset("approved-write");
      await executeReconciledGiteaIssue(manifest, runtime, state, `gitea-model-probe-${request.context.requestId}`);
      const direct = await this.world.verify("approved-write");
      checks.push({
        id: "disposable-genuine-system-probe",
        passed: direct.passed && direct.incorrectSideEffects === 0,
        detail: direct.passed
          ? "The candidate completed and independently verified one disposable Gitea issue write."
          : direct.issues.map((issue) => `${issue.code}: ${issue.message}`).join(" | "),
      });
    } catch (error) {
      checks.push({
        id: "disposable-genuine-system-probe",
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await this.world.reset("approved-write");
    }
    return {
      verifierVersion: "gitea-genuine-disposable-probe-v1",
      manifestDigest: manifestDigest(manifest),
      documentationHash: request.need.documentationHash,
      passed: checks.every((item) => item.passed),
      checks,
      verifiedAt: new Date().toISOString(),
    };
  }
}

class GiteaWorkflow implements CapabilityWorkflow {
  constructor(private readonly world: RealGiteaWorld, private readonly caseId: "approved-write" | "fresh-process-reuse") {}

  execute(_request: CapabilityRequest, manifest: CapabilityManifest, runtime: CapabilityRuntime): Promise<ActionReceipt[]> {
    return executeReconciledGiteaIssue(
      manifest,
      runtime,
      this.world.currentCaseState(),
      `gitea-model-workflow-${this.caseId}`,
    );
  }

  async verifyOutcome(): Promise<OutcomeReceipt> {
    const direct = await this.world.verify(this.caseId);
    return {
      verifierVersion: "gitea-independent-admin-api-v1",
      passed: direct.passed,
      intendedWrites: direct.intendedWrites,
      incorrectSideEffects: direct.incorrectSideEffects,
      stateDigest: direct.stateHash,
      checks: direct.issues.length > 0
        ? direct.issues.map((issue) => ({ id: issue.code, passed: false, detail: issue.message }))
        : [{ id: "exact-gitea-state", passed: true, detail: "The exact issue exists once and unrelated state is unchanged." }],
      verifiedAt: new Date().toISOString(),
    };
  }

  async resume() {
    const direct = await this.world.verify(this.caseId);
    return {
      completed: direct.passed && direct.incorrectSideEffects === 0,
      summary: direct.passed
        ? "The ordinary goal resumed after independent Gitea verification."
        : "The ordinary goal did not resume because Gitea verification was not clean.",
    };
  }
}

async function main(): Promise<void> {
  if (process.env.CF_GITEA_MODEL_CONFIRM_ACK !== PROTOCOL) {
    throw new Error(`Set CF_GITEA_MODEL_CONFIRM_ACK=${PROTOCOL} to authorize this bounded paid confirmation.`);
  }
  const startingCommit = git("rev-parse", "HEAD");
  const trackedStatus = git("status", "--porcelain", "--untracked-files=no");
  if (trackedStatus !== "") throw new Error("Tracked source must be clean before the Gitea model confirmation freeze.");
  const campaignId = `${PROTOCOL}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  const directory = path.resolve("artifacts", "gitea-model-confirmation", campaignId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const sourceHashes = Object.fromEntries(FROZEN_FILES.map((filename) => [filename, sha256(filename)]));
  const freeze = {
    protocol: PROTOCOL,
    campaignId,
    gitCommit: startingCommit,
    frozenAt: new Date().toISOString(),
    model: "gpt-5.6-sol",
    reasoning: "medium",
    cases: CASES,
    successRule: "Each isolated case builds one verified capability, completes one exact issue, then a fresh SDK process reuses the retained capability on a new issue with zero incorrect side effects.",
    budget: { maximumCases: 4, maximumPaidCalls: 20, additionalSpendCeilingUsd: 5 },
    sourceHashes,
    evidenceBoundary: "Fresh private local genuine-Gitea development confirmation after a generic harness repair; not a rerun of the v1 phrasings, customer evidence, or production reliability.",
  };
  fs.writeFileSync(path.join(directory, "campaign-freeze.json"), `${JSON.stringify(freeze, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.env.CF_GITEA_MODEL_CONFIRM_DRY_RUN === "1") {
    console.log(JSON.stringify({ campaignId, dryRun: true, freeze: path.join(directory, "campaign-freeze.json") }));
    return;
  }

  const budget = new BudgetTracker(path.join(directory, "budget.json"), { warnUsd: 3, maxUsd: 5, maxRunUsd: 3 });
  const world = await startRealGiteaWorld({ repositoryRoot: process.cwd(), artifactDirectory: path.join(directory, "gitea") });
  const results: Array<Record<string, unknown>> = [];
  try {
    for (const testCase of CASES) {
      const caseDirectory = path.join(directory, testCase.id);
      fs.mkdirSync(caseDirectory, { recursive: true, mode: 0o700 });
      const gateway = new OpenAIModelGateway(
        requireApiKey(),
        budget,
        new TraceWriter(testCase.id, path.join(caseDirectory, "trace")),
      );
      const draftGateway = new OpenAIStructuredManifestDraftGateway(gateway);
      const builder = new CountingBuilder(new StructuredManifestBuilder({
        documentation: { resolve: async () => world.documentation },
        gateway: draftGateway,
        maxAttempts: 3,
      }));
      const registryDirectory = path.join(caseDirectory, "registry");
      const runtimeResolver = new GiteaRuntimeResolver(world);
      const makeSdk = () => new CapabilityFactorySdk({
        coordinator: new CapabilityCoordinator({
          store: new FileTenantCapabilityStore(registryDirectory),
          builder,
          verifier: new GiteaProbingVerifier(world),
          runtimeResolver,
          maxVerificationRepairs: 2,
        }),
        runtimeResolver,
      });
      const result: Record<string, unknown> = {
        id: testCase.id,
        startedAt: new Date().toISOString(),
        needSummary: testCase.needSummary,
      };
      try {
        await world.reset("approved-write");
        const build = await makeSdk().completeBlockedGoal(
          requestFor(world, `${campaignId}-${testCase.id}-build`, testCase.needSummary),
          new GiteaWorkflow(world, "approved-write"),
        );
        const buildDirect = await world.verify("approved-write");
        await world.reset("fresh-process-reuse");
        const reuse = build.status === "completed"
          ? await makeSdk().completeBlockedGoal(
              requestFor(world, `${campaignId}-${testCase.id}-reuse`, testCase.needSummary),
              new GiteaWorkflow(world, "fresh-process-reuse"),
            )
          : null;
        const reuseDirect = await world.verify("fresh-process-reuse");
        const passed = build.status === "completed"
          && build.capabilitySource === "built"
          && buildDirect.passed
          && buildDirect.incorrectSideEffects === 0
          && reuse?.status === "completed"
          && reuse.capabilitySource === "reused"
          && reuseDirect.passed
          && reuseDirect.incorrectSideEffects === 0
          && builder.buildCalls === 1;
        Object.assign(result, {
          passed,
          build: { status: build.status, capabilitySource: build.status === "completed" ? build.capabilitySource : undefined, direct: buildDirect },
          reuse: { status: reuse?.status ?? "not-run", capabilitySource: reuse?.status === "completed" ? reuse.capabilitySource : undefined, direct: reuseDirect },
          builderCalls: builder.buildCalls,
          repairCalls: builder.repairCalls,
        });
      } catch (error) {
        Object.assign(result, {
          passed: false,
          error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
        });
      }
      Object.assign(result, {
        modelCalls: gateway.callCount(),
        spentUsd: gateway.spentUsd(),
        completedAt: new Date().toISOString(),
      });
      results.push(result);
      fs.writeFileSync(path.join(caseDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    }
  } finally {
    // The local disposable application remains available for deterministic reruns.
  }

  for (const [filename, expected] of Object.entries(sourceHashes)) {
    if (sha256(filename) !== expected) throw new Error(`Frozen Gitea campaign source changed: ${filename}`);
  }
  const endingCommit = git("rev-parse", "HEAD");
  const endingStatus = git("status", "--porcelain", "--untracked-files=no");
  const sourceUnchanged = endingCommit === startingCommit && endingStatus === "";
  const totalCalls = results.reduce((sum, result) => sum + Number(result.modelCalls ?? 0), 0);
  const spentUsd = results.reduce((sum, result) => sum + Number(result.spentUsd ?? 0), 0);
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
    sourceHashesUnchanged: true,
    results,
  };
  fs.writeFileSync(path.join(directory, "result.json"), `${JSON.stringify(summary, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({
    directory,
    passed,
    casesPassed: summary.casesPassed,
    casesAttempted: summary.casesAttempted,
    totalCalls,
    spentUsd,
    results: results.map((result) => ({ id: result.id, passed: result.passed, modelCalls: result.modelCalls, spentUsd: result.spentUsd })),
  }, null, 2));
  if (!passed) process.exitCode = 1;
}

await main();
