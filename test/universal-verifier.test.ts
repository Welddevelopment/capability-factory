import { describe, expect, it } from "vitest";
import {
  UniversalVerifierFactory,
  type TrustedOutcomeContract,
  type UniversalObservationAdapter,
} from "../src/product/universal-verifier.js";

const now = "2026-08-05T00:00:00.000Z";

function contract(): TrustedOutcomeContract {
  return {
    schemaVersion: "1.0",
    key: "approved-order-outcome",
    summary: "Exactly one approved order exists and its source is marked complete.",
    executionDriverId: "browser-driver",
    criteria: [
      { key: "order-exists", observationKey: "orders", path: [], operator: "count-equals", expected: 1 },
      { key: "source-complete", observationKey: "source", path: ["status"], operator: "equals", expected: "complete" },
      { key: "unexpected-record-absent", observationKey: "unexpected", path: ["record"], operator: "absent" },
    ],
    incorrectSideEffectObservationKey: "incorrect-side-effects",
    maximumIncorrectSideEffects: 0,
  };
}

function adapter(overrides: Partial<UniversalObservationAdapter> = {}): UniversalObservationAdapter {
  return {
    key: "admin-api-observer",
    sourceId: "independent-admin-api",
    priority: 1,
    observationKeys: ["orders", "source", "unexpected", "incorrect-side-effects"],
    independentFromDriverIds: ["browser-driver"],
    async observe() {
      return {
        orders: [{ id: "order-one" }],
        source: { status: "complete" },
        unexpected: {},
        "incorrect-side-effects": 0,
      };
    },
    ...overrides,
  };
}

const context = { tenantId: "tenant-one", requestId: "request-one", parentGoalId: "goal-one", operationKey: "operation-one" };

describe("universal independent verifier factory", () => {
  it("compiles an independently observed outcome contract and omits raw customer state from the receipt", async () => {
    const result = new UniversalVerifierFactory([adapter()], () => now).compile(contract());
    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;
    const receipt = await result.verifier.verify(context);
    expect(receipt).toMatchObject({
      passed: true,
      incorrectSideEffects: 0,
      independentFromExecution: true,
      observationSource: "independent-admin-api",
      verifiedAt: now,
    });
    expect(receipt.stateDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain("order-one");
  });

  it("refuses an observer coupled to execution or missing any required observation", () => {
    const coupled = adapter({ independentFromDriverIds: [] });
    const incomplete = adapter({ key: "incomplete", observationKeys: ["orders"] });
    const result = new UniversalVerifierFactory([coupled, incomplete]).compile(contract());
    expect(result).toMatchObject({ status: "rejected", checks: [{ id: "observer.independent", passed: false }] });
  });

  it("fails closed on a wrong outcome, incorrect side effect or unavailable observation", async () => {
    const cases: UniversalObservationAdapter[] = [
      adapter({ async observe() { return { orders: [], source: { status: "complete" }, unexpected: {}, "incorrect-side-effects": 0 }; } }),
      adapter({ async observe() { return { orders: [{ id: "one" }], source: { status: "complete" }, unexpected: {}, "incorrect-side-effects": 1 }; } }),
      adapter({ async observe() { throw new Error("private observer failure"); } }),
    ];
    for (const candidate of cases) {
      const result = new UniversalVerifierFactory([candidate], () => now).compile(contract());
      expect(result.status).toBe("compiled");
      if (result.status !== "compiled") continue;
      const receipt = await result.verifier.verify(context);
      expect(receipt.passed).toBe(false);
      expect(receipt.checks.some((check) => !check.passed)).toBe(true);
    }
  });

  it("selects the highest-priority complete independent observer deterministically", () => {
    const slow = adapter({ key: "slow-observer", priority: 20, sourceId: "slow-source" });
    const preferred = adapter({ key: "preferred-observer", priority: 2, sourceId: "preferred-source" });
    const result = new UniversalVerifierFactory([slow, preferred]).compile(contract());
    expect(result.status).toBe("compiled");
    if (result.status === "compiled") expect(result.verifier.adapter.key).toBe("preferred-observer");
  });
});

