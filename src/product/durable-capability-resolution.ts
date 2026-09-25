import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  artifactClassificationSchema,
  type ArtifactClassification,
  type CompiledCapabilityResolutionPlan,
  type GraphInputBinding,
} from "./capability-resolution-compiler.js";
import { redactText } from "./redaction.js";
import {
  VerifiedArtifactStore,
  verifiedArtifactDigest,
  type VerifiedArtifact,
} from "./verified-artifact-flow.js";
import {
  VerifierTemplateQualificationRegistry,
  type VerifierTemplateQualificationReference,
} from "./verifier-template-qualification.js";

const identifier = z.string().min(1).max(180).regex(/^[a-zA-Z0-9_.-]+$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function planDigest(plan: CompiledCapabilityResolutionPlan): string {
  const { planId: _planId, planDigest: _planDigest, ...unsigned } = plan;
  return sha256(unsigned);
}

function artifactId(plan: CompiledCapabilityResolutionPlan, workItemId: string, outputKey: string): string {
  return `artifact.${sha256(`${plan.planId}\u001f${workItemId}\u001f${outputKey}`).slice(0, 40)}`;
}

function recoveryConsumerId(workItemId: string): string {
  return `recovery.${sha256(workItemId).slice(0, 24)}`;
}

function aggregateConsumerId(plan: CompiledCapabilityResolutionPlan): string {
  return `aggregate.${sha256(plan.aggregateVerifierKey).slice(0, 24)}`;
}

export type CapabilityResolutionJobStatus =
  | "queued"
  | "running"
  | "autonomous-completion"
  | "precise-handoff"
  | "unresolved-safe";

export type CapabilityResolutionItemStatus =
  | "pending"
  | "running"
  | "verified"
  | "retained"
  | "blocked"
  | "unresolved-safe";

export interface CapabilityResolutionJobReceipt {
  schemaVersion: "1.0";
  jobId: string;
  tenantId: string;
  requestId: string;
  parentGoalId: string;
  planId: string;
  planDigest: string;
  status: CapabilityResolutionJobStatus;
  attempts: number;
  parentResumed: boolean;
  parentResumeReceiptDigest?: string;
  handoffReceiptDigest?: string;
  aggregateEvidenceDigest?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityResolutionItemReceipt {
  workItemId: string;
  status: CapabilityResolutionItemStatus;
  evidenceReceiptDigest?: string;
  retentionReceiptDigest?: string;
  error?: string;
  updatedAt: string;
}

export interface CapabilityResolutionEvent {
  sequence: number;
  jobId: string;
  tenantId: string;
  workItemId?: string;
  type: string;
  status: string;
  occurredAt: string;
}

interface JobRow {
  job_id: string;
  tenant_id: string;
  request_id: string;
  parent_goal_id: string;
  plan_id: string;
  plan_digest: string;
  plan_json: string;
  status: CapabilityResolutionJobStatus;
  attempts: number;
  parent_resumed: number;
  parent_resume_receipt_digest: string | null;
  handoff_receipt_digest: string | null;
  aggregate_evidence_digest: string | null;
  error_text: string | null;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  job_id: string;
  work_item_id: string;
  ordinal: number;
  status: CapabilityResolutionItemStatus;
  evidence_receipt_digest: string | null;
  retention_receipt_digest: string | null;
  error_text: string | null;
  updated_at: string;
}

function jobReceipt(row: JobRow): CapabilityResolutionJobReceipt {
  return {
    schemaVersion: "1.0",
    jobId: row.job_id,
    tenantId: row.tenant_id,
    requestId: row.request_id,
    parentGoalId: row.parent_goal_id,
    planId: row.plan_id,
    planDigest: row.plan_digest,
    status: row.status,
    attempts: row.attempts,
    parentResumed: row.parent_resumed === 1,
    ...(row.parent_resume_receipt_digest ? { parentResumeReceiptDigest: row.parent_resume_receipt_digest } : {}),
    ...(row.handoff_receipt_digest ? { handoffReceiptDigest: row.handoff_receipt_digest } : {}),
    ...(row.aggregate_evidence_digest ? { aggregateEvidenceDigest: row.aggregate_evidence_digest } : {}),
    ...(row.error_text ? { error: row.error_text } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function itemReceipt(row: ItemRow): CapabilityResolutionItemReceipt {
  return {
    workItemId: row.work_item_id,
    status: row.status,
    ...(row.evidence_receipt_digest ? { evidenceReceiptDigest: row.evidence_receipt_digest } : {}),
    ...(row.retention_receipt_digest ? { retentionReceiptDigest: row.retention_receipt_digest } : {}),
    ...(row.error_text ? { error: row.error_text } : {}),
    updatedAt: row.updated_at,
  };
}

function safeError(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

function hashForFailure(error: unknown): string {
  return sha256(`fail-closed\u001f${safeError(error)}`);
}

/**
 * Durable customer-local state for a compiled capability graph. The item that
 * was running when a process stopped remains `running`; recovery therefore
 * enters reconciliation rather than repeating the action.
 */
export class DurableCapabilityResolutionStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string, private readonly now: () => string = () => new Date().toISOString()) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS capability_resolution_jobs (
        job_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        parent_goal_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        plan_digest TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        parent_resumed INTEGER NOT NULL DEFAULT 0,
        parent_resume_receipt_digest TEXT,
        handoff_receipt_digest TEXT,
        aggregate_evidence_digest TEXT,
        error_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, parent_goal_id)
      );
      CREATE TABLE IF NOT EXISTS capability_resolution_items (
        job_id TEXT NOT NULL,
        work_item_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        status TEXT NOT NULL,
        evidence_receipt_digest TEXT,
        retention_receipt_digest TEXT,
        error_text TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (job_id, work_item_id)
      );
      CREATE TABLE IF NOT EXISTS capability_resolution_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        work_item_id TEXT,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
  }

  create(plan: CompiledCapabilityResolutionPlan): { job: CapabilityResolutionJobReceipt; created: boolean } {
    assertCompiledPlanIntegrity(plan);
    const jobId = `resolution.${sha256(`${plan.tenantId}\u001f${plan.parentGoalId}`).slice(0, 32)}`;
    const timestamp = this.now();
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const inserted = this.database.prepare(`
        INSERT OR IGNORE INTO capability_resolution_jobs
          (job_id, tenant_id, request_id, parent_goal_id, plan_id, plan_digest, plan_json,
           status, attempts, parent_resumed, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, 0, ?, ?)
      `).run(
        jobId, plan.tenantId, plan.requestId, plan.parentGoalId, plan.planId,
        plan.planDigest, JSON.stringify(plan), timestamp, timestamp,
      );
      if (inserted.changes === 1) {
        const insertItem = this.database.prepare(`
          INSERT INTO capability_resolution_items
            (job_id, work_item_id, ordinal, status, updated_at)
          VALUES (?, ?, ?, 'pending', ?)
        `);
        plan.orderedWorkItems.forEach((item, ordinal) => insertItem.run(jobId, item.workItemId, ordinal, timestamp));
        this.event(jobId, plan.tenantId, undefined, "resolution-job.queued", "queued", timestamp);
      }
      this.database.exec("COMMIT;");
      const created = inserted.changes === 1;
      const row = this.jobRow(plan.tenantId, jobId);
      if (!row) throw new Error("Durable capability-resolution job was not persisted.");
      if (
        row.plan_digest !== plan.planDigest
        || row.plan_id !== plan.planId
        || row.request_id !== plan.requestId
        || row.plan_json !== JSON.stringify(plan)
      ) throw new Error("This parent goal already belongs to a different compiled capability plan.");
      return { job: jobReceipt(row), created };
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  get(tenantId: string, jobId: string): CapabilityResolutionJobReceipt | undefined {
    const row = this.jobRow(tenantId, jobId);
    return row ? jobReceipt(row) : undefined;
  }

  plan(tenantId: string, jobId: string): CompiledCapabilityResolutionPlan {
    const row = this.jobRow(tenantId, jobId);
    if (!row) throw new Error("Durable capability-resolution job was not found.");
    const plan = JSON.parse(row.plan_json) as CompiledCapabilityResolutionPlan;
    assertCompiledPlanIntegrity(plan);
    if (plan.planDigest !== row.plan_digest) throw new Error("Stored capability-resolution plan digest changed.");
    return plan;
  }

  items(jobId: string): CapabilityResolutionItemReceipt[] {
    return (this.database.prepare(`
      SELECT * FROM capability_resolution_items WHERE job_id = ? ORDER BY ordinal ASC
    `).all(jobId) as unknown as ItemRow[]).map(itemReceipt);
  }

  events(tenantId: string, jobId: string, afterSequence = 0): CapabilityResolutionEvent[] {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new Error("Event cursor must be non-negative.");
    return (this.database.prepare(`
      SELECT sequence, job_id, tenant_id, work_item_id, event_type, status, occurred_at
      FROM capability_resolution_events
      WHERE tenant_id = ? AND job_id = ? AND sequence > ? ORDER BY sequence ASC
    `).all(tenantId, jobId, afterSequence) as unknown as Array<{
      sequence: number; job_id: string; tenant_id: string; work_item_id: string | null;
      event_type: string; status: string; occurred_at: string;
    }>).map((row) => ({
      sequence: row.sequence,
      jobId: row.job_id,
      tenantId: row.tenant_id,
      ...(row.work_item_id ? { workItemId: row.work_item_id } : {}),
      type: row.event_type,
      status: row.status,
      occurredAt: row.occurred_at,
    }));
  }

  claim(tenantId: string, jobId: string): boolean {
    const timestamp = this.now();
    const updated = this.database.prepare(`
      UPDATE capability_resolution_jobs
      SET status = 'running', attempts = attempts + 1, error_text = NULL, updated_at = ?
      WHERE tenant_id = ? AND job_id = ? AND status = 'queued'
    `).run(timestamp, tenantId, jobId);
    if (updated.changes === 1) this.event(jobId, tenantId, undefined, "resolution-job.started", "running", timestamp);
    return updated.changes === 1;
  }

  startItem(tenantId: string, jobId: string, workItemId: string): void {
    this.transitionItem(tenantId, jobId, workItemId, ["pending"], "running", "resolution-item.started");
  }

  markItemVerified(tenantId: string, jobId: string, workItemId: string, evidenceReceiptDigest: string): void {
    digestSchema.parse(evidenceReceiptDigest);
    this.transitionItem(tenantId, jobId, workItemId, ["running"], "verified", "resolution-item.verified", {
      evidenceReceiptDigest,
    });
  }

  markItemRetained(tenantId: string, jobId: string, workItemId: string, retentionReceiptDigest: string): void {
    digestSchema.parse(retentionReceiptDigest);
    this.transitionItem(tenantId, jobId, workItemId, ["verified"], "retained", "resolution-item.retained", {
      retentionReceiptDigest,
    });
  }

  stopItem(tenantId: string, jobId: string, workItemId: string, status: "blocked" | "unresolved-safe", error: unknown): void {
    this.transitionItem(tenantId, jobId, workItemId, ["pending", "running", "verified"], status, `resolution-item.${status}`, {
      error: safeError(error),
    });
  }

  complete(
    tenantId: string,
    jobId: string,
    status: "autonomous-completion" | "precise-handoff" | "unresolved-safe",
    input: { aggregateEvidenceDigest?: string; parentResumeReceiptDigest?: string; handoffReceiptDigest?: string; error?: string },
  ): CapabilityResolutionJobReceipt {
    if (input.aggregateEvidenceDigest) digestSchema.parse(input.aggregateEvidenceDigest);
    if (input.parentResumeReceiptDigest) digestSchema.parse(input.parentResumeReceiptDigest);
    if (input.handoffReceiptDigest) digestSchema.parse(input.handoffReceiptDigest);
    const resumed = status === "autonomous-completion" && Boolean(input.parentResumeReceiptDigest);
    if (status === "autonomous-completion" && (!input.aggregateEvidenceDigest || !resumed)) {
      throw new Error("Autonomous completion requires aggregate external evidence and a parent-resumption receipt.");
    }
    if (status === "precise-handoff" && !input.handoffReceiptDigest) {
      throw new Error("A precise handoff requires a digest-bound handoff receipt.");
    }
    const timestamp = this.now();
    const updated = this.database.prepare(`
      UPDATE capability_resolution_jobs
      SET status = ?, aggregate_evidence_digest = ?, parent_resumed = ?,
          parent_resume_receipt_digest = ?, handoff_receipt_digest = ?, error_text = ?, updated_at = ?
      WHERE tenant_id = ? AND job_id = ? AND status = 'running'
    `).run(
      status, input.aggregateEvidenceDigest ?? null, resumed ? 1 : 0,
      input.parentResumeReceiptDigest ?? null, input.handoffReceiptDigest ?? null,
      input.error ? safeError(input.error) : null,
      timestamp, tenantId, jobId,
    );
    if (updated.changes !== 1) throw new Error("Running capability-resolution job could not be completed.");
    this.event(jobId, tenantId, undefined, "resolution-job.finished", status, timestamp);
    return jobReceipt(this.jobRow(tenantId, jobId)!);
  }

  recoverInterrupted(maxAttempts = 2): CapabilityResolutionJobReceipt[] {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
      throw new Error("Capability-resolution recovery allows between one and three attempts.");
    }
    const timestamp = this.now();
    const running = this.database.prepare(`SELECT * FROM capability_resolution_jobs WHERE status = 'running'`).all() as unknown as JobRow[];
    for (const row of running) {
      const status = row.attempts < maxAttempts ? "queued" : "unresolved-safe";
      this.database.prepare(`
        UPDATE capability_resolution_jobs SET status = ?, error_text = ?, updated_at = ? WHERE job_id = ?
      `).run(status, status === "queued" ? null : "Recovery attempt ceiling reached.", timestamp, row.job_id);
      this.event(row.job_id, row.tenant_id, undefined, "resolution-job.recovered", status, timestamp);
    }
    return (this.database.prepare(`SELECT * FROM capability_resolution_jobs WHERE status = 'queued' ORDER BY created_at ASC`).all() as unknown as JobRow[]).map(jobReceipt);
  }

  health(): { status: "ready" | "degraded"; error?: string } {
    const row = this.database.prepare("PRAGMA quick_check").get() as unknown as Record<string, unknown>;
    const value = Object.values(row)[0];
    return value === "ok" ? { status: "ready" } : { status: "degraded", error: `Capability-resolution job database check failed: ${String(value)}` };
  }

  close(): void {
    this.database.close();
  }

  private transitionItem(
    tenantId: string,
    jobId: string,
    workItemId: string,
    from: CapabilityResolutionItemStatus[],
    to: CapabilityResolutionItemStatus,
    eventType: string,
    values: { evidenceReceiptDigest?: string; retentionReceiptDigest?: string; error?: string } = {},
  ): void {
    const timestamp = this.now();
    const placeholders = from.map(() => "?").join(", ");
    const updated = this.database.prepare(`
      UPDATE capability_resolution_items
      SET status = ?, evidence_receipt_digest = COALESCE(?, evidence_receipt_digest),
          retention_receipt_digest = COALESCE(?, retention_receipt_digest), error_text = ?, updated_at = ?
      WHERE job_id = ? AND work_item_id = ? AND status IN (${placeholders})
    `).run(
      to, values.evidenceReceiptDigest ?? null, values.retentionReceiptDigest ?? null,
      values.error ?? null, timestamp, jobId, workItemId, ...from,
    );
    if (updated.changes !== 1) throw new Error(`Capability-resolution item ${workItemId} could not transition to ${to}.`);
    this.event(jobId, tenantId, workItemId, eventType, to, timestamp);
  }

  private jobRow(tenantId: string, jobId: string): JobRow | undefined {
    return this.database.prepare(`
      SELECT * FROM capability_resolution_jobs WHERE tenant_id = ? AND job_id = ?
    `).get(tenantId, jobId) as unknown as JobRow | undefined;
  }

  private event(jobId: string, tenantId: string, workItemId: string | undefined, type: string, status: string, occurredAt: string): void {
    this.database.prepare(`
      INSERT INTO capability_resolution_events
        (job_id, tenant_id, work_item_id, event_type, status, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(jobId, tenantId, workItemId ?? null, type, status, occurredAt);
  }
}

export interface BoundInputContract {
  inputKey: string;
  schemaKey: string;
  maximumClassification: ArtifactClassification;
  allowedSources: GraphInputBinding["kind"][];
  parse(value: unknown): unknown;
}

export interface RuntimeBindingQualification {
  schemaVersion: "1.0";
  status: "qualified";
  qualificationDigest: string;
  primitiveRegistryDigest: string;
  verifierRegistryDigest: string;
  qualifiedAt: string;
}

export interface CapabilityResolutionExecutionContext {
  tenantId: string;
  requestId: string;
  parentGoalId: string;
  planId: string;
  planDigest: string;
  workItemId: string;
  primitiveKey: string;
  primitiveVersion: string;
  targetAlias: string;
  actionKey: string;
}

export interface CapabilityResolutionObservation {
  passed: boolean;
  incorrectSideEffects: number;
  evidenceReceiptDigest: string;
  outputs: Record<string, unknown>;
  detail: string;
}

export interface CapabilityResolutionReconciliation {
  classification: "completed" | "not-started" | "partial" | "incorrect" | "unknown";
  evidenceDigest: string;
  detail: string;
}

export interface CapabilityResolutionRuntimeBinding {
  readonly primitiveKey: string;
  readonly primitiveVersion: string;
  readonly runtimeFamily: string;
  readonly targetAlias: string;
  readonly actionKey: string;
  readonly routeBuilderKey: string;
  readonly observationKeys: string[];
  readonly verifierTemplateKey: string;
  readonly verifierTemplateQualification: VerifierTemplateQualificationReference;
  readonly inputContracts: BoundInputContract[];
  readonly qualification: RuntimeBindingQualification;
  execute(input: { context: CapabilityResolutionExecutionContext; values: Readonly<Record<string, unknown>>; idempotencyKey: string }): Promise<void>;
  reconcile(input: { context: CapabilityResolutionExecutionContext; values: Readonly<Record<string, unknown>>; idempotencyKey: string }): Promise<CapabilityResolutionReconciliation>;
  verify(input: { context: CapabilityResolutionExecutionContext; values: Readonly<Record<string, unknown>> }): Promise<CapabilityResolutionObservation>;
  retain(input: { context: CapabilityResolutionExecutionContext; retentionKey: string; evidenceReceiptDigest: string }): Promise<{ retained: true; receiptDigest: string }>;
  quarantine(input: { context: CapabilityResolutionExecutionContext; reason: string; evidenceDigest?: string }): Promise<void>;
}

export interface CapabilityResolutionAuthorityGate {
  check(input: {
    context: CapabilityResolutionExecutionContext;
    maximumRisk: string;
    requiredApprovalKeys: string[];
  }): Promise<{
    allowed: boolean;
    authorityDigest: string;
    planDigest: string;
    detail: string;
    handoffReceiptDigest?: string;
  }>;
}

export interface TrustedCapabilityValueResolver {
  resolve(input: {
    context: CapabilityResolutionExecutionContext;
    binding: Exclude<GraphInputBinding, { kind: "verified-artifact" }>;
    contract: Omit<BoundInputContract, "parse">;
  }): Promise<{ value: unknown; provenanceDigest: string }>;
}

export interface CapabilityResolutionAggregateVerifier {
  readonly key: string;
  readonly kind: "independent-external-state";
  readonly qualification: RuntimeBindingQualification;
  verify(input: {
    plan: CompiledCapabilityResolutionPlan;
    terminalArtifacts: Array<{ artifact: VerifiedArtifact; value: unknown }>;
  }): Promise<{ passed: boolean; incorrectSideEffects: number; evidenceDigest: string; detail: string }>;
}

export interface CapabilityResolutionParentResumer {
  resume(input: {
    plan: CompiledCapabilityResolutionPlan;
    aggregateEvidenceDigest: string;
    itemEvidenceDigests: string[];
    resumptionKey: string;
  }): Promise<{ resumed: true; completed: true; receiptDigest: string }>;
  reconcile(input: {
    plan: CompiledCapabilityResolutionPlan;
    aggregateEvidenceDigest: string;
    resumptionKey: string;
  }): Promise<{
    classification: "completed" | "not-started" | "partial" | "incorrect" | "unknown";
    receiptDigest?: string;
    evidenceDigest: string;
    detail: string;
  }>;
}

export interface DurableCapabilityResolutionRuntime {
  primitiveRegistryDigest: string;
  verifierRegistryDigest: string;
  supportedRuntimeFamilies: string[];
  verifierTemplateQualifications: VerifierTemplateQualificationRegistry;
  bindings: CapabilityResolutionRuntimeBinding[];
  authority: CapabilityResolutionAuthorityGate;
  values: TrustedCapabilityValueResolver;
  aggregateVerifier: CapabilityResolutionAggregateVerifier;
  parentResumer: CapabilityResolutionParentResumer;
}

function assertCompiledPlanIntegrity(plan: CompiledCapabilityResolutionPlan): void {
  digestSchema.parse(plan.planDigest);
  digestSchema.parse(plan.primitiveRegistryDigest);
  digestSchema.parse(plan.verifierRegistryDigest);
  if (planDigest(plan) !== plan.planDigest) throw new Error("Compiled capability-resolution plan failed its immutable digest check.");
  if (plan.planId !== `capability-plan-${plan.planDigest.slice(0, 24)}`) throw new Error("Compiled capability-resolution plan ID does not match its digest.");
  if (new Set(plan.orderedWorkItems.map((item) => item.workItemId)).size !== plan.orderedWorkItems.length) {
    throw new Error("Compiled capability-resolution plan contains duplicate work-item identities.");
  }
}

function executionContext(plan: CompiledCapabilityResolutionPlan, workItemId: string): CapabilityResolutionExecutionContext {
  const item = plan.orderedWorkItems.find((candidate) => candidate.workItemId === workItemId);
  if (!item) throw new Error(`Compiled work item ${workItemId} is unavailable.`);
  return {
    tenantId: plan.tenantId,
    requestId: plan.requestId,
    parentGoalId: plan.parentGoalId,
    planId: plan.planId,
    planDigest: plan.planDigest,
    workItemId: item.workItemId,
    primitiveKey: item.primitiveKey,
    primitiveVersion: item.primitiveVersion,
    targetAlias: item.targetAlias,
    actionKey: item.actionKey,
  };
}

function qualificationMatches(
  qualification: RuntimeBindingQualification,
  plan: CompiledCapabilityResolutionPlan,
): boolean {
  return qualification.schemaVersion === "1.0"
    && qualification.status === "qualified"
    && digestSchema.safeParse(qualification.qualificationDigest).success
    && qualification.primitiveRegistryDigest === plan.primitiveRegistryDigest
    && qualification.verifierRegistryDigest === plan.verifierRegistryDigest
    && Number.isFinite(Date.parse(qualification.qualifiedAt));
}

/**
 * Executes only a digest-bound compiler plan through separately qualified
 * runtime bindings. The action response is deliberately unavailable to both
 * leaf and aggregate verifiers.
 */
export class DurableCapabilityResolutionExecutor {
  constructor(
    private readonly store: DurableCapabilityResolutionStore,
    private readonly artifacts: VerifiedArtifactStore,
    private readonly runtime: DurableCapabilityResolutionRuntime,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly artifactLifetimeMs = 24 * 60 * 60 * 1_000,
  ) {}

  submit(plan: CompiledCapabilityResolutionPlan): { job: CapabilityResolutionJobReceipt; created: boolean } {
    this.preflight(plan);
    return this.store.create(plan);
  }

  async run(tenantId: string, jobId: string): Promise<CapabilityResolutionJobReceipt> {
    const current = this.store.get(tenantId, jobId);
    if (!current) throw new Error("Durable capability-resolution job was not found.");
    if (["autonomous-completion", "precise-handoff", "unresolved-safe"].includes(current.status)) return current;
    if (!this.store.claim(tenantId, jobId)) throw new Error("Capability-resolution job is not available to run.");
    const plan = this.store.plan(tenantId, jobId);
    try {
      this.preflight(plan);
      for (const item of plan.orderedWorkItems) {
        const dependencyStates = new Map(this.store.items(jobId).map((receipt) => [receipt.workItemId, receipt.status]));
        if (item.dependsOn.some((dependency) => dependencyStates.get(dependency) !== "retained")) {
          return this.store.complete(tenantId, jobId, "unresolved-safe", { error: `Dependency for ${item.workItemId} did not finish verified retention.` });
        }
        const state = this.store.items(jobId).find((receipt) => receipt.workItemId === item.workItemId);
        if (!state) throw new Error(`Durable state for ${item.workItemId} is unavailable.`);
        if (state.status === "retained") continue;
        const binding = this.binding(plan, item.workItemId);
        const context = executionContext(plan, item.workItemId);
        const values = await this.resolveInputs(plan, item.workItemId, binding);
        const authority = await this.runtime.authority.check({
          context,
          maximumRisk: item.maximumRisk,
          requiredApprovalKeys: [...item.requiredApprovalKeys],
        });
        digestSchema.parse(authority.authorityDigest);
        if (authority.planDigest !== plan.planDigest) throw new Error("Live authority receipt is not bound to the compiled plan.");
        if (!authority.allowed) {
          if (!authority.handoffReceiptDigest) throw new Error("Denied authority did not provide a precise handoff receipt.");
          digestSchema.parse(authority.handoffReceiptDigest);
          this.store.stopItem(tenantId, jobId, item.workItemId, "blocked", authority.detail);
          return this.store.complete(tenantId, jobId, "precise-handoff", {
            handoffReceiptDigest: authority.handoffReceiptDigest,
            error: authority.detail,
          });
        }

        const idempotencyKey = sha256(`${plan.planDigest}\u001f${item.workItemId}`);
        let recovery = state.status === "running";
        if (state.status === "pending") {
          this.store.startItem(tenantId, jobId, item.workItemId);
          try {
            await binding.execute({ context, values, idempotencyKey });
          } catch {
            recovery = true;
          }
        } else if (state.status !== "verified" && state.status !== "running") {
          throw new Error(`Work item ${item.workItemId} cannot continue from ${state.status}.`);
        }

        if (recovery) {
          const reconciled = await binding.reconcile({ context, values, idempotencyKey });
          digestSchema.parse(reconciled.evidenceDigest);
          if (reconciled.classification !== "completed") {
            await binding.quarantine({ context, reason: reconciled.detail, evidenceDigest: reconciled.evidenceDigest });
            this.store.stopItem(tenantId, jobId, item.workItemId, "unresolved-safe", `Reconciliation classified external state as ${reconciled.classification}: ${reconciled.detail}`);
            return this.store.complete(tenantId, jobId, "unresolved-safe", { error: reconciled.detail });
          }
        }

        let evidenceDigest = state.evidenceReceiptDigest;
        if (state.status !== "verified") {
          let observation: CapabilityResolutionObservation;
          try {
            observation = await binding.verify({ context, values });
          } catch (error) {
            await binding.quarantine({ context, reason: `Independent verification failed closed: ${safeError(error)}` });
            this.store.stopItem(tenantId, jobId, item.workItemId, "unresolved-safe", error);
            return this.store.complete(tenantId, jobId, "unresolved-safe", { error: safeError(error) });
          }
          digestSchema.parse(observation.evidenceReceiptDigest);
          if (!observation.passed || observation.incorrectSideEffects !== 0) {
            await binding.quarantine({ context, reason: observation.detail, evidenceDigest: observation.evidenceReceiptDigest });
            this.store.stopItem(tenantId, jobId, item.workItemId, "unresolved-safe", observation.detail);
            return this.store.complete(tenantId, jobId, "unresolved-safe", { error: observation.detail });
          }
          await this.publishOutputs(plan, item.workItemId, observation);
          this.store.markItemVerified(tenantId, jobId, item.workItemId, observation.evidenceReceiptDigest);
          evidenceDigest = observation.evidenceReceiptDigest;
        }
        if (!evidenceDigest) throw new Error(`Verified work item ${item.workItemId} has no evidence receipt.`);
        const retention = await binding.retain({
          context,
          retentionKey: sha256(`retention\u001f${plan.planDigest}\u001f${item.workItemId}`),
          evidenceReceiptDigest: evidenceDigest,
        });
        if (!retention.retained) throw new Error("Runtime binding did not retain the verified capability.");
        digestSchema.parse(retention.receiptDigest);
        this.store.markItemRetained(tenantId, jobId, item.workItemId, retention.receiptDigest);
      }

      const terminalArtifacts = plan.terminalOutputs.map((terminal) => this.artifacts.resolve({
        artifactId: artifactId(plan, terminal.workItemId, terminal.outputKey),
        tenantId: plan.tenantId,
        parentGoalId: plan.parentGoalId,
        consumerWorkItemId: aggregateConsumerId(plan),
        expectedSchemaKey: plan.orderedWorkItems
          .find((item) => item.workItemId === terminal.workItemId)!
          .outputSchemas.find((output) => output.key === terminal.outputKey)!.schemaKey,
        maximumClassification: "restricted",
        planDigest: plan.planDigest,
        now: this.now(),
      }));
      let aggregate: Awaited<ReturnType<CapabilityResolutionAggregateVerifier["verify"]>>;
      try {
        aggregate = await this.runtime.aggregateVerifier.verify({ plan, terminalArtifacts });
      } catch (error) {
        await this.quarantineAll(plan, `Aggregate verification failed closed: ${safeError(error)}`, hashForFailure(error));
        return this.store.complete(tenantId, jobId, "unresolved-safe", { error: safeError(error) });
      }
      digestSchema.parse(aggregate.evidenceDigest);
      if (!aggregate.passed || aggregate.incorrectSideEffects !== 0) {
        await this.quarantineAll(plan, aggregate.detail, aggregate.evidenceDigest);
        return this.store.complete(tenantId, jobId, "unresolved-safe", {
          aggregateEvidenceDigest: aggregate.evidenceDigest,
          error: aggregate.detail,
        });
      }
      const itemEvidenceDigests = this.store.items(jobId).map((item) => item.evidenceReceiptDigest).filter((value): value is string => Boolean(value));
      if (itemEvidenceDigests.length !== plan.orderedWorkItems.length) throw new Error("Parent resumption requires one evidence receipt per work item.");
      const resumptionKey = sha256(`parent-resumption\u001f${plan.planDigest}`);
      let resumed: { resumed: true; completed: true; receiptDigest: string };
      try {
        resumed = await this.runtime.parentResumer.resume({
          plan,
          aggregateEvidenceDigest: aggregate.evidenceDigest,
          itemEvidenceDigests,
          resumptionKey,
        });
      } catch (error) {
        const reconciliation = await this.runtime.parentResumer.reconcile({
          plan,
          aggregateEvidenceDigest: aggregate.evidenceDigest,
          resumptionKey,
        });
        digestSchema.parse(reconciliation.evidenceDigest);
        if (reconciliation.classification !== "completed" || !reconciliation.receiptDigest) {
          return this.store.complete(tenantId, jobId, "unresolved-safe", { error: `Parent resumption reconciliation was ${reconciliation.classification}: ${reconciliation.detail}` });
        }
        digestSchema.parse(reconciliation.receiptDigest);
        resumed = { resumed: true, completed: true, receiptDigest: reconciliation.receiptDigest };
      }
      if (!resumed.resumed || !resumed.completed) throw new Error("Parent resumer did not confirm original-goal completion.");
      digestSchema.parse(resumed.receiptDigest);
      return this.store.complete(tenantId, jobId, "autonomous-completion", {
        aggregateEvidenceDigest: aggregate.evidenceDigest,
        parentResumeReceiptDigest: resumed.receiptDigest,
      });
    } catch (error) {
      if (this.store.get(tenantId, jobId)?.status === "running") {
        return this.store.complete(tenantId, jobId, "unresolved-safe", { error: safeError(error) });
      }
      throw error;
    }
  }

  private preflight(plan: CompiledCapabilityResolutionPlan): void {
    assertCompiledPlanIntegrity(plan);
    if (plan.primitiveRegistryDigest !== this.runtime.primitiveRegistryDigest) throw new Error("Current primitive registry does not match the compiled plan.");
    if (plan.verifierRegistryDigest !== this.runtime.verifierRegistryDigest) throw new Error("Current verifier registry does not match the compiled plan.");
    if (
      this.runtime.aggregateVerifier.key !== plan.aggregateVerifierKey
      || this.runtime.aggregateVerifier.kind !== "independent-external-state"
      || !qualificationMatches(this.runtime.aggregateVerifier.qualification, plan)
    ) throw new Error("Aggregate verifier is missing, unqualified or different from the compiled plan.");
    const families = new Set(this.runtime.supportedRuntimeFamilies.map((family) => identifier.parse(family)));
    for (const item of plan.orderedWorkItems) {
      const binding = this.runtime.bindings.find((candidate) => candidate.primitiveKey === item.primitiveKey && candidate.primitiveVersion === item.primitiveVersion);
      if (!binding) throw new Error(`No runtime binding exists for ${item.primitiveKey}@${item.primitiveVersion}.`);
      if (!families.has(binding.runtimeFamily)) throw new Error(`Runtime family ${binding.runtimeFamily} is not supported by this installation.`);
      if (!qualificationMatches(binding.qualification, plan)) throw new Error(`Runtime binding for ${item.workItemId} is not qualified for the compiled registries.`);
      if (binding.verifierTemplateQualification.templateKey !== binding.verifierTemplateKey) {
        throw new Error(`Runtime binding for ${item.workItemId} changed its verifier-template identity.`);
      }
      this.runtime.verifierTemplateQualifications.assertQualified({
        reference: binding.verifierTemplateQualification,
        runtimeFamily: binding.runtimeFamily,
        primitiveRegistryDigest: plan.primitiveRegistryDigest,
        verifierRegistryDigest: plan.verifierRegistryDigest,
        now: this.now(),
      });
      if (
        binding.targetAlias !== item.targetAlias
        || binding.actionKey !== item.actionKey
        || !item.routeBuilderKeys.includes(binding.routeBuilderKey)
        || binding.verifierTemplateKey !== item.verifierTemplateKey
        || JSON.stringify([...binding.observationKeys].sort()) !== JSON.stringify([...item.observationKeys].sort())
      ) throw new Error(`Runtime binding for ${item.workItemId} changed its trusted execution or verification contract.`);
      const contractKeys = binding.inputContracts.map((contract) => contract.inputKey);
      const bindingKeys = item.bindings.map((input) => input.inputKey);
      if (new Set(contractKeys).size !== contractKeys.length || JSON.stringify([...contractKeys].sort()) !== JSON.stringify([...bindingKeys].sort())) {
        throw new Error(`Runtime binding for ${item.workItemId} does not exactly cover compiled inputs.`);
      }
      for (const graphBinding of item.bindings) {
        const contract = binding.inputContracts.find((candidate) => candidate.inputKey === graphBinding.inputKey)!;
        if (!contract.allowedSources.includes(graphBinding.kind)) throw new Error(`Runtime input ${graphBinding.inputKey} rejects its compiled source kind.`);
      }
    }
  }

  private binding(plan: CompiledCapabilityResolutionPlan, workItemId: string): CapabilityResolutionRuntimeBinding {
    const item = plan.orderedWorkItems.find((candidate) => candidate.workItemId === workItemId)!;
    return this.runtime.bindings.find((candidate) => candidate.primitiveKey === item.primitiveKey && candidate.primitiveVersion === item.primitiveVersion)!;
  }

  private async resolveInputs(
    plan: CompiledCapabilityResolutionPlan,
    workItemId: string,
    runtimeBinding: CapabilityResolutionRuntimeBinding,
  ): Promise<Readonly<Record<string, unknown>>> {
    const item = plan.orderedWorkItems.find((candidate) => candidate.workItemId === workItemId)!;
    const context = executionContext(plan, workItemId);
    const values: Record<string, unknown> = {};
    for (const graphBinding of item.bindings) {
      const contract = runtimeBinding.inputContracts.find((candidate) => candidate.inputKey === graphBinding.inputKey)!;
      if (graphBinding.kind === "verified-artifact") {
        const producer = plan.orderedWorkItems.find((candidate) => candidate.workItemId === graphBinding.producerWorkItemId);
        const output = producer?.outputSchemas.find((candidate) => candidate.key === graphBinding.outputKey);
        if (!producer || !output || output.schemaKey !== contract.schemaKey) throw new Error(`Verified artifact binding for ${graphBinding.inputKey} changed schema.`);
        const resolved = this.artifacts.resolve({
          artifactId: artifactId(plan, graphBinding.producerWorkItemId, graphBinding.outputKey),
          tenantId: plan.tenantId,
          parentGoalId: plan.parentGoalId,
          consumerWorkItemId: workItemId,
          expectedSchemaKey: contract.schemaKey,
          maximumClassification: contract.maximumClassification,
          planDigest: plan.planDigest,
          now: this.now(),
        });
        values[contract.inputKey] = contract.parse(resolved.value);
      } else {
        const resolved = await this.runtime.values.resolve({
          context,
          binding: graphBinding,
          contract: {
            inputKey: contract.inputKey,
            schemaKey: contract.schemaKey,
            maximumClassification: contract.maximumClassification,
            allowedSources: [...contract.allowedSources],
          },
        });
        digestSchema.parse(resolved.provenanceDigest);
        values[contract.inputKey] = contract.parse(resolved.value);
      }
    }
    return Object.freeze(values);
  }

  private async publishOutputs(
    plan: CompiledCapabilityResolutionPlan,
    workItemId: string,
    observation: CapabilityResolutionObservation,
  ): Promise<void> {
    const item = plan.orderedWorkItems.find((candidate) => candidate.workItemId === workItemId)!;
    const expected = item.outputSchemas.map((output) => output.key).sort();
    if (JSON.stringify(Object.keys(observation.outputs).sort()) !== JSON.stringify(expected)) {
      throw new Error(`Independent verifier for ${workItemId} did not return the exact compiled output set.`);
    }
    for (const output of item.outputSchemas) {
      const value = observation.outputs[output.key];
      const consumers = plan.orderedWorkItems
        .filter((candidate) => candidate.bindings.some((binding) => binding.kind === "verified-artifact" && binding.producerWorkItemId === workItemId && binding.outputKey === output.key))
        .map((candidate) => candidate.workItemId);
      if (plan.terminalOutputs.some((terminal) => terminal.workItemId === workItemId && terminal.outputKey === output.key)) {
        consumers.push(aggregateConsumerId(plan));
      }
      consumers.push(recoveryConsumerId(workItemId));
      const artifact: VerifiedArtifact = {
        schemaVersion: "1.0",
        artifactId: artifactId(plan, workItemId, output.key),
        version: 1,
        tenantId: plan.tenantId,
        parentGoalId: plan.parentGoalId,
        producerWorkItemId: workItemId,
        schemaKey: output.schemaKey,
        classification: artifactClassificationSchema.parse(output.classification),
        contentDigest: verifiedArtifactDigest(value),
        evidenceReceiptDigest: observation.evidenceReceiptDigest,
        planDigest: plan.planDigest,
        allowedConsumerWorkItemIds: [...new Set(consumers)].sort(),
        expiresAt: new Date(Date.parse(this.now()) + this.artifactLifetimeMs).toISOString(),
        reusePolicy: "same-plan-only",
        customerLocalReference: `local.${sha256(`${plan.planId}\u001f${workItemId}\u001f${output.key}`).slice(0, 32)}`,
        createdAt: this.now(),
      };
      try {
        this.artifacts.publish({
          artifact,
          value,
          producerVerification: {
            passed: true,
            incorrectSideEffects: 0,
            externalEvidenceDigest: observation.evidenceReceiptDigest,
          },
        });
      } catch (error) {
        const existing = this.artifacts.resolve({
          artifactId: artifact.artifactId,
          tenantId: plan.tenantId,
          parentGoalId: plan.parentGoalId,
          consumerWorkItemId: recoveryConsumerId(workItemId),
          expectedSchemaKey: output.schemaKey,
          maximumClassification: "restricted",
          planDigest: plan.planDigest,
          now: this.now(),
        });
        if (
          existing.artifact.contentDigest !== artifact.contentDigest
          || existing.artifact.evidenceReceiptDigest !== artifact.evidenceReceiptDigest
        ) throw error;
      }
    }
  }

  private async quarantineAll(plan: CompiledCapabilityResolutionPlan, reason: string, evidenceDigest: string): Promise<void> {
    for (const item of plan.orderedWorkItems) {
      await this.binding(plan, item.workItemId).quarantine({
        context: executionContext(plan, item.workItemId),
        reason,
        evidenceDigest,
      });
    }
  }
}
