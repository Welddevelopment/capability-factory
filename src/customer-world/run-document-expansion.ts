import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FictionalPdfOrderWorld } from "./pdf-order-world.js";

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capability-factory-document-demo-"));
  const world = await FictionalPdfOrderWorld.create(root);
  const firstInput = await world.writeDocument({
    fileAlias: "east-pdf-3001.pdf",
    documentId: "PDF-3001",
    purchaseOrderNumber: "EAST-3001",
    lines: [
      { itemCode: "BOLT-10", quantity: 8 },
      { itemCode: "FILTER-42", quantity: 2 },
    ],
  });
  const first = await world.sdk().completeGoal(world.request({
    requestId: "document-new-capability",
    operationKey: firstInput.operationKey,
    inputDocumentAlias: "east-pdf-3001.pdf",
    expectedDocumentSha256: firstInput.sha256,
  }));

  const secondInput = await world.writeDocument({
    fileAlias: "east-pdf-3002.pdf",
    documentId: "PDF-3002",
    purchaseOrderNumber: "EAST-3002",
    lines: [{ itemCode: "GLOVE-7", quantity: 20 }],
  });
  const second = await world.sdk().completeGoal(world.request({
    requestId: "document-retained-reuse",
    operationKey: secondInput.operationKey,
    inputDocumentAlias: "east-pdf-3002.pdf",
    expectedDocumentSha256: secondInput.sha256,
    simulateLostResponseAfterCommit: true,
  }));

  process.stdout.write(`${JSON.stringify({
    boundary: {
      environment: "local disposable fictional trusted PDF inbox and draft store",
      capabilityMode: "experimental-document-actions",
      supportedWorkflow: "one pinned one-page machine-readable PDF order template to one verified draft",
      notClaimed: ["arbitrary PDFs", "scans or OCR", "multi-page documents", "customer deployment", "production readiness"],
    },
    firstRun: first,
    freshProcessReuseWithLostResponseReconciliation: second,
    independentlyReadDrafts: world.listDrafts(),
    preservedDemoRoot: root,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
