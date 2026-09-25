import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAuthorityContinuityEnrollmentGuard,
  signAuthorityContinuityCurrentnessResponse,
  signAuthorityContinuityEnrollmentPolicy,
  signAuthorityContinuityLiveStatusResponse,
  type AuthorityContinuityLiveStatusChallenge,
} from "../src/product/authority-continuity-enrollment-provider.js";
import { createCustomerLocalAuthorityContinuityGuard } from "../src/product/customer-local-authority-continuity-guard.js";
import {
  inspectAmbiguousLegacyCustomerLocalHttpAuthorityTrustStore,
  migrateLegacyCustomerLocalHttpAuthorityTrustStore,
  reclassifyAmbiguousLegacyCustomerLocalHttpAuthorityTrustStore,
  signLegacyHttpAuthorityReclassificationAttestation,
} from "../src/product/customer-local-http-authority-legacy-migration.js";
import { CustomerLocalHttpAuthorityTrustStore, restoreSignedCustomerLocalHttpAuthorityTrustBackup } from "../src/product/customer-local-http-authority-trust.js";
import {
  createCustomerLocalHttpWriteAuthority,
  customerLocalAuthorityDigest,
  customerLocalHttpAuthorityTrustContractDigest,
  signWorkspaceHttpAuthorityActivation,
} from "../src/product/customer-local-http-write-authority.js";
import { CustomerLocalTrustStore } from "../src/product/customer-local-trust-backup.js";
import { DurableExternalMonotonicContinuityAnchor } from "../src/product/external-monotonic-continuity-anchor.js";
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

function authorityMaterials() {
  const compilation = compileAuthorityWizard({
    schemaVersion: "1.0", systemsAndTargets: { aliases: ["orders"], confirmed: true }, credentialAliases: { aliases: ["actionBearer", "observerBearer"], confirmed: true },
    readsAllowed: { actions: [{ actionName: "auditOrder", targetAlias: "orders" }], confirmed: true }, writes: [{ actionName: "createOrder", targetAlias: "orders", method: "POST", policy: "preauthorized", confirmed: true }],
    limits: { monetary: { kind: "none", confirmed: true }, quantityPerAction: { kind: "limit", maximum: 10, confirmed: true }, actionsPerHour: { kind: "limit", maximum: 10, confirmed: true } },
    forbiddenActions: { actionNames: ["deleteOrder"], confirmed: true }, approver: { kind: "not-required", confirmed: true }, retryAndReconciliation: { reconcileBeforeRetry: true, blindRetryAllowed: false, maximumAttempts: 1, confirmed: true }, finalConsequentialReview: { confirmed: true },
  });
  const body: Omit<HttpActionBindingDeclaration, "declarationDigest"> = {
    schemaVersion: "1.0", kind: "constrained-http-action-binding-declaration", state: "proposal-only", executable: false, qualified: false, activated: false,
    driverId: "orders_action", targetAlias: "orders", serverUrl: "https://localhost:9443/", operation: { operationId: "createOrder", method: "POST", pathTemplate: "/orders" }, credentialAlias: "actionBearer", requestMappings: [],
    reconciliationKeySource: { kind: "workflow-input", inputKey: "orderRef", confirmed: true }, acceptedStatuses: [201], authorityPolicy: "preauthorized", retry: { reconcileBeforeRetry: true, blindRetryAllowed: false },
    provenance: { normalizedMaterialDigest: "a".repeat(64), normalizationReceiptDigest: "b".repeat(64), authorityCompilationDigest: compilation.compilationDigest, confirmedFactsDigest: "c".repeat(64), operationPointer: "/paths/~1orders/post" },
  };
  return { compilation, declaration: { ...body, declarationDigest: customerLocalAuthorityDigest(body) } };
}

describe("CF-077 reclassified recovery joined to enrolled write authority", () => {
  it("requires every new recovery, activation and live-enrollment boundary before bounded lease use", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf077-joined-")); roots.push(root);
    const admin = generateKeyPairSync("ed25519"), assessor = generateKeyPairSync("ed25519"), authorityKeys = generateKeyPairSync("ed25519"), provider = generateKeyPairSync("ed25519"), anchorKeys = generateKeyPairSync("ed25519");
    const now = Date.now(), trustStore = new CustomerLocalTrustStore(join(root, "trust.sqlite"), {
      schemaVersion: "1.0", tenantId: "tenant_cf077", environment: "local",
      keys: [
        { keyId: "workspace_admin_v1", issuer: "customer_admin", publicKeyPem: pem(admin.publicKey), notBefore: new Date(now - 60_000).toISOString(), notAfter: new Date(now + 3_600_000).toISOString() },
        { keyId: "continuity_assessor_v1", issuer: "independent_continuity_assessor", publicKeyPem: pem(assessor.publicKey), notBefore: new Date(now - 60_000).toISOString(), notAfter: new Date(now + 3_600_000).toISOString() },
      ],
    }); closers.push(() => trustStore.close());
    const workspaceId = "workspace_cf077", legacyPath = join(root, "authority-legacy.sqlite"), initialStore = new CustomerLocalHttpAuthorityTrustStore({ statePath: legacyPath, workspaceId, initialAdminKeyId: "workspace_admin_v1", trustStore });
    const { compilation, declaration } = authorityMaterials(), authorityStatePath = join(root, "write-authority.sqlite"), commonBase = {
      statePath: authorityStatePath, issuerId: "cf077_authority", signerKeyId: "cf077_authority_key", privateKey: authorityKeys.privateKey, publicKey: authorityKeys.publicKey,
      authorityCompilation: compilation, actionDeclaration: declaration, transportAuthorityBoundaryDigest: "d".repeat(64), credentialResolverDigest: "e".repeat(64), quantityMetric: { kind: "json-body-number" as const, field: "quantity" }, maximumLeaseMilliseconds: 5_000,
    };
    const authorityContractDigest = customerLocalHttpAuthorityTrustContractDigest({ ...commonBase, workspaceAuthorityTrustStore: initialStore });
    const initialActivation = signWorkspaceHttpAuthorityActivation({ adminSignerKeyId: "workspace_admin_v1", workspaceId, authorityContractDigest, privateKey: admin.privateKey, issuedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(), activationNonce: sha("cf077-initial-activation").slice(0, 48) });
    initialStore.importActivation(initialActivation); initialStore.close();
    const legacyDatabase = new DatabaseSync(legacyPath); legacyDatabase.prepare("DELETE FROM authority_trust_meta WHERE key IN ('recovery_continuity_required','last_recovery_at')").run(); legacyDatabase.close();

    const migratedPath = join(root, "authority-migrated.sqlite"), migration = migrateLegacyCustomerLocalHttpAuthorityTrustStore({ sourcePath: legacyPath, destinationPath: migratedPath, workspaceId, initialAdminKeyId: "workspace_admin_v1", trustStore });
    const inspection = inspectAmbiguousLegacyCustomerLocalHttpAuthorityTrustStore({ statePath: migratedPath, workspaceId, initialAdminKeyId: "workspace_admin_v1", trustStore });
    const attestation = signLegacyHttpAuthorityReclassificationAttestation({
      classification: "independently-attested-never-recovered", sourceStateDigest: inspection.sourceStateDigest, initialMigrationReceiptDigest: inspection.initialMigrationReceiptDigest,
      migratedAuditStateDigest: inspection.migratedAuditStateDigest, tenantId: inspection.tenantId, environment: inspection.environment, workspaceId: inspection.workspaceId,
      trustConfigurationDigest: inspection.trustConfigurationDigest, eventHeadDigest: inspection.eventHeadDigest, eventCount: inspection.eventCount,
      continuityGuardIdentityDigest: null, effectiveRecoveryAt: null, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), signerKeyId: "continuity_assessor_v1",
      statement: "Independent records bind this exact migrated audit state and show it was never previously recovered.", privateKey: assessor.privateKey,
    });
    const reclassification = reclassifyAmbiguousLegacyCustomerLocalHttpAuthorityTrustStore({ statePath: migratedPath, workspaceId, initialAdminKeyId: "workspace_admin_v1", trustStore, attestation });
    expect(reclassification).toMatchObject({ initialMigrationReceiptDigest: migration.receiptDigest, classification: "never-recovered", executionAuthorityEffect: "none" });
    const reclassifiedStore = new CustomerLocalHttpAuthorityTrustStore({ statePath: migratedPath, workspaceId, initialAdminKeyId: "workspace_admin_v1", trustStore }), backupDirectory = join(root, "authority-backup");
    const backup = reclassifiedStore.createSignedAuditBackup({ directory: backupDirectory, signerKeyId: "workspace_admin_v1", signerPrivateKey: admin.privateKey, expiresAt: new Date(Date.now() + 60_000).toISOString() }); reclassifiedStore.close();

    const anchor = new DurableExternalMonotonicContinuityAnchor(join(root, "continuity-anchor.sqlite"), { schemaVersion: "1.0", anchorId: "anchor_cf077", tenantId: "tenant_cf077", installationId: "installation_cf077", workspaceId, authorityContractDigest, trustConfigurationDigest: trustStore.configDigest, signerKeyId: "anchor_signer_v1", signerPublicKeyPem: pem(anchorKeys.publicKey) }, { signerPrivateKey: anchorKeys.privateKey }); closers.push(() => anchor.close());
    const recoveryCheckpoint = anchor.pinRecoveryManifest(backup.manifest.manifestDigest), restored = restoreSignedCustomerLocalHttpAuthorityTrustBackup({ backupDirectory, destinationStatePath: join(root, "authority-restored.sqlite"), trustStore, expectedWorkspaceId: workspaceId }); closers.push(() => restored.store.close());
    const completion = anchor.completeCurrentRecovery(backup.manifest.manifestDigest, restored.restoreReceiptDigest), continuityGuard = createCustomerLocalAuthorityContinuityGuard({ anchor, recoveryManifestDigest: backup.manifest.manifestDigest, recoveryReceiptDigest: restored.restoreReceiptDigest, recoveryCheckpointDigest: recoveryCheckpoint.checkpointDigest, completionCheckpoint: completion });
    expect(restored.store.recoveryContinuityRequirement()).not.toBeNull();
    restored.store.importActivation(initialActivation);
    expect(() => restored.store.resolveCurrent(authorityContractDigest)).toThrow(/audit-only|fresh post-restore/i);
    while (Date.now() <= Date.parse(restored.restoredAt)) await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
    const freshActivation = signWorkspaceHttpAuthorityActivation({ adminSignerKeyId: "workspace_admin_v1", workspaceId, authorityContractDigest, privateKey: admin.privateKey, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(), activationNonce: sha("cf077-fresh-activation").slice(0, 48) });
    restored.store.importActivation(freshActivation);

    const runtimeReleaseDigest = sha("cf077-runtime-release"), challengeNonce = sha("cf077-enrollment-challenge").slice(0, 48), policy = signAuthorityContinuityEnrollmentPolicy({
      providerId: "continuity_provider", policyId: "policy_cf077", policyEpoch: 1, tenantId: "tenant_cf077", installationId: "installation_cf077", workspaceId,
      authorityContractDigest, trustConfigurationDigest: trustStore.configDigest, runtimeReleaseDigest, enrolledAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
      providerSignerKeyId: "provider_signer_v1", state: "enrolled", privateKey: provider.privateKey,
    });
    const enrollmentResponse = signAuthorityContinuityCurrentnessResponse({ providerId: policy.providerId, policyId: policy.policyId, policyEpoch: policy.policyEpoch, policyDigest: policy.policyDigest, tenantId: policy.tenantId, installationId: policy.installationId, workspaceId, authorityContractDigest, trustConfigurationDigest: trustStore.configDigest, runtimeReleaseDigest, challengeNonce, state: "active", continuityGuardIdentityDigest: continuityGuard.identityDigest, issuedAt: new Date(Date.now() - 1).toISOString(), expiresAt: new Date(Date.now() + 299_000).toISOString(), providerSignerKeyId: policy.providerSignerKeyId, privateKey: provider.privateKey });
    const live = { epoch: 1, state: "active" as "active" | "suspended" | "revoked" | "unknown" };
    const enrollmentGuard = createAuthorityContinuityEnrollmentGuard({
      policy, response: enrollmentResponse, providerPublicKey: provider.publicKey, expectedChallengeNonce: challengeNonce, expectedRuntimeReleaseDigest: runtimeReleaseDigest, continuityGuard,
      liveStatusProvider: { queryCurrent(challenge: AuthorityContinuityLiveStatusChallenge) { return signAuthorityContinuityLiveStatusResponse({ ...challenge, statusEpoch: live.epoch, state: live.state, issuedAt: new Date(Date.now() - 1).toISOString(), expiresAt: new Date(Date.now() + 5_000).toISOString(), providerSignerKeyId: policy.providerSignerKeyId, privateKey: provider.privateKey }); } },
    });
    const restoredBase = { ...commonBase, workspaceAuthorityTrustStore: restored.store };
    expect(() => createCustomerLocalHttpWriteAuthority({ ...restoredBase, authorityContinuityEnrollmentGuard: enrollmentGuard } as never)).toThrow(/recovery.*guard|continuity/i);
    const joined = createCustomerLocalHttpWriteAuthority({ ...restoredBase, continuityGuard, authorityContinuityEnrollmentGuard: enrollmentGuard }); closers.push(() => { joined.verifier.close(); joined.issuer.close(); });
    const request = (orderRef: string): CompiledHttpRequest => ({ requestId: `request_${orderRef}`, parentGoalId: "parent_cf077", workItemId: `item_${orderRef}`, driverId: declaration.driverId, targetAlias: declaration.targetAlias, serverUrl: declaration.serverUrl, operationId: declaration.operation.operationId, method: "POST", path: "/orders", query: {}, headers: {}, body: { order_ref: orderRef, quantity: 1 }, credentialAlias: declaration.credentialAlias, reconciliationKey: orderRef, declarationDigest: declaration.declarationDigest });
    const completedRequest = request("COMPLETED"), completedLease = await joined.issuer.issueLease({ request: completedRequest, credentialAlias: "actionBearer" });
    joined.verifier.consume({ lease: completedLease, request: completedRequest, credentialAlias: "actionBearer" });
    const pendingRequest = request("PENDING"), pendingLease = await joined.issuer.issueLease({ request: pendingRequest, credentialAlias: "actionBearer" });
    live.epoch = 2; live.state = "suspended";
    expect(() => joined.verifier.consume({ lease: pendingLease, request: pendingRequest, credentialAlias: "actionBearer" })).toThrow(/provider-state-suspended/i);
    live.epoch = 3; live.state = "active";
    anchor.pinRecoveryManifest(sha("cf077-later-recovery"));
    await expect(joined.issuer.issueLease({ request: request("STALE-GUARD"), credentialAlias: "actionBearer" })).rejects.toThrow(/stale|superseded|mismatched|missing|continuity/i);
  });
});
