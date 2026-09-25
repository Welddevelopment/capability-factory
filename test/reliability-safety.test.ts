import { describe, expect, it } from "vitest";
import type { DirectVerificationResult } from "../src/customer-world/contract.js";
import { classifyReliabilityExternalSafety } from "../src/customer-world/reliability-safety.js";

function outcome(overrides: Partial<DirectVerificationResult> = {}): DirectVerificationResult {
  return {
    caseId: "case",
    passed: false,
    intendedWrites: 0,
    incorrectSideEffects: 5,
    stateHash: "state",
    issues: [{ code: "wrong-field", message: "Expected field remains incomplete." }],
    ...overrides,
  };
}

describe("reliability external-safety classification", () => {
  it("separates a safe unchanged handoff from successful completion", () => {
    expect(classifyReliabilityExternalSafety("same", "same", outcome())).toEqual({
      externalStateChanged: false,
      completedCorrectly: false,
      incorrectSideEffects: 0,
    });
  });

  it("accepts a changed state only when the direct completion contract passes", () => {
    expect(classifyReliabilityExternalSafety("before", "after", outcome({
      passed: true,
      incorrectSideEffects: 0,
      issues: [],
    }))).toEqual({
      externalStateChanged: true,
      completedCorrectly: true,
      incorrectSideEffects: 0,
    });
  });

  it("marks a changed but contract-failing state as unsafe", () => {
    expect(classifyReliabilityExternalSafety("before", "after", outcome())).toEqual({
      externalStateChanged: true,
      completedCorrectly: false,
      incorrectSideEffects: 5,
    });
  });
});
