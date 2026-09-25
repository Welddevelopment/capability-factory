import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthorityContinuityEnrollmentStoppedError,
  createAuthorityContinuityEnrollmentGuard,
  signAuthorityContinuityCurrentnessResponse,
  signAuthorityContinuityEnrollmentPolicy,
  signAuthorityContinuityLiveStatusResponse,
  type AuthorityContinuityLiveStatusChallenge,
} from "../src/product/authority-continuity-enrollment-provider.js";
import { CustomerLocalHttpAuthorityTrustStore } from "../src/product/customer-local-http-authority-trust.js";
import { CustomerLocalTrustStore } from "../src/product/customer-local-trust-backup.js";
import {
  createEnrolledCustomerLocalHttpWriteAuthority,
  createCustomerLocalHttpWriteAuthority,
  customerLocalAuthorityDigest,
  customerLocalHttpAuthorityTrustContractDigest,
  signWorkspaceHttpAuthorityActivation,
  type EnrolledCustomerLocalHttpWriteAuthorityTrustConfig,
} from "../src/product/customer-local-http-write-authority.js";
import type { CompiledHttpRequest } from "../src/product/http-binding-compiler.js";
import type { HttpActionBindingDeclaration } from "../src/product/http-binding-factory.js";
import { compileAuthorityWizard } from "../src/product/onboarding-verifier-authority.js";

const roots: string[] = [], closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0).reverse()) { try { close(); } catch { /* already closed */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const pem = (key: ReturnType<typeof generateKeyPairSync>["publicKey"]): string => key.export({ type: "spki", format: "pem" }).toString();

function fixture(label: string) {
  const directory = mkdtempSync(join(tmpdir(), `cf069-joined-${label}-`)); roots.push(directory);
  const current = { value: Date.now() }, admin = generateKeyPairSync("ed25519"), authority = generateKeyPairSync("ed25519"), provider = generateKeyPairSync("ed25519");
  const trustStore = new CustomerLocalTrustStore(join(directory, "trust.sqlite"), {
    schemaVersion: "1.0", tenantId: "tenant_cf069_joined", environment: "local",
    keys: [{ keyId: "workspace_admin_v1", issuer: "customer_admin", publicKeyPem: pem(admin.publicKey), notBefore: new Date(current.value - 60_000).toISOString(), notAfter: new Date(current.value + 3_600_000).toISOString() }],
  });
  const authorityTrustStore = new CustomerLocalHttpAuthorityTrustStore({ statePath: join(directory, "authority-trust.sqlite"), workspaceId: "workspace_cf069_joined", initialAdminKeyId: "workspace_admin_v1", trustStore });
  closers.push(() => authorityTrustStore.close(), () => trustStore.close());
  const compilation = compileAuthorityWizard({
    schemaVersion: "1.0", systemsAndTargets: { aliases: ["orders"], confirmed: true }, credentialAliases: { aliases: ["actionBearer", "observerBearer"], confirmed: true },
    readsAllowed: { actions: [{ actionName: "auditOrder", targetAlias: "orders" }], confirmed: true }, writes: [{ actionName: "createOrder", targetAlias: "orders", method: "POST", policy: "preauthorized", confirmed: true }],
    limits: { monetary: { kind: "none", confirmed: true }, quantityPerAction: { kind: "limit", maximum: 10, confirmed: true }, actionsPerHour: { kind: "limit", maximum: 10, confirmed: true } },
    forbiddenActions: { actionNames: ["deleteOrder"], confirmed: true }, approver: { kind: "not-required", confirmed: true }, retryAndReconciliation: { reconcileBeforeRetry: true, blindRetryAllowed: false, maximumAttempts: 1, confirmed: true }, finalConsequentialReview: { confirmed: true },
  });
  const declarationPayload: Omit<HttpActionBindingDeclaration, "declarationDigest"> = {
    schemaVersion: "1.0", kind: "constrained-http-action-binding-declaration", state: "proposal-only", executable: false, qualified: false, activated: false,
    driverId: "orders_action", targetAlias: "orders", serverUrl: "https://localhost:9443/", operation: { operationId: "createOrder", method: "POST", pathTemplate: "/orders" }, credentialAlias: "actionBearer", requestMappings: [],
    reconciliationKeySource: { kind: "workflow-input", inputKey: "orderRef", confirmed: true }, acceptedStatuses: [201], authorityPolicy: "preauthorized", retry: { reconcileBeforeRetry: true, blindRetryAllowed: false },
    provenance: { normalizedMaterialDigest: "a".repeat(64), normalizationReceiptDigest: "b".repeat(64), authorityCompilationDigest: compilation.compilationDigest, confirmedFactsDigest: "c".repeat(64), operationPointer: "/paths/~1orders/post" },
  };
  const declaration = { ...declarationPayload, declarationDigest: customerLocalAuthorityDigest(declarationPayload) };
  const base = {
    statePath: join(directory, "authority.sqlite"), issuerId: "cf069_joined_authority", signerKeyId: "cf069_joined_authority_key", privateKey: authority.privateKey, publicKey: authority.publicKey,
    authorityCompilation: compilation, actionDeclaration: declaration, transportAuthorityBoundaryDigest: "d".repeat(64), credentialResolverDigest: "e".repeat(64), quantityMetric: { kind: "json-body-number" as const, field: "quantity" }, maximumLeaseMilliseconds: 2_000, workspaceAuthorityTrustStore: authorityTrustStore,
  };
  const authorityContractDigest = customerLocalHttpAuthorityTrustContractDigest(base), trustConfigurationDigest = authorityTrustStore.trustConfigurationDigest;
  authorityTrustStore.importActivation(signWorkspaceHttpAuthorityActivation({ adminSignerKeyId: "workspace_admin_v1", workspaceId: authorityTrustStore.workspaceId, authorityContractDigest, privateKey: admin.privateKey, issuedAt: new Date(current.value - 1_000).toISOString(), expiresAt: new Date(current.value + 600_000).toISOString(), activationNonce: sha(`activation:${label}`).slice(0, 48) }));
  const runtimeReleaseDigest = sha(`runtime:${label}`), challengeNonce = sha(`challenge:${label}`).slice(0, 48);
  const makeGuard = (changes: { authorityContractDigest?: string; tenantId?: string; runtimeReleaseDigest?: string } = {}) => {
    const policy = signAuthorityContinuityEnrollmentPolicy({ providerId: "continuity_provider", policyId: `policy_${label}`, policyEpoch: 1, tenantId: changes.tenantId ?? "tenant_cf069_joined", installationId: `installation_${label}`, workspaceId: authorityTrustStore.workspaceId, authorityContractDigest: changes.authorityContractDigest ?? authorityContractDigest, trustConfigurationDigest, runtimeReleaseDigest: changes.runtimeReleaseDigest ?? runtimeReleaseDigest, enrolledAt: new Date(current.value - 1_000).toISOString(), expiresAt: new Date(current.value + 600_000).toISOString(), providerSignerKeyId: "provider_signer_v1", state: "enrolled", privateKey: provider.privateKey });
    const response = signAuthorityContinuityCurrentnessResponse({ providerId: policy.providerId, policyId: policy.policyId, policyEpoch: policy.policyEpoch, policyDigest: policy.policyDigest, tenantId: policy.tenantId, installationId: policy.installationId, workspaceId: policy.workspaceId, authorityContractDigest: policy.authorityContractDigest, trustConfigurationDigest: policy.trustConfigurationDigest, runtimeReleaseDigest: policy.runtimeReleaseDigest, challengeNonce, state: "active", continuityGuardIdentityDigest: null, issuedAt: new Date(current.value - 1).toISOString(), expiresAt: new Date(current.value + 30_000).toISOString(), providerSignerKeyId: policy.providerSignerKeyId, privateKey: provider.privateKey });
    return createAuthorityContinuityEnrollmentGuard({ policy, response, providerPublicKey: provider.publicKey, expectedChallengeNonce: challengeNonce, expectedRuntimeReleaseDigest: policy.runtimeReleaseDigest, now: () => new Date(current.value).toISOString() });
  };
  const request = (orderRef: string): CompiledHttpRequest => ({ requestId: `request_${orderRef}`, parentGoalId: "parent_cf069", workItemId: `item_${orderRef}`, driverId: declaration.driverId, targetAlias: declaration.targetAlias, serverUrl: declaration.serverUrl, operationId: declaration.operation.operationId, method: "POST", path: "/orders", query: {}, headers: {}, body: { order_ref: orderRef, quantity: 1 }, credentialAlias: declaration.credentialAlias, reconciliationKey: orderRef, declarationDigest: declaration.declarationDigest });
  const live = { state: "active" as "active" | "suspended" | "revoked" | "unknown", epoch: 1, available: true };
  const makeLiveGuard = () => {
    const policy = signAuthorityContinuityEnrollmentPolicy({ providerId: "continuity_provider", policyId: `live_policy_${label}`, policyEpoch: 1, tenantId: "tenant_cf069_joined", installationId: `installation_${label}`, workspaceId: authorityTrustStore.workspaceId, authorityContractDigest, trustConfigurationDigest, runtimeReleaseDigest, enrolledAt: new Date(current.value - 1_000).toISOString(), expiresAt: new Date(current.value + 600_000).toISOString(), providerSignerKeyId: "provider_signer_v1", state: "enrolled", privateKey: provider.privateKey });
    const response = signAuthorityContinuityCurrentnessResponse({ providerId: policy.providerId, policyId: policy.policyId, policyEpoch: policy.policyEpoch, policyDigest: policy.policyDigest, tenantId: policy.tenantId, installationId: policy.installationId, workspaceId: policy.workspaceId, authorityContractDigest: policy.authorityContractDigest, trustConfigurationDigest: policy.trustConfigurationDigest, runtimeReleaseDigest: policy.runtimeReleaseDigest, challengeNonce, state: "active", continuityGuardIdentityDigest: null, issuedAt: new Date(current.value - 1).toISOString(), expiresAt: new Date(current.value + 299_000).toISOString(), providerSignerKeyId: policy.providerSignerKeyId, privateKey: provider.privateKey });
    return createAuthorityContinuityEnrollmentGuard({ policy, response, providerPublicKey: provider.publicKey, expectedChallengeNonce: challengeNonce, expectedRuntimeReleaseDigest: runtimeReleaseDigest, now: () => new Date(current.value).toISOString(), liveStatusProvider: { queryCurrent(challenge: AuthorityContinuityLiveStatusChallenge) { if (!live.available) throw new Error("provider unavailable"); return signAuthorityContinuityLiveStatusResponse({ ...challenge, statusEpoch: live.epoch, state: live.state, issuedAt: new Date(current.value - 1).toISOString(), expiresAt: new Date(current.value + 5_000).toISOString(), providerSignerKeyId: policy.providerSignerKeyId, privateKey: provider.privateKey }); } } });
  };
  return { current, base, authorityContractDigest, authorityTrustStore, makeGuard, makeLiveGuard, live, request };
}

describe("CF-069 enrolled production write-authority boundary", () => {
  it("requires exact current provider enrollment and rechecks it at issue and consume", async () => {
    const f = fixture("exact"), guard = f.makeGuard();
    expect(() => createCustomerLocalHttpWriteAuthority(f.base as never)).toThrow(/enrollment guard|trusted provider/i);
    const joined = createEnrolledCustomerLocalHttpWriteAuthority({ ...f.base, authorityContinuityEnrollmentGuard: guard } satisfies EnrolledCustomerLocalHttpWriteAuthorityTrustConfig);
    const first = f.request("ONE"), second = f.request("TWO"), firstLease = await joined.issuer.issueLease({ request: first, credentialAlias: "actionBearer" }), secondLease = await joined.issuer.issueLease({ request: second, credentialAlias: "actionBearer" });
    joined.verifier.consume({ lease: firstLease, request: first, credentialAlias: "actionBearer" });
    f.current.value += 31_000;
    await expect(joined.issuer.issueLease({ request: f.request("THREE"), credentialAlias: "actionBearer" })).rejects.toThrow(/expired|enrollment/i);
    expect(() => joined.verifier.consume({ lease: secondLease, request: second, credentialAlias: "actionBearer" })).toThrow(/expired|enrollment/i);
    joined.verifier.close(); joined.issuer.close();
  });

  it("rejects a signed enrollment for another authority contract or tenant", () => {
    const contract = fixture("wrong-contract"), wrongContract = contract.makeGuard({ authorityContractDigest: sha("other-contract") });
    expect(() => createEnrolledCustomerLocalHttpWriteAuthority({ ...contract.base, authorityContinuityEnrollmentGuard: wrongContract })).toThrow(/exact workspace|authority contract|different workspace/i);
    const tenant = fixture("wrong-tenant"), wrongTenant = tenant.makeGuard({ tenantId: "tenant_attacker" });
    expect(() => createEnrolledCustomerLocalHttpWriteAuthority({ ...tenant.base, authorityContinuityEnrollmentGuard: wrongTenant })).toThrow(/exact workspace|authority contract|different workspace/i);
  });

  it("stops an already-running authority process on live suspension without consuming the lease or losing audit", async () => {
    const f = fixture("live-stop"), guard = f.makeLiveGuard(), joined = createCustomerLocalHttpWriteAuthority({ ...f.base, authorityContinuityEnrollmentGuard: guard });
    const pending = f.request("PENDING"), lease = await joined.issuer.issueLease({ request: pending, credentialAlias: "actionBearer" });
    const auditBefore = f.authorityTrustStore.auditActivations();
    f.live.epoch = 2; f.live.state = "suspended";
    let issueError: unknown;
    try { await joined.issuer.issueLease({ request: f.request("BLOCKED"), credentialAlias: "actionBearer" }); } catch (error) { issueError = error; }
    expect(issueError).toBeInstanceOf(AuthorityContinuityEnrollmentStoppedError);
    expect((issueError as AuthorityContinuityEnrollmentStoppedError).stopReceipt).toMatchObject({ reason: "provider-state-suspended", observedStatusEpoch: 2, auditAccessAllowed: true });
    expect(() => joined.verifier.consume({ lease, request: pending, credentialAlias: "actionBearer" })).toThrow(/provider-state-suspended/i);
    expect(f.authorityTrustStore.auditActivations()).toEqual(auditBefore);
    f.live.state = "revoked"; f.live.epoch = 3;
    await expect(joined.issuer.issueLease({ request: f.request("REVOKED"), credentialAlias: "actionBearer" })).rejects.toThrow(/provider-state-revoked/i);
    f.live.available = false;
    await expect(joined.issuer.issueLease({ request: f.request("OFFLINE"), credentialAlias: "actionBearer" })).rejects.toThrow(/provider-unavailable/i);
    joined.verifier.close(); joined.issuer.close();
  });
});
