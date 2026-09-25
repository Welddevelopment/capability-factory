import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FICTIONAL_EDI_APPROVAL,
  FICTIONAL_EDI_INPUT_ALIAS,
  FICTIONAL_EDI_OUTPUT_ALIAS,
  FictionalEdiFileTransferWorld,
} from "../src/customer-world/edi-file-transfer-world.js";
import {
  ExperimentalFileTransferDriver,
  ExperimentalFileTransferPolicyError,
  experimentalFileTransferCapabilitySchema,
} from "../src/experimental/file-transfer-driver.js";

const roots: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-file-driver-"));
  roots.push(root);
  return new FictionalEdiFileTransferWorld(root);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("experimental file-transfer driver policy", () => {
  it("probes in memory without writing to the business outbox", async () => {
    const world = fixture();
    const target = world.target;
    const driver = new ExperimentalFileTransferDriver({
      [FICTIONAL_EDI_INPUT_ALIAS]: target,
      [FICTIONAL_EDI_OUTPUT_ALIAS]: target,
    });
    const manifest = experimentalFileTransferCapabilitySchema.parse({
      schemaVersion: "0.1",
      capabilityMode: "experimental-file-transfer-actions",
      id: "probe-capability",
      needKey: "probe-need",
      inputRootAlias: FICTIONAL_EDI_INPUT_ALIAS,
      outputRootAlias: FICTIONAL_EDI_OUTPUT_ALIAS,
      contractHash: world.contractHash,
      inputFormat: "x12-850",
      outputFormat: "canonical-order-json",
      senderId: "EASTINDUSTRIAL",
      receiverId: "FICTIONALBUYER",
      allowedItemCodes: ["BOLT-10"],
      maxLineItems: 2,
      maxQuantityPerLine: 10,
      maxInputBytes: 10_000,
      approvalKey: FICTIONAL_EDI_APPROVAL,
      outcomeVerifierKey: "customer-outbox-order-verifier-v1",
    });
    const receipt = await driver.verifyCapability(manifest);
    expect(receipt.passed).toBe(true);
    expect(fs.readdirSync(world.outputRoot)).toEqual([]);
  });

  it("rejects root aliases that resolve to different reviewed targets", async () => {
    const world = fixture();
    const other = fixture();
    const driver = new ExperimentalFileTransferDriver({
      [FICTIONAL_EDI_INPUT_ALIAS]: world.target,
      [FICTIONAL_EDI_OUTPUT_ALIAS]: other.target,
    });
    const manifest = experimentalFileTransferCapabilitySchema.parse({
      schemaVersion: "0.1",
      capabilityMode: "experimental-file-transfer-actions",
      id: "split-target-capability",
      needKey: "split-target-need",
      inputRootAlias: FICTIONAL_EDI_INPUT_ALIAS,
      outputRootAlias: FICTIONAL_EDI_OUTPUT_ALIAS,
      contractHash: world.contractHash,
      inputFormat: "x12-850",
      outputFormat: "canonical-order-json",
      senderId: "EASTINDUSTRIAL",
      receiverId: "FICTIONALBUYER",
      allowedItemCodes: ["BOLT-10"],
      maxLineItems: 2,
      maxQuantityPerLine: 10,
      maxInputBytes: 10_000,
      approvalKey: FICTIONAL_EDI_APPROVAL,
      outcomeVerifierKey: "customer-outbox-order-verifier-v1",
    });
    await expect(driver.verifyCapability(manifest)).rejects.toBeInstanceOf(ExperimentalFileTransferPolicyError);
  });

  it("rejects path syntax before any file access", async () => {
    const world = fixture();
    const input = world.writeInput({
      fileAlias: "safe.edi",
      purchaseOrderNumber: "SAFE-1",
      lines: [{ itemCode: "BOLT-10", quantity: 1 }],
    });
    const result = await world.sdk().completeGoal(world.request({
      requestId: "unsafe-path",
      operationKey: "unsafe-path-operation",
      inputFileAlias: "../safe.edi",
      expectedInputSha256: input.sha256,
    }));
    expect(result).toMatchObject({ status: "blocked", handoff: { writesAttempted: 0 } });
    expect(world.listOutputs()).toEqual([]);
  });

  it("reports one attempted write and quarantines when post-write verification becomes unavailable", async () => {
    const world = fixture();
    const target = world.target;
    const driver = new ExperimentalFileTransferDriver({
      [FICTIONAL_EDI_INPUT_ALIAS]: target,
      [FICTIONAL_EDI_OUTPUT_ALIAS]: target,
    });
    const manifest = experimentalFileTransferCapabilitySchema.parse({
      schemaVersion: "0.1",
      capabilityMode: "experimental-file-transfer-actions",
      id: "unknown-outcome-capability",
      needKey: "unknown-outcome-need",
      inputRootAlias: FICTIONAL_EDI_INPUT_ALIAS,
      outputRootAlias: FICTIONAL_EDI_OUTPUT_ALIAS,
      contractHash: world.contractHash,
      inputFormat: "x12-850",
      outputFormat: "canonical-order-json",
      senderId: "EASTINDUSTRIAL",
      receiverId: "FICTIONALBUYER",
      allowedItemCodes: ["BOLT-10"],
      maxLineItems: 2,
      maxQuantityPerLine: 10,
      maxInputBytes: 10_000,
      approvalKey: FICTIONAL_EDI_APPROVAL,
      outcomeVerifierKey: "customer-outbox-order-verifier-v1",
    });
    const input = world.writeInput({
      fileAlias: "unknown.edi",
      purchaseOrderNumber: "UNKNOWN-1",
      lines: [{ itemCode: "BOLT-10", quantity: 1 }],
    });
    const verification = await driver.verifyCapability(manifest);
    let calls = 0;
    const result = await driver.execute(
      manifest,
      {
        operationKey: "unknown-outcome-operation",
        runId: "unknown-outcome-run",
        inputFileAlias: "unknown.edi",
        expectedInputSha256: input.sha256,
        approvals: [FICTIONAL_EDI_APPROVAL],
        verification,
      },
      {
        key: "customer-outbox-order-verifier-v1",
        verify: async () => {
          calls += 1;
          if (calls === 1) return { outcome: "not-started", detail: "No output yet." };
          throw new Error("Verifier unavailable.");
        },
      },
    );
    expect(result).toMatchObject({
      status: "unknown",
      writesAttempted: 1,
      quarantined: true,
    });
    const outputFiles = fs.readdirSync(world.outputRoot);
    expect(outputFiles).toHaveLength(1);
    expect(createHash("sha256").update(fs.readFileSync(path.join(world.outputRoot, outputFiles[0]!))).digest("hex"))
      .toMatch(/^[a-f0-9]{64}$/);
  });
});
