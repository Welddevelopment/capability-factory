import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { FileValidatedGoalPlanStore } from "./broad-goal-sdk.js";
import { FileGoalContinuationRevocationStore, HmacGoalContinuationAuthority } from "./continuation.js";
import type { GoalPlanner } from "./goal-coordination.js";
import { PilotInstallationManager, type PilotInstallationMetadata } from "./installation.js";
import { CustomerLocalOperationalControl } from "./operations.js";
import { createControlledPilotSdk, type ControlledPilotAdapter } from "./pilot-adapter.js";
import { redactValue } from "./redaction.js";
import { createCapabilitySidecar } from "./sidecar.js";
import { SidecarGoalJobService, SidecarGoalJobStore } from "./sidecar-jobs.js";

export const PILOT_PACKAGE_SCHEMA_VERSION = "1.0" as const;

export interface PilotPackageConfig {
  schemaVersion: typeof PILOT_PACKAGE_SCHEMA_VERSION;
  tenantId: string;
  bind: { host: "127.0.0.1"; port: number };
  adapterRuntime: { path: string; sha256: string };
  files: {
    accessToken: string;
    continuationSecret: string;
    operationsDatabase: string;
    goalJobsDatabase: string;
    plansDirectory: string;
    continuationRevocationsDirectory: string;
    capabilityHealthDatabase: string;
  };
  limits: {
    maxWriteAttemptsPerRun: number;
    maxWriteAttemptsPerHour: number;
    maxModelSpendUsdPerDay: number;
    maxJobAttempts: number;
  };
}

export interface PilotReadinessCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface PilotPackageReadiness {
  ready: boolean;
  installationId?: string;
  productVersion?: string;
  checks: PilotReadinessCheck[];
  checkedAt: string;
}

export interface PilotEvidenceExport {
  schemaVersion: "1.0";
  installation: Pick<PilotInstallationMetadata, "installationId" | "productVersion" | "installationMode" | "lifecycle" | "supportedCapabilityModes">;
  package: {
    tenantId: string;
    bindHost: "127.0.0.1";
    bindPort: number;
    adapterRuntimeSha256: string;
    limits: PilotPackageConfig["limits"];
  };
  readiness: PilotPackageReadiness;
  suppliedReportSha256: string;
  suppliedReport: unknown;
  exportedAt: string;
}

export interface PilotSupportBundle {
  schemaVersion: "1.0";
  installation: PilotEvidenceExport["installation"];
  package: PilotEvidenceExport["package"];
  readiness: PilotPackageReadiness;
  storage: Array<{ role: string; present: boolean; private: boolean }>;
  guarantees: {
    secretValuesIncluded: false;
    customerPayloadsIncluded: false;
    immutableOutput: true;
  };
  exportedAt: string;
}

export interface PackagedPilotRuntimeContext {
  rootDirectory: string;
  dataDirectory: string;
  tenantId: string;
  continuationAuthority: HmacGoalContinuationAuthority;
  continuationRevocations: FileGoalContinuationRevocationStore;
  capabilityHealthDatabasePath: string;
  operations: CustomerLocalOperationalControl;
}

export interface PackagedPilotRuntime {
  adapter: ControlledPilotAdapter;
  planner: GoalPlanner;
  close?(): Promise<void> | void;
}

export type PackagedPilotRuntimeFactory = (context: PackagedPilotRuntimeContext) => Promise<PackagedPilotRuntime> | PackagedPilotRuntime;

export interface BuiltPilotPackageSidecar {
  app: FastifyInstance;
  config: PilotPackageConfig;
  close(): Promise<void>;
}

const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.-]+$/);
const relativePath = z.string().min(1).max(500).refine((value) => !path.isAbsolute(value) && !value.split(/[\\/]/).includes(".."));
const positiveInteger = z.number().int().positive();
const configSchema: z.ZodType<PilotPackageConfig> = z.object({
  schemaVersion: z.literal(PILOT_PACKAGE_SCHEMA_VERSION),
  tenantId: identifier,
  bind: z.object({ host: z.literal("127.0.0.1"), port: z.number().int().min(1).max(65_535) }).strict(),
  adapterRuntime: z.object({ path: relativePath, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  files: z.object({
    accessToken: relativePath,
    continuationSecret: relativePath,
    operationsDatabase: relativePath,
    goalJobsDatabase: relativePath,
    plansDirectory: relativePath,
    continuationRevocationsDirectory: relativePath,
    capabilityHealthDatabase: relativePath,
  }).strict(),
  limits: z.object({
    maxWriteAttemptsPerRun: positiveInteger.max(1_000),
    maxWriteAttemptsPerHour: positiveInteger.max(100_000),
    maxModelSpendUsdPerDay: z.number().positive().max(1_000_000),
    maxJobAttempts: positiveInteger.max(10),
  }).strict(),
}).strict();

function nowIso(): string {
  return new Date().toISOString();
}

function hashBytes(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashFile(filename: string): string {
  return hashBytes(fs.readFileSync(filename));
}

function regularFile(filename: string): boolean {
  try {
    const stat = fs.lstatSync(filename);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function secureFile(filename: string): boolean {
  if (!regularFile(filename)) return false;
  return (fs.statSync(filename).mode & 0o077) === 0;
}

function writePrivateFile(filename: string, value: string): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filename, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.chmodSync(filename, 0o600);
}

function writeJsonAtomic(filename: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, filename);
  fs.chmodSync(filename, 0o600);
}

async function portAvailable(host: "127.0.0.1", port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/** Customer-local packaging around the existing installation lifecycle. Secret values never enter config or reports. */
export class PilotPackageManager {
  readonly installation: PilotInstallationManager;
  readonly configFilename: string;

  private readonly portProbe: (host: "127.0.0.1", port: number) => Promise<boolean>;

  constructor(readonly rootDirectory: string, options: { portProbe?: (host: "127.0.0.1", port: number) => Promise<boolean> } = {}) {
    this.rootDirectory = path.resolve(rootDirectory);
    this.installation = new PilotInstallationManager(this.rootDirectory);
    this.configFilename = path.join(this.rootDirectory, "pilot-package.json");
    this.portProbe = options.portProbe ?? portAvailable;
  }

  initialize(input: {
    installationId: string;
    tenantId: string;
    productVersion: string;
    adapterRuntimePath: string;
    port?: number;
    limits?: Partial<PilotPackageConfig["limits"]>;
  }): PilotPackageConfig {
    if (fs.existsSync(this.rootDirectory)) throw new Error("Pilot package root already exists; initialization will not overwrite it.");
    const runtime = path.resolve(input.adapterRuntimePath);
    if (!regularFile(runtime)) throw new Error("Adapter runtime must be a regular, non-symbolic-link file.");
    const config = configSchema.parse({
      schemaVersion: PILOT_PACKAGE_SCHEMA_VERSION,
      tenantId: input.tenantId,
      bind: { host: "127.0.0.1", port: input.port ?? 4317 },
      adapterRuntime: { path: "adapter/runtime.mjs", sha256: hashFile(runtime) },
      files: {
        accessToken: "secrets/sidecar-access-token",
        continuationSecret: "secrets/continuation-secret",
        operationsDatabase: "data/operations.sqlite",
        goalJobsDatabase: "data/goal-jobs.sqlite",
        plansDirectory: "data/plans",
        continuationRevocationsDirectory: "data/continuation-revocations",
        capabilityHealthDatabase: "data/capability-health.sqlite",
      },
      limits: {
        maxWriteAttemptsPerRun: input.limits?.maxWriteAttemptsPerRun ?? 5,
        maxWriteAttemptsPerHour: input.limits?.maxWriteAttemptsPerHour ?? 100,
        maxModelSpendUsdPerDay: input.limits?.maxModelSpendUsdPerDay ?? 5,
        maxJobAttempts: input.limits?.maxJobAttempts ?? 3,
      },
    });
    try {
      this.installation.install({
        installationId: input.installationId,
        productVersion: input.productVersion,
        installationMode: "customer-hosted-sidecar",
      });
      const adapterDestination = this.resolve(config.adapterRuntime.path);
      fs.mkdirSync(path.dirname(adapterDestination), { recursive: true, mode: 0o700 });
      fs.copyFileSync(runtime, adapterDestination, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(adapterDestination, 0o600);
      writePrivateFile(this.resolve(config.files.accessToken), randomBytes(32).toString("base64url"));
      writePrivateFile(this.resolve(config.files.continuationSecret), randomBytes(48).toString("base64url"));
      fs.mkdirSync(this.resolve(config.files.plansDirectory), { recursive: true, mode: 0o700 });
      fs.mkdirSync(this.resolve(config.files.continuationRevocationsDirectory), { recursive: true, mode: 0o700 });
      writeJsonAtomic(this.configFilename, config);
      return structuredClone(config);
    } catch (error) {
      if (fs.existsSync(this.rootDirectory)) fs.rmSync(this.rootDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  readConfig(): PilotPackageConfig {
    if (!secureFile(this.configFilename)) throw new Error("Pilot package config is missing, linked, or has unsafe permissions.");
    return configSchema.parse(JSON.parse(fs.readFileSync(this.configFilename, "utf8")));
  }

  /** Intended only for a customer-local client or server process; callers must never log the returned value. */
  readAccessTokenForLocalClient(): string {
    const config = this.readConfig();
    return this.readSecret(config.files.accessToken, 32);
  }

  readContinuationSecretForLocalRuntime(): string {
    const config = this.readConfig();
    return this.readSecret(config.files.continuationSecret, 32);
  }

  async readiness(): Promise<PilotPackageReadiness> {
    const checks: PilotReadinessCheck[] = [];
    let metadata: PilotInstallationMetadata | undefined;
    let config: PilotPackageConfig | undefined;
    try {
      metadata = this.installation.inspect();
      checks.push({ id: "installation-active", passed: metadata.lifecycle === "active", detail: "Installation lifecycle must be active." });
      checks.push({ id: "installation-mode", passed: metadata.installationMode === "customer-hosted-sidecar", detail: "Installation must use the customer-hosted sidecar mode." });
    } catch (error) {
      checks.push({ id: "installation-metadata", passed: false, detail: error instanceof Error ? error.message : String(error) });
    }
    try {
      config = this.readConfig();
      checks.push({ id: "package-config", passed: true, detail: "Package config is valid and private." });
    } catch (error) {
      checks.push({ id: "package-config", passed: false, detail: error instanceof Error ? error.message : String(error) });
    }
    if (config) {
      const runtime = this.resolve(config.adapterRuntime.path);
      checks.push({ id: "adapter-runtime", passed: regularFile(runtime) && hashFile(runtime) === config.adapterRuntime.sha256, detail: "Adapter runtime is regular and matches its pinned digest." });
      for (const [id, relative] of [["access-token", config.files.accessToken], ["continuation-secret", config.files.continuationSecret]] as const) {
        const filename = this.resolve(relative);
        checks.push({ id, passed: secureFile(filename) && fs.readFileSync(filename, "utf8").trim().length >= 32, detail: `${id} exists only as a private customer-local file.` });
      }
      checks.push({ id: "plans-directory", passed: fs.existsSync(this.resolve(config.files.plansDirectory)) && (fs.statSync(this.resolve(config.files.plansDirectory)).mode & 0o077) === 0, detail: "Validated plans directory is private." });
      checks.push({ id: "continuation-revocations", passed: fs.existsSync(this.resolve(config.files.continuationRevocationsDirectory)) && (fs.statSync(this.resolve(config.files.continuationRevocationsDirectory)).mode & 0o077) === 0, detail: "Continuation revocation records remain private and customer-local." });
      checks.push({ id: "bind-address", passed: config.bind.host === "127.0.0.1", detail: "The reference sidecar binds only to localhost." });
      checks.push({ id: "port-available", passed: await this.portProbe(config.bind.host, config.bind.port), detail: "Configured localhost port is available for startup." });
    }
    return {
      ready: checks.length > 0 && checks.every((check) => check.passed),
      ...(metadata ? { installationId: metadata.installationId, productVersion: metadata.productVersion } : {}),
      checks,
      checkedAt: nowIso(),
    };
  }

  async exportEvidence(input: { reportPath: string; outputPath: string }): Promise<PilotEvidenceExport> {
    const output = path.resolve(input.outputPath);
    if (fs.existsSync(output)) throw new Error("Evidence export path already exists; exports are immutable.");
    const reportPath = path.resolve(input.reportPath);
    if (!regularFile(reportPath)) throw new Error("Evidence input must be a regular, non-symbolic-link file.");
    const reportBytes = fs.readFileSync(reportPath);
    if (reportBytes.byteLength > 10_000_000) throw new Error("Evidence input exceeds the 10 MB local export limit.");
    const report: unknown = JSON.parse(reportBytes.toString("utf8"));
    const metadata = this.installation.inspect();
    const config = this.readConfig();
    const readiness = await this.readiness();
    const exported: PilotEvidenceExport = {
      schemaVersion: "1.0",
      installation: {
        installationId: metadata.installationId,
        productVersion: metadata.productVersion,
        installationMode: metadata.installationMode,
        lifecycle: metadata.lifecycle,
        supportedCapabilityModes: metadata.supportedCapabilityModes,
      },
      package: {
        tenantId: config.tenantId,
        bindHost: config.bind.host,
        bindPort: config.bind.port,
        adapterRuntimeSha256: config.adapterRuntime.sha256,
        limits: config.limits,
      },
      readiness,
      suppliedReportSha256: hashBytes(reportBytes),
      suppliedReport: redactValue(report),
      exportedAt: nowIso(),
    };
    writeJsonAtomic(output, exported);
    return structuredClone(exported);
  }

  async exportSupportBundle(outputPath: string): Promise<PilotSupportBundle> {
    const output = path.resolve(outputPath);
    if (fs.existsSync(output)) throw new Error("Support bundle path already exists; exports are immutable.");
    const metadata = this.installation.inspect();
    const config = this.readConfig();
    const readiness = await this.readiness();
    const storageEntries = [
      ["operations", config.files.operationsDatabase],
      ["goal-jobs", config.files.goalJobsDatabase],
      ["capability-health", config.files.capabilityHealthDatabase],
      ["validated-plans", config.files.plansDirectory],
      ["continuation-revocations", config.files.continuationRevocationsDirectory],
    ] as const;
    const exported: PilotSupportBundle = {
      schemaVersion: "1.0",
      installation: {
        installationId: metadata.installationId,
        productVersion: metadata.productVersion,
        installationMode: metadata.installationMode,
        lifecycle: metadata.lifecycle,
        supportedCapabilityModes: metadata.supportedCapabilityModes,
      },
      package: {
        tenantId: config.tenantId,
        bindHost: config.bind.host,
        bindPort: config.bind.port,
        adapterRuntimeSha256: config.adapterRuntime.sha256,
        limits: config.limits,
      },
      readiness: redactValue(readiness) as PilotPackageReadiness,
      storage: storageEntries.map(([role, relative]) => {
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

  resolve(relative: string): string {
    const checked = relativePath.parse(relative);
    const resolved = path.resolve(this.rootDirectory, checked);
    if (!resolved.startsWith(`${this.rootDirectory}${path.sep}`)) throw new Error("Package path escapes the installation root.");
    return resolved;
  }

  private readSecret(relative: string, minimumBytes: number): string {
    const filename = this.resolve(relative);
    if (!secureFile(filename)) throw new Error("Customer-local secret is missing, linked, or has unsafe permissions.");
    const value = fs.readFileSync(filename, "utf8").trim();
    if (Buffer.byteLength(value) < minimumBytes) throw new Error("Customer-local secret is too short.");
    return value;
  }
}

/** Assembles the real durable sidecar without binding a socket, which also enables safe pre-start verification. */
export async function buildPilotPackageSidecar(
  manager: PilotPackageManager,
  factory: PackagedPilotRuntimeFactory,
): Promise<BuiltPilotPackageSidecar> {
  const readiness = await manager.readiness();
  if (!readiness.ready) {
    throw new Error(`Pilot package is not ready: ${readiness.checks.filter((item) => !item.passed).map((item) => item.id).join(", ")}`);
  }
  const config = manager.readConfig();
  const metadata = manager.installation.inspect();
  const operations = new CustomerLocalOperationalControl(
    manager.resolve(config.files.operationsDatabase),
    config.tenantId,
    config.limits,
  );
  const continuationAuthority = new HmacGoalContinuationAuthority(
    `${metadata.installationId}-continuation`,
    manager.readContinuationSecretForLocalRuntime(),
  );
  const continuationRevocations = new FileGoalContinuationRevocationStore(manager.resolve(config.files.continuationRevocationsDirectory));
  let runtime: PackagedPilotRuntime | undefined;
  let app: FastifyInstance | undefined;
  try {
    runtime = await factory({
      rootDirectory: manager.rootDirectory,
      dataDirectory: manager.installation.dataDirectory,
      tenantId: config.tenantId,
      continuationAuthority,
      continuationRevocations,
      capabilityHealthDatabasePath: manager.resolve(config.files.capabilityHealthDatabase),
      operations,
    });
    const sdk = await createControlledPilotSdk(runtime.adapter, {
      planner: runtime.planner,
      plans: new FileValidatedGoalPlanStore(manager.resolve(config.files.plansDirectory)),
    });
    const jobs = new SidecarGoalJobService(
      new SidecarGoalJobStore(manager.resolve(config.files.goalJobsDatabase)),
      sdk,
      { maxAttempts: config.limits.maxJobAttempts },
    );
    app = createCapabilitySidecar(undefined, { resolve: () => undefined }, {
      accessToken: manager.readAccessTokenForLocalClient(),
      broadGoals: sdk,
      goalJobs: jobs,
    });
    let closed = false;
    return {
      app,
      config,
      close: async () => {
        if (closed) return;
        closed = true;
        await app!.close();
        await runtime!.close?.();
        operations.close();
      },
    };
  } catch (error) {
    if (app) await app.close().catch(() => undefined);
    await runtime?.close?.();
    operations.close();
    throw error;
  }
}

/** Starts the assembled package on its localhost-only configured address. */
export async function startPilotPackageSidecar(
  manager: PilotPackageManager,
  factory: PackagedPilotRuntimeFactory,
  options: { listenHost?: "127.0.0.1" | "0.0.0.0" } = {},
): Promise<BuiltPilotPackageSidecar & { url: string }> {
  const built = await buildPilotPackageSidecar(manager, factory);
  const listenHost = options.listenHost ?? built.config.bind.host;
  try {
    await built.app.listen({ host: listenHost, port: built.config.bind.port });
    return { ...built, url: `http://${built.config.bind.host}:${built.config.bind.port}` };
  } catch (error) {
    await built.close();
    throw error;
  }
}
