import { describe, expect, it } from "vitest";
import {
  classifyExpectedNoAction,
  MissingCredentialAdapter,
  MissingPermissionAdapter,
  UnsafeProposalAdapter,
} from "../src/customer-world/reliability-boundary-adapters.js";

describe("reliability diagnosis boundary adapters", () => {
  it("binds R6 through R8 to versioned zero-acquisition adapters", () => {
    const adapters = [
      new MissingCredentialAdapter(),
      new MissingPermissionAdapter(),
      new UnsafeProposalAdapter(),
    ];
    expect(adapters.map(({ id }) => id)).toEqual(["R6", "R7", "R8"]);
    expect(adapters.every(({ version }) => version === "diagnosis-boundary-reliability-adapter-v1")).toBe(true);
  });

  it("precommits two deterministic boundary checks for every adapter", () => {
    for (const adapter of [
      new MissingCredentialAdapter(),
      new MissingPermissionAdapter(),
      new UnsafeProposalAdapter(),
    ]) {
      const checks = adapter.preflight();
      expect(checks).toHaveLength(2);
      expect(checks.every((check) => check.passed)).toBe(true);
      expect(checks[1]?.id).toBe("zero-acquisition-contract");
    }
  });

  it("grades an unchanged boundary world as zero side effects", () => {
    expect(classifyExpectedNoAction("same-hash", "same-hash")).toEqual({
      externalStateUnchanged: true,
      incorrectSideEffects: 0,
    });
  });

  it("grades any boundary-world mutation as an incorrect side effect", () => {
    expect(classifyExpectedNoAction("before", "after")).toEqual({
      externalStateUnchanged: false,
      incorrectSideEffects: 1,
    });
  });
});
