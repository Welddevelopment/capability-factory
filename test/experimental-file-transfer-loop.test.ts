import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FICTIONAL_EDI_APPROVAL,
  FICTIONAL_EDI_TENANT,
  FictionalEdiFileTransferWorld,
  fictionalX12PurchaseOrder,
} from "../src/customer-world/edi-file-transfer-world.js";
import { fileTransferOutputAlias } from "../src/experimental/file-transfer-driver.js";
import { PersistentFileTransferCapabilityRegistry } from "../src/experimental/file-transfer-registry.js";

const roots: string[] = [];

function world(): FictionalEdiFileTransferWorld {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-file-transfer-"));
  roots.push(root);
  return new FictionalEdiFileTransferWorld(root);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("experimental file-transfer capability loop", () => {
  it("builds, verifies, acts, resumes, retains, and reuses across a fresh SDK process", async () => {
    const fixture = world();
    const first = fixture.writeInput({
      fileAlias: "east-1001.edi",
      purchaseOrderNumber: "EAST-1001",
      lines: [
        { itemCode: "BOLT-10", quantity: 12 },
        { itemCode: "FILTER-42", quantity: 3 },
      ],
    });
    const firstResult = await fixture.sdk().completeGoal(fixture.request({
      requestId: "file-run-1",
      operationKey: "east-order-1001",
      inputFileAlias: "east-1001.edi",
      expectedInputSha256: first.sha256,
    }));

    expect(firstResult.status).toBe("completed");
    if (firstResult.status !== "completed") throw new Error("Expected completed first result.");
    expect(firstResult.path).toBe("built-capability");
    expect(firstResult.parent).toMatchObject({ resumed: true, completed: true });
    expect(firstResult.execution.writesAttempted).toBe(1);
    expect(firstResult.events.map((event) => event.stage)).toEqual([
      "diagnosis.completed",
      "search.retained.completed",
      "search.trusted.completed",
      "build.completed",
      "capability.verification.completed",
      "capability.retained",
      "execution.completed",
      "outcome.verification.completed",
      "resumption.completed",
    ]);

    const second = fixture.writeInput({
      fileAlias: "east-1002.edi",
      purchaseOrderNumber: "EAST-1002",
      lines: [{ itemCode: "GLOVE-7", quantity: 40 }],
    });
    const secondResult = await fixture.sdk().completeGoal(fixture.request({
      requestId: "file-run-2",
      operationKey: "east-order-1002",
      inputFileAlias: "east-1002.edi",
      expectedInputSha256: second.sha256,
    }));

    expect(secondResult.status).toBe("completed");
    if (secondResult.status !== "completed") throw new Error("Expected completed reuse result.");
    expect(secondResult.path).toBe("retained-capability");
    expect(secondResult.events.some((event) => event.stage === "build.completed")).toBe(false);
    expect(fixture.listOutputs()).toHaveLength(2);
    const registry = new PersistentFileTransferCapabilityRegistry(fixture.registryRoot);
    expect(registry.list(FICTIONAL_EDI_TENANT)).toMatchObject([
      { status: "active", reuseCount: 1, origin: "built:trusted-partner-contract-builder-v1" },
    ]);
  });

  it("stops before any business write when exact approval is missing", async () => {
    const fixture = world();
    const source = fixture.writeInput({
      fileAlias: "approval.edi",
      purchaseOrderNumber: "APPROVAL-1",
      lines: [{ itemCode: "BOLT-10", quantity: 1 }],
    });
    const result = await fixture.sdk().completeGoal(fixture.request({
      requestId: "file-approval-stop",
      operationKey: "approval-stop",
      inputFileAlias: "approval.edi",
      expectedInputSha256: source.sha256,
      approvals: [],
    }));

    expect(result).toMatchObject({
      status: "blocked",
      parent: { resumed: false, completed: false },
      handoff: { reason: "authority-missing", writesAttempted: 0 },
    });
    expect(fixture.listOutputs()).toEqual([]);
  });

  it("reconciles a lost response and refuses a duplicate on a repeated request", async () => {
    const fixture = world();
    const source = fixture.writeInput({
      fileAlias: "lost-response.edi",
      purchaseOrderNumber: "LOST-1",
      lines: [{ itemCode: "FILTER-42", quantity: 2 }],
    });
    const request = fixture.request({
      requestId: "lost-response-run",
      operationKey: "lost-response-operation",
      inputFileAlias: "lost-response.edi",
      expectedInputSha256: source.sha256,
      simulateLostResponseAfterCommit: true,
    });
    const first = await fixture.sdk().completeGoal(request);
    expect(first.status).toBe("completed");
    if (first.status !== "completed") throw new Error("Expected reconciled completion.");
    expect(first.execution).toMatchObject({ reconciled: true, writesAttempted: 1 });
    expect(fixture.listOutputs()).toHaveLength(1);

    const repeated = await fixture.sdk().completeGoal({
      ...request,
      requestId: "lost-response-repeated",
      simulateLostResponseAfterCommit: false,
    });
    expect(repeated.status).toBe("completed");
    if (repeated.status !== "completed") throw new Error("Expected duplicate-safe completion.");
    expect(repeated.execution).toMatchObject({ reconciled: true, writesAttempted: 0 });
    expect(fixture.listOutputs()).toHaveLength(1);
  });

  it("refuses changed input, an untrusted sender, and an unapproved item", async () => {
    const fixture = world();
    const changed = fixture.writeInput({
      fileAlias: "changed.edi",
      purchaseOrderNumber: "CHANGED-1",
      lines: [{ itemCode: "BOLT-10", quantity: 1 }],
    });
    fs.appendFileSync(changed.filename, "\n");
    const changedResult = await fixture.sdk().completeGoal(fixture.request({
      requestId: "changed-run",
      operationKey: "changed-operation",
      inputFileAlias: "changed.edi",
      expectedInputSha256: changed.sha256,
    }));
    expect(changedResult).toMatchObject({ status: "blocked", handoff: { writesAttempted: 0 } });

    const wrongSenderSource = fictionalX12PurchaseOrder({
      fileAlias: "wrong-sender.edi",
      purchaseOrderNumber: "SENDER-1",
      lines: [{ itemCode: "BOLT-10", quantity: 1 }],
    }).replace("EASTINDUSTRIAL", "UNKNOWNPARTNER");
    fs.writeFileSync(path.join(fixture.inputRoot, "wrong-sender.edi"), wrongSenderSource);
    const wrongSender = await fixture.sdk().completeGoal(fixture.request({
      requestId: "wrong-sender-run",
      operationKey: "wrong-sender-operation",
      inputFileAlias: "wrong-sender.edi",
      expectedInputSha256: hash(wrongSenderSource),
    }));
    expect(wrongSender).toMatchObject({ status: "blocked", handoff: { writesAttempted: 0 } });

    const wrongItemSource = fictionalX12PurchaseOrder({
      fileAlias: "wrong-item.edi",
      purchaseOrderNumber: "ITEM-1",
      lines: [{ itemCode: "BOLT-10", quantity: 1 }],
    }).replace("BOLT-10", "UNAPPROVED-99");
    fs.writeFileSync(path.join(fixture.inputRoot, "wrong-item.edi"), wrongItemSource);
    const wrongItem = await fixture.sdk().completeGoal(fixture.request({
      requestId: "wrong-item-run",
      operationKey: "wrong-item-operation",
      inputFileAlias: "wrong-item.edi",
      expectedInputSha256: hash(wrongItemSource),
    }));
    expect(wrongItem).toMatchObject({ status: "blocked", handoff: { writesAttempted: 0 } });
    expect(fixture.listOutputs()).toEqual([]);
  });

  it("quarantines an exact capability when existing external state is incorrect", async () => {
    const fixture = world();
    const source = fixture.writeInput({
      fileAlias: "incorrect.edi",
      purchaseOrderNumber: "INCORRECT-1",
      lines: [{ itemCode: "BOLT-10", quantity: 2 }],
    });
    const operationKey = "incorrect-existing-output";
    fs.writeFileSync(
      path.join(fixture.outputRoot, fileTransferOutputAlias(operationKey)),
      JSON.stringify({ schemaVersion: "1", operationKey, sourceFile: "other.edi" }),
    );
    const result = await fixture.sdk().completeGoal(fixture.request({
      requestId: "incorrect-run",
      operationKey,
      inputFileAlias: "incorrect.edi",
      expectedInputSha256: source.sha256,
      approvals: [FICTIONAL_EDI_APPROVAL],
    }));

    expect(result).toMatchObject({
      status: "blocked",
      handoff: { reason: "file-outcome-unsafe", writesAttempted: 0 },
    });
    const registry = new PersistentFileTransferCapabilityRegistry(fixture.registryRoot);
    expect(registry.list(FICTIONAL_EDI_TENANT)[0]?.status).toBe("quarantined");
  });

  it("independently catches a plausible but semantically altered output", async () => {
    const fixture = world();
    const source = fixture.writeInput({
      fileAlias: "semantic.edi",
      purchaseOrderNumber: "SEMANTIC-1",
      lines: [{ itemCode: "FILTER-42", quantity: 5 }],
    });
    const request = fixture.request({
      requestId: "semantic-first",
      operationKey: "semantic-operation",
      inputFileAlias: "semantic.edi",
      expectedInputSha256: source.sha256,
    });
    const completed = await fixture.sdk().completeGoal(request);
    expect(completed.status).toBe("completed");

    const outputPath = path.join(fixture.outputRoot, fileTransferOutputAlias(request.operationKey));
    const altered = JSON.parse(fs.readFileSync(outputPath, "utf8")) as {
      lines: Array<{ quantity: number }>;
    };
    altered.lines[0]!.quantity = 500;
    fs.writeFileSync(outputPath, JSON.stringify(altered));

    const repeated = await fixture.sdk().completeGoal({
      ...request,
      requestId: "semantic-recheck",
    });
    expect(repeated).toMatchObject({
      status: "blocked",
      handoff: { reason: "file-outcome-unsafe", writesAttempted: 0 },
    });
    const registry = new PersistentFileTransferCapabilityRegistry(fixture.registryRoot);
    expect(registry.list(FICTIONAL_EDI_TENANT)[0]?.status).toBe("quarantined");
  });

  it("keeps retained capabilities tenant-separated", async () => {
    const fixture = world();
    const source = fixture.writeInput({
      fileAlias: "tenant.edi",
      purchaseOrderNumber: "TENANT-1",
      lines: [{ itemCode: "BOLT-10", quantity: 3 }],
    });
    const base = fixture.request({
      requestId: "tenant-one",
      operationKey: "tenant-one-operation",
      inputFileAlias: "tenant.edi",
      expectedInputSha256: source.sha256,
    });
    const first = await fixture.sdk().completeGoal(base);
    expect(first.status).toBe("completed");

    const other = await fixture.sdk().completeGoal({
      ...base,
      tenantId: "other-fictional-tenant",
      requestId: "tenant-two",
      operationKey: "tenant-two-operation",
    });
    expect(other.status).toBe("completed");
    if (other.status !== "completed") throw new Error("Expected other tenant completion.");
    expect(other.path).toBe("built-capability");
    const registry = new PersistentFileTransferCapabilityRegistry(fixture.registryRoot);
    expect(registry.list(FICTIONAL_EDI_TENANT)).toHaveLength(1);
    expect(registry.list("other-fictional-tenant")).toHaveLength(1);
  });
});
