import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runFrozenPlanningBenchmark } from "./frozen-planning-benchmark.js";

const materialDirectory = resolve(process.argv[2] ?? "validation/cf-015-frozen-planning-benchmark-v1");
const receiptPath = resolve(process.argv[3] ?? "output/cf-015-frozen-planning-benchmark-v1/execution-receipt.json");
const receipt = runFrozenPlanningBenchmark({ materialDirectory, requireSeal: true });
mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 }); chmodSync(receiptPath, 0o600);
process.stdout.write(`${JSON.stringify({ status: receipt.status, receiptPath, receiptDigest: receipt.receiptDigest })}\n`);
