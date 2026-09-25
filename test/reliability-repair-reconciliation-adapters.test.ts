import { describe, expect, it } from "vitest";
import {
  isExpectedLostResponseIntermediate,
  LostResponseReconciliationAdapter,
} from "../src/customer-world/reliability-reconciliation-adapter.js";
import { StructuredRepairAdapter } from "../src/customer-world/reliability-repair-adapter.js";

describe("repair and reconciliation reliability adapters", () => {
  it("binds versioned R4 and R5 cases", () => {
    expect(new StructuredRepairAdapter()).toMatchObject({
      id: "R4",
      version: "structured-repair-reliability-adapter-v1",
    });
    expect(new LostResponseReconciliationAdapter()).toMatchObject({
      id: "R5",
      version: "lost-response-reconciliation-adapter-v1",
    });
  });

  it("precommits the structured fault, repair bound, retained dependency, and reconciliation order", () => {
    for (const adapter of [new StructuredRepairAdapter(), new LostResponseReconciliationAdapter()]) {
      const checks = adapter.preflight();
      expect(checks).toHaveLength(2);
      expect(checks.every((check) => check.passed)).toBe(true);
    }
  });

  it("accepts only the exact interrupted state expected after a lost create response", () => {
    const expectedIssues = Array.from({ length: 5 }, (_, index) => ({
      code: "wrong-field" as const,
      message: `Expected field ${index} has not yet been updated.`,
    }));
    expect(isExpectedLostResponseIntermediate({
      caseId: "lost-response-retry",
      passed: false,
      intendedWrites: 1,
      incorrectSideEffects: 5,
      stateHash: "partial",
      issues: expectedIssues,
    })).toBe(true);
    expect(isExpectedLostResponseIntermediate({
      caseId: "lost-response-retry",
      passed: false,
      intendedWrites: 1,
      incorrectSideEffects: 1,
      stateHash: "unsafe",
      issues: [{ code: "forbidden-write", message: "Another order changed." }],
    })).toBe(false);
  });
});
