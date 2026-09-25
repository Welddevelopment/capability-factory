import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  assertAuthorityContinuityEnrollmentStopReceiptIntegrity,
  type AuthorityContinuityEnrollmentStopReceipt,
  type AuthorityContinuityEnrollmentStopRecorder,
} from "./authority-continuity-enrollment-provider.js";

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,179}$/;
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value !== null && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

export interface AuthorityContinuityStopLedgerEntry {
  sequence: number;
  previousHash: string;
  receipt: AuthorityContinuityEnrollmentStopReceipt;
  entryHash: string;
  recordedAt: string;
}

export class DurableAuthorityContinuityStopLedger implements AuthorityContinuityEnrollmentStopRecorder {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(readonly statePath: string, readonly tenantId: string, readonly installationId: string) {
    if (!identifier.test(tenantId) || !identifier.test(installationId)) throw new Error("Authority continuity stop ledger requires exact tenant and installation identities.");
    if (statePath !== ":memory:") mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(statePath);
    this.database.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    if (statePath !== ":memory:") chmodSync(statePath, 0o600);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS authority_continuity_stop_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS authority_continuity_stops(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        previous_hash TEXT NOT NULL,
        receipt_digest TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        entry_hash TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
    `);
    const existing = this.database.prepare("SELECT key,value FROM authority_continuity_stop_meta ORDER BY key").all() as Array<{ key: string; value: string }>;
    if (existing.length === 0) {
      const insert = this.database.prepare("INSERT INTO authority_continuity_stop_meta(key,value) VALUES(?,?)");
      insert.run("schema_version", "1.0"); insert.run("tenant_id", tenantId); insert.run("installation_id", installationId);
    } else {
      const meta = Object.fromEntries(existing.map((row) => [row.key, row.value]));
      if (meta.schema_version !== "1.0" || meta.tenant_id !== tenantId || meta.installation_id !== installationId) throw new Error("Authority continuity stop ledger identity is substituted or incompatible.");
    }
    this.verify();
  }

  record(receipt: AuthorityContinuityEnrollmentStopReceipt): void {
    this.ensureOpen(); assertAuthorityContinuityEnrollmentStopReceiptIntegrity(receipt);
    if (receipt.tenantId !== this.tenantId || receipt.installationId !== this.installationId) throw new Error("Authority continuity stop receipt belongs to another tenant or installation.");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.database.prepare("SELECT entry_hash FROM authority_continuity_stops ORDER BY sequence DESC LIMIT 1").get() as { entry_hash: string } | undefined;
      const previousHash = prior?.entry_hash ?? "0".repeat(64), receiptJson = canonical(receipt), recordedAt = receipt.observedAt;
      const entryHash = hash(`${previousHash}\u001f${receipt.receiptDigest}\u001f${receiptJson}\u001f${recordedAt}`);
      this.database.prepare("INSERT INTO authority_continuity_stops(previous_hash,receipt_digest,receipt_json,entry_hash,recorded_at) VALUES(?,?,?,?,?)").run(previousHash, receipt.receiptDigest, receiptJson, entryHash, recordedAt);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  entries(): AuthorityContinuityStopLedgerEntry[] {
    this.ensureOpen(); this.verify();
    return (this.database.prepare("SELECT sequence,previous_hash,receipt_json,entry_hash,recorded_at FROM authority_continuity_stops ORDER BY sequence").all() as Array<{ sequence: number; previous_hash: string; receipt_json: string; entry_hash: string; recorded_at: string }>).map((row) => ({ sequence: row.sequence, previousHash: row.previous_hash, receipt: JSON.parse(row.receipt_json) as AuthorityContinuityEnrollmentStopReceipt, entryHash: row.entry_hash, recordedAt: row.recorded_at }));
  }

  verify(): { entries: number; finalHash: string } {
    this.ensureOpen();
    const rows = this.database.prepare("SELECT sequence,previous_hash,receipt_digest,receipt_json,entry_hash,recorded_at FROM authority_continuity_stops ORDER BY sequence").all() as Array<{ sequence: number; previous_hash: string; receipt_digest: string; receipt_json: string; entry_hash: string; recorded_at: string }>;
    let previousHash = "0".repeat(64);
    rows.forEach((row, index) => {
      const receipt = JSON.parse(row.receipt_json) as AuthorityContinuityEnrollmentStopReceipt;
      assertAuthorityContinuityEnrollmentStopReceiptIntegrity(receipt);
      const expected = hash(`${previousHash}\u001f${receipt.receiptDigest}\u001f${row.receipt_json}\u001f${row.recorded_at}`);
      if (row.sequence !== index + 1 || row.previous_hash !== previousHash || row.receipt_digest !== receipt.receiptDigest || row.recorded_at !== receipt.observedAt || row.entry_hash !== expected) throw new Error("Authority continuity stop ledger is truncated, reordered, inserted, or tampered.");
      previousHash = row.entry_hash;
    });
    return { entries: rows.length, finalHash: previousHash };
  }

  close(): void { if (!this.closed) { this.closed = true; this.database.close(); } }
  private ensureOpen(): void { if (this.closed) throw new Error("Authority continuity stop ledger is closed."); }
}
