import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FictionalPdfTableOrderWorld,
  fictionalPdfTableOrder,
  fictionalTableDocumentContractHash,
} from "../src/customer-world/pdf-table-order-world.js";
import { fictionalPdfOrder } from "../src/customer-world/pdf-order-world.js";
import { documentOperationKey } from "../src/experimental/document-driver.js";
import {
  buildCapabilityModePackageSidecar,
  CapabilityModePackageManager,
} from "../src/product/capability-mode-package.js";
import { CAPABILITY_MODE_SCHEMA_VERSION } from "../src/product/capability-mode-contract.js";
import { createDocumentModeRunner } from "../src/product/capability-mode-router.js";

describe("second machine-readable PDF layout", () => {
  it("uses a different table envelope and completes build, verify, act, resume, retain, and reuse", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-table-document-"));
    try {
      const world = await FictionalPdfTableOrderWorld.create(root);
      const firstInput = await world.writeDocument({
        fileAlias: "table-1001.pdf",
        documentId: "TABLE-1001",
        purchaseOrderNumber: "PO-TABLE-1001",
        lines: [
          { itemCode: "BOLT-10", quantity: 2 },
          { itemCode: "FILTER-42", quantity: 3 },
        ],
      });
      const first = await world.sdk().completeGoal(world.request({
        requestId: "table-document-first",
        operationKey: firstInput.operationKey,
        inputDocumentAlias: "table-1001.pdf",
        expectedDocumentSha256: firstInput.sha256,
      }));
      expect(first).toMatchObject({
        status: "completed",
        path: "built-capability",
        execution: { writesAttempted: 1 },
        parent: { resumed: true, completed: true },
      });
      expect(world.listDrafts()).toHaveLength(1);

      const secondInput = await world.writeDocument({
        fileAlias: "table-1002.pdf",
        documentId: "TABLE-1002",
        purchaseOrderNumber: "PO-TABLE-1002",
        lines: [{ itemCode: "GLOVE-7", quantity: 8 }],
      });
      const second = await world.sdk().completeGoal(world.request({
        requestId: "table-document-second",
        operationKey: secondInput.operationKey,
        inputDocumentAlias: "table-1002.pdf",
        expectedDocumentSha256: secondInput.sha256,
        simulateLostResponseAfterCommit: true,
      }));
      expect(second).toMatchObject({
        status: "completed",
        path: "retained-capability",
        execution: { writesAttempted: 1, reconciled: true },
        parent: { resumed: true, completed: true },
      });
      expect(world.listDrafts()).toHaveLength(2);

      const wrongLayout = await fictionalPdfOrder({
        fileAlias: "wrong-layout.pdf",
        documentId: "WRONG-LAYOUT-1",
        purchaseOrderNumber: "WRONG-LAYOUT-1",
        lines: [{ itemCode: "BOLT-10", quantity: 1 }],
      });
      const wrongLayoutHash = createHash("sha256").update(wrongLayout).digest("hex");
      fs.writeFileSync(path.join(world.inputRoot, "wrong-layout.pdf"), wrongLayout, { mode: 0o600 });
      world.target.trustedIngressSha256ByAlias["wrong-layout.pdf"] = wrongLayoutHash;
      const refused = await world.sdk().completeGoal(world.request({
        requestId: "wrong-layout-refused",
        operationKey: documentOperationKey("WRONG-LAYOUT-1"),
        inputDocumentAlias: "wrong-layout.pdf",
        expectedDocumentSha256: wrongLayoutHash,
      }));
      expect(refused).toMatchObject({
        status: "blocked",
        handoff: { writesAttempted: 0 },
        parent: { resumed: false, completed: false },
      });
      expect(world.listDrafts()).toHaveLength(2);

      const bytes = await fictionalPdfTableOrder({
        fileAlias: "structure.pdf",
        documentId: "STRUCTURE-1",
        purchaseOrderNumber: "STRUCTURE-1",
        lines: [{ itemCode: "BOLT-10", quantity: 1 }],
      });
      expect(bytes.byteLength).toBeGreaterThan(500);
      expect(fictionalTableDocumentContractHash()).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs the second layout through the customer-local packaged durable sidecar", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-table-document-package-"));
    try {
      const world = await FictionalPdfTableOrderWorld.create(path.join(root, "world"));
      const contractPath = path.join(root, "table-document-contract.json");
      fs.writeFileSync(contractPath, `${JSON.stringify({
        schemaVersion: "1",
        contractHash: fictionalTableDocumentContractHash(),
        inputFormat: "machine-readable-pdf-order-table-v2",
        templateVersion: "2",
      }, null, 2)}\n`, { mode: 0o600 });
      const manager = new CapabilityModePackageManager(path.join(root, "package"), {
        portProbe: async () => true,
      });
      manager.initialize({
        installationId: "table-document-package",
        productVersion: "0.1.0",
        tenantId: "fictional-table-document-operator",
        modes: [{
          capabilityMode: "experimental-document-actions",
          driverVersion: "document-driver-v0.1",
          contractFiles: [{ sourcePath: contractPath, packagedName: "table-document-contract.json" }],
        }],
      });
      const built = await buildCapabilityModePackageSidecar(manager, async () => [
        createDocumentModeRunner(world.sdk()),
      ]);
      const token = manager.readAccessTokenForLocalClient();
      try {
        const input = await world.writeDocument({
          fileAlias: "packaged-table.pdf",
          documentId: "PACKAGED-TABLE-1",
          purchaseOrderNumber: "PACKAGED-TABLE-1",
          lines: [{ itemCode: "FILTER-42", quantity: 5 }],
        });
        const request = world.request({
          requestId: "packaged-table-document",
          operationKey: input.operationKey,
          inputDocumentAlias: "packaged-table.pdf",
          expectedDocumentSha256: input.sha256,
        });
        const submitted = await built.app.inject({
          method: "POST",
          url: "/v1/capability-mode-jobs",
          headers: { "x-capability-sidecar-token": token },
          payload: {
            schemaVersion: CAPABILITY_MODE_SCHEMA_VERSION,
            capabilityMode: "experimental-document-actions",
            request,
          },
        });
        expect(submitted.statusCode).toBe(202);
        const jobId = submitted.json().jobId as string;
        let terminal: Record<string, unknown> | undefined;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const response = await built.app.inject({
            method: "GET",
            url: `/v1/capability-mode-jobs/${jobId}?tenantId=${request.tenantId}`,
            headers: { "x-capability-sidecar-token": token },
          });
          const job = response.json() as Record<string, unknown>;
          if (job.status !== "queued" && job.status !== "running") {
            terminal = job;
            break;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        expect(terminal).toMatchObject({
          capabilityMode: "experimental-document-actions",
          status: "completed",
          result: {
            parentResumed: true,
            parentCompleted: true,
            acquisitionPath: "built-capability",
          },
        });
        expect(world.listDrafts()).toHaveLength(1);
      } finally {
        await built.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
