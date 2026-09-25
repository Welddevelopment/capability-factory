import {
  createHash,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CUSTOMER_LOCAL_RESOURCE_LIMITS,
  boundedFileSize,
  readBoundedFile,
  sha256BoundedFile,
} from "./customer-local-resource-bounds.js";
import {
  CustomerLocalTrustStore,
  type RotationReceipt,
} from "./customer-local-trust-backup.js";
import type { WorkspaceHttpAuthorityActivationReceipt } from "./customer-local-http-write-authority.js";

export const CUSTOMER_LOCAL_HTTP_AUTHORITY_TRUST_VERSION = "1.0" as const;
export const CUSTOMER_LOCAL_HTTP_AUTHORITY_TRUST_BACKUP_VERSION = "1.0" as const;

const identifier = /^[A-Za-z][A-Za-z0-9_.-]{1,179}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
const trustedStores = new WeakSet<object>();
const trustedBindings = new WeakSet<object>();

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

function digest(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

function keyDigest(key: KeyObject): string {
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error("HTTP authority trust requires an Ed25519 public key.");
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
}

function activationPayload(receipt: WorkspaceHttpAuthorityActivationReceipt) {
  const { signature: _signature, receiptDigest: _receiptDigest, ...payload } = receipt;
  return payload;
}

function exactCustomerTrustStore(value: CustomerLocalTrustStore): void {
  if (Object.getPrototypeOf(value) !== CustomerLocalTrustStore.prototype) throw new Error("HTTP authority trust requires the exact customer-local trust-store implementation.");
}

function legacyLineageDescriptor(meta: Record<string, string>): LegacyLineageDescriptor {
  const state = meta.legacy_migration_state;
  if (state === undefined) {
    if (["legacy_source_state_digest", "legacy_migration_receipt_digest", "legacy_reclassification_receipt_digest", "legacy_reclassification_attestation_digest", "legacy_reclassification_prestate_digest"].some((key) => meta[key] !== undefined)) throw new Error("Authority trust store has partial legacy lineage without a migration state.");
    return { migrationState: null, sourceStateDigest: null, initialMigrationReceiptDigest: null, reclassificationReceiptDigest: null, reclassificationAttestationDigest: null, reclassificationPrestateDigest: null };
  }
  if (!["never-recovered", "anchored-recovery", "ambiguous-audit-only"].includes(state)
    || !digestPattern.test(meta.legacy_source_state_digest ?? "") || !digestPattern.test(meta.legacy_migration_receipt_digest ?? "")) throw new Error("Authority trust store has malformed legacy migration lineage.");
  const reclassification = meta.legacy_reclassification_receipt_digest;
  if (reclassification === undefined) {
    if (meta.legacy_reclassification_attestation_digest !== undefined || meta.legacy_reclassification_prestate_digest !== undefined) throw new Error("Authority trust store has partial legacy reclassification lineage.");
    return { migrationState: state as LegacyLineageDescriptor["migrationState"], sourceStateDigest: meta.legacy_source_state_digest!, initialMigrationReceiptDigest: meta.legacy_migration_receipt_digest!, reclassificationReceiptDigest: null, reclassificationAttestationDigest: null, reclassificationPrestateDigest: null };
  }
  if (state === "ambiguous-audit-only" || !digestPattern.test(reclassification) || !digestPattern.test(meta.legacy_reclassification_attestation_digest ?? "") || !digestPattern.test(meta.legacy_reclassification_prestate_digest ?? "")) throw new Error("Authority trust store has malformed terminal reclassification lineage.");
  return {
    migrationState: state as LegacyLineageDescriptor["migrationState"], sourceStateDigest: meta.legacy_source_state_digest!, initialMigrationReceiptDigest: meta.legacy_migration_receipt_digest!,
    reclassificationReceiptDigest: reclassification, reclassificationAttestationDigest: meta.legacy_reclassification_attestation_digest!, reclassificationPrestateDigest: meta.legacy_reclassification_prestate_digest!,
  };
}

function parseEpoch(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} timestamp is invalid.`);
  return parsed;
}

function quoteSqlitePath(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export interface CustomerLocalHttpAuthorityTrustBackupManifest {
  schemaVersion: typeof CUSTOMER_LOCAL_HTTP_AUTHORITY_TRUST_BACKUP_VERSION;
  kind: "customer-local-http-authority-trust-audit-backup";
  workspaceId: string;
  tenantId: string;
  environment: string;
  trustConfigurationDigest: string;
  initialAdminKeyId: string;
  currentAdminKeyId: string;
  sourceActivationMode: "live" | "audit-only-restored";
  createdAt: string;
  expiresAt: string;
  signerKeyId: string;
  signerPublicKeyDigest: string;
  database: {
    path: "authority-trust.sqlite";
    bytes: number;
    sha256: string;
    sqliteUserVersion: 1;
    eventCount: number;
    eventHeadDigest: string;
  };
  legacyLineage: {
    migrationState: "never-recovered" | "anchored-recovery" | "ambiguous-audit-only" | null;
    sourceStateDigest: string | null;
    initialMigrationReceiptDigest: string | null;
    reclassificationReceiptDigest: string | null;
    reclassificationAttestationDigest: string | null;
    reclassificationPrestateDigest: string | null;
  };
  restoreMode: "audit-only-until-fresh-signed-activation";
  executionAuthorityEffect: "none";
  activationAuthorityEffect: "none";
  rollbackProtection: "requires-external-monotonic-anchor";
  manifestDigest: string;
}

type LegacyLineageDescriptor = CustomerLocalHttpAuthorityTrustBackupManifest["legacyLineage"];

export interface CustomerLocalHttpAuthorityTrustBackupSignature {
  schemaVersion: "1.0";
  algorithm: "Ed25519";
  signerKeyId: string;
  signature: string;
}

interface ActivationRow {
  activation_digest: string;
  workspace_id: string;
  authority_contract_digest: string;
  admin_signer_key_id: string;
  admin_public_key_digest: string;
  activation_json: string;
  issued_at: string;
  expires_at: string;
  imported_at: string;
  revoked_at: string | null;
  revocation_digest: string | null;
}

export interface WorkspaceHttpAuthorityActivationRevocationReceipt {
  schemaVersion: "1.0";
  workspaceId: string;
  authorityContractDigest: string;
  activationReceiptDigest: string;
  trustConfigurationDigest: string;
  revocationSignerKeyId: string;
  revocationSignerPublicKeyDigest: string;
  issuedAt: string;
  effectiveAt: string;
  reason: string;
  revocationNonce: string;
  executionAuthorityEffect: "revoke-exact-workspace-activation";
  auditAccessAllowed: true;
  signature: string;
  receiptDigest: string;
}

type ActivationRevocationPayload = Omit<WorkspaceHttpAuthorityActivationRevocationReceipt, "signature" | "receiptDigest">;

function activationRevocationPayload(receipt: WorkspaceHttpAuthorityActivationRevocationReceipt): ActivationRevocationPayload {
  const { signature: _signature, receiptDigest: _receiptDigest, ...payload } = receipt;
  return payload;
}

export function signWorkspaceHttpAuthorityActivationRevocation(input: {
  workspaceId: string;
  authorityContractDigest: string;
  activationReceiptDigest: string;
  trustConfigurationDigest: string;
  revocationSignerKeyId: string;
  revocationSignerPublicKeyDigest: string;
  issuedAt: string;
  effectiveAt: string;
  reason: string;
  revocationNonce: string;
  privateKey: KeyObject;
}): WorkspaceHttpAuthorityActivationRevocationReceipt {
  if (input.privateKey.type !== "private" || input.privateKey.asymmetricKeyType !== "ed25519") throw new Error("Workspace authority activation revocation requires an Ed25519 private key.");
  const payload: ActivationRevocationPayload = {
    schemaVersion: "1.0",
    workspaceId: input.workspaceId,
    authorityContractDigest: input.authorityContractDigest,
    activationReceiptDigest: input.activationReceiptDigest,
    trustConfigurationDigest: input.trustConfigurationDigest,
    revocationSignerKeyId: input.revocationSignerKeyId,
    revocationSignerPublicKeyDigest: input.revocationSignerPublicKeyDigest,
    issuedAt: input.issuedAt,
    effectiveAt: input.effectiveAt,
    reason: input.reason,
    revocationNonce: input.revocationNonce,
    executionAuthorityEffect: "revoke-exact-workspace-activation",
    auditAccessAllowed: true,
  };
  const signature = sign(null, Buffer.from(canonical(payload)), input.privateKey).toString("base64");
  return { ...payload, signature, receiptDigest: digest({ payload, signature }) };
}

export interface CustomerLocalHttpAuthorityTrustBinding {
  version: typeof CUSTOMER_LOCAL_HTTP_AUTHORITY_TRUST_VERSION;
  workspaceId: string;
  adminSignerKeyId: string;
  adminPublicKey: KeyObject;
  adminPublicKeyDigest: string;
  activationReceipt: WorkspaceHttpAuthorityActivationReceipt;
  activationReceiptDigest: string;
  authorityContractDigest: string;
  trustConfigurationDigest: string;
  authorityTrustStatePathDigest: string;
  bindingDigest: string;
  executionAuthorityEffect: "activation-only";
  auditAccessAllowed: true;
  testOnlyClock: boolean;
  assertCurrent(): void;
  withCurrentConsumption<T>(consume: () => T): T;
}

export function assertTrustedCustomerLocalHttpAuthorityTrustBinding(value: CustomerLocalHttpAuthorityTrustBinding): void {
  if (!trustedBindings.has(value)) throw new Error("Workspace authority trust binding is not an instance of the trusted customer-local implementation.");
}

export interface CustomerLocalHttpAuthorityTrustAuditEntry {
  activationDigest: string;
  workspaceId: string;
  authorityContractDigest: string;
  adminSignerKeyId: string;
  adminPublicKeyDigest: string;
  issuedAt: string;
  expiresAt: string;
  importedAt: string;
  revokedAt: string | null;
  revocationDigest: string | null;
  isCurrentHead: boolean;
}

/**
 * Independent customer-local root for workspace-admin authority.
 *
 * This ledger never issues action authority. It only pins which admin key owns a
 * workspace and which exact signed activation is current for an authority
 * contract. Audit and rollback inspection remain available after execution
 * authority becomes stale or revoked.
 */
export class CustomerLocalHttpAuthorityTrustStore {
  readonly statePath: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly trustConfigurationDigest: string;
  private readonly trustStore: CustomerLocalTrustStore;
  private readonly database: DatabaseSync;
  private readonly testOnly: boolean;
  private closed = false;

  constructor(input: {
    statePath: string;
    workspaceId: string;
    initialAdminKeyId: string;
    trustStore: CustomerLocalTrustStore;
    testOnly?: true;
  }) {
    if (!identifier.test(input.workspaceId) || !identifier.test(input.initialAdminKeyId)) throw new Error("HTTP authority trust workspace or initial admin identity is invalid.");
    exactCustomerTrustStore(input.trustStore);
    this.statePath = input.statePath;
    this.tenantId = input.trustStore.config.tenantId;
    this.workspaceId = input.workspaceId;
    this.trustStore = input.trustStore;
    this.testOnly = input.testOnly === true;
    if (input.trustStore.clockSource !== "system" && !this.testOnly) throw new Error("Production HTTP authority trust cannot use a caller-controlled clock; use the explicit test-only boundary.");
    this.trustConfigurationDigest = input.trustStore.configDigest;
    if (input.statePath !== ":memory:") mkdirSync(dirname(input.statePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(input.statePath);
    this.database.exec("PRAGMA busy_timeout=5000;");
    if (input.statePath !== ":memory:") chmodSync(input.statePath, 0o600);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA user_version = 1;
      CREATE TABLE IF NOT EXISTS authority_trust_meta(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS authority_admin_rotations(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        old_key_id TEXT NOT NULL,
        new_key_id TEXT NOT NULL,
        rotation_receipt_digest TEXT NOT NULL UNIQUE,
        receipt_json TEXT NOT NULL,
        adopted_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS authority_activations(
        activation_digest TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        authority_contract_digest TEXT NOT NULL,
        admin_signer_key_id TEXT NOT NULL,
        admin_public_key_digest TEXT NOT NULL,
        activation_json TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        revoked_at TEXT,
        revocation_digest TEXT
      );
      CREATE TABLE IF NOT EXISTS authority_activation_heads(
        authority_contract_digest TEXT PRIMARY KEY,
        activation_digest TEXT NOT NULL REFERENCES authority_activations(activation_digest)
      );
      CREATE TABLE IF NOT EXISTS authority_trust_events(
        sequence INTEGER PRIMARY KEY,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        previous_event_digest TEXT,
        event_digest TEXT NOT NULL UNIQUE,
        recorded_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS authority_rotation_limit
      BEFORE INSERT ON authority_admin_rotations
      WHEN (SELECT COUNT(*) FROM authority_admin_rotations) >= 256
      BEGIN SELECT RAISE(ABORT, 'HTTP authority admin-rotation history limit reached.'); END;
      CREATE TRIGGER IF NOT EXISTS authority_activation_limit
      BEFORE INSERT ON authority_activations
      WHEN (SELECT COUNT(*) FROM authority_activations) >= 4096
      BEGIN SELECT RAISE(ABORT, 'HTTP authority activation history limit reached.'); END;
      CREATE TRIGGER IF NOT EXISTS authority_trust_event_limit
      BEFORE INSERT ON authority_trust_events
      WHEN (SELECT COUNT(*) FROM authority_trust_events) >= 8192
      BEGIN SELECT RAISE(ABORT, 'HTTP authority trust event history limit reached.'); END;
    `);
    const existing = Object.fromEntries((this.database.prepare("SELECT key,value FROM authority_trust_meta").all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]));
    if (Object.keys(existing).length === 0) {
      const initial = input.trustStore.assertTrusted(input.initialAdminKeyId, input.trustStore.currentTime(), "HTTP authority trust bootstrap");
      if (initial.state !== "active") throw new Error("Initial workspace-admin trust key must be active.");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const insert = this.database.prepare("INSERT INTO authority_trust_meta(key,value) VALUES(?,?)");
        insert.run("version", CUSTOMER_LOCAL_HTTP_AUTHORITY_TRUST_VERSION);
        insert.run("workspace_id", input.workspaceId);
        insert.run("tenant_id", input.trustStore.config.tenantId);
        insert.run("environment", input.trustStore.config.environment);
        insert.run("trust_configuration_digest", input.trustStore.configDigest);
        insert.run("initial_admin_key_id", input.initialAdminKeyId);
        insert.run("current_admin_key_id", input.initialAdminKeyId);
        insert.run("clock_mode", this.testOnly ? "test-only" : "system");
        insert.run("activation_mode", "live");
        insert.run("audit_only_entered_at", "");
        insert.run("recovery_continuity_required", "false");
        insert.run("last_recovery_at", "");
        insert.run("last_seen_epoch_ms", String(parseEpoch(input.trustStore.currentTime(), "HTTP authority trust bootstrap")));
        insert.run("event_count", "0");
        insert.run("event_head_digest", "");
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    this.assertPinnedIdentity(input.initialAdminKeyId);
    trustedStores.add(this);
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("HTTP authority trust store is closed.");
  }

  private meta(): Record<string, string> {
    this.ensureOpen();
    return Object.fromEntries((this.database.prepare("SELECT key,value FROM authority_trust_meta").all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]));
  }

  private assertPinnedIdentity(initialAdminKeyId?: string, requireInitialMatch = true): Record<string, string> {
    const meta = this.meta();
    if (meta.version !== CUSTOMER_LOCAL_HTTP_AUTHORITY_TRUST_VERSION || meta.workspace_id !== this.workspaceId
      || meta.tenant_id !== this.trustStore.config.tenantId || meta.environment !== this.trustStore.config.environment
      || meta.trust_configuration_digest !== this.trustStore.configDigest || !meta.initial_admin_key_id || !meta.current_admin_key_id || !meta.last_seen_epoch_ms
      || meta.event_count === undefined || meta.event_head_digest === undefined || meta.clock_mode !== (this.testOnly ? "test-only" : "system")
      || !["live", "audit-only-restored"].includes(meta.activation_mode ?? "") || meta.audit_only_entered_at === undefined
      || !["true", "false"].includes(meta.recovery_continuity_required ?? "") || meta.last_recovery_at === undefined) {
      throw new Error("Persisted workspace authority trust identity conflicts with the independently pinned customer-local trust store.");
    }
    if (requireInitialMatch && initialAdminKeyId && meta.initial_admin_key_id !== initialAdminKeyId) throw new Error("Caller attempted to substitute the pinned workspace-admin bootstrap key on restart.");
    const restoreManifestDigest = meta.last_audit_restore_manifest_digest, restoreLineageDigest = meta.last_audit_restore_legacy_lineage_digest;
    if ((restoreManifestDigest === undefined) !== (restoreLineageDigest === undefined)
      || (restoreManifestDigest !== undefined && (!digestPattern.test(restoreManifestDigest) || !digestPattern.test(restoreLineageDigest!)))) {
      throw new Error("Persisted workspace authority restore lineage is torn or malformed.");
    }
    legacyLineageDescriptor(meta);
    return meta;
  }

  private appendEvent(eventType: "admin-rotation" | "activation-imported" | "activation-revoked", payload: unknown, recordedAt: string): string {
    const meta = this.meta(), sequence = Number(meta.event_count) + 1, previousEventDigest = meta.event_head_digest || null;
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("HTTP authority trust event sequence is invalid.");
    const eventDigest = digest({ sequence, eventType, payloadDigest: digest(payload), previousEventDigest, recordedAt });
    this.database.prepare("INSERT INTO authority_trust_events(sequence,event_type,payload_json,previous_event_digest,event_digest,recorded_at) VALUES(?,?,?,?,?,?)")
      .run(sequence, eventType, JSON.stringify(payload), previousEventDigest, eventDigest, recordedAt);
    this.database.prepare("UPDATE authority_trust_meta SET value=? WHERE key='event_count'").run(String(sequence));
    this.database.prepare("UPDATE authority_trust_meta SET value=? WHERE key='event_head_digest'").run(eventDigest);
    return eventDigest;
  }

  private validateLegacyReclassificationLineage(meta: Record<string, string>): void {
    const table = this.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='authority_legacy_reclassifications'").get() as { name: string } | undefined;
    const receiptDigest = meta.legacy_reclassification_receipt_digest;
    if (receiptDigest === undefined) {
      if (table) throw new Error("Legacy authority reclassification table exists without bound lineage metadata.");
      return;
    }
    for (const key of ["legacy_reclassification_attestation_digest", "legacy_reclassification_prestate_digest", "legacy_reclassification_guard_identity_digest", "legacy_reclassified_at", "legacy_migration_receipt_digest", "legacy_source_state_digest"]) {
      if (meta[key] === undefined) throw new Error("Legacy authority reclassification metadata is incomplete.");
    }
    if (!table || !digestPattern.test(receiptDigest) || !digestPattern.test(meta.legacy_reclassification_attestation_digest!)
      || !digestPattern.test(meta.legacy_reclassification_prestate_digest!) || !digestPattern.test(meta.legacy_migration_receipt_digest!)
      || !digestPattern.test(meta.legacy_source_state_digest!) || !["never-recovered", "anchored-recovery"].includes(meta.legacy_migration_state ?? "")) {
      throw new Error("Legacy authority reclassification lineage is missing, malformed, or not terminal.");
    }
    const rows = this.database.prepare("SELECT receipt_digest,receipt_json,attestation_json,reclassified_at FROM authority_legacy_reclassifications").all() as Array<{ receipt_digest: string; receipt_json: string; attestation_json: string; reclassified_at: string }>;
    if (rows.length !== 1) throw new Error("Legacy authority reclassification must retain exactly one immutable lineage receipt.");
    const row = rows[0]!, receipt = JSON.parse(row.receipt_json) as Record<string, unknown>, attestation = JSON.parse(row.attestation_json) as Record<string, unknown>;
    const { receiptDigest: persistedReceiptDigest, ...receiptBody } = receipt;
    const { signature, receiptDigest: attestationDigest, ...attestationPayload } = attestation;
    if (row.receipt_digest !== receiptDigest || persistedReceiptDigest !== receiptDigest || digest(receiptBody) !== receiptDigest
      || attestationDigest !== meta.legacy_reclassification_attestation_digest || digest({ payload: attestationPayload, signature }) !== attestationDigest
      || typeof signature !== "string" || !base64Pattern.test(signature)
      || receipt.schemaVersion !== "1.0" || receipt.kind !== "legacy-http-authority-trust-reclassification"
      || receipt.sourceStateDigest !== meta.legacy_source_state_digest || receipt.initialMigrationReceiptDigest !== meta.legacy_migration_receipt_digest
      || receipt.migratedAuditStateDigest !== meta.legacy_reclassification_prestate_digest || receipt.tenantId !== meta.tenant_id
      || receipt.environment !== meta.environment || receipt.workspaceId !== meta.workspace_id || receipt.trustConfigurationDigest !== meta.trust_configuration_digest
      || receipt.priorClassification !== "ambiguous-audit-only" || receipt.classification !== meta.legacy_migration_state
      || receipt.attestationReceiptDigest !== attestationDigest || typeof receipt.preservedEventCount !== "number"
      || !Number.isSafeInteger(receipt.preservedEventCount) || receipt.preservedEventCount < 0 || receipt.preservedEventCount > Number(meta.event_count)
      || receipt.activationMode !== "audit-only-restored"
      || receipt.freshActivationRequired !== true || receipt.freshAuthorityStateRequired !== true
      || receipt.existingLeaseAuthorityEffect !== "none" || receipt.executionAuthorityEffect !== "none"
      || receipt.reclassifiedAt !== row.reclassified_at || receipt.reclassifiedAt !== meta.legacy_reclassified_at
      || attestation.schemaVersion !== "1.0" || attestation.kind !== "legacy-http-authority-reclassification-attestation"
      || attestation.sourceStateDigest !== receipt.sourceStateDigest || attestation.initialMigrationReceiptDigest !== receipt.initialMigrationReceiptDigest
      || attestation.migratedAuditStateDigest !== receipt.migratedAuditStateDigest || attestation.tenantId !== receipt.tenantId
      || attestation.environment !== receipt.environment || attestation.workspaceId !== receipt.workspaceId
      || attestation.trustConfigurationDigest !== receipt.trustConfigurationDigest || attestation.eventHeadDigest !== receipt.preservedEventHeadDigest
      || attestation.eventCount !== receipt.preservedEventCount || attestation.activationAuthorityEffect !== "none"
      || attestation.executionAuthorityEffect !== "none" || typeof attestation.signerKeyId !== "string"
      || typeof attestation.issuedAt !== "string" || typeof attestation.expiresAt !== "string" || typeof attestation.statement !== "string"
      || !attestation.statement.trim() || attestation.statement.length > 1_000) {
      throw new Error("Legacy authority reclassification receipt or attestation changed after publication.");
    }
    const preservedHead = receipt.preservedEventCount === 0 ? "" : (this.database.prepare("SELECT event_digest FROM authority_trust_events WHERE sequence=?").get(receipt.preservedEventCount) as { event_digest: string } | undefined)?.event_digest;
    if (preservedHead !== receipt.preservedEventHeadDigest) throw new Error("Legacy authority reclassification no longer binds an exact prefix of the append-only authority history.");
    const issuedAt = parseEpoch(attestation.issuedAt, "Legacy reclassification issue"), expiresAt = parseEpoch(attestation.expiresAt, "Legacy reclassification expiry"), reclassifiedAt = parseEpoch(row.reclassified_at, "Legacy reclassification publication");
    const assessor = this.trustStore.assertTrusted(attestation.signerKeyId, attestation.issuedAt, "legacy authority reclassification audit");
    if (assessor.state !== "active" || issuedAt > reclassifiedAt || expiresAt <= reclassifiedAt || expiresAt <= issuedAt || expiresAt - issuedAt > 24 * 60 * 60 * 1_000
      || !verify(null, Buffer.from(canonical(attestationPayload)), assessor.publicKey, Buffer.from(signature, "base64"))) {
      throw new Error("Legacy authority reclassification attestation no longer verifies against its pinned assessor and publication time.");
    }
    const currentRecoveryRequired = meta.recovery_continuity_required === "true";
    const currentRecoveryAt = currentRecoveryRequired ? parseEpoch(meta.last_recovery_at!, "Current authority recovery lineage") : null;
    if (receipt.classification === "never-recovered") {
      if (receipt.recoveryContinuityRequired !== false || receipt.continuityGuardIdentityDigest !== null
        || attestation.classification !== "independently-attested-never-recovered" || attestation.continuityGuardIdentityDigest !== null
        || attestation.effectiveRecoveryAt !== null || meta.legacy_reclassification_guard_identity_digest !== ""
        || (currentRecoveryRequired ? currentRecoveryAt! < reclassifiedAt : meta.last_recovery_at !== "")) throw new Error("Never-recovered reclassification acquired invalid historical or later recovery lineage.");
    } else if (receipt.recoveryContinuityRequired !== true || typeof receipt.continuityGuardIdentityDigest !== "string"
      || !digestPattern.test(receipt.continuityGuardIdentityDigest) || receipt.continuityGuardIdentityDigest !== meta.legacy_reclassification_guard_identity_digest
      || attestation.classification !== "externally-anchored-recovery" || attestation.continuityGuardIdentityDigest !== receipt.continuityGuardIdentityDigest
      || typeof attestation.effectiveRecoveryAt !== "string" || !currentRecoveryRequired
      || currentRecoveryAt! < parseEpoch(attestation.effectiveRecoveryAt, "Original anchored reclassification recovery")) throw new Error("Anchored reclassification lost its exact recovery lineage.");
  }

  private validateEventChain(): void {
    const meta = this.assertPinnedIdentity(), events = this.database.prepare("SELECT sequence,event_type,payload_json,previous_event_digest,event_digest,recorded_at FROM authority_trust_events ORDER BY sequence").all() as Array<{ sequence: number; event_type: string; payload_json: string; previous_event_digest: string | null; event_digest: string; recorded_at: string }>;
    this.validateLegacyReclassificationLineage(meta);
    if (events.length !== Number(meta.event_count) || events.length > 8192) throw new Error("Workspace authority trust event count diverges from its pinned head.");
    type ReplayKey = { keyId: string; issuer: string; publicKey: KeyObject; publicKeyDigest: string; notBefore: number; notAfter: number; state: "active" | "retiring" };
    const replayKeys = new Map<string, ReplayKey>();
    for (const key of this.trustStore.config.keys) {
      const publicKey = createPublicKey(key.publicKeyPem);
      replayKeys.set(key.keyId, { keyId: key.keyId, issuer: key.issuer, publicKey, publicKeyDigest: keyDigest(publicKey), notBefore: parseEpoch(key.notBefore, "Bootstrap key start"), notAfter: parseEpoch(key.notAfter, "Bootstrap key end"), state: "active" });
    }
    let previous: string | null = null, previousRecordedAt = 0, currentAdminKeyId = meta.initial_admin_key_id!;
    const activationHeads = new Map<string, string>(), activationReceipts = new Map<string, { receipt: WorkspaceHttpAuthorityActivationReceipt; importedAt: string; adminPublicKeyDigest: string }>(), revoked = new Map<string, { digest: string; effectiveAt: string }>(), rotationRecords: Array<{ digest: string; receiptJson: string; adoptedAt: string }> = [];
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      if (event.sequence !== index + 1 || event.previous_event_digest !== previous) throw new Error("Workspace authority trust event sequence or predecessor changed.");
      const recordedAt = parseEpoch(event.recorded_at, "Authority trust event recording");
      if (recordedAt < previousRecordedAt) throw new Error("Workspace authority trust event chronology moved backward.");
      const payload = JSON.parse(event.payload_json) as unknown;
      const expected = digest({ sequence: event.sequence, eventType: event.event_type, payloadDigest: digest(payload), previousEventDigest: previous, recordedAt: event.recorded_at });
      if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(event.event_digest, "hex"))) throw new Error("Workspace authority trust event digest changed.");
      if (event.event_type === "admin-rotation") {
        const receipt = payload as RotationReceipt;
        const rotation = receipt.payload, old = replayKeys.get(currentAdminKeyId), next = createPublicKey(rotation.newPublicKeyPem), issuedAt = parseEpoch(rotation.issuedAt, "Rotation issue"), effectiveAt = parseEpoch(rotation.effectiveAt, "Rotation effect"), newNotAfter = parseEpoch(rotation.newNotAfter, "Rotation successor expiry");
        if (!old || rotation.schemaVersion !== "1.0" || rotation.tenantId !== this.trustStore.config.tenantId || rotation.environment !== this.trustStore.config.environment
          || rotation.oldKeyId !== currentAdminKeyId || rotation.oldPublicKeyDigest !== old.publicKeyDigest || rotation.executionAuthorityEffect !== "none" || rotation.activationEffect !== "none"
          || receipt.receiptDigest !== digest(rotation) || previousRecordedAt > issuedAt || issuedAt > effectiveAt || effectiveAt > recordedAt
          || effectiveAt < old.notBefore || effectiveAt >= old.notAfter || replayKeys.has(rotation.newKeyId) || keyDigest(next) !== rotation.newPublicKeyDigest || newNotAfter <= effectiveAt
          || !base64Pattern.test(receipt.oldKeySignature) || !base64Pattern.test(receipt.newKeySignature)
          || !verify(null, Buffer.from(canonical(rotation)), old.publicKey, Buffer.from(receipt.oldKeySignature, "base64"))
          || !verify(null, Buffer.from(canonical(rotation)), next, Buffer.from(receipt.newKeySignature, "base64"))) throw new Error("Workspace authority trust rotation event failed signed lineage replay.");
        old.state = "retiring";
        replayKeys.set(rotation.newKeyId, { keyId: rotation.newKeyId, issuer: rotation.newIssuer, publicKey: next, publicKeyDigest: rotation.newPublicKeyDigest, notBefore: effectiveAt, notAfter: newNotAfter, state: "active" });
        currentAdminKeyId = rotation.newKeyId;
        rotationRecords.push({ digest: receipt.receiptDigest, receiptJson: JSON.stringify(receipt), adoptedAt: event.recorded_at });
      } else if (event.event_type === "activation-imported") {
        const receipt = payload as WorkspaceHttpAuthorityActivationReceipt;
        const signer = replayKeys.get(currentAdminKeyId), issuedAt = parseEpoch(receipt.issuedAt, "Activation issue"), expiresAt = parseEpoch(receipt.expiresAt, "Activation expiry");
        if (!signer || signer.state !== "active" || receipt.schemaVersion !== "1.0" || receipt.workspaceId !== this.workspaceId || receipt.adminSignerKeyId !== currentAdminKeyId
          || !digestPattern.test(receipt.authorityContractDigest) || issuedAt < signer.notBefore || issuedAt >= signer.notAfter || issuedAt > recordedAt || expiresAt <= issuedAt || expiresAt - issuedAt > 365 * 24 * 60 * 60 * 1_000
          || !base64Pattern.test(receipt.signature) || receipt.receiptDigest !== digest({ payload: activationPayload(receipt), signature: receipt.signature })
          || !verify(null, Buffer.from(canonical(activationPayload(receipt))), signer.publicKey, Buffer.from(receipt.signature, "base64"))) throw new Error("Workspace authority activation event failed signed historical replay.");
        activationHeads.set(receipt.authorityContractDigest, receipt.receiptDigest);
        activationReceipts.set(receipt.receiptDigest, { receipt, importedAt: event.recorded_at, adminPublicKeyDigest: signer.publicKeyDigest });
      } else if (event.event_type === "activation-revoked") {
        const receipt = payload as WorkspaceHttpAuthorityActivationRevocationReceipt;
        const signer = replayKeys.get(currentAdminKeyId), target = activationReceipts.get(receipt.activationReceiptDigest), signed = activationRevocationPayload(receipt), issuedAt = parseEpoch(receipt.issuedAt, "Activation revocation issue"), effectiveAt = parseEpoch(receipt.effectiveAt, "Activation revocation effect");
        if (!signer || signer.state !== "active" || !target || revoked.has(receipt.activationReceiptDigest) || receipt.schemaVersion !== "1.0" || receipt.workspaceId !== this.workspaceId
          || receipt.authorityContractDigest !== target.receipt.authorityContractDigest || receipt.trustConfigurationDigest !== this.trustConfigurationDigest
          || receipt.revocationSignerKeyId !== currentAdminKeyId || receipt.revocationSignerPublicKeyDigest !== signer.publicKeyDigest
          || receipt.executionAuthorityEffect !== "revoke-exact-workspace-activation" || receipt.auditAccessAllowed !== true || !receipt.reason.trim()
          || receipt.receiptDigest !== digest({ payload: signed, signature: receipt.signature }) || issuedAt > effectiveAt || effectiveAt > recordedAt
          || !base64Pattern.test(receipt.signature) || !verify(null, Buffer.from(canonical(signed)), signer.publicKey, Buffer.from(receipt.signature, "base64"))) throw new Error("Workspace authority activation revocation event failed signed historical replay.");
        revoked.set(receipt.activationReceiptDigest, { digest: receipt.receiptDigest, effectiveAt: receipt.effectiveAt });
      } else throw new Error("Workspace authority trust event type is unknown.");
      previous = event.event_digest;
      previousRecordedAt = recordedAt;
    }
    if ((previous ?? "") !== meta.event_head_digest || currentAdminKeyId !== meta.current_admin_key_id) throw new Error("Workspace authority trust event head or admin lineage diverges from materialized state.");
    const actualHeads = new Map((this.database.prepare("SELECT authority_contract_digest,activation_digest FROM authority_activation_heads").all() as Array<{ authority_contract_digest: string; activation_digest: string }>).map((row) => [row.authority_contract_digest, row.activation_digest]));
    if (canonical([...actualHeads.entries()].sort()) !== canonical([...activationHeads.entries()].sort())) throw new Error("Workspace authority activation heads diverge from their append-only event lineage.");
    const rows = this.database.prepare("SELECT * FROM authority_activations").all() as unknown as ActivationRow[];
    if (rows.length !== activationReceipts.size || rows.some((row) => {
      const replayed = activationReceipts.get(row.activation_digest), revocation = revoked.get(row.activation_digest);
      if (!replayed) return true;
      const receipt = replayed.receipt;
      return row.workspace_id !== receipt.workspaceId || row.authority_contract_digest !== receipt.authorityContractDigest || row.admin_signer_key_id !== receipt.adminSignerKeyId
        || row.admin_public_key_digest !== replayed.adminPublicKeyDigest || row.activation_json !== JSON.stringify(receipt) || row.issued_at !== receipt.issuedAt || row.expires_at !== receipt.expiresAt
        || row.imported_at !== replayed.importedAt || row.revoked_at !== (revocation?.effectiveAt ?? null) || row.revocation_digest !== (revocation?.digest ?? null);
    })) throw new Error("Workspace authority activation records diverge from their append-only event lineage.");
    const persistedRotations = (this.database.prepare("SELECT rotation_receipt_digest,receipt_json,adopted_at FROM authority_admin_rotations ORDER BY sequence").all() as Array<{ rotation_receipt_digest: string; receipt_json: string; adopted_at: string }>).map((row) => ({ digest: row.rotation_receipt_digest, receiptJson: row.receipt_json, adoptedAt: row.adopted_at }));
    if (canonical(persistedRotations) !== canonical(rotationRecords)) throw new Error("Workspace authority rotation records diverge from their signed append-only event lineage.");
  }

  private trustedNow(): string {
    const now = this.trustStore.currentTime();
    const epochNow = parseEpoch(now, "HTTP authority trust current time");
    const meta = this.assertPinnedIdentity();
    const lastSeen = Number(meta.last_seen_epoch_ms);
    if (!Number.isSafeInteger(lastSeen) || epochNow < lastSeen) throw new Error("HTTP authority trust clock moved backward below its durable last-seen boundary.");
    if (epochNow > lastSeen) this.database.prepare("UPDATE authority_trust_meta SET value=? WHERE key='last_seen_epoch_ms'").run(String(epochNow));
    return now;
  }

  stableIdentity(): { workspaceId: string; trustConfigurationDigest: string; activationPolicyVersion: "1.0" } {
    this.validateEventChain();
    return { workspaceId: this.workspaceId, trustConfigurationDigest: this.trustConfigurationDigest, activationPolicyVersion: "1.0" };
  }

  currentAdminKey(): { keyId: string; publicKey: KeyObject; publicKeyDigest: string; trustConfigurationDigest: string } {
    if (!trustedStores.has(this)) throw new Error("HTTP authority trust store implementation identity is invalid.");
    this.validateEventChain();
    const meta = this.assertPinnedIdentity();
    const trusted = this.trustStore.assertTrusted(meta.current_admin_key_id!, this.trustedNow(), "workspace-admin authority resolution");
    if (trusted.state !== "active") throw new Error("Current workspace-admin key is rotated, retiring, or otherwise not active; adopt the exact signed successor before issuing authority.");
    return { keyId: trusted.keyId, publicKey: trusted.publicKey, publicKeyDigest: trusted.publicKeyDigest, trustConfigurationDigest: this.trustConfigurationDigest };
  }

  adoptAdminRotation(receipt: RotationReceipt): { oldKeyId: string; newKeyId: string; rotationReceiptDigest: string } {
    this.validateEventChain();
    const meta = this.assertPinnedIdentity();
    const payload = receipt.payload;
    const now = this.trustedNow();
    if (payload.schemaVersion !== "1.0" || payload.tenantId !== this.trustStore.config.tenantId || payload.environment !== this.trustStore.config.environment
      || payload.oldKeyId !== meta.current_admin_key_id || payload.executionAuthorityEffect !== "none" || payload.activationEffect !== "none"
      || receipt.receiptDigest !== digest(payload) || parseEpoch(payload.issuedAt, "Admin rotation issue") > parseEpoch(payload.effectiveAt, "Admin rotation effect")
      || parseEpoch(payload.effectiveAt, "Admin rotation effect") > parseEpoch(now, "Admin rotation adoption")) throw new Error("Workspace-admin rotation receipt has the wrong boundary, lineage, digest, or chronology.");
    const oldKey = this.trustStore.assertTrusted(payload.oldKeyId, now, "workspace-admin rotation adoption old key");
    const newKey = this.trustStore.assertTrusted(payload.newKeyId, now, "workspace-admin rotation adoption new key");
    if (oldKey.state !== "retiring" || newKey.state !== "active" || oldKey.publicKeyDigest !== payload.oldPublicKeyDigest || newKey.publicKeyDigest !== payload.newPublicKeyDigest) throw new Error("Workspace-admin rotation is not the exact applied customer-local trust transition.");
    const material = Buffer.from(canonical(payload));
    if (!base64Pattern.test(receipt.oldKeySignature) || !base64Pattern.test(receipt.newKeySignature)
      || !verify(null, material, oldKey.publicKey, Buffer.from(receipt.oldKeySignature, "base64"))
      || !verify(null, material, newKey.publicKey, Buffer.from(receipt.newKeySignature, "base64"))) throw new Error("Workspace-admin rotation requires both exact Ed25519 signatures.");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const latest = this.meta();
      if (latest.current_admin_key_id !== payload.oldKeyId) throw new Error("Workspace-admin rotation lost a concurrent lineage race.");
      const recordedAt = this.trustedNow();
      if (parseEpoch(payload.effectiveAt, "Admin rotation effect") > parseEpoch(recordedAt, "Admin rotation adoption")) throw new Error("Workspace-admin rotation is not yet effective at its serialized adoption point.");
      this.database.prepare("INSERT INTO authority_admin_rotations(old_key_id,new_key_id,rotation_receipt_digest,receipt_json,adopted_at) VALUES(?,?,?,?,?)")
        .run(payload.oldKeyId, payload.newKeyId, receipt.receiptDigest, JSON.stringify(receipt), recordedAt);
      this.database.prepare("UPDATE authority_trust_meta SET value=? WHERE key='current_admin_key_id'").run(payload.newKeyId);
      this.appendEvent("admin-rotation", receipt, recordedAt);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { oldKeyId: payload.oldKeyId, newKeyId: payload.newKeyId, rotationReceiptDigest: receipt.receiptDigest };
  }

  importActivation(receipt: WorkspaceHttpAuthorityActivationReceipt): { activationReceiptDigest: string; authorityContractDigest: string } {
    const admin = this.currentAdminKey();
    const now = this.trustedNow();
    const issued = parseEpoch(receipt.issuedAt, "Authority activation issue");
    const expires = parseEpoch(receipt.expiresAt, "Authority activation expiry");
    if (receipt.schemaVersion !== "1.0" || receipt.workspaceId !== this.workspaceId || receipt.adminSignerKeyId !== admin.keyId
      || !digestPattern.test(receipt.authorityContractDigest) || receipt.receiptDigest !== digest({ payload: activationPayload(receipt), signature: receipt.signature })
      || issued > parseEpoch(now, "Authority activation import") || expires <= issued || expires <= parseEpoch(now, "Authority activation import")
      || expires - issued > 365 * 24 * 60 * 60 * 1_000 || !base64Pattern.test(receipt.signature)
      || !verify(null, Buffer.from(canonical(activationPayload(receipt))), admin.publicKey, Buffer.from(receipt.signature, "base64"))) {
      throw new Error("Workspace authority activation is forged, stale, cross-workspace, overlong, or signed by a non-current admin key.");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const serializedAdmin = this.currentAdminKey();
      if (serializedAdmin.keyId !== admin.keyId || serializedAdmin.publicKeyDigest !== admin.publicKeyDigest) throw new Error("Workspace authority activation lost a concurrent admin-lineage race.");
      const recordedAt = this.trustedNow();
      if (issued > parseEpoch(recordedAt, "Authority activation serialized import") || expires <= parseEpoch(recordedAt, "Authority activation serialized import")) throw new Error("Workspace authority activation became stale or future-issued before serialized import.");
      const current = this.database.prepare("SELECT a.* FROM authority_activation_heads h JOIN authority_activations a ON a.activation_digest=h.activation_digest WHERE h.authority_contract_digest=?")
        .get(receipt.authorityContractDigest) as ActivationRow | undefined;
      if (current?.activation_digest === receipt.receiptDigest && current.activation_json === JSON.stringify(receipt)) {
        this.database.exec("COMMIT");
        return { activationReceiptDigest: receipt.receiptDigest, authorityContractDigest: receipt.authorityContractDigest };
      }
      if (current && current.activation_digest !== receipt.receiptDigest && parseEpoch(current.issued_at, "Current activation issue") >= issued) throw new Error("Workspace authority activation cannot roll its exact contract back to an older or same-time receipt.");
      this.database.prepare("INSERT OR IGNORE INTO authority_activations VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL)")
        .run(receipt.receiptDigest, this.workspaceId, receipt.authorityContractDigest, admin.keyId, admin.publicKeyDigest, JSON.stringify(receipt), receipt.issuedAt, receipt.expiresAt, recordedAt);
      const inserted = this.database.prepare("SELECT * FROM authority_activations WHERE activation_digest=?").get(receipt.receiptDigest) as unknown as ActivationRow;
      if (inserted.workspace_id !== this.workspaceId || inserted.authority_contract_digest !== receipt.authorityContractDigest || inserted.admin_signer_key_id !== admin.keyId
        || inserted.admin_public_key_digest !== admin.publicKeyDigest || inserted.activation_json !== JSON.stringify(receipt)) throw new Error("Existing authority activation digest refers to different persisted content.");
      this.database.prepare("INSERT INTO authority_activation_heads(authority_contract_digest,activation_digest) VALUES(?,?) ON CONFLICT(authority_contract_digest) DO UPDATE SET activation_digest=excluded.activation_digest")
        .run(receipt.authorityContractDigest, receipt.receiptDigest);
      this.appendEvent("activation-imported", receipt, recordedAt);
      const mode = this.meta();
      if (mode.activation_mode === "audit-only-restored") {
        if (mode.legacy_migration_state === "ambiguous-audit-only") throw new Error("Ambiguous legacy recovery history cannot leave audit-only mode until it is reclassified with exact independent evidence.");
        if (issued <= parseEpoch(mode.audit_only_entered_at!, "Audit-only recovery entry")) throw new Error("Restored authority trust requires a fresh post-restore activation.");
        this.database.prepare("UPDATE authority_trust_meta SET value='live' WHERE key='activation_mode'").run();
        this.database.prepare("UPDATE authority_trust_meta SET value='' WHERE key='audit_only_entered_at'").run();
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { activationReceiptDigest: receipt.receiptDigest, authorityContractDigest: receipt.authorityContractDigest };
  }

  revokeActivation(receipt: WorkspaceHttpAuthorityActivationRevocationReceipt): { activationReceiptDigest: string; revokedAt: string } {
    const admin = this.currentAdminKey();
    const now = this.trustedNow();
    const payload = activationRevocationPayload(receipt);
    const target = this.database.prepare("SELECT * FROM authority_activations WHERE activation_digest=?").get(receipt.activationReceiptDigest) as ActivationRow | undefined;
    if (!target || receipt.schemaVersion !== "1.0" || receipt.workspaceId !== this.workspaceId || receipt.authorityContractDigest !== target.authority_contract_digest
      || receipt.trustConfigurationDigest !== this.trustConfigurationDigest || receipt.revocationSignerKeyId !== admin.keyId
      || receipt.revocationSignerPublicKeyDigest !== admin.publicKeyDigest || receipt.executionAuthorityEffect !== "revoke-exact-workspace-activation"
      || receipt.auditAccessAllowed !== true || !receipt.reason.trim() || receipt.reason.length > 500
      || !/^[a-f0-9]{32,128}$/.test(receipt.revocationNonce) || receipt.receiptDigest !== digest({ payload, signature: receipt.signature })
      || parseEpoch(receipt.issuedAt, "Activation revocation issue") > parseEpoch(receipt.effectiveAt, "Activation revocation effect")
      || parseEpoch(receipt.effectiveAt, "Activation revocation effect") > parseEpoch(now, "Activation revocation currentness")
      || !base64Pattern.test(receipt.signature) || !verify(null, Buffer.from(canonical(payload)), admin.publicKey, Buffer.from(receipt.signature, "base64"))) {
      throw new Error("Workspace authority activation revocation is forged, cross-boundary, future-dated, or unauthorized.");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const serializedAdmin = this.currentAdminKey();
      if (serializedAdmin.keyId !== admin.keyId || serializedAdmin.publicKeyDigest !== admin.publicKeyDigest) throw new Error("Workspace authority activation revocation lost a concurrent admin-lineage race.");
      const recordedAt = this.trustedNow();
      if (parseEpoch(receipt.effectiveAt, "Activation revocation effect") > parseEpoch(recordedAt, "Activation revocation serialized currentness")) throw new Error("Workspace authority activation revocation is not yet effective at its serialized point.");
      const current = this.database.prepare("SELECT revoked_at,revocation_digest FROM authority_activations WHERE activation_digest=?").get(receipt.activationReceiptDigest) as { revoked_at: string | null; revocation_digest: string | null } | undefined;
      if (!current) throw new Error("Workspace authority activation disappeared before serialized revocation.");
      if (current.revoked_at !== null || current.revocation_digest !== null) throw new Error("Workspace authority activation is already revoked.");
      this.database.prepare("UPDATE authority_activations SET revoked_at=?,revocation_digest=? WHERE activation_digest=?")
        .run(receipt.effectiveAt, receipt.receiptDigest, receipt.activationReceiptDigest);
      this.appendEvent("activation-revoked", receipt, recordedAt);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { activationReceiptDigest: receipt.activationReceiptDigest, revokedAt: receipt.effectiveAt };
  }

  resolveCurrent(authorityContractDigest: string): CustomerLocalHttpAuthorityTrustBinding {
    if (!trustedStores.has(this) || !digestPattern.test(authorityContractDigest)) throw new Error("HTTP authority trust resolution requires an exact trusted store and contract digest.");
    if (this.assertPinnedIdentity().activation_mode !== "live") throw new Error("Restored workspace authority trust is audit-only until a fresh post-restore activation is registered.");
    const admin = this.currentAdminKey();
    const row = this.database.prepare("SELECT a.* FROM authority_activation_heads h JOIN authority_activations a ON a.activation_digest=h.activation_digest WHERE h.authority_contract_digest=?")
      .get(authorityContractDigest) as ActivationRow | undefined;
    if (!row) throw new Error("No current independently pinned workspace authority activation exists for this exact contract.");
    const assertCurrent = () => {
      if (this.assertPinnedIdentity().activation_mode !== "live") throw new Error("Workspace authority trust is audit-only and cannot authorize consumption.");
      const currentAdmin = this.currentAdminKey();
      const current = this.database.prepare("SELECT a.* FROM authority_activation_heads h JOIN authority_activations a ON a.activation_digest=h.activation_digest WHERE h.authority_contract_digest=?")
        .get(authorityContractDigest) as ActivationRow | undefined;
      if (!current || current.activation_digest !== row.activation_digest || current.workspace_id !== this.workspaceId || current.authority_contract_digest !== authorityContractDigest
        || current.admin_signer_key_id !== currentAdmin.keyId || current.admin_public_key_digest !== currentAdmin.publicKeyDigest) throw new Error("Workspace authority activation or admin trust changed after resolution.");
      const receipt = JSON.parse(current.activation_json) as WorkspaceHttpAuthorityActivationReceipt;
      const now = this.trustedNow();
      const trustedAtIssue = this.trustStore.assertTrusted(current.admin_signer_key_id, receipt.issuedAt, "workspace authority activation issuance");
      const trustedNow = this.trustStore.assertTrusted(current.admin_signer_key_id, now, "workspace authority activation currentness");
      if (current.revoked_at !== null || current.revocation_digest !== null || trustedNow.state !== "active" || trustedAtIssue.publicKeyDigest !== current.admin_public_key_digest || trustedNow.publicKeyDigest !== current.admin_public_key_digest
        || receipt.receiptDigest !== current.activation_digest || receipt.workspaceId !== this.workspaceId || receipt.authorityContractDigest !== authorityContractDigest
        || receipt.adminSignerKeyId !== current.admin_signer_key_id || parseEpoch(receipt.issuedAt, "Activation issue") > parseEpoch(now, "Activation currentness")
        || parseEpoch(receipt.expiresAt, "Activation expiry") <= parseEpoch(now, "Activation currentness")
        || receipt.receiptDigest !== digest({ payload: activationPayload(receipt), signature: receipt.signature })
        || !base64Pattern.test(receipt.signature) || !verify(null, Buffer.from(canonical(activationPayload(receipt))), trustedNow.publicKey, Buffer.from(receipt.signature, "base64"))) {
        throw new Error("Current workspace authority activation is stale, revoked, rotated, substituted, or invalid.");
      }
    };
    assertCurrent();
    const activationReceipt = JSON.parse(row.activation_json) as WorkspaceHttpAuthorityActivationReceipt;
    const body = {
      version: CUSTOMER_LOCAL_HTTP_AUTHORITY_TRUST_VERSION,
      workspaceId: this.workspaceId,
      adminSignerKeyId: admin.keyId,
      adminPublicKeyDigest: admin.publicKeyDigest,
      activationReceiptDigest: row.activation_digest,
      authorityContractDigest,
      trustConfigurationDigest: this.trustConfigurationDigest,
      authorityTrustStatePathDigest: digest(this.statePath),
      executionAuthorityEffect: "activation-only" as const,
      auditAccessAllowed: true as const,
      testOnlyClock: this.testOnly,
    };
    const withCurrentConsumption = <T>(consume: () => T): T => {
      if (typeof consume !== "function") throw new Error("Workspace authority consumption serialization requires one trusted synchronous operation.");
      this.ensureOpen();
      this.database.exec("BEGIN IMMEDIATE");
      try {
        assertCurrent();
        const result = consume();
        if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") throw new Error("Workspace authority consumption serialization cannot span an asynchronous callback.");
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    };
    const binding: CustomerLocalHttpAuthorityTrustBinding = Object.freeze({
      ...body,
      adminPublicKey: admin.publicKey,
      activationReceipt,
      bindingDigest: digest(body),
      assertCurrent,
      withCurrentConsumption,
    });
    trustedBindings.add(binding);
    return binding;
  }

  recoveryContinuityRequirement(): { restoredAt: string } | null {
    if (!trustedStores.has(this)) throw new Error("Recovery continuity requires an exact trusted authority store.");
    const meta = this.assertPinnedIdentity();
    if (meta.recovery_continuity_required !== "true") return null;
    parseEpoch(meta.last_recovery_at!, "Authority recovery continuity");
    return { restoredAt: meta.last_recovery_at! };
  }

  auditActivations(): CustomerLocalHttpAuthorityTrustAuditEntry[] {
    this.validateEventChain();
    const heads = new Map((this.database.prepare("SELECT authority_contract_digest,activation_digest FROM authority_activation_heads").all() as Array<{ authority_contract_digest: string; activation_digest: string }>).map((row) => [row.authority_contract_digest, row.activation_digest]));
    return (this.database.prepare("SELECT * FROM authority_activations ORDER BY imported_at,activation_digest").all() as unknown as ActivationRow[]).map((row) => ({
      activationDigest: row.activation_digest,
      workspaceId: row.workspace_id,
      authorityContractDigest: row.authority_contract_digest,
      adminSignerKeyId: row.admin_signer_key_id,
      adminPublicKeyDigest: row.admin_public_key_digest,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      importedAt: row.imported_at,
      revokedAt: row.revoked_at,
      revocationDigest: row.revocation_digest,
      isCurrentHead: heads.get(row.authority_contract_digest) === row.activation_digest,
    }));
  }

  createSignedAuditBackup(input: {
    directory: string;
    signerKeyId: string;
    signerPrivateKey: KeyObject;
    expiresAt: string;
  }): { manifest: CustomerLocalHttpAuthorityTrustBackupManifest; signature: CustomerLocalHttpAuthorityTrustBackupSignature } {
    if (this.statePath === ":memory:") throw new Error("Workspace authority trust backup requires a durable source database.");
    if (existsSync(input.directory)) throw new Error("Workspace authority trust backup destination must be a fresh path.");
    this.validateEventChain();
    const createdAt = this.trustedNow(), created = parseEpoch(createdAt, "Authority trust backup creation"), expires = parseEpoch(input.expiresAt, "Authority trust backup expiry");
    if (expires <= created || expires - created > 7 * 24 * 60 * 60 * 1_000) throw new Error("Workspace authority trust backup validity must be positive and no longer than seven days.");
    if (input.signerPrivateKey.type !== "private" || input.signerPrivateKey.asymmetricKeyType !== "ed25519") throw new Error("Workspace authority trust backup requires an Ed25519 signing key.");
    const trusted = this.trustStore.assertTrusted(input.signerKeyId, createdAt, "workspace authority trust backup signing");
    if (trusted.state !== "active" || keyDigest(createPublicKey(input.signerPrivateKey)) !== trusted.publicKeyDigest) throw new Error("Workspace authority trust backup signer is not the exact active independently pinned key.");
    const sourceMeta = this.assertPinnedIdentity();
    mkdirSync(input.directory, { recursive: false, mode: 0o700 });
    const target = join(input.directory, "authority-trust.sqlite");
    try {
      this.database.exec(`VACUUM INTO ${quoteSqlitePath(target)}`);
      chmodSync(target, 0o600);
      const bytes = boundedFileSize(target, CUSTOMER_LOCAL_RESOURCE_LIMITS.databaseFileBytes, "Workspace authority trust backup database");
      const snapshot = new DatabaseSync(target, { readOnly: true });
      let snapshotMeta: Record<string, string>;
      try {
        const userVersion = (snapshot.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
        if (userVersion !== 1) throw new Error("Workspace authority trust backup database schema version is invalid.");
        snapshotMeta = Object.fromEntries((snapshot.prepare("SELECT key,value FROM authority_trust_meta").all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]));
      } finally {
        snapshot.close();
      }
      if (snapshotMeta.workspace_id !== this.workspaceId || snapshotMeta.tenant_id !== this.trustStore.config.tenantId || snapshotMeta.environment !== this.trustStore.config.environment
        || snapshotMeta.trust_configuration_digest !== this.trustConfigurationDigest || snapshotMeta.initial_admin_key_id !== sourceMeta.initial_admin_key_id
        || snapshotMeta.current_admin_key_id !== sourceMeta.current_admin_key_id || snapshotMeta.event_count !== sourceMeta.event_count
        || snapshotMeta.event_head_digest !== sourceMeta.event_head_digest || snapshotMeta.activation_mode !== sourceMeta.activation_mode
        || canonical(legacyLineageDescriptor(snapshotMeta)) !== canonical(legacyLineageDescriptor(sourceMeta))) {
        throw new Error("Workspace authority trust changed or crossed scope while its backup snapshot was created.");
      }
      const body = {
        schemaVersion: CUSTOMER_LOCAL_HTTP_AUTHORITY_TRUST_BACKUP_VERSION,
        kind: "customer-local-http-authority-trust-audit-backup" as const,
        workspaceId: this.workspaceId,
        tenantId: this.trustStore.config.tenantId,
        environment: this.trustStore.config.environment,
        trustConfigurationDigest: this.trustConfigurationDigest,
        initialAdminKeyId: sourceMeta.initial_admin_key_id!,
        currentAdminKeyId: sourceMeta.current_admin_key_id!,
        sourceActivationMode: sourceMeta.activation_mode as "live" | "audit-only-restored",
        createdAt,
        expiresAt: input.expiresAt,
        signerKeyId: trusted.keyId,
        signerPublicKeyDigest: trusted.publicKeyDigest,
        database: {
          path: "authority-trust.sqlite" as const,
          bytes,
          sha256: sha256BoundedFile(target, CUSTOMER_LOCAL_RESOURCE_LIMITS.databaseFileBytes, "Workspace authority trust backup database"),
          sqliteUserVersion: 1 as const,
          eventCount: Number(sourceMeta.event_count),
          eventHeadDigest: sourceMeta.event_head_digest!,
        },
        legacyLineage: legacyLineageDescriptor(sourceMeta),
        restoreMode: "audit-only-until-fresh-signed-activation" as const,
        executionAuthorityEffect: "none" as const,
        activationAuthorityEffect: "none" as const,
        rollbackProtection: "requires-external-monotonic-anchor" as const,
      };
      const manifest: CustomerLocalHttpAuthorityTrustBackupManifest = { ...body, manifestDigest: digest(body) };
      const signature: CustomerLocalHttpAuthorityTrustBackupSignature = {
        schemaVersion: "1.0",
        algorithm: "Ed25519",
        signerKeyId: trusted.keyId,
        signature: sign(null, Buffer.from(canonical(manifest)), input.signerPrivateKey).toString("base64"),
      };
      writeFileSync(join(input.directory, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      writeFileSync(join(input.directory, "manifest.sig"), JSON.stringify(signature), { mode: 0o600 });
      return { manifest, signature };
    } catch (error) {
      rmSync(input.directory, { recursive: true, force: true });
      throw error;
    }
  }

  markRestoredAuditOnly(input?: { sourceManifestDigest: string; sourceLegacyLineageDigest: string }): { auditOnly: true; restoredAt: string } {
    if (input && (!digestPattern.test(input.sourceManifestDigest) || !digestPattern.test(input.sourceLegacyLineageDigest))) throw new Error("Authority restore lineage requires exact signed manifest and legacy-lineage digests.");
    this.validateEventChain();
    const restoredAt = this.trustedNow();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE authority_trust_meta SET value='audit-only-restored' WHERE key='activation_mode'").run();
      this.database.prepare("UPDATE authority_trust_meta SET value=? WHERE key='audit_only_entered_at'").run(restoredAt);
      this.database.prepare("UPDATE authority_trust_meta SET value='true' WHERE key='recovery_continuity_required'").run();
      this.database.prepare("UPDATE authority_trust_meta SET value=? WHERE key='last_recovery_at'").run(restoredAt);
      if (input) {
        this.database.prepare("INSERT INTO authority_trust_meta(key,value) VALUES('last_audit_restore_manifest_digest',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(input.sourceManifestDigest);
        this.database.prepare("INSERT INTO authority_trust_meta(key,value) VALUES('last_audit_restore_legacy_lineage_digest',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(input.sourceLegacyLineageDigest);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { auditOnly: true, restoredAt };
  }

  close(): void {
    if (!this.closed) {
      this.database.close();
      this.closed = true;
    }
  }
}

export function restoreSignedCustomerLocalHttpAuthorityTrustBackup(input: {
  backupDirectory: string;
  destinationStatePath: string;
  trustStore: CustomerLocalTrustStore;
  expectedWorkspaceId: string;
  testOnly?: true;
  _testOnlyAfterCopy?: (temporaryStatePath: string) => void;
  _testOnlyBeforePublish?: (temporaryStatePath: string, destinationStatePath: string) => void;
}): {
  store: CustomerLocalHttpAuthorityTrustStore;
  manifestDigest: string;
  restoreReceiptDigest: string;
  restoredStateSha256: string;
  restoredAt: string;
  auditOnly: true;
  executionAuthority: false;
  activationAuthority: false;
  rollbackProtectionRequiresExternalMonotonicAnchor: true;
} {
  exactCustomerTrustStore(input.trustStore);
  if (input.trustStore.clockSource !== "system" && input.testOnly !== true) throw new Error("Production workspace authority trust restore cannot use a caller-controlled clock.");
  if (!identifier.test(input.expectedWorkspaceId)) throw new Error("Workspace authority trust restore requires an exact workspace identity.");
  if (existsSync(input.destinationStatePath) || existsSync(`${input.destinationStatePath}-wal`) || existsSync(`${input.destinationStatePath}-shm`)) throw new Error("Workspace authority trust restore destination must be fresh.");
  const expectedNames = ["authority-trust.sqlite", "manifest.json", "manifest.sig"];
  const actualNames = readdirSync(input.backupDirectory).sort();
  if (canonical(actualNames) !== canonical(expectedNames.sort())) throw new Error("Workspace authority trust backup has extra, missing, mixed, or torn files.");
  const manifest = JSON.parse(readBoundedFile(join(input.backupDirectory, "manifest.json"), CUSTOMER_LOCAL_RESOURCE_LIMITS.manifestBytes, "Workspace authority trust backup manifest").toString("utf8")) as CustomerLocalHttpAuthorityTrustBackupManifest;
  const detached = JSON.parse(readBoundedFile(join(input.backupDirectory, "manifest.sig"), 64_000, "Workspace authority trust backup signature").toString("utf8")) as CustomerLocalHttpAuthorityTrustBackupSignature;
  const now = input.trustStore.currentTime(), nowEpoch = parseEpoch(now, "Authority trust restore current time"), created = parseEpoch(manifest.createdAt, "Authority trust backup creation"), expires = parseEpoch(manifest.expiresAt, "Authority trust backup expiry");
  const { manifestDigest, ...manifestBody } = manifest;
  if (manifest.schemaVersion !== CUSTOMER_LOCAL_HTTP_AUTHORITY_TRUST_BACKUP_VERSION || manifest.kind !== "customer-local-http-authority-trust-audit-backup"
    || manifest.workspaceId !== input.expectedWorkspaceId || manifest.tenantId !== input.trustStore.config.tenantId || manifest.environment !== input.trustStore.config.environment
    || manifest.trustConfigurationDigest !== input.trustStore.configDigest || !identifier.test(manifest.initialAdminKeyId) || !identifier.test(manifest.currentAdminKeyId)
    || !["live", "audit-only-restored"].includes(manifest.sourceActivationMode) || manifest.database.path !== "authority-trust.sqlite" || basename(manifest.database.path) !== manifest.database.path
    || manifest.database.sqliteUserVersion !== 1 || !Number.isSafeInteger(manifest.database.eventCount) || manifest.database.eventCount < 0 || !digestPattern.test(manifest.database.sha256)
    || (manifest.database.eventHeadDigest !== "" && !digestPattern.test(manifest.database.eventHeadDigest)) || manifest.restoreMode !== "audit-only-until-fresh-signed-activation"
    || manifest.executionAuthorityEffect !== "none" || manifest.activationAuthorityEffect !== "none" || manifest.rollbackProtection !== "requires-external-monotonic-anchor"
    || detached.schemaVersion !== "1.0" || detached.algorithm !== "Ed25519" || detached.signerKeyId !== manifest.signerKeyId
    || manifestDigest !== digest(manifestBody) || created > nowEpoch || expires <= created || expires <= nowEpoch || expires - created > 7 * 24 * 60 * 60 * 1_000) {
    throw new Error("Workspace authority trust backup schema, scope, currentness, or non-authorizing boundary is invalid.");
  }
  if (!manifest.legacyLineage || typeof manifest.legacyLineage !== "object") throw new Error("Workspace authority trust backup is missing its signed legacy lineage descriptor.");
  const trusted = input.trustStore.assertTrusted(manifest.signerKeyId, now, "workspace authority trust backup restore");
  if (trusted.state !== "active" || trusted.publicKeyDigest !== manifest.signerPublicKeyDigest || !base64Pattern.test(detached.signature)
    || !verify(null, Buffer.from(canonical(manifest)), trusted.publicKey, Buffer.from(detached.signature, "base64"))) throw new Error("Workspace authority trust backup detached signature or independently pinned signer is invalid.");
  const source = join(input.backupDirectory, manifest.database.path);
  if (boundedFileSize(source, CUSTOMER_LOCAL_RESOURCE_LIMITS.databaseFileBytes, "Workspace authority trust backup database") !== manifest.database.bytes
    || sha256BoundedFile(source, CUSTOMER_LOCAL_RESOURCE_LIMITS.databaseFileBytes, "Workspace authority trust backup database") !== manifest.database.sha256) throw new Error("Workspace authority trust backup raw database identity changed after signing.");
  const temporaryStatePath = `${input.destinationStatePath}.restore-in-progress`;
  if (existsSync(temporaryStatePath)) throw new Error("Workspace authority trust restore temporary destination must be fresh.");
  mkdirSync(dirname(input.destinationStatePath), { recursive: true, mode: 0o700 });
  let staged: CustomerLocalHttpAuthorityTrustStore | undefined, restored: CustomerLocalHttpAuthorityTrustStore | undefined;
  try {
    copyFileSync(source, temporaryStatePath);
    chmodSync(temporaryStatePath, 0o600);
    input._testOnlyAfterCopy?.(temporaryStatePath);
    if (boundedFileSize(temporaryStatePath, CUSTOMER_LOCAL_RESOURCE_LIMITS.databaseFileBytes, "Restored workspace authority trust database") !== manifest.database.bytes
      || sha256BoundedFile(temporaryStatePath, CUSTOMER_LOCAL_RESOURCE_LIMITS.databaseFileBytes, "Restored workspace authority trust database") !== manifest.database.sha256) throw new Error("Workspace authority trust backup changed during restore.");
    const copied = new DatabaseSync(temporaryStatePath, { readOnly: true });
    try {
      const userVersion = (copied.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      const copiedMeta = Object.fromEntries((copied.prepare("SELECT key,value FROM authority_trust_meta").all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]));
      if (userVersion !== manifest.database.sqliteUserVersion || copiedMeta.workspace_id !== manifest.workspaceId || copiedMeta.tenant_id !== manifest.tenantId
        || copiedMeta.environment !== manifest.environment || copiedMeta.trust_configuration_digest !== manifest.trustConfigurationDigest
        || copiedMeta.initial_admin_key_id !== manifest.initialAdminKeyId || copiedMeta.current_admin_key_id !== manifest.currentAdminKeyId
        || copiedMeta.activation_mode !== manifest.sourceActivationMode || Number(copiedMeta.event_count) !== manifest.database.eventCount
        || copiedMeta.event_head_digest !== manifest.database.eventHeadDigest
        || canonical(legacyLineageDescriptor(copiedMeta)) !== canonical(manifest.legacyLineage)) throw new Error("Restored workspace authority trust semantic identity diverges from its signed manifest.");
    } finally {
      copied.close();
    }
    staged = new CustomerLocalHttpAuthorityTrustStore({
      statePath: temporaryStatePath,
      workspaceId: manifest.workspaceId,
      initialAdminKeyId: manifest.initialAdminKeyId,
      trustStore: input.trustStore,
      ...(input.testOnly ? { testOnly: true as const } : {}),
    });
    const audit = staged.auditActivations();
    const sourceLegacyLineageDigest = digest(manifest.legacyLineage);
    const restoredAuditState = staged.markRestoredAuditOnly({ sourceManifestDigest: manifestDigest, sourceLegacyLineageDigest });
    const auditAfter = staged.auditActivations();
    if (canonical(audit) !== canonical(auditAfter)) throw new Error("Workspace authority trust audit changed while restore entered its non-authorizing mode.");
    staged.close(); staged = undefined;
    const checkpoint = new DatabaseSync(temporaryStatePath);
    try {
      checkpoint.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      const journal = checkpoint.prepare("PRAGMA journal_mode=DELETE").get() as { journal_mode: string };
      if (journal.journal_mode.toLowerCase() !== "delete") throw new Error("Staged authority trust restore could not checkpoint into one atomic database file.");
      const mode = checkpoint.prepare("SELECT value FROM authority_trust_meta WHERE key='activation_mode'").get() as { value: string } | undefined;
      if (mode?.value !== "audit-only-restored") throw new Error("Staged authority trust restore did not durably enter audit-only mode.");
    } finally {
      checkpoint.close();
    }
    rmSync(`${temporaryStatePath}-wal`, { force: true });
    rmSync(`${temporaryStatePath}-shm`, { force: true });
    const restoredStateSha256 = sha256BoundedFile(temporaryStatePath, CUSTOMER_LOCAL_RESOURCE_LIMITS.databaseFileBytes, "Audit-only staged authority trust database");
    const restoreReceipt = {
      schemaVersion: "1.0" as const,
      kind: "customer-local-http-authority-trust-audit-restore" as const,
      manifestDigest,
      workspaceId: manifest.workspaceId,
      trustConfigurationDigest: manifest.trustConfigurationDigest,
      sourceLegacyLineageDigest,
      restoredAt: restoredAuditState.restoredAt,
      restoredStateSha256,
      activationMode: "audit-only-restored" as const,
      executionAuthority: false as const,
      activationAuthority: false as const,
      rollbackProtection: "requires-external-monotonic-anchor" as const,
    };
    const restoreReceiptDigest = digest(restoreReceipt);
    input._testOnlyBeforePublish?.(temporaryStatePath, input.destinationStatePath);
    if (existsSync(input.destinationStatePath) || sha256BoundedFile(temporaryStatePath, CUSTOMER_LOCAL_RESOURCE_LIMITS.databaseFileBytes, "Audit-only staged authority trust database") !== restoredStateSha256) throw new Error("Staged authority trust restore changed before atomic publication.");
    const finalStageCheck = new DatabaseSync(temporaryStatePath, { readOnly: true });
    try {
      const mode = finalStageCheck.prepare("SELECT value FROM authority_trust_meta WHERE key='activation_mode'").get() as { value: string } | undefined;
      if (mode?.value !== "audit-only-restored") throw new Error("Staged authority trust restore was reactivated before publication.");
    } finally {
      finalStageCheck.close();
    }
    renameSync(temporaryStatePath, input.destinationStatePath);
    restored = new CustomerLocalHttpAuthorityTrustStore({
      statePath: input.destinationStatePath,
      workspaceId: manifest.workspaceId,
      initialAdminKeyId: manifest.initialAdminKeyId,
      trustStore: input.trustStore,
      ...(input.testOnly ? { testOnly: true as const } : {}),
    });
    if (restored.auditActivations().length !== audit.length) throw new Error("Published audit-only authority trust changed after atomic publication.");
    return {
      store: restored,
      manifestDigest,
      restoreReceiptDigest,
      restoredStateSha256,
      restoredAt: restoredAuditState.restoredAt,
      auditOnly: true,
      executionAuthority: false,
      activationAuthority: false,
      rollbackProtectionRequiresExternalMonotonicAnchor: true,
    };
  } catch (error) {
    try { staged?.close(); } catch { /* preserve original restore failure */ }
    try { restored?.close(); } catch { /* preserve original restore failure */ }
    rmSync(temporaryStatePath, { force: true });
    rmSync(`${temporaryStatePath}-wal`, { force: true });
    rmSync(`${temporaryStatePath}-shm`, { force: true });
    rmSync(input.destinationStatePath, { force: true });
    rmSync(`${input.destinationStatePath}-wal`, { force: true });
    rmSync(`${input.destinationStatePath}-shm`, { force: true });
    throw error;
  }
}
