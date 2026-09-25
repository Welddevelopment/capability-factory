import { createHash, sign, verify, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CustomerLocalHttpAuthorityTrustStore } from "./customer-local-http-authority-trust.js";
import { assertTrustedCustomerLocalAuthorityContinuityGuard, type CustomerLocalAuthorityContinuityGuard } from "./customer-local-authority-continuity-guard.js";
import { CustomerLocalTrustStore } from "./customer-local-trust-backup.js";

export const LEGACY_HTTP_AUTHORITY_MIGRATION_VERSION = "1.0" as const;
const digestPattern = /^[a-f0-9]{64}$/;
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;

const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value !== null && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);
const digest = (value: unknown): string => createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
const quoteSqlitePath = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const epoch = (value: string, label: string): number => { const result = Date.parse(value); if (!Number.isFinite(result)) throw new Error(`${label} timestamp is invalid.`); return result; };

export interface LegacyHttpAuthorityContinuityAttestation {
  schemaVersion: "1.0";
  kind: "legacy-http-authority-continuity-attestation";
  classification: "independently-attested-never-recovered" | "externally-anchored-recovery";
  sourceStateDigest: string;
  tenantId: string;
  environment: string;
  workspaceId: string;
  trustConfigurationDigest: string;
  eventHeadDigest: string;
  eventCount: number;
  continuityGuardIdentityDigest: string | null;
  effectiveRecoveryAt: string | null;
  issuedAt: string;
  expiresAt: string;
  signerKeyId: string;
  statement: string;
  executionAuthorityEffect: "none";
  signature: string;
  receiptDigest: string;
}

type AttestationPayload = Omit<LegacyHttpAuthorityContinuityAttestation, "signature" | "receiptDigest">;

export function signLegacyHttpAuthorityContinuityAttestation(input: Omit<AttestationPayload, "schemaVersion" | "kind" | "executionAuthorityEffect"> & { privateKey: KeyObject }): LegacyHttpAuthorityContinuityAttestation {
  if (input.privateKey.type !== "private" || input.privateKey.asymmetricKeyType !== "ed25519") throw new Error("Legacy continuity attestation requires an Ed25519 private key.");
  const { privateKey, ...rest } = input;
  const payload: AttestationPayload = { schemaVersion: "1.0", kind: "legacy-http-authority-continuity-attestation", ...rest, executionAuthorityEffect: "none" };
  const signature = sign(null, Buffer.from(canonical(payload)), privateKey).toString("base64");
  return { ...payload, signature, receiptDigest: digest({ payload, signature }) };
}

export interface LegacyHttpAuthorityMigrationReceipt {
  schemaVersion: "1.0";
  kind: "legacy-http-authority-trust-migration";
  sourceStateDigest: string;
  migratedStatePathDigest: string;
  tenantId: string;
  environment: string;
  workspaceId: string;
  trustConfigurationDigest: string;
  classification: "never-recovered" | "anchored-recovery" | "ambiguous-audit-only";
  attestationReceiptDigest: string | null;
  continuityGuardIdentityDigest: string | null;
  activationMode: "audit-only-restored";
  recoveryContinuityRequired: boolean;
  freshActivationRequired: true;
  freshAuthorityStateRequired: true;
  existingLeaseAuthorityEffect: "none";
  executionAuthorityEffect: "none";
  migratedAt: string;
  receiptDigest: string;
}

interface LegacySnapshot {
  stateDigest: string;
  meta: Record<string, string>;
  eventHeadDigest: string;
  eventCount: number;
  authorityContractDigests: string[];
}

export interface LegacyHttpAuthorityMigrationInspection {
  schemaVersion: "1.0";
  sourceStateDigest: string;
  tenantId: string;
  environment: string;
  workspaceId: string;
  trustConfigurationDigest: string;
  initialAdminKeyId: string;
  currentAdminKeyId: string;
  eventHeadDigest: string;
  eventCount: number;
  authorityContractDigests: string[];
  classification: "legacy-history-unknown";
  executionAuthorityEffect: "none";
  inspectionDigest: string;
}

export interface AmbiguousLegacyHttpAuthorityReclassificationInspection {
  schemaVersion: "1.0";
  kind: "ambiguous-legacy-http-authority-reclassification-inspection";
  sourceStateDigest: string;
  initialMigrationReceiptDigest: string;
  migratedAuditStateDigest: string;
  tenantId: string;
  environment: string;
  workspaceId: string;
  trustConfigurationDigest: string;
  eventHeadDigest: string;
  eventCount: number;
  authorityContractDigests: string[];
  currentClassification: "ambiguous-audit-only";
  activationMode: "audit-only-restored";
  executionAuthorityEffect: "none";
  inspectionDigest: string;
}

export interface LegacyHttpAuthorityReclassificationAttestation {
  schemaVersion: "1.0";
  kind: "legacy-http-authority-reclassification-attestation";
  classification: "independently-attested-never-recovered" | "externally-anchored-recovery";
  sourceStateDigest: string;
  initialMigrationReceiptDigest: string;
  migratedAuditStateDigest: string;
  tenantId: string;
  environment: string;
  workspaceId: string;
  trustConfigurationDigest: string;
  eventHeadDigest: string;
  eventCount: number;
  continuityGuardIdentityDigest: string | null;
  effectiveRecoveryAt: string | null;
  issuedAt: string;
  expiresAt: string;
  signerKeyId: string;
  statement: string;
  activationAuthorityEffect: "none";
  executionAuthorityEffect: "none";
  signature: string;
  receiptDigest: string;
}

type ReclassificationAttestationPayload = Omit<LegacyHttpAuthorityReclassificationAttestation, "signature" | "receiptDigest">;

export interface LegacyHttpAuthorityReclassificationReceipt {
  schemaVersion: "1.0";
  kind: "legacy-http-authority-trust-reclassification";
  sourceStateDigest: string;
  initialMigrationReceiptDigest: string;
  migratedAuditStateDigest: string;
  tenantId: string;
  environment: string;
  workspaceId: string;
  trustConfigurationDigest: string;
  priorClassification: "ambiguous-audit-only";
  classification: "never-recovered" | "anchored-recovery";
  attestationReceiptDigest: string;
  continuityGuardIdentityDigest: string | null;
  preservedEventHeadDigest: string;
  preservedEventCount: number;
  activationMode: "audit-only-restored";
  recoveryContinuityRequired: boolean;
  freshActivationRequired: true;
  freshAuthorityStateRequired: true;
  existingLeaseAuthorityEffect: "none";
  executionAuthorityEffect: "none";
  reclassifiedAt: string;
  receiptDigest: string;
}

interface MigratedAuditSnapshot {
  stateDigest: string;
  meta: Record<string, string>;
  eventHeadDigest: string;
  eventCount: number;
  authorityContractDigests: string[];
}

function legacySnapshot(path: string): LegacySnapshot {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const tables = new Set((schema as Array<{ type: string; name: string }>).filter((item) => item.type === "table").map((item) => item.name));
    const expected = ["authority_trust_meta", "authority_admin_rotations", "authority_activations", "authority_activation_heads", "authority_trust_events"];
    if (expected.some((table) => !tables.has(table))) throw new Error("Legacy authority trust store is missing a required table.");
    const metaRows = database.prepare("SELECT key,value FROM authority_trust_meta ORDER BY key").all() as Array<{ key: string; value: string }>;
    const meta = Object.fromEntries(metaRows.map((row) => [row.key, row.value]));
    const hasRequired = Object.hasOwn(meta, "recovery_continuity_required"), hasRecoveryAt = Object.hasOwn(meta, "last_recovery_at");
    if (hasRequired !== hasRecoveryAt) throw new Error("Legacy authority continuity metadata is torn or partially migrated.");
    if (hasRequired) throw new Error("Authority trust store already has current continuity metadata and must not use legacy migration.");
    const rotations = database.prepare("SELECT * FROM authority_admin_rotations ORDER BY sequence").all();
    const activations = database.prepare("SELECT * FROM authority_activations ORDER BY activation_digest").all();
    const heads = database.prepare("SELECT * FROM authority_activation_heads ORDER BY authority_contract_digest").all() as Array<{ authority_contract_digest: string }>;
    const events = database.prepare("SELECT * FROM authority_trust_events ORDER BY sequence").all();
    const eventCount = Number(meta.event_count);
    if (!Number.isSafeInteger(eventCount) || eventCount < 0 || events.length !== eventCount || meta.event_head_digest === undefined) throw new Error("Legacy authority event count or head is invalid.");
    return { stateDigest: digest({ schema, metaRows, rotations, activations, heads, events }), meta, eventHeadDigest: meta.event_head_digest, eventCount, authorityContractDigests: [...new Set(heads.map((row) => row.authority_contract_digest))].sort() };
  } finally { database.close(); }
}

function migratedAuditSnapshotFromDatabase(database: DatabaseSync): MigratedAuditSnapshot {
  const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const metaRows = database.prepare("SELECT key,value FROM authority_trust_meta ORDER BY key").all() as Array<{ key: string; value: string }>;
  const meta = Object.fromEntries(metaRows.map((row) => [row.key, row.value]));
  const rotations = database.prepare("SELECT * FROM authority_admin_rotations ORDER BY sequence").all();
  const activations = database.prepare("SELECT * FROM authority_activations ORDER BY activation_digest").all();
  const heads = database.prepare("SELECT * FROM authority_activation_heads ORDER BY authority_contract_digest").all() as Array<{ authority_contract_digest: string }>;
  const events = database.prepare("SELECT * FROM authority_trust_events ORDER BY sequence").all();
  const eventCount = Number(meta.event_count);
  if (!Number.isSafeInteger(eventCount) || eventCount < 0 || events.length !== eventCount || meta.event_head_digest === undefined) throw new Error("Migrated authority event count or head is invalid.");
  return {
    stateDigest: digest({ schema, metaRows, rotations, activations, heads, events }),
    meta,
    eventHeadDigest: meta.event_head_digest,
    eventCount,
    authorityContractDigests: [...new Set(heads.map((row) => row.authority_contract_digest))].sort(),
  };
}

function migratedAuditSnapshot(path: string): MigratedAuditSnapshot {
  const database = new DatabaseSync(path, { readOnly: true });
  try { return migratedAuditSnapshotFromDatabase(database); }
  finally { database.close(); }
}

export function inspectAmbiguousLegacyCustomerLocalHttpAuthorityTrustStore(input: {
  statePath: string;
  workspaceId: string;
  initialAdminKeyId: string;
  trustStore: CustomerLocalTrustStore;
  testOnly?: true;
}): AmbiguousLegacyHttpAuthorityReclassificationInspection {
  if (Object.getPrototypeOf(input.trustStore) !== CustomerLocalTrustStore.prototype) throw new Error("Legacy authority reclassification inspection requires the exact customer-local trust store.");
  const store = new CustomerLocalHttpAuthorityTrustStore({ statePath: input.statePath, workspaceId: input.workspaceId, initialAdminKeyId: input.initialAdminKeyId, trustStore: input.trustStore, ...(input.testOnly ? { testOnly: true as const } : {}) });
  try {
    store.auditActivations();
    if (store.recoveryContinuityRequirement() === null) throw new Error("Legacy authority reclassification requires an ambiguous continuity requirement.");
  } finally { store.close(); }
  const snapshot = migratedAuditSnapshot(input.statePath), meta = snapshot.meta;
  if (meta.legacy_migration_state !== "ambiguous-audit-only" || meta.activation_mode !== "audit-only-restored"
    || !digestPattern.test(meta.legacy_source_state_digest ?? "") || !digestPattern.test(meta.legacy_migration_receipt_digest ?? "")
    || meta.recovery_continuity_required !== "true" || meta.legacy_reclassification_receipt_digest !== undefined) {
    throw new Error("Authority trust store is not an exact unreclassified ambiguous legacy migration.");
  }
  const body = {
    schemaVersion: "1.0" as const,
    kind: "ambiguous-legacy-http-authority-reclassification-inspection" as const,
    sourceStateDigest: meta.legacy_source_state_digest!,
    initialMigrationReceiptDigest: meta.legacy_migration_receipt_digest!,
    migratedAuditStateDigest: snapshot.stateDigest,
    tenantId: meta.tenant_id!, environment: meta.environment!, workspaceId: meta.workspace_id!, trustConfigurationDigest: meta.trust_configuration_digest!,
    eventHeadDigest: snapshot.eventHeadDigest, eventCount: snapshot.eventCount, authorityContractDigests: snapshot.authorityContractDigests,
    currentClassification: "ambiguous-audit-only" as const, activationMode: "audit-only-restored" as const, executionAuthorityEffect: "none" as const,
  };
  return { ...body, inspectionDigest: digest(body) };
}

export function signLegacyHttpAuthorityReclassificationAttestation(input: Omit<ReclassificationAttestationPayload, "schemaVersion" | "kind" | "activationAuthorityEffect" | "executionAuthorityEffect"> & { privateKey: KeyObject }): LegacyHttpAuthorityReclassificationAttestation {
  if (input.privateKey.type !== "private" || input.privateKey.asymmetricKeyType !== "ed25519") throw new Error("Legacy reclassification attestation requires an Ed25519 private key.");
  const { privateKey, ...rest } = input;
  const payload: ReclassificationAttestationPayload = {
    schemaVersion: "1.0", kind: "legacy-http-authority-reclassification-attestation", ...rest,
    activationAuthorityEffect: "none", executionAuthorityEffect: "none",
  };
  const signature = sign(null, Buffer.from(canonical(payload)), privateKey).toString("base64");
  return { ...payload, signature, receiptDigest: digest({ payload, signature }) };
}

export function inspectLegacyCustomerLocalHttpAuthorityTrustStore(path: string): LegacyHttpAuthorityMigrationInspection {
  const snapshot = legacySnapshot(path), meta = snapshot.meta;
  for (const key of ["tenant_id", "environment", "workspace_id", "trust_configuration_digest", "initial_admin_key_id", "current_admin_key_id"]) if (!meta[key]) throw new Error(`Legacy authority trust store is missing ${key}.`);
  const body = {
    schemaVersion: "1.0" as const, sourceStateDigest: snapshot.stateDigest,
    tenantId: meta.tenant_id!, environment: meta.environment!, workspaceId: meta.workspace_id!, trustConfigurationDigest: meta.trust_configuration_digest!,
    initialAdminKeyId: meta.initial_admin_key_id!, currentAdminKeyId: meta.current_admin_key_id!, eventHeadDigest: snapshot.eventHeadDigest,
    eventCount: snapshot.eventCount, authorityContractDigests: snapshot.authorityContractDigests,
    classification: "legacy-history-unknown" as const, executionAuthorityEffect: "none" as const,
  };
  return { ...body, inspectionDigest: digest(body) };
}

function verifyAttestation(input: { attestation: LegacyHttpAuthorityContinuityAttestation; snapshot: LegacySnapshot; trustStore: CustomerLocalTrustStore; now: string; continuityGuard?: CustomerLocalAuthorityContinuityGuard }): "never-recovered" | "anchored-recovery" {
  const { signature, receiptDigest, ...payload } = input.attestation;
  const meta = input.snapshot.meta;
  if (input.attestation.schemaVersion !== "1.0" || input.attestation.kind !== "legacy-http-authority-continuity-attestation" || input.attestation.executionAuthorityEffect !== "none" || !digestPattern.test(receiptDigest) || receiptDigest !== digest({ payload, signature }) || !base64Pattern.test(signature) || !input.attestation.statement.trim() || input.attestation.statement.length > 1_000 || input.attestation.sourceStateDigest !== input.snapshot.stateDigest || input.attestation.tenantId !== meta.tenant_id || input.attestation.environment !== meta.environment || input.attestation.workspaceId !== meta.workspace_id || input.attestation.trustConfigurationDigest !== meta.trust_configuration_digest || input.attestation.eventHeadDigest !== input.snapshot.eventHeadDigest || input.attestation.eventCount !== input.snapshot.eventCount) throw new Error("Legacy continuity attestation is stale, cross-store, malformed, or substituted.");
  const issued = epoch(input.attestation.issuedAt, "Legacy attestation issue"), expires = epoch(input.attestation.expiresAt, "Legacy attestation expiry"), current = epoch(input.now, "Legacy migration currentness");
  if (issued > current || expires <= current || expires <= issued || expires - issued > 24 * 60 * 60 * 1_000) throw new Error("Legacy continuity attestation is future-issued, expired, or overlong.");
  const trusted = input.trustStore.assertTrusted(input.attestation.signerKeyId, input.attestation.issuedAt, "legacy authority continuity attestation");
  const currentTrusted = input.trustStore.assertTrusted(input.attestation.signerKeyId, input.now, "legacy authority continuity attestation currentness");
  if (trusted.state !== "active" || currentTrusted.state !== "active" || trusted.publicKeyDigest !== currentTrusted.publicKeyDigest || !verify(null, Buffer.from(canonical(payload)), trusted.publicKey, Buffer.from(signature, "base64"))) throw new Error("Legacy continuity attestation is not signed by the current pinned trusted assessor.");
  if (input.attestation.classification === "independently-attested-never-recovered") {
    if (input.attestation.continuityGuardIdentityDigest !== null || input.attestation.effectiveRecoveryAt !== null || input.continuityGuard) throw new Error("Never-recovered attestation cannot carry recovery lineage.");
    return "never-recovered";
  }
  if (input.attestation.classification !== "externally-anchored-recovery" || !input.continuityGuard || input.attestation.continuityGuardIdentityDigest !== input.continuityGuard.identityDigest || input.attestation.effectiveRecoveryAt === null) throw new Error("Anchored legacy recovery requires the exact current trusted continuity guard and recovery time.");
  assertTrustedCustomerLocalAuthorityContinuityGuard(input.continuityGuard);
  epoch(input.attestation.effectiveRecoveryAt, "Legacy effective recovery");
  if (input.continuityGuard.tenantId !== meta.tenant_id || input.continuityGuard.workspaceId !== meta.workspace_id || input.continuityGuard.trustConfigurationDigest !== meta.trust_configuration_digest || input.snapshot.authorityContractDigests.length !== 1 || input.snapshot.authorityContractDigests[0] !== input.continuityGuard.authorityContractDigest) throw new Error("Anchored continuity guard does not cover the exact legacy trust-store scope.");
  return "anchored-recovery";
}

export function migrateLegacyCustomerLocalHttpAuthorityTrustStore(input: {
  sourcePath: string;
  destinationPath: string;
  workspaceId: string;
  initialAdminKeyId: string;
  trustStore: CustomerLocalTrustStore;
  attestation?: LegacyHttpAuthorityContinuityAttestation;
  continuityGuard?: CustomerLocalAuthorityContinuityGuard;
  testOnly?: true;
}): LegacyHttpAuthorityMigrationReceipt {
  if (Object.getPrototypeOf(input.trustStore) !== CustomerLocalTrustStore.prototype) throw new Error("Legacy authority migration requires the exact customer-local trust store.");
  if (input.sourcePath === input.destinationPath || existsSync(input.destinationPath) || basename(input.destinationPath) !== input.destinationPath.split("/").at(-1)) throw new Error("Legacy authority migration requires a distinct fresh destination path.");
  const snapshot = legacySnapshot(input.sourcePath), now = input.trustStore.currentTime(), meta = snapshot.meta;
  if (meta.workspace_id !== input.workspaceId || meta.initial_admin_key_id !== input.initialAdminKeyId || meta.tenant_id !== input.trustStore.config.tenantId || meta.environment !== input.trustStore.config.environment || meta.trust_configuration_digest !== input.trustStore.configDigest) throw new Error("Legacy authority migration scope differs from the pinned customer-local trust store.");
  const classification: LegacyHttpAuthorityMigrationReceipt["classification"] = input.attestation ? verifyAttestation({ attestation: input.attestation, snapshot, trustStore: input.trustStore, now, ...(input.continuityGuard ? { continuityGuard: input.continuityGuard } : {}) }) : "ambiguous-audit-only";
  if (!input.attestation && input.continuityGuard) throw new Error("A continuity guard cannot classify legacy history without a signed exact-store attestation.");
  const body = {
    schemaVersion: "1.0" as const, kind: "legacy-http-authority-trust-migration" as const,
    sourceStateDigest: snapshot.stateDigest, migratedStatePathDigest: digest(input.destinationPath),
    tenantId: meta.tenant_id!, environment: meta.environment!, workspaceId: meta.workspace_id!, trustConfigurationDigest: meta.trust_configuration_digest!,
    classification, attestationReceiptDigest: input.attestation?.receiptDigest ?? null,
    continuityGuardIdentityDigest: classification === "anchored-recovery" ? input.continuityGuard!.identityDigest : null,
    activationMode: "audit-only-restored" as const, recoveryContinuityRequired: classification !== "never-recovered",
    freshActivationRequired: true as const, freshAuthorityStateRequired: true as const,
    existingLeaseAuthorityEffect: "none" as const, executionAuthorityEffect: "none" as const, migratedAt: now,
  };
  const receipt: LegacyHttpAuthorityMigrationReceipt = { ...body, receiptDigest: digest(body) };
  const stagingDirectory = join(dirname(input.destinationPath), `.${basename(input.destinationPath)}.migration-${receipt.receiptDigest.slice(0, 12)}`), stagingPath = join(stagingDirectory, "staging.sqlite");
  if (existsSync(stagingDirectory)) throw new Error("Legacy authority migration staging path already exists.");
  mkdirSync(stagingDirectory, { recursive: false, mode: 0o700 });
  try {
    const source = new DatabaseSync(input.sourcePath, { readOnly: true });
    try { source.exec(`VACUUM INTO ${quoteSqlitePath(stagingPath)}`); } finally { source.close(); }
    chmodSync(stagingPath, 0o600);
    if (legacySnapshot(stagingPath).stateDigest !== snapshot.stateDigest) throw new Error("Legacy authority source changed between inspection and the migration snapshot.");
    const stage = new DatabaseSync(stagingPath);
    try {
      stage.exec("BEGIN IMMEDIATE");
      const insert = stage.prepare("INSERT INTO authority_trust_meta(key,value) VALUES(?,?)");
      insert.run("recovery_continuity_required", receipt.recoveryContinuityRequired ? "true" : "false");
      insert.run("last_recovery_at", classification === "anchored-recovery" ? input.attestation!.effectiveRecoveryAt! : classification === "ambiguous-audit-only" ? now : "");
      insert.run("legacy_migration_state", classification);
      insert.run("legacy_migration_receipt_digest", receipt.receiptDigest);
      insert.run("legacy_source_state_digest", snapshot.stateDigest);
      stage.prepare("UPDATE authority_trust_meta SET value='audit-only-restored' WHERE key='activation_mode'").run();
      stage.prepare("UPDATE authority_trust_meta SET value=? WHERE key='audit_only_entered_at'").run(now);
      stage.exec("COMMIT");
    } catch (error) { try { stage.exec("ROLLBACK"); } catch { /* no active transaction */ } throw error; }
    finally { stage.close(); }
    const staged = new CustomerLocalHttpAuthorityTrustStore({ statePath: stagingPath, workspaceId: input.workspaceId, initialAdminKeyId: input.initialAdminKeyId, trustStore: input.trustStore, ...(input.testOnly ? { testOnly: true as const } : {}) });
    try {
      staged.auditActivations();
      const requiresContinuity = staged.recoveryContinuityRequirement() !== null;
      if (requiresContinuity !== receipt.recoveryContinuityRequired) throw new Error("Migrated recovery classification diverged from its receipt.");
    }
    finally { staged.close(); }
    const publisher = new DatabaseSync(stagingPath, { readOnly: true });
    try { publisher.exec(`VACUUM INTO ${quoteSqlitePath(input.destinationPath)}`); } finally { publisher.close(); }
    chmodSync(input.destinationPath, 0o600);
    const published = new CustomerLocalHttpAuthorityTrustStore({ statePath: input.destinationPath, workspaceId: input.workspaceId, initialAdminKeyId: input.initialAdminKeyId, trustStore: input.trustStore, ...(input.testOnly ? { testOnly: true as const } : {}) });
    try { published.auditActivations(); }
    finally { published.close(); }
    return receipt;
  } catch (error) {
    rmSync(input.destinationPath, { force: true });
    throw error;
  } finally { rmSync(stagingDirectory, { recursive: true, force: true }); }
}

export function reclassifyAmbiguousLegacyCustomerLocalHttpAuthorityTrustStore(input: {
  statePath: string;
  workspaceId: string;
  initialAdminKeyId: string;
  trustStore: CustomerLocalTrustStore;
  attestation: LegacyHttpAuthorityReclassificationAttestation;
  continuityGuard?: CustomerLocalAuthorityContinuityGuard;
  testOnly?: true;
}): LegacyHttpAuthorityReclassificationReceipt {
  if (Object.getPrototypeOf(input.trustStore) !== CustomerLocalTrustStore.prototype) throw new Error("Legacy authority reclassification requires the exact customer-local trust store.");
  const inspection = inspectAmbiguousLegacyCustomerLocalHttpAuthorityTrustStore({ statePath: input.statePath, workspaceId: input.workspaceId, initialAdminKeyId: input.initialAdminKeyId, trustStore: input.trustStore, ...(input.testOnly ? { testOnly: true as const } : {}) });
  const now = input.trustStore.currentTime(), { signature, receiptDigest, ...payload } = input.attestation;
  if (input.attestation.schemaVersion !== "1.0" || input.attestation.kind !== "legacy-http-authority-reclassification-attestation"
    || input.attestation.activationAuthorityEffect !== "none" || input.attestation.executionAuthorityEffect !== "none"
    || !digestPattern.test(receiptDigest) || receiptDigest !== digest({ payload, signature }) || !base64Pattern.test(signature)
    || !input.attestation.statement.trim() || input.attestation.statement.length > 1_000
    || input.attestation.sourceStateDigest !== inspection.sourceStateDigest
    || input.attestation.initialMigrationReceiptDigest !== inspection.initialMigrationReceiptDigest
    || input.attestation.migratedAuditStateDigest !== inspection.migratedAuditStateDigest
    || input.attestation.tenantId !== inspection.tenantId || input.attestation.environment !== inspection.environment
    || input.attestation.workspaceId !== inspection.workspaceId || input.attestation.trustConfigurationDigest !== inspection.trustConfigurationDigest
    || input.attestation.eventHeadDigest !== inspection.eventHeadDigest || input.attestation.eventCount !== inspection.eventCount) {
    throw new Error("Legacy reclassification attestation is stale, cross-store, malformed, or substituted.");
  }
  const issued = epoch(input.attestation.issuedAt, "Legacy reclassification issue"), expires = epoch(input.attestation.expiresAt, "Legacy reclassification expiry"), current = epoch(now, "Legacy reclassification currentness");
  if (issued > current || expires <= current || expires <= issued || expires - issued > 24 * 60 * 60 * 1_000) throw new Error("Legacy reclassification attestation is future-issued, expired, or overlong.");
  const trustedAtIssue = input.trustStore.assertTrusted(input.attestation.signerKeyId, input.attestation.issuedAt, "legacy authority reclassification attestation");
  const trustedNow = input.trustStore.assertTrusted(input.attestation.signerKeyId, now, "legacy authority reclassification currentness");
  if (trustedAtIssue.state !== "active" || trustedNow.state !== "active" || trustedAtIssue.publicKeyDigest !== trustedNow.publicKeyDigest
    || !verify(null, Buffer.from(canonical(payload)), trustedNow.publicKey, Buffer.from(signature, "base64"))) {
    throw new Error("Legacy reclassification attestation is not signed by the current pinned trusted assessor.");
  }
  let classification: LegacyHttpAuthorityReclassificationReceipt["classification"];
  let guardIdentity: string | null = null;
  let effectiveRecoveryAt = "";
  if (input.attestation.classification === "independently-attested-never-recovered") {
    if (input.attestation.continuityGuardIdentityDigest !== null || input.attestation.effectiveRecoveryAt !== null || input.continuityGuard) throw new Error("Never-recovered reclassification cannot carry recovery lineage.");
    classification = "never-recovered";
  } else {
    if (input.attestation.classification !== "externally-anchored-recovery" || !input.continuityGuard
      || input.attestation.continuityGuardIdentityDigest !== input.continuityGuard.identityDigest || input.attestation.effectiveRecoveryAt === null) {
      throw new Error("Anchored legacy reclassification requires the exact current trusted continuity guard and recovery time.");
    }
    assertTrustedCustomerLocalAuthorityContinuityGuard(input.continuityGuard);
    effectiveRecoveryAt = input.attestation.effectiveRecoveryAt;
    const effectiveRecoveryEpoch = epoch(effectiveRecoveryAt, "Legacy reclassification effective recovery");
    if (effectiveRecoveryEpoch > issued || effectiveRecoveryEpoch > current) throw new Error("Legacy reclassification recovery cannot occur after its independent attestation or current time.");
    if (input.continuityGuard.tenantId !== inspection.tenantId || input.continuityGuard.workspaceId !== inspection.workspaceId
      || input.continuityGuard.trustConfigurationDigest !== inspection.trustConfigurationDigest
      || inspection.authorityContractDigests.length !== 1 || inspection.authorityContractDigests[0] !== input.continuityGuard.authorityContractDigest) {
      throw new Error("Anchored reclassification guard does not cover the exact migrated trust-store scope.");
    }
    classification = "anchored-recovery";
    guardIdentity = input.continuityGuard.identityDigest;
  }
  const body = {
    schemaVersion: "1.0" as const, kind: "legacy-http-authority-trust-reclassification" as const,
    sourceStateDigest: inspection.sourceStateDigest, initialMigrationReceiptDigest: inspection.initialMigrationReceiptDigest,
    migratedAuditStateDigest: inspection.migratedAuditStateDigest, tenantId: inspection.tenantId, environment: inspection.environment,
    workspaceId: inspection.workspaceId, trustConfigurationDigest: inspection.trustConfigurationDigest,
    priorClassification: "ambiguous-audit-only" as const, classification, attestationReceiptDigest: input.attestation.receiptDigest,
    continuityGuardIdentityDigest: guardIdentity, preservedEventHeadDigest: inspection.eventHeadDigest, preservedEventCount: inspection.eventCount,
    activationMode: "audit-only-restored" as const, recoveryContinuityRequired: classification === "anchored-recovery",
    freshActivationRequired: true as const, freshAuthorityStateRequired: true as const,
    existingLeaseAuthorityEffect: "none" as const, executionAuthorityEffect: "none" as const, reclassifiedAt: now,
  };
  const receipt: LegacyHttpAuthorityReclassificationReceipt = { ...body, receiptDigest: digest(body) };
  const applySerialized = () => {
    const database = new DatabaseSync(input.statePath);
    try {
      database.exec("BEGIN IMMEDIATE");
      const serialized = migratedAuditSnapshotFromDatabase(database), meta = serialized.meta;
      if (serialized.stateDigest !== inspection.migratedAuditStateDigest || meta.legacy_migration_state !== "ambiguous-audit-only"
        || meta.legacy_migration_receipt_digest !== inspection.initialMigrationReceiptDigest || meta.legacy_source_state_digest !== inspection.sourceStateDigest
        || meta.activation_mode !== "audit-only-restored" || meta.recovery_continuity_required !== "true"
        || serialized.eventHeadDigest !== inspection.eventHeadDigest || serialized.eventCount !== inspection.eventCount) {
        throw new Error("Ambiguous migrated authority state changed before serialized reclassification.");
      }
      database.exec(`CREATE TABLE authority_legacy_reclassifications(
        receipt_digest TEXT PRIMARY KEY,
        receipt_json TEXT NOT NULL,
        attestation_json TEXT NOT NULL,
        reclassified_at TEXT NOT NULL
      )`);
      const addMeta = database.prepare("INSERT INTO authority_trust_meta(key,value) VALUES(?,?)");
      addMeta.run("legacy_reclassification_receipt_digest", receipt.receiptDigest);
      addMeta.run("legacy_reclassification_attestation_digest", input.attestation.receiptDigest);
      addMeta.run("legacy_reclassification_prestate_digest", inspection.migratedAuditStateDigest);
      addMeta.run("legacy_reclassification_guard_identity_digest", guardIdentity ?? "");
      addMeta.run("legacy_reclassified_at", now);
      database.prepare("UPDATE authority_trust_meta SET value=? WHERE key='legacy_migration_state'").run(classification);
      database.prepare("UPDATE authority_trust_meta SET value=? WHERE key='recovery_continuity_required'").run(receipt.recoveryContinuityRequired ? "true" : "false");
      database.prepare("UPDATE authority_trust_meta SET value=? WHERE key='last_recovery_at'").run(classification === "anchored-recovery" ? effectiveRecoveryAt : "");
      database.prepare("INSERT INTO authority_legacy_reclassifications(receipt_digest,receipt_json,attestation_json,reclassified_at) VALUES(?,?,?,?)")
        .run(receipt.receiptDigest, JSON.stringify(receipt), JSON.stringify(input.attestation), now);
      const finalMeta = Object.fromEntries((database.prepare("SELECT key,value FROM authority_trust_meta").all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]));
      const finalRow = database.prepare("SELECT receipt_digest,receipt_json,attestation_json,reclassified_at FROM authority_legacy_reclassifications").get() as { receipt_digest: string; receipt_json: string; attestation_json: string; reclassified_at: string } | undefined;
      if (finalMeta.activation_mode !== "audit-only-restored" || finalMeta.legacy_migration_state !== classification
        || finalMeta.legacy_reclassification_receipt_digest !== receipt.receiptDigest || finalMeta.legacy_reclassification_attestation_digest !== input.attestation.receiptDigest
        || finalMeta.legacy_reclassification_prestate_digest !== inspection.migratedAuditStateDigest || finalMeta.event_head_digest !== inspection.eventHeadDigest
        || Number(finalMeta.event_count) !== inspection.eventCount || !finalRow || finalRow.receipt_digest !== receipt.receiptDigest
        || finalRow.receipt_json !== JSON.stringify(receipt) || finalRow.attestation_json !== JSON.stringify(input.attestation) || finalRow.reclassified_at !== now) {
        throw new Error("Serialized legacy reclassification did not preserve its exact audit-only lineage.");
      }
      const currentAssessor = input.trustStore.assertTrusted(input.attestation.signerKeyId, input.trustStore.currentTime(), "legacy authority reclassification commit currentness");
      if (currentAssessor.state !== "active" || currentAssessor.publicKeyDigest !== trustedNow.publicKeyDigest) throw new Error("Legacy reclassification assessor trust changed before serialized commit.");
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    } finally { database.close(); }
  };
  if (classification === "anchored-recovery") input.continuityGuard!.withCurrentConsumption(applySerialized);
  else applySerialized();
  return receipt;
}
