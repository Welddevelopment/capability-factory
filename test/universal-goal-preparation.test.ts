import { describe, expect, it } from "vitest";
import type { CapabilityMode } from "../src/product/capability-mode-contract.js";
import { CapabilityModeRouter, type CapabilityModeRunner } from "../src/product/capability-mode-router.js";
import { UniversalCapabilityCoordinator } from "../src/product/universal-capability-coordinator.js";
import {
  TrustedUniversalGoalPreparer,
  UniversalGoalPreparationError,
  type TrustedUniversalScope,
  type UniversalWorkflowPlanner,
} from "../src/product/universal-goal-preparation.js";
import { createCapabilitySidecar } from "../src/product/sidecar.js";
import type { PreparedCapabilityRoute } from "../src/product/universal-capability-coordinator.js";
import type { CapabilityBundle } from "../src/product/universal-capability-contract.js";

const digest = "b".repeat(64);
const ordinaryGoal = "Create the approved record in the unfamiliar customer portal and verify that it exists.";

function route(): PreparedCapabilityRoute {
  const bundle: CapabilityBundle = {
    schemaVersion: "1.0",
    capabilityId: "browser-portal-capability",
    tenantId: "tenant-one",
    needKey: "submit-customer-record",
    summary: "Submit one approved customer record.",
    source: "built-manifest",
    runtime: { family: "browser-web", driverId: "browser-driver", driverVersion: "1.0.0", executionBoundary: "customer-local" },
    manifest: { mediaType: "application/json", digest, reference: "browser-manifest", generated: true },
    authority: { targetAliases: ["customer-portal"], secretAliases: ["portal-session"], approvalKeys: ["submit-record"], risk: "consequential-write" },
    verification: { preUseVerifierKey: "browser-probe", outcomeVerifierKey: "portal-record-verifier", observationSource: "portal-admin-api", independentFromExecution: true, contractHash: digest },
    recovery: { operationKey: "submit-record-one", idempotency: "required", reconcileBeforeRetry: true, blindRetryAllowed: false, quarantineOn: ["verification-failure", "incorrect-outcome", "unknown-outcome"] },
    provenance: { trustedSourceIds: ["portal-ui-contract"], sourceHashes: [digest], builderVersion: "builder-one", builtAt: "2026-08-05T00:00:00.000Z" },
    retention: { version: 1, reusable: true, scopeDigest: digest },
  };
  return {
    routeId: "portal-browser-route",
    family: "browser-web",
    envelope: {
      schemaVersion: "1.0",
      capabilityMode: "experimental-browser-actions",
      request: {
        tenantId: "tenant-one",
        requestId: "request-one",
        parentGoalId: "goal-one",
        ordinaryGoal,
        needKey: "submit-customer-record",
        uiContractHash: digest,
        operationKey: "submit-record-one",
        input: { recordId: "record-one" },
        approvals: ["submit-record"],
      },
    },
    bundle,
    supportedActions: ["submit-record"],
    targetAliases: ["customer-portal"],
    observationKeys: ["portal-admin-api"],
    requiredSecretAliases: ["portal-session"],
    requiredApprovalKeys: ["submit-record"],
    priority: 1,
  };
}

function scope(): TrustedUniversalScope {
  return {
    tenantId: "tenant-one",
    scopeKey: "customer-operations",
    observations: [
      { id: "record-missing", source: "external-state", summary: "The required record is absent." },
      { id: "portal-approved", source: "customer-config", summary: "The portal target is approved for this workflow." },
    ],
    workflows: [{
      key: "submit-portal-record",
      summary: "Create one approved record in the configured customer portal.",
      requiredEvidenceIds: ["record-missing", "portal-approved"],
      gap: {
        key: "submit-customer-record",
        summary: "The agent lacks the approved portal submission ability.",
        requiredActions: ["submit-record"],
        targetAliases: ["customer-portal"],
        requiredObservationKeys: ["portal-admin-api"],
        maximumRisk: "consequential-write",
      },
      authority: {
        allowedTargetAliases: ["customer-portal"],
        allowedSecretAliases: ["portal-session"],
        allowedActions: ["submit-record"],
        grantedApprovals: ["submit-record"],
        maximumRisk: "consequential-write",
      },
      prepareRoutes: () => [route()],
    }],
  };
}

function submission() {
  return {
    schemaVersion: "1.0" as const,
    tenantId: "tenant-one",
    requestId: "request-one",
    parentGoalId: "goal-one",
    ordinaryGoal,
    scopeKey: "customer-operations",
    visibility: "summary" as const,
  };
}

function planner(value: unknown): UniversalWorkflowPlanner {
  return { async propose() { return value; } };
}

function proposal() {
  return {
    decision: "select-workflow",
    workflowKey: "submit-portal-record",
    evidenceIds: ["record-missing", "portal-approved"],
    summary: "The trusted portal workflow matches the ordinary goal.",
    confidence: "high",
  };
}

describe("trusted universal ordinary-goal preparation", () => {
  it("lets a planner select only a trusted workflow while trusted code owns the gap, authority and route", async () => {
    const preparer = new TrustedUniversalGoalPreparer({ resolve: () => scope() }, planner(proposal()));
    const prepared = await preparer.prepare(submission());
    expect(prepared).toMatchObject({
      selectedWorkflowKey: "submit-portal-record",
      goal: {
        ordinaryGoal,
        gap: { key: "submit-customer-record", requiredActions: ["submit-record"] },
        authority: { allowedTargetAliases: ["customer-portal"] },
      },
    });
    expect(prepared.routes).toHaveLength(1);
    expect(prepared.checks.every((check) => check.passed)).toBe(true);
  });

  it("rejects invented workflows, invented evidence and omitted workflow evidence", async () => {
    const cases = [
      { ...proposal(), workflowKey: "invented-workflow" },
      { ...proposal(), evidenceIds: ["invented-evidence"] },
      { ...proposal(), evidenceIds: ["record-missing"] },
    ];
    for (const candidate of cases) {
      const preparer = new TrustedUniversalGoalPreparer({ resolve: () => scope() }, planner(candidate));
      await expect(preparer.prepare(submission())).rejects.toBeInstanceOf(UniversalGoalPreparationError);
    }
  });

  it("joins ordinary-goal planning to automatic runtime selection without exposing a mode to the caller", async () => {
    const seen: CapabilityMode[] = [];
    const runner: CapabilityModeRunner = {
      descriptor: {
        capabilityMode: "experimental-browser-actions",
        label: "Browser",
        driverVersion: "browser-v1",
        maturity: "experimental-local",
        configured: true,
        claimBoundary: "Bounded local browser evidence only.",
      },
      async run(envelope) {
        seen.push(envelope.capabilityMode);
        return {
          capabilityMode: envelope.capabilityMode,
          status: "completed",
          parentResumed: true,
          parentCompleted: true,
          summary: "The portal record exists and the original goal completed.",
          capabilityId: "browser-portal-capability",
        };
      },
    };
    const coordinator = new UniversalCapabilityCoordinator(new CapabilityModeRouter([runner]));
    const preparer = new TrustedUniversalGoalPreparer({ resolve: () => scope() }, planner(proposal()));
    const app = createCapabilitySidecar(undefined, { resolve: () => undefined }, {
      accessToken: "universal-planner-token",
      universalCapabilities: { coordinator, prepare: (value) => preparer.prepare(value) },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/universal-goals",
        headers: { "x-capability-sidecar-token": "universal-planner-token" },
        payload: submission(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "autonomous-completion", selectedFamily: "browser-web" });
      expect(seen).toEqual(["experimental-browser-actions"]);
    } finally {
      await app.close();
    }
  });
});

