import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runAdversarialResolutionFamily } from "./adversarial-resolution-family.js";

const materialDirectory = resolve(process.argv[2] ?? "validation/cf-014-adversarial-family-v1");
const workingDirectory = resolve(process.argv[3] ?? "output/cf-014-adversarial-family-v1/run");
const receiptPath = resolve(process.argv[4] ?? "output/cf-014-adversarial-family-v1/execution-receipt.json");
const receipt = await runAdversarialResolutionFamily({ materialDirectory, workingDirectory, requireSeal: true });
mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
chmodSync(receiptPath, 0o600);
process.stdout.write(`${JSON.stringify({ status: receipt.status, receiptPath, receiptDigest: receipt.receiptDigest })}\n`);
