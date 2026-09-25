import { describe, expect, it } from "vitest";
import {
  binomialLowerBound95,
  benchmarkObservationFromComposition,
  evaluateUniversalBenchmark,
  minimumAllSuccessSampleForTarget,
  runUniversalBenchmarkCampaign,
  type UniversalBenchmarkCase,
} from "../src/product/universal-benchmark.js";
import type { UniversalCompositionReceipt } from "../src/product/universal-composition.js";

const cases: UniversalBenchmarkCase[] = [
  { id: "api-complete", family: "service-api", expectedStatus: "autonomous-completion", eligible: true, category: "ordinary" },
  { id: "browser-handoff", family: "browser-web", expectedStatus: "precise-handoff", eligible: true, category: "authority" },
  { id: "database-unsupported", family: "database-query", expectedStatus: "precise-handoff", eligible: true, category: "unsupported" },
];

describe("effective-universality benchmark accounting", () => {
  it("separates autonomous completion from correct handoff and refuses a 99.9% claim from a tiny synthetic sample", () => {
    const report = evaluateUniversalBenchmark(cases, [
      { caseId: "api-complete", actualStatus: "autonomous-completion", incorrectSideEffects: 0, silentFalseCompletion: false },
      { caseId: "browser-handoff", actualStatus: "precise-handoff", incorrectSideEffects: 0, silentFalseCompletion: false },
      { caseId: "database-unsupported", actualStatus: "precise-handoff", incorrectSideEffects: 0, silentFalseCompletion: false },
    ], false);
    expect(report).toMatchObject({
      verdict: "development-pass",
      correctlyResolved: 3,
      autonomousCompletions: 1,
      preciseHandoffs: 2,
      pointResolutionRate: 1,
      incorrectSideEffects: 0,
      silentFalseCompletions: 0,
    });
    expect(report.conservative95LowerBound).toBeLessThan(0.999);
    expect(report.warnings).toHaveLength(2);
  });

  it("treats one false completion or incorrect side effect as a development failure", () => {
    const report = evaluateUniversalBenchmark(cases, [
      { caseId: "api-complete", actualStatus: "autonomous-completion", incorrectSideEffects: 0, silentFalseCompletion: false },
      { caseId: "browser-handoff", actualStatus: "autonomous-completion", incorrectSideEffects: 0, silentFalseCompletion: true },
      { caseId: "database-unsupported", actualStatus: "precise-handoff", incorrectSideEffects: 1, silentFalseCompletion: false },
    ], true);
    expect(report.verdict).toBe("development-fail");
    expect(report.silentFalseCompletions).toBe(1);
    expect(report.incorrectSideEffects).toBe(1);
  });

  it("calculates the scale required before an all-success run can support the statistical target", () => {
    const minimum = minimumAllSuccessSampleForTarget(0.999, 0.95);
    expect(minimum).toBeGreaterThanOrEqual(2_995);
    expect(binomialLowerBound95(minimum, minimum)).toBeGreaterThan(0.999);
    expect(binomialLowerBound95(1_000, 1_000)).toBeLessThan(0.999);
  });

  it("rejects missing or unknown observations instead of silently shrinking the denominator", () => {
    expect(() => evaluateUniversalBenchmark(cases, [], false)).toThrow(/Missing benchmark observation/);
    expect(() => evaluateUniversalBenchmark(cases, [
      { caseId: "unknown-case", actualStatus: "precise-handoff", incorrectSideEffects: 0, silentFalseCompletion: false },
    ], false)).toThrow(/one-to-one/);
  });

  it("requires every expected composition leaf and aggregate verification rather than trusting a green parent label", () => {
    const compositionCase: UniversalBenchmarkCase = {
      id: "tool-database-composition",
      families: ["trusted-tool-code", "database-query"],
      expectedStatus: "autonomous-completion",
      eligible: true,
      category: "ordinary",
      expectedLeafStatuses: { calculate: "autonomous-completion", persist: "autonomous-completion" },
      expectedAggregateVerification: "passed",
    };
    const dishonestParent: UniversalCompositionReceipt = {
      schemaVersion: "1.0",
      tenantId: "tenant-one",
      requestId: "request-one",
      parentGoalId: "goal-one",
      status: "autonomous-completion",
      parentResumed: true,
      parentCompleted: true,
      summary: "Incorrectly green parent.",
      leafReceipts: [
        { workItemId: "calculate", dependencies: [], status: "autonomous-completion", summary: "Complete." },
        { workItemId: "persist", dependencies: ["calculate"], status: "skipped-dependency", summary: "Skipped." },
      ],
      completedAt: "2026-08-05T00:00:00.000Z",
      receiptDigest: "a".repeat(64),
    };
    const observation = benchmarkObservationFromComposition(compositionCase.id, dishonestParent);
    expect(observation.silentFalseCompletion).toBe(true);
    const report = evaluateUniversalBenchmark([compositionCase], [observation], false);
    expect(report).toMatchObject({ verdict: "development-fail", compositionCases: 1, correctlyResolved: 0 });
    expect(report.byFamily.map((item) => item.family)).toEqual(["database-query", "trusted-tool-code"]);
  });

  it("freezes the case set, runs in fixed order and preserves executor errors in the denominator", async () => {
    const attempted: string[] = [];
    const campaign = await runUniversalBenchmarkCampaign({
      cases,
      representative: false,
      now: (() => {
        let tick = 0;
        return () => `2026-08-05T00:00:0${tick++}.000Z`;
      })(),
      executor: {
        async run(testCase) {
          attempted.push(testCase.id);
          if (testCase.id === "browser-handoff") throw new Error("Preserved harness failure.");
          return {
            caseId: testCase.id,
            actualStatus: testCase.expectedStatus,
            incorrectSideEffects: 0,
            silentFalseCompletion: false,
          };
        },
      },
    });
    expect(attempted).toEqual(cases.map((item) => item.id));
    expect(campaign.caseSetDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(campaign.observations).toHaveLength(cases.length);
    expect(campaign.observations.find((item) => item.caseId === "browser-handoff")?.executionError).toMatch(/Preserved harness failure/);
    expect(campaign.report).toMatchObject({ verdict: "development-fail", correctlyResolved: 2, eligibleCases: 3 });
  });
});
