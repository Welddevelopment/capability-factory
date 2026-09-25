import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { reclassifyAmbiguousLegacyCustomerLocalHttpAuthorityTrustStore, type LegacyHttpAuthorityReclassificationAttestation } from "../../src/product/customer-local-http-authority-legacy-migration.js";
import { CustomerLocalHttpAuthorityTrustStore } from "../../src/product/customer-local-http-authority-trust.js";
import { CustomerLocalTrustStore, type CustomerLocalTrustConfiguration, type RotationReceipt } from "../../src/product/customer-local-trust-backup.js";

interface WorkerInput {
  mode: "reclassify" | "adopt-admin-rotation" | "crash-uncommitted";
  startAtEpochMs: number;
  statePath: string;
  trustPath: string;
  workspaceId: string;
  initialAdminKeyId: string;
  trustConfig: CustomerLocalTrustConfiguration;
  now: string;
  attestation?: LegacyHttpAuthorityReclassificationAttestation;
  rotationReceipt?: RotationReceipt;
}

const inputPath = process.argv[2];
if (!inputPath) throw new Error("CF-076 worker requires one input path.");
const input = JSON.parse(readFileSync(inputPath, "utf8")) as WorkerInput;
while (Date.now() < input.startAtEpochMs) { /* synchronize the bounded local race */ }

if (input.mode === "crash-uncommitted") {
  const database = new DatabaseSync(input.statePath);
  database.exec("BEGIN IMMEDIATE");
  database.prepare("INSERT INTO authority_trust_meta(key,value) VALUES('cf076_uncommitted_probe','must-rollback')").run();
  process.exit(0);
}

const trustStore = new CustomerLocalTrustStore(input.trustPath, input.trustConfig, () => input.now);
try {
  if (input.mode === "adopt-admin-rotation") {
    if (!input.rotationReceipt) throw new Error("CF-076 rotation worker requires the frozen receipt.");
    const authority = new CustomerLocalHttpAuthorityTrustStore({ statePath: input.statePath, workspaceId: input.workspaceId, initialAdminKeyId: input.initialAdminKeyId, trustStore, testOnly: true });
    try {
      const result = authority.adoptAdminRotation(input.rotationReceipt);
      process.stdout.write(JSON.stringify({ status: "fulfilled", rotationReceiptDigest: result.rotationReceiptDigest }));
    } finally { authority.close(); }
    process.exit(0);
  }
  if (!input.attestation) throw new Error("CF-076 reclassification worker requires the frozen attestation.");
  const receipt = reclassifyAmbiguousLegacyCustomerLocalHttpAuthorityTrustStore({
    statePath: input.statePath,
    workspaceId: input.workspaceId,
    initialAdminKeyId: input.initialAdminKeyId,
    trustStore,
    attestation: input.attestation,
    testOnly: true,
  });
  process.stdout.write(JSON.stringify({ status: "fulfilled", receiptDigest: receipt.receiptDigest }));
} catch (error) {
  process.stdout.write(JSON.stringify({ status: "rejected", message: error instanceof Error ? error.message : String(error) }));
} finally {
  trustStore.close();
}
