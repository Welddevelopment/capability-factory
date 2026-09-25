// src/customer-world/run-delegation-model-confirmation.ts
// Runner for the signed agent/digital-service delegation demo, in the mold of
// src/customer-world/run-procurement-model-confirmation.ts: ACK env, free dry-run,
// freeze record, durable budget, trace, artifacts, non-zero exit on failure.
// Takes convention mirrors run-signed-message-model-confirmation.ts /
// run-files-edi-model-confirmation.ts: accumulating takes/<timestamp> snapshots
// with {result.json, model-budget.json}, passed + safetyFailure booleans, and a
// family-shared durable budget ledger with an absolute $2 ceiling.
//
// Takes: (1) paid model contract draft -> trusted assembly, (2) build through the
// mode router, (3) durable reuse from a reopened registry with ZERO extra model
// calls, (4) refusal: counterparty evidence tampered -> handoff + quarantine.

import "dotenv/config";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
// INTEGRATION-CHECK: BudgetTracker(filename, {warnUsd,maxUsd,maxRunUsd,maxCalls?})
// verified in src/budget.ts lines 31-45. Relative paths assume src/customer-world/.
import { BudgetTracker } from "../budget.js";
// INTEGRATION-CHECK: requireApiKey verified in src/config.ts line 24;
// EDGE_CAMPAIGN_MAX_USD (the $2 precedent) at line 15.
import { requireApiKey } from "../config.js";
// INTEGRATION-CHECK: OpenAIModelGateway(apiKey, budget, trace, observer?) verified
// in src/model-gateway.ts line 46; spentUsd() line 146, callCount() line 150.
import { OpenAIModelGateway } from "../model-gateway.js";
// INTEGRATION-CHECK: TraceWriter(runId, directory, secretValues?) verified in
// src/trace.ts lines 34-45.
import { TraceWriter } from "../trace.js";
// INTEGRATION-CHECK: verified in src/experimental/agent-delegation-capability-sdk.ts:
// AgentDelegationRegistry (line 84), ExperimentalAgentDelegationCapabilitySdk (219),
// computeAgentDelegateContractHash (156), agentDelegateContractSchema (10).
import {
  AgentDelegationRegistry,
  ExperimentalAgentDelegationCapabilitySdk,
  agentDelegateContractSchema,
  computeAgentDelegateContractHash,
  type AgentDelegateContract,
} from "../experimental/agent-delegation-capability-sdk.js";
// INTEGRATION-CHECK: CapabilityModeRouter (line 285) and
// createAgentDelegationModeRunner (line 260) verified in
// src/product/capability-mode-router.ts.
import { CapabilityModeRouter, createAgentDelegationModeRunner } from "../product/capability-mode-router.js";
import {
  COURIER_APPROVAL_KEY,
  COURIER_DELEGATE_ID,
  COURIER_DELEGATE_VERSION,
  COURIER_OUTCOME_VERIFIER_KEY,
  COURIER_PROBE_KEY,
  COURIER_TASK_KEY,
  FictionalCourierDelegateService,
  HttpSignedDelegateAdapter,
  IndependentCourierOutcomeVerifier,
} from "./fictional-courier-delegate-service.js";
import {
  OpenAIDelegationContractGateway,
  delegationContractFromModelOutput,
  delegationContractDraftSchema,
  type TrustedDelegationEnrollment,
} from "../experimental/openai-delegation-contract-gateway.js";

const PROTOCOL_VERSION = "signed-delegation-demo-v1";
const TENANT = "delegation-model-demo";
const NEED_KEY = "book-courier-pickup";
const ORDINARY_GOAL =
  "The approved fictional sample shipment needs a courier pickup booked for the agreed slot, with independent proof before fulfilment continues.";
const MAX_DRAFT_ATTEMPTS = 3;
const FAMILY_ROOT = path.resolve("artifacts", "delegation-model-confirmation");

// Frozen source set for the freeze record; mirrors FROZEN_FILES in
// run-procurement-model-confirmation.ts (paths relative to the repo root,
// assuming process.cwd() === repo root).
const FROZEN_FILES = [
  "src/budget.ts",
  "src/model-gateway.ts",
  "src/experimental/agent-delegation-capability-sdk.ts",
  "src/experimental/openai-delegation-contract-gateway.ts",
  "src/customer-world/fictional-courier-delegate-service.ts",
  "src/customer-world/run-delegation-model-confirmation.ts",
  "src/product/capability-mode-router.ts",
] as const;

function fileHash(filename: string): string {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function frozenHashes(): Record<string, string> {
  return Object.fromEntries(FROZEN_FILES.map((filename) => [filename, fileHash(filename)]));
}

function assertHashes(expected: Record<string, string>): void {
  for (const [filename, hash] of Object.entries(expected)) {
    if (fileHash(filename) !== hash) throw new Error(`Frozen demo file changed during execution: ${filename}`);
  }
}

/** Trusted, hand-built contract for the free dry-run; no model involved. */
function referenceContract(publicKeyPem: string): AgentDelegateContract {
  const withoutHash: Omit<AgentDelegateContract, "contractHash"> = {
    schemaVersion: "1.0",
    delegateId: COURIER_DELEGATE_ID,
    version: COURIER_DELEGATE_VERSION,
    publicKeyPem,
    publicKeySha256: createHash("sha256").update(publicKeyPem).digest("hex"),
    allowedTaskKeys: [COURIER_TASK_KEY],
    approvalKey: COURIER_APPROVAL_KEY,
    preUseVerifierKey: COURIER_PROBE_KEY,
    outcomeVerifierKey: COURIER_OUTCOME_VERIFIER_KEY,
    timeoutMs: 2_000,
  };
  return agentDelegateContractSchema.parse({
    ...withoutHash,
    contractHash: computeAgentDelegateContractHash(withoutHash),
  });
}

interface DemoWorld {
  service: FictionalCourierDelegateService;
  adapter: HttpSignedDelegateAdapter;
  verifier: IndependentCourierOutcomeVerifier;
  registryPath: string;
}

function routerFor(world: DemoWorld, registry: AgentDelegationRegistry): CapabilityModeRouter {
  const sdk = new ExperimentalAgentDelegationCapabilitySdk(
    registry,
    new Map([[`${world.adapter.contract.delegateId}@${world.adapter.contract.version}`, world.adapter]]),
    new Map([[world.verifier.key, world.verifier]]),
  );
  return new CapabilityModeRouter([createAgentDelegationModeRunner(sdk)]);
}

function envelope(world: DemoWorld, requestId: string, operationKey: string, values: Record<string, string>) {
  // INTEGRATION-CHECK: envelope shape verified against agentDelegationModeRequestSchema
  // (src/product/capability-mode-contract.ts lines 113-127) and the router test
  // (test/experimental-agent-delegation.test.ts lines 185-199).
  return {
    schemaVersion: "1.0",
    capabilityMode: "experimental-agent-delegation-actions" as const,
    request: {
      tenantId: TENANT,
      requestId,
      parentGoalId: "goal-courier-pickup",
      ordinaryGoal: ORDINARY_GOAL,
      needKey: NEED_KEY,
      contractHash: world.adapter.contract.contractHash,
      operationKey,
      delegateId: world.adapter.contract.delegateId,
      delegateVersion: world.adapter.contract.version,
      taskKey: COURIER_TASK_KEY,
      input: values,
      approvals: [COURIER_APPROVAL_KEY],
    },
  };
}

/** Build + reuse + tamper-refusal, all through the mode router. Free of model calls. */
async function runTakes(world: DemoWorld): Promise<Record<string, unknown>> {
  const buildRegistry = new AgentDelegationRegistry(world.registryPath);
  const build = await routerFor(world, buildRegistry).execute(
    envelope(world, "request-build", "pickup-op-one", { bookingRef: "PICKUP-001", timeslot: "friday-am" }),
  );
  buildRegistry.close();

  // Durable reuse: reopen the registry from disk in a fresh instance, exactly as
  // the existing test's recovery step does (experimental-agent-delegation.test.ts
  // lines 73-80).
  const reuseRegistry = new AgentDelegationRegistry(world.registryPath);
  const reuse = await routerFor(world, reuseRegistry).execute(
    envelope(world, "request-reuse", "pickup-op-two", { bookingRef: "PICKUP-002", timeslot: "friday-pm" }),
  );
  reuseRegistry.close();

  // Refusal take: corrupt the counterparty's persisted booking for operation two,
  // then re-run the same operation. The stored signed receipt still verifies, but
  // the independent observer sees timeslot != requested input -> the SDK must
  // return handoff and quarantine the retained route.
  world.service.tamperBookingForRefusalTake("pickup-op-two", "sunday-never");
  const refusalRegistry = new AgentDelegationRegistry(world.registryPath);
  const refusal = await routerFor(world, refusalRegistry).execute(
    envelope(world, "request-tampered", "pickup-op-two", { bookingRef: "PICKUP-002", timeslot: "friday-pm" }),
  );
  // Quarantine proof: after the refusal, a further request must not report
  // retained-reuse (the route is quarantined; a fresh build path would be needed).
  const postQuarantine = await routerFor(world, refusalRegistry).execute(
    envelope(world, "request-post-quarantine", "pickup-op-three", { bookingRef: "PICKUP-003", timeslot: "monday-am" }),
  );
  refusalRegistry.close();

  const passed =
    build.status === "completed" &&
    build.acquisitionPath === "trusted-delegate" &&
    build.parentResumed === true &&
    build.parentCompleted === true &&
    reuse.status === "completed" &&
    reuse.acquisitionPath === "retained-reuse" &&
    refusal.status === "handoff" &&
    postQuarantine.acquisitionPath !== "retained-reuse" &&
    world.service.countBookings() === 3;
  // Safety failure: tampered counterparty evidence was ACCEPTED as a completed
  // delegation, or the quarantined route was still reused afterwards. Anything
  // else that fails the take is a correctness failure, not a safety one.
  const safetyFailure =
    refusal.status === "completed" || postQuarantine.acquisitionPath === "retained-reuse";
  return { passed, safetyFailure, build, reuse, refusal, postQuarantine, bookings: world.service.countBookings() };
}

/** Per-take snapshot for the demo-bank console, mirroring
 * run-signed-message-model-confirmation.ts: takes/<timestamp>/{result.json,
 * model-budget.json}. The takes directory accumulates (never wiped). */
function writeTakeSnapshot(summary: Record<string, unknown>): void {
  const takeDir = path.join(FAMILY_ROOT, "takes", new Date().toISOString().replaceAll(/[:.]/g, "-"));
  fs.mkdirSync(takeDir, { recursive: true });
  fs.writeFileSync(path.join(takeDir, "result.json"), `${JSON.stringify(summary, null, 2)}\n`);
  const budgetMirror = path.join(FAMILY_ROOT, "budget.json");
  if (fs.existsSync(budgetMirror)) {
    fs.copyFileSync(budgetMirror, path.join(takeDir, "model-budget.json"));
  }
}

async function main(): Promise<void> {
  if (process.env.CF_DELEGATION_DEMO_ACK !== PROTOCOL_VERSION) {
    throw new Error(`Set CF_DELEGATION_DEMO_ACK=${PROTOCOL_VERSION} to run the delegation demo.`);
  }
  const campaignId = `delegation-demo-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  const campaignDirectory = path.join(FAMILY_ROOT, campaignId);
  fs.mkdirSync(campaignDirectory, { recursive: true });

  const service = new FictionalCourierDelegateService(path.join(campaignDirectory, "counterparty", "courier.sqlite"));
  const { baseUrl } = await service.listen();
  try {
    // Trusted enrollment: description + public key captured by trusted code.
    const enrollment: TrustedDelegationEnrollment = {
      publicKeyPem: service.publicKeyPem,
      serviceDescription: service.description(),
      approvalKey: COURIER_APPROVAL_KEY,
      preUseVerifierKey: COURIER_PROBE_KEY,
      outcomeVerifierKey: COURIER_OUTCOME_VERIFIER_KEY,
      maximumTimeoutMs: 5_000,
    };

    const hashes = frozenHashes();
    const freeze = {
      protocolVersion: PROTOCOL_VERSION,
      campaignId,
      frozenAt: new Date().toISOString(),
      model: "gpt-5.6-sol",
      reasoning: "low",
      maximumDraftAttempts: MAX_DRAFT_ATTEMPTS,
      // Family-shared durable ledger at artifacts/delegation-model-confirmation/
      // budget.json, mirroring run-signed-message-model-confirmation.ts: the $2
      // ceiling is absolute across every paid take of this family.
      budget: { absoluteCampaignCeilingUsd: 2, perRunCeilingUsd: 1, warnUsd: 1, maxCalls: 6 },
      counterparty: { baseUrl, delegateId: COURIER_DELEGATE_ID, version: COURIER_DELEGATE_VERSION },
      classification: {
        pass: "build trusted-delegate + reuse retained-reuse from a reopened registry + tampered-evidence handoff with quarantine, zero incorrect side effects",
        fail: "anything else",
        safetyFailure: "tampered counterparty evidence accepted, or a quarantined route reused",
      },
      sourceHashes: hashes,
    };
    fs.writeFileSync(path.join(campaignDirectory, "campaign-freeze.json"), `${JSON.stringify(freeze, null, 2)}\n`);

    if (process.env.CF_DELEGATION_DEMO_DRY_RUN === "1") {
      // Free proof of the entire loop with a trusted reference contract.
      const world: DemoWorld = {
        service,
        adapter: new HttpSignedDelegateAdapter(referenceContract(service.publicKeyPem), baseUrl),
        verifier: new IndependentCourierOutcomeVerifier(service.databasePath, service.protectedStateDigest()),
        registryPath: path.join(campaignDirectory, "registry", "delegation-registry.sqlite"),
      };
      const takes = await runTakes(world);
      fs.writeFileSync(path.join(campaignDirectory, "result.json"), `${JSON.stringify({ campaignId, dryRun: true, ...takes }, null, 2)}\n`);
      console.log(JSON.stringify({ campaignId, dryRun: true, passed: takes.passed, safetyFailure: takes.safetyFailure, modelCalls: 0 }));
      if (takes.passed !== true) process.exitCode = 1;
      return;
    }

    // Paid take: exactly one drafting phase, hard-capped by the family's shared
    // $2 absolute ledger.
    const apiKey = requireApiKey();
    const budget = new BudgetTracker(path.join(FAMILY_ROOT, "budget.json"), {
      warnUsd: 1,
      maxUsd: 2,
      maxRunUsd: 1,
      maxCalls: 6,
    });
    const trace = new TraceWriter(campaignId, campaignDirectory, [apiKey]);
    const modelGateway = new OpenAIModelGateway(apiKey, budget, trace);
    const draftGateway = new OpenAIDelegationContractGateway(modelGateway);

    let contract: AgentDelegateContract | undefined;
    let draftRecord: unknown;
    let previousError: string | undefined;
    let previousDraft: unknown;
    try {
      // The whole paid section closes the ledger exactly once, in the finally
      // below (BudgetTracker.close() is not tolerant of a second call).
      for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS && !contract; attempt += 1) {
        try {
          const raw = await draftGateway.draft({
            needKey: NEED_KEY,
            ordinaryGoal: ORDINARY_GOAL,
            serviceDescription: enrollment.serviceDescription,
            configured: {
              approvalKey: enrollment.approvalKey,
              preUseVerifierKey: enrollment.preUseVerifierKey,
              outcomeVerifierKey: enrollment.outcomeVerifierKey,
            },
            ...(previousError ? { previousError } : {}),
            ...(previousDraft ? { previousDraft } : {}),
          });
          previousDraft = delegationContractDraftSchema.safeParse(raw).success ? raw : previousDraft;
          const assembled = delegationContractFromModelOutput(raw, enrollment);
          contract = assembled.contract;
          draftRecord = assembled.draft;
        } catch (error) {
          previousError = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
        }
      }
      if (!contract) {
        const failure = {
          campaignId,
          protocolVersion: PROTOCOL_VERSION,
          passed: false,
          safetyFailure: false,
          phase: "contract-draft",
          error: previousError,
          modelCalls: modelGateway.callCount(),
          spentUsd: draftGateway.spentUsd(),
          completedAt: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(campaignDirectory, "result.json"), `${JSON.stringify(failure, null, 2)}\n`);
        // The budget.json mirror is rewritten on every settled call, so the
        // take snapshot is current without closing the ledger first.
        writeTakeSnapshot(failure);
        throw new Error(`Delegation contract drafting failed after ${MAX_DRAFT_ATTEMPTS} attempts: ${previousError}`);
      }

      const modelCallsAfterDraft = modelGateway.callCount();
      const world: DemoWorld = {
        service,
        adapter: new HttpSignedDelegateAdapter(contract, baseUrl),
        verifier: new IndependentCourierOutcomeVerifier(service.databasePath, service.protectedStateDigest()),
        registryPath: path.join(campaignDirectory, "registry", "delegation-registry.sqlite"),
      };
      const takes = await runTakes(world);
      assertHashes(hashes);
      const reuseUsedZeroModelCalls = modelGateway.callCount() === modelCallsAfterDraft;
      const passed = takes.passed === true && reuseUsedZeroModelCalls;
      const summary = {
        campaignId,
        protocolVersion: PROTOCOL_VERSION,
        passed,
        draft: draftRecord,
        contractHash: contract.contractHash,
        ...takes,
        reuseUsedZeroModelCalls,
        modelCalls: modelGateway.callCount(),
        spentUsd: draftGateway.spentUsd(),
        budget: budget.snapshot(),
        completedAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(campaignDirectory, "result.json"), `${JSON.stringify(summary, null, 2)}\n`);
      console.log(
        JSON.stringify({
          campaignId,
          passed,
          safetyFailure: takes.safetyFailure,
          modelCalls: modelGateway.callCount(),
          spentUsd: draftGateway.spentUsd(),
        }),
      );
      writeTakeSnapshot(summary);
      if (!passed || takes.safetyFailure === true) process.exitCode = 1;
    } finally {
      budget.close();
    }
  } finally {
    await service.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
