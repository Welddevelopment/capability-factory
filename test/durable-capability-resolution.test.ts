import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  compileCapabilityResolutionGraph,
  type CapabilityResolutionCompilerContext,
  type CompiledCapabilityResolutionPlan,
} from "../src/product/capability-resolution-compiler.js";
import {
  DurableCapabilityResolutionExecutor,
  DurableCapabilityResolutionStore,
  type CapabilityResolutionRuntimeBinding,
  type DurableCapabilityResolutionRuntime,
} from "../src/product/durable-capability-resolution.js";
import { VerifiedArtifactStore } from "../src/product/verified-artifact-flow.js";
import {
  VerifierTemplateQualificationRegistry,
  qualificationReference,
  qualifyVerifierTemplate,
  verifierQualificationDigest,
  type ExpectedVerifierTemplateVerdict,
  type VerifierTemplateControlId,
  type VerifierTemplateQualificationCase,
  type VerifierTemplateQualificationCorpus,
} from "../src/product/verifier-template-qualification.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const now = () => "2026-08-14T10:00:00.000Z";

function compilerContext(): CapabilityResolutionCompilerContext {
  return {
    identity: {
      tenantId: "tenant-one",
      requestId: "request-one",
      parentGoalId: "goal-one",
      ordinaryGoalDigest: hash("restock every short item"),
    },
    primitives: [
      {
        key: "inventory.read-shortage-v1",
        version: "v1",
        effect: "Read the shortage from inventory.",
        targetAlias: "inventory-system",
        actionKey: "read-shortage",
        maximumRisk: "read-only",
        requiredApprovalKeys: [],
        inputs: [{ key: "sku", schemaKey: "sku-v1", allowedSources: ["trusted-config"], maximumClassification: "internal" }],
        outputs: [{ key: "shortage", schemaKey: "quantity-v1", classification: "internal" }],
        routeBuilderKeys: ["inventory-read-route"],
        requiredObservationKeys: ["inventory-read-observer"],
        verifierTemplateKey: "read-observation-verifier",
        idempotency: "not-applicable",
        provenanceDigest: hash("inventory primitive"),
        enabled: true,
      },
      {
        key: "supplier.create-draft-v1",
        version: "v1",
        effect: "Create one duplicate-safe supplier draft.",
        targetAlias: "supplier-system",
        actionKey: "create-draft",
        maximumRisk: "reversible-write",
        requiredApprovalKeys: ["approve-draft"],
        inputs: [
          { key: "sku", schemaKey: "sku-v1", allowedSources: ["trusted-config"], maximumClassification: "internal" },
          { key: "quantity", schemaKey: "quantity-v1", allowedSources: ["verified-artifact"], maximumClassification: "internal" },
        ],
        outputs: [{ key: "draft-reference", schemaKey: "draft-reference-v1", classification: "internal" }],
        routeBuilderKeys: ["supplier-http-route"],
        requiredObservationKeys: ["supplier-draft-observer"],
        verifierTemplateKey: "draft-outcome-verifier",
        idempotency: "required",
        provenanceDigest: hash("supplier primitive"),
        enabled: true,
      },
    ],
    evidence: [{
      evidenceId: "restock-policy",
      digest: hash("restock evidence"),
      summary: "Approved inventory to supplier draft workflow.",
      permittedPrimitiveKeys: ["inventory.read-shortage-v1", "supplier.create-draft-v1"],
    }],
    trustedConfigValues: [{ key: "sku-widget", schemaKey: "sku-v1", classification: "internal", digest: hash("widget") }],
    trustedLiteralValues: [],
    evidenceValues: [],
    enabledRouteBuilderKeys: ["inventory-read-route", "supplier-http-route"],
    enabledObservationKeys: ["inventory-read-observer", "supplier-draft-observer"],
    enabledVerifierTemplateKeys: ["read-observation-verifier", "draft-outcome-verifier"],
    authority: {
      targetAliases: ["inventory-system", "supplier-system"],
      actionKeys: ["read-shortage", "create-draft"],
      approvalKeys: ["approve-draft"],
      maximumRisk: "reversible-write",
    },
    aggregateVerifier: {
      key: "restock-aggregate-v1",
      requiredTerminalOutputs: [{ workItemId: "create-draft", outputKey: "draft-reference" }],
    },
  };
}

function compiledPlan(): CompiledCapabilityResolutionPlan {
  const context = compilerContext();
  const result = compileCapabilityResolutionGraph({
    schemaVersion: "1.0",
    decision: "compile",
    tenantId: context.identity.tenantId,
    requestId: context.identity.requestId,
    parentGoalId: context.identity.parentGoalId,
    ordinaryGoalDigest: context.identity.ordinaryGoalDigest,
    summary: "Read the shortage and create one approved draft.",
    workItems: [
      {
        workItemId: "read-shortage",
        primitiveKey: "inventory.read-shortage-v1",
        primitiveVersion: "v1",
        citedEvidenceIds: ["restock-policy"],
        dependsOn: [],
        bindings: [{ inputKey: "sku", kind: "trusted-config", valueKey: "sku-widget" }],
      },
      {
        workItemId: "create-draft",
        primitiveKey: "supplier.create-draft-v1",
        primitiveVersion: "v1",
        citedEvidenceIds: ["restock-policy"],
        dependsOn: ["read-shortage"],
        bindings: [
          { inputKey: "sku", kind: "trusted-config", valueKey: "sku-widget" },
          { inputKey: "quantity", kind: "verified-artifact", producerWorkItemId: "read-shortage", outputKey: "shortage" },
        ],
      },
    ],
    terminalOutputs: [{ workItemId: "create-draft", outputKey: "draft-reference" }],
  }, context);
  if (!result.plan) throw new Error(JSON.stringify(result.errors));
  return result.plan;
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

function verifierCase(controlId: VerifierTemplateControlId): VerifierTemplateQualificationCase {
  return {
    controlId,
    independentObservation: { verdict: verifierOracle[controlId] },
    responseDisposition: controlId === "lost-response-reconciliation"
      ? "lost"
      : controlId === "adversarial-action-response" ? "available" : "not-applicable",
    ...(controlId === "adversarial-action-response" ? { actionResponse: { status: 200, body: { completed: true } } } : {}),
    expected: verifierOracle[controlId],
  };
}

function verifierCorpus(): VerifierTemplateQualificationCorpus {
  return {
    schemaVersion: "1.0",
    corpusVersion: "durable-resolution-v1",
    cases: (Object.keys(verifierOracle) as VerifierTemplateControlId[]).map(verifierCase),
  };
}

function qualifiedTemplate(plan: CompiledCapabilityResolutionPlan, templateKey: string) {
  const result = qualifyVerifierTemplate({
    candidate: {
      templateKey,
      templateVersion: "v1",
      runtimeFamily: "constrained-http-api",
      implementationDigest: hash(`${templateKey} implementation v1`),
      outcomeSchemaDigest: hash(`${templateKey} outcome schema v1`),
      evaluate(input) {
        const observation = z.object({ verdict: z.object({
          classification: z.enum(["completed", "not-started", "partial", "incorrect", "duplicate", "stale", "collateral", "unknown", "unavailable"]),
          passed: z.boolean(),
          nextAction: z.enum(["resume", "retry-after-authority-recheck", "quarantine", "handoff"]),
          incorrectSideEffects: z.number().int().nonnegative(),
        }).strict() }).strict().parse(input.independentObservation);
        return {
          ...observation.verdict,
          observedStateDigest: verifierQualificationDigest(input.independentObservation),
        };
      },
    },
    corpus: verifierCorpus(),
    primitiveRegistryDigest: plan.primitiveRegistryDigest,
    verifierRegistryDigest: plan.verifierRegistryDigest,
    qualifiedAt: "2026-08-14T09:00:00.000Z",
    expiresAt: "2026-09-13T09:00:00.000Z",
  });
  if (result.status !== "qualified") throw new Error(JSON.stringify(result));
  return result.receipt;
}

interface World {
  shortage: number;
  shortageRead: boolean;
  draftReference?: string;
  readExecutions: number;
  writeExecutions: number;
  retained: string[];
  quarantined: string[];
  parentResumptions: number;
}

function runtime(plan: CompiledCapabilityResolutionPlan, world: World, authorityAllowed = true): DurableCapabilityResolutionRuntime {
  const qualification = {
    schemaVersion: "1.0" as const,
    status: "qualified" as const,
    qualificationDigest: hash("qualified runtime bindings"),
    primitiveRegistryDigest: plan.primitiveRegistryDigest,
    verifierRegistryDigest: plan.verifierRegistryDigest,
    qualifiedAt: now(),
  };
  const readVerifier = qualifiedTemplate(plan, "read-observation-verifier");
  const writeVerifier = qualifiedTemplate(plan, "draft-outcome-verifier");
  const verifierTemplateQualifications = new VerifierTemplateQualificationRegistry([readVerifier, writeVerifier]);
  const read: CapabilityResolutionRuntimeBinding = {
    primitiveKey: "inventory.read-shortage-v1",
    primitiveVersion: "v1",
    runtimeFamily: "constrained-http-api",
    targetAlias: "inventory-system",
    actionKey: "read-shortage",
    routeBuilderKey: "inventory-read-route",
    observationKeys: ["inventory-read-observer"],
    verifierTemplateKey: "read-observation-verifier",
    verifierTemplateQualification: qualificationReference(readVerifier),
    inputContracts: [{
      inputKey: "sku",
      schemaKey: "sku-v1",
      maximumClassification: "internal",
      allowedSources: ["trusted-config"],
      parse: (value) => z.string().min(1).parse(value),
    }],
    qualification,
    async execute() { world.readExecutions += 1; world.shortageRead = true; },
    async reconcile() {
      return {
        classification: world.shortageRead ? "completed" : "not-started",
        evidenceDigest: hash(`read-reconcile-${world.shortageRead}`),
        detail: world.shortageRead ? "Inventory read already completed." : "Inventory read did not start.",
      };
    },
    async verify() {
      return {
        passed: world.shortageRead,
        incorrectSideEffects: 0,
        evidenceReceiptDigest: hash("read external evidence"),
        outputs: { shortage: world.shortage },
        detail: "Shortage observed independently from inventory state.",
      };
    },
    async retain({ context }) {
      if (!world.retained.includes(context.workItemId)) world.retained.push(context.workItemId);
      return { retained: true, receiptDigest: hash(`retained-${context.workItemId}`) };
    },
    async quarantine({ context }) { world.quarantined.push(context.workItemId); },
  };
  const write: CapabilityResolutionRuntimeBinding = {
    primitiveKey: "supplier.create-draft-v1",
    primitiveVersion: "v1",
    runtimeFamily: "constrained-http-api",
    targetAlias: "supplier-system",
    actionKey: "create-draft",
    routeBuilderKey: "supplier-http-route",
    observationKeys: ["supplier-draft-observer"],
    verifierTemplateKey: "draft-outcome-verifier",
    verifierTemplateQualification: qualificationReference(writeVerifier),
    inputContracts: [
      {
        inputKey: "sku", schemaKey: "sku-v1", maximumClassification: "internal", allowedSources: ["trusted-config"],
        parse: (value) => z.string().min(1).parse(value),
      },
      {
        inputKey: "quantity", schemaKey: "quantity-v1", maximumClassification: "internal", allowedSources: ["verified-artifact"],
        parse: (value) => z.number().int().positive().parse(value),
      },
    ],
    qualification,
    async execute({ values }) {
      world.writeExecutions += 1;
      if (!world.draftReference) world.draftReference = `PO-${String(values.quantity)}`;
    },
    async reconcile() {
      return {
        classification: world.draftReference ? "completed" : "not-started",
        evidenceDigest: hash(`write-reconcile-${world.draftReference ?? "none"}`),
        detail: world.draftReference ? "Exactly one draft exists." : "No draft exists.",
      };
    },
    async verify({ values }) {
      const expected = `PO-${String(values.quantity)}`;
      return {
        passed: world.draftReference === expected,
        incorrectSideEffects: 0,
        evidenceReceiptDigest: hash("write external evidence"),
        outputs: { "draft-reference": world.draftReference },
        detail: "Supplier state contains exactly one expected draft.",
      };
    },
    async retain({ context }) {
      if (!world.retained.includes(context.workItemId)) world.retained.push(context.workItemId);
      return { retained: true, receiptDigest: hash(`retained-${context.workItemId}`) };
    },
    async quarantine({ context }) { world.quarantined.push(context.workItemId); },
  };
  return {
    primitiveRegistryDigest: plan.primitiveRegistryDigest,
    verifierRegistryDigest: plan.verifierRegistryDigest,
    supportedRuntimeFamilies: ["constrained-http-api"],
    verifierTemplateQualifications,
    bindings: [read, write],
    authority: {
      async check({ context }) {
        return {
          allowed: authorityAllowed,
          authorityDigest: hash(`authority-${context.workItemId}`),
          planDigest: plan.planDigest,
          detail: authorityAllowed ? "Exact current authority is present." : "Draft approval is missing.",
          ...(!authorityAllowed ? { handoffReceiptDigest: hash("authority handoff") } : {}),
        };
      },
    },
    values: {
      async resolve({ binding }) {
        if (binding.kind !== "trusted-config" || binding.valueKey !== "sku-widget") throw new Error("Unexpected trusted value request.");
        return { value: "WIDGET-1", provenanceDigest: hash("trusted config widget") };
      },
    },
    aggregateVerifier: {
      key: "restock-aggregate-v1",
      kind: "independent-external-state",
      qualification,
      async verify({ terminalArtifacts }) {
        return {
          passed: terminalArtifacts.length === 1 && terminalArtifacts[0]?.value === world.draftReference,
          incorrectSideEffects: 0,
          evidenceDigest: hash("aggregate external evidence"),
          detail: "The independent aggregate state contains the exact expected draft.",
        };
      },
    },
    parentResumer: {
      async resume() {
        world.parentResumptions += 1;
        return { resumed: true, completed: true, receiptDigest: hash("parent resumed") };
      },
      async reconcile() {
        return {
          classification: world.parentResumptions > 0 ? "completed" : "not-started",
          ...(world.parentResumptions > 0 ? { receiptDigest: hash("parent resumed") } : {}),
          evidenceDigest: hash("parent resumption reconciliation"),
          detail: world.parentResumptions > 0 ? "Parent completion is externally visible." : "Parent did not resume.",
        };
      },
    },
  };
}

function artifactStore(path = ":memory:"): VerifiedArtifactStore {
  return new VerifiedArtifactStore(path, [
    { schemaKey: "quantity-v1", maximumBytes: 64, parse: (value) => z.number().int().positive().parse(value) },
    { schemaKey: "draft-reference-v1", maximumBytes: 256, parse: (value) => z.string().regex(/^PO-[0-9]+$/).parse(value) },
  ]);
}

function emptyWorld(): World {
  return {
    shortage: 18,
    shortageRead: false,
    readExecutions: 0,
    writeExecutions: 0,
    retained: [],
    quarantined: [],
    parentResumptions: 0,
  };
}

describe("durable capability-resolution execution", () => {
  it("joins a compiler plan, typed verified artifacts, authority, retention and parent resumption", async () => {
    const plan = compiledPlan();
    const world = emptyWorld();
    const store = new DurableCapabilityResolutionStore(":memory:", now);
    const artifacts = artifactStore();
    try {
      const executor = new DurableCapabilityResolutionExecutor(store, artifacts, runtime(plan, world), now);
      const submitted = executor.submit(plan);
      const result = await executor.run(plan.tenantId, submitted.job.jobId);
      expect(result).toMatchObject({ status: "autonomous-completion", parentResumed: true, attempts: 1 });
      expect(store.items(result.jobId).map((item) => item.status)).toEqual(["retained", "retained"]);
      expect(world).toMatchObject({ readExecutions: 1, writeExecutions: 1, draftReference: "PO-18", parentResumptions: 1 });
      expect(world.retained).toEqual(["read-shortage", "create-draft"]);
      expect(store.events(plan.tenantId, result.jobId).map((event) => event.type)).toContain("resolution-item.verified");
      expect(executor.submit(plan)).toMatchObject({ created: false, job: { status: "autonomous-completion" } });
    } finally {
      artifacts.close();
      store.close();
    }
  });

  it("fails before action for a mutated plan, unqualified binding or unsupported runtime family", () => {
    const plan = compiledPlan();
    const world = emptyWorld();
    const makeExecutor = (providedRuntime: DurableCapabilityResolutionRuntime) => {
      const store = new DurableCapabilityResolutionStore(":memory:", now);
      const artifacts = artifactStore();
      return { store, artifacts, executor: new DurableCapabilityResolutionExecutor(store, artifacts, providedRuntime, now) };
    };

    const changed = structuredClone(plan);
    changed.orderedWorkItems[0]!.targetAlias = "other-system";
    const changedResources = makeExecutor(runtime(plan, world));
    expect(() => changedResources.executor.submit(changed)).toThrow(/digest/i);
    changedResources.artifacts.close();
    changedResources.store.close();

    const unqualifiedRuntime = runtime(plan, world);
    unqualifiedRuntime.bindings[0]!.qualification.qualificationDigest = "bad";
    const unqualifiedResources = makeExecutor(unqualifiedRuntime);
    expect(() => unqualifiedResources.executor.submit(plan)).toThrow(/unqualified|not qualified/i);
    unqualifiedResources.artifacts.close();
    unqualifiedResources.store.close();

    const unsupportedRuntime = runtime(plan, world);
    unsupportedRuntime.supportedRuntimeFamilies = [];
    const unsupportedResources = makeExecutor(unsupportedRuntime);
    expect(() => unsupportedResources.executor.submit(plan)).toThrow(/not supported/i);
    unsupportedResources.artifacts.close();
    unsupportedResources.store.close();
    expect(world.readExecutions).toBe(0);
    expect(world.writeExecutions).toBe(0);
  });

  it("fails before action when a verifier template is missing, mutated, expired or qualified for another family", () => {
    const plan = compiledPlan();
    const makeExecutor = (
      preparedRuntime: DurableCapabilityResolutionRuntime,
      world: World,
      clock: () => string = now,
    ) => {
      const store = new DurableCapabilityResolutionStore(":memory:", clock);
      const artifacts = artifactStore();
      return {
        world,
        store,
        artifacts,
        executor: new DurableCapabilityResolutionExecutor(store, artifacts, preparedRuntime, clock),
      };
    };
    const expectPreActionFailure = (
      resources: ReturnType<typeof makeExecutor>,
      pattern: RegExp,
    ) => {
      expect(() => resources.executor.submit(plan)).toThrow(pattern);
      expect(resources.world.readExecutions).toBe(0);
      expect(resources.world.writeExecutions).toBe(0);
      resources.artifacts.close();
      resources.store.close();
    };

    const unqualifiedWorld = emptyWorld();
    const unqualified = runtime(plan, unqualifiedWorld);
    unqualified.verifierTemplateQualifications = new VerifierTemplateQualificationRegistry();
    expectPreActionFailure(makeExecutor(unqualified, unqualifiedWorld), /not qualified/i);

    const mutatedWorld = emptyWorld();
    const mutated = runtime(plan, mutatedWorld);
    (mutated.bindings[0]!.verifierTemplateQualification as { implementationDigest: string }).implementationDigest = hash("mutated verifier implementation");
    expectPreActionFailure(makeExecutor(mutated, mutatedWorld), /identity changed/i);

    const expiredWorld = emptyWorld();
    const expired = runtime(plan, expiredWorld);
    const afterExpiry = () => "2026-09-13T09:00:00.000Z";
    expectPreActionFailure(makeExecutor(expired, expiredWorld, afterExpiry), /expired/i);

    const wrongFamilyWorld = emptyWorld();
    const wrongFamily = runtime(plan, wrongFamilyWorld);
    wrongFamily.supportedRuntimeFamilies.push("experimental-browser-actions");
    (wrongFamily.bindings[0] as { runtimeFamily: string }).runtimeFamily = "experimental-browser-actions";
    expectPreActionFailure(makeExecutor(wrongFamily, wrongFamilyWorld), /different runtime family/i);
  });

  it("stops with a precise handoff when live authority is missing", async () => {
    const plan = compiledPlan();
    const world = emptyWorld();
    const store = new DurableCapabilityResolutionStore(":memory:", now);
    const artifacts = artifactStore();
    try {
      const executor = new DurableCapabilityResolutionExecutor(store, artifacts, runtime(plan, world, false), now);
      const submitted = executor.submit(plan);
      const result = await executor.run(plan.tenantId, submitted.job.jobId);
      expect(result).toMatchObject({ status: "precise-handoff", parentResumed: false, handoffReceiptDigest: hash("authority handoff") });
      expect(store.items(result.jobId)[0]).toMatchObject({ status: "blocked" });
      expect(world).toMatchObject({ readExecutions: 0, writeExecutions: 0, parentResumptions: 0 });
    } finally {
      artifacts.close();
      store.close();
    }
  });

  it("reconciles a running item after restart and never repeats its action", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-durable-resolution-"));
    const jobPath = join(directory, "jobs.sqlite");
    const artifactPath = join(directory, "artifacts.sqlite");
    const plan = compiledPlan();
    const world = emptyWorld();
    let jobId = "";
    try {
      const firstStore = new DurableCapabilityResolutionStore(jobPath, now);
      const firstArtifacts = artifactStore(artifactPath);
      const firstExecutor = new DurableCapabilityResolutionExecutor(firstStore, firstArtifacts, runtime(plan, world), now);
      const submitted = firstExecutor.submit(plan);
      jobId = submitted.job.jobId;
      expect(firstStore.claim(plan.tenantId, jobId)).toBe(true);
      firstStore.startItem(plan.tenantId, jobId, "read-shortage");
      world.shortageRead = true; // external action completed, but the process stopped before recording proof
      firstArtifacts.close();
      firstStore.close();

      const recoveredStore = new DurableCapabilityResolutionStore(jobPath, now);
      const recoveredArtifacts = artifactStore(artifactPath);
      try {
        expect(recoveredStore.recoverInterrupted()).toHaveLength(1);
        const recoveredExecutor = new DurableCapabilityResolutionExecutor(recoveredStore, recoveredArtifacts, runtime(plan, world), now);
        const result = await recoveredExecutor.run(plan.tenantId, jobId);
        expect(result.status, result.error).toBe("autonomous-completion");
        expect(world.readExecutions).toBe(0);
        expect(world.writeExecutions).toBe(1);
        expect(world.parentResumptions).toBe(1);
      } finally {
        recoveredArtifacts.close();
        recoveredStore.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reconciles a lost parent-resumption response without resuming twice", async () => {
    const plan = compiledPlan();
    const world = emptyWorld();
    const store = new DurableCapabilityResolutionStore(":memory:", now);
    const artifacts = artifactStore();
    try {
      const preparedRuntime = runtime(plan, world);
      const successfulResume = preparedRuntime.parentResumer.resume.bind(preparedRuntime.parentResumer);
      preparedRuntime.parentResumer.resume = async (input) => {
        await successfulResume(input);
        throw new Error("The parent resumed, but its response was lost.");
      };
      const executor = new DurableCapabilityResolutionExecutor(store, artifacts, preparedRuntime, now);
      const submitted = executor.submit(plan);
      const result = await executor.run(plan.tenantId, submitted.job.jobId);
      expect(result).toMatchObject({ status: "autonomous-completion", parentResumed: true });
      expect(world.parentResumptions).toBe(1);
    } finally {
      artifacts.close();
      store.close();
    }
  });

  it("quarantines every participating binding when aggregate external state fails", async () => {
    const plan = compiledPlan();
    const world = emptyWorld();
    const store = new DurableCapabilityResolutionStore(":memory:", now);
    const artifacts = artifactStore();
    try {
      const preparedRuntime = runtime(plan, world);
      preparedRuntime.aggregateVerifier.verify = async () => ({
        passed: false,
        incorrectSideEffects: 1,
        evidenceDigest: hash("aggregate rejected external state"),
        detail: "An unexpected collateral record exists.",
      });
      const executor = new DurableCapabilityResolutionExecutor(store, artifacts, preparedRuntime, now);
      const submitted = executor.submit(plan);
      const result = await executor.run(plan.tenantId, submitted.job.jobId);
      expect(result).toMatchObject({ status: "unresolved-safe", parentResumed: false });
      expect(world.quarantined).toEqual(["read-shortage", "create-draft"]);
      expect(world.parentResumptions).toBe(0);
    } finally {
      artifacts.close();
      store.close();
    }
  });
});
