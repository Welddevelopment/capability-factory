import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runFreshStartOnboardingTeardown } from "../src/product/fresh-start-onboarding-teardown.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("fresh-start onboarding teardown", () => {
  it("measures the clean packaging journey without turning fixture declarations into customer evidence", async () => {
    const projectDirectory = process.cwd();
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cf-fresh-onboarding-teardown-"));
    temporaryDirectories.push(outputDirectory);
    const report = await runFreshStartOnboardingTeardown({
      projectDirectory,
      packageDirectory: path.join(projectDirectory, "validation/fresh-start-onboarding-teardown-v1/package"),
      outputDirectory,
    });

    expect(report).toMatchObject({
      rehearsalType: "automated-author-independent-packaging-rehearsal",
      spendUsd: 0,
      modelCalls: 0,
      fixturePackage: { importedRepositoryHelperFixtures: false },
      measuredJourney: {
        preparationStatus: "acceptance-scaffold-ready",
        acceptanceStatus: "completed",
        actualHumanActiveMinutes: null,
        underOneDayClaimSupported: false,
      },
      restartAndReuse: {
        preparationReadFromFreshCliProcess: true,
        preparationSnapshotDigestStable: true,
        acceptanceReloadedFromDurableStore: true,
        acceptanceReceiptCountStable: true,
        acceptanceAttemptsStable: true,
      },
      acceptance: { passed: true, cases: 10, receipts: 10, incorrectSideEffects: 0 },
      customerSpecificWork: { executableCustomerCodeWrittenInRehearsal: 0 },
    });
    expect(report.preciseRemainingBlockers.map((item) => item.blockerId)).toEqual([
      "customer-action-runtime-binding-not-generated",
      "customer-observer-binding-not-generated",
      "real-credential-and-environment-activation-missing",
      "fresh-human-onboarding-evidence-not-run",
    ]);
    expect(report.authorOnlyStepDisposition.filter((item) => item.disposition === "precise-blocker")).toHaveLength(3);
    expect(fs.existsSync(report.reportPath)).toBe(true);
  }, 30_000);
});
