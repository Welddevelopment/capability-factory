import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  capabilityModeSchema,
  type CapabilityMode,
} from "./capability-mode-contract.js";
import {
  CapabilityModeJobService,
  CapabilityModeJobStore,
} from "./capability-mode-jobs.js";
import {
  CapabilityModeRouter,
  type CapabilityModeRunner,
} from "./capability-mode-router.js";
import {
  DirectorySecretProvider,
  type ScopedSecretDescriptor,
} from "./secrets.js";
import { redactText, redactValue } from "./redaction.js";
import { createCapabilitySidecar } from "./sidecar.js";

export const CAPABILITY_MODE_PACKAGE_SCHEMA_VERSION = "1.0" as const;

export interface CapabilityModePackageContract {
  path: string;
  sha256: string;
}

export interface CapabilityModePackageRegistration {
  capabilityMode: CapabilityMode;
  driverVersion: string;
  contractFiles: CapabilityModePackageContract[];
  requiredSecrets: ScopedSecretDescriptor[];
}

export interface CapabilityModePackageConfig {
  schemaVersion: typeof CAPABILITY_MODE_PACKAGE_SCHEMA_VERSION;
  installation: {
    installationId: string;
    productVersion: string;
    lifecycle: "active" | "deactivated";
    deactivationReason?: string | undefined;
  };
  tenantId: string;
  bind: { host: "127.0.0.1"; port: number };
  files: {
    accessToken: string;
    modeJobsDatabase: string;
    stateDirectory: string;
    secretsDirectory: string;
    backupsDirectory: string;
  };
  modes: CapabilityModePackageRegistration[];
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityModePackageReadinessCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface CapabilityModePackageReadiness {
  ready: boolean;
  checks: CapabilityModePackageReadinessCheck[];
  checkedAt: string;
}

export interface CapabilityModePackageBackupManifest {
  schemaVersion: "1.0";
  backupId: string;
  installationId: string;
  productVersion: string;
  reason: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  createdAt: string;
}

export interface CapabilityModePackageEvidenceExport {
  schemaVersion: "1.0";
  installation: CapabilityModePackageConfig["installation"];
  tenantId: string;
  bind: CapabilityModePackageConfig["bind"];
  modes: Array<{
    capabilityMode: CapabilityMode;
    driverVersion: string;
    contracts: CapabilityModePackageContract[];
    requiredSecretAliases: string[];
  }>;
  readiness: CapabilityModePackageReadiness;
  suppliedReportSha256: string;
  suppliedReport: unknown;
  guarantees: {
    secretValuesIncluded: false;
    customerPayloadsIncludedByPackage: false;
    immutableOutput: true;
  };
  exportedAt: string;
}

export interface CapabilityModePackageSupportBundle {
  schemaVersion: "1.0";
  installation: CapabilityModePackageConfig["installation"];
  modes: Array<{ capabilityMode: CapabilityMode; driverVersion: string }>;
  readiness: CapabilityModePackageReadiness;
  storage: Array<{ role: string; present: boolean; private: boolean }>;
  guarantees: {
    secretValuesIncluded: false;
    customerPayloadsIncluded: false;
    immutableOutput: true;
  };
  exportedAt: string;
}

export interface CapabilityModePackageRuntimeContext {
  rootDirectory: string;
  stateDirectory: string;
  tenantId: string;
  secrets: DirectorySecretProvider;
  registrations: CapabilityModePackageRegistration[];
}

export type CapabilityModePackageRunnerFactory = (
  context: CapabilityModePackageRuntimeContext,
) => Promise<CapabilityModeRunner[]> | CapabilityModeRunner[];

export interface BuiltCapabilityModePackageSidecar {
  app: FastifyInstance;
  config: CapabilityModePackageConfig;
  close(): Promise<void>;
}

const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.-]+$/);
const relativePath = z.string().min(1).max(500).refine((value) => {
  if (path.isAbsolute(value) || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}, "Package paths must be normalized relative POSIX paths without traversal.");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const secretDescriptorSchema: z.ZodType<ScopedSecretDescriptor> = z.object({
  alias: identifier,
  version: identifier,
  scope: z.object({
    targetAliases: z.array(identifier).min(1).max(64),
    actionNames: z.array(identifier).min(1).max(64),
    methods: z.array(z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "BROWSER"])).min(1).max(6),
  }).strict(),
}).strict();
const registrationSchema: z.ZodType<CapabilityModePackageRegistration> = z.object({
  capabilityMode: capabilityModeSchema,
  driverVersion: identifier,
  contractFiles: z.array(z.object({
    path: relativePath,
    sha256: digest,
  }).strict()).min(1).max(64),
  requiredSecrets: z.array(secretDescriptorSchema).max(64),
}).strict();
const configSchema: z.ZodType<CapabilityModePackageConfig> = z.object({
  schemaVersion: z.literal(CAPABILITY_MODE_PACKAGE_SCHEMA_VERSION),
  installation: z.object({
    installationId: identifier,
    productVersion: identifier,
    lifecycle: z.enum(["active", "deactivated"]),
    deactivationReason: z.string().min(1).max(1_000).optional(),
  }).strict(),
  tenantId: identifier,
  bind: z.object({
    host: z.literal("127.0.0.1"),
    port: z.number().int().min(1).max(65_535),
  }).strict(),
  files: z.object({
    accessToken: relativePath,
    modeJobsDatabase: relativePath,
    stateDirectory: relativePath,
    secretsDirectory: relativePath,
    backupsDirectory: relativePath,
  }).strict(),
  modes: z.array(registrationSchema).min(1).max(16),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
const backupManifestSchema: z.ZodType<CapabilityModePackageBackupManifest> = z.object({
  schemaVersion: z.literal("1.0"),
  backupId: identifier,
  installationId: identifier,
  productVersion: identifier,
  reason: z.string().min(1).max(1_000),
  files: z.array(z.object({
    path: relativePath,
    bytes: z.number().int().nonnegative(),
    sha256: digest,
  }).strict()),
  createdAt: z.string().datetime(),
}).strict();

function nowIso(): string {
  return new Date().toISOString();
}

function sha256(filename: string): string {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function regularFile(filename: string): boolean {
  try {
    const stat = fs.lstatSync(filename);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function privateFile(filename: string): boolean {
  return regularFile(filename) && (fs.statSync(filename).mode & 0o077) === 0;
}

function privateDirectory(directory: string): boolean {
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function writePrivateFile(filename: string, value: string): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filename, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.chmodSync(filename, 0o600);
}

function writeJsonAtomic(filename: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  fs.renameSync(temporary, filename);
  fs.chmodSync(filename, 0o600);
}

function filesBelow(root: string, skippedTopLevel = new Set<string>()): string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  const walk = (directory: string, depth: number) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (depth === 0 && skippedTopLevel.has(entry.name)) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Capability-mode package backup refuses symbolic links.");
      if (entry.isDirectory()) walk(filename, depth + 1);
      else if (entry.isFile()) found.push(filename);
      else throw new Error("Capability-mode package backup supports regular files only.");
    }
  };
  walk(root, 0);
  return found.sort();
}

function copyPrivateFile(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
}

async function portAvailable(host: "127.0.0.1", port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

function uniqueRegistrationChecks(registrations: CapabilityModePackageRegistration[]): void {
  const modes = new Set<CapabilityMode>();
  const contractPaths = new Set<string>();
  const secretScopes = new Map<string, string>();
  for (const registration of registrations) {
    if (modes.has(registration.capabilityMode)) {
      throw new Error(`Duplicate packaged capability mode: ${registration.capabilityMode}`);
    }
    modes.add(registration.capabilityMode);
    for (const contract of registration.contractFiles) {
      if (contractPaths.has(contract.path)) throw new Error(`Duplicate packaged contract path: ${contract.path}`);
      contractPaths.add(contract.path);
    }
    for (const secret of registration.requiredSecrets) {
      const encoded = JSON.stringify(secret);
      const existing = secretScopes.get(secret.alias);
      if (existing && existing !== encoded) {
        throw new Error(`Secret alias has conflicting packaged scopes: ${secret.alias}`);
      }
      secretScopes.set(secret.alias, encoded);
    }
  }
}

/** Additive customer-local package for experimental drivers. It does not widen the HTTP pilot metadata. */
export class CapabilityModePackageManager {
  readonly configFilename: string;
  private readonly portProbe: (host: "127.0.0.1", port: number) => Promise<boolean>;

  constructor(
    readonly rootDirectory: string,
    options: { portProbe?: (host: "127.0.0.1", port: number) => Promise<boolean> } = {},
  ) {
    this.rootDirectory = path.resolve(rootDirectory);
    this.configFilename = path.join(this.rootDirectory, "capability-mode-package.json");
    this.portProbe = options.portProbe ?? portAvailable;
  }

  initialize(input: {
    installationId: string;
    productVersion: string;
    tenantId: string;
    port?: number;
    modes: Array<{
      capabilityMode: CapabilityMode;
      driverVersion: string;
      contractFiles: Array<{ sourcePath: string; packagedName: string }>;
      requiredSecrets?: ScopedSecretDescriptor[];
    }>;
  }): CapabilityModePackageConfig {
    if (fs.existsSync(this.rootDirectory)) {
      throw new Error("Capability-mode package root already exists; initialization will not overwrite it.");
    }
    const timestamp = nowIso();
    const registrations: CapabilityModePackageRegistration[] = input.modes.map((mode) => ({
      capabilityMode: mode.capabilityMode,
      driverVersion: mode.driverVersion,
      contractFiles: mode.contractFiles.map((contract) => {
        const source = path.resolve(contract.sourcePath);
        if (!regularFile(source)) throw new Error("Trusted contract source must be a regular non-symlink file.");
        const packaged = relativePath.parse(
          `contracts/${mode.capabilityMode}/${identifier.parse(contract.packagedName)}`,
        );
        return { path: packaged, sha256: sha256(source) };
      }),
      requiredSecrets: mode.requiredSecrets ?? [],
    }));
    uniqueRegistrationChecks(registrations);
    const config = configSchema.parse({
      schemaVersion: CAPABILITY_MODE_PACKAGE_SCHEMA_VERSION,
      installation: {
        installationId: input.installationId,
        productVersion: input.productVersion,
        lifecycle: "active",
      },
      tenantId: input.tenantId,
      bind: { host: "127.0.0.1", port: input.port ?? 4318 },
      files: {
        accessToken: "secrets/sidecar-access-token",
        modeJobsDatabase: "data/capability-mode-jobs.sqlite",
        stateDirectory: "data/mode-state",
        secretsDirectory: "secrets/mode-values",
        backupsDirectory: "backups",
      },
      modes: registrations,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    try {
      fs.mkdirSync(this.rootDirectory, { recursive: false, mode: 0o700 });
      fs.mkdirSync(this.resolve(config.files.stateDirectory), { recursive: true, mode: 0o700 });
      fs.mkdirSync(this.resolve(config.files.secretsDirectory), { recursive: true, mode: 0o700 });
      fs.mkdirSync(this.resolve(config.files.backupsDirectory), { recursive: true, mode: 0o700 });
      writePrivateFile(this.resolve(config.files.accessToken), randomBytes(32).toString("base64url"));
      for (const [modeIndex, mode] of input.modes.entries()) {
        for (const [contractIndex, contract] of mode.contractFiles.entries()) {
          const destination = this.resolve(registrations[modeIndex]!.contractFiles[contractIndex]!.path);
          fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
          fs.copyFileSync(path.resolve(contract.sourcePath), destination, fs.constants.COPYFILE_EXCL);
          fs.chmodSync(destination, 0o600);
        }
      }
      writeJsonAtomic(this.configFilename, config);
      return structuredClone(config);
    } catch (error) {
      if (fs.existsSync(this.rootDirectory)) fs.rmSync(this.rootDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  readConfig(): CapabilityModePackageConfig {
    if (!privateFile(this.configFilename)) {
      throw new Error("Capability-mode package config is missing, linked, or has unsafe permissions.");
    }
    const config = configSchema.parse(JSON.parse(fs.readFileSync(this.configFilename, "utf8")));
    uniqueRegistrationChecks(config.modes);
    return config;
  }

  readAccessTokenForLocalClient(): string {
    const config = this.readConfig();
    const filename = this.resolve(config.files.accessToken);
    if (!privateFile(filename)) throw new Error("Customer-local sidecar token is missing or unsafe.");
    const value = fs.readFileSync(filename, "utf8").trim();
    if (Buffer.byteLength(value) < 32) throw new Error("Customer-local sidecar token is too short.");
    return value;
  }

  writeSecret(alias: string, value: string): void {
    const config = this.readConfig();
    const known = new Set(config.modes.flatMap((mode) => mode.requiredSecrets.map((secret) => secret.alias)));
    if (!known.has(alias)) throw new Error(`Secret alias is not declared by this package: ${alias}`);
    if (!value || Buffer.byteLength(value) > 16_384) throw new Error("Secret value has an invalid size.");
    writePrivateFile(path.join(this.resolve(config.files.secretsDirectory), identifier.parse(alias)), value);
  }

  secretProvider(): DirectorySecretProvider {
    const config = this.readConfig();
    const descriptors = new Map<string, ScopedSecretDescriptor>();
    for (const descriptor of config.modes.flatMap((mode) => mode.requiredSecrets)) {
      descriptors.set(descriptor.alias, descriptor);
    }
    return new DirectorySecretProvider(this.resolve(config.files.secretsDirectory), [...descriptors.values()]);
  }

  stateDirectory(mode: CapabilityMode): string {
    const config = this.readConfig();
    if (!config.modes.some((item) => item.capabilityMode === mode)) {
      throw new Error(`Capability mode is not packaged: ${mode}`);
    }
    const directory = path.join(this.resolve(config.files.stateDirectory), mode);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  deactivate(reason: string): CapabilityModePackageConfig {
    const config = this.readConfig();
    const safeReason = redactText(reason).trim();
    if (!safeReason || safeReason.length > 1_000) throw new Error("Deactivation reason must be bounded.");
    const next = configSchema.parse({
      ...config,
      installation: {
        ...config.installation,
        lifecycle: "deactivated",
        deactivationReason: safeReason,
      },
      updatedAt: nowIso(),
    });
    writeJsonAtomic(this.configFilename, next);
    return structuredClone(next);
  }

  backup(reason: string): CapabilityModePackageBackupManifest {
    const config = this.readConfig();
    const safeReason = redactText(reason).trim();
    if (!safeReason || safeReason.length > 1_000) throw new Error("Backup reason must be bounded.");
    const activeJournal = filesBelow(this.rootDirectory, new Set(["backups"]))
      .find((filename) => filename.endsWith("-wal") || filename.endsWith("-shm"));
    if (activeJournal) {
      throw new Error("Capability-mode package backup requires the local sidecar to be stopped and SQLite journals closed.");
    }
    const backupId = `backup-${new Date().toISOString().replaceAll(/[^0-9]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    const backupRoot = path.join(this.resolve(config.files.backupsDirectory), backupId);
    const payloadRoot = path.join(backupRoot, "payload");
    fs.mkdirSync(payloadRoot, { recursive: true, mode: 0o700 });
    try {
      const files = filesBelow(this.rootDirectory, new Set([path.basename(config.files.backupsDirectory)]));
      const manifestFiles = files.map((filename) => {
        const relative = path.relative(this.rootDirectory, filename).split(path.sep).join("/");
        const destination = path.join(payloadRoot, ...relative.split("/"));
        copyPrivateFile(filename, destination);
        const stat = fs.statSync(filename);
        return { path: relative, bytes: stat.size, sha256: sha256(filename) };
      });
      const manifest = backupManifestSchema.parse({
        schemaVersion: "1.0",
        backupId,
        installationId: config.installation.installationId,
        productVersion: config.installation.productVersion,
        reason: safeReason,
        files: manifestFiles,
        createdAt: nowIso(),
      });
      writeJsonAtomic(path.join(backupRoot, "manifest.json"), manifest);
      return structuredClone(manifest);
    } catch (error) {
      fs.rmSync(backupRoot, { recursive: true, force: true });
      throw error;
    }
  }

  verifyBackup(backupId: string): CapabilityModePackageBackupManifest {
    const config = this.readConfig();
    const safeBackupId = identifier.parse(backupId);
    const backupRoot = path.join(this.resolve(config.files.backupsDirectory), safeBackupId);
    const manifestFilename = path.join(backupRoot, "manifest.json");
    if (!privateFile(manifestFilename)) throw new Error("Capability-mode package backup manifest is missing or unsafe.");
    const manifest = backupManifestSchema.parse(JSON.parse(fs.readFileSync(manifestFilename, "utf8")));
    if (manifest.backupId !== safeBackupId) throw new Error("Backup identity does not match its directory.");
    if (manifest.installationId !== config.installation.installationId) {
      throw new Error("Backup belongs to a different capability-mode installation.");
    }
    const payloadRoot = path.join(backupRoot, "payload");
    const actual = filesBelow(payloadRoot)
      .map((filename) => path.relative(payloadRoot, filename).split(path.sep).join("/"));
    const declared = manifest.files.map((file) => file.path);
    if (new Set(declared).size !== declared.length || JSON.stringify(actual) !== JSON.stringify([...declared].sort())) {
      throw new Error("Backup payload does not exactly match its manifest.");
    }
    for (const file of manifest.files) {
      const filename = path.join(payloadRoot, ...file.path.split("/"));
      const stat = fs.statSync(filename);
      if (stat.size !== file.bytes || sha256(filename) !== file.sha256) {
        throw new Error(`Backup integrity check failed for ${file.path}.`);
      }
    }
    return structuredClone(manifest);
  }

  restore(backupId: string): CapabilityModePackageConfig {
    const config = this.readConfig();
    const manifest = this.verifyBackup(backupId);
    const backupsName = path.basename(config.files.backupsDirectory);
    const payloadRoot = path.join(this.resolve(config.files.backupsDirectory), manifest.backupId, "payload");
    for (const entry of fs.readdirSync(this.rootDirectory, { withFileTypes: true })) {
      if (entry.name === backupsName) continue;
      fs.rmSync(path.join(this.rootDirectory, entry.name), { recursive: true, force: true });
    }
    for (const filename of filesBelow(payloadRoot)) {
      const relative = path.relative(payloadRoot, filename);
      copyPrivateFile(filename, path.join(this.rootDirectory, relative));
    }
    return this.readConfig();
  }

  async exportEvidence(input: {
    reportPath: string;
    outputPath: string;
  }): Promise<CapabilityModePackageEvidenceExport> {
    const output = path.resolve(input.outputPath);
    if (fs.existsSync(output)) throw new Error("Evidence export path already exists; exports are immutable.");
    const reportPath = path.resolve(input.reportPath);
    if (!regularFile(reportPath)) throw new Error("Evidence input must be a regular non-symlink file.");
    const bytes = fs.readFileSync(reportPath);
    if (bytes.byteLength > 10_000_000) throw new Error("Evidence input exceeds the 10 MB local export limit.");
    const report: unknown = JSON.parse(bytes.toString("utf8"));
    const config = this.readConfig();
    const exported: CapabilityModePackageEvidenceExport = {
      schemaVersion: "1.0",
      installation: structuredClone(config.installation),
      tenantId: config.tenantId,
      bind: structuredClone(config.bind),
      modes: config.modes.map((mode) => ({
        capabilityMode: mode.capabilityMode,
        driverVersion: mode.driverVersion,
        contracts: structuredClone(mode.contractFiles),
        requiredSecretAliases: mode.requiredSecrets.map((secret) => secret.alias).sort(),
      })),
      readiness: await this.readiness(),
      suppliedReportSha256: createHash("sha256").update(bytes).digest("hex"),
      suppliedReport: redactValue(report),
      guarantees: {
        secretValuesIncluded: false,
        customerPayloadsIncludedByPackage: false,
        immutableOutput: true,
      },
      exportedAt: nowIso(),
    };
    writeJsonAtomic(output, exported);
    return structuredClone(exported);
  }

  async exportSupportBundle(outputPath: string): Promise<CapabilityModePackageSupportBundle> {
    const output = path.resolve(outputPath);
    if (fs.existsSync(output)) throw new Error("Support bundle path already exists; exports are immutable.");
    const config = this.readConfig();
    const entries = [
      ["mode-jobs", config.files.modeJobsDatabase],
      ["mode-state", config.files.stateDirectory],
      ["mode-secrets", config.files.secretsDirectory],
      ["backups", config.files.backupsDirectory],
    ] as const;
    const exported: CapabilityModePackageSupportBundle = {
      schemaVersion: "1.0",
      installation: structuredClone(config.installation),
      modes: config.modes.map((mode) => ({
        capabilityMode: mode.capabilityMode,
        driverVersion: mode.driverVersion,
      })),
      readiness: redactValue(await this.readiness()) as CapabilityModePackageReadiness,
      storage: entries.map(([role, relative]) => {
        const filename = this.resolve(relative);
        return {
          role,
          present: fs.existsSync(filename),
          private: fs.existsSync(filename) && (fs.statSync(filename).mode & 0o077) === 0,
        };
      }),
      guarantees: {
        secretValuesIncluded: false,
        customerPayloadsIncluded: false,
        immutableOutput: true,
      },
      exportedAt: nowIso(),
    };
    writeJsonAtomic(output, exported);
    return structuredClone(exported);
  }

  async readiness(): Promise<CapabilityModePackageReadiness> {
    const checks: CapabilityModePackageReadinessCheck[] = [];
    let config: CapabilityModePackageConfig | undefined;
    try {
      config = this.readConfig();
      checks.push({
        id: "package-config",
        passed: true,
        detail: "Package config is valid, private, and keeps each capability mode explicit.",
      });
    } catch (error) {
      checks.push({
        id: "package-config",
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    if (config) {
      checks.push({
        id: "installation-active",
        passed: config.installation.lifecycle === "active",
        detail: "Experimental capability-mode package lifecycle must be active.",
      });
      checks.push({
        id: "bind-address",
        passed: config.bind.host === "127.0.0.1",
        detail: "The reference package binds only to localhost.",
      });
      checks.push({
        id: "port-available",
        passed: await this.portProbe(config.bind.host, config.bind.port),
        detail: "Configured localhost port is available for startup.",
      });
      checks.push({
        id: "access-token",
        passed: privateFile(this.resolve(config.files.accessToken))
          && fs.readFileSync(this.resolve(config.files.accessToken), "utf8").trim().length >= 32,
        detail: "The sidecar access token exists only as a private customer-local file.",
      });
      for (const [role, relative] of [
        ["state-directory", config.files.stateDirectory],
        ["secrets-directory", config.files.secretsDirectory],
        ["backups-directory", config.files.backupsDirectory],
      ] as const) {
        checks.push({
          id: role,
          passed: privateDirectory(this.resolve(relative)),
          detail: `${role} must be a private non-symlink directory.`,
        });
      }
      for (const registration of config.modes) {
        for (const contract of registration.contractFiles) {
          const filename = this.resolve(contract.path);
          checks.push({
            id: `contract:${registration.capabilityMode}:${path.basename(contract.path)}`,
            passed: privateFile(filename) && sha256(filename) === contract.sha256,
            detail: "Trusted contract must remain a private regular file matching its pinned digest.",
          });
        }
        for (const secret of registration.requiredSecrets) {
          const filename = path.join(this.resolve(config.files.secretsDirectory), secret.alias);
          checks.push({
            id: `secret:${registration.capabilityMode}:${secret.alias}`,
            passed: privateFile(filename)
              && fs.statSync(filename).size > 0
              && fs.statSync(filename).size <= 16_384,
            detail: "Required credential must exist as a private customer-local file; its value is never copied into config.",
          });
        }
      }
    }
    return {
      ready: checks.length > 0 && checks.every((check) => check.passed),
      checks,
      checkedAt: nowIso(),
    };
  }

  resolve(relative: string): string {
    const checked = relativePath.parse(relative);
    const resolved = path.resolve(this.rootDirectory, checked);
    if (!resolved.startsWith(`${this.rootDirectory}${path.sep}`)) {
      throw new Error("Capability-mode package path escapes the installation root.");
    }
    return resolved;
  }
}

/** Builds the authenticated durable customer-local sidecar without binding a socket. */
export async function buildCapabilityModePackageSidecar(
  manager: CapabilityModePackageManager,
  factory: CapabilityModePackageRunnerFactory,
): Promise<BuiltCapabilityModePackageSidecar> {
  const readiness = await manager.readiness();
  if (!readiness.ready) {
    throw new Error(
      `Capability-mode package is not ready: ${readiness.checks.filter((check) => !check.passed).map((check) => check.id).join(", ")}`,
    );
  }
  const config = manager.readConfig();
  const runners = await factory({
    rootDirectory: manager.rootDirectory,
    stateDirectory: manager.resolve(config.files.stateDirectory),
    tenantId: config.tenantId,
    secrets: manager.secretProvider(),
    registrations: structuredClone(config.modes),
  });
  const expected = new Map(config.modes.map((mode) => [mode.capabilityMode, mode]));
  if (runners.length !== expected.size) {
    throw new Error("Runtime runner count does not exactly match the packaged capability-mode registrations.");
  }
  for (const runner of runners) {
    const registration = expected.get(runner.descriptor.capabilityMode);
    if (!registration || registration.driverVersion !== runner.descriptor.driverVersion) {
      throw new Error(`Runtime runner does not match its pinned package registration: ${runner.descriptor.capabilityMode}`);
    }
  }
  const jobs = new CapabilityModeJobService(
    new CapabilityModeJobStore(manager.resolve(config.files.modeJobsDatabase)),
    new CapabilityModeRouter(runners),
  );
  const app = createCapabilitySidecar(undefined, { resolve: () => undefined }, {
    accessToken: manager.readAccessTokenForLocalClient(),
    capabilityModeJobs: jobs,
  });
  let closed = false;
  return {
    app,
    config,
    close: async () => {
      if (closed) return;
      closed = true;
      await app.close();
    },
  };
}

/** Starts the experimental-mode package only on its configured loopback address. */
export async function startCapabilityModePackageSidecar(
  manager: CapabilityModePackageManager,
  factory: CapabilityModePackageRunnerFactory,
): Promise<BuiltCapabilityModePackageSidecar & { url: string }> {
  const built = await buildCapabilityModePackageSidecar(manager, factory);
  try {
    await built.app.listen({ host: built.config.bind.host, port: built.config.bind.port });
    return { ...built, url: `http://${built.config.bind.host}:${built.config.bind.port}` };
  } catch (error) {
    await built.close();
    throw error;
  }
}
