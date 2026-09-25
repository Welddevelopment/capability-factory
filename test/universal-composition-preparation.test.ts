import { describe, expect, it } from "vitest";
import type { CapabilityBundle, UniversalGoalSubmission } from "../src/product/universal-capability-contract.js";
import { CapabilityModeRouter, type CapabilityModeRunner } from "../src/product/capability-mode-router.js";
import { UniversalCapabilityCoordinator, type PreparedCapabilityRoute } from "../src/product/universal-capability-coordinator.js";
import {
  TrustedUniversalCompositionPreparer,
  UniversalCompositionPreparationError,
  type TrustedUniversalCompositionScope,
  type UniversalCompositionPlanner,
} from "../src/product/universal-composition-preparation.js";
import { UniversalCompositionCoordinator } from "../src/product/universal-composition.js";
import { createCapabilitySidecar } from "../src/product/sidecar.js";
import { CapabilityFactorySidecarClient } from "../src/product/client.js";

const digest = "d".repeat(64);
const ordinaryGoal = "Calculate the approved quantity, persist the result, and prove the combined external outcome.";

function submission(): UniversalGoalSubmission {
  return {
    schemaVersion: "1.0",
    tenantId: "tenant-one",
    requestId: "request-parent",
    parentGoalId: "goal-parent",
    ordinaryGoal,
    scopeKey: "trusted-multi-system-scope",
    visibility: "summary",
  };
}

function route(input: {
  workItemId: string;
  leafRequestId: string;
  action: string;
  target: string;
  observation: string;
  approval: string;
}): PreparedCapabilityRoute {
  const needKey = `need-${input.workItemId}`;
  const bundle: CapabilityBundle = {
    schemaVersion: "1.0",
    capabilityId: `capability-${input.workItemId}`,
    tenantId: "tenant-one",
    needKey,
    summary: `Trusted capability for ${input.workItemId}.`,
    source: "trusted-existing",
    runtime: { family: "trusted-tool-code", driverId: "trusted-tool-driver", driverVersion: "1.0.0", executionBoundary: "isolated-sandbox" },
    manifest: { mediaType: "application/wasm", digest, reference: `manifest-${input.workItemId}`, generated: false },
    authority: { targetAliases: [input.target], secretAliases: [], approvalKeys: [input.approval], risk: "read-only" },
    verification: { preUseVerifierKey: `probe-${input.workItemId}`, outcomeVerifierKey: `outcome-${input.workItemId}`, observationSource: input.observation, independentFromExecution: true, contractHash: digest },
    recovery: { operationKey: `operation-${input.workItemId}`, idempotency: "not-applicable", reconcileBeforeRetry: true, blindRetryAllowed: false, quarantineOn: ["verification-failure", "incorrect-outcome", "unknown-outcome"] },
    provenance: { trustedSourceIds: ["trusted-scope"], sourceHashes: [digest], builderVersion: "builder-one", builtAt: "2026-08-05T00:00:00.000Z" },
    retention: { version: 1, reusable: true, scopeDigest: digest },
  };
  return {
    routeId: `route-${input.workItemId}`,
    family: "trusted-tool-code",
    envelope: {
      schemaVersion: "1.0",
      capabilityMode: "experimental-trusted-tool-actions",
      request: {
        tenantId: "tenant-one",
        requestId: input.leafRequestId,
        parentGoalId: "goal-parent",
        ordinaryGoal,
        needKey,
        contractHash: digest,
        operationKey: `operation-${input.workItemId}`,
        toolId: `tool-${input.workItemId}`,
        toolVersion: "1.0.0",
        values: [1, 2],
        approvals: [input.approval],
      },
    },
    bundle,
    supportedActions: [input.action],
    targetAliases: [input.target],
    observationKeys: [input.observation],
    requiredSecretAliases: [],
    requiredApprovalKeys: [input.approval],
    priority: 1,
  };
}

function scope(): TrustedUniversalCompositionScope {
  const definition = (workItemId: string, dependencies: string[]) => ({
    workItemId,
    dependencies,
    gap: {
      key: `need-${workItemId}`,
      summary: `A trusted ability is needed for ${workItemId}.`,
      requiredActions: [`action-${workItemId}`],
      targetAliases: [`target-${workItemId}`],
      requiredObservationKeys: [`observation-${workItemId}`],
      maximumRisk: "read-only" as const,
    },
    authority: {
      allowedTargetAliases: [`target-${workItemId}`],
      allowedSecretAliases: [],
      allowedActions: [`action-${workItemId}`],
      grantedApprovals: [`approve-${workItemId}`],
      maximumRisk: "read-only" as const,
    },
    prepareRoutes: ({ leafRequestId }: { leafRequestId: string }) => [route({
      workItemId,
      leafRequestId,
      action: `action-${workItemId}`,
      target: `target-${workItemId}`,
      observation: `observation-${workItemId}`,
      approval: `approve-${workItemId}`,
    })],
  });
  return {
    tenantId: "tenant-one",
    scopeKey: "trusted-multi-system-scope",
    observations: [
      { id: "shortfall-observed", source: "external-state", summary: "The fictional item is below its trusted threshold." },
      { id: "write-approved", source: "customer-config", summary: "The exact bounded write is approved." },
    ],
    compositions: [{
      key: "calculate-and-persist",
      summary: "Calculate an approved result and persist it through separate capabilities.",
      requiredEvidenceIds: ["shortfall-observed", "write-approved"],
      failurePolicy: "stop-all",
      workItems: [definition("calculate", []), definition("persist", ["calculate"])],
      verifier: {
        key: "aggregate-outcome",
        sourceId: "independent-external-state",
        kind: "independent-external-state",
        async verify({ leafReceipts }) {
          return { passed: leafReceipts.length === 2, incorrectSideEffects: 0, stateDigest: digest, detail: "Both externally verified leaves are present." };
        },
      },
    }],
  };
}

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    decision: "select-composition",
    compositionKey: "calculate-and-persist",
    evidenceIds: ["shortfall-observed", "write-approved"],
    summary: "The trusted composition matches the broad ordinary goal.",
    confidence: "high",
    ...overrides,
  };
}

function planner(value: unknown): UniversalCompositionPlanner {
  return { async propose() { return value; } };
}

describe("trusted universal composition preparation", () => {
  it("lets planning select only a trusted DAG while trusted code owns every gap, authority, route and aggregate verifier", async () => {
    const prepared = await new TrustedUniversalCompositionPreparer({ resolve: () => scope() }, planner(proposal())).prepare(submission());
    expect(prepared).toMatchObject({
      selectedCompositionKey: "calculate-and-persist",
      plan: { failurePolicy: "stop-all", ordinaryGoal },
      verifier: { key: "aggregate-outcome", kind: "independent-external-state" },
    });
    expect(prepared.plan.workItems.map((item) => ({ id: item.workItemId, dependencies: item.dependencies }))).toEqual([
      { id: "calculate", dependencies: [] },
      { id: "persist", dependencies: ["calculate"] },
    ]);
    expect(prepared.plan.workItems.every((item) => item.routes[0]?.envelope.request.requestId === item.goal.requestId)).toBe(true);
    expect(prepared.checks.every((check) => check.passed)).toBe(true);
  });

  it("rejects invented compositions, invented observations and omitted required evidence", async () => {
    for (const candidate of [
      proposal({ compositionKey: "invented-composition" }),
      proposal({ evidenceIds: ["invented-observation"] }),
      proposal({ evidenceIds: ["shortfall-observed"] }),
    ]) {
      await expect(new TrustedUniversalCompositionPreparer({ resolve: () => scope() }, planner(candidate)).prepare(submission()))
        .rejects.toBeInstanceOf(UniversalCompositionPreparationError);
    }
  });

  it("accepts one ordinary goal at the authenticated sidecar and returns only after leaf and aggregate verification", async () => {
    const runner: CapabilityModeRunner = {
      descriptor: {
        capabilityMode: "experimental-trusted-tool-actions",
        label: "Trusted tool",
        driverVersion: "1.0.0",
        maturity: "experimental-local",
        configured: true,
        claimBoundary: "Local composition-preparation test boundary.",
      },
      async run(envelope) {
        return {
          capabilityMode: envelope.capabilityMode,
          status: "completed",
          parentResumed: true,
          parentCompleted: true,
          summary: "The bounded leaf result passed its independent verifier.",
        };
      },
    };
    const leaf = new UniversalCapabilityCoordinator(new CapabilityModeRouter([runner]));
    const coordinator = new UniversalCompositionCoordinator(leaf);
    const preparer = new TrustedUniversalCompositionPreparer({ resolve: () => scope() }, planner(proposal()));
    const app = createCapabilitySidecar(undefined, { resolve: () => undefined }, {
      accessToken: "universal-composition-token",
      universalCompositions: { coordinator, prepare: (value) => preparer.prepare(value) },
    });
    try {
      const unauthorized = await app.inject({ method: "POST", url: "/v1/universal-compositions", payload: submission() });
      expect(unauthorized.statusCode).toBe(401);
      const response = await app.inject({
        method: "POST",
        url: "/v1/universal-compositions",
        headers: { "x-capability-sidecar-token": "universal-composition-token" },
        payload: submission(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: "autonomous-completion",
        parentResumed: true,
        parentCompleted: true,
        aggregateOutcome: { passed: true, incorrectSideEffects: 0 },
      });
      const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
      const throughClient = await new CapabilityFactorySidecarClient({
        baseUrl,
        accessToken: "universal-composition-token",
      }).completeUniversalComposition(submission());
      expect(throughClient).toMatchObject({ status: "autonomous-completion", parentCompleted: true });
    } finally {
      await app.close();
    }
  });
});
