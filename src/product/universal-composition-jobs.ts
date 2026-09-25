import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  universalGoalSubmissionSchema,
  type UniversalGoalSubmission,
} from "./universal-capability-contract.js";
import {
  isUniversalCompositionReceipt,
  type UniversalCompositionCoordinator,
  type UniversalCompositionPlan,
  type UniversalCompositionReceipt,
  type UniversalCompositionVerifier,
} from "./universal-composition.js";
import { redactText } from "./redaction.js";

export type UniversalCompositionJobStatus = "queued" | "running" | UniversalCompositionReceipt["status"];

export interface UniversalCompositionJobReceipt {
  schemaVersion: "1.0";
  jobId: string;
  tenantId: string;
  parentGoalId: string;
  requestId: string;
  compositionKey: string;
  planDigest: string;
  verifierKey: string;
  verifierSourceId: string;
  status: UniversalCompositionJobStatus;
  attempts: number;
  result?: UniversalCompositionReceipt;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UniversalCompositionJobEvent {
  sequence: number;
  jobId: string;
  tenantId: string;
  compositionKey: string;
  type: "composition-job.queued" | "composition-job.started" | "composition-job.recovered" | "composition-job.finished" | "composition-job.unknown";
  status: UniversalCompositionJobStatus;
  attempts: number;
  occurredAt: string;
}

interface CompositionJobRow {
  job_id: string;
  tenant_id: string;
  parent_goal_id: string;
  request_id: string;
  composition_key: string;
  request_digest: string;
  plan_digest: string;
  verifier_key: string;
  verifier_source_id: string;
  status: UniversalCompositionJobStatus;
  attempts: number;
  submission_json: string;
  plan_json: string;
  result_json: string | null;
  error_text: string | null;
  created_at: string;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function jobIdFor(submission: UniversalGoalSubmission): string {
  return createHash("sha256")
    .update(`universal-composition-job-v1\u001f${submission.tenantId}\u001f${submission.parentGoalId}`)
    .digest("hex")
    .slice(0, 32);
}

function parseResult(raw: string | null): UniversalCompositionReceipt | undefined {
  if (!raw) return undefined;
  const value: unknown = JSON.parse(raw);
  if (!isUniversalCompositionReceipt(value)) throw new Error("Stored universal-composition result is invalid.");
  return value;
}

function receipt(row: CompositionJobRow): UniversalCompositionJobReceipt {
  const result = parseResult(row.result_json);
  return {
    schemaVersion: "1.0",
    jobId: row.job_id,
    tenantId: row.tenant_id,
    parentGoalId: row.parent_goal_id,
    requestId: row.request_id,
    compositionKey: row.composition_key,
    planDigest: row.plan_digest,
    verifierKey: row.verifier_key,
    verifierSourceId: row.verifier_source_id,
    status: row.status,
    attempts: row.attempts,
    ...(result ? { result } : {}),
    ...(row.error_text ? { error: row.error_text } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function isUniversalCompositionJobReceipt(value: unknown): value is UniversalCompositionJobReceipt {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return row.schemaVersion === "1.0"
    && typeof row.jobId === "string"
    && typeof row.tenantId === "string"
    && typeof row.parentGoalId === "string"
    && typeof row.requestId === "string"
    && typeof row.compositionKey === "string"
    && typeof row.planDigest === "string"
    && typeof row.verifierKey === "string"
    && typeof row.verifierSourceId === "string"
    && typeof row.status === "string"
    && typeof row.attempts === "number"
    && typeof row.createdAt === "string"
    && typeof row.updatedAt === "string";
}

export function isUniversalCompositionJobEvent(value: unknown): value is UniversalCompositionJobEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return typeof event.sequence === "number"
    && typeof event.jobId === "string"
    && typeof event.tenantId === "string"
    && typeof event.compositionKey === "string"
    && typeof event.type === "string"
    && typeof event.status === "string"
    && typeof event.attempts === "number"
    && typeof event.occurredAt === "string";
}

export class UniversalCompositionJobStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS universal_composition_jobs (
        job_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        parent_goal_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        composition_key TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        plan_digest TEXT NOT NULL,
        verifier_key TEXT NOT NULL,
        verifier_source_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        submission_json TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        result_json TEXT,
        error_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, parent_goal_id)
      );
      CREATE INDEX IF NOT EXISTS universal_composition_jobs_status
        ON universal_composition_jobs (status, created_at);
      CREATE TABLE IF NOT EXISTS universal_composition_job_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        composition_key TEXT NOT NULL,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS universal_composition_job_events_job
        ON universal_composition_job_events (tenant_id, job_id, sequence);
      CREATE TRIGGER IF NOT EXISTS universal_composition_job_insert_event
      AFTER INSERT ON universal_composition_jobs
      BEGIN
        INSERT INTO universal_composition_job_events
          (job_id, tenant_id, composition_key, event_type, status, attempts, occurred_at)
        VALUES (NEW.job_id, NEW.tenant_id, NEW.composition_key, 'composition-job.queued', NEW.status, NEW.attempts, NEW.updated_at);
      END;
      CREATE TRIGGER IF NOT EXISTS universal_composition_job_update_event
      AFTER UPDATE OF status ON universal_composition_jobs
      WHEN OLD.status <> NEW.status
      BEGIN
        INSERT INTO universal_composition_job_events
          (job_id, tenant_id, composition_key, event_type, status, attempts, occurred_at)
        VALUES (
          NEW.job_id, NEW.tenant_id, NEW.composition_key,
          CASE
            WHEN NEW.status = 'running' THEN 'composition-job.started'
            WHEN NEW.status = 'queued' THEN 'composition-job.recovered'
            WHEN NEW.status = 'unresolved-safe' AND NEW.error_text IS NOT NULL THEN 'composition-job.unknown'
            ELSE 'composition-job.finished'
          END,
          NEW.status, NEW.attempts, NEW.updated_at
        );
      END;
      PRAGMA user_version = 1;
    `);
    const health = this.health();
    if (health.status !== "ready") {
      this.database.close();
      throw new Error(health.error);
    }
  }

  create(input: {
    submission: UniversalGoalSubmission;
    compositionKey: string;
    plan: UniversalCompositionPlan;
    verifier: UniversalCompositionVerifier;
  }): { job: UniversalCompositionJobReceipt; created: boolean } {
    const submission = universalGoalSubmissionSchema.parse(input.submission);
    if (
      input.plan.tenantId !== submission.tenantId
      || input.plan.requestId !== submission.requestId
      || input.plan.parentGoalId !== submission.parentGoalId
      || input.plan.ordinaryGoal !== submission.ordinaryGoal
    ) throw new Error("Prepared composition changed immutable ordinary-goal identity.");
    const jobId = jobIdFor(submission);
    const requestHash = digest(submission);
    const planHash = digest(input.plan);
    const timestamp = nowIso();
    const inserted = this.database.prepare(`
      INSERT OR IGNORE INTO universal_composition_jobs
        (job_id, tenant_id, parent_goal_id, request_id, composition_key, request_digest,
         plan_digest, verifier_key, verifier_source_id, status, attempts, submission_json,
         plan_json, result_json, error_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, NULL, NULL, ?, ?)
    `).run(
      jobId, submission.tenantId, submission.parentGoalId, submission.requestId,
      input.compositionKey, requestHash, planHash, input.verifier.key, input.verifier.sourceId,
      JSON.stringify(submission), JSON.stringify(input.plan), timestamp, timestamp,
    );
    const row = this.row(submission.tenantId, jobId);
    if (!row) throw new Error("Universal-composition job was not persisted.");
    if (
      row.request_digest !== requestHash
      || row.request_id !== submission.requestId
      || row.composition_key !== input.compositionKey
      || row.plan_digest !== planHash
      || row.verifier_key !== input.verifier.key
      || row.verifier_source_id !== input.verifier.sourceId
    ) throw new Error("This parent goal already belongs to a different composition request or plan.");
    return { job: receipt(row), created: inserted.changes === 1 };
  }

  /**
   * Returns an existing exact request before trusted/model-backed preparation is
   * repeated. The parent goal is the idempotency boundary; changing any part of
   * the submission under that identity is a conflict, never a re-plan.
   */
  lookupSubmission(rawSubmission: unknown): UniversalCompositionJobReceipt | undefined {
    const submission = universalGoalSubmissionSchema.parse(rawSubmission);
    const row = this.row(submission.tenantId, jobIdFor(submission));
    if (!row) return undefined;
    if (row.request_digest !== digest(submission) || row.request_id !== submission.requestId) {
      throw new Error("This parent goal already belongs to a different universal-composition submission.");
    }
    return receipt(row);
  }

  get(tenantId: string, jobId: string): UniversalCompositionJobReceipt | undefined {
    const row = this.row(tenantId, jobId);
    return row ? receipt(row) : undefined;
  }

  events(tenantId: string, jobId: string, afterSequence = 0): UniversalCompositionJobEvent[] {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new Error("Event cursor must be non-negative.");
    if (!this.row(tenantId, jobId)) return [];
    return (this.database.prepare(`
      SELECT sequence, job_id, tenant_id, composition_key, event_type, status, attempts, occurred_at
      FROM universal_composition_job_events
      WHERE tenant_id = ? AND job_id = ? AND sequence > ? ORDER BY sequence ASC
    `).all(tenantId, jobId, afterSequence) as unknown as Array<{
      sequence: number;
      job_id: string;
      tenant_id: string;
      composition_key: string;
      event_type: UniversalCompositionJobEvent["type"];
      status: UniversalCompositionJobStatus;
      attempts: number;
      occurred_at: string;
    }>).map((event) => ({
      sequence: event.sequence,
      jobId: event.job_id,
      tenantId: event.tenant_id,
      compositionKey: event.composition_key,
      type: event.event_type,
      status: event.status,
      attempts: event.attempts,
      occurredAt: event.occurred_at,
    }));
  }

  claim(tenantId: string, jobId: string): {
    job: UniversalCompositionJobReceipt;
    submission: UniversalGoalSubmission;
    plan: UniversalCompositionPlan;
  } | undefined {
    const updated = this.database.prepare(`
      UPDATE universal_composition_jobs
      SET status = 'running', attempts = attempts + 1, error_text = NULL, updated_at = ?
      WHERE tenant_id = ? AND job_id = ? AND status = 'queued'
    `).run(nowIso(), tenantId, jobId);
    if (updated.changes !== 1) return undefined;
    const row = this.row(tenantId, jobId)!;
    const submission = universalGoalSubmissionSchema.parse(JSON.parse(row.submission_json));
    const plan = JSON.parse(row.plan_json) as UniversalCompositionPlan;
    if (digest(plan) !== row.plan_digest) throw new Error("Stored universal-composition plan digest mismatch.");
    return { job: receipt(row), submission, plan };
  }

  complete(tenantId: string, jobId: string, result: UniversalCompositionReceipt): UniversalCompositionJobReceipt {
    if (!isUniversalCompositionReceipt(result)) throw new Error("Universal-composition result is invalid.");
    const row = this.row(tenantId, jobId);
    if (!row || row.status !== "running") throw new Error("Running universal-composition job was not found.");
    if (result.tenantId !== row.tenant_id || result.parentGoalId !== row.parent_goal_id || result.requestId !== row.request_id) {
      throw new Error("Universal-composition result identity does not match its durable job.");
    }
    const updated = this.database.prepare(`
      UPDATE universal_composition_jobs
      SET status = ?, result_json = ?, error_text = NULL, updated_at = ?
      WHERE tenant_id = ? AND job_id = ? AND status = 'running'
    `).run(result.status, JSON.stringify(result), nowIso(), tenantId, jobId);
    if (updated.changes !== 1) throw new Error("Running universal-composition job could not be completed.");
    return receipt(this.row(tenantId, jobId)!);
  }

  markUnknown(tenantId: string, jobId: string, error: unknown): UniversalCompositionJobReceipt {
    const message = redactText(error instanceof Error ? error.message : String(error)).slice(0, 1_000);
    const updated = this.database.prepare(`
      UPDATE universal_composition_jobs
      SET status = 'unresolved-safe', error_text = ?, updated_at = ?
      WHERE tenant_id = ? AND job_id = ? AND status = 'running'
    `).run(message, nowIso(), tenantId, jobId);
    if (updated.changes !== 1) throw new Error("Universal-composition job could not be marked unresolved-safe.");
    return receipt(this.row(tenantId, jobId)!);
  }

  recoverInterrupted(maxAttempts: number): UniversalCompositionJobReceipt[] {
    this.database.prepare(`
      UPDATE universal_composition_jobs
      SET status = CASE WHEN attempts < ? THEN 'queued' ELSE 'unresolved-safe' END,
          error_text = CASE WHEN attempts < ? THEN NULL ELSE 'Recovery attempt ceiling reached.' END,
          updated_at = ?
      WHERE status = 'running'
    `).run(maxAttempts, maxAttempts, nowIso());
    return (this.database.prepare(
      "SELECT * FROM universal_composition_jobs WHERE status = 'queued' ORDER BY created_at ASC",
    ).all() as unknown as CompositionJobRow[]).map(receipt);
  }

  health(): { status: "ready" | "degraded"; error?: string } {
    const row = this.database.prepare("PRAGMA quick_check").get() as unknown as Record<string, unknown>;
    const value = Object.values(row)[0];
    return value === "ok" ? { status: "ready" } : { status: "degraded", error: `Universal-composition job database check failed: ${String(value)}` };
  }

  close(): void {
    this.database.close();
  }

  private row(tenantId: string, jobId: string): CompositionJobRow | undefined {
    return this.database.prepare(
      "SELECT * FROM universal_composition_jobs WHERE tenant_id = ? AND job_id = ?",
    ).get(tenantId, jobId) as unknown as CompositionJobRow | undefined;
  }
}

export type UniversalCompositionJobPreparer = (submission: UniversalGoalSubmission) => Promise<{
  plan: UniversalCompositionPlan;
  verifier: UniversalCompositionVerifier;
  selectedCompositionKey: string;
}>;

export type UniversalCompositionVerifierResolver = (compositionKey: string) => UniversalCompositionVerifier | undefined;

export class UniversalCompositionJobService {
  private tail: Promise<void> = Promise.resolve();
  private readonly scheduled = new Set<string>();
  private workerError: string | undefined;

  constructor(
    private readonly store: UniversalCompositionJobStore,
    private readonly coordinator: UniversalCompositionCoordinator,
    private readonly prepare: UniversalCompositionJobPreparer,
    private readonly resolveVerifier: UniversalCompositionVerifierResolver,
    private readonly maxAttempts = 2,
  ) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
      throw new Error("Universal-composition recovery allows between one and three attempts.");
    }
  }

  async submit(rawSubmission: unknown): Promise<{ job: UniversalCompositionJobReceipt; created: boolean }> {
    const submission = universalGoalSubmissionSchema.parse(rawSubmission);
    const existing = this.store.lookupSubmission(submission);
    if (existing) {
      if (existing.status === "queued") this.schedule(existing.tenantId, existing.jobId);
      return { job: existing, created: false };
    }
    const prepared = await this.prepare(submission);
    const verifier = this.resolveVerifier(prepared.selectedCompositionKey);
    if (
      !verifier
      || verifier.key !== prepared.verifier.key
      || verifier.sourceId !== prepared.verifier.sourceId
      || verifier.kind !== "independent-external-state"
    ) throw new Error("Trusted composition verifier registry does not match the prepared plan.");
    const saved = this.store.create({
      submission,
      compositionKey: prepared.selectedCompositionKey,
      plan: prepared.plan,
      verifier,
    });
    if (saved.job.status === "queued") this.schedule(saved.job.tenantId, saved.job.jobId);
    return saved;
  }

  get(tenantId: string, jobId: string): UniversalCompositionJobReceipt | undefined {
    return this.store.get(tenantId, jobId);
  }

  events(tenantId: string, jobId: string, afterSequence = 0): UniversalCompositionJobEvent[] {
    return this.store.events(tenantId, jobId, afterSequence);
  }

  recover(): UniversalCompositionJobReceipt[] {
    const jobs = this.store.recoverInterrupted(this.maxAttempts);
    for (const job of jobs) this.schedule(job.tenantId, job.jobId);
    return jobs;
  }

  async idle(): Promise<void> {
    await this.tail;
  }

  health(): { status: "ready" | "degraded"; error?: string } {
    const storage = this.store.health();
    if (storage.status === "degraded") return storage;
    return this.workerError ? { status: "degraded", error: this.workerError } : { status: "ready" };
  }

  async close(): Promise<void> {
    await this.idle();
    this.store.close();
  }

  private schedule(tenantId: string, jobId: string): void {
    const key = `${tenantId}\u001f${jobId}`;
    if (this.scheduled.has(key)) return;
    this.scheduled.add(key);
    this.tail = this.tail
      .catch(() => undefined)
      .then(async () => {
        try {
          const claimed = this.store.claim(tenantId, jobId);
          if (!claimed) return;
          const verifier = this.resolveVerifier(claimed.job.compositionKey);
          if (
            !verifier
            || verifier.key !== claimed.job.verifierKey
            || verifier.sourceId !== claimed.job.verifierSourceId
            || verifier.kind !== "independent-external-state"
          ) throw new Error("The persisted composition verifier identity is no longer trusted.");
          this.store.complete(tenantId, jobId, await this.coordinator.resolve(claimed.plan, verifier));
          this.workerError = undefined;
        } catch (error) {
          const message = redactText(error instanceof Error ? error.message : String(error)).slice(0, 1_000);
          if (this.store.get(tenantId, jobId)?.status === "running") {
            this.store.markUnknown(tenantId, jobId, error);
          }
          this.workerError = message;
        }
      })
      .finally(() => this.scheduled.delete(key));
  }
}
