import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FICTIONAL_DRAFT_ALIAS,
  FICTIONAL_INBOX_ALIAS,
  FICTIONAL_INBOX_APPROVAL,
  FICTIONAL_INBOX_VERIFIER,
  FictionalInboxOrderWorld,
} from "../src/customer-world/inbox-order-world.js";
import {
  ExperimentalInboxMessageDriver,
  ExperimentalInboxMessagePolicyError,
  experimentalInboxMessageCapabilitySchema,
} from "../src/experimental/inbox-message-driver.js";

const roots: string[] = [];

function fixture(): FictionalInboxOrderWorld {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-inbox-driver-"));
  roots.push(root);
  return new FictionalInboxOrderWorld(root);
}

function manifest(world: FictionalInboxOrderWorld) {
  return experimentalInboxMessageCapabilitySchema.parse({
    schemaVersion: "0.1",
    capabilityMode: "experimental-inbox-message-actions",
    id: "inbox-driver-test-capability",
    needKey: "inbox-driver-test-need",
    inboxRootAlias: FICTIONAL_INBOX_ALIAS,
    outputRootAlias: FICTIONAL_DRAFT_ALIAS,
    contractHash: world.contractHash,
    inputFormat: "rfc822-plain-text-order",
    outputFormat: "canonical-draft-order-json",
    allowedFromAddress: "orders@east-industrial.example",
    allowedToAddress: "orders@fictional-buyer.example",
    subjectPrefix: "NEW ORDER ",
    allowedItemCodes: ["BOLT-10"],
    maxLineItems: 2,
    maxQuantityPerLine: 10,
    maxInputBytes: 10_000,
    approvalKey: FICTIONAL_INBOX_APPROVAL,
    outcomeVerifierKey: FICTIONAL_INBOX_VERIFIER,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("experimental inbox-message driver policy", () => {
  it("probes the message template in memory without writing a draft", async () => {
    const world = fixture();
    const target = world.target;
    const driver = new ExperimentalInboxMessageDriver({
      [FICTIONAL_INBOX_ALIAS]: target,
      [FICTIONAL_DRAFT_ALIAS]: target,
    });
    expect((await driver.verifyCapability(manifest(world))).passed).toBe(true);
    expect(fs.readdirSync(world.outputRoot)).toEqual([]);
  });

  it("rejects aliases that resolve to different reviewed targets", async () => {
    const world = fixture();
    const other = fixture();
    const driver = new ExperimentalInboxMessageDriver({
      [FICTIONAL_INBOX_ALIAS]: world.target,
      [FICTIONAL_DRAFT_ALIAS]: other.target,
    });
    await expect(driver.verifyCapability(manifest(world))).rejects.toBeInstanceOf(
      ExperimentalInboxMessagePolicyError,
    );
  });

  it("refuses path syntax before any message access", async () => {
    const world = fixture();
    const input = world.writeMessage({
      fileAlias: "safe.eml",
      purchaseOrderNumber: "SAFE-1",
      messageId: "<safe-1@east-industrial.example>",
      lines: [{ itemCode: "BOLT-10", quantity: 1 }],
    });
    const result = await world.sdk().completeGoal(world.request({
      requestId: "unsafe-path",
      operationKey: input.operationKey,
      inputMessageAlias: "../safe.eml",
      expectedMessageSha256: input.sha256,
    }));
    expect(result).toMatchObject({ status: "blocked", handoff: { writesAttempted: 0 } });
    expect(world.listDrafts()).toEqual([]);
  });

  it("preserves one attempted write and unknown status when post-write verification disappears", async () => {
    const world = fixture();
    const target = world.target;
    const driver = new ExperimentalInboxMessageDriver({
      [FICTIONAL_INBOX_ALIAS]: target,
      [FICTIONAL_DRAFT_ALIAS]: target,
    });
    const safeManifest = manifest(world);
    const input = world.writeMessage({
      fileAlias: "unknown.eml",
      purchaseOrderNumber: "UNKNOWN-1",
      messageId: "<unknown-1@east-industrial.example>",
      lines: [{ itemCode: "BOLT-10", quantity: 1 }],
    });
    const verification = await driver.verifyCapability(safeManifest);
    let calls = 0;
    const result = await driver.execute(
      safeManifest,
      {
        operationKey: input.operationKey,
        runId: "unknown-run",
        inputMessageAlias: "unknown.eml",
        expectedMessageSha256: input.sha256,
        approvals: [FICTIONAL_INBOX_APPROVAL],
        verification,
      },
      {
        key: FICTIONAL_INBOX_VERIFIER,
        verify: async () => {
          calls += 1;
          if (calls === 1) return { outcome: "not-started", detail: "No draft yet." };
          throw new Error("Verifier unavailable.");
        },
      },
    );
    expect(result).toMatchObject({
      status: "unknown",
      writesAttempted: 1,
      quarantined: true,
    });
    expect(fs.readdirSync(world.outputRoot)).toHaveLength(1);
  });
});
