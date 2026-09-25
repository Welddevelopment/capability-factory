import { readFileSync } from "node:fs";
import { CustomerLocalHttpAuthorityTrustStore } from "../../src/product/customer-local-http-authority-trust.js";
import { CustomerLocalTrustStore, type CustomerLocalTrustConfiguration } from "../../src/product/customer-local-trust-backup.js";

interface Input {
  trustPath: string;
  authorityTrustPath: string;
  workspaceId: string;
  initialAdminKeyId: string;
  authorityContractDigest: string;
  now: string;
  trustConfig: CustomerLocalTrustConfiguration;
}

const input = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Input;
const trustStore = new CustomerLocalTrustStore(input.trustPath, input.trustConfig, () => input.now);
const authorityTrustStore = new CustomerLocalHttpAuthorityTrustStore({
  statePath: input.authorityTrustPath,
  workspaceId: input.workspaceId,
  initialAdminKeyId: input.initialAdminKeyId,
  trustStore,
  testOnly: true,
});
try {
  authorityTrustStore.resolveCurrent(input.authorityContractDigest);
  process.stdout.write(JSON.stringify({ status: "fulfilled" }));
} catch (error) {
  process.stdout.write(JSON.stringify({ status: "rejected", message: error instanceof Error ? error.message : String(error) }));
} finally {
  authorityTrustStore.close(); trustStore.close();
}
