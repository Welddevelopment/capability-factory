import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runSignedMessageCleanFamily } from "../src/product/signed-message-clean-family.js";

const roots: string[] = [];
const validation = new URL("../validation/cf-008-signed-message-clean-family-v1/", import.meta.url);
const family = JSON.parse(readFileSync(new URL("family.json", validation), "utf8")) as {
  contracts: Array<{
    contract: { contractId: string; envelope: string; algorithm: string; orderingPolicy: string; keys: Array<{ keyId: string; keyDigest: string }> };
    keys: Array<{ keyId: string; secretBase64: string }>;
  }>;
  faults: string[];
};

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function expectedStatus(fault: string, ordering: string): "read-only" | "completed" | "blocked" | "quarantined" {
  if (fault === "read-only") return "read-only";
  if (["approved-write", "fresh-process-reuse", "lost-response", "restart", "duplicate-submission", "rotated-key"].includes(fault)) return "completed";
  if (fault === "reordered-message") return ordering === "strict-monotonic" ? "blocked" : "completed";
  if (["partial-outcome", "incorrect-outcome", "duplicate-outcome", "collateral-outcome"].includes(fault)) return "quarantined";
  return "blocked";
}

describe("CF-008 signed-message generic clean family", () => {
  it("freezes two distinct envelope, algorithm and ordering contracts with exact key pins", () => {
    expect(family.contracts.map((entry) => [entry.contract.envelope, entry.contract.algorithm, entry.contract.orderingPolicy])).toEqual([
      ["canonical-json-detached-v1", "hmac-sha256", "strict-monotonic"],
      ["fixed-header-embedded-v1", "hmac-sha512", "unique-message-only"],
    ]);
    for (const entry of family.contracts) {
      for (const fixture of entry.keys) {
        const trust = entry.contract.keys.find((key) => key.keyId === fixture.keyId);
        expect(trust?.keyDigest).toBe(createHash("sha256").update(Buffer.from(fixture.secretBase64, "base64")).digest("hex"));
      }
    }
    expect(family.faults).toHaveLength(27);
  });

  it("runs all frozen cases through proposal, acceptance, recovery and lifecycle controls", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf-008-clean-family-")); roots.push(root);
    const receipt = await runSignedMessageCleanFamily(fileURLToPath(validation), root);
    expect(receipt).toMatchObject({
      status: "passed", caseCount: 54, acceptanceCasesExecuted: 20, extraCasesExecuted: 34,
      effects: { proposals: 35, writes: 13, replaysBlocked: 3, recoveries: 25, resumptions: 13, reuse: 13, quarantines: 8, incorrectSideEffectsSurviving: 0 },
      composition: { handwrittenReusableSourceFiles: 2, frozenDeclarativeContracts: 2, frozenDeclarativeFaults: 27, caseSpecificExecutableFilesAfterFreeze: 0 },
      modelCalls: 0, paidSpendUsd: 0,
    });
    expect(receipt.cases.filter((item) => item.acceptanceCase)).toHaveLength(20);
    for (const result of receipt.cases) {
      const contract = receipt.contracts.find((entry) => entry.contractId === result.contractId)!;
      expect(result.actualStatus, `${result.contractId}/${result.fault}`).toBe(expectedStatus(result.fault, contract.orderingPolicy));
      expect(result.status).toBe("passed");
    }
  });

  it("blocks trust, freshness, replay and ambiguity faults before any action write", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf-008-fail-closed-")); roots.push(root);
    const receipt = await runSignedMessageCleanFamily(fileURLToPath(validation), root);
    const preAction = new Set(["tampered", "unknown-key", "revoked-key", "expired-key", "algorithm-confusion", "cross-tenant", "stale-timestamp", "future-timestamp", "replayed-message", "schema-ambiguity"]);
    for (const result of receipt.cases.filter((item) => preAction.has(item.fault))) {
      expect(result.actualStatus).toBe("blocked");
      expect(result.writes).toBe(0);
    }
    const strictOrder = receipt.cases.find((item) => item.contractId === "json-detached-orders" && item.fault === "reordered-message")!;
    const uniqueOrder = receipt.cases.find((item) => item.contractId === "fixed-embedded-orders" && item.fault === "reordered-message")!;
    expect(strictOrder).toMatchObject({ actualStatus: "blocked", replaysBlocked: 1, writes: 0 });
    expect(uniqueOrder).toMatchObject({ actualStatus: "completed", replaysBlocked: 0, writes: 1 });
  });

  it("fails closed if frozen family material no longer matches the campaign seal", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf-008-seal-")); roots.push(root);
    const copied = join(root, "validation");
    const work = join(root, "work");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(copied, { recursive: true });
    writeFileSync(join(copied, "family.json"), `${JSON.stringify({ ...family, frozenAt: "2026-08-14T12:00:01.000Z" })}\n`);
    writeFileSync(join(copied, "campaign-seal.json"), readFileSync(new URL("campaign-seal.json", validation)));
    await expect(runSignedMessageCleanFamily(copied, work)).rejects.toThrow(/seal failed/);
  });
});
