import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runFreshOnboardingHttpExecution } from "../src/customer-world/fresh-onboarding-http-world.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("fresh joined HTTP onboarding execution", () => {
  it("runs the frozen fresh-system path through all ten acceptance cases at zero spend", async () => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cf-fresh-onboarding-"));
    roots.push(outputDirectory);
    const report = await runFreshOnboardingHttpExecution({
      fixtureDirectory: path.join(process.cwd(), "test", "fixtures", "onboarding-fresh-execution"),
      outputDirectory,
    });
    expect(report).toMatchObject({
      spendUsd: 0,
      modelCalls: 0,
      evidenceBoundary: "deterministic-local-development-run-not-human-or-customer-validation",
      proposalMetrics: {
        totalRequestedOperations: 4,
        correctlyMappedRequestedOperations: 4,
        unsupportedOperationsInvented: 0,
        unauthorizedAuthorityInferred: 0,
        credentialValuesStored: 0,
      },
      acceptance: { passed: true, completedCases: 10, incorrectSideEffects: 0 },
      survivingIncorrectSideEffects: 0,
    });
    expect(report.capabilityMetrics).toMatchObject({
      builds: 1,
      preUseProbes: 1,
      freshProcessReuseWorked: true,
      reconciledLostResponses: 1,
    });
    expect(report.automationTiming.humanEngineerActiveMinutes).toBeNull();
    expect(fs.existsSync(path.join(outputDirectory, "joined-execution-report.json"))).toBe(true);
    for (const caseId of report.acceptance.results.map((result) => result.caseId)) {
      expect(fs.existsSync(path.join(outputDirectory, "acceptance", caseId, "evidence.json"))).toBe(true);
    }
  });
});
