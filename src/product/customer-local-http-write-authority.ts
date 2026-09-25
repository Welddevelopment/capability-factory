import {
  createHash,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AuthorityWizardCompilation } from "./onboarding-verifier-authority.js";
import { assertAuthorityWizardCompilationIntegrity } from "./onboarding-verifier-authority.js";
import type { HttpActionBindingDeclaration } from "./http-binding-factory.js";
import type { CompiledHttpObservationResult, CompiledHttpRequest } from "./http-binding-compiler.js";
import {
  assertTrustedCustomerLocalHttpAuthorityTrustBinding,
  type CustomerLocalHttpAuthorityTrustBinding,
  type CustomerLocalHttpAuthorityTrustStore,
} from "./customer-local-http-authority-trust.js";
import { assertTrustedCustomerLocalAuthorityContinuityGuard, type CustomerLocalAuthorityContinuityGuard } from "./customer-local-authority-continuity-guard.js";
import { assertTrustedAuthorityContinuityEnrollmentGuard, type AuthorityContinuityEnrollmentGuard } from "./authority-continuity-enrollment-provider.js";

export const CUSTOMER_LOCAL_HTTP_WRITE_AUTHORITY_VERSION = "1.3" as const;

const identifier = /^[a-zA-Z][a-zA-Z0-9_.-]{1,179}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
const trustedIssuers = new WeakSet<object>();
const trustedVerifiers = new WeakSet<object>();
const trustedRecoveryObserverSigners = new WeakSet<object>();
const trustedRecoveryObservationSessions = new WeakSet<object>();
const MAXIMUM_UNCONSUMED_LEASE_GENERATIONS = 3;

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
}

export function customerLocalAuthorityDigest(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

function publicKeyDer(key: KeyObject): Buffer {
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error("HTTP write authority requires an Ed25519 public key.");
  return key.export({ type: "spki", format: "der" });
}

function publicKeyDigest(key: KeyObject): string {
  return createHash("sha256").update(publicKeyDer(key)).digest("hex");
}

function assertDigest(value: string, label: string): void {
  if (!digestPattern.test(value) || /^0+$/.test(value)) throw new Error(`${label} must be a non-placeholder SHA-256 digest.`);
}

function assertIdentifier(value: string, label: string): void {
  if (!identifier.test(value)) throw new Error(`${label} must be a stable identifier.`);
}

function assertIsoRange(issuedAt: string, expiresAt: string, now: number): { issued: number; expires: number } {
  const issued = Date.parse(issuedAt), expires = Date.parse(expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now || expires <= issued || expires <= now) {
    throw new Error("HTTP write authority lease or approval is not currently valid.");
  }
  return { issued, expires };
}

function sameDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex"), rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export interface HttpActionApprovalReceipt {
  schemaVersion: "1.0";
  signerKeyId: string;
  approverOwnerAlias: string;
  requestDigest: string;
  parentGoalId: string;
  workItemId: string;
  issuedAt: string;
  expiresAt: string;
  approvalNonce: string;
  signature: string;
  receiptDigest: string;
}

export interface WorkspaceHttpAuthorityActivationReceipt {
  schemaVersion: "1.0";
  adminSignerKeyId: string;
  workspaceId: string;
  authorityContractDigest: string;
  issuedAt: string;
  expiresAt: string;
  activationNonce: string;
  signature: string;
  receiptDigest: string;
}

export interface HttpActionAuthorityLease {
  schemaVersion: "2.1";
  signerKeyId: string;
  authorityPublicKeyDigest: string;
  policyDigest: string;
  policyEpoch: number;
  workspaceId: string;
  workspaceAuthorityActivationDigest?: string;
  leaseId: string;
  requestDigest: string;
  actionDeclarationDigest: string;
  authorityCompilationDigest: string;
  transportAuthorityBoundaryDigest: string;
  credentialResolverDigest: string;
  credentialAlias: string;
  targetAlias: string;
  operationId: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  parentGoalId: string;
  workItemId: string;
  issuedAt: string;
  expiresAt: string;
  approvalReceiptDigest?: string;
  attempt: 1 | 2;
  generation: number;
  priorLeaseDigest?: string;
  notStartedRecoveryReceiptDigest?: string;
  transportReservationDigest?: string;
  priorUnconsumedLeaseDigest?: string;
  signature: string;
  leaseDigest: string;
}

export interface HttpNotStartedRecoveryReceipt {
  schemaVersion: "1.0";
  signerKeyId: string;
  observerImplementationDigest: string;
  observerBindingDigest: string;
  observerQualificationDigest: string;
  priorLeaseDigest: string;
  requestDigest: string;
  observationRequestDigest: string;
  parentGoalId: string;
  workItemId: string;
  reconciliationKeyDigest: string;
  observationDigest: string;
  classification: "not-started";
  stateDigest: string;
  observationStartedAt: string;
  observationCompletedAt: string;
  serverObservedAt: string;
  expiresAt: string;
  actionResponseUsedAsProof: false;
  recoveryNonce: string;
  signature: string;
  receiptDigest: string;
}

export interface HttpNotStartedRecoveryEvidence {
  priorLease: HttpActionAuthorityLease;
  receipt: HttpNotStartedRecoveryReceipt;
  observation: CompiledHttpObservationResult;
}

export interface HttpUnconsumedLeaseReplacementEvidence {
  priorLease: HttpActionAuthorityLease;
  reason: "expired-before-consume";
}

export interface HttpNotStartedRecoveryObservationSession {
  sessionId: string;
  signerKeyId: string;
  priorLeaseDigest: string;
  requestDigest: string;
  observationRequestDigest: string;
  parentGoalId: string;
  workItemId: string;
  reconciliationKeyDigest: string;
  observationStartedAt: string;
}

export interface CustomerLocalHttpNotStartedObserverSigner {
  signerKeyId: string;
  observerImplementationDigest: string;
  observerBindingDigest: string;
  observerQualificationDigest: string;
  begin(input: { priorLease: HttpActionAuthorityLease; actionRequest: CompiledHttpRequest; observationRequest: CompiledHttpRequest }): HttpNotStartedRecoveryObservationSession;
  complete(input: { session: HttpNotStartedRecoveryObservationSession; observation: CompiledHttpObservationResult }): HttpNotStartedRecoveryReceipt;
}

type ApprovalPayload = Omit<HttpActionApprovalReceipt, "signature" | "receiptDigest">;
type WorkspaceActivationPayload = Omit<WorkspaceHttpAuthorityActivationReceipt, "signature" | "receiptDigest">;
type LeasePayload = Omit<HttpActionAuthorityLease, "signature" | "leaseDigest">;
type NotStartedRecoveryPayload = Omit<HttpNotStartedRecoveryReceipt, "signature" | "receiptDigest">;

function approvalPayload(receipt: HttpActionApprovalReceipt): ApprovalPayload {
  const { signature: _signature, receiptDigest: _receiptDigest, ...payload } = receipt;
  return payload;
}

function leasePayload(lease: HttpActionAuthorityLease): LeasePayload {
  const { signature: _signature, leaseDigest: _leaseDigest, ...payload } = lease;
  return payload;
}

function workspaceActivationPayload(receipt: WorkspaceHttpAuthorityActivationReceipt): WorkspaceActivationPayload {
  const { signature: _signature, receiptDigest: _receiptDigest, ...payload } = receipt;
  return payload;
}

function notStartedRecoveryPayload(receipt: HttpNotStartedRecoveryReceipt): NotStartedRecoveryPayload {
  const { signature: _signature, receiptDigest: _receiptDigest, ...payload } = receipt;
  return payload;
}

export function signWorkspaceHttpAuthorityActivation(input: {
  adminSignerKeyId: string;
  workspaceId: string;
  authorityContractDigest: string;
  privateKey: KeyObject;
  issuedAt: string;
  expiresAt: string;
  activationNonce?: string;
}): WorkspaceHttpAuthorityActivationReceipt {
  assertIdentifier(input.adminSignerKeyId, "Workspace admin signer key ID");
  assertIdentifier(input.workspaceId, "Workspace ID");
  assertDigest(input.authorityContractDigest, "Workspace authority contract digest");
  if (input.privateKey.type !== "private" || input.privateKey.asymmetricKeyType !== "ed25519") throw new Error("Workspace authority activation requires an Ed25519 private key.");
  const payload: WorkspaceActivationPayload = {
    schemaVersion: "1.0",
    adminSignerKeyId: input.adminSignerKeyId,
    workspaceId: input.workspaceId,
    authorityContractDigest: input.authorityContractDigest,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    activationNonce: input.activationNonce ?? randomBytes(24).toString("hex"),
  };
  if (!/^[a-f0-9]{32,128}$/.test(payload.activationNonce) || /^0+$/.test(payload.activationNonce)) throw new Error("Workspace authority activation nonce must be non-placeholder hexadecimal material.");
  const signature = sign(null, Buffer.from(canonical(payload)), input.privateKey).toString("base64");
  return Object.freeze({ ...payload, signature, receiptDigest: customerLocalAuthorityDigest({ payload, signature }) });
}

export function signHttpActionApproval(input: {
  signerKeyId: string;
  approverOwnerAlias: string;
  request: CompiledHttpRequest;
  privateKey: KeyObject;
  issuedAt: string;
  expiresAt: string;
  approvalNonce?: string;
}): HttpActionApprovalReceipt {
  assertIdentifier(input.signerKeyId, "Approval signer key ID");
  assertIdentifier(input.approverOwnerAlias, "Approval owner alias");
  if (input.privateKey.type !== "private" || input.privateKey.asymmetricKeyType !== "ed25519") throw new Error("HTTP action approval requires an Ed25519 private key.");
  const payload: ApprovalPayload = {
    schemaVersion: "1.0",
    signerKeyId: input.signerKeyId,
    approverOwnerAlias: input.approverOwnerAlias,
    requestDigest: compiledHttpWriteRequestDigest(input.request),
    parentGoalId: input.request.parentGoalId,
    workItemId: input.request.workItemId,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    approvalNonce: input.approvalNonce ?? randomBytes(24).toString("hex"),
  };
  if (!/^[a-f0-9]{32,128}$/.test(payload.approvalNonce) || /^0+$/.test(payload.approvalNonce)) throw new Error("HTTP action approval nonce must be a non-placeholder hexadecimal nonce.");
  const signature = sign(null, Buffer.from(canonical(payload)), input.privateKey).toString("base64");
  return Object.freeze({ ...payload, signature, receiptDigest: customerLocalAuthorityDigest({ payload, signature }) });
}

function assertSafeNotStartedObservation(observation: CompiledHttpObservationResult): void {
  if (observation.classification !== "not-started" || observation.passed !== false || observation.nextAction !== "retry-after-authority-recheck" || observation.incorrectSideEffects !== 0 || observation.actionResponseUsedAsProof !== false) {
    throw new Error("HTTP recovery evidence is not an exact independently classified not-started result.");
  }
  assertDigest(observation.stateDigest, "Recovery observation state digest");
  if (!Array.isArray(observation.checks) || observation.checks.length === 0 || observation.checks.length > 256) throw new Error("HTTP recovery observation checks are absent or unbounded.");
  const notStarted = observation.checks.filter((check) => check.role === "not-started");
  const freshness = observation.checks.filter((check) => check.role === "freshness");
  const success = observation.checks.filter((check) => check.role === "success");
  const collateral = observation.checks.filter((check) => check.role === "collateral");
  if (notStarted.length === 0 || !notStarted.every((check) => check.passed) || freshness.length === 0 || !freshness.every((check) => check.passed) || success.some((check) => check.passed) || collateral.some((check) => !check.passed)) {
    throw new Error("HTTP recovery observation contains incomplete, contradictory, stale, or collateral evidence.");
  }
  if (!Number.isFinite(Date.parse(observation.observedAt))) throw new Error("HTTP recovery observation time is malformed.");
}

function recoveryObservationDigest(observation: CompiledHttpObservationResult): string {
  const { notStartedRecoveryReceipt: _receipt, ...payload } = observation;
  return customerLocalAuthorityDigest(payload);
}

interface RecoveryObserverSignerConfig {
  signerKeyId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  observerImplementationDigest: string;
  observerBindingDigest: string;
  observerQualificationDigest: string;
  maximumReceiptMilliseconds?: number;
}

interface InternalRecoveryObserverSignerConfig extends RecoveryObserverSignerConfig {
  now: () => number;
  nonce: () => string;
}

function createCustomerLocalHttpNotStartedObserverSignerInternal(input: InternalRecoveryObserverSignerConfig): CustomerLocalHttpNotStartedObserverSigner {
  assertIdentifier(input.signerKeyId, "Recovery observer signer key ID");
  assertDigest(input.observerImplementationDigest, "Recovery observer implementation digest");
  assertDigest(input.observerBindingDigest, "Recovery observer binding digest");
  assertDigest(input.observerQualificationDigest, "Recovery observer qualification digest");
  if (input.privateKey.type !== "private" || input.privateKey.asymmetricKeyType !== "ed25519" || !timingSafeEqual(publicKeyDer(createPublicKey(input.privateKey)), publicKeyDer(input.publicKey))) throw new Error("HTTP not-started observer signer requires one Ed25519 key pair.");
  const maximumReceiptMilliseconds = input.maximumReceiptMilliseconds ?? 30_000;
  if (!Number.isInteger(maximumReceiptMilliseconds) || maximumReceiptMilliseconds < 1_000 || maximumReceiptMilliseconds > 300_000) throw new Error("HTTP recovery observer receipt lifetime must be between one second and five minutes.");
  const signer: CustomerLocalHttpNotStartedObserverSigner = Object.freeze({
    signerKeyId: input.signerKeyId,
    observerImplementationDigest: input.observerImplementationDigest,
    observerBindingDigest: input.observerBindingDigest,
    observerQualificationDigest: input.observerQualificationDigest,
    begin(beginInput: { priorLease: HttpActionAuthorityLease; actionRequest: CompiledHttpRequest; observationRequest: CompiledHttpRequest }) {
      const requestDigest = compiledHttpWriteRequestDigest(beginInput.actionRequest), observationRequestDigest = compiledHttpWriteRequestDigest(beginInput.observationRequest);
      if (beginInput.priorLease.requestDigest !== requestDigest || beginInput.priorLease.parentGoalId !== beginInput.actionRequest.parentGoalId || beginInput.priorLease.workItemId !== beginInput.actionRequest.workItemId) throw new Error("HTTP recovery observation belongs to different prior action work.");
      if (!["GET", "HEAD"].includes(beginInput.observationRequest.method) || beginInput.observationRequest.parentGoalId !== beginInput.actionRequest.parentGoalId || beginInput.observationRequest.workItemId !== beginInput.actionRequest.workItemId || beginInput.observationRequest.reconciliationKey !== beginInput.actionRequest.reconciliationKey) throw new Error("HTTP recovery observation request is not the exact read-side query for the interrupted work.");
      const sessionId = input.nonce();
      if (!/^[a-f0-9]{32,128}$/.test(sessionId) || /^0+$/.test(sessionId)) throw new Error("HTTP recovery observation session nonce is malformed or placeholder.");
      const session = Object.freeze({
        sessionId,
        signerKeyId: input.signerKeyId,
        priorLeaseDigest: beginInput.priorLease.leaseDigest,
        requestDigest,
        observationRequestDigest,
        parentGoalId: beginInput.actionRequest.parentGoalId,
        workItemId: beginInput.actionRequest.workItemId,
        reconciliationKeyDigest: customerLocalAuthorityDigest(beginInput.actionRequest.reconciliationKey),
        observationStartedAt: new Date(input.now()).toISOString(),
      });
      trustedRecoveryObservationSessions.add(session);
      return session;
    },
    complete(completeInput: { session: HttpNotStartedRecoveryObservationSession; observation: CompiledHttpObservationResult }) {
      const session = completeInput.session;
      if (!trustedRecoveryObservationSessions.has(session) || session.signerKeyId !== input.signerKeyId) throw new Error("HTTP recovery observation session is forged, foreign, or already completed.");
      trustedRecoveryObservationSessions.delete(session);
      assertSafeNotStartedObservation(completeInput.observation);
      const completedAtEpochMs = input.now(), startedAtEpochMs = Date.parse(session.observationStartedAt);
      if (!Number.isFinite(startedAtEpochMs) || completedAtEpochMs < startedAtEpochMs) throw new Error("HTTP recovery observation local clock moved backward during the read.");
      const payload: NotStartedRecoveryPayload = {
        schemaVersion: "1.0",
        signerKeyId: input.signerKeyId,
        observerImplementationDigest: input.observerImplementationDigest,
        observerBindingDigest: input.observerBindingDigest,
        observerQualificationDigest: input.observerQualificationDigest,
        priorLeaseDigest: session.priorLeaseDigest,
        requestDigest: session.requestDigest,
        observationRequestDigest: session.observationRequestDigest,
        parentGoalId: session.parentGoalId,
        workItemId: session.workItemId,
        reconciliationKeyDigest: session.reconciliationKeyDigest,
        observationDigest: recoveryObservationDigest(completeInput.observation),
        classification: "not-started",
        stateDigest: completeInput.observation.stateDigest,
        observationStartedAt: session.observationStartedAt,
        observationCompletedAt: new Date(completedAtEpochMs).toISOString(),
        serverObservedAt: completeInput.observation.observedAt,
        expiresAt: new Date(completedAtEpochMs + maximumReceiptMilliseconds).toISOString(),
        actionResponseUsedAsProof: false,
        recoveryNonce: session.sessionId,
      };
      const signature = sign(null, Buffer.from(canonical(payload)), input.privateKey).toString("base64");
      return Object.freeze({ ...payload, signature, receiptDigest: customerLocalAuthorityDigest({ payload, signature }) });
    },
  });
  trustedRecoveryObserverSigners.add(signer);
  return signer;
}

export function createCustomerLocalHttpNotStartedObserverSigner(input: RecoveryObserverSignerConfig): CustomerLocalHttpNotStartedObserverSigner {
  if (Object.hasOwn(input, "now") || Object.hasOwn(input, "nonce")) throw new Error("Production recovery observer signer does not accept caller-controlled time or nonce sources.");
  return createCustomerLocalHttpNotStartedObserverSignerInternal({ ...input, now: () => Date.now(), nonce: () => randomBytes(24).toString("hex") });
}

export function createTestCustomerLocalHttpNotStartedObserverSigner(input: RecoveryObserverSignerConfig & { testOnly: true; now: () => number; nonce?: () => string }): CustomerLocalHttpNotStartedObserverSigner {
  if (input.testOnly !== true) throw new Error("Test recovery observer signer requires an explicit test-only boundary.");
  return createCustomerLocalHttpNotStartedObserverSignerInternal({ ...input, nonce: input.nonce ?? (() => randomBytes(24).toString("hex")) });
}

export function assertTrustedCustomerLocalHttpNotStartedObserverSigner(value: CustomerLocalHttpNotStartedObserverSigner): void {
  if (!trustedRecoveryObserverSigners.has(value)) throw new Error("HTTP recovery observer signer is not an instance of the trusted customer-local implementation.");
}

export function compiledHttpWriteRequestDigest(request: CompiledHttpRequest): string {
  return customerLocalAuthorityDigest({
    requestId: request.requestId,
    parentGoalId: request.parentGoalId,
    workItemId: request.workItemId,
    driverId: request.driverId,
    targetAlias: request.targetAlias,
    serverUrl: request.serverUrl,
    operationId: request.operationId,
    method: request.method,
    path: request.path,
    query: request.query,
    headers: request.headers,
    body: request.body,
    credentialAlias: request.credentialAlias,
    reconciliationKey: request.reconciliationKey,
    declarationDigest: request.declarationDigest,
  });
}

export type HttpAuthorityMetricBinding =
  | { kind: "json-body-number"; field: string }
  | { kind: "trusted-constant"; value: number };

export interface CustomerLocalHttpWriteAuthorityIssuer {
  issuerId: string;
  implementationDigest: string;
  policyDigest: string;
  authorityCompilationDigest: string;
  actionDeclarationDigest: string;
  transportAuthorityBoundaryDigest: string;
  credentialResolverDigest: string;
  verifierImplementationDigest: string;
  recoveryObserverImplementationDigest?: string;
  recoveryObserverBindingDigest?: string;
  recoveryObserverQualificationDigest?: string;
  issueLease(input: {
    request: CompiledHttpRequest;
    credentialAlias: string;
    transportReservationDigest?: string;
    approvalReceipt?: HttpActionApprovalReceipt;
    notStartedRecovery?: HttpNotStartedRecoveryEvidence;
    unconsumedReplacement?: HttpUnconsumedLeaseReplacementEvidence;
  }): Promise<HttpActionAuthorityLease>;
  revokeAll(reason: string): void;
  close(): void;
}

export interface CustomerLocalHttpWriteAuthorityVerifier {
  verifierId: string;
  implementationDigest: string;
  policyDigest: string;
  transportAuthorityBoundaryDigest: string;
  consume(input: {
    lease: HttpActionAuthorityLease | undefined;
    request: CompiledHttpRequest;
    credentialAlias: string;
    transportReservationDigest?: string;
  }): void;
  close(): void;
}

/** Prevents an arbitrary structurally similar object from substituting for the trusted issuer implementation. */
export function assertTrustedCustomerLocalHttpWriteAuthorityIssuer(value: CustomerLocalHttpWriteAuthorityIssuer): void {
  if (!trustedIssuers.has(value)) throw new Error("HTTP write-authority issuer is not an instance of the trusted customer-local implementation.");
}

/** Prevents a no-op structural verifier from being pinned into a write transport. */
export function assertTrustedCustomerLocalHttpWriteAuthorityVerifier(value: CustomerLocalHttpWriteAuthorityVerifier): void {
  if (!trustedVerifiers.has(value)) throw new Error("HTTP write-authority verifier is not an instance of the trusted customer-local implementation.");
}

interface CommonAuthorityConfig {
  statePath: string;
  issuerId: string;
  signerKeyId: string;
  publicKey: KeyObject;
  transportAuthorityBoundaryDigest: string;
}

export interface CustomerLocalHttpWriteAuthorityConfig extends CommonAuthorityConfig {
  privateKey: KeyObject;
  authorityCompilation: AuthorityWizardCompilation;
  actionDeclaration: HttpActionBindingDeclaration;
  credentialResolverDigest: string;
  quantityMetric?: HttpAuthorityMetricBinding;
  monetaryMetric?: HttpAuthorityMetricBinding & { currency: string };
  maximumLeaseMilliseconds?: number;
  maximumApprovalMilliseconds?: number;
  maximumRecoveryEvidenceMilliseconds?: number;
  approval?: {
    signerKeyId: string;
    publicKey: KeyObject;
  };
  recoveryObserver?: {
    signerKeyId: string;
    publicKey: KeyObject;
    observerImplementationDigest: string;
    observerBindingDigest: string;
    observerQualificationDigest: string;
  };
  workspaceAuthority: {
    workspaceId: string;
    adminSignerKeyId: string;
    adminPublicKey: KeyObject;
    activationReceipt: WorkspaceHttpAuthorityActivationReceipt;
    trustBinding?: CustomerLocalHttpAuthorityTrustBinding;
    continuityGuard?: CustomerLocalAuthorityContinuityGuard;
    enrollmentGuard?: AuthorityContinuityEnrollmentGuard;
  };
}

export type CustomerLocalHttpWriteAuthorityContractInput = Omit<CustomerLocalHttpWriteAuthorityConfig, "workspaceAuthority"> & {
  workspaceAuthority: Omit<CustomerLocalHttpWriteAuthorityConfig["workspaceAuthority"], "activationReceipt">;
};

export type CustomerLocalHttpWriteAuthorityTrustConfig = Omit<CustomerLocalHttpWriteAuthorityConfig, "workspaceAuthority"> & {
  workspaceAuthorityTrustStore: CustomerLocalHttpAuthorityTrustStore;
  continuityGuard?: CustomerLocalAuthorityContinuityGuard;
};

export type EnrolledCustomerLocalHttpWriteAuthorityTrustConfig = CustomerLocalHttpWriteAuthorityTrustConfig & {
  authorityContinuityEnrollmentGuard: AuthorityContinuityEnrollmentGuard;
};

export type TestCustomerLocalHttpWriteAuthorityTrustConfig = CustomerLocalHttpWriteAuthorityTrustConfig & {
  testOnly: true;
};

export type CustomerLocalHttpWriteAuthorityTrustContractInput = Omit<CustomerLocalHttpWriteAuthorityTrustConfig, "workspaceAuthorityTrustStore"> & {
  workspaceAuthorityTrust: {
    workspaceId: string;
    trustConfigurationDigest: string;
    activationPolicyVersion: "1.0";
  };
};

export interface TestCustomerLocalHttpWriteAuthorityConfig extends CustomerLocalHttpWriteAuthorityConfig {
  testOnly: true;
  now: () => number;
  nonce?: () => string;
}

type InternalCustomerLocalHttpWriteAuthorityConfig = CustomerLocalHttpWriteAuthorityConfig & {
  now: () => number;
  nonce: () => string;
};

function openAuthorityDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const database = new DatabaseSync(path);
  database.exec("PRAGMA busy_timeout=5000;");
  if (path !== ":memory:") chmodSync(path, 0o600);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS http_authority_policy(
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      policy_digest TEXT NOT NULL,
      policy_epoch INTEGER NOT NULL,
      last_seen_epoch_ms INTEGER NOT NULL,
      revoked_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS http_authority_leases(
      lease_id TEXT PRIMARY KEY,
      policy_digest TEXT NOT NULL,
      policy_epoch INTEGER NOT NULL,
      request_digest TEXT NOT NULL,
      action_key_digest TEXT NOT NULL,
      credential_alias TEXT NOT NULL,
      issued_at_epoch_ms INTEGER NOT NULL,
      expires_at_epoch_ms INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('issued','consumed')),
      consumed_at_epoch_ms INTEGER,
      attempt INTEGER NOT NULL DEFAULT 1,
      generation INTEGER NOT NULL DEFAULT 1,
      prior_lease_digest TEXT,
      not_started_recovery_receipt_digest TEXT,
      transport_reservation_digest TEXT,
      prior_unconsumed_lease_digest TEXT,
      retired_at_epoch_ms INTEGER,
      retirement_reason TEXT,
      approval_receipt_digest TEXT,
      lease_digest TEXT
    );
    CREATE INDEX IF NOT EXISTS http_authority_recent_issuance
      ON http_authority_leases(policy_digest, issued_at_epoch_ms);
    CREATE UNIQUE INDEX IF NOT EXISTS http_authority_single_use_approval
      ON http_authority_leases(approval_receipt_digest)
      WHERE approval_receipt_digest IS NOT NULL;
  `);
  const leaseColumns = new Set((database.prepare("PRAGMA table_info(http_authority_leases)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!leaseColumns.has("consumed_at_epoch_ms")) database.exec("ALTER TABLE http_authority_leases ADD COLUMN consumed_at_epoch_ms INTEGER");
  if (!leaseColumns.has("attempt")) database.exec("ALTER TABLE http_authority_leases ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1");
  if (!leaseColumns.has("generation")) database.exec("ALTER TABLE http_authority_leases ADD COLUMN generation INTEGER NOT NULL DEFAULT 1");
  if (!leaseColumns.has("prior_lease_digest")) database.exec("ALTER TABLE http_authority_leases ADD COLUMN prior_lease_digest TEXT");
  if (!leaseColumns.has("not_started_recovery_receipt_digest")) database.exec("ALTER TABLE http_authority_leases ADD COLUMN not_started_recovery_receipt_digest TEXT");
  if (!leaseColumns.has("transport_reservation_digest")) database.exec("ALTER TABLE http_authority_leases ADD COLUMN transport_reservation_digest TEXT");
  if (!leaseColumns.has("prior_unconsumed_lease_digest")) database.exec("ALTER TABLE http_authority_leases ADD COLUMN prior_unconsumed_lease_digest TEXT");
  if (!leaseColumns.has("retired_at_epoch_ms")) database.exec("ALTER TABLE http_authority_leases ADD COLUMN retired_at_epoch_ms INTEGER");
  if (!leaseColumns.has("retirement_reason")) database.exec("ALTER TABLE http_authority_leases ADD COLUMN retirement_reason TEXT");
  database.exec(`
    DROP INDEX IF EXISTS http_authority_single_write_per_work_item;
    DROP INDEX IF EXISTS http_authority_single_attempt_per_work_item;
    CREATE UNIQUE INDEX IF NOT EXISTS http_authority_unique_generation_per_work_item
      ON http_authority_leases(policy_digest, policy_epoch, action_key_digest, attempt, generation);
    CREATE UNIQUE INDEX IF NOT EXISTS http_authority_single_live_generation_per_attempt
      ON http_authority_leases(policy_digest, policy_epoch, action_key_digest, attempt)
      WHERE status = 'issued' AND retired_at_epoch_ms IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS http_authority_single_consumed_execution_attempt
      ON http_authority_leases(policy_digest, policy_epoch, action_key_digest, attempt)
      WHERE status = 'consumed';
    CREATE UNIQUE INDEX IF NOT EXISTS http_authority_single_use_not_started_recovery
      ON http_authority_leases(not_started_recovery_receipt_digest)
      WHERE not_started_recovery_receipt_digest IS NOT NULL;
  `);
  return database;
}

function initializePolicy(database: DatabaseSync, policyDigest: string): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database.prepare("SELECT policy_digest FROM http_authority_policy WHERE singleton = 1").get() as { policy_digest: string } | undefined;
    if (!row) database.prepare("INSERT INTO http_authority_policy(singleton, policy_digest, policy_epoch, last_seen_epoch_ms, revoked_reason) VALUES(1, ?, 1, 0, NULL)").run(policyDigest);
    else if (!sameDigest(row.policy_digest, policyDigest)) throw new Error("Durable HTTP authority state belongs to a different policy.");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function metricValue(binding: HttpAuthorityMetricBinding, request: CompiledHttpRequest, label: string): number {
  const value = binding.kind === "trusted-constant"
    ? binding.value
    : request.body && typeof request.body === "object" && Object.hasOwn(request.body, binding.field)
      ? request.body[binding.field]
      : undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} authority metric is absent, nonnumeric, or negative.`);
  return value;
}

function verifyApproval(input: {
  receipt: HttpActionApprovalReceipt | undefined;
  request: CompiledHttpRequest;
  signerKeyId: string;
  approverOwnerAlias: string;
  publicKey: KeyObject;
  now: number;
  maximumApprovalMilliseconds: number;
}): HttpActionApprovalReceipt {
  const receipt = input.receipt;
  if (!receipt) throw new Error("The reviewed write policy requires an exact signed approval receipt.");
  if (receipt.schemaVersion !== "1.0" || receipt.signerKeyId !== input.signerKeyId || receipt.approverOwnerAlias !== input.approverOwnerAlias) throw new Error("HTTP action approval belongs to a different signer or approver.");
  assertDigest(receipt.requestDigest, "Approval request digest");
  if (receipt.requestDigest !== compiledHttpWriteRequestDigest(input.request) || receipt.parentGoalId !== input.request.parentGoalId || receipt.workItemId !== input.request.workItemId) throw new Error("HTTP action approval is bound to different exact work.");
  const validity = assertIsoRange(receipt.issuedAt, receipt.expiresAt, input.now);
  if (validity.expires - validity.issued > input.maximumApprovalMilliseconds || input.now - validity.issued > input.maximumApprovalMilliseconds) throw new Error("HTTP action approval exceeds the policy-bound maximum age or lifetime.");
  if (!/^[a-f0-9]{32,128}$/.test(receipt.approvalNonce) || /^0+$/.test(receipt.approvalNonce)) throw new Error("HTTP action approval nonce is malformed or placeholder.");
  if (!base64Pattern.test(receipt.signature) || receipt.receiptDigest !== customerLocalAuthorityDigest({ payload: approvalPayload(receipt), signature: receipt.signature }) || !verify(null, Buffer.from(canonical(approvalPayload(receipt))), input.publicKey, Buffer.from(receipt.signature, "base64"))) {
    throw new Error("HTTP action approval failed its signature or integrity check.");
  }
  return receipt;
}

function verifyNotStartedRecovery(input: {
  evidence: HttpNotStartedRecoveryEvidence | undefined;
  request: CompiledHttpRequest;
  observer: NonNullable<CustomerLocalHttpWriteAuthorityConfig["recoveryObserver"]> | undefined;
  now: number;
  maximumRecoveryEvidenceMilliseconds: number;
}): HttpNotStartedRecoveryReceipt {
  if (!input.observer) throw new Error("HTTP write authority has no configured independent recovery observer.");
  const evidence = input.evidence;
  if (!evidence) throw new Error("HTTP retry requires exact signed independently verified not-started evidence.");
  const { priorLease, receipt, observation } = evidence;
  assertSafeNotStartedObservation(observation);
  if (receipt.schemaVersion !== "1.0" || receipt.signerKeyId !== input.observer.signerKeyId
    || receipt.observerImplementationDigest !== input.observer.observerImplementationDigest
    || receipt.observerBindingDigest !== input.observer.observerBindingDigest
    || receipt.observerQualificationDigest !== input.observer.observerQualificationDigest) throw new Error("HTTP not-started recovery belongs to a different configured observer boundary.");
  const requestDigest = compiledHttpWriteRequestDigest(input.request);
  if (receipt.priorLeaseDigest !== priorLease.leaseDigest || receipt.requestDigest !== requestDigest || priorLease.requestDigest !== requestDigest
    || receipt.parentGoalId !== input.request.parentGoalId || receipt.workItemId !== input.request.workItemId
    || priorLease.parentGoalId !== input.request.parentGoalId || priorLease.workItemId !== input.request.workItemId
    || receipt.reconciliationKeyDigest !== customerLocalAuthorityDigest(input.request.reconciliationKey)) throw new Error("HTTP not-started recovery is bound to different prior or requested work.");
  if (!observation.notStartedRecoveryReceipt || observation.notStartedRecoveryReceipt.receiptDigest !== receipt.receiptDigest
    || receipt.classification !== "not-started" || receipt.actionResponseUsedAsProof !== false || receipt.stateDigest !== observation.stateDigest
    || receipt.observationDigest !== recoveryObservationDigest(observation) || receipt.serverObservedAt !== observation.observedAt) throw new Error("HTTP not-started recovery observation or classification changed after signing.");
  assertDigest(receipt.observationRequestDigest, "Recovery observation request digest");
  const observationStartedAt = Date.parse(receipt.observationStartedAt), observationCompletedAt = Date.parse(receipt.observationCompletedAt), expiresAt = Date.parse(receipt.expiresAt);
  if (!Number.isFinite(observationStartedAt) || !Number.isFinite(observationCompletedAt) || !Number.isFinite(expiresAt) || observationStartedAt > observationCompletedAt || observationCompletedAt > input.now || expiresAt <= input.now || expiresAt <= observationCompletedAt
    || expiresAt - observationCompletedAt > input.maximumRecoveryEvidenceMilliseconds || input.now - observationCompletedAt > input.maximumRecoveryEvidenceMilliseconds) throw new Error("HTTP not-started recovery evidence is stale, future-dated, causally invalid, or exceeds its policy lifetime.");
  if (!/^[a-f0-9]{32,128}$/.test(receipt.recoveryNonce) || /^0+$/.test(receipt.recoveryNonce)) throw new Error("HTTP not-started recovery nonce is malformed or placeholder.");
  if (!base64Pattern.test(receipt.signature) || receipt.receiptDigest !== customerLocalAuthorityDigest({ payload: notStartedRecoveryPayload(receipt), signature: receipt.signature })
    || !verify(null, Buffer.from(canonical(notStartedRecoveryPayload(receipt))), input.observer.publicKey, Buffer.from(receipt.signature, "base64"))) throw new Error("HTTP not-started recovery failed its signature or integrity check.");
  return receipt;
}

export function customerLocalHttpAuthorityContractDigest(input: CustomerLocalHttpWriteAuthorityContractInput | CustomerLocalHttpWriteAuthorityConfig | CustomerLocalHttpWriteAuthorityTrustContractInput): string {
  const workspaceAuthority = "workspaceAuthorityTrust" in input
    ? {
        workspaceId: input.workspaceAuthorityTrust.workspaceId,
        trustConfigurationDigest: input.workspaceAuthorityTrust.trustConfigurationDigest,
        activationPolicyVersion: input.workspaceAuthorityTrust.activationPolicyVersion,
      }
    : input.workspaceAuthority.trustBinding
      ? {
          workspaceId: input.workspaceAuthority.workspaceId,
          trustConfigurationDigest: input.workspaceAuthority.trustBinding.trustConfigurationDigest,
          activationPolicyVersion: "1.0" as const,
        }
      : {
          workspaceId: input.workspaceAuthority.workspaceId,
          adminSignerKeyId: input.workspaceAuthority.adminSignerKeyId,
          adminPublicKeyDigest: publicKeyDigest(input.workspaceAuthority.adminPublicKey),
        };
  return customerLocalAuthorityDigest({
    version: CUSTOMER_LOCAL_HTTP_WRITE_AUTHORITY_VERSION,
    issuerId: input.issuerId,
    signerKeyId: input.signerKeyId,
    authorityPublicKeyDigest: publicKeyDigest(input.publicKey),
    authorityCompilationDigest: input.authorityCompilation.compilationDigest,
    actionDeclarationDigest: input.actionDeclaration.declarationDigest,
    transportAuthorityBoundaryDigest: input.transportAuthorityBoundaryDigest,
    credentialResolverDigest: input.credentialResolverDigest,
    quantityMetric: input.quantityMetric,
    monetaryMetric: input.monetaryMetric,
    maximumLeaseMilliseconds: input.maximumLeaseMilliseconds ?? 2_000,
    maximumApprovalMilliseconds: input.maximumApprovalMilliseconds ?? 300_000,
    approval: input.approval ? { signerKeyId: input.approval.signerKeyId, publicKeyDigest: publicKeyDigest(input.approval.publicKey) } : null,
    maximumRecoveryEvidenceMilliseconds: input.maximumRecoveryEvidenceMilliseconds ?? 30_000,
    unconsumedLeaseReplacement: {
      protocol: "expired-durable-unconsumed-generation-v1",
      maximumGenerationsPerExecutionAttempt: MAXIMUM_UNCONSUMED_LEASE_GENERATIONS,
      freshApprovalRequiredPerGeneration: true,
      issuedGenerationsCountTowardHourlyLimit: true,
    },
    recoveryObserver: input.recoveryObserver ? {
      signerKeyId: input.recoveryObserver.signerKeyId,
      publicKeyDigest: publicKeyDigest(input.recoveryObserver.publicKey),
      observerImplementationDigest: input.recoveryObserver.observerImplementationDigest,
      observerBindingDigest: input.recoveryObserver.observerBindingDigest,
      observerQualificationDigest: input.recoveryObserver.observerQualificationDigest,
    } : null,
    workspaceAuthority,
  });
}

export function customerLocalHttpAuthorityTrustContractDigest(input: CustomerLocalHttpWriteAuthorityTrustConfig | EnrolledCustomerLocalHttpWriteAuthorityTrustConfig): string {
  const { workspaceAuthorityTrustStore, continuityGuard: _continuityGuard, authorityContinuityEnrollmentGuard: _enrollmentGuard, ...contract } = input as EnrolledCustomerLocalHttpWriteAuthorityTrustConfig;
  const identity = workspaceAuthorityTrustStore.stableIdentity();
  return customerLocalHttpAuthorityContractDigest({ ...contract, workspaceAuthorityTrust: identity });
}

function validateAuthorityConfiguration(input: InternalCustomerLocalHttpWriteAuthorityConfig): { policyDigest: string; authorityContractDigest: string; maximumLeaseMilliseconds: number; maximumApprovalMilliseconds: number; maximumRecoveryEvidenceMilliseconds: number } {
  assertIdentifier(input.issuerId, "Authority issuer ID");
  assertIdentifier(input.signerKeyId, "Authority signer key ID");
  assertDigest(input.transportAuthorityBoundaryDigest, "Transport authority boundary digest");
  assertDigest(input.credentialResolverDigest, "Credential resolver digest");
  if (input.privateKey.type !== "private" || input.privateKey.asymmetricKeyType !== "ed25519") throw new Error("HTTP write authority requires an Ed25519 private key.");
  const derivedPublic = createPublicKey(input.privateKey);
  if (!timingSafeEqual(publicKeyDer(derivedPublic), publicKeyDer(input.publicKey))) throw new Error("HTTP authority public and private keys do not form one Ed25519 pair.");
  assertAuthorityWizardCompilationIntegrity(input.authorityCompilation);
  const { declarationDigest, ...declarationPayload } = input.actionDeclaration;
  if (customerLocalAuthorityDigest(declarationPayload) !== declarationDigest) throw new Error("HTTP write authority declaration failed its intrinsic integrity check.");
  if (input.authorityCompilation.status !== "review-required" || !input.authorityCompilation.candidateAuthority) throw new Error("HTTP write authority requires an intact reviewed authority candidate.");
  if (input.actionDeclaration.provenance.authorityCompilationDigest !== input.authorityCompilation.compilationDigest) throw new Error("HTTP write authority declaration belongs to a different authority compilation.");
  const rule = input.authorityCompilation.guardrails.exactWriteRules.find((candidate) => candidate.actionName === input.actionDeclaration.operation.operationId && candidate.targetAlias === input.actionDeclaration.targetAlias && candidate.method === input.actionDeclaration.operation.method);
  if (!rule || rule.policy !== input.actionDeclaration.authorityPolicy) throw new Error("HTTP write authority has no exact matching reviewed write rule.");
  if (input.authorityCompilation.guardrails.forbiddenActions.includes(input.actionDeclaration.operation.operationId)) throw new Error("HTTP write authority action is explicitly forbidden.");
  const limits = input.authorityCompilation.guardrails.limits;
  if (limits.quantityPerAction.kind === "limit" && !input.quantityMetric) throw new Error("A quantity limit requires one explicit trusted quantity metric binding.");
  if (limits.monetary.kind === "limit" && (!input.monetaryMetric || input.monetaryMetric.currency !== limits.monetary.currency)) throw new Error("A monetary limit requires one explicit same-currency trusted monetary metric binding.");
  if (input.quantityMetric?.kind === "json-body-number" && !identifier.test(input.quantityMetric.field)) throw new Error("Quantity metric field is malformed.");
  if (input.monetaryMetric?.kind === "json-body-number" && !identifier.test(input.monetaryMetric.field)) throw new Error("Monetary metric field is malformed.");
  const maximumLeaseMilliseconds = input.maximumLeaseMilliseconds ?? 2_000;
  if (!Number.isInteger(maximumLeaseMilliseconds) || maximumLeaseMilliseconds < 50 || maximumLeaseMilliseconds > 10_000) throw new Error("HTTP write authority lease lifetime must be between 50 ms and 10 seconds.");
  const maximumApprovalMilliseconds = input.maximumApprovalMilliseconds ?? 300_000;
  if (!Number.isInteger(maximumApprovalMilliseconds) || maximumApprovalMilliseconds < 1_000 || maximumApprovalMilliseconds > 3_600_000) throw new Error("HTTP action approval maximum age must be between one second and one hour.");
  const maximumRecoveryEvidenceMilliseconds = input.maximumRecoveryEvidenceMilliseconds ?? 30_000;
  if (!Number.isInteger(maximumRecoveryEvidenceMilliseconds) || maximumRecoveryEvidenceMilliseconds < 1_000 || maximumRecoveryEvidenceMilliseconds > 300_000) throw new Error("HTTP not-started recovery evidence lifetime must be between one second and five minutes.");
  if (rule.policy === "requires-approval") {
    if (!input.authorityCompilation.guardrails.approverOwnerAlias || !input.approval) throw new Error("Approval-gated HTTP authority requires a pinned approver key and owner alias.");
    assertIdentifier(input.approval.signerKeyId, "Approval signer key ID");
    publicKeyDer(input.approval.publicKey);
  }
  if (input.recoveryObserver) {
    if (input.authorityCompilation.guardrails.maximumAttempts !== 2) throw new Error("HTTP not-started recovery authority requires an exact two-attempt reviewed ceiling.");
    assertIdentifier(input.recoveryObserver.signerKeyId, "Recovery observer signer key ID");
    publicKeyDer(input.recoveryObserver.publicKey);
    assertDigest(input.recoveryObserver.observerImplementationDigest, "Recovery observer implementation digest");
    assertDigest(input.recoveryObserver.observerBindingDigest, "Recovery observer binding digest");
    assertDigest(input.recoveryObserver.observerQualificationDigest, "Recovery observer qualification digest");
  } else if (input.authorityCompilation.guardrails.maximumAttempts > 1) {
    throw new Error("HTTP write authority cannot permit multiple attempts without a configured independent not-started recovery observer.");
  }
  assertIdentifier(input.workspaceAuthority.workspaceId, "Workspace ID");
  assertIdentifier(input.workspaceAuthority.adminSignerKeyId, "Workspace admin signer key ID");
  publicKeyDer(input.workspaceAuthority.adminPublicKey);
  if (input.workspaceAuthority.trustBinding) {
    assertTrustedCustomerLocalHttpAuthorityTrustBinding(input.workspaceAuthority.trustBinding);
    if (input.workspaceAuthority.trustBinding.workspaceId !== input.workspaceAuthority.workspaceId
      || input.workspaceAuthority.trustBinding.adminSignerKeyId !== input.workspaceAuthority.adminSignerKeyId
      || input.workspaceAuthority.trustBinding.adminPublicKeyDigest !== publicKeyDigest(input.workspaceAuthority.adminPublicKey)
      || input.workspaceAuthority.trustBinding.activationReceiptDigest !== input.workspaceAuthority.activationReceipt.receiptDigest) {
      throw new Error("Workspace authority trust binding differs from the resolved admin or activation.");
    }
    input.workspaceAuthority.trustBinding.assertCurrent();
  }
  const authorityContractDigest = customerLocalHttpAuthorityContractDigest(input);
  if (input.workspaceAuthority.continuityGuard) {
    const guard = input.workspaceAuthority.continuityGuard;
    assertTrustedCustomerLocalAuthorityContinuityGuard(guard);
    if (!input.workspaceAuthority.trustBinding || guard.workspaceId !== input.workspaceAuthority.workspaceId
      || guard.authorityContractDigest !== authorityContractDigest || guard.trustConfigurationDigest !== input.workspaceAuthority.trustBinding.trustConfigurationDigest) throw new Error("Authority continuity guard belongs to a different workspace, contract, or trust configuration.");
  }
  if (input.workspaceAuthority.enrollmentGuard) {
    const guard = input.workspaceAuthority.enrollmentGuard;
    assertTrustedAuthorityContinuityEnrollmentGuard(guard);
    if (!input.workspaceAuthority.trustBinding || guard.workspaceId !== input.workspaceAuthority.workspaceId
      || guard.authorityContractDigest !== authorityContractDigest
      || guard.trustConfigurationDigest !== input.workspaceAuthority.trustBinding.trustConfigurationDigest
      || guard.continuityGuardIdentityDigest !== (input.workspaceAuthority.continuityGuard?.identityDigest ?? null)) {
      throw new Error("Authority continuity enrollment belongs to a different workspace, contract, trust configuration, or recovery lineage.");
    }
  }
  const activation = input.workspaceAuthority.activationReceipt;
  if (activation.schemaVersion !== "1.0" || activation.adminSignerKeyId !== input.workspaceAuthority.adminSignerKeyId || activation.workspaceId !== input.workspaceAuthority.workspaceId || activation.authorityContractDigest !== authorityContractDigest) throw new Error("Workspace authority activation belongs to a different admin, workspace, or exact authority contract.");
  const activationValidity = assertIsoRange(activation.issuedAt, activation.expiresAt, input.now());
  if (activationValidity.expires - activationValidity.issued > 365 * 24 * 60 * 60 * 1_000) throw new Error("Workspace authority activation exceeds the one-year maximum lifetime.");
  if (!/^[a-f0-9]{32,128}$/.test(activation.activationNonce) || /^0+$/.test(activation.activationNonce) || !base64Pattern.test(activation.signature) || activation.receiptDigest !== customerLocalAuthorityDigest({ payload: workspaceActivationPayload(activation), signature: activation.signature }) || !verify(null, Buffer.from(canonical(workspaceActivationPayload(activation))), input.workspaceAuthority.adminPublicKey, Buffer.from(activation.signature, "base64"))) throw new Error("Workspace authority activation failed its nonce, signature, or integrity check.");
  const policyDigest = customerLocalAuthorityDigest(input.workspaceAuthority.trustBinding
    ? { authorityContractDigest, workspaceAuthorityTrustConfigurationDigest: input.workspaceAuthority.trustBinding.trustConfigurationDigest, activationPolicyVersion: "1.0", continuityGuardIdentityDigest: input.workspaceAuthority.continuityGuard?.identityDigest ?? null, enrollmentGuardIdentityDigest: input.workspaceAuthority.enrollmentGuard?.identityDigest ?? null }
    : { authorityContractDigest, workspaceActivationReceiptDigest: activation.receiptDigest });
  return { policyDigest, authorityContractDigest, maximumLeaseMilliseconds, maximumApprovalMilliseconds, maximumRecoveryEvidenceMilliseconds };
}

function leaseSignatureValid(lease: HttpActionAuthorityLease, publicKey: KeyObject): boolean {
  if (!base64Pattern.test(lease.signature)) return false;
  const payload = leasePayload(lease);
  return lease.leaseDigest === customerLocalAuthorityDigest({ payload, signature: lease.signature })
    && verify(null, Buffer.from(canonical(payload)), publicKey, Buffer.from(lease.signature, "base64"));
}

function createCustomerLocalHttpWriteAuthorityInternal(input: InternalCustomerLocalHttpWriteAuthorityConfig): {
  issuer: CustomerLocalHttpWriteAuthorityIssuer;
  verifier: CustomerLocalHttpWriteAuthorityVerifier;
} {
  input = {
    ...input,
    authorityCompilation: deepFreezeJson(structuredClone(input.authorityCompilation)),
    actionDeclaration: deepFreezeJson(structuredClone(input.actionDeclaration)),
    ...(input.quantityMetric ? { quantityMetric: deepFreezeJson(structuredClone(input.quantityMetric)) } : {}),
    ...(input.monetaryMetric ? { monetaryMetric: deepFreezeJson(structuredClone(input.monetaryMetric)) } : {}),
    ...(input.approval ? { approval: Object.freeze({ signerKeyId: input.approval.signerKeyId, publicKey: input.approval.publicKey }) } : {}),
    ...(input.recoveryObserver ? { recoveryObserver: Object.freeze({
      signerKeyId: input.recoveryObserver.signerKeyId,
      publicKey: input.recoveryObserver.publicKey,
      observerImplementationDigest: input.recoveryObserver.observerImplementationDigest,
      observerBindingDigest: input.recoveryObserver.observerBindingDigest,
      observerQualificationDigest: input.recoveryObserver.observerQualificationDigest,
    }) } : {}),
    workspaceAuthority: Object.freeze({
      workspaceId: input.workspaceAuthority.workspaceId,
      adminSignerKeyId: input.workspaceAuthority.adminSignerKeyId,
      adminPublicKey: input.workspaceAuthority.adminPublicKey,
      activationReceipt: deepFreezeJson(structuredClone(input.workspaceAuthority.activationReceipt)),
      ...(input.workspaceAuthority.trustBinding ? { trustBinding: input.workspaceAuthority.trustBinding } : {}),
      ...(input.workspaceAuthority.continuityGuard ? { continuityGuard: input.workspaceAuthority.continuityGuard } : {}),
      ...(input.workspaceAuthority.enrollmentGuard ? { enrollmentGuard: input.workspaceAuthority.enrollmentGuard } : {}),
    }),
  };
  const { policyDigest, authorityContractDigest, maximumLeaseMilliseconds, maximumApprovalMilliseconds, maximumRecoveryEvidenceMilliseconds } = validateAuthorityConfiguration(input);
  const database = openAuthorityDatabase(input.statePath);
  initializePolicy(database, policyDigest);
  const now = input.now;
  const nonce = input.nonce;
  const verifierImplementationDigest = customerLocalAuthorityDigest({
    version: CUSTOMER_LOCAL_HTTP_WRITE_AUTHORITY_VERSION,
    role: "transport-boundary-verifier",
    issuerId: input.issuerId,
    signerKeyId: input.signerKeyId,
    authorityPublicKeyDigest: publicKeyDigest(input.publicKey),
    policyDigest,
    authorityContractDigest,
    transportAuthorityBoundaryDigest: input.transportAuthorityBoundaryDigest,
    leaseSchemaVersion: "2.1",
    maximumUnconsumedLeaseGenerations: MAXIMUM_UNCONSUMED_LEASE_GENERATIONS,
    workspaceAuthorityTrustConfigurationDigest: input.workspaceAuthority.trustBinding?.trustConfigurationDigest ?? null,
    continuityGuardIdentityDigest: input.workspaceAuthority.continuityGuard?.identityDigest ?? null,
    enrollmentGuardIdentityDigest: input.workspaceAuthority.enrollmentGuard?.identityDigest ?? null,
  });
  const issuerImplementationDigest = customerLocalAuthorityDigest({
    version: CUSTOMER_LOCAL_HTTP_WRITE_AUTHORITY_VERSION,
    role: "durable-lease-issuer",
    issuerId: input.issuerId,
    signerKeyId: input.signerKeyId,
    policyDigest,
    authorityContractDigest,
    verifierImplementationDigest,
    leaseSchemaVersion: "2.1",
    maximumUnconsumedLeaseGenerations: MAXIMUM_UNCONSUMED_LEASE_GENERATIONS,
    workspaceAuthorityTrustConfigurationDigest: input.workspaceAuthority.trustBinding?.trustConfigurationDigest ?? null,
    continuityGuardIdentityDigest: input.workspaceAuthority.continuityGuard?.identityDigest ?? null,
    enrollmentGuardIdentityDigest: input.workspaceAuthority.enrollmentGuard?.identityDigest ?? null,
    ...(input.recoveryObserver ? {
      recoveryObserverImplementationDigest: input.recoveryObserver.observerImplementationDigest,
      recoveryObserverBindingDigest: input.recoveryObserver.observerBindingDigest,
      recoveryObserverQualificationDigest: input.recoveryObserver.observerQualificationDigest,
    } : {}),
  });
  let closed = false;

  const issuer: CustomerLocalHttpWriteAuthorityIssuer = Object.freeze({
    issuerId: input.issuerId,
    implementationDigest: issuerImplementationDigest,
    policyDigest,
    authorityCompilationDigest: input.authorityCompilation.compilationDigest,
    actionDeclarationDigest: input.actionDeclaration.declarationDigest,
    transportAuthorityBoundaryDigest: input.transportAuthorityBoundaryDigest,
    credentialResolverDigest: input.credentialResolverDigest,
    verifierImplementationDigest,
    ...(input.recoveryObserver ? {
      recoveryObserverImplementationDigest: input.recoveryObserver.observerImplementationDigest,
      recoveryObserverBindingDigest: input.recoveryObserver.observerBindingDigest,
      recoveryObserverQualificationDigest: input.recoveryObserver.observerQualificationDigest,
    } : {}),
    async issueLease(issueInput: { request: CompiledHttpRequest; credentialAlias: string; transportReservationDigest?: string; approvalReceipt?: HttpActionApprovalReceipt; notStartedRecovery?: HttpNotStartedRecoveryEvidence; unconsumedReplacement?: HttpUnconsumedLeaseReplacementEvidence }) {
      if (closed) throw new Error("HTTP write authority issuer is closed.");
      if (issueInput.credentialAlias !== input.actionDeclaration.credentialAlias || issueInput.request.credentialAlias !== issueInput.credentialAlias) throw new Error("HTTP write authority credential alias differs from the reviewed action.");
      const request = issueInput.request;
      if (request.declarationDigest !== input.actionDeclaration.declarationDigest || request.targetAlias !== input.actionDeclaration.targetAlias || request.operationId !== input.actionDeclaration.operation.operationId || request.method !== input.actionDeclaration.operation.method || request.serverUrl !== input.actionDeclaration.serverUrl) throw new Error("HTTP write authority request differs from the exact reviewed declaration.");
      if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) throw new Error("HTTP write authority cannot authorize a read method.");
      const limits = input.authorityCompilation.guardrails.limits;
      if (limits.quantityPerAction.kind === "limit" && metricValue(input.quantityMetric!, request, "Quantity") > limits.quantityPerAction.maximum) throw new Error("HTTP write exceeds the confirmed per-action quantity limit.");
      if (limits.monetary.kind === "limit" && metricValue(input.monetaryMetric!, request, "Monetary") > limits.monetary.maximum) throw new Error("HTTP write exceeds the confirmed monetary limit.");
      input.workspaceAuthority.trustBinding?.assertCurrent();
      input.workspaceAuthority.continuityGuard?.assertCurrent();
      input.workspaceAuthority.enrollmentGuard?.assertCurrent();
      const issuedAtEpochMs = now(), activationExpiresAtEpochMs = Date.parse(input.workspaceAuthority.activationReceipt.expiresAt);
      if (!Number.isFinite(activationExpiresAtEpochMs) || activationExpiresAtEpochMs <= issuedAtEpochMs) throw new Error("Configured workspace-admin authority activation has expired.");
      const requestDigest = compiledHttpWriteRequestDigest(request);
      if (issueInput.transportReservationDigest !== undefined) assertDigest(issueInput.transportReservationDigest, "HTTP transport reservation digest");
      if (issueInput.notStartedRecovery && issueInput.unconsumedReplacement) throw new Error("HTTP authority cannot combine external not-started recovery with unconsumed lease-generation replacement.");
      const recoveryReceipt = issueInput.notStartedRecovery ? verifyNotStartedRecovery({ evidence: issueInput.notStartedRecovery, request, observer: input.recoveryObserver, now: issuedAtEpochMs, maximumRecoveryEvidenceMilliseconds }) : undefined;
      const priorLease = issueInput.notStartedRecovery?.priorLease;
      if (priorLease && (priorLease.schemaVersion !== "2.1" || priorLease.signerKeyId !== input.signerKeyId || priorLease.authorityPublicKeyDigest !== publicKeyDigest(input.publicKey)
        || priorLease.policyDigest !== policyDigest || priorLease.workspaceId !== input.workspaceAuthority.workspaceId || priorLease.workspaceAuthorityActivationDigest !== input.workspaceAuthority.trustBinding?.activationReceiptDigest || priorLease.requestDigest !== requestDigest
        || priorLease.actionDeclarationDigest !== input.actionDeclaration.declarationDigest || priorLease.authorityCompilationDigest !== input.authorityCompilation.compilationDigest
        || priorLease.transportAuthorityBoundaryDigest !== input.transportAuthorityBoundaryDigest || priorLease.credentialResolverDigest !== input.credentialResolverDigest
        || priorLease.credentialAlias !== issueInput.credentialAlias || priorLease.targetAlias !== request.targetAlias || priorLease.operationId !== request.operationId
        || priorLease.method !== request.method || priorLease.parentGoalId !== request.parentGoalId || priorLease.workItemId !== request.workItemId
        || priorLease.attempt !== 1 || !leaseSignatureValid(priorLease, input.publicKey))) throw new Error("HTTP retry prior lease is forged or belongs to different exact work.");
      const unconsumedPriorLease = issueInput.unconsumedReplacement?.priorLease;
      if (issueInput.unconsumedReplacement && issueInput.unconsumedReplacement.reason !== "expired-before-consume") throw new Error("HTTP unconsumed lease replacement reason is unsupported.");
      if (unconsumedPriorLease && (unconsumedPriorLease.schemaVersion !== "2.1" || unconsumedPriorLease.signerKeyId !== input.signerKeyId || unconsumedPriorLease.authorityPublicKeyDigest !== publicKeyDigest(input.publicKey)
        || unconsumedPriorLease.policyDigest !== policyDigest || unconsumedPriorLease.workspaceId !== input.workspaceAuthority.workspaceId || unconsumedPriorLease.workspaceAuthorityActivationDigest !== input.workspaceAuthority.trustBinding?.activationReceiptDigest || unconsumedPriorLease.requestDigest !== requestDigest
        || unconsumedPriorLease.actionDeclarationDigest !== input.actionDeclaration.declarationDigest || unconsumedPriorLease.authorityCompilationDigest !== input.authorityCompilation.compilationDigest
        || unconsumedPriorLease.transportAuthorityBoundaryDigest !== input.transportAuthorityBoundaryDigest || unconsumedPriorLease.credentialResolverDigest !== input.credentialResolverDigest
        || unconsumedPriorLease.credentialAlias !== issueInput.credentialAlias || unconsumedPriorLease.targetAlias !== request.targetAlias || unconsumedPriorLease.operationId !== request.operationId
        || unconsumedPriorLease.method !== request.method || unconsumedPriorLease.parentGoalId !== request.parentGoalId || unconsumedPriorLease.workItemId !== request.workItemId
        || ![1, 2].includes(unconsumedPriorLease.attempt) || !Number.isInteger(unconsumedPriorLease.generation) || unconsumedPriorLease.generation < 1
        || unconsumedPriorLease.generation >= MAXIMUM_UNCONSUMED_LEASE_GENERATIONS || !leaseSignatureValid(unconsumedPriorLease, input.publicKey))) throw new Error("HTTP unconsumed replacement prior lease is forged, over-generation, or belongs to different exact work.");
      const attempt: 1 | 2 = recoveryReceipt ? 2 : unconsumedPriorLease ? unconsumedPriorLease.attempt : 1;
      const generation = unconsumedPriorLease ? unconsumedPriorLease.generation + 1 : 1;
      const issuedAt = new Date(issuedAtEpochMs).toISOString(), expiresAtEpochMs = Math.min(issuedAtEpochMs + maximumLeaseMilliseconds, activationExpiresAtEpochMs), expiresAt = new Date(expiresAtEpochMs).toISOString();
      const actionKeyDigest = customerLocalAuthorityDigest({
        policyDigest,
        parentGoalId: request.parentGoalId,
        workItemId: request.workItemId,
        actionDeclarationDigest: input.actionDeclaration.declarationDigest,
      });
      let approvalReceiptDigest: string | undefined;
      if (input.actionDeclaration.authorityPolicy === "requires-approval") {
        const receipt = verifyApproval({ receipt: issueInput.approvalReceipt, request, signerKeyId: input.approval!.signerKeyId, approverOwnerAlias: input.authorityCompilation.guardrails.approverOwnerAlias!, publicKey: input.approval!.publicKey, now: issuedAtEpochMs, maximumApprovalMilliseconds });
        approvalReceiptDigest = receipt.receiptDigest;
      } else if (issueInput.approvalReceipt) {
        throw new Error("An unexpected approval receipt cannot alter a preauthorized policy.");
      }
      const leaseId = nonce();
      if (!/^[a-f0-9]{32,128}$/.test(leaseId) || /^0+$/.test(leaseId)) throw new Error("HTTP write authority lease nonce is malformed or placeholder.");
      const issueDurably = () => {
        database.exec("BEGIN IMMEDIATE");
        try {
        const policy = database.prepare("SELECT policy_digest, policy_epoch, last_seen_epoch_ms, revoked_reason FROM http_authority_policy WHERE singleton = 1").get() as { policy_digest: string; policy_epoch: number; last_seen_epoch_ms: number; revoked_reason: string | null } | undefined;
        if (!policy || !sameDigest(policy.policy_digest, policyDigest) || policy.revoked_reason) throw new Error("HTTP write authority policy is missing, changed, or revoked.");
        if (issuedAtEpochMs < policy.last_seen_epoch_ms) throw new Error("HTTP write authority detected a local clock rollback.");
        if (limits.actionsPerHour.kind === "limit") {
          const recent = database.prepare("SELECT COUNT(*) AS count FROM http_authority_leases WHERE policy_digest = ? AND issued_at_epoch_ms > ?").get(policyDigest, issuedAtEpochMs - 3_600_000) as { count: number };
          if (recent.count >= limits.actionsPerHour.maximum) throw new Error("HTTP write exceeds the confirmed actions-per-hour limit.");
        }
        const payload: LeasePayload = {
          schemaVersion: "2.1",
          signerKeyId: input.signerKeyId,
          authorityPublicKeyDigest: publicKeyDigest(input.publicKey),
          policyDigest,
          policyEpoch: policy.policy_epoch,
          workspaceId: input.workspaceAuthority.workspaceId,
          ...(input.workspaceAuthority.trustBinding ? { workspaceAuthorityActivationDigest: input.workspaceAuthority.trustBinding.activationReceiptDigest } : {}),
          leaseId,
          requestDigest,
          actionDeclarationDigest: input.actionDeclaration.declarationDigest,
          authorityCompilationDigest: input.authorityCompilation.compilationDigest,
          transportAuthorityBoundaryDigest: input.transportAuthorityBoundaryDigest,
          credentialResolverDigest: input.credentialResolverDigest,
          credentialAlias: issueInput.credentialAlias,
          targetAlias: request.targetAlias,
          operationId: request.operationId,
          method: request.method as LeasePayload["method"],
          parentGoalId: request.parentGoalId,
          workItemId: request.workItemId,
          issuedAt,
          expiresAt,
          attempt,
          generation,
          ...(issueInput.transportReservationDigest ? { transportReservationDigest: issueInput.transportReservationDigest } : {}),
          ...(approvalReceiptDigest ? { approvalReceiptDigest } : {}),
          ...(priorLease ? { priorLeaseDigest: priorLease.leaseDigest } : {}),
          ...(recoveryReceipt ? { notStartedRecoveryReceiptDigest: recoveryReceipt.receiptDigest } : {}),
          ...(unconsumedPriorLease ? { priorUnconsumedLeaseDigest: unconsumedPriorLease.leaseDigest } : {}),
        };
        if (recoveryReceipt && priorLease) {
          const prior = database.prepare("SELECT policy_digest, policy_epoch, request_digest, action_key_digest, status, consumed_at_epoch_ms, attempt, lease_digest FROM http_authority_leases WHERE lease_id = ?").get(priorLease.leaseId) as { policy_digest: string; policy_epoch: number; request_digest: string; action_key_digest: string; status: string; consumed_at_epoch_ms: number | null; attempt: number; lease_digest: string } | undefined;
          const observationStartedAtEpochMs = Date.parse(recoveryReceipt.observationStartedAt);
          if (!prior || prior.status !== "consumed" || prior.attempt !== 1 || prior.consumed_at_epoch_ms === null || observationStartedAtEpochMs < prior.consumed_at_epoch_ms
            || prior.policy_epoch !== policy.policy_epoch || !sameDigest(prior.policy_digest, policyDigest) || !sameDigest(prior.request_digest, requestDigest)
            || !sameDigest(prior.action_key_digest, actionKeyDigest) || !sameDigest(prior.lease_digest, priorLease.leaseDigest)) throw new Error("HTTP retry requires the exact durably consumed first attempt and a later independent observation.");
        }
        if (unconsumedPriorLease) {
          const prior = database.prepare("SELECT policy_digest, policy_epoch, request_digest, action_key_digest, credential_alias, status, consumed_at_epoch_ms, expires_at_epoch_ms, attempt, generation, retired_at_epoch_ms, lease_digest FROM http_authority_leases WHERE lease_id = ?").get(unconsumedPriorLease.leaseId) as { policy_digest: string; policy_epoch: number; request_digest: string; action_key_digest: string; credential_alias: string; status: string; consumed_at_epoch_ms: number | null; expires_at_epoch_ms: number; attempt: number; generation: number; retired_at_epoch_ms: number | null; lease_digest: string } | undefined;
          if (!prior || prior.status !== "issued" || prior.consumed_at_epoch_ms !== null || prior.retired_at_epoch_ms !== null || prior.expires_at_epoch_ms > issuedAtEpochMs
            || prior.policy_epoch !== policy.policy_epoch || !sameDigest(prior.policy_digest, policyDigest) || !sameDigest(prior.request_digest, requestDigest)
            || !sameDigest(prior.action_key_digest, actionKeyDigest) || prior.credential_alias !== issueInput.credentialAlias || prior.attempt !== attempt
            || prior.generation !== unconsumedPriorLease.generation || !sameDigest(prior.lease_digest, unconsumedPriorLease.leaseDigest)) throw new Error("HTTP replacement requires the exact expired, durably unconsumed live lease generation.");
          const retired = database.prepare("UPDATE http_authority_leases SET retired_at_epoch_ms = ?, retirement_reason = 'expired-before-consume' WHERE lease_id = ? AND status = 'issued' AND consumed_at_epoch_ms IS NULL AND retired_at_epoch_ms IS NULL AND expires_at_epoch_ms <= ?").run(issuedAtEpochMs, unconsumedPriorLease.leaseId, issuedAtEpochMs);
          if (retired.changes !== 1) throw new Error("HTTP unconsumed lease generation could not be retired exactly once.");
        }
        const signature = sign(null, Buffer.from(canonical(payload)), input.privateKey).toString("base64");
        const leaseDigest = customerLocalAuthorityDigest({ payload, signature });
        database.prepare("INSERT INTO http_authority_leases(lease_id, policy_digest, policy_epoch, request_digest, action_key_digest, credential_alias, issued_at_epoch_ms, expires_at_epoch_ms, status, attempt, generation, prior_lease_digest, not_started_recovery_receipt_digest, transport_reservation_digest, prior_unconsumed_lease_digest, approval_receipt_digest, lease_digest) VALUES(?,?,?,?,?,?,?,?, 'issued',?,?,?,?,?,?,?,?)").run(leaseId, policyDigest, policy.policy_epoch, requestDigest, actionKeyDigest, issueInput.credentialAlias, issuedAtEpochMs, expiresAtEpochMs, attempt, generation, priorLease?.leaseDigest ?? null, recoveryReceipt?.receiptDigest ?? null, issueInput.transportReservationDigest ?? null, unconsumedPriorLease?.leaseDigest ?? null, approvalReceiptDigest ?? null, leaseDigest);
        database.prepare("UPDATE http_authority_policy SET last_seen_epoch_ms = ? WHERE singleton = 1 AND policy_digest = ?").run(issuedAtEpochMs, policyDigest);
          database.exec("COMMIT");
          return Object.freeze({ ...payload, signature, leaseDigest });
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      };
      return input.workspaceAuthority.enrollmentGuard
        ? input.workspaceAuthority.enrollmentGuard.withCurrentConsumption(issueDurably)
        : input.workspaceAuthority.continuityGuard ? input.workspaceAuthority.continuityGuard.withCurrentConsumption(issueDurably) : issueDurably();
    },
    revokeAll(reason: string) {
      if (closed) throw new Error("HTTP write authority issuer is closed.");
      if (typeof reason !== "string" || reason.trim().length < 3 || reason.length > 500) throw new Error("HTTP write authority revocation requires a bounded reason.");
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare("UPDATE http_authority_policy SET policy_epoch = policy_epoch + 1, revoked_reason = ? WHERE singleton = 1 AND policy_digest = ?").run(reason.trim(), policyDigest);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      if (!closed) { closed = true; database.close(); }
    },
  });

  const verifierDatabase = input.statePath === ":memory:" ? database : openAuthorityDatabase(input.statePath);
  if (input.statePath !== ":memory:") initializePolicy(verifierDatabase, policyDigest);
  let verifierClosed = false;
  const verifier: CustomerLocalHttpWriteAuthorityVerifier = Object.freeze({
    verifierId: `${input.issuerId}.transport-boundary-verifier`,
    implementationDigest: verifierImplementationDigest,
    policyDigest,
    transportAuthorityBoundaryDigest: input.transportAuthorityBoundaryDigest,
    consume(consumeInput: { lease: HttpActionAuthorityLease | undefined; request: CompiledHttpRequest; credentialAlias: string; transportReservationDigest?: string }) {
      if (verifierClosed || closed) throw new Error("HTTP write authority verifier is closed.");
      const consumeDurably = () => {
        const lease = consumeInput.lease;
        if (!lease) throw new Error("A signed immediate write-authority lease is missing at the transport boundary.");
        if (lease.schemaVersion !== "2.1" || lease.signerKeyId !== input.signerKeyId || lease.authorityPublicKeyDigest !== publicKeyDigest(input.publicKey) || lease.policyDigest !== policyDigest || lease.workspaceId !== input.workspaceAuthority.workspaceId || lease.workspaceAuthorityActivationDigest !== input.workspaceAuthority.trustBinding?.activationReceiptDigest || lease.transportAuthorityBoundaryDigest !== input.transportAuthorityBoundaryDigest || lease.credentialAlias !== consumeInput.credentialAlias || lease.requestDigest !== compiledHttpWriteRequestDigest(consumeInput.request) || lease.targetAlias !== consumeInput.request.targetAlias || lease.operationId !== consumeInput.request.operationId || lease.method !== consumeInput.request.method || lease.parentGoalId !== consumeInput.request.parentGoalId || lease.workItemId !== consumeInput.request.workItemId || lease.actionDeclarationDigest !== consumeInput.request.declarationDigest || lease.transportReservationDigest !== consumeInput.transportReservationDigest || !leaseSignatureValid(lease, input.publicKey)) {
          throw new Error("HTTP write authority lease is forged or bound to different exact work.");
        }
        const verifiedAtEpochMs = now();
        assertIsoRange(lease.issuedAt, lease.expiresAt, verifiedAtEpochMs);
        verifierDatabase.exec("BEGIN IMMEDIATE");
        try {
          const policy = verifierDatabase.prepare("SELECT policy_digest, policy_epoch, last_seen_epoch_ms, revoked_reason FROM http_authority_policy WHERE singleton = 1").get() as { policy_digest: string; policy_epoch: number; last_seen_epoch_ms: number; revoked_reason: string | null } | undefined;
          const row = verifierDatabase.prepare("SELECT policy_digest, policy_epoch, request_digest, credential_alias, status, consumed_at_epoch_ms, retired_at_epoch_ms, attempt, generation, prior_lease_digest, not_started_recovery_receipt_digest, transport_reservation_digest, prior_unconsumed_lease_digest, lease_digest FROM http_authority_leases WHERE lease_id = ?").get(lease.leaseId) as { policy_digest: string; policy_epoch: number; request_digest: string; credential_alias: string; status: string; consumed_at_epoch_ms: number | null; retired_at_epoch_ms: number | null; attempt: number; generation: number; prior_lease_digest: string | null; not_started_recovery_receipt_digest: string | null; transport_reservation_digest: string | null; prior_unconsumed_lease_digest: string | null; lease_digest: string } | undefined;
          if (!policy || !row || policy.revoked_reason || verifiedAtEpochMs < policy.last_seen_epoch_ms || policy.policy_epoch !== lease.policyEpoch || row.policy_epoch !== lease.policyEpoch || row.status !== "issued" || row.consumed_at_epoch_ms !== null || row.retired_at_epoch_ms !== null || !sameDigest(row.policy_digest, policyDigest) || !sameDigest(row.request_digest, lease.requestDigest) || row.credential_alias !== lease.credentialAlias || !sameDigest(row.lease_digest, lease.leaseDigest)) throw new Error("HTTP write authority lease is absent, replayed, retired, stale, revoked, clock-rolled-back, or changed in durable state.");
          if (row.attempt !== lease.attempt || row.generation !== lease.generation || (row.prior_lease_digest ?? undefined) !== lease.priorLeaseDigest || (row.not_started_recovery_receipt_digest ?? undefined) !== lease.notStartedRecoveryReceiptDigest || (row.transport_reservation_digest ?? undefined) !== lease.transportReservationDigest || (row.prior_unconsumed_lease_digest ?? undefined) !== lease.priorUnconsumedLeaseDigest) throw new Error("HTTP write authority attempt, generation, recovery lineage, or transport reservation changed in durable state.");
          const updated = verifierDatabase.prepare("UPDATE http_authority_leases SET status = 'consumed', consumed_at_epoch_ms = ? WHERE lease_id = ? AND status = 'issued' AND consumed_at_epoch_ms IS NULL AND retired_at_epoch_ms IS NULL").run(verifiedAtEpochMs, lease.leaseId);
          if (updated.changes !== 1) throw new Error("HTTP write authority lease could not be consumed exactly once.");
          verifierDatabase.prepare("UPDATE http_authority_policy SET last_seen_epoch_ms = ? WHERE singleton = 1 AND policy_digest = ?").run(verifiedAtEpochMs, policyDigest);
          verifierDatabase.exec("COMMIT");
        } catch (error) {
          verifierDatabase.exec("ROLLBACK");
          throw error;
        }
      };
      const consumeWithTrust = () => input.workspaceAuthority.trustBinding ? input.workspaceAuthority.trustBinding.withCurrentConsumption(consumeDurably) : consumeDurably();
      if (input.workspaceAuthority.enrollmentGuard) input.workspaceAuthority.enrollmentGuard.withCurrentConsumption(consumeWithTrust);
      else if (input.workspaceAuthority.continuityGuard) input.workspaceAuthority.continuityGuard.withCurrentConsumption(consumeWithTrust);
      else consumeWithTrust();
    },
    close() {
      if (!verifierClosed) {
        verifierClosed = true;
        if (verifierDatabase !== database) verifierDatabase.close();
      }
    },
  });
  trustedIssuers.add(issuer);
  trustedVerifiers.add(verifier);
  return { issuer, verifier };
}

/** Explicit test-only trust-store constructor for frozen pre-CF-069 evidence. */
export function createTestCustomerLocalHttpWriteAuthorityFromTrustStore(input: TestCustomerLocalHttpWriteAuthorityTrustConfig): {
  issuer: CustomerLocalHttpWriteAuthorityIssuer;
  verifier: CustomerLocalHttpWriteAuthorityVerifier;
} {
  if (input.testOnly !== true) throw new Error("Trust-store compatibility authority requires an explicit test-only boundary.");
  if (Object.hasOwn(input, "now") || Object.hasOwn(input, "nonce")) throw new Error("Trust-store test authority does not accept caller-controlled time or nonce sources.");
  if (Object.hasOwn(input, "workspaceAuthority")) throw new Error("Trust-store test authority cannot accept a caller-supplied admin key or activation receipt.");
  const { workspaceAuthorityTrustStore, continuityGuard, testOnly: _testOnly, ...base } = input;
  const authorityContractDigest = customerLocalHttpAuthorityTrustContractDigest(input);
  const continuityRequired = workspaceAuthorityTrustStore.recoveryContinuityRequirement() !== null;
  if (continuityRequired !== (continuityGuard !== undefined)) throw new Error(continuityRequired ? "Recovered workspace authority requires its current external continuity guard." : "Continuity guard cannot be attached to a workspace authority store that has no recovery lineage.");
  const trustBinding = workspaceAuthorityTrustStore.resolveCurrent(authorityContractDigest);
  assertTrustedCustomerLocalHttpAuthorityTrustBinding(trustBinding);
  if (trustBinding.testOnlyClock) throw new Error("Trust-store authority cannot use a test-only customer-local trust clock.");
  return createCustomerLocalHttpWriteAuthorityInternal({
    ...base,
    workspaceAuthority: {
      workspaceId: trustBinding.workspaceId,
      adminSignerKeyId: trustBinding.adminSignerKeyId,
      adminPublicKey: trustBinding.adminPublicKey,
      activationReceipt: trustBinding.activationReceipt,
      trustBinding,
      ...(continuityGuard ? { continuityGuard } : {}),
    },
    now: () => Date.now(),
    nonce: () => randomBytes(24).toString("hex"),
  });
}

/**
 * Strict authority-capable production constructor. A separately pinned provider
 * must attest that this exact installation, runtime release, authority contract,
 * trust configuration, and recovery lineage are currently enrolled. The guard
 * is rechecked at construction, lease issue, and lease consumption.
 */
export function createCustomerLocalHttpWriteAuthority(input: EnrolledCustomerLocalHttpWriteAuthorityTrustConfig): {
  issuer: CustomerLocalHttpWriteAuthorityIssuer;
  verifier: CustomerLocalHttpWriteAuthorityVerifier;
} {
  if (Object.hasOwn(input, "now") || Object.hasOwn(input, "nonce") || Object.hasOwn(input, "testOnly")) throw new Error("Enrolled production HTTP write authority does not accept caller-controlled time or nonce sources.");
  if (Object.hasOwn(input, "workspaceAuthority")) throw new Error("Enrolled production HTTP write authority cannot accept a caller-supplied admin key or activation receipt.");
  const { workspaceAuthorityTrustStore, continuityGuard, authorityContinuityEnrollmentGuard, ...base } = input;
  assertTrustedAuthorityContinuityEnrollmentGuard(authorityContinuityEnrollmentGuard);
  const authorityContractDigest = customerLocalHttpAuthorityTrustContractDigest(input);
  const continuityRequired = workspaceAuthorityTrustStore.recoveryContinuityRequirement() !== null;
  if (continuityRequired !== (continuityGuard !== undefined)) throw new Error(continuityRequired ? "Recovered workspace authority requires its current external continuity guard." : "Continuity guard cannot be attached to a workspace authority store that has no recovery lineage.");
  const trustBinding = workspaceAuthorityTrustStore.resolveCurrent(authorityContractDigest);
  assertTrustedCustomerLocalHttpAuthorityTrustBinding(trustBinding);
  if (trustBinding.testOnlyClock) throw new Error("Enrolled production HTTP write authority cannot use a test-only customer-local trust clock.");
  if (authorityContinuityEnrollmentGuard.workspaceId !== trustBinding.workspaceId
    || authorityContinuityEnrollmentGuard.tenantId !== workspaceAuthorityTrustStore.tenantId
    || authorityContinuityEnrollmentGuard.authorityContractDigest !== authorityContractDigest
    || authorityContinuityEnrollmentGuard.trustConfigurationDigest !== trustBinding.trustConfigurationDigest
    || authorityContinuityEnrollmentGuard.continuityGuardIdentityDigest !== (continuityGuard?.identityDigest ?? null)) {
    throw new Error("Authority-capable startup requires current enrollment for the exact workspace, authority contract, trust configuration, and recovery lineage.");
  }
  return createCustomerLocalHttpWriteAuthorityInternal({
    ...base,
    workspaceAuthority: {
      workspaceId: trustBinding.workspaceId,
      adminSignerKeyId: trustBinding.adminSignerKeyId,
      adminPublicKey: trustBinding.adminPublicKey,
      activationReceipt: trustBinding.activationReceipt,
      trustBinding,
      ...(continuityGuard ? { continuityGuard } : {}),
      enrollmentGuard: authorityContinuityEnrollmentGuard,
    },
    now: () => Date.now(),
    nonce: () => randomBytes(24).toString("hex"),
  });
}

export const createEnrolledCustomerLocalHttpWriteAuthority = createCustomerLocalHttpWriteAuthority;

/** Explicit test-only constructor used for frozen local fault campaigns. */
export function createTestCustomerLocalHttpWriteAuthority(input: TestCustomerLocalHttpWriteAuthorityConfig): {
  issuer: CustomerLocalHttpWriteAuthorityIssuer;
  verifier: CustomerLocalHttpWriteAuthorityVerifier;
} {
  if (input.testOnly !== true) throw new Error("Test HTTP write authority requires an explicit test-only boundary.");
  return createCustomerLocalHttpWriteAuthorityInternal({ ...input, nonce: input.nonce ?? (() => randomBytes(24).toString("hex")) });
}
