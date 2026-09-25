import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ComposedRuntimeRecoveryCoordinator,
  type ComposedRecoveryContext,
  type ComposedRecoveryReceipt,
  type ReconciledRecoveryClassification,
} from "../src/product/composed-runtime-recovery.js";
import {
  DurableCapabilityLifecycle,
  type LifecycleCapabilityRecord,
  type LifecycleHealthSource,
  type LifecycleObservedMaterial,
  type ReplacementQualification,
} from "../src/product/durable-capability-lifecycle.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];
const tenantId = "tenant-cf-020";
const planDigest = hash("cf-020-plan");
const families = ["generic-local-sqlite", "generic-local-schema-file"] as const;

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "cf-020-lifecycle-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});
function recoveryReceipt(input: {
  runtimeFamily: string;
  capabilityKey: string;
  capabilityVersion: string;
  qualificationDigest: string;
  classification?: ReconciledRecoveryClassification;
  stateVersion?: number;
  materialDigest?: string;
}): ComposedRecoveryReceipt {
  const coordinator = new ComposedRuntimeRecoveryCoordinator(":memory:", () => "2026-08-14T12:00:00.000Z");
  const context: ComposedRecoveryContext = {
    schemaVersion: "1.0", tenantId, parentGoalId: "parent-cf-020", planId: "plan-cf-020", planDigest,
    workItemId: `item-${input.runtimeFamily}-${input.capabilityVersion}-${input.stateVersion ?? 1}`,
    stateVersion: input.stateVersion ?? 1, runtimeFamily: input.runtimeFamily,
    capabilityKey: input.capabilityKey, capabilityVersion: input.capabilityVersion,
    capabilityQualificationDigest: input.qualificationDigest,
    capabilityMaterialDigest: input.materialDigest ?? hash(`material-${input.runtimeFamily}-${input.capabilityVersion}`),
    idempotencyKey: hash(`idempotency-${input.runtimeFamily}-${input.capabilityKey}-${input.capabilityVersion}-${input.stateVersion ?? 1}`),
  };
  const classification = input.classification ?? "completed";
  const receipt = coordinator.recover({
    context,
    responseDisposition: classification === "completed" ? "lost" : "available",
    independentEvidence: {
      schemaVersion: "1.0", observerKey: `observer-${input.runtimeFamily}`, classification,
      observationDigest: hash(`observation-${input.runtimeFamily}-${input.capabilityVersion}-${classification}`),
      incorrectSideEffects: ["incorrect", "duplicate", "collateral"].includes(classification) ? 1 : 0,
      tenantId,
      parentGoalId: context.parentGoalId,
      planId: context.planId,
      planDigest, workItemId: context.workItemId, stateVersion: context.stateVersion,
      runtimeFamily: context.runtimeFamily, capabilityKey: context.capabilityKey,
      capabilityVersion: context.capabilityVersion,
      capabilityQualificationDigest: context.capabilityQualificationDigest,
      capabilityMaterialDigest: context.capabilityMaterialDigest,
      observedAt: "2026-08-14T12:00:00.000Z",
    },
  });
  coordinator.close();
  return receipt;
}

function lifecycleInput(input: {
  runtimeFamily: string;
  capabilityKey: string;
  capabilityVersion?: string;
  qualificationDigest?: string;
  qualificationExpiresAt?: string;
  documentationDigest?: string;
  schemaDigest?: string;
  provenanceDigest?: string;
  retentionEvidenceDigest: string;
}) {
  return {
    schemaVersion: "1.0" as const,
    tenantId,
    runtimeFamily: input.runtimeFamily,
    capabilityKey: input.capabilityKey,
    capabilityVersion: input.capabilityVersion ?? "1.0.0",
    capabilityQualificationDigest: input.qualificationDigest ?? hash(`qualification-${input.runtimeFamily}-${input.capabilityVersion ?? "1.0.0"}`),
    qualificationExpiresAt: input.qualificationExpiresAt ?? "2026-09-14T12:00:00.000Z",
    documentationDigest: input.documentationDigest ?? hash(`documentation-${input.runtimeFamily}-${input.capabilityVersion ?? "1.0.0"}`),
    schemaDigest: input.schemaDigest ?? hash(`schema-${input.runtimeFamily}-${input.capabilityVersion ?? "1.0.0"}`),
    provenanceDigest: input.provenanceDigest ?? hash(`provenance-${input.runtimeFamily}-${input.capabilityVersion ?? "1.0.0"}`),
    retentionEvidenceDigest: input.retentionEvidenceDigest,
  };
}

function retain(
  lifecycle: DurableCapabilityLifecycle,
  runtimeFamily: string,
  capabilityKey: string,
  capabilityVersion = "1.0.0",
  qualificationExpiresAt = "2026-09-14T12:00:00.000Z",
): LifecycleCapabilityRecord {
  const qualificationDigest = hash(`qualification-${runtimeFamily}-${capabilityVersion}`);
  const candidate = lifecycleInput({
    runtimeFamily, capabilityKey, capabilityVersion, qualificationDigest, qualificationExpiresAt,
    retentionEvidenceDigest: hash(`placeholder-${runtimeFamily}-${capabilityVersion}`),
  });
  const materialDigest = hashMaterial(candidate);
  const receipt = recoveryReceipt({ runtimeFamily, capabilityKey, capabilityVersion, qualificationDigest, materialDigest });
  return lifecycle.retainFromRecovery({ ...candidate, retentionEvidenceDigest: receipt.independentEvidence.observationDigest }, receipt);
}

function hashMaterial(candidate: { documentationDigest: string; schemaDigest: string; provenanceDigest: string }): string {
  const canonical = `{\"documentationDigest\":\"${candidate.documentationDigest}\",\"provenanceDigest\":\"${candidate.provenanceDigest}\",\"schemaDigest\":\"${candidate.schemaDigest}\"}`;
  return hash(canonical);
}

interface MutableWorld {
  observed: Map<string, LifecycleObservedMaterial>;
  probePassed: Map<string, boolean>;
  unavailable: Set<string>;
}

function source(world: MutableWorld): LifecycleHealthSource {
  return {
    async observe(record) {
      if (world.unavailable.has(record.capabilityKey)) throw new Error("observation unavailable");
      return world.observed.get(`${record.runtimeFamily}:${record.capabilityKey}`) ?? {
        documentationDigest: record.documentationDigest,
        schemaDigest: record.schemaDigest,
        provenanceDigest: record.provenanceDigest,
        documentationCompatibility: "unchanged",
        observationDigest: hash(`observed-${record.runtimeFamily}-${record.capabilityVersion}`),
      };
    },
    async probe(record, observed) {
      const passed = world.probePassed.get(`${record.runtimeFamily}:${record.capabilityKey}`) ?? true;
      return { passed, evidenceDigest: hash(`probe-${record.runtimeFamily}-${record.capabilityVersion}-${observed.observationDigest}-${passed}`), detail: passed ? "Independent probe passed." : "Independent probe failed." };
    },
  };
}

function qualificationFor(candidate: ReturnType<typeof lifecycleInput>, passed = true, expiresAt = candidate.qualificationExpiresAt): ReplacementQualification {
  const observed = {
    documentationDigest: candidate.documentationDigest,
    schemaDigest: candidate.schemaDigest,
    provenanceDigest: candidate.provenanceDigest,
    documentationCompatibility: "unchanged" as const,
    observationDigest: hash(`replacement-observation-${candidate.runtimeFamily}-${candidate.capabilityVersion}`),
  };
  return {
    schemaVersion: "1.0", passed,
    evidenceDigest: hash(`replacement-qualification-${candidate.runtimeFamily}-${candidate.capabilityVersion}-${passed}`),
    capabilityQualificationDigest: candidate.capabilityQualificationDigest,
    qualifiedAt: "2026-08-14T12:01:00.000Z", expiresAt, observed,
    probe: { passed, evidenceDigest: hash(`replacement-probe-${candidate.runtimeFamily}-${candidate.capabilityVersion}-${passed}`), detail: passed ? "Replacement passed." : "Replacement failed." },
  };
}

describe("durable recurring retained-capability lifecycle", () => {
  it("persists two families, multiple workflow dependencies and concurrent read visibility across restart", async () => {
    const directory = root();
    const path = join(directory, "lifecycle.sqlite");
    let clock = "2026-08-14T12:00:00.000Z";
    const first = new DurableCapabilityLifecycle(path, () => clock, 60_000);
    const sqlite = retain(first, families[0], "record-upsert");
    const file = retain(first, families[1], "record-export");
    for (const workflow of ["daily-sync", "exception-repair", "month-end-close"]) first.registerDependency(tenantId, sqlite.runtimeFamily, sqlite.capabilityKey, workflow);
    for (const workflow of ["daily-sync", "dispatch-export"]) first.registerDependency(tenantId, file.runtimeFamily, file.capabilityKey, workflow);
    expect(first.continueWorkflow({ tenantId, workflowKey: "daily-sync", planDigest, workItemId: "continue-db", runtimeFamily: sqlite.runtimeFamily, capabilityKey: sqlite.capabilityKey }).capabilityVersion).toBe("1.0.0");
    first.close();

    const restarted = new DurableCapabilityLifecycle(path, () => clock, 60_000);
    const parallel = new DurableCapabilityLifecycle(path, () => clock, 60_000);
    try {
      const snapshots = await Promise.all(Array.from({ length: 20 }, (_, index) => Promise.resolve(
        (index % 2 === 0 ? restarted : parallel).dependencies(tenantId, families[0], "record-upsert"),
      )));
      expect(snapshots.every((item) => JSON.stringify(item) === JSON.stringify(["daily-sync", "exception-repair", "month-end-close"]))).toBe(true);
      expect(restarted.list(tenantId).map((item) => [item.runtimeFamily, item.status])).toEqual([
        [families[1], "active"], [families[0], "active"],
      ]);
      clock = "2026-08-14T12:01:00.000Z";
      expect(() => restarted.continueWorkflow({ tenantId, workflowKey: "daily-sync", planDigest, workItemId: "due-db", runtimeFamily: families[0], capabilityKey: "record-upsert" })).toThrow(/probe is due/);
      const run = await restarted.runPeriodic(tenantId, source({ observed: new Map(), probePassed: new Map(), unavailable: new Set() }));
      expect(run).toMatchObject({ trigger: "periodic", checked: 2, healthy: 2, quarantined: 0 });
      expect(restarted.continueWorkflow({ tenantId, workflowKey: "daily-sync", planDigest, workItemId: "after-probe", runtimeFamily: families[0], capabilityKey: "record-upsert" }).capabilityVersion).toBe("1.0.0");
    } finally { parallel.close(); restarted.close(); }
  });

  it("accepts benign documentation drift only after re-probe and quarantines breaking schema drift", async () => {
    const lifecycle = new DurableCapabilityLifecycle(":memory:", () => "2026-08-14T12:00:00.000Z", 60_000);
    const sqlite = retain(lifecycle, families[0], "benign-reader");
    const file = retain(lifecycle, families[1], "breaking-writer");
    lifecycle.registerDependency(tenantId, sqlite.runtimeFamily, sqlite.capabilityKey, "support-read");
    lifecycle.registerDependency(tenantId, file.runtimeFamily, file.capabilityKey, "daily-export");
    const world: MutableWorld = { observed: new Map(), probePassed: new Map(), unavailable: new Set() };
    world.observed.set(`${sqlite.runtimeFamily}:${sqlite.capabilityKey}`, {
      documentationDigest: hash("benign-doc-v2"), schemaDigest: sqlite.schemaDigest,
      provenanceDigest: sqlite.provenanceDigest, documentationCompatibility: "compatible",
      observationDigest: hash("benign-observation"),
    });
    world.observed.set(`${file.runtimeFamily}:${file.capabilityKey}`, {
      documentationDigest: file.documentationDigest, schemaDigest: hash("breaking-schema-v2"),
      provenanceDigest: file.provenanceDigest, documentationCompatibility: "unchanged",
      observationDigest: hash("breaking-observation"),
    });
    try {
      const run = await lifecycle.runTriggered(tenantId, "schema-change", source(world));
      expect(run).toMatchObject({ checked: 2, benignDrift: 1, quarantined: 1 });
      expect(run.assessments.find((item) => item.capabilityKey === "benign-reader")).toMatchObject({ status: "benign-drift", reason: "benign-documentation-drift", dependencies: ["support-read"] });
      expect(run.assessments.find((item) => item.capabilityKey === "breaking-writer")).toMatchObject({ status: "quarantined", reason: "schema-drift", dependencies: ["daily-export"] });
      expect(lifecycle.get(tenantId, sqlite.runtimeFamily, sqlite.capabilityKey, "1.0.0")?.documentationDigest).toBe(hash("benign-doc-v2"));
      expect(() => lifecycle.continueWorkflow({ tenantId, workflowKey: "daily-export", planDigest, workItemId: "blocked-file", runtimeFamily: file.runtimeFamily, capabilityKey: file.capabilityKey })).toThrow(/No active/);
      expect(lifecycle.continueWorkflow({ tenantId, workflowKey: "support-read", planDigest, workItemId: "continue-reader", runtimeFamily: sqlite.runtimeFamily, capabilityKey: sqlite.capabilityKey }).capabilityVersion).toBe("1.0.0");
    } finally { lifecycle.close(); }
  });

  it("quarantines verifier failure, stale qualification and unavailable observation before reuse", async () => {
    let clock = "2026-08-14T12:00:00.000Z";
    const lifecycle = new DurableCapabilityLifecycle(":memory:", () => clock, 60_000);
    const verifier = retain(lifecycle, families[0], "verifier-fails");
    const stale = retain(lifecycle, families[1], "qualification-stales", "1.0.0", "2026-08-14T12:02:00.000Z");
    const unavailable = retain(lifecycle, families[0], "observer-unavailable");
    for (const item of [verifier, stale, unavailable]) lifecycle.registerDependency(tenantId, item.runtimeFamily, item.capabilityKey, `workflow-${item.capabilityKey}`);
    const world: MutableWorld = { observed: new Map(), probePassed: new Map([[`${verifier.runtimeFamily}:${verifier.capabilityKey}`, false]]), unavailable: new Set([unavailable.capabilityKey]) };
    try {
      clock = "2026-08-14T12:03:00.000Z";
      const run = await lifecycle.runTriggered(tenantId, "manual", source(world));
      expect(run.assessments.map((item) => [item.capabilityKey, item.reason]).sort()).toEqual([
        ["observer-unavailable", "observation-unavailable"],
        ["qualification-stales", "qualification-stale"],
        ["verifier-fails", "verifier-failure"],
      ]);
      expect(lifecycle.list(tenantId).every((item) => item.status === "quarantined")).toBe(true);
      for (const item of [verifier, stale, unavailable]) expect(() => lifecycle.continueWorkflow({
        tenantId, workflowKey: `workflow-${item.capabilityKey}`, planDigest,
        workItemId: `blocked-${item.capabilityKey}`, runtimeFamily: item.runtimeFamily, capabilityKey: item.capabilityKey,
      })).toThrow(/No active/);
    } finally { lifecycle.close(); }
  });

  it("integrates composed recovery invalidation and rejects cross-qualification recovery receipts", () => {
    const lifecycle = new DurableCapabilityLifecycle(":memory:", () => "2026-08-14T12:00:00.000Z", 60_000);
    const active = retain(lifecycle, families[0], "recovery-bound");
    lifecycle.registerDependency(tenantId, active.runtimeFamily, active.capabilityKey, "repair-flow");
    try {
      const staleReceipt = recoveryReceipt({ runtimeFamily: active.runtimeFamily, capabilityKey: active.capabilityKey, capabilityVersion: active.capabilityVersion, qualificationDigest: active.capabilityQualificationDigest, classification: "stale", stateVersion: 2 });
      lifecycle.applyRecoveryReceipt(staleReceipt);
      expect(lifecycle.get(tenantId, active.runtimeFamily, active.capabilityKey, active.capabilityVersion)).toMatchObject({ status: "quarantined" });
      expect(() => lifecycle.continueWorkflow({ tenantId, workflowKey: "repair-flow", planDigest, workItemId: "repair-continuation", runtimeFamily: active.runtimeFamily, capabilityKey: active.capabilityKey })).toThrow(/No active/);
      const forged = recoveryReceipt({ runtimeFamily: active.runtimeFamily, capabilityKey: active.capabilityKey, capabilityVersion: active.capabilityVersion, qualificationDigest: hash("other-qualification"), classification: "stale", stateVersion: 3 });
      expect(() => lifecycle.applyRecoveryReceipt(forged)).toThrow(/qualification/);
    } finally { lifecycle.close(); }
  });

  it("rejects lower, failed and stale replacements, then atomically activates a qualified higher version", () => {
    const lifecycle = new DurableCapabilityLifecycle(":memory:", () => "2026-08-14T12:00:00.000Z", 60_000);
    const prior = retain(lifecycle, families[0], "replace-after-drift");
    lifecycle.registerDependency(tenantId, prior.runtimeFamily, prior.capabilityKey, "workflow-a");
    lifecycle.registerDependency(tenantId, prior.runtimeFamily, prior.capabilityKey, "workflow-b");
    const staleReceipt = recoveryReceipt({ runtimeFamily: prior.runtimeFamily, capabilityKey: prior.capabilityKey, capabilityVersion: prior.capabilityVersion, qualificationDigest: prior.capabilityQualificationDigest, classification: "stale", stateVersion: 2 });
    lifecycle.applyRecoveryReceipt(staleReceipt);
    const candidate = lifecycleInput({
      runtimeFamily: prior.runtimeFamily, capabilityKey: prior.capabilityKey, capabilityVersion: "1.1.0",
      retentionEvidenceDigest: hash("replacement-retention-evidence"),
    });
    const lower = { ...candidate, capabilityVersion: "1.0.0", capabilityQualificationDigest: hash("lower-qualification") };
    try {
      expect(() => lifecycle.stageReplacement(lower, qualificationFor(lower))).toThrow(/higher semantic version/);
      expect(() => lifecycle.stageReplacement(candidate, qualificationFor(candidate, false))).toThrow(/did not pass/);
      expect(() => lifecycle.stageReplacement(candidate, qualificationFor(candidate, true, "2026-08-14T11:59:00.000Z"))).toThrow(/stale|does not match/);
      expect(lifecycle.list(tenantId)).toHaveLength(1);
      lifecycle.stageReplacement(candidate, qualificationFor(candidate));
      expect(() => lifecycle.continueWorkflow({ tenantId, workflowKey: "workflow-a", planDigest, workItemId: "candidate-not-active", runtimeFamily: prior.runtimeFamily, capabilityKey: prior.capabilityKey })).toThrow(/No active/);
      const activation = lifecycle.activateReplacement(tenantId, prior.runtimeFamily, prior.capabilityKey, "1.1.0");
      expect(activation).toMatchObject({ priorStatus: "quarantined", replacementVersion: "1.1.0", dependencySnapshot: ["workflow-a", "workflow-b"], status: "active" });
      expect(lifecycle.continueWorkflow({ tenantId, workflowKey: "workflow-a", planDigest, workItemId: "replacement-continuation", runtimeFamily: prior.runtimeFamily, capabilityKey: prior.capabilityKey }).capabilityVersion).toBe("1.1.0");
      const rolledBack = lifecycle.rollbackActivation(activation.activationId, activation.rollbackToken);
      expect(rolledBack.status).toBe("rolled-back");
      expect(lifecycle.get(tenantId, prior.runtimeFamily, prior.capabilityKey, "1.0.0")?.status).toBe("quarantined");
      expect(lifecycle.get(tenantId, prior.runtimeFamily, prior.capabilityKey, "1.1.0")?.status).toBe("rolled-back");
      expect(() => lifecycle.continueWorkflow({ tenantId, workflowKey: "workflow-a", planDigest, workItemId: "after-safe-rollback", runtimeFamily: prior.runtimeFamily, capabilityKey: prior.capabilityKey })).toThrow(/No active/);
    } finally { lifecycle.close(); }
  });

  it("rolls back an active-family replacement atomically to the previously healthy version", () => {
    const lifecycle = new DurableCapabilityLifecycle(":memory:", () => "2026-08-14T12:00:00.000Z", 60_000);
    const prior = retain(lifecycle, families[1], "rollback-healthy");
    lifecycle.registerDependency(tenantId, prior.runtimeFamily, prior.capabilityKey, "export-flow");
    const candidate = lifecycleInput({
      runtimeFamily: prior.runtimeFamily, capabilityKey: prior.capabilityKey, capabilityVersion: "2.0.0",
      retentionEvidenceDigest: hash("rollback-replacement-retention"),
    });
    try {
      lifecycle.stageReplacement(candidate, qualificationFor(candidate));
      const activation = lifecycle.activateReplacement(tenantId, prior.runtimeFamily, prior.capabilityKey, "2.0.0");
      expect(lifecycle.continueWorkflow({ tenantId, workflowKey: "export-flow", planDigest, workItemId: "on-v2", runtimeFamily: prior.runtimeFamily, capabilityKey: prior.capabilityKey }).capabilityVersion).toBe("2.0.0");
      lifecycle.rollbackActivation(activation.activationId, activation.rollbackToken);
      expect(lifecycle.continueWorkflow({ tenantId, workflowKey: "export-flow", planDigest, workItemId: "back-on-v1", runtimeFamily: prior.runtimeFamily, capabilityKey: prior.capabilityKey }).capabilityVersion).toBe("1.0.0");
      expect(() => lifecycle.rollbackActivation(activation.activationId, activation.rollbackToken)).toThrow(/already been rolled back/);
    } finally { lifecycle.close(); }
  });
});
