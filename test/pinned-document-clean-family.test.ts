import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  renderPinnedDocumentVariantHashes,
  runPinnedDocumentCleanFamily,
} from "../src/product/pinned-document-clean-family.js";

const roots: string[] = [];
const validation = new URL("../validation/cf-007-pinned-document-clean-family-v1/", import.meta.url);
const family = JSON.parse(readFileSync(new URL("family.json", validation), "utf8")) as {
  contracts: Array<{ contract: Record<string, unknown>; document: Record<string, unknown>; approvedAt: string; variants: Record<string, string> }>;
};

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("CF-007 pinned machine-readable document clean family", () => {
  it("keeps all frozen approved byte pins reproducible for two genuinely different layouts", async () => {
    for (const entry of family.contracts) {
      const hashes = await renderPinnedDocumentVariantHashes(entry as never);
      expect(hashes).toEqual(entry.variants);
    }
    expect(family.contracts.map((entry) => entry.contract.layout)).toEqual(["labeled-envelope-v1", "controlled-table-v2"]);
  });

  it("runs both sealed contracts through one generic factory, acceptance executor, recovery and lifecycle", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf-007-clean-family-")); roots.push(root);
    const receipt = await runPinnedDocumentCleanFamily(fileURLToPath(validation), root);
    expect(receipt).toMatchObject({
      status: "passed", caseCount: 38, acceptanceCasesExecuted: 20, extraFaultCasesExecuted: 18,
      effects: { actionWrites: 10, parentResumptions: 10, retainedReuses: 10, quarantines: 8, incorrectSideEffectsSurviving: 0 },
      composition: {
        generatedProposals: 28, generatedManifests: 28, handwrittenReusableSourceFiles: 2,
        frozenDeclarativeContracts: 2, frozenDeclarativeCases: 38, caseSpecificExecutableFilesAfterFreeze: 0,
      },
      historicalSourcesModified: 0, modelCalls: 0, paidSpendUsd: 0,
    });
    expect(receipt.layouts).toHaveLength(2);
    expect(receipt.cases.filter((item) => item.acceptanceCase)).toHaveLength(20);
    expect(receipt.cases.every((item) => item.status === "passed" && item.actualStatus === item.expectedStatus)).toBe(true);
  });

  it("fails closed if frozen material or implementation hashes do not match", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf-007-seal-")); roots.push(root);
    const copied = join(root, "validation");
    const work = join(root, "work");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(copied, { recursive: true });
    writeFileSync(join(copied, "family.json"), `${JSON.stringify({ ...family, frozenAt: "2026-08-14T12:00:01.000Z" })}\n`);
    writeFileSync(join(copied, "campaign-seal.json"), readFileSync(new URL("campaign-seal.json", validation)));
    await expect(runPinnedDocumentCleanFamily(copied, work)).rejects.toThrow(/seal failed/);
  });
});
