import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createStressMatrixDefinitions,
  exactOneSided95SuccessLowerBound,
  STRESS_MATRIX_CLASSES,
} from "../src/product/reliability-stress-matrix.js";
import { runReliabilityStressMatrix } from "../src/customer-world/run-reliability-stress-matrix.js";

describe("reliability stress matrix protocol", () => {
  it("precommits exactly 100 unique deterministic trials in the fixed class counts", () => {
    const definitions = createStressMatrixDefinitions();
    expect(definitions).toHaveLength(100);
    expect(new Set(definitions.map((item) => item.id))).toHaveLength(100);
    expect(new Set(definitions.map((item) => item.seed))).toHaveLength(100);
    for (const expected of STRESS_MATRIX_CLASSES) {
      expect(definitions.filter((item) => item.classId === expected.id)).toHaveLength(expected.trials);
    }
  });

  it("does not calculate an all-pass bound for a failing or empty sequence", () => {
    expect(exactOneSided95SuccessLowerBound(0, 0)).toBeNull();
    expect(exactOneSided95SuccessLowerBound(99, 100)).toBeNull();
    expect(exactOneSided95SuccessLowerBound(100, 100)).toBeCloseTo(0.97045, 4);
  });

  it("executes all 100 trials through the real deterministic scheduler and sidecar boundaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf-stress-matrix-test-"));
    try {
      const { report } = await runReliabilityStressMatrix({ repositoryRoot: process.cwd(), artifactRoot: root });
      expect(report).toMatchObject({
        passed: true,
        abortedForSafety: false,
        expectedTrials: 100,
        completedTrials: 100,
        passedTrials: 100,
        incorrectSideEffectsSurviving: 0,
      });
      expect(report.incorrectSideEffectsObserved).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
