import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runSealedMultifamilyCampaign } from "./sealed-multifamily-campaign.js";

const sealDirectory = resolve(process.argv[2] ?? "validation/sealed-multifamily-campaign-v2");
const workingDirectory = resolve(process.argv[3] ?? "output/sealed-multifamily-campaign-v2/run");
const receiptPath = resolve(process.argv[4] ?? "output/sealed-multifamily-campaign-v2/execution-receipt.json");

const receipt = await runSealedMultifamilyCampaign({ sealDirectory, workingDirectory });
mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
chmodSync(receiptPath, 0o600);
process.stdout.write(`${JSON.stringify({ status: receipt.status, receiptPath, receiptDigest: receipt.receiptDigest })}\n`);
