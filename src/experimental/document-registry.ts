import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  experimentalDocumentCapabilitySchema,
  type ExperimentalDocumentCapability,
  type ExperimentalDocumentVerification,
} from "./document-driver.js";

export interface VerifiedDocumentCapabilityRecord {
  tenantId: string;
  needKey: string;
  manifest: ExperimentalDocumentCapability;
  verification: ExperimentalDocumentVerification;
  origin: `trusted:${string}` | `built:${string}`;
  status: "active" | "quarantined" | "revoked";
  statusReason?: string;
  registeredAt: string;
  lastUsedAt?: string;
  reuseCount: number;
}

export interface DocumentCapabilityRegistry {
  findActive(tenantId: string, needKey: string, contractHash: string): VerifiedDocumentCapabilityRecord | undefined;
  register(record: VerifiedDocumentCapabilityRecord): void;
  markUsed(tenantId: string, capabilityId: string): void;
  setStatus(tenantId: string, capabilityId: string, status: VerifiedDocumentCapabilityRecord["status"], reason?: string): void;
  list(tenantId: string): VerifiedDocumentCapabilityRecord[];
}

interface RegistryFile {
  schemaVersion: "1";
  records: VerifiedDocumentCapabilityRecord[];
}

function clone(record: VerifiedDocumentCapabilityRecord): VerifiedDocumentCapabilityRecord {
  return structuredClone(record);
}

export class PersistentDocumentCapabilityRegistry implements DocumentCapabilityRegistry {
  constructor(private readonly rootDirectory: string) {
    fs.mkdirSync(rootDirectory, { recursive: true, mode: 0o700 });
  }

  findActive(tenantId: string, needKey: string, contractHash: string): VerifiedDocumentCapabilityRecord | undefined {
    const found = this.read(tenantId).records.find((record) =>
      record.status === "active" &&
      record.needKey === needKey &&
      record.manifest.contractHash === contractHash,
    );
    return found ? clone(found) : undefined;
  }

  register(record: VerifiedDocumentCapabilityRecord): void {
    if (!record.tenantId) throw new Error("A tenant ID is required for a document capability.");
    if (!record.verification.passed) throw new Error("A document capability requires passing verification.");
    const safe = clone({ ...record, manifest: experimentalDocumentCapabilitySchema.parse(record.manifest) });
    const data = this.read(record.tenantId);
    const index = data.records.findIndex((candidate) => candidate.manifest.id === safe.manifest.id);
    if (index >= 0) data.records[index] = safe;
    else data.records.push(safe);
    this.write(record.tenantId, data);
  }

  markUsed(tenantId: string, capabilityId: string): void {
    const data = this.read(tenantId);
    const record = data.records.find((candidate) => candidate.manifest.id === capabilityId);
    if (!record) throw new Error(`Document capability not found for tenant: ${capabilityId}`);
    record.lastUsedAt = new Date().toISOString();
    record.reuseCount += 1;
    this.write(tenantId, data);
  }

  setStatus(
    tenantId: string,
    capabilityId: string,
    status: VerifiedDocumentCapabilityRecord["status"],
    reason?: string,
  ): void {
    const data = this.read(tenantId);
    const record = data.records.find((candidate) => candidate.manifest.id === capabilityId);
    if (!record) throw new Error(`Document capability not found for tenant: ${capabilityId}`);
    record.status = status;
    if (reason) record.statusReason = reason.slice(0, 1_000);
    this.write(tenantId, data);
  }

  list(tenantId: string): VerifiedDocumentCapabilityRecord[] {
    return this.read(tenantId).records.map(clone);
  }

  private filename(tenantId: string): string {
    return path.join(this.rootDirectory, `${createHash("sha256").update(tenantId).digest("hex")}.json`);
  }

  private read(tenantId: string): RegistryFile {
    const filename = this.filename(tenantId);
    if (!fs.existsSync(filename)) return { schemaVersion: "1", records: [] };
    const raw = JSON.parse(fs.readFileSync(filename, "utf8")) as RegistryFile;
    if (raw.schemaVersion !== "1") throw new Error("Unsupported document-capability registry schema.");
    return {
      schemaVersion: "1",
      records: raw.records.map((record) => ({
        ...record,
        manifest: experimentalDocumentCapabilitySchema.parse(record.manifest),
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
