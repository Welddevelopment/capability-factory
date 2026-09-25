import { describe, expect, it } from "vitest";
import {
  GoalPlanCompiler,
  GOAL_COORDINATION_SCHEMA_VERSION,
  goalPlanProposalSchema,
  type GoalPlanProposal,
  type GoalPlanner,
  type TrustedGoalScope,
  validateGoalPlan,
} from "../src/product/goal-coordination.js";

function scope(writeAuthority: TrustedGoalScope["authority"]["writeAuthority"] = "preauthorized"): TrustedGoalScope {
  return {
    tenantId: "tenant-a",
    parentGoalId: "parent-goal-a",
    requestId: "request-a",
    ordinaryGoal: "Complete every due order and restock every item with insufficient stock.",
    deadline: { key: "today-2100", description: "Today at 21:00 local business time." },
    entities: [
      { alias: "order_1048", kind: "order", systemAliases: ["orders"] },
      { alias: "sku_crate", kind: "inventory-item", systemAliases: ["supplier_east"] },
    ],
    systems: [
      {
        targetAlias: "orders",
        credentialAliases: ["orders_key"],
        operations: [
          { name: "read_order", method: "GET" },
          { name: "update_order", method: "PUT", requiredCompanionActions: ["read_order"] },
        ],
      },
      {
        targetAlias: "supplier_east",
        credentialAliases: ["east_key"],
        operations: [
          { name: "read_stock", method: "GET" },
          { name: "find_restock", method: "GET" },
          {
            name: "create_restock",
            method: "POST",
            requiredCompanionActions: ["read_stock", "find_restock"],
          },
        ],
      },
    ],
    completionCriteria: [
      { key: "order-details-complete", summary: "The exact order has all required details.", verifierKey: "order-direct-v1" },
      { key: "restock-exists-once", summary: "Exactly one compatible restock exists.", verifierKey: "supplier-direct-v1" },
    ],
    requiredCoverage: [
      {
        key: "restock-crate",
        entityAliases: ["sku_crate"],
        workflowKey: "restock-east",
        requiredActions: ["read_stock", "find_restock", "create_restock"],
        targetAliases: ["supplier_east"],
        completionCriterionKeys: ["restock-exists-once"],
      },
      {
        key: "finalize-order-1048",
        entityAliases: ["order_1048"],
        workflowKey: "complete-order-details",
        requiredActions: ["read_order", "update_order"],
        targetAliases: ["orders"],
        completionCriterionKeys: ["order-details-complete"],
        dependsOnCoverageKeys: ["restock-crate"],
      },
    ],
    authority: {
      allowedTargetAliases: ["orders", "supplier_east"],
      allowedSecretAliases: ["orders_key", "east_key"],
      allowedMethods: ["GET", "POST", "PUT"],
      writeAuthority,
      approvedWriteActions: [],
    },
  };
}

function proposal(): GoalPlanProposal {
  return {
    schemaVersion: GOAL_COORDINATION_SCHEMA_VERSION,
    deadlineKey: "today-2100",
    summary: "Restock the missing crate, then finalize the dependent order.",
    workItems: [
      {
        key: "finalize-order",
        groupKey: "orders",
        groupLabel: "Finalize orders",
        summary: "Complete the exact order after stock is verified.",
        coverageKeys: ["finalize-order-1048"],
        entityAliases: ["order_1048"],
        workflowKey: "complete-order-details",
        requiredActions: ["read_order", "update_order"],
        targetAliases: ["orders"],
        completionCriterionKeys: ["order-details-complete"],
        dependsOnKeys: ["restock-crate"],
      },
      {
        key: "restock-crate",
        groupKey: "supplier-east",
        groupLabel: "East supplier restock",
        summary: "Create one safely reconciled restock for the missing crate.",
        coverageKeys: ["restock-crate"],
        entityAliases: ["sku_crate"],
        workflowKey: "restock-east",
        requiredActions: ["read_stock", "find_restock", "create_restock"],
        targetAliases: ["supplier_east"],
        completionCriterionKeys: ["restock-exists-once"],
        dependsOnKeys: [],
      },
    ],
  };
}

describe("trusted broad-goal plan validation", () => {
  it("derives stable identities and conservative dependency order from a complete trusted plan", () => {
    const first = validateGoalPlan(proposal(), scope());
    const second = validateGoalPlan(proposal(), scope());
    expect(first.status).toBe("validated");
    expect(second.status).toBe("validated");
    if (first.status !== "validated" || second.status !== "validated") return;
    expect(first.plan.executionMode).toBe("conservative-sequential");
    expect(first.plan.workItems.map((item) => item.key)).toEqual(["restock-crate", "finalize-order"]);
    expect(first.plan.workItems.map((item) => item.executionOrder)).toEqual([1, 2]);
    expect(first.plan.workItems[1]!.dependencyWorkItemIds).toEqual([first.plan.workItems[0]!.workItemId]);
    expect(second.plan.workItems).toEqual(first.plan.workItems);
    expect(second.plan.validationReceiptId).toBe(first.plan.validationReceiptId);
  });

  it("rejects omitted or duplicate trusted coverage", () => {
    const missing = proposal();
    missing.workItems = missing.workItems.slice(0, 1);
    const result = validateGoalPlan(missing, scope());
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.checks.find((check) => check.id === "complete-coverage")?.passed).toBe(false);
    }
  });

  it("rejects invented actions and missing safety companion reads", () => {
    const invented = proposal();
    invented.workItems[1]!.requiredActions = ["create_restock", "delete_supplier_account"];
    const result = validateGoalPlan(invented, scope());
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.checks.find((check) => check.id === "item:restock-crate:documented-actions")?.passed).toBe(false);
      expect(result.checks.find((check) => check.id === "item:restock-crate:companion-actions")?.passed).toBe(false);
    }
  });

  it("rejects dependency cycles and removal of trusted ordering", () => {
    const cyclic = proposal();
    cyclic.workItems[1]!.dependsOnKeys = ["finalize-order"];
    const result = validateGoalPlan(cyclic, scope());
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.checks.find((check) => check.id === "acyclic-dependencies")?.passed).toBe(false);
    }

    const reordered = proposal();
    reordered.workItems[0]!.dependsOnKeys = [];
    const missingTrustedDependency = validateGoalPlan(reordered, scope());
    expect(missingTrustedDependency.status).toBe("rejected");
    if (missingTrustedDependency.status === "rejected") {
      expect(
        missingTrustedDependency.checks.find(
          (check) => check.id === "coverage:finalize-order-1048:trusted-dependencies",
        )?.passed,
      ).toBe(false);
    }
  });

  it("preserves a valid plan but derives a write-authority handoff requirement from trusted policy", () => {
    const result = validateGoalPlan(proposal(), scope("denied"));
    expect(result.status).toBe("validated");
    if (result.status !== "validated") return;
    expect(result.plan.workItems.every((item) => item.authority.currentlyAuthorized === false)).toBe(true);
    expect(result.plan.workItems.every((item) => item.authority.missing.includes("write-authority"))).toBe(true);
  });

  it("rejects planner attempts to smuggle authority or credentials into the structured proposal", () => {
    const unsafe = {
      ...proposal(),
      authority: { writeAuthority: "preauthorized" },
      credentialAliases: ["invented_secret"],
    };
    expect(() => goalPlanProposalSchema.parse(unsafe)).toThrow();
  });

  it("allows one bounded repair but activates only the trusted validator result", async () => {
    let calls = 0;
    const planner: GoalPlanner = {
      propose: async (_trustedScope, repair) => {
        calls += 1;
        if (!repair) {
          const incomplete = proposal();
          incomplete.workItems = incomplete.workItems.slice(0, 1);
          return incomplete;
        }
        expect(repair.failedChecks.some((check) => check.id === "complete-coverage")).toBe(true);
        return proposal();
      },
    };
    const compiled = await new GoalPlanCompiler(planner, 2).compile(scope());
    expect(compiled.status).toBe("validated");
    expect(compiled.attempts).toBe(2);
    expect(calls).toBe(2);
  });

  it("returns a rejected receipt after the bounded repair budget is exhausted", async () => {
    const planner: GoalPlanner = {
      propose: async () => {
        const incomplete = proposal();
        incomplete.workItems = incomplete.workItems.slice(0, 1);
        return incomplete;
      },
    };
    const compiled = await new GoalPlanCompiler(planner, 2).compile(scope());
    expect(compiled.status).toBe("rejected");
    expect(compiled.attempts).toBe(2);
    if (compiled.status === "rejected") {
      expect(compiled.checks.some((check) => check.id === "complete-coverage" && !check.passed)).toBe(true);
    }
  });
});
