import { describe, expect, it } from "vitest";
import {
  DatabaseCapabilityRegistry,
  ExperimentalDatabaseCapabilitySdk,
  type DatabaseCapabilityAdapter,
  type DatabaseCapabilityManifest,
} from "../src/experimental/database-capability-sdk.js";
import { CapabilityModeRouter, createDatabaseModeRunner } from "../src/product/capability-mode-router.js";

const hash = "c".repeat(64);

function request(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: "tenant-one",
    requestId: "request-one",
    parentGoalId: "goal-one",
    ordinaryGoal: "Create the approved replenishment draft and verify the database outcome.",
    needKey: "create-replenishment-draft",
    contractHash: hash,
    operationKey: "restock-widget-one",
    input: { sku: "widget-one", quantity: "4" },
    approvals: ["create-approved-draft"],
    ...overrides,
  };
}

class FakeReviewedDatabaseAdapter implements DatabaseCapabilityAdapter {
  readonly contract = {
    schemaVersion: "1.0" as const,
    targetAlias: "inventory-database",
    procedureKey: "create-replenishment-draft",
    schemaHash: hash,
    requiredInputKeys: ["sku", "quantity"],
    approvalKey: "create-approved-draft",
    preUseVerifierKey: "procedure-probe",
    outcomeVerifierKey: "independent-database-read",
  };
  readonly rows = new Map<string, { sku: string; quantity: string }>();
  probePasses = true;
  stateUnknown = false;
  wrongOutcome = false;
  executeCalls = 0;

  async probe(manifest: DatabaseCapabilityManifest): Promise<{ passed: boolean; detail: string }> {
    return {
      passed: this.probePasses
        && manifest.procedureKey === this.contract.procedureKey
        && manifest.contractHash === this.contract.schemaHash,
      detail: "The reviewed operation and schema were inspected without a write.",
    };
  }

  async reconcile(operationKey: string): Promise<"completed" | "not-started" | "unknown"> {
    if (this.stateUnknown) return "unknown";
    return this.rows.has(operationKey) ? "completed" : "not-started";
  }

  async execute(_manifest: DatabaseCapabilityManifest, operationKey: string, input: Record<string, string>): Promise<void> {
    this.executeCalls += 1;
    if (!this.rows.has(operationKey)) this.rows.set(operationKey, { sku: input.sku!, quantity: input.quantity! });
  }

  async verifyOutcome(operationKey: string, input: Record<string, string>) {
    const row = this.rows.get(operationKey);
    const passed = !this.wrongOutcome && row?.sku === input.sku && row?.quantity === input.quantity;
    return {
      passed,
      incorrectSideEffects: this.wrongOutcome ? 1 : 0,
      stateDigest: hash,
      detail: passed ? "A separate database read found exactly one intended draft." : "The independent database state did not match.",
    };
  }
}

describe("experimental reviewed-database capability mode", () => {
  it("builds, probes without a write, executes, independently verifies, resumes and retains", async () => {
    const adapter = new FakeReviewedDatabaseAdapter();
    const registry = new DatabaseCapabilityRegistry();
    const sdk = new ExperimentalDatabaseCapabilitySdk(registry, adapter);
    const first = await sdk.completeGoal(request());
    expect(first).toMatchObject({ status: "completed", path: "built-capability", parent: { resumed: true, completed: true } });
    expect(adapter.executeCalls).toBe(1);

    const second = await new ExperimentalDatabaseCapabilitySdk(registry, adapter).completeGoal(request({ requestId: "request-two", operationKey: "restock-widget-two" }));
    expect(second).toMatchObject({ status: "completed", path: "retained-reuse" });
    expect(adapter.executeCalls).toBe(2);
  });

  it("reconciles a lost response after commit without duplicating the reviewed operation", async () => {
    const adapter = new FakeReviewedDatabaseAdapter();
    const sdk = new ExperimentalDatabaseCapabilitySdk(new DatabaseCapabilityRegistry(), adapter);
    const result = await sdk.completeGoal(request({ simulateLostResponseAfterCommit: true }));
    expect(result.status).toBe("completed");
    expect(adapter.executeCalls).toBe(1);
    expect(adapter.rows).toHaveLength(1);
  });

  it("stops before a write for missing approval, changed contract or failed probe", async () => {
    for (const variant of [
      request({ approvals: [] }),
      request({ contractHash: "d".repeat(64) }),
    ]) {
      const adapter = new FakeReviewedDatabaseAdapter();
      const result = await new ExperimentalDatabaseCapabilitySdk(new DatabaseCapabilityRegistry(), adapter).completeGoal(variant);
      expect(result.status).toBe("handoff");
      expect(adapter.executeCalls).toBe(0);
    }
    const adapter = new FakeReviewedDatabaseAdapter();
    adapter.probePasses = false;
    const result = await new ExperimentalDatabaseCapabilitySdk(new DatabaseCapabilityRegistry(), adapter).completeGoal(request());
    expect(result.status).toBe("handoff");
    expect(adapter.executeCalls).toBe(0);
  });

  it("fails closed on unknown or incorrect external state", async () => {
    const unknown = new FakeReviewedDatabaseAdapter();
    unknown.stateUnknown = true;
    const unknownResult = await new ExperimentalDatabaseCapabilitySdk(new DatabaseCapabilityRegistry(), unknown).completeGoal(request());
    expect(unknownResult.status).toBe("unknown");
    expect(unknown.executeCalls).toBe(0);

    const wrong = new FakeReviewedDatabaseAdapter();
    wrong.wrongOutcome = true;
    const wrongResult = await new ExperimentalDatabaseCapabilitySdk(new DatabaseCapabilityRegistry(), wrong).completeGoal(request());
    expect(wrongResult.status).toBe("handoff");
    expect(wrong.executeCalls).toBe(1);
  });

  it("runs through the shared explicit mode router without widening other drivers", async () => {
    const adapter = new FakeReviewedDatabaseAdapter();
    const router = new CapabilityModeRouter([
      createDatabaseModeRunner(new ExperimentalDatabaseCapabilitySdk(new DatabaseCapabilityRegistry(), adapter)),
    ]);
    const result = await router.execute({
      schemaVersion: "1.0",
      capabilityMode: "experimental-database-actions",
      request: request(),
    });
    expect(result).toMatchObject({
      capabilityMode: "experimental-database-actions",
      status: "completed",
      parentResumed: true,
      parentCompleted: true,
      acquisitionPath: "built-capability",
    });
  });
});
