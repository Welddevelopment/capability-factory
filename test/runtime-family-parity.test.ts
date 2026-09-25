import { describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_FAMILY_REGISTRY } from "../src/product/universal-capability-contract.js";
import { assessRuntimeFamilyParity, makeParityEvidence } from "../src/product/runtime-family-parity.js";
import { RUNTIME_FAMILY_PARITY_LEDGER_V1 } from "../src/product/runtime-family-parity-ledger.js";

describe("runtime-family parity contract", () => {
  it("tracks every enabled family exactly once without upgrading experimental maturity", () => {
    const enabled = DEFAULT_RUNTIME_FAMILY_REGISTRY.filter((item) => item.enabled).map((item) => item.family).sort();
    const ledger = RUNTIME_FAMILY_PARITY_LEDGER_V1.map((item) => item.family).sort();
    expect(ledger).toEqual(enabled);
    const assessments = RUNTIME_FAMILY_PARITY_LEDGER_V1.map(assessRuntimeFamilyParity);
    expect(assessments.find((item) => item.family === "service-api")).toMatchObject({
      achievedLevel: "transfer-local",
      nextLevel: "onboarding-validated",
    });
    expect(assessments.filter((item) => item.family !== "service-api").every((item) => item.achievedLevel !== "onboarding-validated")).toBe(true);
  });

  it("does not let a happy path skip the hardening level", () => {
    const evidence = makeParityEvidence({
      "complete-capability-bundle": [{ path: "test/example.test.ts", detail: "Bundle exists." }],
      "ordinary-goal-entry": [{ path: "test/example.test.ts", detail: "Goal accepted." }],
      "no-write-pre-use-probe": [{ path: "test/example.test.ts", detail: "Probe passed." }],
      "explicit-authority-zero-write-stop": [{ path: "test/example.test.ts", detail: "Authority denied safely." }],
      "independent-external-outcome-observer": [{ path: "test/example.test.ts", detail: "Observer is separate." }],
      "incorrect-partial-unknown-rejection": [{ path: "test/example.test.ts", detail: "Bad outcomes rejected." }],
      "fresh-process-retained-reuse": [{ path: "test/example.test.ts", detail: "Reuse passed." }],
      "second-distinct-system-or-contract": [{ path: "test/example.test.ts", detail: "Second system passed." }],
    });
    const assessment = assessRuntimeFamilyParity({
      schemaVersion: "1.0",
      family: "browser-web",
      currentMode: "experimental-browser-actions",
      assessedAt: "2026-08-12",
      target: "http-reference-quality",
      evidence,
      claimBoundary: "Synthetic test profile.",
    });
    expect(assessment.achievedLevel).toBe("bounded-loop");
    expect(assessment.nextLevel).toBe("hardened-local");
    expect(assessment.blockers.map((item) => item.requirement)).toContain("executed-ten-case-acceptance");
  });

  it("requires referenced evidence for every demonstrated requirement", () => {
    expect(() => assessRuntimeFamilyParity({
      schemaVersion: "1.0",
      family: "service-api",
      currentMode: "constrained-http-api",
      assessedAt: "2026-08-12",
      target: "http-reference-quality",
      evidence: makeParityEvidence({}).map((item) => item.requirement === "complete-capability-bundle"
        ? { ...item, status: "demonstrated", boundary: "Claimed without evidence." }
        : item),
      claimBoundary: "Invalid profile.",
    })).toThrow(/evidence/i);
  });
});
