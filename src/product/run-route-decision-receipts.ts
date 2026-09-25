import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRouteDecisionReceipts } from "./route-decision-receipt.js";

const materialDirectory = resolve(process.argv[2] ?? "validation/cf-015-frozen-planning-benchmark-v1");
const benchmarkReceiptPath = resolve(process.argv[3] ?? "output/cf-015-frozen-planning-benchmark-v1/execution-receipt.json");
const outputDirectory = resolve(process.argv[4] ?? "output/cf-023-route-decision-receipts-v1");
const receipts = createRouteDecisionReceipts({ materialDirectory, benchmarkReceiptPath });
mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
for (const receipt of receipts) {
  const path = resolve(outputDirectory, `${receipt.goalId}.json`);
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 }); chmodSync(path, 0o600);
}
process.stdout.write(`${JSON.stringify({ status: "passed", receiptCount: receipts.length, outputDirectory })}\n`);
