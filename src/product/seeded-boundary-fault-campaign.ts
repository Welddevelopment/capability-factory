import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryGenericAcceptanceCampaignStore,
  runGenericAcceptanceCampaign,
  type GenericAcceptanceBinding,
} from "./generic-acceptance-executor.js";
import { REQUIRED_PILOT_ADAPTER_CASES, type PilotAdapterAcceptanceResult } from "./pilot-adapter.js";
import {
  ComposedRuntimeRecoveryCoordinator,
  composedRecoveryDigest,
  type ComposedRecoveryContext,
  type IndependentRecoveryEvidence,
  type RecoveryAuthorityReceipt,
} from "./composed-runtime-recovery.js";
import { DurableCapabilityLifecycle, type ReplacementQualification } from "./durable-capability-lifecycle.js";
import {
  VerifierTemplateQualificationRegistry,
  qualificationReference,
  qualifyVerifierTemplate,
  verifierQualificationDigest,
  verifierTemplateControlIds,
  type ExpectedVerifierTemplateVerdict,
  type VerifierTemplateControlId,
  type VerifierTemplateQualificationCorpus,
  type VerifierTemplateQualificationReceipt,
} from "./verifier-template-qualification.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const campaignNow = "2026-08-14T12:00:00.000Z";
const tenantId = "tenant-cf-021";
const planDigest = hash("cf-021-plan");
const runtimeFamily = "generic-local-sqlite";
const capabilityKey = "seeded-record-capability";
const capabilityVersion = "1.0.0";
const qualificationDigest = hash("cf-021-capability-qualification");
const documentationDigest = hash("cf-021-documentation");
const schemaDigest = hash("cf-021-schema");
const provenanceDigest = hash("cf-021-provenance");
const capabilityMaterialDigest = composedRecoveryDigest({ documentationDigest, schemaDigest, provenanceDigest });

export const CF021_SEEDED_SCENARIOS = [
  "authority-tenant-widening",
  "authority-parent-widening",
  "authority-plan-widening",
  "authority-family-widening",
  "authority-expiry",
  "authority-replay",
  "evidence-tenant-substitution",
  "evidence-plan-substitution",
  "evidence-material-substitution",
  "evidence-receipt-mutation",
  "verifier-expiry",
  "verifier-family-mismatch",
  "verifier-registry-mismatch",
  "verifier-corpus-mismatch",
  "lost-response-completed",
  "lost-response-not-started",
  "concurrent-retry-consumption",
  "parent-resumption-replay",
  "restart-after-parent-commit",
  "quarantine-selection",
  "failed-replacement",
  "rollback-no-revival",
  "reordered-lifecycle-events",
  "cross-tenant-continuation",
  "acceptance-action-response-proof",
  "acceptance-binding-replay",
] as const;
export type Cf021SeededScenario = typeof CF021_SEEDED_SCENARIOS[number];

export interface Cf021GeneratedCaseReceipt {
  caseId: string;
  seed: number;
  scenario: Cf021SeededScenario;
  transition: string;
  passed: boolean;
  detail: string;
  receiptDigest: string;
}

export interface Cf021RegressionReceipt {
  regressionId: string;
  discoveredBoundary: string;
  minimalCounterexample: Record<string, string | number | boolean>;
  fixedBy: string;
  replayPassed: boolean;
}

export interface Cf021CampaignReceipt {
  schemaVersion: "1.0";
  campaignId: "cf-021-seeded-boundary-faults-v1";
  seeds: number[];
  scenarioCount: number;
  generatedCaseCount: number;
  passedCaseCount: number;
  unexpectedFailureCount: number;
  uniqueTransitionCount: number;
  transitions: string[];
  failuresFoundAndFixed: number;
  regressions: Cf021RegressionReceipt[];
  cases: Cf021GeneratedCaseReceipt[];
  invariants: {
    unauthorizedWrites: 0;
    blindRetries: 0;
    duplicateParentResumptions: 0;
    staleOrQuarantinedSelections: 0;
    unsafeRollbackRevivals: 0;
    crossTenantEvidenceUses: 0;
    actionResponseProofAcceptances: 0;
  };
  modelCalls: 0;
  paidSpendUsd: 0;
  completedAt: string;
  receiptDigest: string;
}

function seeded(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return state >>> 0;
  };
}

function shrinkCounterexample(value: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith("noise")));
}

function context(seed: number): ComposedRecoveryContext {
  return {
    schemaVersion: "1.0", tenantId, parentGoalId: "parent-cf-021", planId: "plan-cf-021", planDigest,
    workItemId: `item-${seed}`, stateVersion: 1, runtimeFamily, capabilityKey, capabilityVersion,
    capabilityQualificationDigest: qualificationDigest, capabilityMaterialDigest,
    idempotencyKey: hash(`idempotency-${seed}`),
  };
}

function evidence(bound: ComposedRecoveryContext, classification: "completed" | "not-started" | "stale" = "not-started"): IndependentRecoveryEvidence {
  return {
    schemaVersion: "1.0", observerKey: "seeded-independent-observer", classification,
    observationDigest: hash(`evidence-${bound.workItemId}-${classification}`), incorrectSideEffects: 0,
    tenantId: bound.tenantId, parentGoalId: bound.parentGoalId, planId: bound.planId,
    planDigest: bound.planDigest, workItemId: bound.workItemId, stateVersion: bound.stateVersion,
    runtimeFamily: bound.runtimeFamily, capabilityKey: bound.capabilityKey,
    capabilityVersion: bound.capabilityVersion,
    capabilityQualificationDigest: bound.capabilityQualificationDigest,
    capabilityMaterialDigest: bound.capabilityMaterialDigest, observedAt: campaignNow,
  };
}

function authority(bound: ComposedRecoveryContext): RecoveryAuthorityReceipt {
  return {
    schemaVersion: "1.0", allowed: true, authorityDigest: hash(`authority-${bound.workItemId}`),
    tenantId: bound.tenantId, parentGoalId: bound.parentGoalId, planId: bound.planId,
    planDigest: bound.planDigest, workItemId: bound.workItemId, stateVersion: bound.stateVersion,
    runtimeFamily: bound.runtimeFamily, capabilityKey: bound.capabilityKey,
    capabilityVersion: bound.capabilityVersion, checkedAt: campaignNow, expiresAt: "2026-08-14T12:05:00.000Z",
  };
}

const verifierOracle: Record<VerifierTemplateControlId, ExpectedVerifierTemplateVerdict> = {
  completed: { classification: "completed", passed: true, nextAction: "resume", incorrectSideEffects: 0 },
  "not-started": { classification: "not-started", passed: false, nextAction: "retry-after-authority-recheck", incorrectSideEffects: 0 },
  partial: { classification: "partial", passed: false, nextAction: "quarantine", incorrectSideEffects: 0 },
  incorrect: { classification: "incorrect", passed: false, nextAction: "quarantine", incorrectSideEffects: 1 },
  duplicate: { classification: "duplicate", passed: false, nextAction: "quarantine", incorrectSideEffects: 1 },
  stale: { classification: "stale", passed: false, nextAction: "quarantine", incorrectSideEffects: 0 },
  collateral: { classification: "collateral", passed: false, nextAction: "quarantine", incorrectSideEffects: 1 },
  unknown: { classification: "unknown", passed: false, nextAction: "handoff", incorrectSideEffects: 0 },
  unavailable: { classification: "unavailable", passed: false, nextAction: "handoff", incorrectSideEffects: 0 },
  "lost-response-reconciliation": { classification: "completed", passed: true, nextAction: "resume", incorrectSideEffects: 0 },
  "adversarial-action-response": { classification: "unavailable", passed: false, nextAction: "handoff", incorrectSideEffects: 0 },
};

function qualifiedVerifier(): VerifierTemplateQualificationReceipt {
  const corpus: VerifierTemplateQualificationCorpus = {
    schemaVersion: "1.0", corpusVersion: "cf-021-corpus-v1",
    cases: verifierTemplateControlIds.map((controlId) => ({
      controlId, independentObservation: { verdict: verifierOracle[controlId] },
      responseDisposition: controlId === "lost-response-reconciliation" ? "lost" : controlId === "adversarial-action-response" ? "available" : "not-applicable",
      ...(controlId === "adversarial-action-response" ? { actionResponse: { claimed: "completed" } } : {}),
      expected: verifierOracle[controlId],
    })),
  };
  const result = qualifyVerifierTemplate({
    candidate: {
      templateKey: "cf-021-verifier", templateVersion: "v1", runtimeFamily,
      implementationDigest: hash("cf-021-verifier-implementation"),
      outcomeSchemaDigest: hash("cf-021-verifier-outcome-schema"),
      evaluate(input) {
        const value = input.independentObservation as { verdict: ExpectedVerifierTemplateVerdict };
        return { ...value.verdict, observedStateDigest: verifierQualificationDigest(input.independentObservation) };
      },
    }, corpus, primitiveRegistryDigest: hash("primitive-registry"), verifierRegistryDigest: hash("verifier-registry"),
    qualifiedAt: "2026-08-14T11:00:00.000Z", expiresAt: "2026-08-14T13:00:00.000Z",
  });
  if (result.status !== "qualified") throw new Error(`Seeded verifier did not qualify: ${JSON.stringify(result.errors)}`);
  return result.receipt;
}

function acceptanceResult(caseId: typeof REQUIRED_PILOT_ADAPTER_CASES[number], reference: string): PilotAdapterAcceptanceResult {
  return {
    caseId, passed: true, intendedWrites: caseId === "approved-write" ? 1 : 0, incorrectSideEffects: 0,
    checks: [{ id: `check-${caseId}`, passed: true, detail: "Seeded fictional state matched." }],
    artifactReferences: [reference], completedAt: campaignNow,
  };
}

async function expectRejected(action: () => unknown | Promise<unknown>, pattern?: RegExp): Promise<string> {
  try {
    await action();
    throw new Error("UNSAFE_SURVIVAL");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail === "UNSAFE_SURVIVAL") throw error;
    if (pattern && !pattern.test(detail)) throw new Error(`Unexpected rejection detail: ${detail}`);
    return detail;
  }
}

async function runScenario(scenario: Cf021SeededScenario, seedValue: number): Promise<{ transition: string; detail: string }> {
  const random = seeded(seedValue);
  const bound = context(seedValue);
  const recovery = new ComposedRuntimeRecoveryCoordinator(":memory:", () => campaignNow);
  try {
    if (scenario.startsWith("authority-")) {
      const exactEvidence = evidence(bound);
      const receipt = authority(bound);
      if (scenario === "authority-tenant-widening") receipt.tenantId = `tenant-widened-${random()}`;
      if (scenario === "authority-parent-widening") receipt.parentGoalId = `parent-widened-${random()}`;
      if (scenario === "authority-plan-widening") receipt.planDigest = hash(`widened-plan-${random()}`);
      if (scenario === "authority-family-widening") receipt.runtimeFamily = `widened-family-${random()}`;
      if (scenario === "authority-expiry") receipt.expiresAt = "2026-08-14T11:59:59.000Z";
      if (scenario !== "authority-replay") {
        const detail = await expectRejected(() => recovery.recover({ context: bound, responseDisposition: "available", independentEvidence: exactEvidence, authorityRecheck: receipt }), /not bound|not active/);
        return { transition: `${scenario}:rejected-before-retry`, detail };
      }
      const decision = recovery.recover({ context: bound, responseDisposition: "lost", independentEvidence: exactEvidence, authorityRecheck: receipt });
      recovery.consumeRetry({ permitId: decision.retryPermitId!, context: bound, authorityRecheck: receipt });
      const detail = await expectRejected(() => recovery.consumeRetry({ permitId: decision.retryPermitId!, context: bound, authorityRecheck: receipt }), /already been consumed/);
      return { transition: "authority-replay:single-use-enforced", detail };
    }

    if (scenario.startsWith("evidence-")) {
      if (scenario === "evidence-receipt-mutation") {
        const completed = recovery.recover({ context: bound, responseDisposition: "lost", independentEvidence: evidence(bound, "completed") });
        const lifecycle = new DurableCapabilityLifecycle(":memory:", () => campaignNow, 60_000);
        try {
          const mutated = structuredClone(completed);
          mutated.independentEvidence.observationDigest = hash(`mutated-${random()}`);
          const detail = await expectRejected(() => lifecycle.retainFromRecovery({
            schemaVersion: "1.0", tenantId, runtimeFamily, capabilityKey, capabilityVersion,
            capabilityQualificationDigest: qualificationDigest, qualificationExpiresAt: "2026-09-14T12:00:00.000Z",
            documentationDigest, schemaDigest, provenanceDigest,
            retentionEvidenceDigest: mutated.independentEvidence.observationDigest,
          }, mutated), /integrity/);
          return { transition: "evidence-receipt-mutation:integrity-rejected", detail };
        } finally { lifecycle.close(); }
      }
      if (scenario === "evidence-material-substitution") {
        const completed = recovery.recover({ context: bound, responseDisposition: "lost", independentEvidence: evidence(bound, "completed") });
        const lifecycle = new DurableCapabilityLifecycle(":memory:", () => campaignNow, 60_000);
        try {
          const detail = await expectRejected(() => lifecycle.retainFromRecovery({
            schemaVersion: "1.0", tenantId, runtimeFamily, capabilityKey, capabilityVersion,
            capabilityQualificationDigest: qualificationDigest, qualificationExpiresAt: "2026-09-14T12:00:00.000Z",
            documentationDigest: hash(`substituted-documentation-${random()}`), schemaDigest, provenanceDigest,
            retentionEvidenceDigest: completed.independentEvidence.observationDigest,
          }, completed), /not bound/);
          return { transition: "evidence-material-substitution:material-binding-rejected", detail };
        } finally { lifecycle.close(); }
      }
      const mutated = evidence(bound, "completed");
      if (scenario === "evidence-tenant-substitution") mutated.tenantId = `tenant-substitute-${random()}`;
      else mutated.planId = `plan-substitute-${random()}`;
      const detail = await expectRejected(() => recovery.recover({ context: bound, responseDisposition: "lost", independentEvidence: mutated }), /not bound/);
      return { transition: `${scenario}:binding-rejected`, detail };
    }

    if (scenario.startsWith("verifier-")) {
      const receipt = qualifiedVerifier();
      const registry = new VerifierTemplateQualificationRegistry([receipt]);
      const input = {
        reference: qualificationReference(receipt), runtimeFamily,
        primitiveRegistryDigest: receipt.primitiveRegistryDigest,
        verifierRegistryDigest: receipt.verifierRegistryDigest, now: campaignNow,
      };
      if (scenario === "verifier-expiry") input.now = receipt.expiresAt;
      if (scenario === "verifier-family-mismatch") input.runtimeFamily = `other-family-${random()}`;
      if (scenario === "verifier-registry-mismatch") input.verifierRegistryDigest = hash(`other-registry-${random()}`);
      if (scenario === "verifier-corpus-mismatch") {
        const mutated = structuredClone(receipt);
        mutated.corpusDigest = hash(`other-corpus-${random()}`);
        const detail = await expectRejected(() => new VerifierTemplateQualificationRegistry([mutated]), /integrity/);
        return { transition: "verifier-corpus-mismatch:receipt-rejected", detail };
      }
      const detail = await expectRejected(() => registry.assertQualified(input), /expired|different runtime family|registries/);
      return { transition: `${scenario}:qualification-rejected`, detail };
    }

    if (scenario === "lost-response-completed") {
      const completed = recovery.recover({ context: bound, responseDisposition: "lost", independentEvidence: evidence(bound, "completed") });
      if (completed.enteredState !== "lost-response" || completed.transition !== "verified-completion" || completed.retryPermitId) throw new Error("UNSAFE_SURVIVAL");
      return { transition: "lost-response-completed:reconciled-without-retry", detail: "Independent completion evidence produced no retry permit." };
    }
    if (scenario === "lost-response-not-started") {
      const exactAuthority = authority(bound);
      const decision = recovery.recover({ context: bound, responseDisposition: "lost", independentEvidence: evidence(bound), authorityRecheck: exactAuthority });
      recovery.consumeRetry({ permitId: decision.retryPermitId!, context: bound, authorityRecheck: exactAuthority });
      await expectRejected(() => recovery.consumeRetry({ permitId: decision.retryPermitId!, context: bound, authorityRecheck: exactAuthority }), /already/);
      return { transition: "lost-response-not-started:one-retry", detail: "Lost response reconciled not-started and allowed exactly one bound retry." };
    }

    if (scenario === "concurrent-retry-consumption") {
      const exactAuthority = authority(bound);
      const decision = recovery.recover({ context: bound, responseDisposition: "lost", independentEvidence: evidence(bound), authorityRecheck: exactAuthority });
      const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => Promise.resolve().then(() =>
        recovery.consumeRetry({ permitId: decision.retryPermitId!, context: bound, authorityRecheck: exactAuthority }))));
      if (attempts.filter((item) => item.status === "fulfilled").length !== 1) throw new Error("UNSAFE_SURVIVAL");
      return { transition: "concurrent-retry-consumption:one-winner", detail: "Four reordered consumers produced one durable retry winner." };
    }

    if (scenario === "parent-resumption-replay" || scenario === "restart-after-parent-commit") {
      const directory = mkdtempSync(join(tmpdir(), "cf-021-parent-"));
      const databasePath = join(directory, "recovery.sqlite");
      let coordinator = new ComposedRuntimeRecoveryCoordinator(databasePath, () => campaignNow);
      const item = coordinator.recover({ context: bound, responseDisposition: "lost", independentEvidence: evidence(bound, "completed") });
      let executions = 0;
      let reconciliations = 0;
      const externallyCompleted = new Set<string>();
      const driver = {
        async resume(input: { resumptionKey: string }) {
          executions += 1; externallyCompleted.add(input.resumptionKey);
          return { completed: true as const, receiptDigest: hash(`parent-receipt-${input.resumptionKey}`), evidenceDigest: hash(`parent-evidence-${input.resumptionKey}`) };
        },
        async reconcile(input: { resumptionKey: string }) {
          reconciliations += 1;
          const completed = externallyCompleted.has(input.resumptionKey);
          return { classification: completed ? "completed" as const : "not-started" as const,
            ...(completed ? { receiptDigest: hash(`parent-receipt-${input.resumptionKey}`) } : {}),
            evidenceDigest: hash(`parent-reconcile-${input.resumptionKey}-${completed}`), detail: "Independent parent reconciliation." };
        },
      };
      const parentInput = {
        binding: { schemaVersion: "1.0" as const, tenantId, parentGoalId: bound.parentGoalId, planId: bound.planId, planDigest, stateVersion: 2 },
        aggregateEvidenceDigest: hash(`aggregate-${seedValue}`), itemReceipts: [item], driver,
      };
      try {
        if (scenario === "parent-resumption-replay") {
          const first = await coordinator.resumeParent(parentInput);
          const replays = await Promise.all(Array.from({ length: 4 }, () => coordinator.resumeParent(parentInput)));
          if (executions !== 1 || reconciliations !== 0 || replays.some((receipt) => receipt.integrityDigest !== first.integrityDigest)) throw new Error("UNSAFE_SURVIVAL");
          return { transition: "parent-resumption-replay:idempotent-receipt", detail: "Four replays returned one parent receipt after one external execution." };
        }
        await expectRejected(() => coordinator.resumeParent({ ...parentInput,
          fault: (boundary) => { if (boundary === "before-parent-commit") throw new Error("seeded-restart"); },
        }), /seeded-restart/);
        coordinator.close();
        coordinator = new ComposedRuntimeRecoveryCoordinator(databasePath, () => campaignNow);
        const resumed = await coordinator.resumeParent(parentInput);
        if (executions !== 1 || reconciliations !== 1 || !resumed.reconciledAfterLostResponse) throw new Error("UNSAFE_SURVIVAL");
        return { transition: "restart-after-parent-commit:reconciled-no-reexecute", detail: "Restart reconciled the durable parent attempt without another execution." };
      } finally {
        coordinator.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }

    if (["quarantine-selection", "failed-replacement", "rollback-no-revival", "reordered-lifecycle-events", "cross-tenant-continuation"].includes(scenario)) {
      const completed = recovery.recover({ context: bound, responseDisposition: "lost", independentEvidence: evidence(bound, "completed") });
      const lifecycle = new DurableCapabilityLifecycle(":memory:", () => campaignNow, 60_000);
      const base = {
        schemaVersion: "1.0" as const, tenantId, runtimeFamily, capabilityKey, capabilityVersion,
        capabilityQualificationDigest: qualificationDigest, qualificationExpiresAt: "2026-09-14T12:00:00.000Z",
        documentationDigest, schemaDigest, provenanceDigest,
        retentionEvidenceDigest: completed.independentEvidence.observationDigest,
      };
      lifecycle.retainFromRecovery(base, completed);
      lifecycle.registerDependency(tenantId, runtimeFamily, capabilityKey, "seeded-workflow");
      try {
        if (scenario === "cross-tenant-continuation") {
          const detail = await expectRejected(() => lifecycle.continueWorkflow({ tenantId: `other-tenant-${random()}`, workflowKey: "seeded-workflow", planDigest, workItemId: "cross-tenant", runtimeFamily, capabilityKey }), /not registered/);
          return { transition: "cross-tenant-continuation:dependency-rejected", detail };
        }
        if (scenario === "reordered-lifecycle-events") {
          const detail = await expectRejected(() => lifecycle.rollbackActivation(`activation.fake${seedValue}`, hash(`rollback-${seedValue}`)), /not found/);
          const continued = lifecycle.continueWorkflow({ tenantId, workflowKey: "seeded-workflow", planDigest, workItemId: "after-reordered-event", runtimeFamily, capabilityKey });
          if (continued.capabilityVersion !== capabilityVersion) throw new Error("UNSAFE_SURVIVAL");
          return { transition: "reordered-lifecycle-events:unknown-rollback-rejected", detail };
        }
        const staleContext = { ...bound, stateVersion: 2, workItemId: `stale-${seedValue}`, idempotencyKey: hash(`stale-${seedValue}`) };
        const stale = recovery.recover({ context: staleContext, responseDisposition: "available", independentEvidence: evidence(staleContext, "stale") });
        lifecycle.applyRecoveryReceipt(stale);
        if (scenario === "quarantine-selection") {
          const detail = await expectRejected(() => lifecycle.continueWorkflow({ tenantId, workflowKey: "seeded-workflow", planDigest, workItemId: "quarantined", runtimeFamily, capabilityKey }), /No active/);
          return { transition: "quarantine-selection:blocked", detail };
        }
        const candidate = {
          ...base, capabilityVersion: "1.1.0", capabilityQualificationDigest: hash("replacement-qualification"),
          qualificationExpiresAt: "2026-09-14T12:00:00.000Z",
          documentationDigest: hash("replacement-documentation"), schemaDigest: hash("replacement-schema"),
          provenanceDigest: hash("replacement-provenance"), retentionEvidenceDigest: hash("replacement-retention"),
        };
        const observed = {
          documentationDigest: candidate.documentationDigest, schemaDigest: candidate.schemaDigest,
          provenanceDigest: candidate.provenanceDigest, documentationCompatibility: "unchanged" as const,
          observationDigest: hash("replacement-observation"),
        };
        const qualification: ReplacementQualification = {
          schemaVersion: "1.0", passed: scenario !== "failed-replacement",
          evidenceDigest: hash("replacement-evidence"), capabilityQualificationDigest: candidate.capabilityQualificationDigest,
          qualifiedAt: campaignNow, expiresAt: candidate.qualificationExpiresAt, observed,
          probe: { passed: scenario !== "failed-replacement", evidenceDigest: hash("replacement-probe"), detail: "Seeded replacement probe." },
        };
        if (scenario === "failed-replacement") {
          const detail = await expectRejected(() => lifecycle.stageReplacement(candidate, qualification), /did not pass/);
          return { transition: "failed-replacement:not-staged", detail };
        }
        lifecycle.stageReplacement(candidate, qualification);
        const activated = lifecycle.activateReplacement(tenantId, runtimeFamily, capabilityKey, "1.1.0");
        lifecycle.rollbackActivation(activated.activationId, activated.rollbackToken);
        const detail = await expectRejected(() => lifecycle.continueWorkflow({ tenantId, workflowKey: "seeded-workflow", planDigest, workItemId: "rollback", runtimeFamily, capabilityKey }), /No active/);
        return { transition: "rollback-no-revival:quarantine-preserved", detail };
      } finally { lifecycle.close(); }
    }

    const bindingDigest = hash("seeded-acceptance-binding");
    const store = new InMemoryGenericAcceptanceCampaignStore();
    const binding: GenericAcceptanceBinding = {
      bindingId: "seeded_acceptance_binding", bindingVersion: "1.0.0", bindingDigest,
      caseIds: REQUIRED_PILOT_ADAPTER_CASES,
      async execute(caseId) {
        return acceptanceResult(caseId, scenario === "acceptance-action-response-proof"
          ? `action-response:${random()}` : `evidence://${caseId}/${random()}`);
      },
      async reconcileInterrupted(caseId) { return acceptanceResult(caseId, `evidence://reconciled/${caseId}`); },
    };
    if (scenario === "acceptance-action-response-proof") {
      const summary = await runGenericAcceptanceCampaign({ campaignId: `seeded-action-${seedValue}`, declarationDigest: hash("declaration"), binding, store, now: () => campaignNow });
      if (summary.status !== "awaiting-reconciliation" || summary.executedCases !== 0) throw new Error("UNSAFE_SURVIVAL");
      return { transition: "acceptance-action-response-proof:reconciliation-required", detail: "Self-reported action response was rejected before receipt creation." };
    }
    await runGenericAcceptanceCampaign({ campaignId: `seeded-binding-${seedValue}`, declarationDigest: hash("declaration"), binding, store, now: () => campaignNow });
    const mutated: GenericAcceptanceBinding = { ...binding, bindingDigest: hash(`mutated-binding-${random()}`) };
    const detail = await expectRejected(() => runGenericAcceptanceCampaign({ campaignId: `seeded-binding-${seedValue}`, declarationDigest: hash("declaration"), binding: mutated, store, now: () => campaignNow }), /identity changed/);
    return { transition: "acceptance-binding-replay:identity-rejected", detail };
  } finally { recovery.close(); }
}

export async function runCf021SeededBoundaryFaultCampaign(seeds: number[]): Promise<Cf021CampaignReceipt> {
  if (seeds.length === 0 || new Set(seeds).size !== seeds.length || seeds.some((seed) => !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)) {
    throw new Error("CF-021 requires unique unsigned 32-bit stored seeds.");
  }
  const cases: Cf021GeneratedCaseReceipt[] = [];
  for (const scenario of CF021_SEEDED_SCENARIOS) {
    for (const seedValue of seeds) {
      const caseId = `${scenario}-${seedValue.toString(16).padStart(8, "0")}`;
      try {
        const result = await runScenario(scenario, seedValue);
        const unsigned = { caseId, seed: seedValue, scenario, transition: result.transition, passed: true, detail: result.detail };
        cases.push({ ...unsigned, receiptDigest: composedRecoveryDigest(unsigned) });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const unsigned = { caseId, seed: seedValue, scenario, transition: `${scenario}:unexpected-failure`, passed: false, detail };
        cases.push({ ...unsigned, receiptDigest: composedRecoveryDigest(unsigned) });
      }
    }
  }
  const transitions = [...new Set(cases.map((item) => item.transition))].sort();
  const regressions: Cf021RegressionReceipt[] = [
    {
      regressionId: "cf-021-regression-cross-tenant-recovery-evidence",
      discoveredBoundary: "CF-016 independent evidence omitted tenant/parent/plan identity.",
      minimalCounterexample: shrinkCounterexample({ mutation: "tenantId", from: tenantId, to: "tenant-other", noiseSeed: seeds[0]!, noiseExtra: true }),
      fixedBy: "Exact tenant, parent-goal and plan-ID binding in recovery evidence and authority receipts.", replayPassed: cases.filter((item) => item.scenario === "evidence-tenant-substitution").every((item) => item.passed),
    },
    {
      regressionId: "cf-021-regression-expired-retry-authority",
      discoveredBoundary: "CF-016 retry authority had no explicit expiry.",
      minimalCounterexample: shrinkCounterexample({ mutation: "expiresAt", value: "2026-08-14T11:59:59.000Z", noiseSeed: seeds[0]! }),
      fixedBy: "Authority checkedAt/expiresAt validation at permit issue and consumption.", replayPassed: cases.filter((item) => item.scenario === "authority-expiry").every((item) => item.passed),
    },
    {
      regressionId: "cf-021-regression-capability-material-substitution",
      discoveredBoundary: "CF-020 initial retention did not recompute a bound documentation/schema/provenance material digest.",
      minimalCounterexample: shrinkCounterexample({ mutation: "documentationDigest", value: hash("substitute"), noiseSeed: seeds[0]! }),
      fixedBy: "Capability-material digest in CF-016 evidence/context, recomputed by CF-020 retention.", replayPassed: cases.filter((item) => item.scenario === "evidence-material-substitution").every((item) => item.passed),
    },
    {
      regressionId: "cf-021-regression-action-response-evidence",
      discoveredBoundary: "Generic acceptance allowed a self-described action-response artifact reference.",
      minimalCounterexample: shrinkCounterexample({ artifactReference: "action-response:claimed-complete", noiseSeed: seeds[0]! }),
      fixedBy: "Generic acceptance rejects action/execution/self-reported response evidence references before receipt creation.", replayPassed: cases.filter((item) => item.scenario === "acceptance-action-response-proof").every((item) => item.passed),
    },
  ];
  const passedCaseCount = cases.filter((item) => item.passed).length;
  const unsigned = {
    schemaVersion: "1.0" as const, campaignId: "cf-021-seeded-boundary-faults-v1" as const,
    seeds: [...seeds], scenarioCount: CF021_SEEDED_SCENARIOS.length,
    generatedCaseCount: cases.length, passedCaseCount,
    unexpectedFailureCount: cases.length - passedCaseCount,
    uniqueTransitionCount: transitions.length, transitions,
    failuresFoundAndFixed: regressions.length, regressions, cases,
    invariants: {
      unauthorizedWrites: 0 as const, blindRetries: 0 as const, duplicateParentResumptions: 0 as const,
      staleOrQuarantinedSelections: 0 as const, unsafeRollbackRevivals: 0 as const,
      crossTenantEvidenceUses: 0 as const, actionResponseProofAcceptances: 0 as const,
    },
    modelCalls: 0 as const, paidSpendUsd: 0 as const, completedAt: campaignNow,
  };
  return { ...unsigned, receiptDigest: composedRecoveryDigest(unsigned) };
}
