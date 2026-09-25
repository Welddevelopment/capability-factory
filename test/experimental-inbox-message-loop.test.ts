import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FICTIONAL_INBOX_TENANT,
  FictionalInboxOrderWorld,
  fictionalOrderEmail,
} from "../src/customer-world/inbox-order-world.js";
import {
  inboxMessageOperationKey,
  inboxMessageOutputAlias,
} from "../src/experimental/inbox-message-driver.js";
import { PersistentInboxMessageCapabilityRegistry } from "../src/experimental/inbox-message-registry.js";

const roots: string[] = [];

function world(): FictionalInboxOrderWorld {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-inbox-message-"));
  roots.push(root);
  return new FictionalInboxOrderWorld(root);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("experimental inbox-message capability loop", () => {
  it("builds, verifies, creates one draft, resumes, retains, and reuses in a fresh SDK", async () => {
    const fixture = world();
    const first = fixture.writeMessage({
      fileAlias: "order-1.eml",
      purchaseOrderNumber: "ORDER-1",
      messageId: "<order-1@east-industrial.example>",
      lines: [
        { itemCode: "BOLT-10", quantity: 4 },
        { itemCode: "FILTER-42", quantity: 2 },
      ],
    });
    const firstResult = await fixture.sdk().completeGoal(fixture.request({
      requestId: "inbox-run-1",
      operationKey: first.operationKey,
      inputMessageAlias: "order-1.eml",
      expectedMessageSha256: first.sha256,
    }));
    expect(firstResult.status).toBe("completed");
    if (firstResult.status !== "completed") throw new Error("Expected inbox completion.");
    expect(firstResult.path).toBe("built-capability");
    expect(firstResult.parent).toMatchObject({ resumed: true, completed: true });
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

    const second = fixture.writeMessage({
      fileAlias: "order-2.eml",
      purchaseOrderNumber: "ORDER-2",
      messageId: "<order-2@east-industrial.example>",
      lines: [{ itemCode: "GLOVE-7", quantity: 15 }],
    });
    const secondResult = await fixture.sdk().completeGoal(fixture.request({
      requestId: "inbox-run-2",
      operationKey: second.operationKey,
      inputMessageAlias: "order-2.eml",
      expectedMessageSha256: second.sha256,
    }));
    expect(secondResult.status).toBe("completed");
    if (secondResult.status !== "completed") throw new Error("Expected inbox reuse.");
    expect(secondResult.path).toBe("retained-capability");
    expect(fixture.listDrafts()).toHaveLength(2);
    const registry = new PersistentInboxMessageCapabilityRegistry(fixture.registryRoot);
    expect(registry.list(FICTIONAL_INBOX_TENANT)).toMatchObject([
      { status: "active", reuseCount: 1, origin: "built:trusted-inbox-template-builder-v1" },
    ]);
  });

  it("stops before draft creation when exact approval is absent", async () => {
    const fixture = world();
    const input = fixture.writeMessage({
      fileAlias: "approval.eml",
      purchaseOrderNumber: "APPROVAL-1",
      messageId: "<approval-1@east-industrial.example>",
      lines: [{ itemCode: "BOLT-10", quantity: 1 }],
    });
    const result = await fixture.sdk().completeGoal(fixture.request({
      requestId: "approval-stop",
      operationKey: input.operationKey,
      inputMessageAlias: "approval.eml",
      expectedMessageSha256: input.sha256,
      approvals: [],
    }));
    expect(result).toMatchObject({
      status: "blocked",
      parent: { resumed: false },
      handoff: { reason: "authority-missing", writesAttempted: 0 },
    });
    expect(fixture.listDrafts()).toEqual([]);
  });

  it("reconciles a lost response and does not create a duplicate on repetition", async () => {
    const fixture = world();
    const input = fixture.writeMessage({
      fileAlias: "lost.eml",
      purchaseOrderNumber: "LOST-1",
      messageId: "<lost-1@east-industrial.example>",
      lines: [{ itemCode: "FILTER-42", quantity: 2 }],
    });
    const request = fixture.request({
      requestId: "lost-first",
      operationKey: input.operationKey,
      inputMessageAlias: "lost.eml",
      expectedMessageSha256: input.sha256,
      simulateLostResponseAfterCommit: true,
    });
    const first = await fixture.sdk().completeGoal(request);
    expect(first.status).toBe("completed");
    if (first.status !== "completed") throw new Error("Expected reconciled inbox completion.");
    expect(first.execution).toMatchObject({ reconciled: true, writesAttempted: 1 });
    const repeated = await fixture.sdk().completeGoal({
      ...request,
      requestId: "lost-repeated",
      simulateLostResponseAfterCommit: false,
    });
    expect(repeated.status).toBe("completed");
    if (repeated.status !== "completed") throw new Error("Expected duplicate-safe inbox completion.");
    expect(repeated.execution).toMatchObject({ reconciled: true, writesAttempted: 0 });
    expect(fixture.listDrafts()).toHaveLength(1);
  });

  it("refuses an arbitrary operation identity for the same immutable Message-ID", async () => {
    const fixture = world();
    const input = fixture.writeMessage({
      fileAlias: "identity.eml",
      purchaseOrderNumber: "IDENTITY-1",
      messageId: "<identity-1@east-industrial.example>",
      lines: [{ itemCode: "BOLT-10", quantity: 2 }],
    });
    const result = await fixture.sdk().completeGoal(fixture.request({
      requestId: "wrong-operation-identity",
      operationKey: "caller-selected-duplicate-key",
      inputMessageAlias: "identity.eml",
      expectedMessageSha256: input.sha256,
    }));
    expect(result).toMatchObject({ status: "blocked", handoff: { writesAttempted: 0 } });
    expect(fixture.listDrafts()).toEqual([]);
  });

  it("refuses a valid-looking message without a customer-local trusted-ingress receipt", async () => {
    const fixture = world();
    const source = fictionalOrderEmail({
      fileAlias: "untrusted-ingress.eml",
      purchaseOrderNumber: "UNTRUSTED-1",
      messageId: "<untrusted-1@east-industrial.example>",
      lines: [{ itemCode: "BOLT-10", quantity: 1 }],
    });
    fs.writeFileSync(path.join(fixture.inboxRoot, "untrusted-ingress.eml"), source);
    const result = await fixture.sdk().completeGoal(fixture.request({
      requestId: "untrusted-ingress",
      operationKey: inboxMessageOperationKey("<untrusted-1@east-industrial.example>"),
      inputMessageAlias: "untrusted-ingress.eml",
      expectedMessageSha256: hash(source),
    }));
    expect(result).toMatchObject({ status: "blocked", handoff: { writesAttempted: 0 } });
    expect(fixture.listDrafts()).toEqual([]);
  });

  it("refuses a changed message, spoofed sender, subject mismatch, and attachment content type", async () => {
    const fixture = world();
    const changed = fixture.writeMessage({
      fileAlias: "changed.eml",
      purchaseOrderNumber: "CHANGED-1",
      messageId: "<changed-1@east-industrial.example>",
      lines: [{ itemCode: "BOLT-10", quantity: 1 }],
    });
    fs.appendFileSync(changed.filename, " ");
    const changedResult = await fixture.sdk().completeGoal(fixture.request({
      requestId: "changed-message",
      operationKey: changed.operationKey,
      inputMessageAlias: "changed.eml",
      expectedMessageSha256: changed.sha256,
    }));
    expect(changedResult).toMatchObject({ status: "blocked", handoff: { writesAttempted: 0 } });

    const valid = fictionalOrderEmail({
      fileAlias: "spoofed.eml",
      purchaseOrderNumber: "SPOOFED-1",
      messageId: "<spoofed-1@east-industrial.example>",
      lines: [{ itemCode: "BOLT-10", quantity: 1 }],
    });
    for (const [alias, source] of [
      ["spoofed.eml", valid.replace("orders@east-industrial.example", "attacker@example.test")],
      ["subject.eml", valid.replace("Subject: NEW ORDER SPOOFED-1", "Subject: NEW ORDER SOMETHING-ELSE")],
      ["attachment.eml", valid.replace("text/plain; charset=utf-8", "multipart/mixed; boundary=unsafe")],
    ] as const) {
      fs.writeFileSync(path.join(fixture.inboxRoot, alias), source);
      fixture.target.trustedIngressSha256ByAlias[alias] = hash(source);
      const result = await fixture.sdk().completeGoal(fixture.request({
        requestId: `reject-${alias}`,
        operationKey: `reject-${alias}`,
        inputMessageAlias: alias,
        expectedMessageSha256: hash(source),
      }));
      expect(result).toMatchObject({ status: "blocked", handoff: { writesAttempted: 0 } });
    }
    expect(fixture.listDrafts()).toEqual([]);
  });

  it("quarantines when a plausible draft is semantically altered", async () => {
    const fixture = world();
    const input = fixture.writeMessage({
      fileAlias: "semantic.eml",
      purchaseOrderNumber: "SEMANTIC-1",
      messageId: "<semantic-1@east-industrial.example>",
      lines: [{ itemCode: "FILTER-42", quantity: 5 }],
    });
    const request = fixture.request({
      requestId: "semantic-first",
      operationKey: input.operationKey,
      inputMessageAlias: "semantic.eml",
      expectedMessageSha256: input.sha256,
    });
    expect((await fixture.sdk().completeGoal(request)).status).toBe("completed");
    const outputPath = path.join(fixture.outputRoot, inboxMessageOutputAlias(request.operationKey));
    const altered = JSON.parse(fs.readFileSync(outputPath, "utf8")) as {
      lines: Array<{ quantity: number }>;
    };
    altered.lines[0]!.quantity = 500;
    fs.writeFileSync(outputPath, JSON.stringify(altered));
    const repeated = await fixture.sdk().completeGoal({ ...request, requestId: "semantic-recheck" });
    expect(repeated).toMatchObject({
      status: "blocked",
      handoff: { reason: "inbox-outcome-unsafe", writesAttempted: 0 },
    });
    const registry = new PersistentInboxMessageCapabilityRegistry(fixture.registryRoot);
    expect(registry.list(FICTIONAL_INBOX_TENANT)[0]?.status).toBe("quarantined");
  });

  it("keeps retained inbox capabilities tenant-separated", async () => {
    const fixture = world();
    const input = fixture.writeMessage({
      fileAlias: "tenant.eml",
      purchaseOrderNumber: "TENANT-1",
      messageId: "<tenant-1@east-industrial.example>",
      lines: [{ itemCode: "BOLT-10", quantity: 3 }],
    });
    const base = fixture.request({
      requestId: "tenant-one",
      operationKey: input.operationKey,
      inputMessageAlias: "tenant.eml",
      expectedMessageSha256: input.sha256,
    });
    expect((await fixture.sdk().completeGoal(base)).status).toBe("completed");
    const otherInput = fixture.writeMessage({
      fileAlias: "tenant-two.eml",
      purchaseOrderNumber: "TENANT-2",
      messageId: "<tenant-2@east-industrial.example>",
      lines: [{ itemCode: "FILTER-42", quantity: 2 }],
    });
    const other = await fixture.sdk().completeGoal({
      ...fixture.request({
        requestId: "tenant-two",
        operationKey: otherInput.operationKey,
        inputMessageAlias: "tenant-two.eml",
        expectedMessageSha256: otherInput.sha256,
      }),
      tenantId: "other-fictional-inbox-tenant",
    });
    expect(other.status).toBe("completed");
    if (other.status !== "completed") throw new Error("Expected other tenant inbox completion.");
    expect(other.path).toBe("built-capability");
    const registry = new PersistentInboxMessageCapabilityRegistry(fixture.registryRoot);
    expect(registry.list(FICTIONAL_INBOX_TENANT)).toHaveLength(1);
    expect(registry.list("other-fictional-inbox-tenant")).toHaveLength(1);
  });
});
