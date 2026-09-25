import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthorityContinuityEnrollmentStoppedError,
  assertTrustedAuthorityContinuityEnrollmentGuard,
  createAuthorityContinuityEnrollmentGuard,
  signAuthorityContinuityCurrentnessResponse,
  signAuthorityContinuityEnrollmentPolicy,
  signAuthorityContinuityLiveStatusResponse,
  type AuthorityContinuityLiveStatusChallenge,
} from "../src/product/authority-continuity-enrollment-provider.js";
import { createCustomerLocalAuthorityContinuityGuard } from "../src/product/customer-local-authority-continuity-guard.js";
import { DurableExternalMonotonicContinuityAnchor, type ExternalMonotonicContinuityAnchorConfiguration } from "../src/product/external-monotonic-continuity-anchor.js";
import { DurableAuthorityContinuityStopLedger } from "../src/product/authority-continuity-stop-ledger.js";

const roots: string[] = [], closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0).reverse()) { try { close(); } catch { /* closed */ } } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const pem = (key: ReturnType<typeof generateKeyPairSync>["publicKey"]): string => key.export({ type: "spki", format: "pem" }).toString();

function fixture(label = "base") {
  const provider = generateKeyPairSync("ed25519"), now = { value: Date.parse("2026-08-14T12:00:00.000Z") }, challenge = sha(`challenge:${label}`).slice(0, 48), runtime = sha(`runtime:${label}`), authority = sha(`authority:${label}`), trust = sha(`trust:${label}`);
  const policy = signAuthorityContinuityEnrollmentPolicy({ providerId: "continuity_provider", policyId: `policy_${label}`, policyEpoch: 1, tenantId: "tenant_cf069", installationId: "installation_cf069", workspaceId: "workspace_cf069", authorityContractDigest: authority, trustConfigurationDigest: trust, runtimeReleaseDigest: runtime, enrolledAt: new Date(now.value - 1_000).toISOString(), expiresAt: new Date(now.value + 120_000).toISOString(), providerSignerKeyId: "provider_signer_v1", state: "enrolled", privateKey: provider.privateKey });
  const response = (changes: Partial<Parameters<typeof signAuthorityContinuityCurrentnessResponse>[0]> = {}) => signAuthorityContinuityCurrentnessResponse({ providerId: policy.providerId, policyId: policy.policyId, policyEpoch: policy.policyEpoch, policyDigest: policy.policyDigest, tenantId: policy.tenantId, installationId: policy.installationId, workspaceId: policy.workspaceId, authorityContractDigest: policy.authorityContractDigest, trustConfigurationDigest: policy.trustConfigurationDigest, runtimeReleaseDigest: policy.runtimeReleaseDigest, challengeNonce: challenge, state: "active", continuityGuardIdentityDigest: null, issuedAt: new Date(now.value - 1).toISOString(), expiresAt: new Date(now.value + 30_000).toISOString(), providerSignerKeyId: policy.providerSignerKeyId, ...changes, privateKey: provider.privateKey });
  return { provider, now, challenge, runtime, authority, trust, policy, response };
}

describe("CF-069 separately administered continuity enrollment", () => {
  it("creates a current exact-installation guard and rejects structural substitution", () => {
    const f = fixture(), guard = createAuthorityContinuityEnrollmentGuard({ policy: f.policy, response: f.response(), providerPublicKey: f.provider.publicKey, expectedChallengeNonce: f.challenge, expectedRuntimeReleaseDigest: f.runtime, now: () => new Date(f.now.value).toISOString() });
    expect(guard).toMatchObject({ policyDigest: f.policy.policyDigest, tenantId: "tenant_cf069", installationId: "installation_cf069", runtimeReleaseDigest: f.runtime, continuityGuardIdentityDigest: null });
    expect(() => assertTrustedAuthorityContinuityEnrollmentGuard({ ...guard } as never)).toThrow(/not an instance/i);
    expect(guard.withCurrentConsumption(() => "allowed")).toBe("allowed");
  });

  it("rejects missing current enrollment through suspended, stale, replayed-challenge and old-runtime responses", () => {
    const f = fixture("stops");
    const suspendedPolicy = signAuthorityContinuityEnrollmentPolicy({ providerId: f.policy.providerId, policyId: f.policy.policyId, policyEpoch: 2, tenantId: f.policy.tenantId, installationId: f.policy.installationId, workspaceId: f.policy.workspaceId, authorityContractDigest: f.policy.authorityContractDigest, trustConfigurationDigest: f.policy.trustConfigurationDigest, runtimeReleaseDigest: f.policy.runtimeReleaseDigest, enrolledAt: f.policy.enrolledAt, expiresAt: f.policy.expiresAt, providerSignerKeyId: f.policy.providerSignerKeyId, state: "suspended", privateKey: f.provider.privateKey });
    expect(() => createAuthorityContinuityEnrollmentGuard({ policy: suspendedPolicy, response: f.response({ policyDigest: suspendedPolicy.policyDigest, policyEpoch: suspendedPolicy.policyEpoch }), providerPublicKey: f.provider.publicKey, expectedChallengeNonce: f.challenge, expectedRuntimeReleaseDigest: f.runtime, now: () => new Date(f.now.value).toISOString() })).toThrow(/inactive|invalid/i);
    expect(() => createAuthorityContinuityEnrollmentGuard({ policy: f.policy, response: f.response({ state: "suspended" }), providerPublicKey: f.provider.publicKey, expectedChallengeNonce: f.challenge, expectedRuntimeReleaseDigest: f.runtime, now: () => new Date(f.now.value).toISOString() })).toThrow(/inactive|missing|stale|replayed/i);
    expect(() => createAuthorityContinuityEnrollmentGuard({ policy: f.policy, response: f.response({ challengeNonce: sha("other").slice(0, 48) }), providerPublicKey: f.provider.publicKey, expectedChallengeNonce: f.challenge, expectedRuntimeReleaseDigest: f.runtime, now: () => new Date(f.now.value).toISOString() })).toThrow(/replayed|cross-installation|missing|stale/i);
    expect(() => createAuthorityContinuityEnrollmentGuard({ policy: f.policy, response: f.response({ runtimeReleaseDigest: sha("old-runtime") }), providerPublicKey: f.provider.publicKey, expectedChallengeNonce: f.challenge, expectedRuntimeReleaseDigest: f.runtime, now: () => new Date(f.now.value).toISOString() })).toThrow(/cross-installation|missing|stale|replayed/i);
    f.now.value += 31_000;
    expect(() => createAuthorityContinuityEnrollmentGuard({ policy: f.policy, response: f.response({ issuedAt: new Date(f.now.value - 31_001).toISOString(), expiresAt: new Date(f.now.value - 1).toISOString() }), providerPublicKey: f.provider.publicKey, expectedChallengeNonce: f.challenge, expectedRuntimeReleaseDigest: f.runtime, now: () => new Date(f.now.value).toISOString() })).toThrow(/stale|missing|replayed/i);
  });

  it("rejects provider-key, policy, installation and response mutation", () => {
    const f = fixture("mutation"), attacker = generateKeyPairSync("ed25519"), response = f.response();
    expect(() => createAuthorityContinuityEnrollmentGuard({ policy: f.policy, response, providerPublicKey: attacker.publicKey, expectedChallengeNonce: f.challenge, expectedRuntimeReleaseDigest: f.runtime })).toThrow(/provider|signed|invalid/i);
    expect(() => createAuthorityContinuityEnrollmentGuard({ policy: { ...f.policy, installationId: "installation_attacker" }, response, providerPublicKey: f.provider.publicKey, expectedChallengeNonce: f.challenge, expectedRuntimeReleaseDigest: f.runtime })).toThrow(/provider|signed|invalid/i);
    expect(() => createAuthorityContinuityEnrollmentGuard({ policy: f.policy, response: { ...response, workspaceId: "workspace_attacker" }, providerPublicKey: f.provider.publicKey, expectedChallengeNonce: f.challenge, expectedRuntimeReleaseDigest: f.runtime })).toThrow(/forged|cross-installation|missing|stale|replayed/i);
  });

  it("expires after creation and refuses asynchronous continuity consumption", async () => {
    const f = fixture("expiry"), guard = createAuthorityContinuityEnrollmentGuard({ policy: f.policy, response: f.response(), providerPublicKey: f.provider.publicKey, expectedChallengeNonce: f.challenge, expectedRuntimeReleaseDigest: f.runtime, now: () => new Date(f.now.value).toISOString() });
    expect(() => guard.withCurrentConsumption(() => Promise.resolve("unsafe"))).toThrow(/asynchronous/i);
    f.now.value += 31_000;
    expect(() => guard.assertCurrent()).toThrow(/expired/i);
  });

  it("binds recovered installations to the exact current external continuity guard", () => {
    const f = fixture("recovery"), root = mkdtempSync(join(tmpdir(), "cf069-recovery-")); roots.push(root); const anchorKeys = generateKeyPairSync("ed25519");
    const config: ExternalMonotonicContinuityAnchorConfiguration = { schemaVersion: "1.0", anchorId: "anchor_cf069", tenantId: "tenant_cf069", installationId: "installation_cf069", workspaceId: "workspace_cf069", authorityContractDigest: f.authority, trustConfigurationDigest: f.trust, signerKeyId: "anchor_signer_v1", signerPublicKeyPem: pem(anchorKeys.publicKey) };
    const anchor = new DurableExternalMonotonicContinuityAnchor(join(root, "anchor.sqlite"), config, { signerPrivateKey: anchorKeys.privateKey, now: () => new Date(f.now.value).toISOString() }); closers.push(() => anchor.close());
    const manifest = sha("manifest"), pinned = anchor.pinRecoveryManifest(manifest), recoveryReceipt = sha("receipt"), completion = anchor.completeCurrentRecovery(manifest, recoveryReceipt), continuityGuard = createCustomerLocalAuthorityContinuityGuard({ anchor, recoveryManifestDigest: manifest, recoveryReceiptDigest: recoveryReceipt, recoveryCheckpointDigest: pinned.checkpointDigest, completionCheckpoint: completion });
    const response = f.response({ continuityGuardIdentityDigest: continuityGuard.identityDigest });
    const enrolled = createAuthorityContinuityEnrollmentGuard({ policy: f.policy, response, providerPublicKey: f.provider.publicKey, expectedChallengeNonce: f.challenge, expectedRuntimeReleaseDigest: f.runtime, now: () => new Date(f.now.value).toISOString(), continuityGuard });
    expect(enrolled.continuityGuardIdentityDigest).toBe(continuityGuard.identityDigest);
    expect(() => createAuthorityContinuityEnrollmentGuard({ policy: f.policy, response, providerPublicKey: f.provider.publicKey, expectedChallengeNonce: f.challenge, expectedRuntimeReleaseDigest: f.runtime, now: () => new Date(f.now.value).toISOString() })).toThrow(/without a trusted current guard/i);
    anchor.pinRecoveryManifest(sha("later"));
    expect(() => enrolled.assertCurrent()).toThrow(/stale|superseded|mismatched|missing/i);
  });

  it("uses fresh challenges to reject live suspension, revocation, unavailability, stale status and replay", () => {
    const f = fixture("live"), ledgerRoot = mkdtempSync(join(tmpdir(), "cf072-ledger-")); roots.push(ledgerRoot);
    const ledgerPath = join(ledgerRoot, "stops.sqlite"), ledger = new DurableAuthorityContinuityStopLedger(ledgerPath, f.policy.tenantId, f.policy.installationId); closers.push(() => ledger.close());
    const live = { state: "active" as "active" | "suspended" | "revoked" | "unknown", epoch: 1, available: true, stale: false };
    const signLive = (challenge: AuthorityContinuityLiveStatusChallenge) => signAuthorityContinuityLiveStatusResponse({ ...challenge, statusEpoch: live.epoch, state: live.state, issuedAt: new Date(f.now.value - (live.stale ? 31_000 : 1)).toISOString(), expiresAt: new Date(f.now.value + (live.stale ? -1 : 5_000)).toISOString(), providerSignerKeyId: f.policy.providerSignerKeyId, privateKey: f.provider.privateKey });
    const provider = { queryCurrent(challenge: AuthorityContinuityLiveStatusChallenge) { if (!live.available) throw new Error("offline"); return signLive(challenge); } };
    const guard = createAuthorityContinuityEnrollmentGuard({ policy: f.policy, response: f.response(), providerPublicKey: f.provider.publicKey, expectedChallengeNonce: f.challenge, expectedRuntimeReleaseDigest: f.runtime, now: () => new Date(f.now.value).toISOString(), liveStatusProvider: provider, stopRecorder: ledger });
    expect(() => guard.assertCurrent()).not.toThrow();
    f.now.value += 31_000;
    expect(() => guard.assertCurrent()).not.toThrow();
    live.epoch = 2; live.state = "suspended";
    let stopped: unknown;
    try { guard.assertCurrent(); } catch (error) { stopped = error; }
    expect(stopped).toBeInstanceOf(AuthorityContinuityEnrollmentStoppedError);
    expect((stopped as AuthorityContinuityEnrollmentStoppedError).stopReceipt).toMatchObject({ reason: "provider-state-suspended", observedState: "suspended", observedStatusEpoch: 2, auditAccessAllowed: true, executionAuthorityEffect: "stop-only" });
    expect(JSON.stringify((stopped as AuthorityContinuityEnrollmentStoppedError).stopReceipt)).not.toContain("challengeNonce");
    live.epoch = 3; live.state = "revoked";
    expect(() => guard.assertCurrent()).toThrow(/provider-state-revoked/i);
    live.epoch = 2; live.state = "active";
    expect(() => guard.assertCurrent()).toThrow(/provider-epoch-rollback/i);
    live.epoch = 4; live.state = "active"; live.available = false;
    expect(() => guard.assertCurrent()).toThrow(/provider-unavailable/i);
    live.available = true; live.stale = true;
    expect(() => guard.assertCurrent()).toThrow(/provider-response-stale/i);
    live.stale = false;
    let replay: ReturnType<typeof signLive> | undefined;
    const replayProvider = { queryCurrent(challenge: AuthorityContinuityLiveStatusChallenge) { return replay ??= signLive(challenge); } };
    const replayGuard = createAuthorityContinuityEnrollmentGuard({ policy: f.policy, response: f.response(), providerPublicKey: f.provider.publicKey, expectedChallengeNonce: f.challenge, expectedRuntimeReleaseDigest: f.runtime, now: () => new Date(f.now.value).toISOString(), liveStatusProvider: replayProvider });
    expect(() => replayGuard.assertCurrent()).not.toThrow();
    expect(() => replayGuard.assertCurrent()).toThrow(/provider-response-invalid/i);
    expect(ledger.verify()).toMatchObject({ entries: 5 });
    expect(JSON.stringify(ledger.entries())).not.toMatch(/challengeNonce|privateKey|credential/i);
    ledger.close();
    const reopened = new DurableAuthorityContinuityStopLedger(ledgerPath, f.policy.tenantId, f.policy.installationId); closers.push(() => reopened.close());
    expect(reopened.verify()).toMatchObject({ entries: 5 });
    reopened.close();
    const database = new DatabaseSync(ledgerPath); database.prepare("UPDATE authority_continuity_stops SET receipt_json='{}' WHERE sequence=1").run(); database.close();
    expect(() => new DurableAuthorityContinuityStopLedger(ledgerPath, f.policy.tenantId, f.policy.installationId)).toThrow(/receipt|integrity|tampered|malformed/i);
  });
});
