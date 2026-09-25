import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewedInventoryDatabaseAdapter } from "../src/customer-world/reviewed-database-world.js";
import { DatabaseCapabilityRegistry, ExperimentalDatabaseCapabilitySdk } from "../src/experimental/database-capability-sdk.js";

describe("genuine disposable SQLite reviewed-database route", () => {
  it("builds, verifies, writes once, reconciles a lost response and reuses without arbitrary SQL", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-reviewed-database-"));
    const adapter = new ReviewedInventoryDatabaseAdapter(join(directory, "customer.sqlite"));
    const registry = new DatabaseCapabilityRegistry();
    try {
      const base = {
        tenantId: "tenant-one",
        parentGoalId: "goal-one",
        ordinaryGoal: "Create one approved restock draft for the short item and verify the database result.",
        needKey: "create-restock-draft",
        contractHash: adapter.contract.schemaHash,
        input: { sku: "widget-one", quantity: "4" },
        approvals: ["create-approved-draft"],
      };
      const first = await new ExperimentalDatabaseCapabilitySdk(registry, adapter).completeGoal({
        ...base,
        requestId: "request-one",
        operationKey: "operation-one",
        simulateLostResponseAfterCommit: true,
      });
      expect(first).toMatchObject({ status: "completed", path: "built-capability", outcome: { passed: true, incorrectSideEffects: 0 } });
      expect(adapter.countDrafts()).toBe(1);

      const reuse = await new ExperimentalDatabaseCapabilitySdk(registry, adapter).completeGoal({
        ...base,
        requestId: "request-two",
        parentGoalId: "goal-two",
        operationKey: "operation-two",
      });
      expect(reuse).toMatchObject({ status: "completed", path: "retained-reuse", outcome: { passed: true, incorrectSideEffects: 0 } });
      expect(adapter.countDrafts()).toBe(2);
    } finally {
      adapter.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reuses a verified database capability after a fresh registry process opens durable state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-reviewed-database-registry-"));
    const adapter = new ReviewedInventoryDatabaseAdapter(join(directory, "customer.sqlite"));
    const registryPath = join(directory, "capability-registry.sqlite");
    const firstRegistry = new DatabaseCapabilityRegistry(registryPath);
    const base = {
      tenantId: "tenant-one",
      parentGoalId: "goal-one",
      ordinaryGoal: "Create one approved restock draft and verify it.",
      needKey: "create-restock-draft",
      contractHash: adapter.contract.schemaHash,
      input: { sku: "widget-one", quantity: "4" },
      approvals: ["create-approved-draft"],
    };
    try {
      const first = await new ExperimentalDatabaseCapabilitySdk(firstRegistry, adapter).completeGoal({
        ...base, requestId: "request-one", operationKey: "operation-one",
      });
      expect(first).toMatchObject({ status: "completed", path: "built-capability" });
      firstRegistry.close();

      const reopened = new DatabaseCapabilityRegistry(registryPath);
      try {
        const second = await new ExperimentalDatabaseCapabilitySdk(reopened, adapter).completeGoal({
          ...base, requestId: "request-two", parentGoalId: "goal-two", operationKey: "operation-two",
        });
        expect(second).toMatchObject({ status: "completed", path: "retained-reuse" });
      } finally {
        reopened.close();
      }
    } finally {
      adapter.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
