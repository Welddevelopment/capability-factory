import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCf021SeededBoundaryFaultCampaign } from "./seeded-boundary-fault-campaign.js";

interface SeedFile {
  schemaVersion: "1.0";
  campaignId: "cf-021-seeded-boundary-faults-v1";
  generator: "xorshift32";
  seeds: number[];
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const seedPath = resolve(root, "validation", "cf-021-seeded-boundary-faults-v1", "seeds.json");
const outputPath = resolve(root, "output", "cf-021-seeded-boundary-faults-v1", "campaign-receipt.json");
const stored = JSON.parse(await readFile(seedPath, "utf8")) as SeedFile;
if (stored.schemaVersion !== "1.0" || stored.campaignId !== "cf-021-seeded-boundary-faults-v1" || stored.generator !== "xorshift32") {
  throw new Error("CF-021 stored seed material has the wrong identity.");
}
const receipt = await runCf021SeededBoundaryFaultCampaign(stored.seeds);
if (receipt.unexpectedFailureCount !== 0) throw new Error(`CF-021 produced ${receipt.unexpectedFailureCount} unexpected failure(s).`);
await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  outputPath,
  generatedCaseCount: receipt.generatedCaseCount,
  passedCaseCount: receipt.passedCaseCount,
  uniqueTransitionCount: receipt.uniqueTransitionCount,
  failuresFoundAndFixed: receipt.failuresFoundAndFixed,
  receiptDigest: receipt.receiptDigest,
})}\n`);
