import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  broadGoalRequestSchema,
  isBroadGoalRunResult,
  type BroadGoalRequest,
  type BroadGoalRunResult,
} from "./broad-goal-sdk.js";
import {
  goalContinuationGrantSchema,
  type GoalContinuationGrant,
} from "./continuation.js";
import { redactText } from "./redaction.js";

export type SidecarGoalJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "partially-complete"
  | "blocked"
  | "failed"
  | "unknown"
  | "handoff"
  | "plan-rejected";

export interface SidecarGoalJobReceipt {
  schemaVersion: "1.0";
  jobId: string;
  tenantId: string;
  parentGoalId: string;
  requestId: string;
  status: SidecarGoalJobStatus;
  attempts: number;
  continuationGrantId?: string;
  result?: BroadGoalRunResult;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SidecarGoalJobEvent {
  sequence: number;
  jobId: string;
  tenantId: string;
  type:
    | "job.queued"
    | "job.started"
    | "job.recovered"
    | "job.retry-queued"
    | "job.continuation-queued"
    | "job.completed"
    | "job.partially-complete"
    | "job.blocked"
    | "job.failed"
    | "job.unknown"
    | "job.handoff"
    | "job.plan-rejected"
    | "job.status-changed";
  status: SidecarGoalJobStatus;
  attempts: number;
  occurredAt: string;
}

export function isSidecarGoalJobEvent(value: unknown): value is SidecarGoalJobEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return typeof event.sequence === "number"
    && typeof event.jobId === "string"
    && typeof event.tenantId === "string"
    && typeof event.type === "string"
    && typeof event.status === "string"
    && typeof event.attempts === "number"
    && typeof event.occurredAt === "string";
}

interface SidecarGoalJobRow {
  job_id: string;
  tenant_id: string;
  parent_goal_id: string;
  request_id: string;
  request_digest: string;
  status: SidecarGoalJobStatus;
  attempts: number;
  request_json: string;
  continuation_json: string | null;
  result_json: string | null;
  error_text: string | null;
  created_at: string;
  updated_at: string;
}

export interface SidecarBroadGoalRunner {
  completeGoal(request: BroadGoalRequest): Promise<BroadGoalRunResult>;
  continueGoal?(request: BroadGoalRequest, grant: GoalContinuationGrant): Promise<BroadGoalRunResult>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function requestDigest(request: BroadGoalRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function jobIdFor(request: BroadGoalRequest): string {
  return createHash("sha256")
    .update(`sidecar-goal-job-v1\u001f${request.tenantId}\u001f${request.parentGoalId}`)
    .digest("hex")
    .slice(0, 32);
}

function terminalStatus(result: BroadGoalRunResult): Exclude<SidecarGoalJobStatus, "queued" | "running"> {
  return result.status === "active" ? "unknown" : result.status;
}

function parseResult(raw: string | null): BroadGoalRunResult | undefined {
  if (!raw) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!isBroadGoalRunResult(parsed)) throw new Error("Stored sidecar job result is invalid.");
  return parsed;
}

function receipt(row: SidecarGoalJobRow): SidecarGoalJobReceipt {
  const result = parseResult(row.result_json);
  const continuation = row.continuation_json
    ? goalContinuationGrantSchema.parse(JSON.parse(row.continuation_json))
    : undefined;
  return {
    schemaVersion: "1.0",
    jobId: row.job_id,
    tenantId: row.tenant_id,
    parentGoalId: row.parent_goal_id,
    requestId: row.request_id,
    status: row.status,
    attempts: row.attempts,
    ...(continuation ? { continuationGrantId: continuation.grantId } : {}),
    ...(result ? { result } : {}),
    ...(row.error_text ? { error: row.error_text } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function isSidecarGoalJobReceipt(value: unknown): value is SidecarGoalJobReceipt {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === "1.0"
    && typeof record.jobId === "string"
    && typeof record.tenantId === "string"
    && typeof record.parentGoalId === "string"
    && typeof record.requestId === "string"
    && ["queued", "running", "completed", "partially-complete", "blocked", "failed", "unknown", "handoff", "plan-rejected"].includes(String(record.status))
    && typeof record.attempts === "number"
    && (record.continuationGrantId === undefined || typeof record.continuationGrantId === "string")
    && typeof record.createdAt === "string"
    && typeof record.updatedAt === "string"
    && (record.result === undefined || isBroadGoalRunResult(record.result));
}

/** Durable customer-local queue. Requests contain no credential values or self-granted authority. */
export class SidecarGoalJobStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sidecar_goal_jobs (
        job_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        parent_goal_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        request_json TEXT NOT NULL,
        continuation_json TEXT,
        result_json TEXT,
        error_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, parent_goal_id)
      );
      CREATE INDEX IF NOT EXISTS sidecar_goal_jobs_status ON sidecar_goal_jobs (status, created_at);
      CREATE TABLE IF NOT EXISTS sidecar_goal_job_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sidecar_goal_job_events_job
        ON sidecar_goal_job_events (tenant_id, job_id, sequence);
      CREATE TRIGGER IF NOT EXISTS sidecar_goal_job_insert_event
      AFTER INSERT ON sidecar_goal_jobs
      BEGIN
        INSERT INTO sidecar_goal_job_events
          (job_id, tenant_id, event_type, status, attempts, occurred_at)
        VALUES (NEW.job_id, NEW.tenant_id, 'job.queued', NEW.status, NEW.attempts, NEW.updated_at);
      END;
      CREATE TRIGGER IF NOT EXISTS sidecar_goal_job_update_event
      AFTER UPDATE OF status ON sidecar_goal_jobs
      WHEN OLD.status <> NEW.status
      BEGIN
        INSERT INTO sidecar_goal_job_events
          (job_id, tenant_id, event_type, status, attempts, occurred_at)
        VALUES (
          NEW.job_id,
          NEW.tenant_id,
          CASE
            WHEN NEW.status = 'running' THEN 'job.started'
            WHEN NEW.status = 'queued' AND OLD.status = 'running' THEN 'job.recovered'
            WHEN NEW.status = 'queued' THEN 'job.retry-queued'
            WHEN NEW.status = 'completed' THEN 'job.completed'
            WHEN NEW.status = 'partially-complete' THEN 'job.partially-complete'
            WHEN NEW.status = 'blocked' THEN 'job.blocked'
            WHEN NEW.status = 'failed' THEN 'job.failed'
            WHEN NEW.status = 'unknown' THEN 'job.unknown'
            WHEN NEW.status = 'handoff' THEN 'job.handoff'
            WHEN NEW.status = 'plan-rejected' THEN 'job.plan-rejected'
            ELSE 'job.status-changed'
          END,
          NEW.status,
          NEW.attempts,
          NEW.updated_at
        );
      END;
    `);
    const columns = this.database.prepare("PRAGMA table_info(sidecar_goal_jobs)").all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "continuation_json")) {
      this.database.exec("ALTER TABLE sidecar_goal_jobs ADD COLUMN continuation_json TEXT;");
    }
    this.database.exec(`
      DROP TRIGGER IF EXISTS sidecar_goal_job_update_event;
      CREATE TRIGGER sidecar_goal_job_update_event
      AFTER UPDATE OF status ON sidecar_goal_jobs
      WHEN OLD.status <> NEW.status
      BEGIN
        INSERT INTO sidecar_goal_job_events
          (job_id, tenant_id, event_type, status, attempts, occurred_at)
        VALUES (
          NEW.job_id,
          NEW.tenant_id,
          CASE
            WHEN NEW.status = 'running' THEN 'job.started'
            WHEN NEW.status = 'queued' AND OLD.status = 'running' THEN 'job.recovered'
            WHEN NEW.status = 'queued' AND NEW.continuation_json IS NOT NULL THEN 'job.continuation-queued'
            WHEN NEW.status = 'queued' THEN 'job.retry-queued'
            WHEN NEW.status = 'completed' THEN 'job.completed'
            WHEN NEW.status = 'partially-complete' THEN 'job.partially-complete'
            WHEN NEW.status = 'blocked' THEN 'job.blocked'
            WHEN NEW.status = 'failed' THEN 'job.failed'
            WHEN NEW.status = 'unknown' THEN 'job.unknown'
            WHEN NEW.status = 'handoff' THEN 'job.handoff'
            WHEN NEW.status = 'plan-rejected' THEN 'job.plan-rejected'
            ELSE 'job.status-changed'
          END,
          NEW.status,
          NEW.attempts,
          NEW.updated_at
        );
      END;
      PRAGMA user_version = 2;
    `);
    const integrity = this.health();
    if (integrity.status !== "ready") {
      this.database.close();
      throw new Error(integrity.error);
    }
  }

  create(rawRequest: BroadGoalRequest): { job: SidecarGoalJobReceipt; created: boolean } {
    const request = broadGoalRequestSchema.parse(rawRequest);
    const jobId = jobIdFor(request);
    const digest = requestDigest(request);
    const timestamp = nowIso();
    const inserted = this.database.prepare(`
      INSERT OR IGNORE INTO sidecar_goal_jobs
        (job_id, tenant_id, parent_goal_id, request_id, request_digest, status, attempts,
         request_json, result_json, error_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, NULL, NULL, ?, ?)
    `).run(
      jobId,
      request.tenantId,
      request.parentGoalId,
      request.requestId,
      digest,
      JSON.stringify(request),
      timestamp,
      timestamp,
    );
    const row = this.row(request.tenantId, jobId);
    if (!row) throw new Error("Sidecar job was not persisted.");
    if (row.request_digest !== digest || row.request_id !== request.requestId) {
      throw new Error("This parent goal ID already belongs to a different request.");
    }
    return { job: receipt(row), created: inserted.changes === 1 };
  }

  get(tenantId: string, jobId: string): SidecarGoalJobReceipt | undefined {
    const row = this.row(tenantId, jobId);
    return row ? receipt(row) : undefined;
  }

  events(tenantId: string, jobId: string, afterSequence = 0): SidecarGoalJobEvent[] {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new Error("Event cursor must be a non-negative integer.");
    if (!this.row(tenantId, jobId)) return [];
    return (this.database.prepare(`
      SELECT sequence, job_id, tenant_id, event_type, status, attempts, occurred_at
      FROM sidecar_goal_job_events
      WHERE tenant_id = ? AND job_id = ? AND sequence > ?
      ORDER BY sequence ASC
    `).all(tenantId, jobId, afterSequence) as unknown as Array<{
      sequence: number;
      job_id: string;
      tenant_id: string;
      event_type: SidecarGoalJobEvent["type"];
      status: SidecarGoalJobStatus;
      attempts: number;
      occurred_at: string;
    }>).map((event) => ({
      sequence: event.sequence,
      jobId: event.job_id,
      tenantId: event.tenant_id,
      type: event.event_type,
      status: event.status,
      attempts: event.attempts,
      occurredAt: event.occurred_at,
    }));
  }

  claim(tenantId: string, jobId: string): {
    job: SidecarGoalJobReceipt;
    request: BroadGoalRequest;
    continuation?: GoalContinuationGrant;
  } | undefined {
    const timestamp = nowIso();
    const updated = this.database.prepare(`
      UPDATE sidecar_goal_jobs
      SET status = 'running', attempts = attempts + 1, error_text = NULL, updated_at = ?
      WHERE tenant_id = ? AND job_id = ? AND status = 'queued'
    `).run(timestamp, tenantId, jobId);
    if (updated.changes !== 1) return undefined;
    const row = this.row(tenantId, jobId)!;
    const continuation = row.continuation_json
      ? goalContinuationGrantSchema.parse(JSON.parse(row.continuation_json))
      : undefined;
    return {
      job: receipt(row),
      request: broadGoalRequestSchema.parse(JSON.parse(row.request_json)),
      ...(continuation ? { continuation } : {}),
    };
  }

  complete(tenantId: string, jobId: string, result: BroadGoalRunResult): SidecarGoalJobReceipt {
    const status = terminalStatus(result);
    const updated = this.database.prepare(`
      UPDATE sidecar_goal_jobs
      SET status = ?, result_json = ?, continuation_json = NULL, error_text = NULL, updated_at = ?
      WHERE tenant_id = ? AND job_id = ? AND status = 'running'
    `).run(status, JSON.stringify(result), nowIso(), tenantId, jobId);
    if (updated.changes !== 1) throw new Error("Running sidecar job could not be completed.");
    return receipt(this.row(tenantId, jobId)!);
  }

  markUnknown(tenantId: string, jobId: string, error: unknown): SidecarGoalJobReceipt {
    const message = redactText(error instanceof Error ? error.message : String(error)).slice(0, 1_000);
    const updated = this.database.prepare(`
      UPDATE sidecar_goal_jobs
      SET status = 'unknown', result_json = NULL, error_text = ?, updated_at = ?
      WHERE tenant_id = ? AND job_id = ? AND status = 'running'
    `).run(message, nowIso(), tenantId, jobId);
    if (updated.changes !== 1) throw new Error("Running sidecar job could not be marked unknown.");
    return receipt(this.row(tenantId, jobId)!);
  }

  queueRetry(tenantId: string, jobId: string, maxAttempts: number): SidecarGoalJobReceipt {
    const current = this.row(tenantId, jobId);
    if (!current) throw new Error("Sidecar job not found.");
    if (current.status !== "unknown" || current.result_json !== null || current.error_text === null || current.continuation_json !== null) {
      throw new Error("Only an interrupted job without a result can be retried.");
    }
    if (current.attempts >= maxAttempts) throw new Error("Sidecar job reached its retry limit.");
    this.database.prepare(`
      UPDATE sidecar_goal_jobs SET status = 'queued', updated_at = ?
      WHERE tenant_id = ? AND job_id = ? AND status = 'unknown'
    `).run(nowIso(), tenantId, jobId);
    return receipt(this.row(tenantId, jobId)!);
  }

  queueContinuation(
    tenantId: string,
    jobId: string,
    rawGrant: GoalContinuationGrant,
  ): SidecarGoalJobReceipt {
    const grant = goalContinuationGrantSchema.parse(rawGrant);
    const current = this.row(tenantId, jobId);
    if (!current) throw new Error("Sidecar job not found.");
    if (!["partially-complete", "blocked", "handoff"].includes(current.status)) {
      throw new Error("Only a terminal blocked handoff can receive a continuation grant.");
    }
    const result = parseResult(current.result_json);
    if (!result || !("state" in result)) throw new Error("The sidecar job has no saved blocked goal state.");
    if (
      grant.tenantId !== tenantId ||
      grant.parentGoalId !== current.parent_goal_id ||
      grant.expectedStateVersion !== result.state.version ||
      result.state.items[grant.workItemId]?.lifecycle !== "blocked"
    ) {
      throw new Error("Continuation grant does not match the exact saved blocked state.");
    }
    const updated = this.database.prepare(`
      UPDATE sidecar_goal_jobs
      SET status = 'queued', continuation_json = ?, error_text = NULL, updated_at = ?
      WHERE tenant_id = ? AND job_id = ? AND status IN ('partially-complete', 'blocked', 'handoff')
    `).run(JSON.stringify(grant), nowIso(), tenantId, jobId);
    if (updated.changes !== 1) throw new Error("The blocked sidecar job changed before continuation could be queued.");
    return receipt(this.row(tenantId, jobId)!);
  }

  recoverInterrupted(maxAttempts: number): SidecarGoalJobReceipt[] {
    const running = this.database.prepare(
      "SELECT * FROM sidecar_goal_jobs WHERE status = 'running' ORDER BY created_at ASC",
    ).all() as unknown as SidecarGoalJobRow[];
    for (const row of running) {
      if (row.attempts >= maxAttempts) {
        this.database.prepare(`
          UPDATE sidecar_goal_jobs
          SET status = 'unknown', error_text = ?, updated_at = ?
          WHERE tenant_id = ? AND job_id = ? AND status = 'running'
        `).run("The sidecar restarted after this job reached its retry limit.", nowIso(), row.tenant_id, row.job_id);
      } else {
        this.database.prepare(`
          UPDATE sidecar_goal_jobs SET status = 'queued', updated_at = ?
          WHERE tenant_id = ? AND job_id = ? AND status = 'running'
        `).run(nowIso(), row.tenant_id, row.job_id);
      }
    }
    return this.queued();
  }

  queued(): SidecarGoalJobReceipt[] {
    return (this.database.prepare(
      "SELECT * FROM sidecar_goal_jobs WHERE status = 'queued' ORDER BY created_at ASC",
    ).all() as unknown as SidecarGoalJobRow[]).map(receipt);
  }

  close(): void {
    this.database.close();
  }

  health(): { status: "ready" | "degraded"; error?: string } {
    try {
      const rows = this.database.prepare("PRAGMA quick_check(1)").all() as unknown as Array<{ quick_check: string }>;
      return rows.length === 1 && rows[0]?.quick_check === "ok"
        ? { status: "ready" }
        : { status: "degraded", error: "The durable goal-job database failed its SQLite integrity check." };
    } catch {
      return { status: "degraded", error: "The durable goal-job database integrity check could not complete." };
    }
  }

  private row(tenantId: string, jobId: string): SidecarGoalJobRow | undefined {
    return this.database.prepare(
      "SELECT * FROM sidecar_goal_jobs WHERE tenant_id = ? AND job_id = ?",
    ).get(tenantId, jobId) as unknown as SidecarGoalJobRow | undefined;
  }
}

export interface SidecarGoalJobServiceOptions {
  maxAttempts?: number;
}

/** One-at-a-time pilot worker: safe and easy to inspect before adding concurrency. */
export class SidecarGoalJobService {
  private readonly maxAttempts: number;
  private tail: Promise<void> = Promise.resolve();
  private readonly scheduled = new Set<string>();
  private workerError: string | undefined;

  constructor(
    private readonly store: SidecarGoalJobStore,
    private readonly runner: SidecarBroadGoalRunner,
    options: SidecarGoalJobServiceOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 10) {
      throw new Error("Sidecar goal jobs allow between one and ten attempts.");
    }
  }

  submit(request: BroadGoalRequest): { job: SidecarGoalJobReceipt; created: boolean } {
    const saved = this.store.create(request);
    if (saved.job.status === "queued") this.schedule(saved.job.tenantId, saved.job.jobId);
    return saved;
  }

  get(tenantId: string, jobId: string): SidecarGoalJobReceipt | undefined {
    return this.store.get(tenantId, jobId);
  }

  events(tenantId: string, jobId: string, afterSequence = 0): SidecarGoalJobEvent[] {
    return this.store.events(tenantId, jobId, afterSequence);
  }

  retry(tenantId: string, jobId: string): SidecarGoalJobReceipt {
    const job = this.store.queueRetry(tenantId, jobId, this.maxAttempts);
    this.schedule(tenantId, jobId);
    return job;
  }

  continue(tenantId: string, jobId: string, grant: GoalContinuationGrant): SidecarGoalJobReceipt {
    if (!this.runner.continueGoal) throw new Error("The configured broad-goal runner does not support safe continuation.");
    const job = this.store.queueContinuation(tenantId, jobId, grant);
    this.schedule(tenantId, jobId);
    return job;
  }

  recover(): SidecarGoalJobReceipt[] {
    const queued = this.store.recoverInterrupted(this.maxAttempts);
    for (const job of queued) this.schedule(job.tenantId, job.jobId);
    return queued;
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
          await this.run(tenantId, jobId);
          this.workerError = undefined;
        } catch (error) {
          this.workerError = redactText(error instanceof Error ? error.message : String(error)).slice(0, 1_000);
        }
      })
      .finally(() => this.scheduled.delete(key));
  }

  private async run(tenantId: string, jobId: string): Promise<void> {
    const claimed = this.store.claim(tenantId, jobId);
    if (!claimed) return;
    try {
      const result = claimed.continuation
        ? await this.runner.continueGoal!(claimed.request, claimed.continuation)
        : await this.runner.completeGoal(claimed.request);
      this.store.complete(tenantId, jobId, result);
    } catch (error) {
      this.store.markUnknown(tenantId, jobId, error);
    }
  }
}
