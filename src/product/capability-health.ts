import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { manifestDigest } from "./coordinator.js";
import type { VerificationReceipt } from "./contracts.js";
import type { CustomerLocalOperationalControl } from "./operations.js";
import type { TenantCapabilityStore, VerifiedCapabilityRecord } from "./store.js";

export interface CapabilityDocumentationHealthSource {
  currentHash(record: VerifiedCapabilityRecord): Promise<string>;
}

export interface CapabilityHealthProbe {
  verify(record: VerifiedCapabilityRecord): Promise<VerificationReceipt>;
}

export interface CapabilityHealthAssessment {
  capabilityId: string;
  status: "healthy" | "quarantined";
  reason: "verified" | "documentation-drift" | "documentation-unavailable" | "verification-failed";
  expectedDocumentationHash: string;
  observedDocumentationHash?: string;
  verification?: VerificationReceipt;
  dependentWorkflows: string[];
  checkedAt: string;
}

export interface CapabilityHealthRun {
  tenantId: string;
  checked: number;
  healthy: number;
  quarantined: number;
  assessments: CapabilityHealthAssessment[];
  completedAt: string;
}

function nowIso(): string { return new Date().toISOString(); }

/** Persistent dependency and health history; it contains identifiers and verification receipts, not credentials. */
export class CapabilityHealthLedger {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS capability_dependencies (
        tenant_id TEXT NOT NULL, capability_id TEXT NOT NULL, workflow_key TEXT NOT NULL, recorded_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, capability_id, workflow_key)
      );
      CREATE TABLE IF NOT EXISTS capability_health_assessments (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, capability_id TEXT NOT NULL,
        status TEXT NOT NULL, reason TEXT NOT NULL, assessment_json TEXT NOT NULL, checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS capability_replacements (
        tenant_id TEXT NOT NULL, prior_capability_id TEXT NOT NULL, replacement_capability_id TEXT NOT NULL,
        prior_version TEXT NOT NULL, replacement_version TEXT NOT NULL, activated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, prior_capability_id, replacement_capability_id)
      );
    `);
  }

  registerDependency(tenantId: string, capabilityId: string, workflowKey: string): void {
    if (!tenantId || !capabilityId || !workflowKey) throw new Error("Capability dependencies require tenant, capability, and workflow identifiers.");
    this.database.prepare(`INSERT OR IGNORE INTO capability_dependencies (tenant_id, capability_id, workflow_key, recorded_at) VALUES (?, ?, ?, ?)`)
      .run(tenantId, capabilityId, workflowKey, nowIso());
  }

  dependencies(tenantId: string, capabilityId: string): string[] {
    return (this.database.prepare(`SELECT workflow_key FROM capability_dependencies WHERE tenant_id = ? AND capability_id = ? ORDER BY workflow_key`)
      .all(tenantId, capabilityId) as unknown as Array<{ workflow_key: string }>).map((row) => row.workflow_key);
  }

  recordAssessment(tenantId: string, assessment: CapabilityHealthAssessment): void {
    this.database.prepare(`INSERT INTO capability_health_assessments (tenant_id, capability_id, status, reason, assessment_json, checked_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(tenantId, assessment.capabilityId, assessment.status, assessment.reason, JSON.stringify(assessment), assessment.checkedAt);
  }

  history(tenantId: string, capabilityId: string): CapabilityHealthAssessment[] {
    return (this.database.prepare(`SELECT assessment_json FROM capability_health_assessments WHERE tenant_id = ? AND capability_id = ? ORDER BY sequence`)
      .all(tenantId, capabilityId) as unknown as Array<{ assessment_json: string }>).map((row) => JSON.parse(row.assessment_json) as CapabilityHealthAssessment);
  }

  recordReplacement(tenantId: string, prior: VerifiedCapabilityRecord, replacement: VerifiedCapabilityRecord): void {
    this.database.prepare(`INSERT INTO capability_replacements (tenant_id, prior_capability_id, replacement_capability_id, prior_version, replacement_version, activated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(tenantId, prior.manifest.id, replacement.manifest.id, prior.manifest.version, replacement.manifest.version, nowIso());
    for (const workflow of this.dependencies(tenantId, prior.manifest.id)) this.registerDependency(tenantId, replacement.manifest.id, workflow);
  }

  close(): void { this.database.close(); }
}

function verified(record: VerifiedCapabilityRecord, receipt: VerificationReceipt, currentHash: string): boolean {
  return receipt.passed
    && receipt.checks.length > 0
    && receipt.checks.every((check) => check.passed)
    && receipt.manifestDigest === manifestDigest(record.manifest)
    && receipt.documentationHash === currentHash
    && record.manifest.provenance.documentationHash === currentHash;
}

function greaterSemver(next: string, prior: string): boolean {
  const left = next.split(".").map(Number); const right = prior.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! > right[index]!) return true;
    if (left[index]! < right[index]!) return false;
  }
  return false;
}

export class CapabilityHealthMonitor {
  private running = false;

  constructor(private readonly dependencies: {
    store: TenantCapabilityStore;
    ledger: CapabilityHealthLedger;
    documentation: CapabilityDocumentationHealthSource;
    probe: CapabilityHealthProbe;
    operations?: CustomerLocalOperationalControl;
  }) {}

  async runOnce(tenantId: string): Promise<CapabilityHealthRun> {
    if (this.running) throw new Error("A capability health run is already active.");
    this.running = true;
    try {
      const assessments: CapabilityHealthAssessment[] = [];
      for (const record of this.dependencies.store.list(tenantId).filter((item) => item.status === "active")) {
        assessments.push(await this.assess(tenantId, record));
      }
      return { tenantId, checked: assessments.length, healthy: assessments.filter((item) => item.status === "healthy").length,
        quarantined: assessments.filter((item) => item.status === "quarantined").length, assessments, completedAt: nowIso() };
    } finally {
      this.running = false;
    }
  }

  start(tenantId: string, intervalMs: number, onRun?: (run: CapabilityHealthRun) => void | Promise<void>): { stop(): void } {
    if (!Number.isInteger(intervalMs) || intervalMs < 60_000) throw new Error("Capability health interval must be at least one minute.");
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped || this.running) return;
      void this.runOnce(tenantId).then((run) => onRun?.(run)).catch(() => undefined);
    }, intervalMs);
    timer.unref();
    return { stop: () => { stopped = true; clearInterval(timer); } };
  }

  async activateVerifiedReplacement(tenantId: string, priorCapabilityId: string, replacement: VerifiedCapabilityRecord): Promise<void> {
    const prior = this.dependencies.store.list(tenantId).find((item) => item.manifest.id === priorCapabilityId);
    if (!prior) throw new Error("Prior capability does not exist for this tenant.");
    if (replacement.tenantId !== tenantId || replacement.needKey !== prior.needKey) throw new Error("Replacement must preserve tenant and capability need.");
    if (replacement.manifest.id === prior.manifest.id || !greaterSemver(replacement.manifest.version, prior.manifest.version)) {
      throw new Error("Replacement requires a distinct capability ID and a greater semantic version.");
    }
    const currentHash = await this.dependencies.documentation.currentHash(replacement);
    if (!verified(replacement, replacement.verification, currentHash)) throw new Error("Replacement has not passed current independent verification.");
    this.dependencies.store.register({ ...replacement, status: "active" });
    this.dependencies.store.setStatus(tenantId, prior.manifest.id, "quarantined");
    this.dependencies.operations?.setCapabilityStatus(prior.manifest.id, "quarantined", `Superseded by verified ${replacement.manifest.id}.`);
    this.dependencies.operations?.setCapabilityStatus(replacement.manifest.id, "active", `Verified replacement for ${prior.manifest.id}.`);
    this.dependencies.ledger.recordReplacement(tenantId, prior, replacement);
  }

  private async assess(tenantId: string, record: VerifiedCapabilityRecord): Promise<CapabilityHealthAssessment> {
    const expected = record.manifest.provenance.documentationHash;
    const dependencies = this.dependencies.ledger.dependencies(tenantId, record.manifest.id);
    let assessment: CapabilityHealthAssessment;
    try {
      const observed = await this.dependencies.documentation.currentHash(record);
      if (observed !== expected) {
        assessment = { capabilityId: record.manifest.id, status: "quarantined", reason: "documentation-drift", expectedDocumentationHash: expected, observedDocumentationHash: observed, dependentWorkflows: dependencies, checkedAt: nowIso() };
      } else {
        try {
          const receipt = await this.dependencies.probe.verify(record);
          assessment = verified(record, receipt, observed)
            ? { capabilityId: record.manifest.id, status: "healthy", reason: "verified", expectedDocumentationHash: expected, observedDocumentationHash: observed, verification: receipt, dependentWorkflows: dependencies, checkedAt: nowIso() }
            : { capabilityId: record.manifest.id, status: "quarantined", reason: "verification-failed", expectedDocumentationHash: expected, observedDocumentationHash: observed, verification: receipt, dependentWorkflows: dependencies, checkedAt: nowIso() };
        } catch {
          assessment = { capabilityId: record.manifest.id, status: "quarantined", reason: "verification-failed", expectedDocumentationHash: expected, observedDocumentationHash: observed, dependentWorkflows: dependencies, checkedAt: nowIso() };
        }
      }
    } catch {
      assessment = { capabilityId: record.manifest.id, status: "quarantined", reason: "documentation-unavailable", expectedDocumentationHash: expected, dependentWorkflows: dependencies, checkedAt: nowIso() };
    }
    if (assessment.status === "quarantined") {
      this.dependencies.store.setStatus(tenantId, record.manifest.id, "quarantined");
      this.dependencies.operations?.setCapabilityStatus(record.manifest.id, "quarantined", assessment.reason);
    }
    this.dependencies.ledger.recordAssessment(tenantId, assessment);
    return assessment;
  }
}
