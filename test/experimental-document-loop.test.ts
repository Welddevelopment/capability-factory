import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, it } from "vitest";
import {
  FICTIONAL_DOCUMENT_TENANT,
  FictionalPdfOrderWorld,
  fictionalPdfOrder,
} from "../src/customer-world/pdf-order-world.js";
import {
  documentOperationKey,
  documentOutputAlias,
} from "../src/experimental/document-driver.js";
import { PersistentDocumentCapabilityRegistry } from "../src/experimental/document-registry.js";

const roots: string[] = [];

async function world(): Promise<FictionalPdfOrderWorld> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-document-"));
  roots.push(root);
  return FictionalPdfOrderWorld.create(root);
}

function hash(value: Uint8Array | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("experimental document capability loop", () => {
  it("builds, verifies, creates one draft, resumes, retains, and reuses in a fresh SDK", async () => {
    const fixture = await world();
    const first = await fixture.writeDocument({
      fileAlias: "order-1.pdf",
      documentId: "DOC-1",
      purchaseOrderNumber: "ORDER-1",
      lines: [
        { itemCode: "BOLT-10", quantity: 4 },
        { itemCode: "FILTER-42", quantity: 2 },
      ],
    });
    const firstResult = await fixture.sdk().completeGoal(fixture.request({
      requestId: "document-run-1",
      operationKey: first.operationKey,
      inputDocumentAlias: "order-1.pdf",
      expectedDocumentSha256: first.sha256,
    }));
    expect(firstResult.status).toBe("completed");
    if (firstResult.status !== "completed") throw new Error("Expected document completion.");
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

    const second = await fixture.writeDocument({
      fileAlias: "order-2.pdf",
      documentId: "DOC-2",
      purchaseOrderNumber: "ORDER-2",
      lines: [{ itemCode: "GLOVE-7", quantity: 10 }],
    });
    const secondResult = await fixture.sdk().completeGoal(fixture.request({
      requestId: "document-run-2",
      operationKey: second.operationKey,
      inputDocumentAlias: "order-2.pdf",
      expectedDocumentSha256: second.sha256,
    }));
    expect(secondResult.status).toBe("completed");
    if (secondResult.status !== "completed") throw new Error("Expected document reuse.");
    expect(secondResult.path).toBe("retained-capability");
    expect(fixture.listDrafts()).toHaveLength(2);
    const registry = new PersistentDocumentCapabilityRegistry(fixture.registryRoot);
    expect(registry.list(FICTIONAL_DOCUMENT_TENANT)).toMatchObject([
      { status: "active", reuseCount: 1, origin: "built:trusted-document-template-builder-v1" },
    ]);
  });

  it("stops before draft creation when approval is absent", async () => {
    const fixture = await world();
    const input = await fixture.writeDocument({
      fileAlias: "approval.pdf",
      documentId: "APPROVAL-1",
      purchaseOrderNumber: "APPROVAL-1",
      lines: [{ itemCode: "BOLT-10", quantity: 1 }],
    });
    const result = await fixture.sdk().completeGoal(fixture.request({
      requestId: "approval-stop",
      operationKey: input.operationKey,
      inputDocumentAlias: "approval.pdf",
      expectedDocumentSha256: input.sha256,
      approvals: [],
    }));
    expect(result).toMatchObject({ status: "blocked", handoff: { reason: "authority-missing", writesAttempted: 0 } });
    expect(fixture.listDrafts()).toEqual([]);
  });

  it("reconciles a lost response and refuses a duplicate", async () => {
    const fixture = await world();
    const input = await fixture.writeDocument({
      fileAlias: "lost.pdf",
      documentId: "LOST-1",
      purchaseOrderNumber: "LOST-1",
      lines: [{ itemCode: "FILTER-42", quantity: 2 }],
    });
    const request = fixture.request({
      requestId: "lost-first",
      operationKey: input.operationKey,
      inputDocumentAlias: "lost.pdf",
      expectedDocumentSha256: input.sha256,
      simulateLostResponseAfterCommit: true,
    });
    const first = await fixture.sdk().completeGoal(request);
    expect(first.status).toBe("completed");
    if (first.status !== "completed") throw new Error("Expected reconciled document completion.");
    expect(first.execution).toMatchObject({ reconciled: true, writesAttempted: 1 });
    const repeated = await fixture.sdk().completeGoal({
      ...request,
      requestId: "lost-repeated",
      simulateLostResponseAfterCommit: false,
    });
    expect(repeated.status).toBe("completed");
    if (repeated.status !== "completed") throw new Error("Expected duplicate-safe document completion.");
    expect(repeated.execution).toMatchObject({ reconciled: true, writesAttempted: 0 });
    expect(fixture.listDrafts()).toHaveLength(1);
  });

  it("binds duplicate identity to Document-ID and requires trusted ingress", async () => {
    const fixture = await world();
    const input = await fixture.writeDocument({
      fileAlias: "identity.pdf",
      documentId: "IDENTITY-1",
      purchaseOrderNumber: "IDENTITY-1",
      lines: [{ itemCode: "BOLT-10", quantity: 2 }],
    });
    const wrongIdentity = await fixture.sdk().completeGoal(fixture.request({
      requestId: "wrong-identity",
      operationKey: "caller-selected-document-key",
      inputDocumentAlias: "identity.pdf",
      expectedDocumentSha256: input.sha256,
    }));
    expect(wrongIdentity).toMatchObject({ status: "blocked", handoff: { writesAttempted: 0 } });

    const source = await fictionalPdfOrder({
      fileAlias: "untrusted.pdf",
      documentId: "UNTRUSTED-1",
      purchaseOrderNumber: "UNTRUSTED-1",
      lines: [{ itemCode: "BOLT-10", quantity: 1 }],
    });
    fs.writeFileSync(path.join(fixture.inputRoot, "untrusted.pdf"), source);
    const untrusted = await fixture.sdk().completeGoal(fixture.request({
      requestId: "untrusted-ingress",
      operationKey: documentOperationKey("UNTRUSTED-1"),
      inputDocumentAlias: "untrusted.pdf",
      expectedDocumentSha256: hash(source),
    }));
    expect(untrusted).toMatchObject({ status: "blocked", handoff: { writesAttempted: 0 } });
    expect(fixture.listDrafts()).toEqual([]);
  });

  it("refuses changed PDFs, unapproved items, scanned pages, and multi-page documents", async () => {
    const fixture = await world();
    const changed = await fixture.writeDocument({
      fileAlias: "changed.pdf",
      documentId: "CHANGED-1",
      purchaseOrderNumber: "CHANGED-1",
      lines: [{ itemCode: "BOLT-10", quantity: 1 }],
    });
    fs.appendFileSync(changed.filename, Buffer.from([0]));
    const changedResult = await fixture.sdk().completeGoal(fixture.request({
      requestId: "changed",
      operationKey: changed.operationKey,
      inputDocumentAlias: "changed.pdf",
      expectedDocumentSha256: changed.sha256,
    }));
    expect(changedResult).toMatchObject({ status: "blocked", handoff: { writesAttempted: 0 } });

    const unapprovedSource = await fictionalPdfOrder({
      fileAlias: "unapproved.pdf",
      documentId: "UNAPPROVED-1",
      purchaseOrderNumber: "UNAPPROVED-1",
      lines: [{ itemCode: "UNKNOWN-99", quantity: 1 }],
    });
    fs.writeFileSync(path.join(fixture.inputRoot, "unapproved.pdf"), unapprovedSource);
    fixture.target.trustedIngressSha256ByAlias["unapproved.pdf"] = hash(unapprovedSource);
    const unapproved = await fixture.sdk().completeGoal(fixture.request({
      requestId: "unapproved",
      operationKey: documentOperationKey("UNAPPROVED-1"),
      inputDocumentAlias: "unapproved.pdf",
      expectedDocumentSha256: hash(unapprovedSource),
    }));
    expect(unapproved).toMatchObject({ status: "blocked", handoff: { writesAttempted: 0 } });

    for (const [alias, pages] of [["scanned.pdf", 1], ["multi-page.pdf", 2]] as const) {
      const pdf = await PDFDocument.create();
      for (let page = 0; page < pages; page += 1) pdf.addPage([612, 792]);
      const bytes = await pdf.save();
      fs.writeFileSync(path.join(fixture.inputRoot, alias), bytes);
      fixture.target.trustedIngressSha256ByAlias[alias] = hash(bytes);
      const result = await fixture.sdk().completeGoal(fixture.request({
        requestId: alias,
        operationKey: documentOperationKey(alias),
        inputDocumentAlias: alias,
        expectedDocumentSha256: hash(bytes),
      }));
      expect(result).toMatchObject({ status: "blocked", handoff: { writesAttempted: 0 } });
    }
    expect(fixture.listDrafts()).toEqual([]);
  });

  it("quarantines when the independently expected draft is semantically altered", async () => {
    const fixture = await world();
    const input = await fixture.writeDocument({
      fileAlias: "semantic.pdf",
      documentId: "SEMANTIC-1",
      purchaseOrderNumber: "SEMANTIC-1",
      lines: [{ itemCode: "FILTER-42", quantity: 5 }],
    });
    const request = fixture.request({
      requestId: "semantic-first",
      operationKey: input.operationKey,
      inputDocumentAlias: "semantic.pdf",
      expectedDocumentSha256: input.sha256,
    });
    expect((await fixture.sdk().completeGoal(request)).status).toBe("completed");
    const outputPath = path.join(fixture.outputRoot, documentOutputAlias(request.operationKey));
    const altered = JSON.parse(fs.readFileSync(outputPath, "utf8")) as { lines: Array<{ quantity: number }> };
    altered.lines[0]!.quantity = 500;
    fs.writeFileSync(outputPath, JSON.stringify(altered));
    const repeated = await fixture.sdk().completeGoal({ ...request, requestId: "semantic-recheck" });
    expect(repeated).toMatchObject({ status: "blocked", handoff: { reason: "document-outcome-unsafe", writesAttempted: 0 } });
    const registry = new PersistentDocumentCapabilityRegistry(fixture.registryRoot);
    expect(registry.list(FICTIONAL_DOCUMENT_TENANT)[0]?.status).toBe("quarantined");
  });

  it("keeps retained document capabilities tenant-separated", async () => {
    const fixture = await world();
    const first = await fixture.writeDocument({
      fileAlias: "tenant-one.pdf",
      documentId: "TENANT-1",
      purchaseOrderNumber: "TENANT-1",
      lines: [{ itemCode: "BOLT-10", quantity: 1 }],
    });
    expect((await fixture.sdk().completeGoal(fixture.request({
      requestId: "tenant-one",
      operationKey: first.operationKey,
      inputDocumentAlias: "tenant-one.pdf",
      expectedDocumentSha256: first.sha256,
    }))).status).toBe("completed");
    const second = await fixture.writeDocument({
      fileAlias: "tenant-two.pdf",
      documentId: "TENANT-2",
      purchaseOrderNumber: "TENANT-2",
      lines: [{ itemCode: "FILTER-42", quantity: 2 }],
    });
    const other = await fixture.sdk().completeGoal({
      ...fixture.request({
        requestId: "tenant-two",
        operationKey: second.operationKey,
        inputDocumentAlias: "tenant-two.pdf",
        expectedDocumentSha256: second.sha256,
      }),
      tenantId: "other-document-tenant",
    });
    expect(other.status).toBe("completed");
    if (other.status !== "completed") throw new Error("Expected other document tenant completion.");
    expect(other.path).toBe("built-capability");
    const registry = new PersistentDocumentCapabilityRegistry(fixture.registryRoot);
    expect(registry.list(FICTIONAL_DOCUMENT_TENANT)).toHaveLength(1);
    expect(registry.list("other-document-tenant")).toHaveLength(1);
  });
});
