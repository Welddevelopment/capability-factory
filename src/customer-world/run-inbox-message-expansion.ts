import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FictionalInboxOrderWorld } from "./inbox-order-world.js";

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capability-factory-inbox-demo-"));
  const world = new FictionalInboxOrderWorld(root);

  const firstInput = world.writeMessage({
    fileAlias: "east-order-2001.eml",
    purchaseOrderNumber: "EAST-2001",
    messageId: "<east-2001@east-industrial.example>",
    lines: [
      { itemCode: "BOLT-10", quantity: 10 },
      { itemCode: "FILTER-42", quantity: 2 },
    ],
  });
  const first = await world.sdk().completeGoal(world.request({
    requestId: "inbox-new-capability",
    operationKey: firstInput.operationKey,
    inputMessageAlias: "east-order-2001.eml",
    expectedMessageSha256: firstInput.sha256,
  }));

  const secondInput = world.writeMessage({
    fileAlias: "east-order-2002.eml",
    purchaseOrderNumber: "EAST-2002",
    messageId: "<east-2002@east-industrial.example>",
    lines: [{ itemCode: "GLOVE-7", quantity: 25 }],
  });
  const second = await world.sdk().completeGoal(world.request({
    requestId: "inbox-retained-reuse",
    operationKey: secondInput.operationKey,
    inputMessageAlias: "east-order-2002.eml",
    expectedMessageSha256: secondInput.sha256,
    simulateLostResponseAfterCommit: true,
  }));

  process.stdout.write(`${JSON.stringify({
    boundary: {
      environment: "local disposable fictional inbox and draft store",
      capabilityMode: "experimental-inbox-message-actions",
      supportedWorkflow: "one exact plain-text RFC 822 supplier order email to one customer-local draft order",
      notClaimed: ["general email", "PDFs or attachments", "IMAP or Gmail", "customer deployment", "production readiness"],
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
