import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createTestCustomerLocalHttpWriteAuthority,
  type HttpActionAuthorityLease,
  type TestCustomerLocalHttpWriteAuthorityConfig,
} from "../../src/product/customer-local-http-write-authority.js";
import type { CompiledHttpRequest } from "../../src/product/http-binding-compiler.js";

interface WorkerInput {
  config: Omit<TestCustomerLocalHttpWriteAuthorityConfig, "privateKey" | "publicKey" | "now" | "nonce" | "workspaceAuthority"> & {
    privateKeyPem: string;
    publicKeyPem: string;
    workspaceAuthority: Omit<TestCustomerLocalHttpWriteAuthorityConfig["workspaceAuthority"], "adminPublicKey"> & { adminPublicKeyPem: string };
  };
  now: number;
  nonce: string;
  request: CompiledHttpRequest;
  priorLease: HttpActionAuthorityLease;
  reservationDigest: string;
}

const inputPath = process.argv[2];
if (!inputPath) throw new Error("CF-060 worker requires one frozen input path.");
const input = JSON.parse(readFileSync(inputPath, "utf8")) as WorkerInput;
const { privateKeyPem, publicKeyPem, workspaceAuthority, ...config } = input.config;
const authority = createTestCustomerLocalHttpWriteAuthority({
  ...config,
  privateKey: createPrivateKey(privateKeyPem),
  publicKey: createPublicKey(publicKeyPem),
  now: () => input.now,
  nonce: () => input.nonce,
  workspaceAuthority: { ...workspaceAuthority, adminPublicKey: createPublicKey(workspaceAuthority.adminPublicKeyPem) },
});

try {
  const lease = await authority.issuer.issueLease({
    request: input.request,
    credentialAlias: input.request.credentialAlias,
    transportReservationDigest: input.reservationDigest,
    unconsumedReplacement: { priorLease: input.priorLease, reason: "expired-before-consume" },
  });
  process.stdout.write(`${JSON.stringify({ status: "fulfilled", lease })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ status: "rejected", message: error instanceof Error ? error.message : String(error) })}\n`);
} finally {
  authority.verifier.close();
  authority.issuer.close();
}
