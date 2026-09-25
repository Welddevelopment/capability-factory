import { describe, expect, it } from "vitest";
import type { CapabilityMode, CapabilityModeDescriptor, CapabilityModeEnvelope } from "../src/product/capability-mode-contract.js";
import { CapabilityModeRouter, type CapabilityModeRunner } from "../src/product/capability-mode-router.js";
import type { CapabilityBundle, RuntimeFamily, UniversalGoal } from "../src/product/universal-capability-contract.js";
import { UniversalCapabilityCoordinator, type PreparedCapabilityRoute } from "../src/product/universal-capability-coordinator.js";
import {
  UniversalCompositionCoordinator,
  type UniversalCompositionPlan,
  type UniversalCompositionVerifier,
} from "../src/product/universal-composition.js";

const hash = "b".repeat(64);
const ordinaryGoal = "Complete the approved multi-system work and prove the combined external result.";
const familyByMode: Record<CapabilityMode, RuntimeFamily> = {
  "constrained-http-api": "service-api",
  "experimental-browser-actions": "browser-web",
  "experimental-file-transfer-actions": "file-object-edi",
  "experimental-inbox-message-actions": "message-event",
  "experimental-document-actions": "document-media",
  "experimental-database-actions": "database-query",
  "experimental-trusted-tool-actions": "trusted-tool-code",
  "experimental-agent-delegation-actions": "agent-service-delegation",
};

function descriptor(mode: CapabilityMode): CapabilityModeDescriptor {
  return { capabilityMode: mode, label: mode, driverVersion: "1.0.0", maturity: "experimental-local", configured: true, claimBoundary: "Composition test boundary." };
}

function goal(workItemId: string): UniversalGoal {
  return {
    schemaVersion: "1.0",
    tenantId: "tenant-one",
    requestId: `request-${workItemId}`,
    parentGoalId: "parent-one",
    ordinaryGoal,
    gap: {
      key: `need-${workItemId}`,
      summary: `Capability needed for ${workItemId}.`,
      requiredActions: [`action-${workItemId}`],
      targetAliases: [`target-${workItemId}`],
      requiredObservationKeys: [`observation-${workItemId}`],
      maximumRisk: "consequential-write",
    },
    authority: {
      allowedTargetAliases: [`target-${workItemId}`],
      allowedSecretAliases: [],
      allowedActions: [`action-${workItemId}`],
      grantedApprovals: [`approve-${workItemId}`],
      maximumRisk: "consequential-write",
    },
  };
}

function toolEnvelope(workItemId: string): CapabilityModeEnvelope {
  return {
    schemaVersion: "1.0",
    capabilityMode: "experimental-trusted-tool-actions",
    request: {
      tenantId: "tenant-one",
      requestId: `request-${workItemId}`,
      parentGoalId: "parent-one",
      ordinaryGoal,
      needKey: `need-${workItemId}`,
      contractHash: hash,
      operationKey: `operation-${workItemId}`,
      toolId: `tool-${workItemId}`,
      toolVersion: "1.0.0",
      values: [1, 2],
      approvals: [`approve-${workItemId}`],
    },
  };
}

function bundle(workItemId: string): CapabilityBundle {
  return {
    schemaVersion: "1.0",
    capabilityId: `capability-${workItemId}`,
    tenantId: "tenant-one",
    needKey: `need-${workItemId}`,
    summary: `Bounded capability for ${workItemId}.`,
    source: "trusted-existing",
    runtime: { family: "trusted-tool-code", driverId: `driver-${workItemId}`, driverVersion: "1.0.0", executionBoundary: "isolated-sandbox" },
    manifest: { mediaType: "application/wasm", digest: hash, reference: `manifest-${workItemId}`, generated: false },
    authority: { targetAliases: [`target-${workItemId}`], secretAliases: [], approvalKeys: [`approve-${workItemId}`], risk: "consequential-write" },
    verification: { preUseVerifierKey: `probe-${workItemId}`, outcomeVerifierKey: `outcome-${workItemId}`, observationSource: `observation-${workItemId}`, independentFromExecution: true, contractHash: hash },
    recovery: { operationKey: `operation-${workItemId}`, idempotency: "not-applicable", reconcileBeforeRetry: true, blindRetryAllowed: false, quarantineOn: ["verification-failure", "incorrect-outcome", "unknown-outcome"] },
    provenance: { trustedSourceIds: ["trusted-catalog"], sourceHashes: [hash], builderVersion: "builder-one", builtAt: "2026-08-05T00:00:00.000Z" },
    retention: { version: 1, reusable: true, scopeDigest: hash },
  };
}

function route(workItemId: string): PreparedCapabilityRoute {
  return {
    routeId: `route-${workItemId}`,
    family: "trusted-tool-code",
    envelope: toolEnvelope(workItemId),
    bundle: bundle(workItemId),
    supportedActions: [`action-${workItemId}`],
    targetAliases: [`target-${workItemId}`],
    observationKeys: [`observation-${workItemId}`],
    requiredSecretAliases: [],
    requiredApprovalKeys: [`approve-${workItemId}`],
    priority: 1,
  };
}

function plan(): UniversalCompositionPlan {
  return {
    schemaVersion: "1.0",
    tenantId: "tenant-one",
    requestId: "composition-one",
    parentGoalId: "parent-one",
    ordinaryGoal,
    failurePolicy: "continue-independent",
    workItems: [
      { workItemId: "discover", dependencies: [], goal: goal("discover"), routes: [route("discover")] },
      { workItemId: "execute", dependencies: ["discover"], goal: goal("execute"), routes: [route("execute")] },
      { workItemId: "independent", dependencies: [], goal: goal("independent"), routes: [route("independent")] },
    ],
  };
}

function build(runnerStatus: (workItemId: string) => "completed" | "handoff") {
  const mode = "experimental-trusted-tool-actions" as const;
  const runner: CapabilityModeRunner = {
    descriptor: descriptor(mode),
    async run(envelope) {
      const workItemId = envelope.request.requestId.replace("request-", "");
      const status = runnerStatus(workItemId);
      return {
        capabilityMode: mode,
        status,
        parentResumed: status === "completed",
        parentCompleted: status === "completed",
        summary: status === "completed" ? `${workItemId} completed.` : `${workItemId} needs exact authority.`,
      };
    },
  };
  expect(familyByMode[mode]).toBe("trusted-tool-code");
  const leaf = new UniversalCapabilityCoordinator(new CapabilityModeRouter([runner]), { now: () => "2026-08-05T00:00:00.000Z" });
  return new UniversalCompositionCoordinator(leaf, () => "2026-08-05T00:00:01.000Z");
}

function verifier(outcome: { passed: boolean; incorrectSideEffects: number } = { passed: true, incorrectSideEffects: 0 }): UniversalCompositionVerifier {
  return {
    key: "aggregate-verifier",
    sourceId: "independent-customer-state",
    kind: "independent-external-state",
    async verify({ leafReceipts }) {
      return { ...outcome, stateDigest: hash, detail: `Verified ${leafReceipts.length} leaf outcomes.` };
    },
  };
}

describe("universal multi-capability composition", () => {
  it("executes a bounded dependency graph and completes only after the aggregate verifier passes", async () => {
    const result = await build(() => "completed").resolve(plan(), verifier());
    expect(result).toMatchObject({
      status: "autonomous-completion",
      parentResumed: true,
      parentCompleted: true,
      aggregateOutcome: { passed: true, incorrectSideEffects: 0 },
    });
    expect(result.leafReceipts.map((item) => item.workItemId)).toEqual(["discover", "execute", "independent"]);
    expect(result.leafReceipts.every((item) => item.status === "autonomous-completion")).toBe(true);
  });

  it("continues independent work but never runs a dependent leaf after an exact handoff", async () => {
    const result = await build((workItemId) => workItemId === "discover" ? "handoff" : "completed").resolve(plan(), verifier());
    expect(result).toMatchObject({ status: "precise-handoff", parentResumed: false, parentCompleted: false });
    expect(result.leafReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ workItemId: "discover", status: "precise-handoff" }),
      expect.objectContaining({ workItemId: "execute", status: "skipped-dependency" }),
      expect.objectContaining({ workItemId: "independent", status: "autonomous-completion" }),
    ]));
  });

  it("refuses parent completion when the cross-system outcome fails and calls quarantine", async () => {
    const quarantined: string[] = [];
    const aggregate = verifier({ passed: false, incorrectSideEffects: 1 });
    aggregate.quarantine = async ({ bundles }) => { quarantined.push(...bundles.map((item) => item.capabilityId)); };
    const result = await build(() => "completed").resolve(plan(), aggregate);
    expect(result).toMatchObject({ status: "unresolved-safe", parentResumed: false, parentCompleted: false });
    expect(quarantined).toHaveLength(3);
  });

  it("rejects cycles, unknown dependencies and changed parent identity before execution", async () => {
    const cyclic = plan();
    cyclic.workItems[0]!.dependencies = ["execute"];
    await expect(build(() => "completed").resolve(cyclic, verifier())).rejects.toThrow(/cycle/);

    const unknown = plan();
    unknown.workItems[1]!.dependencies = ["missing"];
    await expect(build(() => "completed").resolve(unknown, verifier())).rejects.toThrow(/unknown dependency/);

    const changed = plan();
    changed.workItems[0]!.goal.ordinaryGoal = "A different goal.";
    await expect(build(() => "completed").resolve(changed, verifier())).rejects.toThrow(/immutable parent-goal identity/);
  });
});
