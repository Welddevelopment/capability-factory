import { runCustomerLocalPluginConformance } from "./customer-local-plugin-conformance.js";
import { createReferenceCustomerLocalPluginFixture, type ReferencePluginShape } from "./customer-local-reference-plugins.js";

async function main(): Promise<void> {
  const qualifiedAt = "2026-08-14T01:00:00.000Z";
  const expiresAt = "2026-09-13T01:00:00.000Z";
  const receipts = [];
  for (const shape of ["map-direct", "callback-queued"] as ReferencePluginShape[]) {
    const fixture = createReferenceCustomerLocalPluginFixture(shape, { qualifiedAt, expiresAt });
    receipts.push(await runCustomerLocalPluginConformance({ ...fixture, qualifiedAt, expiresAt }));
  }
  process.stdout.write(`${JSON.stringify({ schemaVersion: "1.0", evidenceBoundary: "Local reference-plugin conformance only; no authority or activation.", receipts }, null, 2)}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Customer-local plugin conformance failed."}\n`);
  process.exitCode = 1;
});
