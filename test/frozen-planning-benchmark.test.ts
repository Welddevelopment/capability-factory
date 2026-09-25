import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { auditPlanningBenchmarkBridges, runFrozenPlanningBenchmark } from "../src/product/frozen-planning-benchmark.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const materialDirectory = join(root, "validation", "cf-015-frozen-planning-benchmark-v1");

describe("CF-015 frozen fair planning benchmark", () => {
  it("runs CF, same-tool fixed policy and adaptive exhaustive search under equal sealed context and budget", () => {
    const receipt = runFrozenPlanningBenchmark({ materialDirectory, requireSeal: true });
    expect(receipt.contextBudgetEqual).toBe(true);
    expect(receipt.strategies.map((item) => [item.strategy, item.metrics.exactOutcomes])).toEqual([["cf", 6], ["adaptive-exhaustive", 6], ["fixed-policy", 3]]);
    expect(receipt.strategies.find((item) => item.strategy === "cf")?.metrics.minimumResidualExact).toBe(3);
    expect(receipt.strategies.every((item) => item.metrics.incorrectEffects === 0 && item.metrics.authorBridges === 0)).toBe(true);
  });

  it("fails closed when frozen benchmark material changes", () => {
    const temporary = mkdtempSync(join(tmpdir(), "cf-015-tamper-"));
    try {
      const copied = join(temporary, "material"); cpSync(materialDirectory, copied, { recursive: true });
      appendFileSync(join(copied, "benchmark.json"), " ");
      expect(() => runFrozenPlanningBenchmark({ materialDirectory: copied, requireSeal: true })).toThrow(/frozen planning material changed/i);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });

  it("rejects case-specific expected routes or planner callbacks as author bridges", () => {
    expect(auditPlanningBenchmarkBridges({ expectedPlan: ["hand-authored"] })).toMatchObject({ ready: false, blockers: expect.arrayContaining([expect.stringMatching(/author-bridge/)]) });
    expect(auditPlanningBenchmarkBridges({ customPlannerCallback: "author" })).toMatchObject({ ready: false, blockers: expect.arrayContaining([expect.stringMatching(/author-bridge/)]) });
  });
});
