import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  CustomerLocalTrustStore,
  type CustomerLocalTrustConfiguration,
} from "../../src/product/customer-local-trust-backup.js";
import {
  CustomerLocalHttpAuthorityTrustStore,
  type WorkspaceHttpAuthorityActivationRevocationReceipt,
} from "../../src/product/customer-local-http-authority-trust.js";
import {
  createTestCustomerLocalHttpWriteAuthorityFromTrustStore,
  type HttpActionAuthorityLease,
} from "../../src/product/customer-local-http-write-authority.js";
import type { CompiledHttpRequest } from "../../src/product/http-binding-compiler.js";
import type { AuthorityWizardCompilation } from "../../src/product/onboarding-verifier-authority.js";
import type { HttpActionBindingDeclaration } from "../../src/product/http-binding-factory.js";

interface RaceInput {
  mode: "consume" | "revoke";
  startAtEpochMs: number;
  trustPath: string;
  authorityTrustPath: string;
  workspaceId: string;
  initialAdminKeyId: string;
  trustConfig: CustomerLocalTrustConfiguration;
  authority: {
    statePath: string;
    issuerId: string;
    signerKeyId: string;
    privateKeyPem: string;
    publicKeyPem: string;
    authorityCompilation: AuthorityWizardCompilation;
    actionDeclaration: HttpActionBindingDeclaration;
    transportAuthorityBoundaryDigest: string;
    credentialResolverDigest: string;
    quantityMetric: { kind: "json-body-number"; field: string };
    maximumLeaseMilliseconds: number;
  };
  lease: HttpActionAuthorityLease;
  request: CompiledHttpRequest;
  revocation: WorkspaceHttpAuthorityActivationRevocationReceipt;
}
const input = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as RaceInput;
const trustStore = new CustomerLocalTrustStore(input.trustPath, input.trustConfig);
const authorityTrustStore = new CustomerLocalHttpAuthorityTrustStore({ statePath: input.authorityTrustPath, workspaceId: input.workspaceId, initialAdminKeyId: input.initialAdminKeyId, trustStore });
while (Date.now() < input.startAtEpochMs) { /* synchronized local contention */ }
const startedAtEpochMs = Date.now();
try {
  if (input.mode === "consume") {
    const authority = createTestCustomerLocalHttpWriteAuthorityFromTrustStore({
      ...input.authority,
      privateKey: createPrivateKey(input.authority.privateKeyPem),
      publicKey: createPublicKey(input.authority.publicKeyPem),
      workspaceAuthorityTrustStore: authorityTrustStore,
      testOnly: true,
    });
    authority.verifier.consume({ lease: input.lease, request: input.request, credentialAlias: input.request.credentialAlias });
    authority.verifier.close(); authority.issuer.close();
  } else {
    authorityTrustStore.revokeActivation(input.revocation);
  }
  process.stdout.write(JSON.stringify({ mode: input.mode, status: "fulfilled", startedAtEpochMs, completedAtEpochMs: Date.now() }));
} catch (error) {
  process.stdout.write(JSON.stringify({ mode: input.mode, status: "rejected", startedAtEpochMs, completedAtEpochMs: Date.now(), message: error instanceof Error ? error.message : String(error) }));
} finally {
  authorityTrustStore.close(); trustStore.close();
}
