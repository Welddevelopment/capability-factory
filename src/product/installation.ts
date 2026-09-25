import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  assertTrustedCustomerLocalHttpAuthorityTrustBinding,
  type CustomerLocalHttpAuthorityTrustBinding,
} from "./customer-local-http-authority-trust.js";
import { assertTrustedCustomerLocalAuthorityContinuityGuard, type CustomerLocalAuthorityContinuityGuard, type CustomerLocalAuthorityContinuityIdentity } from "./customer-local-authority-continuity-guard.js";

export const PILOT_INSTALLATION_SCHEMA_VERSION = 2 as const;

export interface PilotInstallationMetadata {
  schemaVersion: typeof PILOT_INSTALLATION_SCHEMA_VERSION;
  installationId: string;
  productVersion: string;
  installationMode: "embedded-sdk" | "customer-hosted-sidecar";
  lifecycle: "active" | "deactivated" | "uninstalled";
  supportedCapabilityModes: ["constrained-http-api"];
  createdAt: string;
  updatedAt: string;
  lastBackupId?: string | undefined;
  deactivationReason?: string | undefined;
  authorityRecovery?: PilotAuthorityRecoveryGate | undefined;
  authorityContinuity?: CustomerLocalAuthorityContinuityIdentity | undefined;
}

export interface PilotAuthorityRecoveryGate {
  schemaVersion: "1.0";
  state: "audit-only-awaiting-fresh-activation";
  workspaceId: string;
  authorityContractDigest: string;
  trustConfigurationDigest: string;
  authorityTrustStatePathDigest: string;
  authorityRestoreReceiptDigest: string;
  continuityAnchorConfigurationDigest: string;
  continuityRecoveryManifestDigest: string;
  continuityRecoveryCheckpointDigest: string;
  continuityRecoveryGeneration: number;
  restoredAt: string;
  executionAuthorityEffect: "none";
  activationAuthorityEffect: "none";
}

interface LegacyInstallationMetadata {
  schemaVersion: 1;
  installationId: string;
  productVersion: string;
  installationMode: "embedded-sdk" | "customer-hosted-sidecar";
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PilotBackupManifest {
  schemaVersion: "1.0";
  backupId: string;
  installationId: string;
  productVersion: string;
  reason: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  createdAt: string;
}

const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.-]+$/);
const authorityContinuitySchema = z.object({
  schemaVersion: z.literal("1.0"), anchorConfigurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  tenantId: identifier, installationId: identifier, workspaceId: identifier,
  authorityContractDigest: z.string().regex(/^[a-f0-9]{64}$/), trustConfigurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  recoveryManifestDigest: z.string().regex(/^[a-f0-9]{64}$/), recoveryReceiptDigest: z.string().regex(/^[a-f0-9]{64}$/),
  recoveryCheckpointDigest: z.string().regex(/^[a-f0-9]{64}$/), completionCheckpointDigest: z.string().regex(/^[a-f0-9]{64}$/),
  completionGeneration: z.number().int().positive(), identityDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const backupRelativePath = z.string().min(1).max(1_000).refine((value) => {
  if (path.isAbsolute(value) || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}, "Backup paths must be normalized relative POSIX paths without traversal.");
const metadataSchema = z.object({
  schemaVersion: z.literal(PILOT_INSTALLATION_SCHEMA_VERSION),
  installationId: identifier,
  productVersion: identifier,
  installationMode: z.enum(["embedded-sdk", "customer-hosted-sidecar"]),
  lifecycle: z.enum(["active", "deactivated", "uninstalled"]),
  supportedCapabilityModes: z.tuple([z.literal("constrained-http-api")]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastBackupId: identifier.optional(),
  deactivationReason: z.string().min(1).max(1_000).optional(),
  authorityRecovery: z.object({
    schemaVersion: z.literal("1.0"),
    state: z.literal("audit-only-awaiting-fresh-activation"),
    workspaceId: identifier,
    authorityContractDigest: z.string().regex(/^[a-f0-9]{64}$/),
    trustConfigurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
    authorityTrustStatePathDigest: z.string().regex(/^[a-f0-9]{64}$/),
    authorityRestoreReceiptDigest: z.string().regex(/^[a-f0-9]{64}$/),
    continuityAnchorConfigurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
    continuityRecoveryManifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    continuityRecoveryCheckpointDigest: z.string().regex(/^[a-f0-9]{64}$/),
    continuityRecoveryGeneration: z.number().int().positive(),
    restoredAt: z.string().datetime(),
    executionAuthorityEffect: z.literal("none"),
    activationAuthorityEffect: z.literal("none"),
  }).strict().optional(),
  authorityContinuity: authorityContinuitySchema.optional(),
}).strict();

const legacyMetadataSchema: z.ZodType<LegacyInstallationMetadata> = z.object({
  schemaVersion: z.literal(1),
  installationId: identifier,
  productVersion: identifier,
  installationMode: z.enum(["embedded-sdk", "customer-hosted-sidecar"]),
  active: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

const backupManifestSchema: z.ZodType<PilotBackupManifest> = z.object({
  schemaVersion: z.literal("1.0"),
  backupId: identifier,
  installationId: identifier,
  productVersion: identifier,
  reason: z.string().min(1).max(1_000),
  files: z.array(z.object({
    path: backupRelativePath,
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()),
  createdAt: z.string().datetime(),
}).strict();

function nowIso(): string {
  return new Date().toISOString();
}

function sha256(filename: string): string {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function writeJsonAtomic(filename: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filename);
  fs.chmodSync(filename, 0o600);
}

function filesBelow(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Installation backup refuses symbolic links.");
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile()) found.push(filename);
      else throw new Error("Installation backup supports regular files only.");
    }
  };
  walk(root);
  return found.sort();
}

function copyDirectory(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(source)) return;
  for (const filename of filesBelow(source)) {
    const relative = path.relative(source, filename);
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(filename, target);
    fs.chmodSync(target, 0o600);
  }
}

/** Customer-local lifecycle manager for the reference controlled-pilot package. */
export class PilotInstallationManager {
  readonly dataDirectory: string;
  readonly backupsDirectory: string;
  private readonly metadataFilename: string;

  constructor(readonly rootDirectory: string) {
    this.rootDirectory = path.resolve(rootDirectory);
    this.dataDirectory = path.join(this.rootDirectory, "data");
    this.backupsDirectory = path.join(this.rootDirectory, "backups");
    this.metadataFilename = path.join(this.rootDirectory, "installation.json");
  }

  install(input: {
    installationId: string;
    productVersion: string;
    installationMode: PilotInstallationMetadata["installationMode"];
  }): PilotInstallationMetadata {
    if (fs.existsSync(this.metadataFilename)) throw new Error("A pilot installation already exists at this path.");
    const timestamp = nowIso();
    const metadata = metadataSchema.parse({
      schemaVersion: PILOT_INSTALLATION_SCHEMA_VERSION,
      installationId: input.installationId,
      productVersion: input.productVersion,
      installationMode: input.installationMode,
      lifecycle: "active",
      supportedCapabilityModes: ["constrained-http-api"],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    fs.mkdirSync(this.dataDirectory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.backupsDirectory, { recursive: true, mode: 0o700 });
    writeJsonAtomic(this.metadataFilename, metadata);
    return structuredClone(metadata);
  }

  inspect(): PilotInstallationMetadata {
    if (!fs.existsSync(this.metadataFilename)) throw new Error("Pilot installation metadata is missing.");
    const raw: unknown = JSON.parse(fs.readFileSync(this.metadataFilename, "utf8"));
    return metadataSchema.parse(raw);
  }

  migrateLegacy(): { metadata: PilotInstallationMetadata; backup: PilotBackupManifest } {
    const raw: unknown = JSON.parse(fs.readFileSync(this.metadataFilename, "utf8"));
    const legacy = legacyMetadataSchema.parse(raw);
    fs.mkdirSync(this.dataDirectory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.backupsDirectory, { recursive: true, mode: 0o700 });
    const backup = this.backupRaw(`pre-schema-${legacy.schemaVersion}-migration`, legacy);
    const migrated = metadataSchema.parse({
      schemaVersion: PILOT_INSTALLATION_SCHEMA_VERSION,
      installationId: legacy.installationId,
      productVersion: legacy.productVersion,
      installationMode: legacy.installationMode,
      lifecycle: legacy.active ? "active" : "deactivated",
      supportedCapabilityModes: ["constrained-http-api"],
      createdAt: legacy.createdAt,
      updatedAt: nowIso(),
      lastBackupId: backup.backupId,
      ...(!legacy.active ? { deactivationReason: "Migrated from an inactive schema-v1 installation." } : {}),
    });
    writeJsonAtomic(this.metadataFilename, migrated);
    return { metadata: migrated, backup };
  }

  backup(reason: string): PilotBackupManifest {
    const metadata = this.inspect();
    return this.backupRaw(reason, metadata);
  }

  verifyBackup(backupId: string): PilotBackupManifest {
    const directory = path.join(this.backupsDirectory, backupId);
    const manifest = backupManifestSchema.parse(JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8")));
    if (manifest.backupId !== backupId) throw new Error("Backup manifest identity does not match the requested backup.");
    const currentRaw: unknown = JSON.parse(fs.readFileSync(this.metadataFilename, "utf8"));
    const current = z.union([metadataSchema, legacyMetadataSchema]).parse(currentRaw);
    if (manifest.installationId !== current.installationId) throw new Error("Backup belongs to a different installation.");
    const payloadRoot = path.join(directory, "payload");
    const actualPaths = filesBelow(payloadRoot).map((filename) => path.relative(payloadRoot, filename).split(path.sep).join("/"));
    const declaredPaths = manifest.files.map((file) => file.path);
    if (new Set(declaredPaths).size !== declaredPaths.length) throw new Error("Backup manifest contains duplicate file entries.");
    if (JSON.stringify([...declaredPaths].sort()) !== JSON.stringify(actualPaths)) {
      throw new Error("Backup payload does not exactly match its manifest.");
    }
    for (const file of manifest.files) {
      const filename = path.join(payloadRoot, ...file.path.split("/"));
      const stat = fs.statSync(filename);
      if (stat.size !== file.bytes || sha256(filename) !== file.sha256) {
        throw new Error(`Backup integrity check failed for ${file.path}.`);
      }
    }
    return manifest;
  }

  upgrade(
    targetVersion: string,
    migrateData: (dataDirectory: string) => void = () => undefined,
  ): { metadata: PilotInstallationMetadata; backup: PilotBackupManifest } {
    const current = this.inspect();
    if (current.lifecycle !== "active") throw new Error("Only an active installation can be upgraded.");
    if (current.productVersion === targetVersion) throw new Error("Installation already uses the requested product version.");
    const backup = this.backup(`pre-upgrade-${current.productVersion}-to-${targetVersion}`);
    try {
      migrateData(this.dataDirectory);
      const metadata = metadataSchema.parse({
        ...current,
        productVersion: targetVersion,
        lastBackupId: backup.backupId,
        updatedAt: nowIso(),
      });
      writeJsonAtomic(this.metadataFilename, metadata);
      return { metadata, backup };
    } catch (error) {
      this.restore(backup.backupId);
      throw new Error(`Pilot upgrade failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  restore(backupId: string): PilotInstallationMetadata {
    const current = this.inspect();
    if (current.authorityRecovery) throw new Error("Ordinary restore cannot bypass an unresolved authority-recovery gate.");
    const manifest = this.verifyBackup(backupId);
    const payload = path.join(this.backupsDirectory, backupId, "payload");
    const savedMetadata = metadataSchema.parse(JSON.parse(fs.readFileSync(path.join(payload, "installation.json"), "utf8")));
    if (fs.existsSync(this.dataDirectory)) fs.rmSync(this.dataDirectory, { recursive: true, force: true });
    copyDirectory(path.join(payload, "data"), this.dataDirectory);
    writeJsonAtomic(this.metadataFilename, { ...savedMetadata, lastBackupId: manifest.backupId, updatedAt: nowIso() });
    return this.inspect();
  }

  /**
   * Restores package data while deliberately publishing a deactivated,
   * non-authorizing installation. Reactivation requires the exact fresh
   * workspace-authority binding described by the recovery gate.
   */
  restoreAuthorityGated(backupId: string, authorityRecovery: PilotAuthorityRecoveryGate): PilotInstallationMetadata {
    const gate = metadataSchema.shape.authorityRecovery.unwrap().parse(authorityRecovery);
    const current = this.inspect();
    if (current.authorityRecovery) throw new Error("Package already has an unresolved authority-recovery gate.");
    const manifest = this.verifyBackup(backupId);
    const payload = path.join(this.backupsDirectory, backupId, "payload");
    const savedMetadata = metadataSchema.parse(JSON.parse(fs.readFileSync(path.join(payload, "installation.json"), "utf8")));
    if (savedMetadata.installationId !== current.installationId || manifest.installationId !== current.installationId) {
      throw new Error("Authority-gated recovery cannot cross installation identity.");
    }
    const stopping = metadataSchema.parse({
      ...current,
      lifecycle: "deactivated",
      deactivationReason: "Authority-trust recovery is in progress; execution remains disabled.",
      authorityRecovery: gate,
      updatedAt: nowIso(),
    });
    writeJsonAtomic(this.metadataFilename, stopping);
    try {
      if (fs.existsSync(this.dataDirectory)) fs.rmSync(this.dataDirectory, { recursive: true, force: true });
      copyDirectory(path.join(payload, "data"), this.dataDirectory);
      const recovered = metadataSchema.parse({
        ...savedMetadata,
        lifecycle: "deactivated",
        deactivationReason: "Recovered package is audit-only until a fresh signed workspace-authority activation is registered.",
        authorityRecovery: gate,
        lastBackupId: manifest.backupId,
        updatedAt: nowIso(),
      });
      writeJsonAtomic(this.metadataFilename, recovered);
      return this.inspect();
    } catch (error) {
      writeJsonAtomic(this.metadataFilename, stopping);
      throw error;
    }
  }

  deactivate(reason: string): PilotInstallationMetadata {
    const current = this.inspect();
    const metadata = metadataSchema.parse({
      ...current,
      lifecycle: "deactivated",
      deactivationReason: reason,
      updatedAt: nowIso(),
    });
    writeJsonAtomic(this.metadataFilename, metadata);
    return metadata;
  }

  reactivate(): PilotInstallationMetadata {
    const current = this.inspect();
    if (current.authorityRecovery) throw new Error("Recovered package requires a fresh signed workspace-authority activation; ordinary reactivation is forbidden.");
    const { deactivationReason: _reason, ...rest } = current;
    const metadata = metadataSchema.parse({ ...rest, lifecycle: "active", updatedAt: nowIso() });
    writeJsonAtomic(this.metadataFilename, metadata);
    return metadata;
  }


  reactivateAfterAuthorityRecovery(input: {
    binding: CustomerLocalHttpAuthorityTrustBinding;
    authorityRestoreReceiptDigest: string;
    packageRecoveryReceiptDigest: string;
    continuityGuard: CustomerLocalAuthorityContinuityGuard;
  }): PilotInstallationMetadata {
    const current = this.inspect();
    const gate = current.authorityRecovery;
    if (!gate) throw new Error("Package has no authority-recovery gate to clear.");
    if (gate.authorityRestoreReceiptDigest !== input.authorityRestoreReceiptDigest) throw new Error("Authority restore receipt does not match the package recovery gate.");
    assertTrustedCustomerLocalHttpAuthorityTrustBinding(input.binding);
    assertTrustedCustomerLocalAuthorityContinuityGuard(input.continuityGuard);
    input.binding.assertCurrent();
    if (input.binding.workspaceId !== gate.workspaceId || input.binding.authorityContractDigest !== gate.authorityContractDigest
      || input.binding.trustConfigurationDigest !== gate.trustConfigurationDigest
      || input.binding.authorityTrustStatePathDigest !== gate.authorityTrustStatePathDigest
      || Date.parse(input.binding.activationReceipt.issuedAt) <= Date.parse(gate.restoredAt)) {
      throw new Error("Package recovery requires the exact contract, trust scope, and a strictly post-restore signed activation.");
    }
    const continuity = input.continuityGuard;
    if (continuity.anchorConfigurationDigest !== gate.continuityAnchorConfigurationDigest
      || continuity.recoveryManifestDigest !== gate.continuityRecoveryManifestDigest
      || continuity.recoveryCheckpointDigest !== gate.continuityRecoveryCheckpointDigest
      || continuity.completionGeneration <= gate.continuityRecoveryGeneration
      || continuity.recoveryReceiptDigest !== input.packageRecoveryReceiptDigest
      || continuity.installationId !== current.installationId || continuity.workspaceId !== gate.workspaceId
      || continuity.authorityContractDigest !== gate.authorityContractDigest || continuity.trustConfigurationDigest !== gate.trustConfigurationDigest) throw new Error("Package recovery continuity guard differs from the exact external restore completion.");
    const { assertCurrent: _assertCurrent, withCurrentConsumption: _withCurrentConsumption, ...authorityContinuity } = continuity;
    const { deactivationReason: _reason, authorityRecovery: _gate, ...rest } = current;
    const metadata = metadataSchema.parse({ ...rest, lifecycle: "active", authorityContinuity, updatedAt: nowIso() });
    writeJsonAtomic(this.metadataFilename, metadata);
    return metadata;
  }

  /**
   * Exports and verifies a final archive before removing runtime state. The
   * archive is outside the installation root and is never removed here.
   */
  uninstall(archiveDirectory: string): { archiveDirectory: string; manifest: PilotBackupManifest } {
    const current = this.inspect();
    const archive = path.resolve(archiveDirectory);
    if (archive === this.rootDirectory || archive.startsWith(`${this.rootDirectory}${path.sep}`)) {
      throw new Error("Uninstall archive must be outside the installation directory.");
    }
    if (fs.existsSync(archive)) throw new Error("Uninstall archive path already exists.");
    const timestamp = nowIso();
    const uninstalled = metadataSchema.parse({
      ...current,
      lifecycle: "uninstalled",
      deactivationReason: "Customer-local uninstall completed after verified evidence export.",
      updatedAt: timestamp,
    });
    writeJsonAtomic(this.metadataFilename, uninstalled);
    fs.mkdirSync(archive, { recursive: false, mode: 0o700 });
    copyDirectory(this.dataDirectory, path.join(archive, "payload", "data"));
    fs.copyFileSync(this.metadataFilename, path.join(archive, "payload", "installation.json"));
    const payloadRoot = path.join(archive, "payload");
    const files = filesBelow(payloadRoot).map((filename) => ({
      path: path.relative(payloadRoot, filename),
      bytes: fs.statSync(filename).size,
      sha256: sha256(filename),
    }));
    const manifest = backupManifestSchema.parse({
      schemaVersion: "1.0",
      backupId: `uninstall-${createHash("sha256").update(`${current.installationId}\u001f${timestamp}`).digest("hex").slice(0, 20)}`,
      installationId: current.installationId,
      productVersion: current.productVersion,
      reason: "verified-uninstall-archive",
      files,
      createdAt: timestamp,
    });
    writeJsonAtomic(path.join(archive, "manifest.json"), manifest);
    for (const file of manifest.files) {
      if (sha256(path.join(payloadRoot, file.path)) !== file.sha256) throw new Error("Uninstall archive verification failed.");
    }
    fs.rmSync(this.rootDirectory, { recursive: true, force: true });
    return { archiveDirectory: archive, manifest };
  }

  private backupRaw(
    reason: string,
    metadata: PilotInstallationMetadata | LegacyInstallationMetadata,
  ): PilotBackupManifest {
    if (!reason || reason.length > 1_000) throw new Error("Backup reason must be present and bounded.");
    const createdAt = nowIso();
    const backupId = `backup-${createHash("sha256").update(`${metadata.installationId}\u001f${createdAt}\u001f${reason}`).digest("hex").slice(0, 20)}`;
    const directory = path.join(this.backupsDirectory, backupId);
    const payload = path.join(directory, "payload");
    fs.mkdirSync(payload, { recursive: true, mode: 0o700 });
    writeJsonAtomic(path.join(payload, "installation.json"), metadata);
    copyDirectory(this.dataDirectory, path.join(payload, "data"));
    const files = filesBelow(payload).map((filename) => ({
      path: path.relative(payload, filename),
      bytes: fs.statSync(filename).size,
      sha256: sha256(filename),
    }));
    const manifest = backupManifestSchema.parse({
      schemaVersion: "1.0",
      backupId,
      installationId: metadata.installationId,
      productVersion: metadata.productVersion,
      reason,
      files,
      createdAt,
    });
    writeJsonAtomic(path.join(directory, "manifest.json"), manifest);
    return this.verifyBackup(backupId);
  }
}
