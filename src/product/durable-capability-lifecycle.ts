import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  assertComposedRecoveryReceiptIntegrity,
  composedRecoveryDigest,
  type ComposedRecoveryReceipt,
} from "./composed-runtime-recovery.js";

const identifier = z.string().min(1).max(180).regex(/^[a-zA-Z0-9_.-]+$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const timestampSchema = z.string().datetime({ offset: true });

export type LifecycleCapabilityStatus = "active" | "candidate" | "quarantined" | "replaced" | "rolled-back";
export type LifecycleHealthTrigger =
  | "periodic"
  | "documentation-change"
  | "schema-change"
  | "provenance-change"
  | "recovery"
  | "manual";

export interface LifecycleCapabilityRecord {
  schemaVersion: "1.0";
  tenantId: string;
  runtimeFamily: string;
  capabilityKey: string;
  capabilityVersion: string;
  capabilityQualificationDigest: string;
  qualificationExpiresAt: string;
  documentationDigest: string;
  schemaDigest: string;
  provenanceDigest: string;
  retentionEvidenceDigest: string;
  status: LifecycleCapabilityStatus;
  quarantineReason?: string;
  nextProbeAt: string;
  lastCheckedAt?: string;
  lastUsedAt?: string;
  reuseCount: number;
  registeredAt: string;
}
export interface LifecycleObservedMaterial {
  documentationDigest: string;
  schemaDigest: string;
  provenanceDigest: string;
  documentationCompatibility: "unchanged" | "compatible" | "breaking";
  observationDigest: string;
}

export interface LifecycleProbeResult {
  passed: boolean;
  evidenceDigest: string;
  detail: string;
}

export interface LifecycleHealthSource {
  observe(record: LifecycleCapabilityRecord): Promise<LifecycleObservedMaterial>;
  probe(record: LifecycleCapabilityRecord, observed: LifecycleObservedMaterial): Promise<LifecycleProbeResult>;
}

export type LifecycleHealthReason =
  | "verified"
  | "benign-documentation-drift"
  | "breaking-documentation-drift"
  | "schema-drift"
  | "provenance-drift"
  | "verifier-failure"
  | "qualification-stale"
  | "observation-unavailable";

export interface LifecycleHealthAssessment {
  schemaVersion: "1.0";
  assessmentId: string;
  tenantId: string;
  runtimeFamily: string;
  capabilityKey: string;
  capabilityVersion: string;
  trigger: LifecycleHealthTrigger;
  status: "healthy" | "benign-drift" | "quarantined";
  reason: LifecycleHealthReason;
  dependencies: string[];
  expected: { documentationDigest: string; schemaDigest: string; provenanceDigest: string };
  observed?: LifecycleObservedMaterial;
  probe?: LifecycleProbeResult;
  checkedAt: string;
  integrityDigest: string;
}

export interface LifecycleHealthRun {
  schemaVersion: "1.0";
  tenantId: string;
  trigger: LifecycleHealthTrigger;
  checked: number;
  healthy: number;
  benignDrift: number;
  quarantined: number;
  assessments: LifecycleHealthAssessment[];
  completedAt: string;
  integrityDigest: string;
}

export interface ReplacementQualification {
  schemaVersion: "1.0";
  passed: boolean;
  evidenceDigest: string;
  capabilityQualificationDigest: string;
  qualifiedAt: string;
  expiresAt: string;
  observed: LifecycleObservedMaterial;
  probe: LifecycleProbeResult;
}

export interface LifecycleActivationReceipt {
  schemaVersion: "1.0";
  activationId: string;
  tenantId: string;
  runtimeFamily: string;
  capabilityKey: string;
  priorVersion: string;
  priorStatus: LifecycleCapabilityStatus;
  replacementVersion: string;
  dependencySnapshot: string[];
  replacementQualificationDigest: string;
  rollbackToken: string;
  activatedAt: string;
  status: "active" | "rolled-back";
  rolledBackAt?: string;
  integrityDigest: string;
}

export interface LifecycleContinuationReceipt {
  schemaVersion: "1.0";
  continuationId: string;
  tenantId: string;
  workflowKey: string;
  planDigest: string;
  workItemId: string;
  runtimeFamily: string;
  capabilityKey: string;
  capabilityVersion: string;
  capabilityQualificationDigest: string;
  healthStateDigest: string;
  selectedAt: string;
  integrityDigest: string;
}

const capabilityInputSchema = z.object({
  schemaVersion: z.literal("1.0"), tenantId: identifier, runtimeFamily: identifier,
  capabilityKey: identifier, capabilityVersion: semverSchema,
  capabilityQualificationDigest: digestSchema, qualificationExpiresAt: timestampSchema,
  documentationDigest: digestSchema, schemaDigest: digestSchema, provenanceDigest: digestSchema,
  retentionEvidenceDigest: digestSchema,
}).strict();

type CapabilityInput = z.infer<typeof capabilityInputSchema>;

interface CapabilityRow {
  tenant_id: string; runtime_family: string; capability_key: string; capability_version: string;
  qualification_digest: string; qualification_expires_at: string; documentation_digest: string;
  schema_digest: string; provenance_digest: string; retention_evidence_digest: string;
  status: LifecycleCapabilityStatus; quarantine_reason: string | null; next_probe_at: string;
  last_checked_at: string | null; last_used_at: string | null; reuse_count: number; registered_at: string;
}
interface ActivationRow { receipt_json: string; status: "active" | "rolled-back" }

function rowToRecord(row: CapabilityRow): LifecycleCapabilityRecord {
  return {
    schemaVersion: "1.0", tenantId: row.tenant_id, runtimeFamily: row.runtime_family,
    capabilityKey: row.capability_key, capabilityVersion: row.capability_version,
    capabilityQualificationDigest: row.qualification_digest, qualificationExpiresAt: row.qualification_expires_at,
    documentationDigest: row.documentation_digest, schemaDigest: row.schema_digest,
    provenanceDigest: row.provenance_digest, retentionEvidenceDigest: row.retention_evidence_digest,
    status: row.status, ...(row.quarantine_reason ? { quarantineReason: row.quarantine_reason } : {}),
    nextProbeAt: row.next_probe_at, ...(row.last_checked_at ? { lastCheckedAt: row.last_checked_at } : {}),
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}), reuseCount: row.reuse_count,
    registeredAt: row.registered_at,
  };
}

function greaterSemver(next: string, prior: string): boolean {
  const left = semverSchema.parse(next).split(".").map(Number);
  const right = semverSchema.parse(prior).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! > right[index]!) return true;
    if (left[index]! < right[index]!) return false;
  }
  return false;
}

function assessmentUnsigned(value: LifecycleHealthAssessment): Omit<LifecycleHealthAssessment, "integrityDigest"> {
  const { integrityDigest: _integrityDigest, ...unsigned } = value;
  return unsigned;
}

function activationUnsigned(value: LifecycleActivationReceipt): Omit<LifecycleActivationReceipt, "integrityDigest"> {
  const { integrityDigest: _integrityDigest, ...unsigned } = value;
  return unsigned;
}

function continuationUnsigned(value: LifecycleContinuationReceipt): Omit<LifecycleContinuationReceipt, "integrityDigest"> {
  const { integrityDigest: _integrityDigest, ...unsigned } = value;
  return unsigned;
}

/** Durable lifecycle for retained capabilities shared by composed runtime families. */
export class DurableCapabilityLifecycle {
  private readonly database: DatabaseSync;

  constructor(
    databasePath: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly probeIntervalMs = 24 * 60 * 60 * 1_000,
  ) {
    if (!Number.isInteger(probeIntervalMs) || probeIntervalMs < 1_000) throw new Error("Probe interval must be at least one second.");
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS lifecycle_capabilities (
        tenant_id TEXT NOT NULL, runtime_family TEXT NOT NULL, capability_key TEXT NOT NULL,
        capability_version TEXT NOT NULL, qualification_digest TEXT NOT NULL,
        qualification_expires_at TEXT NOT NULL, documentation_digest TEXT NOT NULL,
        schema_digest TEXT NOT NULL, provenance_digest TEXT NOT NULL,
        retention_evidence_digest TEXT NOT NULL, status TEXT NOT NULL,
        quarantine_reason TEXT, next_probe_at TEXT NOT NULL, last_checked_at TEXT,
        last_used_at TEXT, reuse_count INTEGER NOT NULL DEFAULT 0, registered_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, runtime_family, capability_key, capability_version)
      );
      CREATE TABLE IF NOT EXISTS lifecycle_dependencies (
        tenant_id TEXT NOT NULL, runtime_family TEXT NOT NULL, capability_key TEXT NOT NULL,
        workflow_key TEXT NOT NULL, registered_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, runtime_family, capability_key, workflow_key)
      );
      CREATE TABLE IF NOT EXISTS lifecycle_assessments (
        assessment_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, runtime_family TEXT NOT NULL,
        capability_key TEXT NOT NULL, capability_version TEXT NOT NULL,
        assessment_json TEXT NOT NULL, checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lifecycle_activations (
        activation_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, runtime_family TEXT NOT NULL,
        capability_key TEXT NOT NULL, status TEXT NOT NULL, receipt_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lifecycle_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
        runtime_family TEXT NOT NULL, capability_key TEXT NOT NULL,
        capability_version TEXT NOT NULL, event_type TEXT NOT NULL,
        evidence_digest TEXT NOT NULL, occurred_at TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
  }

  retainFromRecovery(input: CapabilityInput, receipt: ComposedRecoveryReceipt): LifecycleCapabilityRecord {
    const candidate = capabilityInputSchema.parse(input);
    assertComposedRecoveryReceiptIntegrity(receipt);
    if (!receipt.verifiedCompletion || receipt.transition !== "verified-completion") {
      throw new Error("Lifecycle retention requires independently verified recovery completion.");
    }
    const context = receipt.context;
    const materialDigest = composedRecoveryDigest({
      documentationDigest: candidate.documentationDigest,
      schemaDigest: candidate.schemaDigest,
      provenanceDigest: candidate.provenanceDigest,
    });
    if (candidate.tenantId !== context.tenantId || candidate.runtimeFamily !== context.runtimeFamily
      || candidate.capabilityKey !== context.capabilityKey || candidate.capabilityVersion !== context.capabilityVersion
      || candidate.capabilityQualificationDigest !== context.capabilityQualificationDigest
      || materialDigest !== context.capabilityMaterialDigest
      || candidate.retentionEvidenceDigest !== receipt.independentEvidence.observationDigest) {
      throw new Error("Lifecycle retention is not bound to the exact recovery receipt.");
    }
    if (Date.parse(candidate.qualificationExpiresAt) <= Date.parse(this.now())) throw new Error("A stale qualification cannot be retained.");
    const existingActive = this.activeRow(candidate.tenantId, candidate.runtimeFamily, candidate.capabilityKey);
    const status: LifecycleCapabilityStatus = existingActive ? "candidate" : "active";
    const registeredAt = this.now();
    const nextProbeAt = new Date(Date.parse(registeredAt) + this.probeIntervalMs).toISOString();
    this.database.prepare(`INSERT INTO lifecycle_capabilities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, 0, ?)
      ON CONFLICT(tenant_id, runtime_family, capability_key, capability_version) DO NOTHING`)
      .run(candidate.tenantId, candidate.runtimeFamily, candidate.capabilityKey, candidate.capabilityVersion,
        candidate.capabilityQualificationDigest, candidate.qualificationExpiresAt, candidate.documentationDigest,
        candidate.schemaDigest, candidate.provenanceDigest, candidate.retentionEvidenceDigest,
        status, nextProbeAt, registeredAt);
    this.event(candidate.tenantId, candidate.runtimeFamily, candidate.capabilityKey, candidate.capabilityVersion,
      "capability.retained", receipt.integrityDigest);
    return this.get(candidate.tenantId, candidate.runtimeFamily, candidate.capabilityKey, candidate.capabilityVersion)!;
  }

  registerDependency(tenantId: string, runtimeFamily: string, capabilityKey: string, workflowKey: string): void {
    identifier.parse(tenantId); identifier.parse(runtimeFamily); identifier.parse(capabilityKey); identifier.parse(workflowKey);
    this.database.prepare("INSERT OR IGNORE INTO lifecycle_dependencies VALUES (?, ?, ?, ?, ?)")
      .run(tenantId, runtimeFamily, capabilityKey, workflowKey, this.now());
  }

  dependencies(tenantId: string, runtimeFamily: string, capabilityKey: string): string[] {
    return (this.database.prepare(`SELECT workflow_key FROM lifecycle_dependencies
      WHERE tenant_id=? AND runtime_family=? AND capability_key=? ORDER BY workflow_key`)
      .all(tenantId, runtimeFamily, capabilityKey) as unknown as Array<{ workflow_key: string }>).map((row) => row.workflow_key);
  }

  get(tenantId: string, runtimeFamily: string, capabilityKey: string, capabilityVersion: string): LifecycleCapabilityRecord | undefined {
    const row = this.database.prepare(`SELECT * FROM lifecycle_capabilities
      WHERE tenant_id=? AND runtime_family=? AND capability_key=? AND capability_version=?`)
      .get(tenantId, runtimeFamily, capabilityKey, capabilityVersion) as unknown as CapabilityRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  list(tenantId: string): LifecycleCapabilityRecord[] {
    return (this.database.prepare("SELECT * FROM lifecycle_capabilities WHERE tenant_id=? ORDER BY runtime_family, capability_key, capability_version")
      .all(tenantId) as unknown as CapabilityRow[]).map(rowToRecord);
  }

  async runPeriodic(tenantId: string, source: LifecycleHealthSource): Promise<LifecycleHealthRun> {
    return this.runHealth(tenantId, "periodic", source, true);
  }

  async runTriggered(tenantId: string, trigger: Exclude<LifecycleHealthTrigger, "periodic">, source: LifecycleHealthSource): Promise<LifecycleHealthRun> {
    return this.runHealth(tenantId, trigger, source, false);
  }

  applyRecoveryReceipt(receipt: ComposedRecoveryReceipt): void {
    assertComposedRecoveryReceiptIntegrity(receipt);
    const context = receipt.context;
    const record = this.get(context.tenantId, context.runtimeFamily, context.capabilityKey, context.capabilityVersion);
    if (!record) throw new Error("Recovery receipt capability is not registered in the lifecycle.");
    if (record.capabilityQualificationDigest !== context.capabilityQualificationDigest) {
      throw new Error("Recovery receipt qualification does not match the lifecycle record.");
    }
    this.event(context.tenantId, context.runtimeFamily, context.capabilityKey, context.capabilityVersion,
      `recovery.${receipt.reconciledClassification}`, receipt.integrityDigest);
    if (receipt.invalidateRetainedCapability) {
      this.quarantine(record, `Composed recovery classified ${receipt.reconciledClassification}.`, receipt.integrityDigest);
    }
  }

  stageReplacement(input: CapabilityInput, qualification: ReplacementQualification): LifecycleCapabilityRecord {
    const candidate = capabilityInputSchema.parse(input);
    const parsed = z.object({
      schemaVersion: z.literal("1.0"), passed: z.boolean(), evidenceDigest: digestSchema,
      capabilityQualificationDigest: digestSchema, qualifiedAt: timestampSchema, expiresAt: timestampSchema,
      observed: z.object({ documentationDigest: digestSchema, schemaDigest: digestSchema, provenanceDigest: digestSchema,
        documentationCompatibility: z.enum(["unchanged", "compatible", "breaking"]), observationDigest: digestSchema }).strict(),
      probe: z.object({ passed: z.boolean(), evidenceDigest: digestSchema, detail: z.string().min(1) }).strict(),
    }).strict().parse(qualification);
    const prior = this.latestRow(candidate.tenantId, candidate.runtimeFamily, candidate.capabilityKey, ["active", "quarantined"]);
    if (!prior) throw new Error("Replacement requires an existing active or quarantined capability.");
    if (!greaterSemver(candidate.capabilityVersion, prior.capability_version)) throw new Error("Replacement requires a higher semantic version.");
    if (!parsed.passed || !parsed.probe.passed) throw new Error("Replacement did not pass independent qualification and verification.");
    if (Date.parse(parsed.expiresAt) <= Date.parse(this.now()) || parsed.expiresAt !== candidate.qualificationExpiresAt) {
      throw new Error("Replacement qualification is stale or does not match the candidate.");
    }
    if (parsed.capabilityQualificationDigest !== candidate.capabilityQualificationDigest
      || parsed.observed.documentationDigest !== candidate.documentationDigest
      || parsed.observed.schemaDigest !== candidate.schemaDigest
      || parsed.observed.provenanceDigest !== candidate.provenanceDigest) {
      throw new Error("Replacement qualification is not bound to the exact candidate material.");
    }
    const registeredAt = this.now();
    const nextProbeAt = new Date(Date.parse(registeredAt) + this.probeIntervalMs).toISOString();
    this.database.prepare(`INSERT INTO lifecycle_capabilities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', NULL, ?, NULL, NULL, 0, ?)`)
      .run(candidate.tenantId, candidate.runtimeFamily, candidate.capabilityKey, candidate.capabilityVersion,
        candidate.capabilityQualificationDigest, candidate.qualificationExpiresAt, candidate.documentationDigest,
        candidate.schemaDigest, candidate.provenanceDigest, candidate.retentionEvidenceDigest, nextProbeAt, registeredAt);
    this.event(candidate.tenantId, candidate.runtimeFamily, candidate.capabilityKey, candidate.capabilityVersion,
      "replacement.qualified", parsed.evidenceDigest);
    return this.get(candidate.tenantId, candidate.runtimeFamily, candidate.capabilityKey, candidate.capabilityVersion)!;
  }

  activateReplacement(tenantId: string, runtimeFamily: string, capabilityKey: string, replacementVersion: string): LifecycleActivationReceipt {
    semverSchema.parse(replacementVersion);
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const prior = this.latestRow(tenantId, runtimeFamily, capabilityKey, ["active", "quarantined"]);
      const replacement = this.row(tenantId, runtimeFamily, capabilityKey, replacementVersion);
      if (!prior || !replacement || replacement.status !== "candidate") throw new Error("Exact prior and qualified replacement are required.");
      if (!greaterSemver(replacement.capability_version, prior.capability_version)) throw new Error("Replacement version is not greater than the prior version.");
      if (Date.parse(replacement.qualification_expires_at) <= Date.parse(this.now())) throw new Error("Replacement qualification became stale before activation.");
      const dependencies = this.dependencies(tenantId, runtimeFamily, capabilityKey);
      const activatedAt = this.now();
      const activationId = `activation.${composedRecoveryDigest({ tenantId, runtimeFamily, capabilityKey, prior: prior.capability_version, replacement: replacement.capability_version, qualification: replacement.qualification_digest }).slice(0, 40)}`;
      const rollbackToken = composedRecoveryDigest({ activationId, priorStatus: prior.status, dependencies });
      this.database.prepare(`UPDATE lifecycle_capabilities SET status='replaced', quarantine_reason=NULL
        WHERE tenant_id=? AND runtime_family=? AND capability_key=? AND capability_version=?`)
        .run(tenantId, runtimeFamily, capabilityKey, prior.capability_version);
      this.database.prepare(`UPDATE lifecycle_capabilities SET status='active', quarantine_reason=NULL
        WHERE tenant_id=? AND runtime_family=? AND capability_key=? AND capability_version=? AND status='candidate'`)
        .run(tenantId, runtimeFamily, capabilityKey, replacementVersion);
      const unsigned: Omit<LifecycleActivationReceipt, "integrityDigest"> = {
        schemaVersion: "1.0", activationId, tenantId, runtimeFamily, capabilityKey,
        priorVersion: prior.capability_version, priorStatus: prior.status,
        replacementVersion, dependencySnapshot: dependencies,
        replacementQualificationDigest: replacement.qualification_digest,
        rollbackToken, activatedAt, status: "active",
      };
      const receipt = { ...unsigned, integrityDigest: composedRecoveryDigest(unsigned) };
      this.database.prepare("INSERT INTO lifecycle_activations VALUES (?, ?, ?, ?, 'active', ?)")
        .run(activationId, tenantId, runtimeFamily, capabilityKey, JSON.stringify(receipt));
      this.event(tenantId, runtimeFamily, capabilityKey, replacementVersion, "replacement.activated", receipt.integrityDigest);
      this.database.exec("COMMIT;");
      return receipt;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  rollbackActivation(activationId: string, rollbackToken: string): LifecycleActivationReceipt {
    identifier.parse(activationId);
    digestSchema.parse(rollbackToken);
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.database.prepare("SELECT receipt_json, status FROM lifecycle_activations WHERE activation_id=?")
        .get(activationId) as unknown as ActivationRow | undefined;
      if (!row) throw new Error("Activation receipt was not found.");
      const receipt = JSON.parse(row.receipt_json) as LifecycleActivationReceipt;
      if (receipt.integrityDigest !== composedRecoveryDigest(activationUnsigned(receipt))) throw new Error("Activation receipt integrity failed.");
      if (row.status !== "active" || receipt.status !== "active") throw new Error("Activation has already been rolled back.");
      if (receipt.rollbackToken !== rollbackToken) throw new Error("Rollback token does not match the exact activation.");
      const replacement = this.row(receipt.tenantId, receipt.runtimeFamily, receipt.capabilityKey, receipt.replacementVersion);
      if (!replacement || replacement.status !== "active") throw new Error("Replacement is no longer the exact active capability.");
      this.database.prepare(`UPDATE lifecycle_capabilities SET status='rolled-back', quarantine_reason='Activation rolled back.'
        WHERE tenant_id=? AND runtime_family=? AND capability_key=? AND capability_version=?`)
        .run(receipt.tenantId, receipt.runtimeFamily, receipt.capabilityKey, receipt.replacementVersion);
      const restoredStatus = receipt.priorStatus === "active" ? "active" : "quarantined";
      this.database.prepare(`UPDATE lifecycle_capabilities SET status=?, quarantine_reason=?
        WHERE tenant_id=? AND runtime_family=? AND capability_key=? AND capability_version=?`)
        .run(restoredStatus, restoredStatus === "quarantined" ? "Prior capability remains quarantined after rollback." : null,
          receipt.tenantId, receipt.runtimeFamily, receipt.capabilityKey, receipt.priorVersion);
      const rolledBackAt = this.now();
      const unsigned: Omit<LifecycleActivationReceipt, "integrityDigest"> = {
        ...activationUnsigned(receipt), status: "rolled-back", rolledBackAt,
      };
      const rolledBack = { ...unsigned, integrityDigest: composedRecoveryDigest(unsigned) };
      this.database.prepare("UPDATE lifecycle_activations SET status='rolled-back', receipt_json=? WHERE activation_id=?")
        .run(JSON.stringify(rolledBack), activationId);
      this.event(receipt.tenantId, receipt.runtimeFamily, receipt.capabilityKey, receipt.replacementVersion,
        "replacement.rolled-back", rolledBack.integrityDigest);
      this.database.exec("COMMIT;");
      return rolledBack;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  continueWorkflow(input: {
    tenantId: string; workflowKey: string; planDigest: string; workItemId: string;
    runtimeFamily: string; capabilityKey: string;
  }): LifecycleContinuationReceipt {
    identifier.parse(input.tenantId); identifier.parse(input.workflowKey); identifier.parse(input.workItemId);
    identifier.parse(input.runtimeFamily); identifier.parse(input.capabilityKey); digestSchema.parse(input.planDigest);
    if (!this.dependencies(input.tenantId, input.runtimeFamily, input.capabilityKey).includes(input.workflowKey)) {
      throw new Error("Workflow is not registered as a dependent of this capability.");
    }
    const active = this.activeRow(input.tenantId, input.runtimeFamily, input.capabilityKey);
    if (!active) throw new Error("No active non-quarantined capability is available for exact continuation.");
    const selectedAt = this.now();
    if (Date.parse(active.qualification_expires_at) <= Date.parse(selectedAt)) {
      this.quarantine(rowToRecord(active), "Capability qualification is stale at continuation time.", composedRecoveryDigest({ input, selectedAt }));
      throw new Error("Capability qualification is stale; continuation is blocked.");
    }
    if (Date.parse(active.next_probe_at) <= Date.parse(selectedAt)) throw new Error("Capability health probe is due; continuation is blocked until re-probe.");
    const healthStateDigest = composedRecoveryDigest({
      qualificationDigest: active.qualification_digest, qualificationExpiresAt: active.qualification_expires_at,
      documentationDigest: active.documentation_digest, schemaDigest: active.schema_digest,
      provenanceDigest: active.provenance_digest, nextProbeAt: active.next_probe_at,
    });
    const continuationId = `continuation.${composedRecoveryDigest({ input, version: active.capability_version, healthStateDigest }).slice(0, 40)}`;
    const unsigned: Omit<LifecycleContinuationReceipt, "integrityDigest"> = {
      schemaVersion: "1.0", continuationId, tenantId: input.tenantId, workflowKey: input.workflowKey,
      planDigest: input.planDigest, workItemId: input.workItemId, runtimeFamily: input.runtimeFamily,
      capabilityKey: input.capabilityKey, capabilityVersion: active.capability_version,
      capabilityQualificationDigest: active.qualification_digest, healthStateDigest, selectedAt,
    };
    const receipt = { ...unsigned, integrityDigest: composedRecoveryDigest(unsigned) };
    this.database.prepare(`UPDATE lifecycle_capabilities SET reuse_count=reuse_count+1, last_used_at=?
      WHERE tenant_id=? AND runtime_family=? AND capability_key=? AND capability_version=? AND status='active'`)
      .run(selectedAt, input.tenantId, input.runtimeFamily, input.capabilityKey, active.capability_version);
    this.event(input.tenantId, input.runtimeFamily, input.capabilityKey, active.capability_version,
      "workflow.continued", receipt.integrityDigest);
    return receipt;
  }

  assessmentHistory(tenantId: string, runtimeFamily: string, capabilityKey: string): LifecycleHealthAssessment[] {
    return (this.database.prepare(`SELECT assessment_json FROM lifecycle_assessments
      WHERE tenant_id=? AND runtime_family=? AND capability_key=? ORDER BY checked_at, assessment_id`)
      .all(tenantId, runtimeFamily, capabilityKey) as unknown as Array<{ assessment_json: string }>)
      .map((row) => JSON.parse(row.assessment_json) as LifecycleHealthAssessment);
  }

  close(): void { this.database.close(); }

  private async runHealth(tenantId: string, trigger: LifecycleHealthTrigger, source: LifecycleHealthSource, dueOnly: boolean): Promise<LifecycleHealthRun> {
    identifier.parse(tenantId);
    const checkedAt = this.now();
    const rows = (this.database.prepare("SELECT * FROM lifecycle_capabilities WHERE tenant_id=? AND status='active' ORDER BY runtime_family, capability_key")
      .all(tenantId) as unknown as CapabilityRow[]).filter((row) => !dueOnly || Date.parse(row.next_probe_at) <= Date.parse(checkedAt));
    const assessments: LifecycleHealthAssessment[] = [];
    for (const row of rows) assessments.push(await this.assess(rowToRecord(row), trigger, checkedAt, source));
    const unsigned = {
      schemaVersion: "1.0" as const, tenantId, trigger, checked: assessments.length,
      healthy: assessments.filter((item) => item.status === "healthy").length,
      benignDrift: assessments.filter((item) => item.status === "benign-drift").length,
      quarantined: assessments.filter((item) => item.status === "quarantined").length,
      assessments, completedAt: this.now(),
    };
    return { ...unsigned, integrityDigest: composedRecoveryDigest(unsigned) };
  }

  private async assess(record: LifecycleCapabilityRecord, trigger: LifecycleHealthTrigger, checkedAt: string, source: LifecycleHealthSource): Promise<LifecycleHealthAssessment> {
    const dependencies = this.dependencies(record.tenantId, record.runtimeFamily, record.capabilityKey);
    const expected = { documentationDigest: record.documentationDigest, schemaDigest: record.schemaDigest, provenanceDigest: record.provenanceDigest };
    let observed: LifecycleObservedMaterial | undefined;
    let probe: LifecycleProbeResult | undefined;
    let status: LifecycleHealthAssessment["status"] = "quarantined";
    let reason: LifecycleHealthReason = "observation-unavailable";
    if (Date.parse(record.qualificationExpiresAt) <= Date.parse(checkedAt)) {
      reason = "qualification-stale";
    } else {
      try {
        observed = await source.observe(record);
        digestSchema.parse(observed.documentationDigest); digestSchema.parse(observed.schemaDigest);
        digestSchema.parse(observed.provenanceDigest); digestSchema.parse(observed.observationDigest);
        if (observed.schemaDigest !== record.schemaDigest) reason = "schema-drift";
        else if (observed.provenanceDigest !== record.provenanceDigest) reason = "provenance-drift";
        else if (observed.documentationDigest !== record.documentationDigest && observed.documentationCompatibility === "breaking") {
          reason = "breaking-documentation-drift";
        } else {
          try {
            probe = await source.probe(record, observed);
            digestSchema.parse(probe.evidenceDigest);
            if (!probe.passed) reason = "verifier-failure";
            else if (observed.documentationDigest !== record.documentationDigest) {
              if (observed.documentationCompatibility !== "compatible") throw new Error("Changed documentation was not classified as compatible or breaking.");
              status = "benign-drift"; reason = "benign-documentation-drift";
            } else {
              status = "healthy"; reason = "verified";
            }
          } catch { reason = "verifier-failure"; }
        }
      } catch { reason = "observation-unavailable"; }
    }
    const unsigned: Omit<LifecycleHealthAssessment, "integrityDigest"> = {
      schemaVersion: "1.0", assessmentId: "", tenantId: record.tenantId,
      runtimeFamily: record.runtimeFamily, capabilityKey: record.capabilityKey,
      capabilityVersion: record.capabilityVersion, trigger, status, reason, dependencies, expected,
      ...(observed ? { observed } : {}), ...(probe ? { probe } : {}), checkedAt,
    };
    unsigned.assessmentId = `assessment.${composedRecoveryDigest(unsigned).slice(0, 40)}`;
    const assessment = { ...unsigned, integrityDigest: composedRecoveryDigest(unsigned) };
    this.database.prepare("INSERT OR REPLACE INTO lifecycle_assessments VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(assessment.assessmentId, record.tenantId, record.runtimeFamily, record.capabilityKey,
        record.capabilityVersion, JSON.stringify(assessment), checkedAt);
    if (status === "quarantined") {
      this.quarantine(record, reason, assessment.integrityDigest);
    } else {
      const nextProbeAt = new Date(Date.parse(checkedAt) + this.probeIntervalMs).toISOString();
      this.database.prepare(`UPDATE lifecycle_capabilities SET documentation_digest=?, last_checked_at=?, next_probe_at=?
        WHERE tenant_id=? AND runtime_family=? AND capability_key=? AND capability_version=? AND status='active'`)
        .run(observed!.documentationDigest, checkedAt, nextProbeAt, record.tenantId,
          record.runtimeFamily, record.capabilityKey, record.capabilityVersion);
      this.event(record.tenantId, record.runtimeFamily, record.capabilityKey, record.capabilityVersion,
        status === "healthy" ? "health.verified" : "health.benign-drift", assessment.integrityDigest);
    }
    return assessment;
  }

  private quarantine(record: LifecycleCapabilityRecord, reason: string, evidenceDigest: string): void {
    this.database.prepare(`UPDATE lifecycle_capabilities SET status='quarantined', quarantine_reason=?, last_checked_at=?
      WHERE tenant_id=? AND runtime_family=? AND capability_key=? AND capability_version=?`)
      .run(reason, this.now(), record.tenantId, record.runtimeFamily, record.capabilityKey, record.capabilityVersion);
    this.event(record.tenantId, record.runtimeFamily, record.capabilityKey, record.capabilityVersion,
      "capability.quarantined", evidenceDigest);
  }

  private activeRow(tenantId: string, runtimeFamily: string, capabilityKey: string): CapabilityRow | undefined {
    return this.database.prepare(`SELECT * FROM lifecycle_capabilities WHERE tenant_id=? AND runtime_family=?
      AND capability_key=? AND status='active' ORDER BY capability_version DESC LIMIT 1`)
      .get(tenantId, runtimeFamily, capabilityKey) as unknown as CapabilityRow | undefined;
  }

  private latestRow(tenantId: string, runtimeFamily: string, capabilityKey: string, statuses: LifecycleCapabilityStatus[]): CapabilityRow | undefined {
    const rows = this.database.prepare(`SELECT * FROM lifecycle_capabilities WHERE tenant_id=? AND runtime_family=?
      AND capability_key=? ORDER BY registered_at DESC, capability_version DESC`)
      .all(tenantId, runtimeFamily, capabilityKey) as unknown as CapabilityRow[];
    return rows.find((row) => statuses.includes(row.status));
  }

  private row(tenantId: string, runtimeFamily: string, capabilityKey: string, version: string): CapabilityRow | undefined {
    return this.database.prepare(`SELECT * FROM lifecycle_capabilities WHERE tenant_id=? AND runtime_family=?
      AND capability_key=? AND capability_version=?`)
      .get(tenantId, runtimeFamily, capabilityKey, version) as unknown as CapabilityRow | undefined;
  }

  private event(tenantId: string, runtimeFamily: string, capabilityKey: string, capabilityVersion: string, type: string, evidenceDigest: string): void {
    digestSchema.parse(evidenceDigest);
    this.database.prepare("INSERT INTO lifecycle_events (tenant_id, runtime_family, capability_key, capability_version, event_type, evidence_digest, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(tenantId, runtimeFamily, capabilityKey, capabilityVersion, type, evidenceDigest, this.now());
  }
}
