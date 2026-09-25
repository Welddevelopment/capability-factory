import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectAmbiguousLegacyCustomerLocalHttpAuthorityTrustStore,
  inspectLegacyCustomerLocalHttpAuthorityTrustStore,
  migrateLegacyCustomerLocalHttpAuthorityTrustStore,
  reclassifyAmbiguousLegacyCustomerLocalHttpAuthorityTrustStore,
  signLegacyHttpAuthorityContinuityAttestation,
  signLegacyHttpAuthorityReclassificationAttestation,
} from "../src/product/customer-local-http-authority-legacy-migration.js";
import { CustomerLocalHttpAuthorityTrustStore, restoreSignedCustomerLocalHttpAuthorityTrustBackup } from "../src/product/customer-local-http-authority-trust.js";
import { createCustomerLocalAuthorityContinuityGuard } from "../src/product/customer-local-authority-continuity-guard.js";
import { DurableExternalMonotonicContinuityAnchor, type ExternalMonotonicContinuityAnchorConfiguration } from "../src/product/external-monotonic-continuity-anchor.js";
import { CustomerLocalTrustStore, createRotationReceipt, type CustomerLocalTrustConfiguration } from "../src/product/customer-local-trust-backup.js";
import { signWorkspaceHttpAuthorityActivation } from "../src/product/customer-local-http-write-authority.js";

const roots: string[] = [], closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0).reverse()) { try { close(); } catch { /* already closed */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value !== null && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);
const objectDigest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const pem = (key: ReturnType<typeof generateKeyPairSync>["publicKey"]): string => key.export({ type: "spki", format: "pem" }).toString();
const publicDigest = (key: ReturnType<typeof generateKeyPairSync>["publicKey"]): string => createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");

async function runCf076Worker(inputPath: string): Promise<{ status: "fulfilled" | "rejected"; receiptDigest?: string; message?: string }> {
  const worker = join(process.cwd(), "test/fixtures/cf076-authority-reclassification-worker.ts"), tsx = join(process.cwd(), "node_modules/tsx/dist/loader.mjs"), child = spawn(process.execPath, ["--import", tsx, worker, inputPath]);
  return await new Promise((resolvePromise, rejectPromise) => {
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", rejectPromise);
    child.once("exit", (code) => code === 0 ? resolvePromise(stdout ? JSON.parse(stdout) : { status: "fulfilled" }) : rejectPromise(new Error(`CF-076 worker failed: ${stderr}`)));
  });
}

function fixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `cf068-${label}-`)); roots.push(root);
  const clock = { value: Date.parse("2026-08-14T12:00:00.000Z") }, admin = generateKeyPairSync("ed25519"), nextAdmin = generateKeyPairSync("ed25519"), assessor = generateKeyPairSync("ed25519"), authorityContractDigest = sha(`authority:${label}`);
  const config: CustomerLocalTrustConfiguration = {
    schemaVersion: "1.0", tenantId: "tenant_cf068", environment: "local",
    keys: [
      { keyId: "workspace_admin_v1", issuer: "customer_admin", publicKeyPem: pem(admin.publicKey), notBefore: new Date(clock.value - 60_000).toISOString(), notAfter: new Date(clock.value + 86_400_000).toISOString() },
      { keyId: "continuity_assessor_v1", issuer: "independent_continuity_assessor", publicKeyPem: pem(assessor.publicKey), notBefore: new Date(clock.value - 60_000).toISOString(), notAfter: new Date(clock.value + 86_400_000).toISOString() },
    ],
  };
  const trustStore = new CustomerLocalTrustStore(join(root, "trust.sqlite"), config, () => new Date(clock.value).toISOString()); closers.push(() => trustStore.close());
  const sourcePath = join(root, "authority-trust-legacy.sqlite");
  const authority = new CustomerLocalHttpAuthorityTrustStore({ statePath: sourcePath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore, testOnly: true });
  const activation = (nonce: string) => signWorkspaceHttpAuthorityActivation({ adminSignerKeyId: "workspace_admin_v1", workspaceId: "workspace_cf068", authorityContractDigest, privateKey: admin.privateKey, issuedAt: new Date(clock.value - 1).toISOString(), expiresAt: new Date(clock.value + 60_000).toISOString(), activationNonce: nonce.repeat(48) });
  authority.importActivation(activation("a")); authority.close();
  const database = new DatabaseSync(sourcePath);
  database.prepare("DELETE FROM authority_trust_meta WHERE key IN ('recovery_continuity_required','last_recovery_at')").run(); database.close();
  const inspect = () => inspectLegacyCustomerLocalHttpAuthorityTrustStore(sourcePath);
  const attest = (classification: "independently-attested-never-recovered" | "externally-anchored-recovery", guardDigest: string | null = null, recoveryAt: string | null = null) => {
    const inspection = inspect();
    return signLegacyHttpAuthorityContinuityAttestation({
      classification, sourceStateDigest: inspection.sourceStateDigest, tenantId: inspection.tenantId, environment: inspection.environment,
      workspaceId: inspection.workspaceId, trustConfigurationDigest: inspection.trustConfigurationDigest,
      eventHeadDigest: inspection.eventHeadDigest, eventCount: inspection.eventCount, continuityGuardIdentityDigest: guardDigest,
      effectiveRecoveryAt: recoveryAt, issuedAt: new Date(clock.value).toISOString(), expiresAt: new Date(clock.value + 60_000).toISOString(),
      signerKeyId: "continuity_assessor_v1", statement: classification === "independently-attested-never-recovered" ? "Independent records show this exact state was never restored." : "Independent records bind this exact state to the current external recovery lineage.",
      privateKey: assessor.privateKey,
    });
  };
  const inspectAmbiguous = (statePath: string) => inspectAmbiguousLegacyCustomerLocalHttpAuthorityTrustStore({ statePath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore, testOnly: true });
  const attestReclassification = (statePath: string, classification: "independently-attested-never-recovered" | "externally-anchored-recovery", guardDigest: string | null = null, recoveryAt: string | null = null) => {
    const inspection = inspectAmbiguous(statePath);
    return signLegacyHttpAuthorityReclassificationAttestation({
      classification, sourceStateDigest: inspection.sourceStateDigest, initialMigrationReceiptDigest: inspection.initialMigrationReceiptDigest,
      migratedAuditStateDigest: inspection.migratedAuditStateDigest, tenantId: inspection.tenantId, environment: inspection.environment,
      workspaceId: inspection.workspaceId, trustConfigurationDigest: inspection.trustConfigurationDigest,
      eventHeadDigest: inspection.eventHeadDigest, eventCount: inspection.eventCount, continuityGuardIdentityDigest: guardDigest,
      effectiveRecoveryAt: recoveryAt, issuedAt: new Date(clock.value).toISOString(), expiresAt: new Date(clock.value + 60_000).toISOString(),
      signerKeyId: "continuity_assessor_v1", statement: classification === "independently-attested-never-recovered" ? "Current independent records bind this exact migrated audit state and show that it was never recovered." : "Current independent records bind this exact migrated audit state to the supplied external recovery lineage.",
      privateKey: assessor.privateKey,
    });
  };
  return { root, clock, admin, nextAdmin, assessor, trustStore, sourcePath, authorityContractDigest, activation, inspect, attest, inspectAmbiguous, attestReclassification };
}

describe("CF-068 legacy authority continuity migration", () => {
  it("copies an independently attested never-recovered store into audit-only mode and requires a fresh activation", () => {
    const f = fixture("never"), inspection = f.inspect();
    expect(inspection).toMatchObject({ classification: "legacy-history-unknown", eventCount: 1, authorityContractDigests: [f.authorityContractDigest], executionAuthorityEffect: "none" });
    const destinationPath = join(f.root, "migrated-never.sqlite"), receipt = migrateLegacyCustomerLocalHttpAuthorityTrustStore({ sourcePath: f.sourcePath, destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, attestation: f.attest("independently-attested-never-recovered"), testOnly: true });
    expect(receipt).toMatchObject({ classification: "never-recovered", activationMode: "audit-only-restored", recoveryContinuityRequired: false, freshActivationRequired: true, freshAuthorityStateRequired: true, existingLeaseAuthorityEffect: "none", executionAuthorityEffect: "none" });
    expect(f.inspect().sourceStateDigest).toBe(inspection.sourceStateDigest);
    const migrated = new CustomerLocalHttpAuthorityTrustStore({ statePath: destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, testOnly: true }); closers.push(() => migrated.close());
    expect(migrated.auditActivations()).toHaveLength(1);
    expect(migrated.recoveryContinuityRequirement()).toBeNull();
    expect(() => migrated.resolveCurrent(f.authorityContractDigest)).toThrow(/audit-only/i);
    f.clock.value += 2;
    migrated.importActivation(f.activation("b"));
    expect(migrated.resolveCurrent(f.authorityContractDigest).authorityContractDigest).toBe(f.authorityContractDigest);
  });

  it("keeps unknown legacy history permanently audit-only until exact reclassification evidence exists", () => {
    const f = fixture("ambiguous"), destinationPath = join(f.root, "migrated-ambiguous.sqlite");
    const receipt = migrateLegacyCustomerLocalHttpAuthorityTrustStore({ sourcePath: f.sourcePath, destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, testOnly: true });
    expect(receipt).toMatchObject({ classification: "ambiguous-audit-only", recoveryContinuityRequired: true });
    const migrated = new CustomerLocalHttpAuthorityTrustStore({ statePath: destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, testOnly: true }); closers.push(() => migrated.close());
    expect(migrated.recoveryContinuityRequirement()).not.toBeNull();
    f.clock.value += 2;
    expect(() => migrated.importActivation(f.activation("c"))).toThrow(/ambiguous legacy recovery history/i);
    expect(() => migrated.resolveCurrent(f.authorityContractDigest)).toThrow(/audit-only/i);
  });

  it("reclassifies an exact ambiguous audit store as never recovered without changing history or activating authority", () => {
    const f = fixture("reclass-never"), destinationPath = join(f.root, "migrated-ambiguous.sqlite");
    const migration = migrateLegacyCustomerLocalHttpAuthorityTrustStore({ sourcePath: f.sourcePath, destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, testOnly: true });
    const inspection = f.inspectAmbiguous(destinationPath), attestation = f.attestReclassification(destinationPath, "independently-attested-never-recovered");
    expect(inspection).toMatchObject({ sourceStateDigest: migration.sourceStateDigest, initialMigrationReceiptDigest: migration.receiptDigest, currentClassification: "ambiguous-audit-only", activationMode: "audit-only-restored", eventCount: 1 });
    const receipt = reclassifyAmbiguousLegacyCustomerLocalHttpAuthorityTrustStore({ statePath: destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, attestation, testOnly: true });
    expect(receipt).toMatchObject({
      sourceStateDigest: migration.sourceStateDigest, initialMigrationReceiptDigest: migration.receiptDigest,
      migratedAuditStateDigest: inspection.migratedAuditStateDigest, priorClassification: "ambiguous-audit-only", classification: "never-recovered",
      preservedEventHeadDigest: inspection.eventHeadDigest, preservedEventCount: 1, activationMode: "audit-only-restored",
      recoveryContinuityRequired: false, freshActivationRequired: true, freshAuthorityStateRequired: true,
      existingLeaseAuthorityEffect: "none", executionAuthorityEffect: "none",
    });
    const migrated = new CustomerLocalHttpAuthorityTrustStore({ statePath: destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, testOnly: true }); closers.push(() => migrated.close());
    expect(migrated.auditActivations()).toHaveLength(1);
    expect(migrated.recoveryContinuityRequirement()).toBeNull();
    expect(() => migrated.resolveCurrent(f.authorityContractDigest)).toThrow(/audit-only/i);
    const database = new DatabaseSync(destinationPath, { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM authority_legacy_reclassifications").get()).toEqual({ count: 1 }); database.close();
    expect(() => reclassifyAmbiguousLegacyCustomerLocalHttpAuthorityTrustStore({ statePath: destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, attestation, testOnly: true })).toThrow(/ambiguous continuity requirement|unreclassified ambiguous/i);
    f.clock.value += 2;
    migrated.importActivation(f.activation("d"));
    expect(migrated.resolveCurrent(f.authorityContractDigest).authorityContractDigest).toBe(f.authorityContractDigest);
  });

  it("reclassifies only through the exact current external recovery guard and still requires fresh activation", () => {
    const f = fixture("reclass-anchored"), destinationPath = join(f.root, "migrated-ambiguous.sqlite");
    const migration = migrateLegacyCustomerLocalHttpAuthorityTrustStore({ sourcePath: f.sourcePath, destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, testOnly: true });
    const anchorKeys = generateKeyPairSync("ed25519");
    const config: ExternalMonotonicContinuityAnchorConfiguration = { schemaVersion: "1.0", anchorId: "anchor_cf071", tenantId: "tenant_cf068", installationId: "installation_cf071", workspaceId: "workspace_cf068", authorityContractDigest: f.authorityContractDigest, trustConfigurationDigest: f.trustStore.configDigest, signerKeyId: "anchor_signer_v1", signerPublicKeyPem: pem(anchorKeys.publicKey) };
    const anchor = new DurableExternalMonotonicContinuityAnchor(join(f.root, "external-anchor.sqlite"), config, { signerPrivateKey: anchorKeys.privateKey, now: () => new Date(f.clock.value).toISOString() }); closers.push(() => anchor.close());
    const manifest = sha("cf071-recovery-manifest"), recovery = anchor.pinRecoveryManifest(manifest), recoveryReceipt = sha("cf071-recovery-receipt"), completion = anchor.completeCurrentRecovery(manifest, recoveryReceipt);
    const guard = createCustomerLocalAuthorityContinuityGuard({ anchor, recoveryManifestDigest: manifest, recoveryReceiptDigest: recoveryReceipt, recoveryCheckpointDigest: recovery.checkpointDigest, completionCheckpoint: completion });
    const attestation = f.attestReclassification(destinationPath, "externally-anchored-recovery", guard.identityDigest, "2026-08-14T11:59:00.000Z");
    const receipt = reclassifyAmbiguousLegacyCustomerLocalHttpAuthorityTrustStore({ statePath: destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, attestation, continuityGuard: guard, testOnly: true });
    expect(receipt).toMatchObject({ initialMigrationReceiptDigest: migration.receiptDigest, classification: "anchored-recovery", continuityGuardIdentityDigest: guard.identityDigest, recoveryContinuityRequired: true, activationMode: "audit-only-restored" });
    const migrated = new CustomerLocalHttpAuthorityTrustStore({ statePath: destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, testOnly: true }); closers.push(() => migrated.close());
    expect(migrated.recoveryContinuityRequirement()).toEqual({ restoredAt: "2026-08-14T11:59:00.000Z" });
    expect(() => migrated.resolveCurrent(f.authorityContractDigest)).toThrow(/audit-only/i);
    f.clock.value += 2;
    migrated.importActivation(f.activation("e"));
    expect(migrated.resolveCurrent(f.authorityContractDigest).authorityContractDigest).toBe(f.authorityContractDigest);
  });

  it("preserves signed reclassification lineage through audit backup and makes pre-reclassification rollback non-authorizing", () => {
    const f = fixture("reclass-backup"), destinationPath = join(f.root, "migrated.sqlite"), oldBackupPath = join(f.root, "ambiguous-backup");
    const migration = migrateLegacyCustomerLocalHttpAuthorityTrustStore({ sourcePath: f.sourcePath, destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, testOnly: true });
    const ambiguous = new CustomerLocalHttpAuthorityTrustStore({ statePath: destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, testOnly: true });
    ambiguous.createSignedAuditBackup({ directory: oldBackupPath, signerKeyId: "workspace_admin_v1", signerPrivateKey: f.admin.privateKey, expiresAt: new Date(f.clock.value + 60_000).toISOString() }); ambiguous.close();
    const reclassification = reclassifyAmbiguousLegacyCustomerLocalHttpAuthorityTrustStore({ statePath: destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, attestation: f.attestReclassification(destinationPath, "independently-attested-never-recovered"), testOnly: true });
    const reclassified = new CustomerLocalHttpAuthorityTrustStore({ statePath: destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, testOnly: true });
    const backupPath = join(f.root, "reclassified-backup"), backup = reclassified.createSignedAuditBackup({ directory: backupPath, signerKeyId: "workspace_admin_v1", signerPrivateKey: f.admin.privateKey, expiresAt: new Date(f.clock.value + 60_000).toISOString() }); reclassified.close();
    expect(backup.manifest.legacyLineage).toEqual({
      migrationState: "never-recovered", sourceStateDigest: migration.sourceStateDigest, initialMigrationReceiptDigest: migration.receiptDigest,
      reclassificationReceiptDigest: reclassification.receiptDigest, reclassificationAttestationDigest: reclassification.attestationReceiptDigest,
      reclassificationPrestateDigest: reclassification.migratedAuditStateDigest,
    });
    const restoredPath = join(f.root, "restored-reclassified.sqlite"), restored = restoreSignedCustomerLocalHttpAuthorityTrustBackup({ backupDirectory: backupPath, destinationStatePath: restoredPath, trustStore: f.trustStore, expectedWorkspaceId: "workspace_cf068", testOnly: true }); closers.push(() => restored.store.close());
    expect(restored.store.auditActivations()).toHaveLength(1);
    expect(restored.store.recoveryContinuityRequirement()).toEqual({ restoredAt: new Date(f.clock.value).toISOString() });
    expect(() => restored.store.resolveCurrent(f.authorityContractDigest)).toThrow(/audit-only/i);
    const restoredDatabase = new DatabaseSync(restoredPath, { readOnly: true });
    expect(restoredDatabase.prepare("SELECT receipt_digest FROM authority_legacy_reclassifications").get()).toEqual({ receipt_digest: reclassification.receiptDigest });
    expect(restoredDatabase.prepare("SELECT value FROM authority_trust_meta WHERE key='last_audit_restore_manifest_digest'").get()).toEqual({ value: backup.manifest.manifestDigest }); restoredDatabase.close();
    f.clock.value += 2;
    restored.store.importActivation(f.activation("e"));
    expect(restored.store.resolveCurrent(f.authorityContractDigest).authorityContractDigest).toBe(f.authorityContractDigest);
    expect(restored.store.recoveryContinuityRequirement()).not.toBeNull();

    const rollbackPath = join(f.root, "restored-ambiguous-rollback.sqlite"), rollback = restoreSignedCustomerLocalHttpAuthorityTrustBackup({ backupDirectory: oldBackupPath, destinationStatePath: rollbackPath, trustStore: f.trustStore, expectedWorkspaceId: "workspace_cf068", testOnly: true }); closers.push(() => rollback.store.close());
    f.clock.value += 2;
    expect(() => rollback.store.importActivation(f.activation("f"))).toThrow(/ambiguous legacy recovery history/i);
    expect(() => rollback.store.resolveCurrent(f.authorityContractDigest)).toThrow(/audit-only/i);
  });

  it("rejects a re-signed backup whose independent reclassification evidence was altered", () => {
    const f = fixture("reclass-backup-tamper"), destinationPath = join(f.root, "migrated.sqlite");
    migrateLegacyCustomerLocalHttpAuthorityTrustStore({ sourcePath: f.sourcePath, destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, testOnly: true });
    reclassifyAmbiguousLegacyCustomerLocalHttpAuthorityTrustStore({ statePath: destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, attestation: f.attestReclassification(destinationPath, "independently-attested-never-recovered"), testOnly: true });
    const store = new CustomerLocalHttpAuthorityTrustStore({ statePath: destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, testOnly: true }), backupPath = join(f.root, "backup");
    store.createSignedAuditBackup({ directory: backupPath, signerKeyId: "workspace_admin_v1", signerPrivateKey: f.admin.privateKey, expiresAt: new Date(f.clock.value + 60_000).toISOString() }); store.close();
    const databasePath = join(backupPath, "authority-trust.sqlite"), database = new DatabaseSync(databasePath), row = database.prepare("SELECT attestation_json FROM authority_legacy_reclassifications").get() as { attestation_json: string };
    const changed = JSON.parse(row.attestation_json) as Record<string, unknown>; changed.statement = "A backup signer tried to replace the independent assessor's statement.";
    database.prepare("UPDATE authority_legacy_reclassifications SET attestation_json=?").run(JSON.stringify(changed)); database.close();
    const manifestPath = join(backupPath, "manifest.json"), signaturePath = join(backupPath, "manifest.sig"), manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, any>;
    const bytes = readFileSync(databasePath); manifest.database.bytes = bytes.length; manifest.database.sha256 = createHash("sha256").update(bytes).digest("hex");
    const { manifestDigest: _oldDigest, ...body } = manifest; manifest.manifestDigest = objectDigest(body);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    writeFileSync(signaturePath, JSON.stringify({ schemaVersion: "1.0", algorithm: "Ed25519", signerKeyId: "workspace_admin_v1", signature: sign(null, Buffer.from(canonical(manifest)), f.admin.privateKey).toString("base64") }));
    expect(() => restoreSignedCustomerLocalHttpAuthorityTrustBackup({ backupDirectory: backupPath, destinationStatePath: join(f.root, "rejected.sqlite"), trustStore: f.trustStore, expectedWorkspaceId: "workspace_cf068", testOnly: true })).toThrow(/reclassification receipt|attestation changed|verifies/i);
  });

  it("serializes two real-process reclassifiers so exactly one commits and the loser fails closed", async () => {
    const f = fixture("reclass-race"), destinationPath = join(f.root, "migrated.sqlite");
    migrateLegacyCustomerLocalHttpAuthorityTrustStore({ sourcePath: f.sourcePath, destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, testOnly: true });
    const attestation = f.attestReclassification(destinationPath, "independently-attested-never-recovered"), startAtEpochMs = Date.now() + 250;
    const shared = { mode: "reclassify" as const, startAtEpochMs, statePath: destinationPath, trustPath: join(f.root, "trust.sqlite"), workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustConfig: f.trustStore.config, now: new Date(f.clock.value).toISOString(), attestation };
    const firstPath = join(f.root, "race-first.json"), secondPath = join(f.root, "race-second.json");
    writeFileSync(firstPath, JSON.stringify(shared)); writeFileSync(secondPath, JSON.stringify(shared));
    const results = await Promise.all([runCf076Worker(firstPath), runCf076Worker(secondPath)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")?.message).toMatch(/ambiguous|changed|serialized|reclassification|locked/i);
    const database = new DatabaseSync(destinationPath, { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM authority_legacy_reclassifications").get()).toEqual({ count: 1 }); database.close();
    const reopened = new CustomerLocalHttpAuthorityTrustStore({ statePath: destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, testOnly: true }); closers.push(() => reopened.close());
    expect(reopened.auditActivations()).toHaveLength(1);
    expect(() => reopened.resolveCurrent(f.authorityContractDigest)).toThrow(/audit-only/i);
  });

  it("recovers from a process crash inside an uncommitted serialized write without partial lineage", async () => {
    const f = fixture("reclass-crash"), destinationPath = join(f.root, "migrated.sqlite");
    migrateLegacyCustomerLocalHttpAuthorityTrustStore({ sourcePath: f.sourcePath, destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, testOnly: true });
    const attestation = f.attestReclassification(destinationPath, "independently-attested-never-recovered"), crashPath = join(f.root, "crash.json");
    writeFileSync(crashPath, JSON.stringify({ mode: "crash-uncommitted", startAtEpochMs: Date.now() + 100, statePath: destinationPath, trustPath: join(f.root, "trust.sqlite"), workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustConfig: f.trustStore.config, now: new Date(f.clock.value).toISOString() }));
    await runCf076Worker(crashPath);
    const afterCrash = new DatabaseSync(destinationPath, { readOnly: true });
    expect(afterCrash.prepare("SELECT value FROM authority_trust_meta WHERE key='cf076_uncommitted_probe'").get()).toBeUndefined(); afterCrash.close();
    const receipt = reclassifyAmbiguousLegacyCustomerLocalHttpAuthorityTrustStore({ statePath: destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, attestation, testOnly: true });
    expect(receipt).toMatchObject({ classification: "never-recovered", activationMode: "audit-only-restored", executionAuthorityEffect: "none" });
  });

  it("serializes a real-process admin rotation with reclassification without losing either valid history", async () => {
    const f = fixture("reclass-rotation-race"), destinationPath = join(f.root, "migrated.sqlite");
    migrateLegacyCustomerLocalHttpAuthorityTrustStore({ sourcePath: f.sourcePath, destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, testOnly: true });
    f.clock.value += 2;
    const attestation = f.attestReclassification(destinationPath, "independently-attested-never-recovered"), rotationPayload = {
      schemaVersion: "1.0" as const, tenantId: "tenant_cf068", environment: "local", oldKeyId: "workspace_admin_v1", oldPublicKeyDigest: publicDigest(f.admin.publicKey),
      newKeyId: "workspace_admin_v2", newIssuer: "customer_admin", newPublicKeyPem: pem(f.nextAdmin.publicKey), newPublicKeyDigest: publicDigest(f.nextAdmin.publicKey),
      effectiveAt: new Date(f.clock.value).toISOString(), newNotAfter: new Date(f.clock.value + 86_400_000).toISOString(), issuedAt: new Date(f.clock.value - 1).toISOString(),
      executionAuthorityEffect: "none" as const, activationEffect: "none" as const,
    }, rotationReceipt = createRotationReceipt({ payload: rotationPayload, oldPrivateKey: f.admin.privateKey, newPrivateKey: f.nextAdmin.privateKey });
    f.trustStore.rotate(rotationReceipt);
    const startAtEpochMs = Date.now() + 250, common = { startAtEpochMs, statePath: destinationPath, trustPath: join(f.root, "trust.sqlite"), workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustConfig: f.trustStore.config, now: new Date(f.clock.value).toISOString() };
    const reclassPath = join(f.root, "race-reclass.json"), rotationPath = join(f.root, "race-rotation.json");
    writeFileSync(reclassPath, JSON.stringify({ ...common, mode: "reclassify", attestation }));
    writeFileSync(rotationPath, JSON.stringify({ ...common, mode: "adopt-admin-rotation", rotationReceipt }));
    const [reclassificationResult, rotationResult] = await Promise.all([runCf076Worker(reclassPath), runCf076Worker(rotationPath)]);
    expect(rotationResult.status).toBe("fulfilled");
    const store = new CustomerLocalHttpAuthorityTrustStore({ statePath: destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, testOnly: true }); closers.push(() => store.close());
    expect(store.currentAdminKey().keyId).toBe("workspace_admin_v2");
    expect(store.auditActivations()).toHaveLength(1);
    if (reclassificationResult.status === "rejected") {
      expect(reclassificationResult.message).toMatch(/stale|changed|serialized|ambiguous|rotation|lineage/i);
      reclassifyAmbiguousLegacyCustomerLocalHttpAuthorityTrustStore({ statePath: destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, attestation: f.attestReclassification(destinationPath, "independently-attested-never-recovered"), testOnly: true });
    }
    const finalDatabase = new DatabaseSync(destinationPath, { readOnly: true });
    expect(finalDatabase.prepare("SELECT COUNT(*) AS count FROM authority_admin_rotations").get()).toEqual({ count: 1 });
    expect(finalDatabase.prepare("SELECT COUNT(*) AS count FROM authority_legacy_reclassifications").get()).toEqual({ count: 1 }); finalDatabase.close();
  });

  it("rejects forged, stale, mutated and cross-migration reclassification evidence", () => {
    const stale = fixture("reclass-stale"), stalePath = join(stale.root, "migrated.sqlite");
    migrateLegacyCustomerLocalHttpAuthorityTrustStore({ sourcePath: stale.sourcePath, destinationPath: stalePath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: stale.trustStore, testOnly: true });
    const exact = stale.attestReclassification(stalePath, "independently-attested-never-recovered");
    const database = new DatabaseSync(stalePath); database.prepare("UPDATE authority_trust_meta SET value=? WHERE key='audit_only_entered_at'").run("2026-08-14T12:00:00.001Z"); database.close();
    expect(() => reclassifyAmbiguousLegacyCustomerLocalHttpAuthorityTrustStore({ statePath: stalePath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: stale.trustStore, attestation: exact, testOnly: true })).toThrow(/stale|cross-store|malformed|substituted/i);

    const forged = fixture("reclass-forged"), forgedPath = join(forged.root, "migrated.sqlite");
    migrateLegacyCustomerLocalHttpAuthorityTrustStore({ sourcePath: forged.sourcePath, destinationPath: forgedPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: forged.trustStore, testOnly: true });
    const forgedExact = forged.attestReclassification(forgedPath, "independently-attested-never-recovered");
    expect(() => reclassifyAmbiguousLegacyCustomerLocalHttpAuthorityTrustStore({ statePath: forgedPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: forged.trustStore, attestation: { ...forgedExact, signature: Buffer.from("forged").toString("base64") }, testOnly: true })).toThrow(/stale|cross-store|malformed|substituted|signed/i);

    const other = fixture("reclass-other"), otherPath = join(other.root, "migrated.sqlite");
    migrateLegacyCustomerLocalHttpAuthorityTrustStore({ sourcePath: other.sourcePath, destinationPath: otherPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: other.trustStore, testOnly: true });
    expect(() => reclassifyAmbiguousLegacyCustomerLocalHttpAuthorityTrustStore({ statePath: otherPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: other.trustStore, attestation: forgedExact, testOnly: true })).toThrow(/stale|cross-store|malformed|substituted/i);

    const persisted = fixture("reclass-persisted-tamper"), persistedPath = join(persisted.root, "migrated.sqlite");
    migrateLegacyCustomerLocalHttpAuthorityTrustStore({ sourcePath: persisted.sourcePath, destinationPath: persistedPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: persisted.trustStore, testOnly: true });
    reclassifyAmbiguousLegacyCustomerLocalHttpAuthorityTrustStore({ statePath: persistedPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: persisted.trustStore, attestation: persisted.attestReclassification(persistedPath, "independently-attested-never-recovered"), testOnly: true });
    const tamper = new DatabaseSync(persistedPath), row = tamper.prepare("SELECT receipt_json FROM authority_legacy_reclassifications").get() as { receipt_json: string };
    const changed = JSON.parse(row.receipt_json) as Record<string, unknown>; changed.executionAuthorityEffect = "activate-legacy-authority";
    tamper.prepare("UPDATE authority_legacy_reclassifications SET receipt_json=?").run(JSON.stringify(changed)); tamper.close();
    const reopened = new CustomerLocalHttpAuthorityTrustStore({ statePath: persistedPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: persisted.trustStore, testOnly: true }); closers.push(() => reopened.close());
    expect(() => reopened.auditActivations()).toThrow(/reclassification receipt|changed after publication/i);
  });

  it("accepts an exact signed store attestation plus current external recovery guard and rejects stale guard lineage", () => {
    const f = fixture("anchored"), anchorKeys = generateKeyPairSync("ed25519");
    const config: ExternalMonotonicContinuityAnchorConfiguration = { schemaVersion: "1.0", anchorId: "anchor_cf068", tenantId: "tenant_cf068", installationId: "installation_cf068", workspaceId: "workspace_cf068", authorityContractDigest: f.authorityContractDigest, trustConfigurationDigest: f.trustStore.configDigest, signerKeyId: "anchor_signer_v1", signerPublicKeyPem: pem(anchorKeys.publicKey) };
    const anchor = new DurableExternalMonotonicContinuityAnchor(join(f.root, "external-anchor.sqlite"), config, { signerPrivateKey: anchorKeys.privateKey, now: () => new Date(f.clock.value).toISOString() }); closers.push(() => anchor.close());
    const manifest = sha("recovery-manifest"), recovery = anchor.pinRecoveryManifest(manifest), receiptDigest = sha("recovery-receipt"), completion = anchor.completeCurrentRecovery(manifest, receiptDigest);
    const guard = createCustomerLocalAuthorityContinuityGuard({ anchor, recoveryManifestDigest: manifest, recoveryReceiptDigest: receiptDigest, recoveryCheckpointDigest: recovery.checkpointDigest, completionCheckpoint: completion });
    const attestation = f.attest("externally-anchored-recovery", guard.identityDigest, "2026-08-14T11:59:00.000Z");
    const migrated = migrateLegacyCustomerLocalHttpAuthorityTrustStore({ sourcePath: f.sourcePath, destinationPath: join(f.root, "migrated-anchored.sqlite"), workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, attestation, continuityGuard: guard, testOnly: true });
    expect(migrated).toMatchObject({ classification: "anchored-recovery", recoveryContinuityRequired: true, continuityGuardIdentityDigest: guard.identityDigest });
    anchor.pinRecoveryManifest(sha("later-recovery"));
    expect(() => migrateLegacyCustomerLocalHttpAuthorityTrustStore({ sourcePath: f.sourcePath, destinationPath: join(f.root, "stale-guard.sqlite"), workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, attestation, continuityGuard: guard, testOnly: true })).toThrow(/stale|superseded|mismatched|missing/i);
  });

  it("rejects stale, forged, cross-store and torn continuity evidence without publishing a destination", () => {
    const f = fixture("attacks"), exact = f.attest("independently-attested-never-recovered"), destinationPath = join(f.root, "rejected.sqlite");
    expect(() => migrateLegacyCustomerLocalHttpAuthorityTrustStore({ sourcePath: f.sourcePath, destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, attestation: { ...exact, sourceStateDigest: sha("other") }, testOnly: true })).toThrow(/stale|cross-store|malformed|substituted/i);
    const forged = { ...exact, signature: Buffer.from("forged").toString("base64") };
    expect(() => migrateLegacyCustomerLocalHttpAuthorityTrustStore({ sourcePath: f.sourcePath, destinationPath, workspaceId: "workspace_cf068", initialAdminKeyId: "workspace_admin_v1", trustStore: f.trustStore, attestation: forged, testOnly: true })).toThrow(/stale|cross-store|malformed|substituted|signed/i);
    const database = new DatabaseSync(f.sourcePath); database.prepare("INSERT INTO authority_trust_meta(key,value) VALUES('recovery_continuity_required','false')").run(); database.close();
    expect(() => f.inspect()).toThrow(/torn|partially migrated/i);
  });
});
