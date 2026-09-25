import { mkdir, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPinnedDocumentCleanFamily } from "./pinned-document-clean-family.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const validation = resolve(root, "validation", "cf-007-pinned-document-clean-family-v1");
const output = resolve(root, "output", "cf-007-pinned-document-clean-family-v1");
const work = resolve(output, "customer-local-work");
const receipt = await runPinnedDocumentCleanFamily(validation, work);
await mkdir(output, { recursive: true, mode: 0o700 });
await writeFile(resolve(output, "campaign-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
rmSync(work, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({
  caseCount: receipt.caseCount,
  layouts: receipt.layouts.map((item) => item.layout),
  acceptanceCasesExecuted: receipt.acceptanceCasesExecuted,
  effects: receipt.effects,
  receiptDigest: receipt.receiptDigest,
})}\n`);
