import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { capabilityManifestSchema, type CapabilityManifest } from "../manifest.js";
import type { VerificationReceipt } from "./contracts.js";

export interface VerifiedCapabilityRecord {
  tenantId: string;
  needKey: string;
  manifest: CapabilityManifest;
  verification: VerificationReceipt;
  origin: "built" | `trusted:${string}`;
  status: "active" | "quarantined" | "revoked";
  registeredAt: string;
  lastUsedAt?: string;
  reuseCount: number;
}

export interface TenantCapabilityStore {
  findActive(tenantId: string, needKey: string, documentationHash: string): VerifiedCapabilityRecord | undefined;
  register(record: VerifiedCapabilityRecord): void;
  markUsed(tenantId: string, capabilityId: string): void;
  setStatus(tenantId: string, capabilityId: string, status: VerifiedCapabilityRecord["status"]): void;
  list(tenantId: string): VerifiedCapabilityRecord[];
}

interface StoreFile {
  schemaVersion: "1";
  records: VerifiedCapabilityRecord[];
}

function clone(record: VerifiedCapabilityRecord): VerifiedCapabilityRecord {
  return structuredClone(record);
}

/**
 * Local reference store. Every tenant receives a separate hashed file, making
 * accidental path traversal and cross-tenant search materially harder.
 */
export class FileTenantCapabilityStore implements TenantCapabilityStore {
  constructor(private readonly rootDirectory: string) {
    fs.mkdirSync(rootDirectory, { recursive: true, mode: 0o700 });
  }

  findActive(tenantId: string, needKey: string, documentationHash: string): VerifiedCapabilityRecord | undefined {
    const found = this.read(tenantId).records.find(
      (record) =>
        record.status === "active" &&
        record.needKey === needKey &&
        record.manifest.provenance.documentationHash === documentationHash,
    );
    return found ? clone(found) : undefined;
  }

  register(record: VerifiedCapabilityRecord): void {
    if (record.tenantId.length === 0) throw new Error("A tenant ID is required");
    const parsed = clone({ ...record, manifest: capabilityManifestSchema.parse(record.manifest) });
    const data = this.read(record.tenantId);
    const index = data.records.findIndex((candidate) => candidate.manifest.id === parsed.manifest.id);
    if (index >= 0) data.records[index] = parsed;
    else data.records.push(parsed);
    this.write(record.tenantId, data);
  }

  markUsed(tenantId: string, capabilityId: string): void {
    const data = this.read(tenantId);
    const record = data.records.find((candidate) => candidate.manifest.id === capabilityId);
    if (!record) throw new Error(`Capability not found for tenant: ${capabilityId}`);
    record.lastUsedAt = new Date().toISOString();
    record.reuseCount += 1;
    this.write(tenantId, data);
  }

  setStatus(tenantId: string, capabilityId: string, status: VerifiedCapabilityRecord["status"]): void {
    const data = this.read(tenantId);
    const record = data.records.find((candidate) => candidate.manifest.id === capabilityId);
    if (!record) throw new Error(`Capability not found for tenant: ${capabilityId}`);
    record.status = status;
    this.write(tenantId, data);
  }

  list(tenantId: string): VerifiedCapabilityRecord[] {
    return this.read(tenantId).records.map(clone);
  }

  private filename(tenantId: string): string {
    const digest = createHash("sha256").update(tenantId).digest("hex");
    return path.join(this.rootDirectory, `${digest}.json`);
  }

  private read(tenantId: string): StoreFile {
    const filename = this.filename(tenantId);
    if (!fs.existsSync(filename)) return { schemaVersion: "1", records: [] };
    const raw = JSON.parse(fs.readFileSync(filename, "utf8")) as StoreFile;
    if (raw.schemaVersion !== "1") throw new Error("Unsupported capability-store schema");
    return {
      schemaVersion: "1",
      records: raw.records.map((record) => ({
        ...record,
        manifest: capabilityManifestSchema.parse(record.manifest),
      })),
    };
  }

  private write(tenantId: string, data: StoreFile): void {
    const filename = this.filename(tenantId);
    const temporary = `${filename}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, filename);
  }
}
