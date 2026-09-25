import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ComposedRuntimeRecoveryCoordinator,
  assertComposedRecoveryReceiptIntegrity,
  composedRecoveryClassifications,
  composedRecoveryFaultBoundaries,
  normalizeBoundedDriverOutcome,
  type ComposedRecoveryClassification,
  type ComposedRecoveryContext,
  type IndependentRecoveryEvidence,
  type ParentResumptionDriver,
  type RecoveryAuthorityReceipt,
  type ReconciledRecoveryClassification,
} from "../src/product/composed-runtime-recovery.js";
import {
  EXPERIMENTAL_DOCUMENT_CAPABILITY_MODE,
  type ExperimentalDocumentOutcome,
} from "../src/experimental/document-driver.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const now = () => "2026-08-14T12:00:00.000Z";
const planDigest = hash("cf-016-bound-plan");
const qualificationDigest = hash("cf-016-qualified-capability");
const families = [
  "generic-local-sqlite",
  "generic-local-schema-file",
  EXPERIMENTAL_DOCUMENT_CAPABILITY_MODE,
] as const;

function context(
  runtimeFamily: string,
  suffix: string,
  stateVersion = 4,
  overrides: Partial<ComposedRecoveryContext> = {},
): ComposedRecoveryContext {
  return {
    schemaVersion: "1.0",
    tenantId: "tenant-cf-016",
    parentGoalId: "parent-cf-016",
    planId: "plan-cf-016",
    planDigest,
    workItemId: `item-${suffix}`,
    stateVersion,
    runtimeFamily,
    capabilityKey: `capability-${suffix}`,
    capabilityVersion: "v1",
    capabilityQualificationDigest: qualificationDigest,
    capabilityMaterialDigest: hash(`material-${suffix}`),
    idempotencyKey: hash(`idempotency-${runtimeFamily}-${suffix}`),
    ...overrides,
  };
}

function evidence(
  bound: ComposedRecoveryContext,
  classification: ReconciledRecoveryClassification,
  overrides: Partial<IndependentRecoveryEvidence> = {},
): IndependentRecoveryEvidence {
  return {
    schemaVersion: "1.0",
    observerKey: `observer-${bound.runtimeFamily}`,
    classification,
    observationDigest: hash(`observation-${bound.runtimeFamily}-${bound.workItemId}-${classification}`),
    incorrectSideEffects: ["incorrect", "duplicate", "collateral"].includes(classification) ? 1 : 0,
    tenantId: bound.tenantId,
    parentGoalId: bound.parentGoalId,
    planId: bound.planId,
    planDigest: bound.planDigest,
    workItemId: bound.workItemId,
    stateVersion: bound.stateVersion,
    runtimeFamily: bound.runtimeFamily,
    capabilityKey: bound.capabilityKey,
    capabilityVersion: bound.capabilityVersion,
    capabilityQualificationDigest: bound.capabilityQualificationDigest,
    capabilityMaterialDigest: bound.capabilityMaterialDigest,
    observedAt: now(),
    ...overrides,
  };
}

function authority(bound: ComposedRecoveryContext, overrides: Partial<RecoveryAuthorityReceipt> = {}): RecoveryAuthorityReceipt {
  return {
    schemaVersion: "1.0",
    allowed: true,
    authorityDigest: hash(`authority-${bound.runtimeFamily}-${bound.workItemId}-${bound.stateVersion}`),
    tenantId: bound.tenantId,
    parentGoalId: bound.parentGoalId,
    planId: bound.planId,
    planDigest: bound.planDigest,
    workItemId: bound.workItemId,
    stateVersion: bound.stateVersion,
    runtimeFamily: bound.runtimeFamily,
    capabilityKey: bound.capabilityKey,
    capabilityVersion: bound.capabilityVersion,
    checkedAt: now(),
    expiresAt: "2026-08-14T12:05:00.000Z",
    ...overrides,
  };
}

function recover(
  coordinator: ComposedRuntimeRecoveryCoordinator,
  bound: ComposedRecoveryContext,
  classification: ReconciledRecoveryClassification,
  responseDisposition: "available" | "lost" = "available",
) {
  return coordinator.recover({
    context: bound,
    responseDisposition,
    independentEvidence: evidence(bound, classification),
    ...(classification === "not-started" ? { authorityRecheck: authority(bound) } : {}),
  });
}

describe("composed runtime recovery state machine", () => {
  it("covers every required state and exact transition across database, schema-file and bounded-document families", () => {
    expect(composedRecoveryClassifications).toEqual([
      "completed", "not-started", "partial", "incorrect", "duplicate", "stale",
      "collateral", "unknown", "unavailable", "lost-response",
    ] satisfies ComposedRecoveryClassification[]);
    const expected = {
      completed: ["verified-completion", false, false],
      "not-started": ["retry-authorized-once", false, false],
      partial: ["quarantine-and-invalidate-retained", true, true],
      incorrect: ["quarantine-and-invalidate-retained", true, true],
      duplicate: ["quarantine-and-invalidate-retained", true, true],
      stale: ["quarantine-and-invalidate-retained", true, true],
      collateral: ["quarantine-and-invalidate-retained", true, true],
      unknown: ["precise-handoff", false, false],
      unavailable: ["precise-handoff", false, false],
    } as const;
    const coordinator = new ComposedRuntimeRecoveryCoordinator(":memory:", now);
    try {
      for (const family of families) {
        for (const [classification, [transition, quarantine, invalidate]] of Object.entries(expected)) {
          const bound = context(family, `${family}-${classification}`);
          const receipt = recover(
            coordinator,
            bound,
            classification as ReconciledRecoveryClassification,
            classification === "completed" ? "lost" : "available",
          );
          assertComposedRecoveryReceiptIntegrity(receipt);
          expect(receipt).toMatchObject({
            enteredState: classification === "completed" ? "lost-response" : classification,
            reconciledClassification: classification,
            transition,
            quarantine,
            invalidateRetainedCapability: invalidate,
            verifiedCompletion: classification === "completed",
          });
          expect(Boolean(receipt.retryPermitId)).toBe(classification === "not-started");
          expect(Boolean(receipt.handoffReason)).toBe(classification === "unknown" || classification === "unavailable");
        }
      }
    } finally { coordinator.close(); }
  });

  it("adapts the actual bounded document-driver vocabulary without upgrading its evidence", () => {
    const outcomes: ExperimentalDocumentOutcome[] = ["complete", "not-started", "partial", "incorrect", "unknown"];
    expect(outcomes.map(normalizeBoundedDriverOutcome)).toEqual(["completed", "not-started", "partial", "incorrect", "unknown"]);
    expect(EXPERIMENTAL_DOCUMENT_CAPABILITY_MODE).toBe("experimental-document-actions");
  });

  it("fails closed on cross-plan, cross-version, cross-family and fabricated completion evidence", () => {
    const coordinator = new ComposedRuntimeRecoveryCoordinator(":memory:", now);
    const bound = context(families[0], "binding");
    try {
      for (const mutation of [
        { planDigest: hash("other-plan") },
        { stateVersion: bound.stateVersion + 1 },
        { runtimeFamily: families[1] },
        { capabilityQualificationDigest: hash("other-qualification") },
      ]) {
        expect(() => coordinator.recover({
          context: bound,
          responseDisposition: "lost",
          independentEvidence: evidence(bound, "completed", mutation),
        })).toThrow(/not bound/);
      }
      expect(() => coordinator.recover({
        context: bound,
        responseDisposition: "available",
        independentEvidence: evidence(bound, "completed", { incorrectSideEffects: 1 }),
      })).toThrow(/incorrect side effects/);
      expect(() => coordinator.recover({
        context: bound,
        responseDisposition: "available",
        independentEvidence: evidence(bound, "not-started"),
      })).toThrow(/authority recheck/);
      expect(() => coordinator.recover({
        context: bound,
        responseDisposition: "available",
        independentEvidence: evidence(bound, "not-started"),
        authorityRecheck: authority(bound, { stateVersion: bound.stateVersion + 1 }),
      })).toThrow(/state version/);
    } finally { coordinator.close(); }
  });

  it("issues a bound retry only for not-started, consumes it once and rolls back a boundary fault", () => {
    const coordinator = new ComposedRuntimeRecoveryCoordinator(":memory:", now);
    const bound = context(families[0], "retry");
    try {
      const receipt = recover(coordinator, bound, "not-started", "lost");
      expect(receipt).toMatchObject({ enteredState: "lost-response", retryStateVersion: 5 });
      expect(() => coordinator.consumeRetry({
        permitId: receipt.retryPermitId!, context: bound, authorityRecheck: authority(bound),
        fault: (boundary) => { if (boundary === "after-retry-consumption") throw new Error("fault-after-retry-consumption"); },
      })).toThrow("fault-after-retry-consumption");
      expect(coordinator.consumeRetry({
        permitId: receipt.retryPermitId!, context: bound, authorityRecheck: authority(bound),
      })).toEqual({ authorized: true, priorStateVersion: 4, nextStateVersion: 5 });
      expect(() => coordinator.consumeRetry({
        permitId: receipt.retryPermitId!, context: bound, authorityRecheck: authority(bound),
      })).toThrow(/already been consumed/);
    } finally { coordinator.close(); }
  });

  it("retains and reuses only exact verified family qualifications, then invalidates on stale evidence", () => {
    const coordinator = new ComposedRuntimeRecoveryCoordinator(":memory:", now);
    try {
      for (const family of families) {
        const bound = context(family, `retained-${family}`);
        const completed = recover(coordinator, bound, "completed", "lost");
        coordinator.retain(completed);
        const reuse = coordinator.reuse({
          tenantId: bound.tenantId,
          runtimeFamily: bound.runtimeFamily,
          capabilityKey: bound.capabilityKey,
          capabilityVersion: bound.capabilityVersion,
          capabilityQualificationDigest: bound.capabilityQualificationDigest,
          consumerPlanDigest: hash(`consumer-${family}`),
          consumerWorkItemId: `reuse-${family}`,
        });
        expect(reuse).toMatchObject({ runtimeFamily: family, retainedEvidenceDigest: completed.independentEvidence.observationDigest });
        expect(reuse.integrityDigest).toHaveLength(64);
        expect(() => coordinator.reuse({
          tenantId: bound.tenantId, runtimeFamily: bound.runtimeFamily, capabilityKey: bound.capabilityKey,
          capabilityVersion: bound.capabilityVersion, capabilityQualificationDigest: hash("qualification-drift"),
          consumerPlanDigest: hash(`drift-consumer-${family}`), consumerWorkItemId: `drift-${family}`,
        })).toThrow(/qualification changed/);

        const staleContext = { ...bound, stateVersion: bound.stateVersion + 1, idempotencyKey: hash(`stale-${family}`) };
        const stale = recover(coordinator, staleContext, "stale");
        expect(stale.invalidateRetainedCapability).toBe(true);
        expect(coordinator.retainedStatus(bound.tenantId, family, bound.capabilityKey)).toBe("invalidated");
        expect(() => coordinator.reuse({
          tenantId: bound.tenantId, runtimeFamily: family, capabilityKey: bound.capabilityKey,
          capabilityVersion: bound.capabilityVersion, capabilityQualificationDigest: bound.capabilityQualificationDigest,
          consumerPlanDigest: hash(`blocked-consumer-${family}`), consumerWorkItemId: `blocked-${family}`,
        })).toThrow(/No active retained capability/);
      }
    } finally { coordinator.close(); }
  });

  it("resumes the parent exactly once after all bound item completions and reconciles a lost response", async () => {
    const coordinator = new ComposedRuntimeRecoveryCoordinator(":memory:", now);
    const databaseItem = recover(coordinator, context(families[0], "parent-db"), "completed", "lost");
    const fileItem = recover(coordinator, context(families[1], "parent-file"), "completed", "available");
    let executions = 0;
    let reconciliations = 0;
    const completedKeys = new Set<string>();
    const driver: ParentResumptionDriver = {
      async resume({ resumptionKey }) {
        executions += 1;
        completedKeys.add(resumptionKey);
        throw new Error("response lost after parent commit");
      },
      async reconcile({ resumptionKey }) {
        reconciliations += 1;
        const completed = completedKeys.has(resumptionKey);
        return {
          classification: completed ? "completed" : "not-started",
          ...(completed ? { receiptDigest: hash(`parent-receipt-${resumptionKey}`) } : {}),
          evidenceDigest: hash(`parent-evidence-${resumptionKey}-${completed}`),
          detail: "Independent parent state was reconciled.",
        };
      },
    };
    const input = {
      binding: { schemaVersion: "1.0" as const, tenantId: "tenant-cf-016", parentGoalId: "parent-cf-016", planId: "plan-cf-016", planDigest, stateVersion: 8 },
      aggregateEvidenceDigest: hash("aggregate-evidence"),
      itemReceipts: [databaseItem, fileItem],
      driver,
    };
    try {
      const first = await coordinator.resumeParent(input);
      const second = await coordinator.resumeParent(input);
      expect(first).toEqual(second);
      expect(first).toMatchObject({ reconciledAfterLostResponse: true });
      expect(executions).toBe(1);
      expect(reconciliations).toBe(1);
    } finally { coordinator.close(); }
  });

  it("rejects parent resumption when any item is unverified or belongs to another plan", async () => {
    const coordinator = new ComposedRuntimeRecoveryCoordinator(":memory:", now);
    const blocked = recover(coordinator, context(families[0], "blocked-parent"), "unknown");
    const driver: ParentResumptionDriver = {
      async resume() { return { completed: true, receiptDigest: hash("receipt"), evidenceDigest: hash("evidence") }; },
      async reconcile() { return { classification: "completed", receiptDigest: hash("receipt"), evidenceDigest: hash("evidence"), detail: "done" }; },
    };
    try {
      await expect(coordinator.resumeParent({
        binding: { schemaVersion: "1.0", tenantId: "tenant-cf-016", parentGoalId: "parent-cf-016", planId: "plan-cf-016", planDigest, stateVersion: 1 },
        aggregateEvidenceDigest: hash("aggregate"), itemReceipts: [blocked], driver,
      })).rejects.toThrow(/incomplete/);
    } finally { coordinator.close(); }
  });

  it("exposes and fault-injects every recovery boundary without creating an unsafe transition", async () => {
    expect(composedRecoveryFaultBoundaries).toHaveLength(14);
    const recoveryBoundaries = [
      "before-reconciliation", "lost-response-recorded", "after-independent-observation",
      "before-authority-recheck", "after-authority-recheck",
    ] as const;
    for (const boundary of recoveryBoundaries) {
      const coordinator = new ComposedRuntimeRecoveryCoordinator(":memory:", now);
      const bound = context(families[0], `fault-${boundary}`);
      const classification = boundary.includes("authority") ? "not-started" as const : "completed" as const;
      expect(() => coordinator.recover({
        context: bound, responseDisposition: "lost", independentEvidence: evidence(bound, classification),
        ...(classification === "not-started" ? { authorityRecheck: authority(bound) } : {}),
        fault: (seen) => { if (seen === boundary) throw new Error(`fault-${boundary}`); },
      })).toThrow(`fault-${boundary}`);
      coordinator.close();
    }

    for (const boundary of ["before-retry-consumption", "after-retry-consumption"] as const) {
      const coordinator = new ComposedRuntimeRecoveryCoordinator(":memory:", now);
      const bound = context(families[0], `fault-${boundary}`);
      const receipt = recover(coordinator, bound, "not-started");
      expect(() => coordinator.consumeRetry({
        permitId: receipt.retryPermitId!, context: bound, authorityRecheck: authority(bound),
        fault: (seen) => { if (seen === boundary) throw new Error(`fault-${boundary}`); },
      })).toThrow(`fault-${boundary}`);
      expect(coordinator.consumeRetry({ permitId: receipt.retryPermitId!, context: bound, authorityRecheck: authority(bound) }).authorized).toBe(true);
      coordinator.close();
    }

    for (const boundary of ["before-retention", "before-retained-reuse"] as const) {
      const coordinator = new ComposedRuntimeRecoveryCoordinator(":memory:", now);
      const bound = context(families[0], `fault-${boundary}`);
      const receipt = recover(coordinator, bound, "completed");
      if (boundary === "before-retention") {
        expect(() => coordinator.retain(receipt, (seen) => { if (seen === boundary) throw new Error(`fault-${boundary}`); })).toThrow(`fault-${boundary}`);
        expect(coordinator.retainedStatus(bound.tenantId, bound.runtimeFamily, bound.capabilityKey)).toBe("missing");
      } else {
        coordinator.retain(receipt);
        expect(() => coordinator.reuse({
          tenantId: bound.tenantId, runtimeFamily: bound.runtimeFamily, capabilityKey: bound.capabilityKey,
          capabilityVersion: bound.capabilityVersion, capabilityQualificationDigest: bound.capabilityQualificationDigest,
          consumerPlanDigest: hash("fault-consumer"), consumerWorkItemId: "fault-consumer",
          fault: (seen) => { if (seen === boundary) throw new Error(`fault-${boundary}`); },
        })).toThrow(`fault-${boundary}`);
      }
      coordinator.close();
    }

    for (const boundary of [
      "before-parent-resumption", "lost-parent-response", "before-parent-reconciliation",
      "after-parent-reconciliation", "before-parent-commit",
    ] as const) {
      const coordinator = new ComposedRuntimeRecoveryCoordinator(":memory:", now);
      const item = recover(coordinator, context(families[0], `fault-${boundary}`), "completed");
      const completed = new Set<string>();
      const driver: ParentResumptionDriver = {
        async resume({ resumptionKey }) { completed.add(resumptionKey); throw new Error("lost"); },
        async reconcile({ resumptionKey }) {
          return { classification: completed.has(resumptionKey) ? "completed" : "not-started", receiptDigest: hash(`receipt-${resumptionKey}`), evidenceDigest: hash(`evidence-${resumptionKey}`), detail: "reconciled" };
        },
      };
      await expect(coordinator.resumeParent({
        binding: { schemaVersion: "1.0", tenantId: "tenant-cf-016", parentGoalId: "parent-cf-016", planId: "plan-cf-016", planDigest, stateVersion: 9 },
        aggregateEvidenceDigest: hash(`aggregate-${boundary}`), itemReceipts: [item], driver,
        fault: (seen) => { if (seen === boundary) throw new Error(`fault-${boundary}`); },
      })).rejects.toThrow(`fault-${boundary}`);
      coordinator.close();
    }
  });
});
