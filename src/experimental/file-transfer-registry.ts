import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  experimentalFileTransferCapabilitySchema,
  type ExperimentalFileTransferCapability,
  type ExperimentalFileTransferVerification,
} from "./file-transfer-driver.js";

export interface VerifiedFileTransferCapabilityRecord {
  tenantId: string;
  needKey: string;
  manifest: ExperimentalFileTransferCapability;
  verification: ExperimentalFileTransferVerification;
  origin: `trusted:${string}` | `built:${string}`;
  status: "active" | "quarantined" | "revoked";
  statusReason?: string;
  registeredAt: string;
  lastUsedAt?: string;
  reuseCount: number;
}

export interface FileTransferCapabilityRegistry {
  findActive(tenantId: string, needKey: string, contractHash: string): VerifiedFileTransferCapabilityRecord | undefined;
  register(record: VerifiedFileTransferCapabilityRecord): void;
  markUsed(tenantId: string, capabilityId: string): void;
  setStatus(
    tenantId: string,
    capabilityId: string,
    status: VerifiedFileTransferCapabilityRecord["status"],
    reason?: string,
  ): void;
  list(tenantId: string): VerifiedFileTransferCapabilityRecord[];
}

interface RegistryFile {
  schemaVersion: "1";
  records: VerifiedFileTransferCapabilityRecord[];
}

function clone(record: VerifiedFileTransferCapabilityRecord): VerifiedFileTransferCapabilityRecord {
  return structuredClone(record);
}

/** A separate tenant registry so file capabilities cannot enter the HTTP or browser stores. */
export class PersistentFileTransferCapabilityRegistry implements FileTransferCapabilityRegistry {
  constructor(private readonly rootDirectory: string) {
    fs.mkdirSync(rootDirectory, { recursive: true, mode: 0o700 });
  }

  findActive(
    tenantId: string,
    needKey: string,
    contractHash: string,
  ): VerifiedFileTransferCapabilityRecord | undefined {
    const found = this.read(tenantId).records.find((record) =>
      record.status === "active" &&
      record.needKey === needKey &&
      record.manifest.contractHash === contractHash,
    );
    return found ? clone(found) : undefined;
  }

  register(record: VerifiedFileTransferCapabilityRecord): void {
    if (!record.tenantId) throw new Error("A tenant ID is required for a file-transfer capability.");
    if (!record.verification.passed) {
      throw new Error("A file-transfer capability cannot be registered without passing verification.");
    }
    const safe = clone({
      ...record,
      manifest: experimentalFileTransferCapabilitySchema.parse(record.manifest),
    });
    const data = this.read(record.tenantId);
    const index = data.records.findIndex((candidate) => candidate.manifest.id === safe.manifest.id);
    if (index >= 0) data.records[index] = safe;
    else data.records.push(safe);
    this.write(record.tenantId, data);
  }

  markUsed(tenantId: string, capabilityId: string): void {
    const data = this.read(tenantId);
    const record = data.records.find((candidate) => candidate.manifest.id === capabilityId);
    if (!record) throw new Error(`File-transfer capability not found for tenant: ${capabilityId}`);
    record.lastUsedAt = new Date().toISOString();
    record.reuseCount += 1;
    this.write(tenantId, data);
  }

  setStatus(
    tenantId: string,
    capabilityId: string,
    status: VerifiedFileTransferCapabilityRecord["status"],
    reason?: string,
  ): void {
    const data = this.read(tenantId);
    const record = data.records.find((candidate) => candidate.manifest.id === capabilityId);
    if (!record) throw new Error(`File-transfer capability not found for tenant: ${capabilityId}`);
    record.status = status;
    if (reason) record.statusReason = reason.slice(0, 1_000);
    this.write(tenantId, data);
  }

  list(tenantId: string): VerifiedFileTransferCapabilityRecord[] {
    return this.read(tenantId).records.map(clone);
  }

  private filename(tenantId: string): string {
    return path.join(this.rootDirectory, `${createHash("sha256").update(tenantId).digest("hex")}.json`);
  }

  private read(tenantId: string): RegistryFile {
    const filename = this.filename(tenantId);
    if (!fs.existsSync(filename)) return { schemaVersion: "1", records: [] };
    const raw = JSON.parse(fs.readFileSync(filename, "utf8")) as RegistryFile;
    if (raw.schemaVersion !== "1") throw new Error("Unsupported file-transfer registry schema.");
    return {
      schemaVersion: "1",
      records: raw.records.map((record) => ({
        ...record,
        manifest: experimentalFileTransferCapabilitySchema.parse(record.manifest),
      })),
    };
  }

  private write(tenantId: string, data: RegistryFile): void {
    const filename = this.filename(tenantId);
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, filename);
  }
}
