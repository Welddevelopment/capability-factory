import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  evaluateCf053FrozenCampaignV1,
  evaluateCf053FrozenCampaignV2PreOpen,
  preflightCf053FrozenCampaign,
} from "../src/product/cf053-provider-transfer-evaluation.js";

const directory = fileURLToPath(new URL("../validation/cf-053-frozen-provider-families-v1/", import.meta.url));
const v2Directory = fileURLToPath(new URL("../validation/cf-053-frozen-provider-families-v2/", import.meta.url));

describe("CF-053 frozen provider transfer v1 preflight", () => {
  it("preserves the current rewritten v1 bytes separately from the historical invalidation", () => {
    const preflight = preflightCf053FrozenCampaign(directory);
    expect(preflight).toMatchObject({
      state: "sealed-input-preflight-passed",
      exactFilesRequired: 5,
      exactFilesMatched: 5,
      executionStarted: false,
      transportsLaunched: 0,
      authorityReceiptsIssued: 0,
      businessWrites: 0,
      observerWrites: 0,
      modelCalls: 0,
      paidSpendUsd: 0,
    });
    expect(preflight.mismatches).toEqual([]);
  });

  it("records an honest per-family not-run result instead of simulating unsupported oracle outcomes", () => {
    const result = evaluateCf053FrozenCampaignV1(directory);
    expect(result).toMatchObject({
      state: "campaign-blocked-before-execution",
      passClaimed: false,
      families: [
        { familyId: "polar-calibration", state: "not-run", candidateGenerated: false, transportLaunched: false, businessWrites: 0 },
        { familyId: "grid-curtailment", state: "not-run", candidateGenerated: false, transportLaunched: false, businessWrites: 0 },
        { familyId: "nested-freight-stop", state: "not-run", candidateGenerated: false, transportLaunched: false, businessWrites: 0 },
      ],
      boundaries: {
        sourceBytesTypedBound: false,
        freshProcessReuseProved: false,
        parentResumptionProved: false,
        customerAcceptance: false,
        activation: false,
      },
      modelCalls: 0,
      paidSpendUsd: 0,
    });
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.stringMatching(/retrospectively rewritten seal/i),
      expect.stringMatching(/runner was not frozen/i),
      expect.stringMatching(/orderRef/i),
      expect.stringMatching(/fresh-process.*parent/i),
    ]));
  });

  it("verifies the v2 raw-byte seal and then stops before opening provider content because no runner was frozen first", () => {
    const result = evaluateCf053FrozenCampaignV2PreOpen(v2Directory);
    expect(result).toMatchObject({
      state: "campaign-blocked-before-provider-content-open-or-execution",
      passClaimed: false,
      preflight: {
        state: "sealed-input-preflight-passed",
        exactFilesRequired: 6,
        exactFilesMatched: 6,
        mismatches: [],
        executionStarted: false,
      },
      families: [
        { familyId: "polar-calibration", state: "not-run", providerContentOpenedByRunner: false, transportLaunched: false },
        { familyId: "grid-curtailment", state: "not-run", providerContentOpenedByRunner: false, transportLaunched: false },
        { familyId: "nested-freight-stop", state: "not-run", providerContentOpenedByRunner: false, transportLaunched: false },
      ],
      boundaries: {
        existingRunnerFrozenBeforeV2: false,
        freshProcessReuseProved: false,
        parentResumptionProved: false,
        customerAcceptance: false,
        activation: false,
      },
      modelCalls: 0,
      paidSpendUsd: 0,
    });
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.stringMatching(/runner was not frozen/i),
      expect.stringMatching(/orderRef/i),
      expect.stringMatching(/fresh-process.*parent/i),
    ]));
  });
});
