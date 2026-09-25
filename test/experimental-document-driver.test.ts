import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FICTIONAL_DOCUMENT_APPROVAL,
  FICTIONAL_DOCUMENT_INPUT_ALIAS,
  FICTIONAL_DOCUMENT_OUTPUT_ALIAS,
  FICTIONAL_DOCUMENT_VERIFIER,
  FictionalPdfOrderWorld,
} from "../src/customer-world/pdf-order-world.js";
import {
  ExperimentalDocumentDriver,
  ExperimentalDocumentPolicyError,
  experimentalDocumentCapabilitySchema,
} from "../src/experimental/document-driver.js";

const roots: string[] = [];

async function fixture(): Promise<FictionalPdfOrderWorld> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-document-driver-"));
  roots.push(root);
  return FictionalPdfOrderWorld.create(root);
}

function manifest(world: FictionalPdfOrderWorld) {
  return experimentalDocumentCapabilitySchema.parse({
    schemaVersion: "0.1",
    capabilityMode: "experimental-document-actions",
    id: "document-driver-test-capability",
    needKey: "document-driver-test-need",
    inputRootAlias: FICTIONAL_DOCUMENT_INPUT_ALIAS,
    outputRootAlias: FICTIONAL_DOCUMENT_OUTPUT_ALIAS,
    contractHash: world.contractHash,
    inputFormat: "machine-readable-pdf-order-v1",
    outputFormat: "canonical-draft-order-json",
    templateTitle: "EAST INDUSTRIAL PURCHASE ORDER",
    templateVersion: "1",
    allowedItemCodes: ["BOLT-10"],
    maxLineItems: 2,
    maxQuantityPerLine: 10,
    maxInputBytes: 1_000_000,
    approvalKey: FICTIONAL_DOCUMENT_APPROVAL,
    outcomeVerifierKey: FICTIONAL_DOCUMENT_VERIFIER,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("experimental document driver policy", () => {
  it("probes a real machine-readable PDF in memory without writing a draft", async () => {
    const world = await fixture();
    const target = world.target;
    const driver = new ExperimentalDocumentDriver({
      [FICTIONAL_DOCUMENT_INPUT_ALIAS]: target,
      [FICTIONAL_DOCUMENT_OUTPUT_ALIAS]: target,
    });
    expect((await driver.verifyCapability(manifest(world))).passed).toBe(true);
    expect(fs.readdirSync(world.outputRoot)).toEqual([]);
  });

  it("rejects aliases that resolve to different reviewed targets", async () => {
    const world = await fixture();
    const other = await fixture();
    const driver = new ExperimentalDocumentDriver({
      [FICTIONAL_DOCUMENT_INPUT_ALIAS]: world.target,
      [FICTIONAL_DOCUMENT_OUTPUT_ALIAS]: other.target,
    });
    await expect(driver.verifyCapability(manifest(world))).rejects.toBeInstanceOf(ExperimentalDocumentPolicyError);
  });

  it("refuses path syntax before document access", async () => {
    const world = await fixture();
    const input = await world.writeDocument({
      fileAlias: "safe.pdf",
      documentId: "SAFE-1",
      purchaseOrderNumber: "SAFE-1",
      lines: [{ itemCode: "BOLT-10", quantity: 1 }],
    });
    const result = await world.sdk().completeGoal(world.request({
      requestId: "unsafe-path",
      operationKey: input.operationKey,
      inputDocumentAlias: "../safe.pdf",
      expectedDocumentSha256: input.sha256,
    }));
    expect(result).toMatchObject({ status: "blocked", handoff: { writesAttempted: 0 } });
    expect(world.listDrafts()).toEqual([]);
  });

  it("preserves one attempted write and unknown status when post-write verification disappears", async () => {
    const world = await fixture();
    const target = world.target;
    const driver = new ExperimentalDocumentDriver({
      [FICTIONAL_DOCUMENT_INPUT_ALIAS]: target,
      [FICTIONAL_DOCUMENT_OUTPUT_ALIAS]: target,
    });
    const safeManifest = manifest(world);
    const input = await world.writeDocument({
      fileAlias: "unknown.pdf",
      documentId: "UNKNOWN-1",
      purchaseOrderNumber: "UNKNOWN-1",
      lines: [{ itemCode: "BOLT-10", quantity: 1 }],
    });
    const verification = await driver.verifyCapability(safeManifest);
    let calls = 0;
    const result = await driver.execute(
      safeManifest,
      {
        operationKey: input.operationKey,
        runId: "unknown-run",
        inputDocumentAlias: "unknown.pdf",
        expectedDocumentSha256: input.sha256,
        approvals: [FICTIONAL_DOCUMENT_APPROVAL],
        verification,
      },
      {
        key: FICTIONAL_DOCUMENT_VERIFIER,
        verify: async () => {
          calls += 1;
          if (calls === 1) return { outcome: "not-started", detail: "No draft yet." };
          throw new Error("Verifier unavailable.");
        },
      },
    );
    expect(result).toMatchObject({ status: "unknown", writesAttempted: 1, quarantined: true });
    expect(fs.readdirSync(world.outputRoot)).toHaveLength(1);
  });
});
