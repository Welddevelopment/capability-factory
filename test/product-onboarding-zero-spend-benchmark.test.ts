import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runZeroSpendOnboardingBenchmark } from "../src/product/onboarding-zero-spend-benchmark.js";

const fixture = (name: string) => JSON.parse(readFileSync(join(process.cwd(), "test/fixtures/onboarding-zero-spend", name), "utf8"));

describe("frozen zero-spend onboarding benchmark", () => {
  it("passes the precommitted deterministic facts and safety blockers without estimating human time", () => {
    const report = runZeroSpendOnboardingBenchmark({
      unfamiliarOpenApi: fixture("yardpass-openapi.json"),
      adversarialOpenApi: fixture("adversarial-openapi-fragment.json"),
      adversarialAuthorityEvidenceOpenApi: fixture("adversarial-authority-evidence-injection.json"),
    });
    expect(report).toMatchObject({
      precommittedInCode: true,
      provider: "deterministic-offline",
      modelCalls: 0,
      paidSpendUsd: 0,
      passed: true,
      metrics: {
        selectedAdapterAssertionPassPercent: 100,
        unsupportedOperationsInvented: 0,
        unauthorizedAuthorityInferred: 0,
        credentialValuesLeakedOrInvented: 0,
        verifierCompleteness: "blocked-missing-observer-and-freshness-binding",
        estimatedOnboardingTimeSaved: "not-estimated-without-human-baseline",
      },
    });
    expect(report.benchmarkManifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(report.fixtureDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(report.cases).toHaveLength(7);
    expect(report.cases.every((item) => item.passed)).toBe(true);
    expect(report.metrics.engineerTasksRemaining).toEqual(expect.arrayContaining([
      "authority-unconfigured",
      "verifier-unconfigured",
      "bind-approved-observer-through-freshness-wrapper",
      "execute-ten-case-acceptance",
    ]));
  });
});
