import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RuntimeActionControlContext, RuntimeOperationGuard } from "../runtime.js";
import { redactValue } from "./redaction.js";

export type OperationalMode = "running" | "draining" | "halted";
export type OperationalCapabilityStatus = "active" | "quarantined" | "revoked";

export interface OperationalLimits {
  maxWriteAttemptsPerRun: number;
  maxWriteAttemptsPerHour: number;
  maxModelSpendUsdPerDay: number;
}

export interface OperationalAuditEntry {
  sequence: number;
  previousHash: string;
  payload: Record<string, unknown>;
  hash: string;
  occurredAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function hashAudit(previousHash: string, payloadJson: string, occurredAt: string): string {
  return createHash("sha256").update(`${previousHash}\u001f${occurredAt}\u001f${payloadJson}`).digest("hex");
}

function validateLimits(limits: OperationalLimits): OperationalLimits {
  if (!Number.isInteger(limits.maxWriteAttemptsPerRun) || limits.maxWriteAttemptsPerRun < 1) {
    throw new Error("Per-run write limit must be a positive integer.");
  }
  if (!Number.isInteger(limits.maxWriteAttemptsPerHour) || limits.maxWriteAttemptsPerHour < 1) {
    throw new Error("Hourly write limit must be a positive integer.");
  }
  if (!Number.isFinite(limits.maxModelSpendUsdPerDay) || limits.maxModelSpendUsdPerDay <= 0) {
    throw new Error("Daily model-spend limit must be positive.");
  }
  return structuredClone(limits);
}

/** Customer-local operational guard for a single controlled-pilot tenant. */
export class CustomerLocalOperationalControl implements RuntimeOperationGuard {
  private readonly database: DatabaseSync;
  private readonly limits: OperationalLimits;

  constructor(databasePath: string, readonly tenantId: string, limits: OperationalLimits) {
    if (!tenantId) throw new Error("Operational control requires a tenant ID.");
    this.limits = validateLimits(limits);
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS operational_state (
        tenant_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        reason TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operational_capabilities (
        tenant_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, capability_id)
      );
      CREATE TABLE IF NOT EXISTS operational_usage (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        amount REAL NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS operational_usage_lookup
        ON operational_usage (tenant_id, kind, occurred_at, run_id);
      CREATE TABLE IF NOT EXISTS operational_incidents (
        incident_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        severity TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operational_backup_checks (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        backup_id TEXT NOT NULL,
        passed INTEGER NOT NULL,
        detail TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operational_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        hash TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
    `);
    const timestamp = nowIso();
    this.database.prepare(`
      INSERT OR IGNORE INTO operational_state (tenant_id, mode, reason, updated_at)
      VALUES (?, 'running', 'Initial controlled-pilot state.', ?)
    `).run(tenantId, timestamp);
  }

  mode(): OperationalMode {
    return (this.database.prepare("SELECT mode FROM operational_state WHERE tenant_id = ?").get(this.tenantId) as { mode: OperationalMode }).mode;
  }

  setMode(mode: OperationalMode, reason: string): void {
    if (!reason) throw new Error("Operational mode changes require a reason.");
    this.database.prepare("UPDATE operational_state SET mode = ?, reason = ?, updated_at = ? WHERE tenant_id = ?")
      .run(mode, reason, nowIso(), this.tenantId);
    this.audit({ type: "operations.mode-changed", mode, reason });
  }

  setCapabilityStatus(capabilityId: string, status: OperationalCapabilityStatus, reason: string): void {
    if (!capabilityId || !reason) throw new Error("Capability control requires an ID and reason.");
    this.database.prepare(`
      INSERT INTO operational_capabilities (tenant_id, capability_id, status, reason, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, capability_id) DO UPDATE SET status = excluded.status, reason = excluded.reason, updated_at = excluded.updated_at
    `).run(this.tenantId, capabilityId, status, reason, nowIso());
    this.audit({ type: "operations.capability-status", capabilityId, status, reason });
  }

  beforeAction(context: RuntimeActionControlContext): void {
    const mode = this.mode();
    if (mode === "halted") throw new Error("Customer-local kill switch is active; all capability actions are stopped.");
    if (mode === "draining" && context.write) throw new Error("Customer-local runtime is draining; new writes are stopped.");
    const capability = this.database.prepare(`
      SELECT status FROM operational_capabilities WHERE tenant_id = ? AND capability_id = ?
    `).get(this.tenantId, context.capabilityId) as { status: OperationalCapabilityStatus } | undefined;
    if (capability && capability.status !== "active") {
      throw new Error(`Capability ${context.capabilityId} is ${capability.status} and cannot execute.`);
    }
    if (!context.write || context.testMode) return;
    const runWrites = (this.database.prepare(`
      SELECT COUNT(*) AS count FROM operational_usage WHERE tenant_id = ? AND kind = 'write-attempt' AND run_id = ?
    `).get(this.tenantId, context.runId) as { count: number }).count;
    const hourWrites = (this.database.prepare(`
      SELECT COUNT(*) AS count FROM operational_usage
      WHERE tenant_id = ? AND kind = 'write-attempt' AND occurred_at >= ?
    `).get(this.tenantId, new Date(Date.now() - 3_600_000).toISOString()) as { count: number }).count;
    if (runWrites >= this.limits.maxWriteAttemptsPerRun) throw new Error("Per-run write-attempt limit reached.");
    if (hourWrites >= this.limits.maxWriteAttemptsPerHour) throw new Error("Hourly write-attempt limit reached.");
    const occurredAt = nowIso();
    this.database.prepare(`
      INSERT INTO operational_usage (tenant_id, run_id, kind, amount, occurred_at)
      VALUES (?, ?, 'write-attempt', 1, ?)
    `).run(this.tenantId, context.runId, occurredAt);
    this.audit({
      type: "operations.write-authorized",
      runId: context.runId,
      capabilityId: context.capabilityId,
      actionName: context.actionName,
      targetAlias: context.targetAlias,
      method: context.method,
    });
  }

  afterAction(
    context: RuntimeActionControlContext,
    outcome: "succeeded" | "failed" | "unknown",
    detail: { status?: number; category?: string },
  ): void {
    this.audit({
      type: "operations.action-result",
      runId: context.runId,
      capabilityId: context.capabilityId,
      actionName: context.actionName,
      outcome,
      ...detail,
    });
    if (outcome === "unknown") {
      this.raiseIncident("high", {
        summary: "External action outcome is unknown and blind retry is blocked.",
        runId: context.runId,
        capabilityId: context.capabilityId,
        actionName: context.actionName,
        detail,
      });
    }
  }

  authorizeModelSpend(runId: string, estimatedUsd: number): void {
    if (!Number.isFinite(estimatedUsd) || estimatedUsd <= 0) throw new Error("Estimated model spend must be positive.");
    const today = nowIso().slice(0, 10);
    const spent = (this.database.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS amount FROM operational_usage
      WHERE tenant_id = ? AND kind = 'model-spend-usd' AND substr(occurred_at, 1, 10) = ?
    `).get(this.tenantId, today) as { amount: number }).amount;
    if (spent + estimatedUsd > this.limits.maxModelSpendUsdPerDay) throw new Error("Daily model-spend limit would be exceeded.");
    this.database.prepare(`
      INSERT INTO operational_usage (tenant_id, run_id, kind, amount, occurred_at)
      VALUES (?, ?, 'model-spend-usd', ?, ?)
    `).run(this.tenantId, runId, estimatedUsd, nowIso());
    this.audit({ type: "operations.model-spend-authorized", runId, estimatedUsd });
  }

  raiseIncident(severity: "low" | "medium" | "high" | "critical", summary: Record<string, unknown>): string {
    const occurredAt = nowIso();
    const safe = redactValue(summary) as Record<string, unknown>;
    const incidentId = createHash("sha256").update(`${this.tenantId}\u001f${occurredAt}\u001f${JSON.stringify(safe)}`).digest("hex").slice(0, 24);
    this.database.prepare(`
      INSERT INTO operational_incidents (incident_id, tenant_id, severity, summary_json, occurred_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(incidentId, this.tenantId, severity, JSON.stringify(safe), occurredAt);
    this.audit({ type: "operations.incident", incidentId, severity, summary: safe });
    return incidentId;
  }

  incidents(): Array<{ incidentId: string; severity: string; summary: Record<string, unknown>; occurredAt: string }> {
    return (this.database.prepare(`
      SELECT incident_id, severity, summary_json, occurred_at FROM operational_incidents
      WHERE tenant_id = ? ORDER BY occurred_at, incident_id
    `).all(this.tenantId) as unknown as Array<{ incident_id: string; severity: string; summary_json: string; occurred_at: string }>).map((row) => ({
      incidentId: row.incident_id,
      severity: row.severity,
      summary: JSON.parse(row.summary_json) as Record<string, unknown>,
      occurredAt: row.occurred_at,
    }));
  }

  recordBackupCheck(backupId: string, passed: boolean, detail: string): void {
    this.database.prepare(`
      INSERT INTO operational_backup_checks (tenant_id, backup_id, passed, detail, occurred_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(this.tenantId, backupId, passed ? 1 : 0, detail, nowIso());
    this.audit({ type: "operations.backup-check", backupId, passed, detail });
    if (!passed) this.raiseIncident("high", { summary: "Customer-local backup verification failed.", backupId, detail });
  }

  exportAudit(): OperationalAuditEntry[] {
    return (this.database.prepare(`
      SELECT sequence, previous_hash, payload_json, hash, occurred_at FROM operational_audit
      WHERE tenant_id = ? ORDER BY sequence
    `).all(this.tenantId) as unknown as Array<{
      sequence: number;
      previous_hash: string;
      payload_json: string;
      hash: string;
      occurred_at: string;
    }>).map((row) => ({
      sequence: row.sequence,
      previousHash: row.previous_hash,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      hash: row.hash,
      occurredAt: row.occurred_at,
    }));
  }

  verifyAuditChain(): { passed: boolean; entries: number; finalHash: string } {
    let previous = "0".repeat(64);
    const entries = this.exportAudit();
    for (const entry of entries) {
      const payloadJson = JSON.stringify(entry.payload);
      if (entry.previousHash !== previous || entry.hash !== hashAudit(previous, payloadJson, entry.occurredAt)) {
        return { passed: false, entries: entries.length, finalHash: previous };
      }
      previous = entry.hash;
    }
    return { passed: true, entries: entries.length, finalHash: previous };
  }

  close(): void {
    this.database.close();
  }

  private audit(payload: Record<string, unknown>): void {
    const safe = redactValue(payload) as Record<string, unknown>;
    const payloadJson = JSON.stringify(safe);
    const previous = this.database.prepare(`
      SELECT hash FROM operational_audit WHERE tenant_id = ? ORDER BY sequence DESC LIMIT 1
    `).get(this.tenantId) as { hash: string } | undefined;
    const previousHash = previous?.hash ?? "0".repeat(64);
    const occurredAt = nowIso();
    const hash = hashAudit(previousHash, payloadJson, occurredAt);
    this.database.prepare(`
      INSERT INTO operational_audit (tenant_id, previous_hash, payload_json, hash, occurred_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(this.tenantId, previousHash, payloadJson, hash, occurredAt);
  }
}
