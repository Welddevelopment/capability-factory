import {
  createHash,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  restoreSignedCustomerLocalHttpAuthorityTrustBackup,
  type CustomerLocalHttpAuthorityTrustStore,
} from "./customer-local-http-authority-trust.js";
import type { CustomerLocalTrustStore } from "./customer-local-trust-backup.js";
import type { PilotAuthorityRecoveryGate, PilotInstallationMetadata } from "./installation.js";
import type { PilotPackageManager } from "./pilot-package.js";
import { CUSTOMER_LOCAL_RESOURCE_LIMITS, readBoundedFile } from "./customer-local-resource-bounds.js";
import {
  DurableExternalMonotonicContinuityAnchor,
  type ExternalMonotonicContinuityAnchorDescriptor,
  type ExternalMonotonicContinuityCheckpoint,
} from "./external-monotonic-continuity-anchor.js";
import { createCustomerLocalAuthorityContinuityGuard, type CustomerLocalAuthorityContinuityGuard } from "./customer-local-authority-continuity-guard.js";

export const CUSTOMER_LOCAL_PILOT_AUTHORITY_RECOVERY_VERSION = "1.1" as const;

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,179}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;

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

function fileDigest(filename: string): string {
  return createHash("sha256").update(readFileSync(filename)).digest("hex");
}

function keyDigest(key: KeyObject): string {
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error("Pilot recovery requires an Ed25519 public key.");
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
}

function epoch(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} timestamp is invalid.`);
  return parsed;
}

function writeFreshJson(filename: string, value: unknown): void {
  if (existsSync(filename)) throw new Error("Pilot recovery evidence is immutable and cannot overwrite an existing file.");
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

export interface CustomerLocalPilotAuthorityRecoveryManifest {
  schemaVersion: typeof CUSTOMER_LOCAL_PILOT_AUTHORITY_RECOVERY_VERSION;
  kind: "customer-local-pilot-authority-recovery-point";
  backupId: string;
  installationId: string;
  productVersion: string;
  tenantId: string;
  workspaceId: string;
  authorityContractDigest: string;
  trustConfigurationDigest: string;
  packageConfigSha256: string;
  adapterRuntimeSha256: string;
  installationBackupManifestSha256: string;
  authorityTrustBackupManifestDigest: string;
  authorityActivationReceiptDigest: string;
  createdAt: string;
  expiresAt: string;
  signerKeyId: string;
  signerPublicKeyDigest: string;
  continuityAnchor: ExternalMonotonicContinuityAnchorDescriptor;
  restoreMode: "package-deactivated-authority-audit-only-until-fresh-signed-activation";
  executionAuthorityEffect: "none";
  activationAuthorityEffect: "none";
  rollbackProtection: "external-monotonic-anchor-currentness-required";
  manifestDigest: string;
}

export interface CustomerLocalPilotAuthorityRecoverySignature {
  schemaVersion: "1.0";
  algorithm: "Ed25519";
  signerKeyId: string;
  signature: string;
}

export interface CustomerLocalPilotAuthorityRecoveryReceipt {
  schemaVersion: "1.0";
  kind: "customer-local-pilot-authority-audit-restore";
  backupId: string;
  installationId: string;
  tenantId: string;
  manifestDigest: string;
  installationBackupManifestSha256: string;
  authorityTrustBackupManifestDigest: string;
  authorityRestoreReceiptDigest: string;
  restoredAuthorityStateSha256: string;
  restoredAt: string;
  finalInstallationMetadataDigest: string;
  packageLifecycle: "deactivated";
  authorityState: "audit-only-awaiting-fresh-activation";
  continuityAnchorConfigurationDigest: string;
  continuityRecoveryCheckpointDigest: string;
  continuityRecoveryGeneration: number;
  continuityCurrentnessVerified: true;
  executionAuthority: false;
  activationAuthority: false;
  rollbackProtectionRequiresExternalMonotonicAnchor: true;
  receiptDigest: string;
}

function recoveryDirectory(manager: PilotPackageManager, backupId: string): string {
  return join(manager.installation.backupsDirectory, backupId);
}

function assertExternalAnchor(manager: PilotPackageManager, anchor: DurableExternalMonotonicContinuityAnchor): void {
  const packageRoot = realpathSync(resolve(manager.rootDirectory));
  const anchorPath = realpathSync(resolve(anchor.path));
  if (anchorPath === packageRoot || anchorPath.startsWith(`${packageRoot}${sep}`)) throw new Error("Continuity anchor must be stored outside the recoverable package root.");
}

function parseManifest(filename: string): CustomerLocalPilotAuthorityRecoveryManifest {
  return JSON.parse(readBoundedFile(filename, CUSTOMER_LOCAL_RESOURCE_LIMITS.manifestBytes, "Pilot authority recovery manifest").toString("utf8")) as CustomerLocalPilotAuthorityRecoveryManifest;
}

function parseSignature(filename: string): CustomerLocalPilotAuthorityRecoverySignature {
  return JSON.parse(readBoundedFile(filename, 64_000, "Pilot authority recovery signature").toString("utf8")) as CustomerLocalPilotAuthorityRecoverySignature;
}

/**
 * Adds an independently signed authority-trust snapshot to an ordinary package
 * lifecycle backup. The resulting recovery point does not itself authorize a
 * restore, activation, or action.
 */
export function createCustomerLocalPilotAuthorityRecoveryPoint(input: {
  manager: PilotPackageManager;
  authorityTrustStore: CustomerLocalHttpAuthorityTrustStore;
  authorityContractDigest: string;
  reason: string;
  signerKeyId: string;
  signerPrivateKey: KeyObject;
  expiresAt: string;
  continuityAnchor: DurableExternalMonotonicContinuityAnchor;
}): { manifest: CustomerLocalPilotAuthorityRecoveryManifest; signature: CustomerLocalPilotAuthorityRecoverySignature; continuityCheckpoint: ExternalMonotonicContinuityCheckpoint } {
  assertExternalAnchor(input.manager, input.continuityAnchor);
  const config = input.manager.readConfig();
  const installation = input.manager.installation.inspect();
  if (installation.lifecycle !== "active" || installation.authorityRecovery) throw new Error("Pilot authority recovery point requires an active, non-recovered package.");
  const binding = input.authorityTrustStore.resolveCurrent(input.authorityContractDigest);
  binding.assertCurrent();
  if (binding.trustConfigurationDigest !== input.authorityTrustStore.trustConfigurationDigest) throw new Error("Pilot package authority binding conflicts with its independent trust store.");
  const installationBackup = input.manager.installation.backup(input.reason);
  const directory = recoveryDirectory(input.manager, installationBackup.backupId);
  const authorityDirectory = join(directory, "authority-trust");
  try {
    const authorityBackup = input.authorityTrustStore.createSignedAuditBackup({
      directory: authorityDirectory,
      signerKeyId: input.signerKeyId,
      signerPrivateKey: input.signerPrivateKey,
      expiresAt: input.expiresAt,
    });
    const trustedPublicKey = createPublicKey(input.signerPrivateKey);
    const createdAt = authorityBackup.manifest.createdAt;
    if (epoch(input.expiresAt, "Pilot recovery expiry") <= epoch(createdAt, "Pilot recovery creation")) throw new Error("Pilot recovery validity window is invalid.");
    const continuityAnchor = input.continuityAnchor.descriptor();
    if (continuityAnchor.tenantId !== config.tenantId || continuityAnchor.installationId !== installation.installationId
      || continuityAnchor.workspaceId !== binding.workspaceId || continuityAnchor.authorityContractDigest !== binding.authorityContractDigest
      || continuityAnchor.trustConfigurationDigest !== binding.trustConfigurationDigest) throw new Error("Continuity anchor belongs to a different package or authority scope.");
    const body = {
      schemaVersion: CUSTOMER_LOCAL_PILOT_AUTHORITY_RECOVERY_VERSION,
      kind: "customer-local-pilot-authority-recovery-point" as const,
      backupId: installationBackup.backupId,
      installationId: installation.installationId,
      productVersion: installation.productVersion,
      tenantId: config.tenantId,
      workspaceId: binding.workspaceId,
      authorityContractDigest: binding.authorityContractDigest,
      trustConfigurationDigest: binding.trustConfigurationDigest,
      packageConfigSha256: fileDigest(input.manager.configFilename),
      adapterRuntimeSha256: config.adapterRuntime.sha256,
      installationBackupManifestSha256: fileDigest(join(directory, "manifest.json")),
      authorityTrustBackupManifestDigest: authorityBackup.manifest.manifestDigest,
      authorityActivationReceiptDigest: binding.activationReceiptDigest,
      createdAt,
      expiresAt: input.expiresAt,
      signerKeyId: input.signerKeyId,
      signerPublicKeyDigest: keyDigest(trustedPublicKey),
      continuityAnchor,
      restoreMode: "package-deactivated-authority-audit-only-until-fresh-signed-activation" as const,
      executionAuthorityEffect: "none" as const,
      activationAuthorityEffect: "none" as const,
      rollbackProtection: "external-monotonic-anchor-currentness-required" as const,
    };
    const manifest: CustomerLocalPilotAuthorityRecoveryManifest = { ...body, manifestDigest: digest(body) };
    const signature: CustomerLocalPilotAuthorityRecoverySignature = {
      schemaVersion: "1.0",
      algorithm: "Ed25519",
      signerKeyId: input.signerKeyId,
      signature: sign(null, Buffer.from(canonical(manifest)), input.signerPrivateKey).toString("base64"),
    };
    writeFreshJson(join(directory, "authority-recovery.json"), manifest);
    writeFreshJson(join(directory, "authority-recovery.sig"), signature);
    const continuityCheckpoint = input.continuityAnchor.pinRecoveryManifest(manifest.manifestDigest);
    return { manifest, signature, continuityCheckpoint };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function assertRecoveryManifest(input: {
  manager: PilotPackageManager;
  trustStore: CustomerLocalTrustStore;
  expectedWorkspaceId: string;
  expectedAuthorityContractDigest: string;
  backupId: string;
  manifest: CustomerLocalPilotAuthorityRecoveryManifest;
  signature: CustomerLocalPilotAuthorityRecoverySignature;
  continuityAnchor: DurableExternalMonotonicContinuityAnchor;
}): void {
  const { manager, trustStore, manifest, signature } = input;
  const config = manager.readConfig();
  const installation = manager.installation.inspect();
  const directory = recoveryDirectory(manager, input.backupId);
  const { manifestDigest, ...body } = manifest;
  const now = trustStore.currentTime();
  if (manifest.schemaVersion !== CUSTOMER_LOCAL_PILOT_AUTHORITY_RECOVERY_VERSION || manifest.kind !== "customer-local-pilot-authority-recovery-point"
    || manifest.backupId !== input.backupId || manifest.installationId !== installation.installationId || manifest.productVersion !== installation.productVersion
    || manifest.tenantId !== config.tenantId || manifest.workspaceId !== input.expectedWorkspaceId
    || manifest.authorityContractDigest !== input.expectedAuthorityContractDigest || manifest.trustConfigurationDigest !== trustStore.configDigest
    || !identifier.test(manifest.signerKeyId) || !digestPattern.test(manifest.packageConfigSha256) || !digestPattern.test(manifest.adapterRuntimeSha256)
    || !digestPattern.test(manifest.installationBackupManifestSha256) || !digestPattern.test(manifest.authorityTrustBackupManifestDigest)
    || !digestPattern.test(manifest.authorityActivationReceiptDigest) || manifest.packageConfigSha256 !== fileDigest(manager.configFilename)
    || manifest.adapterRuntimeSha256 !== config.adapterRuntime.sha256 || manifest.installationBackupManifestSha256 !== fileDigest(join(directory, "manifest.json"))
    || manifest.restoreMode !== "package-deactivated-authority-audit-only-until-fresh-signed-activation"
    || manifest.executionAuthorityEffect !== "none" || manifest.activationAuthorityEffect !== "none"
    || canonical(manifest.continuityAnchor) !== canonical(input.continuityAnchor.descriptor())
    || manifest.rollbackProtection !== "external-monotonic-anchor-currentness-required" || manifestDigest !== digest(body)
    || epoch(manifest.createdAt, "Pilot recovery creation") > epoch(now, "Pilot recovery current time")
    || epoch(manifest.expiresAt, "Pilot recovery expiry") <= epoch(now, "Pilot recovery current time")
    || signature.schemaVersion !== "1.0" || signature.algorithm !== "Ed25519" || signature.signerKeyId !== manifest.signerKeyId
    || !base64Pattern.test(signature.signature)) {
    throw new Error("Pilot authority recovery point is stale, substituted, cross-scope, or violates its non-authorizing boundary.");
  }
  const trusted = trustStore.assertTrusted(manifest.signerKeyId, now, "pilot authority recovery");
  if (trusted.state !== "active" || trusted.publicKeyDigest !== manifest.signerPublicKeyDigest
    || !verify(null, Buffer.from(canonical(manifest)), trusted.publicKey, Buffer.from(signature.signature, "base64"))) {
    throw new Error("Pilot authority recovery signature or independently pinned signer is invalid.");
  }
}

/**
 * Restores package data and the workspace-authority ledger as one recovery
 * operation. The installation is published deactivated and the authority
 * ledger is published audit-only. Only a fresh signed activation can clear the
 * durable installation gate.
 */
export function restoreCustomerLocalPilotAuthorityRecoveryPoint(input: {
  manager: PilotPackageManager;
  trustStore: CustomerLocalTrustStore;
  continuityAnchor: DurableExternalMonotonicContinuityAnchor;
  backupId: string;
  expectedWorkspaceId: string;
  expectedAuthorityContractDigest: string;
  testOnly?: true;
  _testOnlyAfterRecoveryEvidence?: () => void;
}): {
  receipt: CustomerLocalPilotAuthorityRecoveryReceipt;
  authorityTrustStore: CustomerLocalHttpAuthorityTrustStore;
  installation: PilotInstallationMetadata;
  evidencePath: string;
  continuityCompletionCheckpoint: ExternalMonotonicContinuityCheckpoint;
  continuityGuard: CustomerLocalAuthorityContinuityGuard;
} {
  assertExternalAnchor(input.manager, input.continuityAnchor);
  const directory = recoveryDirectory(input.manager, input.backupId);
  const actualNames = readdirSync(directory).sort();
  const expectedNames = ["authority-recovery.json", "authority-recovery.sig", "authority-trust", "manifest.json", "payload"].sort();
  if (canonical(actualNames) !== canonical(expectedNames)) throw new Error("Pilot authority recovery point has extra, missing, mixed, or torn files.");
  input.manager.installation.verifyBackup(input.backupId);
  const manifest = parseManifest(join(directory, "authority-recovery.json"));
  const signature = parseSignature(join(directory, "authority-recovery.sig"));
  assertRecoveryManifest({ ...input, manifest, signature });
  const anchored = input.continuityAnchor.withCurrentRecovery(manifest.manifestDigest, (recoveryCheckpoint) => {
    const authorityDestination = resolve(input.manager.rootDirectory, "trust", `recovered-${input.backupId}.sqlite`);
    if (!authorityDestination.startsWith(`${resolve(input.manager.rootDirectory)}${sep}`)) throw new Error("Authority recovery destination escaped the customer-local package root.");
    let restored: ReturnType<typeof restoreSignedCustomerLocalHttpAuthorityTrustBackup> | undefined;
    let packagePublished = false;
    try {
      restored = restoreSignedCustomerLocalHttpAuthorityTrustBackup({
        backupDirectory: join(directory, "authority-trust"), destinationStatePath: authorityDestination,
        trustStore: input.trustStore, expectedWorkspaceId: input.expectedWorkspaceId,
        ...(input.testOnly ? { testOnly: true as const } : {}),
      });
      if (restored.manifestDigest !== manifest.authorityTrustBackupManifestDigest) throw new Error("Restored authority-trust manifest does not match the package recovery point.");
      const gate: PilotAuthorityRecoveryGate = {
        schemaVersion: "1.0", state: "audit-only-awaiting-fresh-activation", workspaceId: input.expectedWorkspaceId,
        authorityContractDigest: input.expectedAuthorityContractDigest, trustConfigurationDigest: manifest.trustConfigurationDigest,
        authorityTrustStatePathDigest: digest(authorityDestination), authorityRestoreReceiptDigest: restored.restoreReceiptDigest,
        continuityAnchorConfigurationDigest: manifest.continuityAnchor.configurationDigest,
        continuityRecoveryManifestDigest: manifest.manifestDigest,
        continuityRecoveryCheckpointDigest: recoveryCheckpoint.checkpointDigest,
        continuityRecoveryGeneration: recoveryCheckpoint.generation,
        restoredAt: restored.restoredAt, executionAuthorityEffect: "none", activationAuthorityEffect: "none",
      };
      const installation = input.manager.installation.restoreAuthorityGated(input.backupId, gate);
      packagePublished = true;
      const packageConfig = input.manager.readConfig();
      for (const relative of [packageConfig.files.plansDirectory, packageConfig.files.continuationRevocationsDirectory]) mkdirSync(input.manager.resolve(relative), { recursive: true, mode: 0o700 });
      const receiptBody = {
        schemaVersion: "1.0" as const, kind: "customer-local-pilot-authority-audit-restore" as const,
        backupId: input.backupId, installationId: installation.installationId, tenantId: manifest.tenantId,
        manifestDigest: manifest.manifestDigest, installationBackupManifestSha256: manifest.installationBackupManifestSha256,
        authorityTrustBackupManifestDigest: manifest.authorityTrustBackupManifestDigest,
        authorityRestoreReceiptDigest: restored.restoreReceiptDigest, restoredAuthorityStateSha256: restored.restoredStateSha256,
        restoredAt: restored.restoredAt, finalInstallationMetadataDigest: digest(installation),
        packageLifecycle: "deactivated" as const, authorityState: "audit-only-awaiting-fresh-activation" as const,
        continuityAnchorConfigurationDigest: manifest.continuityAnchor.configurationDigest,
        continuityRecoveryCheckpointDigest: recoveryCheckpoint.checkpointDigest,
        continuityRecoveryGeneration: recoveryCheckpoint.generation, continuityCurrentnessVerified: true as const,
        executionAuthority: false as const, activationAuthority: false as const,
        rollbackProtectionRequiresExternalMonotonicAnchor: true as const,
      };
      const receipt: CustomerLocalPilotAuthorityRecoveryReceipt = { ...receiptBody, receiptDigest: digest(receiptBody) };
      const evidencePath = join(input.manager.rootDirectory, "recovery-evidence", `${receipt.receiptDigest}.json`);
      writeFreshJson(evidencePath, receipt);
      input._testOnlyAfterRecoveryEvidence?.();
      return { value: { receipt, authorityTrustStore: restored.store, installation, evidencePath }, recoveryReceiptDigest: receipt.receiptDigest };
    } catch (error) {
      try { restored?.store.close(); } catch { /* preserve the recovery failure */ }
      if (restored && !packagePublished) {
        rmSync(authorityDestination, { force: true }); rmSync(`${authorityDestination}-wal`, { force: true }); rmSync(`${authorityDestination}-shm`, { force: true });
      }
      throw error;
    }
  }, (value) => { try { value.authorityTrustStore.close(); } catch { /* preserve continuity failure */ } });
  const continuityGuard = createCustomerLocalAuthorityContinuityGuard({
    anchor: input.continuityAnchor, recoveryManifestDigest: manifest.manifestDigest,
    recoveryReceiptDigest: anchored.value.receipt.receiptDigest,
    recoveryCheckpointDigest: anchored.recoveryCheckpoint.checkpointDigest,
    completionCheckpoint: anchored.completionCheckpoint,
  });
  return { ...anchored.value, continuityCompletionCheckpoint: anchored.completionCheckpoint, continuityGuard };
}

/**
 * Completes only the external continuity step after a process loss that already
 * published the package deactivated, the authority store audit-only, and the
 * exact immutable recovery receipt. It cannot reactivate either plane.
 */
export function reconcileCustomerLocalPilotAuthorityRecoveryContinuity(input: {
  manager: PilotPackageManager;
  trustStore: CustomerLocalTrustStore;
  continuityAnchor: DurableExternalMonotonicContinuityAnchor;
  backupId: string;
  expectedWorkspaceId: string;
  expectedAuthorityContractDigest: string;
  receipt: CustomerLocalPilotAuthorityRecoveryReceipt;
}): ExternalMonotonicContinuityCheckpoint {
  assertExternalAnchor(input.manager, input.continuityAnchor);
  const directory = recoveryDirectory(input.manager, input.backupId);
  input.manager.installation.verifyBackup(input.backupId);
  const manifest = parseManifest(join(directory, "authority-recovery.json"));
  const signature = parseSignature(join(directory, "authority-recovery.sig"));
  assertRecoveryManifest({ ...input, manifest, signature });
  const { receiptDigest, ...receiptBody } = input.receipt;
  const installation = input.manager.installation.inspect();
  const gate = installation.authorityRecovery;
  const evidencePath = join(input.manager.rootDirectory, "recovery-evidence", `${receiptDigest}.json`);
  const persisted = JSON.parse(readBoundedFile(evidencePath, CUSTOMER_LOCAL_RESOURCE_LIMITS.manifestBytes, "Pilot authority recovery receipt").toString("utf8")) as CustomerLocalPilotAuthorityRecoveryReceipt;
  const current = input.continuityAnchor.current();
  if (digest(receiptBody) !== receiptDigest || canonical(persisted) !== canonical(input.receipt)
    || input.receipt.backupId !== input.backupId || input.receipt.installationId !== installation.installationId
    || input.receipt.manifestDigest !== manifest.manifestDigest || input.receipt.tenantId !== manifest.tenantId
    || input.receipt.packageLifecycle !== "deactivated" || input.receipt.authorityState !== "audit-only-awaiting-fresh-activation"
    || input.receipt.executionAuthority !== false || input.receipt.activationAuthority !== false
    || input.receipt.continuityAnchorConfigurationDigest !== manifest.continuityAnchor.configurationDigest
    || !current || current.kind !== "recovery-pinned" || current.recoveryManifestDigest !== manifest.manifestDigest
    || input.receipt.continuityRecoveryCheckpointDigest !== current.checkpointDigest || input.receipt.continuityRecoveryGeneration !== current.generation
    || installation.lifecycle !== "deactivated" || !gate || gate.authorityContractDigest !== input.expectedAuthorityContractDigest
    || gate.authorityRestoreReceiptDigest !== input.receipt.authorityRestoreReceiptDigest
    || digest(installation) !== input.receipt.finalInstallationMetadataDigest) throw new Error("Recovery continuity reconciliation is stale, substituted, incomplete, or would promote authority.");
  return input.continuityAnchor.completeCurrentRecovery(manifest.manifestDigest, receiptDigest);
}
