import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

export const CF053_PROVIDER_TRANSFER_VERSION = "1.0" as const;

const digestPattern = /^[a-f0-9]{64}$/;
const expectedV1Files = [
  "README.md",
  "expectations.json",
  "grid-curtailment.json",
  "nested-freight-stop.json",
  "polar-calibration.json",
] as const;

const expectedV2Files = [
  "README.md",
  "FAILED_V1_CHRONOLOGY.md",
  "expectations.json",
  "grid-curtailment.json",
  "nested-freight-stop.json",
  "polar-calibration.json",
] as const;

type FrozenFileName = typeof expectedV2Files[number];

interface Cf053FreezeSeal {
  schemaVersion: "1.0";
  campaignId: "cf-053-frozen-provider-families-v1" | "cf-053-frozen-provider-families-v2";
  state: "frozen-before-run";
  frozenAt: string;
  hashAlgorithm: "sha256-raw-file-bytes";
  files: Array<{ path: FrozenFileName; sha256: string }>;
  inputFamilies: ["polar-calibration", "grid-curtailment", "nested-freight-stop"];
  supportedFamilyCount: 2;
  unsupportedStopControlCount: 1;
  executionStartedAtFreeze: false;
  resultExistsAtFreeze: false;
  executionAuthorityEffect: "none";
  activationEffect: "none";
}

export interface Cf053FrozenCampaignPreflight {
  schemaVersion: "1.0";
  campaignId: "cf-053-frozen-provider-families-v1" | "cf-053-frozen-provider-families-v2";
  state: "sealed-input-preflight-passed" | "sealed-input-preflight-failed";
  exactFilesRequired: 5 | 6;
  exactFilesMatched: number;
  mismatches: Array<{ path: FrozenFileName; expectedSha256: string; actualSha256: string }>;
  executionStarted: false;
  transportsLaunched: 0;
  authorityReceiptsIssued: 0;
  businessWrites: 0;
  observerWrites: 0;
  modelCalls: 0;
  paidSpendUsd: 0;
}

export interface Cf053FrozenCampaignBlockedResult {
  schemaVersion: "1.0";
  campaignId: "cf-053-frozen-provider-families-v1";
  state: "campaign-blocked-before-execution";
  passClaimed: false;
  preflight: Cf053FrozenCampaignPreflight;
  blockers: string[];
  families: Array<{
    familyId: "polar-calibration" | "grid-curtailment" | "nested-freight-stop";
    state: "not-run";
    candidateGenerated: false;
    transportLaunched: false;
    authorityGranted: false;
    businessWrites: 0;
    observerWrites: 0;
    evidence: "none-because-campaign-did-not-open";
  }>;
  boundaries: {
    sourceBytesTypedBound: false;
    freshProcessReuseProved: false;
    parentResumptionProved: false;
    customerAcceptance: false;
    activation: false;
    customerEvidence: false;
    productionEvidence: false;
  };
  modelCalls: 0;
  paidSpendUsd: 0;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function campaignFile(directory: string, name: string): string {
  const root = resolve(directory);
  const path = resolve(root, name);
  if (!path.startsWith(`${root}${sep}`) || basename(path) !== name) {
    throw new Error("CF-053 campaign file escaped the exact frozen directory.");
  }
  return path;
}

function parseSeal(directory: string): Cf053FreezeSeal {
  const seal = JSON.parse(readFileSync(campaignFile(directory, "freeze-seal.json"), "utf8")) as Cf053FreezeSeal;
  const expectedFiles = seal.campaignId === "cf-053-frozen-provider-families-v2" ? expectedV2Files : expectedV1Files;
  const names = seal.files?.map((file) => file.path);
  if (
    seal.schemaVersion !== "1.0" ||
    !["cf-053-frozen-provider-families-v1", "cf-053-frozen-provider-families-v2"].includes(seal.campaignId) ||
    seal.state !== "frozen-before-run" ||
    seal.hashAlgorithm !== "sha256-raw-file-bytes" ||
    !Number.isFinite(Date.parse(seal.frozenAt)) ||
    seal.supportedFamilyCount !== 2 ||
    seal.unsupportedStopControlCount !== 1 ||
    seal.executionStartedAtFreeze !== false ||
    seal.resultExistsAtFreeze !== false ||
    seal.executionAuthorityEffect !== "none" ||
    seal.activationEffect !== "none" ||
    names.length !== expectedFiles.length ||
    new Set(names).size !== expectedFiles.length ||
    expectedFiles.some((name) => !names.includes(name)) ||
    seal.files.some((file) => !digestPattern.test(file.sha256))
  ) {
    throw new Error("CF-053 freeze seal failed exact schema, chronology, file-set or non-authority checks.");
  }
  return seal;
}

/**
 * Reads raw bytes only. This is deliberately the first gate before parsing provider or
 * oracle JSON, constructing a CF-041 source, launching CF-052 processes, or issuing any
 * authority receipt.
 */
export function preflightCf053FrozenCampaign(directory: string): Cf053FrozenCampaignPreflight {
  const seal = parseSeal(directory);
  const expectedFiles = seal.campaignId === "cf-053-frozen-provider-families-v2" ? expectedV2Files : expectedV1Files;
  const mismatches: Cf053FrozenCampaignPreflight["mismatches"] = [];
  for (const entry of seal.files) {
    const actualSha256 = sha256(readFileSync(campaignFile(directory, entry.path)));
    if (actualSha256 !== entry.sha256) {
      mismatches.push({ path: entry.path, expectedSha256: entry.sha256, actualSha256 });
    }
  }
  return {
    schemaVersion: "1.0",
    campaignId: seal.campaignId,
    state: mismatches.length === 0 ? "sealed-input-preflight-passed" : "sealed-input-preflight-failed",
    exactFilesRequired: expectedFiles.length,
    exactFilesMatched: expectedFiles.length - mismatches.length,
    mismatches,
    executionStarted: false,
    transportsLaunched: 0,
    authorityReceiptsIssued: 0,
    businessWrites: 0,
    observerWrites: 0,
    modelCalls: 0,
    paidSpendUsd: 0,
  };
}

export interface Cf053FrozenCampaignV2BlockedResult {
  schemaVersion: "1.0";
  campaignId: "cf-053-frozen-provider-families-v2";
  state: "campaign-blocked-before-provider-content-open-or-execution";
  passClaimed: false;
  preflight: Cf053FrozenCampaignPreflight;
  blockers: string[];
  families: Array<{
    familyId: "polar-calibration" | "grid-curtailment" | "nested-freight-stop";
    state: "not-run";
    providerContentOpenedByRunner: false;
    candidateGenerated: false;
    transportLaunched: false;
    authorityGranted: false;
    businessWrites: 0;
    observerWrites: 0;
  }>;
  boundaries: {
    existingRunnerFrozenBeforeV2: false;
    sourceBytesTypedBound: false;
    freshProcessReuseProved: false;
    parentResumptionProved: false;
    customerAcceptance: false;
    activation: false;
  };
  modelCalls: 0;
  paidSpendUsd: 0;
}

/**
 * Performs only the raw-byte v2 seal check. It deliberately does not parse provider or
 * oracle content: the already-existing runner was still v1-specific when v2 froze, so
 * opening the unseen cases and adapting it afterward would violate the prospective gate.
 */
export function evaluateCf053FrozenCampaignV2PreOpen(directory: string): Cf053FrozenCampaignV2BlockedResult {
  const preflight = preflightCf053FrozenCampaign(directory);
  if (preflight.campaignId !== "cf-053-frozen-provider-families-v2") throw new Error("CF-053 v2 pre-open evaluation requires the exact v2 campaign.");
  const blockers: string[] = [];
  if (preflight.state !== "sealed-input-preflight-passed") blockers.push("The v2 raw bytes do not match the v2 seal.");
  blockers.push("The provider-neutral executable transfer runner was not frozen before the v2 unseen cases were sealed; adapting it after opening those cases would violate the prospective no-core-edits protocol.");
  blockers.push("The already-existing executable CF-052 process accepts one orderRef field and has no generic stable-identity/parameter serializer proven for materially different provider inputs.");
  blockers.push("The already-existing CF-052 result explicitly does not prove fresh-process candidate reuse or original parent-goal resumption, but the v2 oracle requires both.");
  return {
    schemaVersion: "1.0",
    campaignId: "cf-053-frozen-provider-families-v2",
    state: "campaign-blocked-before-provider-content-open-or-execution",
    passClaimed: false,
    preflight,
    blockers,
    families: ["polar-calibration", "grid-curtailment", "nested-freight-stop"].map((familyId) => ({
      familyId: familyId as "polar-calibration" | "grid-curtailment" | "nested-freight-stop",
      state: "not-run" as const,
      providerContentOpenedByRunner: false as const,
      candidateGenerated: false as const,
      transportLaunched: false as const,
      authorityGranted: false as const,
      businessWrites: 0 as const,
      observerWrites: 0 as const,
    })),
    boundaries: {
      existingRunnerFrozenBeforeV2: false,
      sourceBytesTypedBound: false,
      freshProcessReuseProved: false,
      parentResumptionProved: false,
      customerAcceptance: false,
      activation: false,
    },
    modelCalls: 0,
    paidSpendUsd: 0,
  };
}

/**
 * CF-053's v1 inputs were frozen before the transfer runner was finished. The exact raw
 * seal was rewritten after the handed-off bytes changed, and unchanged CF-052 also cannot
 * prove the frozen oracle's fresh-process reuse or parent-goal resumption requirements.
 * The current bytes therefore matching the rewritten seal cannot repair the chronology.
 * This function records that honest pre-execution result and cannot manufacture a pass.
 */
export function evaluateCf053FrozenCampaignV1(directory: string): Cf053FrozenCampaignBlockedResult {
  const preflight = preflightCf053FrozenCampaign(directory);
  const invalidation = readFileSync(campaignFile(directory, "INVALIDATED.md"), "utf8");
  if (!invalidation.includes("handed-off seal `932ef063c08e405720b0980afe4f8b42c7fa6aa915f33a61d3e082049df808a7`") || !invalidation.includes("changed bytes `23fae4d39eefbc9bb5f8d18249bd0a364c2e8038b13280bfeeeda74a3ebac4d3`") || !invalidation.includes("handed-off seal `6ca97461ba17d88c86ae64b0843658269a71a6bc54ffdfc8f45fadb71d11eac4`") || !invalidation.includes("changed bytes `d6630a1a5cc1291caebbc5fed95649cb43927a4f40f17a7e8dca53cc7d59194a`")) throw new Error("CF-053 v1 historical invalidation record is missing or changed.");
  const blockers: string[] = ["The current v1 files match a retrospectively rewritten seal, but INVALIDATED.md preserves the handed-off seal mismatch. Rewriting the seal after input mutation cannot restore prospective chronology; v1 remains invalid."];
  blockers.push("The provider-neutral transfer runner was not frozen before the v1 case opened, so changing or completing core transfer logic after seeing the cases would violate the prospective no-core-edits gate.");
  blockers.push("Unchanged CF-052 binds its executable fictional process to one orderRef field and does not implement the two frozen providers' distinct three-field inputs and stable-identity keys.");
  blockers.push("Unchanged CF-052 explicitly does not prove provider-process restart recovery, fresh-process retained reuse, or original parent-goal resumption, while the frozen v1 oracle requires fresh-process reuse and parent resumption.");
  return {
    schemaVersion: "1.0",
    campaignId: "cf-053-frozen-provider-families-v1",
    state: "campaign-blocked-before-execution",
    passClaimed: false,
    preflight,
    blockers,
    families: ["polar-calibration", "grid-curtailment", "nested-freight-stop"].map((familyId) => ({
      familyId: familyId as "polar-calibration" | "grid-curtailment" | "nested-freight-stop",
      state: "not-run" as const,
      candidateGenerated: false as const,
      transportLaunched: false as const,
      authorityGranted: false as const,
      businessWrites: 0 as const,
      observerWrites: 0 as const,
      evidence: "none-because-campaign-did-not-open" as const,
    })),
    boundaries: {
      sourceBytesTypedBound: false,
      freshProcessReuseProved: false,
      parentResumptionProved: false,
      customerAcceptance: false,
      activation: false,
      customerEvidence: false,
      productionEvidence: false,
    },
    modelCalls: 0,
    paidSpendUsd: 0,
  };
}
