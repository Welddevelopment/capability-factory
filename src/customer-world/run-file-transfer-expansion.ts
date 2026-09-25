import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FictionalEdiFileTransferWorld } from "./edi-file-transfer-world.js";

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capability-factory-file-transfer-demo-"));
  const world = new FictionalEdiFileTransferWorld(root);

  const firstInput = world.writeInput({
    fileAlias: "east-industrial-1001.edi",
    purchaseOrderNumber: "EAST-1001",
    lines: [
      { itemCode: "BOLT-10", quantity: 12 },
      { itemCode: "FILTER-42", quantity: 3 },
    ],
  });
  const first = await world.sdk().completeGoal(world.request({
    requestId: "demo-new-capability",
    operationKey: "east-industrial-order-1001",
    inputFileAlias: "east-industrial-1001.edi",
    expectedInputSha256: firstInput.sha256,
  }));

  const secondInput = world.writeInput({
    fileAlias: "east-industrial-1002.edi",
    purchaseOrderNumber: "EAST-1002",
    lines: [{ itemCode: "GLOVE-7", quantity: 40 }],
  });
  const second = await world.sdk().completeGoal(world.request({
    requestId: "demo-retained-reuse",
    operationKey: "east-industrial-order-1002",
    inputFileAlias: "east-industrial-1002.edi",
    expectedInputSha256: secondInput.sha256,
    simulateLostResponseAfterCommit: true,
  }));

  process.stdout.write(`${JSON.stringify({
    boundary: {
      environment: "local disposable fictional file-transfer world",
      capabilityMode: "experimental-file-transfer-actions",
      supportedWorkflow: "one pinned X12 850 partner order to one canonical customer-local outbox record",
      notClaimed: ["general EDI", "SFTP or AS2", "customer deployment", "production readiness"],
    },
    firstRun: first,
    freshProcessReuseWithLostResponseReconciliation: second,
    independentlyReadOutbox: world.listOutputs(),
    preservedDemoRoot: root,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
