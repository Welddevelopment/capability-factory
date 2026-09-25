import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CF021_SEEDED_SCENARIOS,
  runCf021SeededBoundaryFaultCampaign,
} from "../src/product/seeded-boundary-fault-campaign.js";

const stored = JSON.parse(readFileSync(
  new URL("../validation/cf-021-seeded-boundary-faults-v1/seeds.json", import.meta.url),
  "utf8",
)) as { schemaVersion: string; campaignId: string; generator: string; seeds: number[] };

describe("CF-021 seeded boundary fault campaign", () => {
  it("replays every stored seed across every precommitted boundary with all safety invariants intact", async () => {
    const receipt = await runCf021SeededBoundaryFaultCampaign(stored.seeds);
    expect(stored).toMatchObject({ schemaVersion: "1.0", campaignId: receipt.campaignId, generator: "xorshift32" });
    expect(receipt).toMatchObject({
      scenarioCount: 26,
      generatedCaseCount: 312,
      passedCaseCount: 312,
      unexpectedFailureCount: 0,
      uniqueTransitionCount: 26,
      failuresFoundAndFixed: 4,
      invariants: {
        unauthorizedWrites: 0,
        blindRetries: 0,
        duplicateParentResumptions: 0,
        staleOrQuarantinedSelections: 0,
        unsafeRollbackRevivals: 0,
        crossTenantEvidenceUses: 0,
        actionResponseProofAcceptances: 0,
      },
      modelCalls: 0,
      paidSpendUsd: 0,
    });
    expect(receipt.scenarioCount).toBe(CF021_SEEDED_SCENARIOS.length);
    expect(receipt.cases).toHaveLength(stored.seeds.length * CF021_SEEDED_SCENARIOS.length);
    expect(receipt.regressions.every((item) => item.replayPassed)).toBe(true);
    expect(receipt.regressions.every((item) => Object.keys(item.minimalCounterexample).every((key) => !key.startsWith("noise")))).toBe(true);
    expect(receipt.receiptDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic for the same stored seed order", async () => {
    const first = await runCf021SeededBoundaryFaultCampaign(stored.seeds.slice(0, 2));
    const second = await runCf021SeededBoundaryFaultCampaign(stored.seeds.slice(0, 2));
    expect(second.receiptDigest).toBe(first.receiptDigest);
    expect(second.cases).toEqual(first.cases);
  });

  it("rejects missing, duplicate and out-of-range seed material", async () => {
    await expect(runCf021SeededBoundaryFaultCampaign([])).rejects.toThrow(/unique unsigned/);
    await expect(runCf021SeededBoundaryFaultCampaign([1, 1])).rejects.toThrow(/unique unsigned/);
    await expect(runCf021SeededBoundaryFaultCampaign([0x1_0000_0000])).rejects.toThrow(/unique unsigned/);
  });
});
