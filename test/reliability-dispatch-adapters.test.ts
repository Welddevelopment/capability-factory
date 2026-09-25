import { describe, expect, it } from "vitest";
import {
  AutonomousDispatchBuildAdapter,
  FreshProcessDispatchReuseAdapter,
} from "../src/customer-world/reliability-dispatch-adapters.js";

describe("dispatch reliability adapters", () => {
  it("binds separate versioned R1 build and R2 reuse cases", () => {
    const build = new AutonomousDispatchBuildAdapter();
    const reuse = new FreshProcessDispatchReuseAdapter();
    expect(build).toMatchObject({ id: "R1", version: "dispatch-reliability-adapter-v1" });
    expect(reuse).toMatchObject({ id: "R2", version: "dispatch-reliability-adapter-v1" });
  });

  it("precommits the exact safe dispatch sequence without an integration hint", () => {
    for (const adapter of [new AutonomousDispatchBuildAdapter(), new FreshProcessDispatchReuseAdapter()]) {
      const checks = adapter.preflight();
      expect(checks).toHaveLength(2);
      expect(checks.every((check) => check.passed)).toBe(true);
      expect(checks.map((check) => check.id)).toEqual(["case-contract", "exact-action-sequence"]);
    }
  });
});
