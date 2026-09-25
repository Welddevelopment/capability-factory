import { createHash, createPublicKey, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { assertTrustedCustomerLocalAuthorityContinuityGuard, type CustomerLocalAuthorityContinuityGuard } from "./customer-local-authority-continuity-guard.js";

export const AUTHORITY_CONTINUITY_ENROLLMENT_VERSION = "1.0" as const;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,179}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const noncePattern = /^[a-f0-9]{32,128}$/;
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
const trustedEnrollmentGuards = new WeakSet<object>();

const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value !== null && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);
const digest = (value: unknown): string => createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
const publicKeyDigest = (key: KeyObject): string => { const publicKey = key.type === "public" ? key : createPublicKey(key); if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Continuity enrollment requires an Ed25519 provider key."); return createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex"); };
const epoch = (value: string, label: string): number => { const result = Date.parse(value); if (!Number.isFinite(result)) throw new Error(`${label} timestamp is invalid.`); return result; };

export interface AuthorityContinuityEnrollmentPolicy {
  schemaVersion: "1.0";
  kind: "authority-continuity-enrollment-policy";
  providerId: string;
  policyId: string;
  policyEpoch: number;
  tenantId: string;
  installationId: string;
  workspaceId: string;
  authorityContractDigest: string;
  trustConfigurationDigest: string;
  runtimeReleaseDigest: string;
  enrolledAt: string;
  expiresAt: string;
  providerSignerKeyId: string;
  providerSignerPublicKeyDigest: string;
  state: "enrolled" | "suspended" | "revoked";
  executionAuthorityEffect: "none";
  policyDigest: string;
  signature: string;
}

type PolicyPayload = Omit<AuthorityContinuityEnrollmentPolicy, "policyDigest" | "signature">;

export function signAuthorityContinuityEnrollmentPolicy(input: Omit<PolicyPayload, "schemaVersion" | "kind" | "providerSignerPublicKeyDigest" | "executionAuthorityEffect"> & { privateKey: KeyObject }): AuthorityContinuityEnrollmentPolicy {
  if (input.privateKey.type !== "private" || input.privateKey.asymmetricKeyType !== "ed25519") throw new Error("Continuity enrollment policy requires an Ed25519 provider private key.");
  const { privateKey, schemaVersion: _schemaVersion, kind: _kind, providerSignerPublicKeyDigest: _providerKeyDigest, executionAuthorityEffect: _authorityEffect, ...rest } = input as typeof input & Partial<PolicyPayload>;
  const payload: PolicyPayload = { schemaVersion: "1.0", kind: "authority-continuity-enrollment-policy", ...rest, providerSignerPublicKeyDigest: publicKeyDigest(privateKey), executionAuthorityEffect: "none" };
  const policyDigest = digest(payload), signature = sign(null, Buffer.from(canonical({ ...payload, policyDigest })), privateKey).toString("base64");
  return { ...payload, policyDigest, signature };
}

export interface AuthorityContinuityCurrentnessResponse {
  schemaVersion: "1.0";
  kind: "authority-continuity-currentness-response";
  providerId: string;
  policyId: string;
  policyEpoch: number;
  policyDigest: string;
  tenantId: string;
  installationId: string;
  workspaceId: string;
  authorityContractDigest: string;
  trustConfigurationDigest: string;
  runtimeReleaseDigest: string;
  challengeNonce: string;
  state: "active" | "suspended" | "revoked" | "unknown";
  continuityGuardIdentityDigest: string | null;
  issuedAt: string;
  expiresAt: string;
  providerSignerKeyId: string;
  providerSignerPublicKeyDigest: string;
  executionAuthorityEffect: "none";
  responseDigest: string;
  signature: string;
}

type ResponsePayload = Omit<AuthorityContinuityCurrentnessResponse, "responseDigest" | "signature">;

export function signAuthorityContinuityCurrentnessResponse(input: Omit<ResponsePayload, "schemaVersion" | "kind" | "providerSignerPublicKeyDigest" | "executionAuthorityEffect"> & { privateKey: KeyObject }): AuthorityContinuityCurrentnessResponse {
  if (input.privateKey.type !== "private" || input.privateKey.asymmetricKeyType !== "ed25519") throw new Error("Continuity currentness response requires an Ed25519 provider private key.");
  const { privateKey, schemaVersion: _schemaVersion, kind: _kind, providerSignerPublicKeyDigest: _providerKeyDigest, executionAuthorityEffect: _authorityEffect, ...rest } = input as typeof input & Partial<ResponsePayload>;
  const payload: ResponsePayload = { schemaVersion: "1.0", kind: "authority-continuity-currentness-response", ...rest, providerSignerPublicKeyDigest: publicKeyDigest(privateKey), executionAuthorityEffect: "none" };
  const responseDigest = digest(payload), signature = sign(null, Buffer.from(canonical({ ...payload, responseDigest })), privateKey).toString("base64");
  return { ...payload, responseDigest, signature };
}

export interface AuthorityContinuityEnrollmentGuard {
  schemaVersion: "1.0";
  providerId: string;
  policyId: string;
  policyEpoch: number;
  policyDigest: string;
  responseDigest: string;
  tenantId: string;
  installationId: string;
  workspaceId: string;
  authorityContractDigest: string;
  trustConfigurationDigest: string;
  runtimeReleaseDigest: string;
  continuityGuardIdentityDigest: string | null;
  expiresAt: string;
  identityDigest: string;
  assertCurrent(): void;
  withCurrentConsumption<T>(consume: () => T): T;
}

export interface AuthorityContinuityLiveStatusChallenge {
  schemaVersion: "1.0";
  kind: "authority-continuity-live-status-challenge";
  providerId: string;
  policyId: string;
  tenantId: string;
  installationId: string;
  workspaceId: string;
  authorityContractDigest: string;
  trustConfigurationDigest: string;
  runtimeReleaseDigest: string;
  challengeNonce: string;
}

export interface AuthorityContinuityLiveStatusResponse extends Omit<AuthorityContinuityLiveStatusChallenge, "kind"> {
  kind: "authority-continuity-live-status-response";
  statusEpoch: number;
  state: "active" | "suspended" | "revoked" | "unknown";
  issuedAt: string;
  expiresAt: string;
  providerSignerKeyId: string;
  providerSignerPublicKeyDigest: string;
  executionAuthorityEffect: "none";
  statusDigest: string;
  signature: string;
}

type LiveStatusPayload = Omit<AuthorityContinuityLiveStatusResponse, "statusDigest" | "signature">;

export function signAuthorityContinuityLiveStatusResponse(input: Omit<LiveStatusPayload, "schemaVersion" | "kind" | "providerSignerPublicKeyDigest" | "executionAuthorityEffect"> & { privateKey: KeyObject }): AuthorityContinuityLiveStatusResponse {
  if (input.privateKey.type !== "private" || input.privateKey.asymmetricKeyType !== "ed25519") throw new Error("Continuity live status requires an Ed25519 provider private key.");
  const { privateKey, schemaVersion: _schemaVersion, kind: _kind, providerSignerPublicKeyDigest: _providerKeyDigest, executionAuthorityEffect: _authorityEffect, ...rest } = input as typeof input & Partial<LiveStatusPayload>;
  const payload: LiveStatusPayload = { schemaVersion: "1.0", kind: "authority-continuity-live-status-response", ...rest, providerSignerPublicKeyDigest: publicKeyDigest(privateKey), executionAuthorityEffect: "none" };
  const statusDigest = digest(payload), signature = sign(null, Buffer.from(canonical({ ...payload, statusDigest })), privateKey).toString("base64");
  return { ...payload, statusDigest, signature };
}

export interface AuthorityContinuityLiveStatusProvider {
  queryCurrent(challenge: AuthorityContinuityLiveStatusChallenge): AuthorityContinuityLiveStatusResponse;
}

export interface AuthorityContinuityProviderStateRecord {
  schemaVersion: "1.0";
  kind: "authority-continuity-provider-state";
  providerId: string;
  policyId: string;
  tenantId: string;
  installationId: string;
  workspaceId: string;
  authorityContractDigest: string;
  trustConfigurationDigest: string;
  runtimeReleaseDigest: string;
  statusEpoch: number;
  state: AuthorityContinuityLiveStatusResponse["state"];
  changedAt: string;
  providerSignerKeyId: string;
  providerSignerPublicKeyDigest: string;
  executionAuthorityEffect: "none";
  stateDigest: string;
  signature: string;
}

type ProviderStatePayload = Omit<AuthorityContinuityProviderStateRecord, "stateDigest" | "signature">;

export function signAuthorityContinuityProviderState(input: Omit<ProviderStatePayload, "schemaVersion" | "kind" | "providerSignerPublicKeyDigest" | "executionAuthorityEffect"> & { privateKey: KeyObject }): AuthorityContinuityProviderStateRecord {
  if (input.privateKey.type !== "private" || input.privateKey.asymmetricKeyType !== "ed25519") throw new Error("Continuity provider state requires an Ed25519 provider private key.");
  const { privateKey, schemaVersion: _schemaVersion, kind: _kind, providerSignerPublicKeyDigest: _providerKeyDigest, executionAuthorityEffect: _authorityEffect, ...rest } = input as typeof input & Partial<ProviderStatePayload>;
  const payload: ProviderStatePayload = { schemaVersion: "1.0", kind: "authority-continuity-provider-state", ...rest, providerSignerPublicKeyDigest: publicKeyDigest(privateKey), executionAuthorityEffect: "none" };
  const stateDigest = digest(payload), signature = sign(null, Buffer.from(canonical({ ...payload, stateDigest })), privateKey).toString("base64");
  return { ...payload, stateDigest, signature };
}

export function assertAuthorityContinuityProviderState(input: { record: AuthorityContinuityProviderStateRecord; providerPublicKey: KeyObject; expected: Pick<AuthorityContinuityLiveStatusChallenge, "providerId" | "policyId" | "tenantId" | "installationId" | "workspaceId" | "authorityContractDigest" | "trustConfigurationDigest" | "runtimeReleaseDigest"> & { providerSignerKeyId: string } }): void {
  const { record, expected } = input, { stateDigest, signature, ...payload } = record;
  const publicKey = input.providerPublicKey.type === "public" ? input.providerPublicKey : createPublicKey(input.providerPublicKey);
  if (record.schemaVersion !== "1.0" || record.kind !== "authority-continuity-provider-state" || record.providerId !== expected.providerId || record.policyId !== expected.policyId
    || record.tenantId !== expected.tenantId || record.installationId !== expected.installationId || record.workspaceId !== expected.workspaceId || record.authorityContractDigest !== expected.authorityContractDigest
    || record.trustConfigurationDigest !== expected.trustConfigurationDigest || record.runtimeReleaseDigest !== expected.runtimeReleaseDigest || record.providerSignerKeyId !== expected.providerSignerKeyId
    || record.providerSignerPublicKeyDigest !== publicKeyDigest(publicKey) || record.executionAuthorityEffect !== "none" || !Number.isSafeInteger(record.statusEpoch) || record.statusEpoch < 1
    || !["active", "suspended", "revoked", "unknown"].includes(record.state) || !Number.isFinite(Date.parse(record.changedAt)) || stateDigest !== digest(payload) || !base64Pattern.test(signature)
    || !verify(null, Buffer.from(canonical({ ...payload, stateDigest })), publicKey, Buffer.from(signature, "base64"))) throw new Error("Authority continuity provider state is forged, cross-installation, malformed, or widened.");
}

export type AuthorityContinuityEnrollmentStopReason = "provider-unavailable" | "provider-response-invalid" | "provider-response-stale" | "provider-epoch-rollback" | "provider-state-suspended" | "provider-state-revoked" | "provider-state-unknown";

export interface AuthorityContinuityEnrollmentStopReceipt {
  schemaVersion: "1.0";
  kind: "authority-continuity-enrollment-stop-receipt";
  providerId: string;
  policyId: string;
  policyEpoch: number;
  tenantId: string;
  installationId: string;
  workspaceId: string;
  authorityContractDigest: string;
  trustConfigurationDigest: string;
  runtimeReleaseDigest: string;
  reason: AuthorityContinuityEnrollmentStopReason;
  observedState: AuthorityContinuityLiveStatusResponse["state"] | null;
  observedStatusEpoch: number | null;
  observedAt: string;
  auditAccessAllowed: true;
  executionAuthorityEffect: "stop-only";
  receiptDigest: string;
}

export interface AuthorityContinuityEnrollmentStopRecorder {
  record(receipt: AuthorityContinuityEnrollmentStopReceipt): void;
}

export function assertAuthorityContinuityEnrollmentStopReceiptIntegrity(receipt: AuthorityContinuityEnrollmentStopReceipt): void {
  const { receiptDigest, ...payload } = receipt;
  if (receipt.schemaVersion !== "1.0" || receipt.kind !== "authority-continuity-enrollment-stop-receipt" || receipt.auditAccessAllowed !== true || receipt.executionAuthorityEffect !== "stop-only"
    || !identifier.test(receipt.providerId) || !identifier.test(receipt.policyId) || !identifier.test(receipt.tenantId) || !identifier.test(receipt.installationId) || !identifier.test(receipt.workspaceId)
    || !Number.isSafeInteger(receipt.policyEpoch) || receipt.policyEpoch < 1 || !digestPattern.test(receipt.authorityContractDigest) || !digestPattern.test(receipt.trustConfigurationDigest)
    || !digestPattern.test(receipt.runtimeReleaseDigest) || !epoch(receipt.observedAt, "Enrollment stop observation") || receiptDigest !== digest(payload)) throw new Error("Authority continuity stop receipt is malformed, widened, or failed integrity validation.");
}

export class AuthorityContinuityEnrollmentStoppedError extends Error {
  readonly stopReceipt: AuthorityContinuityEnrollmentStopReceipt;
  constructor(receipt: AuthorityContinuityEnrollmentStopReceipt) {
    super(`Authority continuity enrollment stopped: ${receipt.reason}.`);
    this.name = "AuthorityContinuityEnrollmentStoppedError";
    this.stopReceipt = receipt;
  }
}

function stopReceipt(policy: AuthorityContinuityEnrollmentPolicy, reason: AuthorityContinuityEnrollmentStopReason, observedAt: string, response?: AuthorityContinuityLiveStatusResponse): AuthorityContinuityEnrollmentStopReceipt {
  const payload = {
    schemaVersion: "1.0" as const, kind: "authority-continuity-enrollment-stop-receipt" as const,
    providerId: policy.providerId, policyId: policy.policyId, policyEpoch: policy.policyEpoch,
    tenantId: policy.tenantId, installationId: policy.installationId, workspaceId: policy.workspaceId,
    authorityContractDigest: policy.authorityContractDigest, trustConfigurationDigest: policy.trustConfigurationDigest,
    runtimeReleaseDigest: policy.runtimeReleaseDigest, reason,
    observedState: response?.state ?? null, observedStatusEpoch: response?.statusEpoch ?? null,
    observedAt, auditAccessAllowed: true as const, executionAuthorityEffect: "stop-only" as const,
  };
  return Object.freeze({ ...payload, receiptDigest: digest(payload) });
}

function assertFreshLiveStatus(input: { policy: AuthorityContinuityEnrollmentPolicy; response: AuthorityContinuityLiveStatusResponse; challenge: AuthorityContinuityLiveStatusChallenge; providerPublicKey: KeyObject; now: string }): void {
  const { response, challenge, policy } = input, { statusDigest, signature, ...payload } = response;
  const providerKey = input.providerPublicKey.type === "public" ? input.providerPublicKey : createPublicKey(input.providerPublicKey);
  const issued = epoch(response.issuedAt, "Live status issue"), expires = epoch(response.expiresAt, "Live status expiry"), current = epoch(input.now, "Live status currentness");
  if (response.schemaVersion !== "1.0" || response.kind !== "authority-continuity-live-status-response"
    || response.providerId !== challenge.providerId || response.policyId !== challenge.policyId || response.tenantId !== challenge.tenantId
    || response.installationId !== challenge.installationId || response.workspaceId !== challenge.workspaceId
    || response.authorityContractDigest !== challenge.authorityContractDigest || response.trustConfigurationDigest !== challenge.trustConfigurationDigest
    || response.runtimeReleaseDigest !== challenge.runtimeReleaseDigest || response.challengeNonce !== challenge.challengeNonce
    || response.providerSignerKeyId !== policy.providerSignerKeyId || response.providerSignerPublicKeyDigest !== policy.providerSignerPublicKeyDigest
    || response.executionAuthorityEffect !== "none" || !Number.isSafeInteger(response.statusEpoch) || response.statusEpoch < policy.policyEpoch
    || !digestPattern.test(statusDigest) || statusDigest !== digest(payload) || !base64Pattern.test(signature)
    || !verify(null, Buffer.from(canonical({ ...payload, statusDigest })), providerKey, Buffer.from(signature, "base64"))) throw new Error("invalid");
  if (issued > current || expires <= issued || expires <= current || expires - issued > 30_000) throw new Error("stale");
}

function verifySignedPolicy(policy: AuthorityContinuityEnrollmentPolicy, providerPublicKey: KeyObject, now: string): void {
  const { policyDigest, signature, ...payload } = policy;
  const providerKey = providerPublicKey.type === "public" ? providerPublicKey : createPublicKey(providerPublicKey);
  const current = epoch(now, "Enrollment policy currentness"), enrolled = epoch(policy.enrolledAt, "Enrollment policy enrollment"), expires = epoch(policy.expiresAt, "Enrollment policy expiry");
  if (policy.schemaVersion !== "1.0" || policy.kind !== "authority-continuity-enrollment-policy" || policy.state !== "enrolled" || !identifier.test(policy.providerId) || !identifier.test(policy.policyId) || !identifier.test(policy.tenantId) || !identifier.test(policy.installationId) || !identifier.test(policy.workspaceId) || !identifier.test(policy.providerSignerKeyId) || !Number.isSafeInteger(policy.policyEpoch) || policy.policyEpoch < 1 || !digestPattern.test(policy.authorityContractDigest) || !digestPattern.test(policy.trustConfigurationDigest) || !digestPattern.test(policy.runtimeReleaseDigest) || policy.providerSignerPublicKeyDigest !== publicKeyDigest(providerPublicKey) || policy.executionAuthorityEffect !== "none" || policyDigest !== digest(payload) || !base64Pattern.test(signature) || !verify(null, Buffer.from(canonical({ ...payload, policyDigest })), providerKey, Buffer.from(signature, "base64")) || enrolled > current || expires <= current || expires <= enrolled || expires - enrolled > 31 * 24 * 60 * 60 * 1_000) throw new Error("Continuity enrollment policy is invalid, inactive, stale, widened, or not signed by the pinned provider.");
}

export function createAuthorityContinuityEnrollmentGuard(input: {
  policy: AuthorityContinuityEnrollmentPolicy;
  response: AuthorityContinuityCurrentnessResponse;
  providerPublicKey: KeyObject;
  expectedChallengeNonce: string;
  expectedRuntimeReleaseDigest: string;
  now?: () => string;
  continuityGuard?: CustomerLocalAuthorityContinuityGuard;
  liveStatusProvider?: AuthorityContinuityLiveStatusProvider;
  stopRecorder?: AuthorityContinuityEnrollmentStopRecorder;
}): AuthorityContinuityEnrollmentGuard {
  const now = input.now ?? (() => new Date().toISOString()), measured = now();
  const providerKey = input.providerPublicKey.type === "public" ? input.providerPublicKey : createPublicKey(input.providerPublicKey);
  verifySignedPolicy(input.policy, input.providerPublicKey, measured);
  const response = input.response, { responseDigest, signature, ...responsePayload } = response;
  const issued = epoch(response.issuedAt, "Enrollment response issue"), expires = epoch(response.expiresAt, "Enrollment response expiry"), current = epoch(measured, "Enrollment response currentness");
  if (!noncePattern.test(input.expectedChallengeNonce) || /^0+$/.test(input.expectedChallengeNonce) || response.schemaVersion !== "1.0" || response.kind !== "authority-continuity-currentness-response" || response.state !== "active" || response.policyDigest !== input.policy.policyDigest || response.providerId !== input.policy.providerId || response.policyId !== input.policy.policyId || response.policyEpoch !== input.policy.policyEpoch || response.tenantId !== input.policy.tenantId || response.installationId !== input.policy.installationId || response.workspaceId !== input.policy.workspaceId || response.authorityContractDigest !== input.policy.authorityContractDigest || response.trustConfigurationDigest !== input.policy.trustConfigurationDigest || response.runtimeReleaseDigest !== input.policy.runtimeReleaseDigest || response.runtimeReleaseDigest !== input.expectedRuntimeReleaseDigest || response.challengeNonce !== input.expectedChallengeNonce || response.providerSignerKeyId !== input.policy.providerSignerKeyId || response.providerSignerPublicKeyDigest !== input.policy.providerSignerPublicKeyDigest || response.executionAuthorityEffect !== "none" || !digestPattern.test(responseDigest) || responseDigest !== digest(responsePayload) || !base64Pattern.test(signature) || !verify(null, Buffer.from(canonical({ ...responsePayload, responseDigest })), providerKey, Buffer.from(signature, "base64")) || issued > current || expires <= current || expires <= issued || expires - issued > 5 * 60 * 1_000 || expires > epoch(input.policy.expiresAt, "Enrollment policy expiry")) throw new Error("Continuity enrollment response is missing, stale, replayed, cross-installation, inactive, or forged.");
  if (input.continuityGuard) {
    assertTrustedCustomerLocalAuthorityContinuityGuard(input.continuityGuard);
    if (response.continuityGuardIdentityDigest !== input.continuityGuard.identityDigest || input.continuityGuard.tenantId !== input.policy.tenantId || input.continuityGuard.installationId !== input.policy.installationId || input.continuityGuard.workspaceId !== input.policy.workspaceId || input.continuityGuard.authorityContractDigest !== input.policy.authorityContractDigest || input.continuityGuard.trustConfigurationDigest !== input.policy.trustConfigurationDigest) throw new Error("Enrollment response does not bind the exact current external recovery continuity guard.");
  } else if (response.continuityGuardIdentityDigest !== null) throw new Error("Enrollment response claims recovery continuity without a trusted current guard.");
  const body = {
    schemaVersion: "1.0" as const, providerId: input.policy.providerId, policyId: input.policy.policyId, policyEpoch: input.policy.policyEpoch,
    policyDigest: input.policy.policyDigest, responseDigest, tenantId: input.policy.tenantId, installationId: input.policy.installationId,
    workspaceId: input.policy.workspaceId, authorityContractDigest: input.policy.authorityContractDigest, trustConfigurationDigest: input.policy.trustConfigurationDigest,
    runtimeReleaseDigest: input.policy.runtimeReleaseDigest, continuityGuardIdentityDigest: response.continuityGuardIdentityDigest, expiresAt: response.expiresAt,
  };
  let lastLiveStatusEpoch = input.policy.policyEpoch;
  let lastLiveState: AuthorityContinuityLiveStatusResponse["state"] = "active";
  const failStop = (receipt: AuthorityContinuityEnrollmentStopReceipt): never => {
    assertAuthorityContinuityEnrollmentStopReceiptIntegrity(receipt);
    input.stopRecorder?.record(receipt);
    throw new AuthorityContinuityEnrollmentStoppedError(receipt);
  };
  const assertCurrent = () => {
    const measuredAt = now();
    verifySignedPolicy(input.policy, input.providerPublicKey, measuredAt);
    if (!input.liveStatusProvider && epoch(response.expiresAt, "Enrollment response expiry") <= epoch(measuredAt, "Enrollment response currentness")) throw new Error("Continuity enrollment response expired after authority-capable startup.");
    input.continuityGuard?.assertCurrent();
    if (input.liveStatusProvider) {
      const challenge: AuthorityContinuityLiveStatusChallenge = {
        schemaVersion: "1.0", kind: "authority-continuity-live-status-challenge", providerId: input.policy.providerId, policyId: input.policy.policyId,
        tenantId: input.policy.tenantId, installationId: input.policy.installationId, workspaceId: input.policy.workspaceId,
        authorityContractDigest: input.policy.authorityContractDigest, trustConfigurationDigest: input.policy.trustConfigurationDigest,
        runtimeReleaseDigest: input.policy.runtimeReleaseDigest, challengeNonce: randomBytes(24).toString("hex"),
      };
      let liveResponse: AuthorityContinuityLiveStatusResponse;
      try { liveResponse = input.liveStatusProvider.queryCurrent(Object.freeze(challenge)); }
      catch { return failStop(stopReceipt(input.policy, "provider-unavailable", measuredAt)); }
      const liveMeasuredAt = now();
      try { assertFreshLiveStatus({ policy: input.policy, response: liveResponse, challenge, providerPublicKey: input.providerPublicKey, now: liveMeasuredAt }); }
      catch (error) {
        const reason: AuthorityContinuityEnrollmentStopReason = error instanceof Error && error.message === "stale" ? "provider-response-stale"
          : Number.isSafeInteger(liveResponse.statusEpoch) && liveResponse.statusEpoch < input.policy.policyEpoch ? "provider-epoch-rollback" : "provider-response-invalid";
        return failStop(stopReceipt(input.policy, reason, liveMeasuredAt, liveResponse));
      }
      if (liveResponse.statusEpoch < lastLiveStatusEpoch) return failStop(stopReceipt(input.policy, "provider-epoch-rollback", liveMeasuredAt, liveResponse));
      if (liveResponse.statusEpoch === lastLiveStatusEpoch && liveResponse.state !== lastLiveState) return failStop(stopReceipt(input.policy, "provider-response-invalid", liveMeasuredAt, liveResponse));
      if (liveResponse.statusEpoch > lastLiveStatusEpoch) { lastLiveStatusEpoch = liveResponse.statusEpoch; lastLiveState = liveResponse.state; }
      if (liveResponse.state !== "active") return failStop(stopReceipt(input.policy, `provider-state-${liveResponse.state}` as AuthorityContinuityEnrollmentStopReason, liveMeasuredAt, liveResponse));
    }
  };
  const guard: AuthorityContinuityEnrollmentGuard = Object.freeze({
    ...body, identityDigest: digest(body), assertCurrent,
    withCurrentConsumption<T>(consume: () => T): T { if (typeof consume !== "function") throw new Error("Enrollment continuity consumption requires one synchronous operation."); assertCurrent(); const result = input.continuityGuard ? input.continuityGuard.withCurrentConsumption(consume) : consume(); if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") throw new Error("Enrollment continuity cannot span an asynchronous callback."); return result; },
  });
  trustedEnrollmentGuards.add(guard);
  return guard;
}

export function assertTrustedAuthorityContinuityEnrollmentGuard(guard: AuthorityContinuityEnrollmentGuard): void {
  if (!trustedEnrollmentGuards.has(guard)) throw new Error("Authority continuity enrollment guard is not an instance of the trusted provider implementation.");
  guard.assertCurrent();
}
