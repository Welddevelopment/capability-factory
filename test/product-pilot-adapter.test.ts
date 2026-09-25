import { describe, expect, it } from "vitest";
import type { BroadGoalRequest } from "../src/product/broad-goal-sdk.js";
import {
  PILOT_ADAPTER_SCHEMA_VERSION,
  REQUIRED_PILOT_ADAPTER_CASES,
  createControlledPilotSdk,
  preflightControlledPilotAdapter,
  runPilotAdapterAcceptance,
  validatePilotAdapterAcceptanceHarness,
  type ControlledPilotAdapter,
  type PilotAdapterDescriptor,
} from "../src/product/pilot-adapter.js";
import { CURRENT_CAPABILITY_MODE } from "../src/product/pilot-readiness.js";

function descriptor(): PilotAdapterDescriptor {
  return {
    schemaVersion: PILOT_ADAPTER_SCHEMA_VERSION,
    adapterId: "example-pilot-adapter",
    adapterVersion: "1.0.0",
    capabilityMode: CURRENT_CAPABILITY_MODE,
    environmentId: "customer-sandbox",
    scopeKeys: ["approved-order-workflow"],
    workflowKeys: ["create-approved-order"],
    targetAliases: ["customer_erp"],
    credentialAliases: ["customer_erp_writer"],
    documentation: [{ targetAlias: "customer_erp", sha256: "a".repeat(64) }],
    operations: [
      { name: "read_order", targetAlias: "customer_erp", method: "GET", consequence: "read", retrySafety: "not-applicable", outcomeVerifierKey: "order_state_verifier" },
      { name: "create_order", targetAlias: "customer_erp", method: "POST", consequence: "write", retrySafety: "reconcile-before-retry", outcomeVerifierKey: "order_state_verifier" },
    ],
    acceptanceCases: [...REQUIRED_PILOT_ADAPTER_CASES],
    dataBoundary: {
      execution: "customer-local",
      credentials: "customer-local-alias-only",
      externalVerification: "customer-local-independent",
    },
  };
}

function adapter(overrides: Partial<PilotAdapterDescriptor> = {}): ControlledPilotAdapter {
  return {
    descriptor: { ...descriptor(), ...overrides },
    scopes: { resolve: async () => undefined },
    runtimes: { open: async () => undefined },
    preflight: async () => [{ id: "local-runtime", passed: true, detail: "The local runtime is available." }],
  };
}

describe("controlled pilot adapter kit", () => {
  it("accepts a complete alias-only adapter and connects it to the shared SDK", async () => {
    const candidate = adapter();
    const checks = await preflightControlledPilotAdapter(candidate);
    expect(checks.every((item) => item.passed)).toBe(true);
    const sdk = await createControlledPilotSdk(candidate, {
      planner: { propose: async () => { throw new Error("not used"); } },
      plans: { load: () => null, save: (record) => record },
    });
    const result = await sdk.completeGoal({
      schemaVersion: "1.0",
      tenantId: "tenant-a",
      parentGoalId: "goal-a",
      requestId: "request-a",
      scopeKey: "approved-order-workflow",
      ordinaryGoal: "Create the approved order.",
      visibility: "summary",
    } satisfies BroadGoalRequest);
    expect(result).toMatchObject({ status: "handoff", handoff: { reason: "scope-unavailable", writesAttempted: 0 } });
  });

  it("rejects incomplete acceptance coverage and unsafe write retry semantics", async () => {
    const candidate = adapter({
      acceptanceCases: ["approved-write"],
      operations: [{
        name: "create_order",
        targetAlias: "customer_erp",
        method: "POST",
        consequence: "write",
        retrySafety: "not-applicable",
        outcomeVerifierKey: "order_state_verifier",
      }],
    });
    const failed = (await preflightControlledPilotAdapter(candidate)).filter((item) => !item.passed).map((item) => item.id);
    expect(failed).toContain("acceptance-coverage");
    expect(failed).toContain("write-reconciliation");
  });

  it("rejects obvious credential values in the descriptor", async () => {
    const candidate = adapter({ credentialAliases: ["Bearer abc123456789"] });
    const failed = (await preflightControlledPilotAdapter(candidate)).filter((item) => !item.passed).map((item) => item.id);
    expect(failed).toContain("credential-aliases");
    expect(failed).toContain("no-obvious-secret-values");
  });

  it("requires executable evidence for every declared acceptance case", async () => {
    const candidate = adapter();
    expect(validatePilotAdapterAcceptanceHarness(candidate.acceptance)[0]).toMatchObject({ passed: false });
    candidate.acceptance = {
      caseIds: [...REQUIRED_PILOT_ADAPTER_CASES],
      run: async (caseId) => ({
        caseId,
        passed: true,
        intendedWrites: caseId === "approved-write" ? 1 : 0,
        incorrectSideEffects: 0,
        checks: [{ id: `check-${caseId}`, passed: true, detail: "The precommitted condition passed." }],
        artifactReferences: [`artifact://${caseId}`],
        completedAt: "2026-07-27T00:00:00.000Z",
      }),
    };
    const summary = await runPilotAdapterAcceptance(candidate);
    expect(summary).toMatchObject({ passed: true, completedCases: 10, incorrectSideEffects: 0, notRunCases: [] });
  });

  it("stops the acceptance campaign on a surviving incorrect side effect", async () => {
    const candidate = adapter();
    candidate.acceptance = {
      caseIds: [...REQUIRED_PILOT_ADAPTER_CASES],
      run: async (caseId) => ({
        caseId,
        passed: false,
        intendedWrites: 0,
        incorrectSideEffects: 1,
        checks: [{ id: "direct-state", passed: false, detail: "An incorrect side effect remained." }],
        artifactReferences: ["artifact://unsafe-state"],
        completedAt: "2026-07-27T00:00:00.000Z",
      }),
    };
    const summary = await runPilotAdapterAcceptance(candidate);
    expect(summary).toMatchObject({
      passed: false,
      abortedForSafety: true,
      completedCases: 1,
      incorrectSideEffects: 1,
    });
    expect(summary.notRunCases).toHaveLength(9);
  });
});
