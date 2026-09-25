import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  capabilityModeEnvelopeSchema,
  capabilityModeIdentity,
  capabilityModeResultSchema,
  type CapabilityMode,
  type CapabilityModeDescriptor,
  type CapabilityModeEnvelope,
  type CapabilityModeResult,
} from "./capability-mode-contract.js";
import type { CapabilityModeRouter } from "./capability-mode-router.js";
import { redactText } from "./redaction.js";

export type CapabilityModeJobStatus =
  | "queued"
  | "running"
  | CapabilityModeResult["status"];

export interface CapabilityModeJobReceipt {
  schemaVersion: "1.0";
  jobId: string;
  tenantId: string;
  parentGoalId: string;
  requestId: string;
  capabilityMode: CapabilityMode;
  status: CapabilityModeJobStatus;
  attempts: number;
  result?: CapabilityModeResult;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityModeJobEvent {
  sequence: number;
  jobId: string;
  tenantId: string;
  capabilityMode: CapabilityMode;
  type: "mode-job.queued" | "mode-job.started" | "mode-job.recovered" | "mode-job.finished" | "mode-job.unknown";
  status: CapabilityModeJobStatus;
  attempts: number;
  occurredAt: string;
}

interface CapabilityModeJobRow {
  job_id: string;
  tenant_id: string;
  parent_goal_id: string;
  request_id: string;
  capability_mode: CapabilityMode;
  request_digest: string;
  status: CapabilityModeJobStatus;
  attempts: number;
  envelope_json: string;
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

function requestDigest(envelope: CapabilityModeEnvelope): string {
  return createHash("sha256").update(canonical(envelope)).digest("hex");
}

function jobIdFor(envelope: CapabilityModeEnvelope): string {
  const identity = capabilityModeIdentity(envelope);
  return createHash("sha256")
    .update(`capability-mode-job-v1\u001f${identity.tenantId}\u001f${identity.parentGoalId}`)
    .digest("hex")
    .slice(0, 32);
}

function receipt(row: CapabilityModeJobRow): CapabilityModeJobReceipt {
  const result = row.result_json
    ? capabilityModeResultSchema.parse(JSON.parse(row.result_json))
    : undefined;
  return {
    schemaVersion: "1.0",
    jobId: row.job_id,
    tenantId: row.tenant_id,
    parentGoalId: row.parent_goal_id,
    requestId: row.request_id,
    capabilityMode: row.capability_mode,
    status: row.status,
    attempts: row.attempts,
    ...(result ? { result } : {}),
    ...(row.error_text ? { error: row.error_text } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function isCapabilityModeJobReceipt(value: unknown): value is CapabilityModeJobReceipt {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return row.schemaVersion === "1.0"
    && typeof row.jobId === "string"
    && typeof row.tenantId === "string"
    && typeof row.parentGoalId === "string"
    && typeof row.requestId === "string"
    && typeof row.capabilityMode === "string"
    && typeof row.status === "string"
    && typeof row.attempts === "number"
    && typeof row.createdAt === "string"
    && typeof row.updatedAt === "string";
}

export function isCapabilityModeJobEvent(value: unknown): value is CapabilityModeJobEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return typeof event.sequence === "number"
    && typeof event.jobId === "string"
    && typeof event.tenantId === "string"
    && typeof event.capabilityMode === "string"
    && typeof event.type === "string"
    && typeof event.status === "string"
    && typeof event.attempts === "number"
    && typeof event.occurredAt === "string";
}

/** Durable queue shared by all modes; mode identity is immutable per parent goal. */
export class CapabilityModeJobStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS capability_mode_jobs (
        job_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        parent_goal_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        capability_mode TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        envelope_json TEXT NOT NULL,
        result_json TEXT,
        error_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, parent_goal_id)
      );
      CREATE INDEX IF NOT EXISTS capability_mode_jobs_status
        ON capability_mode_jobs (status, created_at);
      CREATE TABLE IF NOT EXISTS capability_mode_job_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        capability_mode TEXT NOT NULL,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS capability_mode_job_events_job
        ON capability_mode_job_events (tenant_id, job_id, sequence);
      CREATE TRIGGER IF NOT EXISTS capability_mode_job_insert_event
      AFTER INSERT ON capability_mode_jobs
      BEGIN
        INSERT INTO capability_mode_job_events
          (job_id, tenant_id, capability_mode, event_type, status, attempts, occurred_at)
        VALUES (
          NEW.job_id, NEW.tenant_id, NEW.capability_mode, 'mode-job.queued',
          NEW.status, NEW.attempts, NEW.updated_at
        );
      END;
      CREATE TRIGGER IF NOT EXISTS capability_mode_job_update_event
      AFTER UPDATE OF status ON capability_mode_jobs
      WHEN OLD.status <> NEW.status
      BEGIN
        INSERT INTO capability_mode_job_events
          (job_id, tenant_id, capability_mode, event_type, status, attempts, occurred_at)
        VALUES (
          NEW.job_id,
          NEW.tenant_id,
          NEW.capability_mode,
          CASE
            WHEN NEW.status = 'running' THEN 'mode-job.started'
            WHEN NEW.status = 'queued' THEN 'mode-job.recovered'
            WHEN NEW.status = 'unknown' THEN 'mode-job.unknown'
            ELSE 'mode-job.finished'
          END,
          NEW.status,
          NEW.attempts,
          NEW.updated_at
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

  create(rawEnvelope: unknown): { job: CapabilityModeJobReceipt; created: boolean } {
    const envelope = capabilityModeEnvelopeSchema.parse(rawEnvelope);
    const identity = capabilityModeIdentity(envelope);
    const jobId = jobIdFor(envelope);
    const digest = requestDigest(envelope);
    const timestamp = nowIso();
    const inserted = this.database.prepare(`
      INSERT OR IGNORE INTO capability_mode_jobs
        (job_id, tenant_id, parent_goal_id, request_id, capability_mode, request_digest,
         status, attempts, envelope_json, result_json, error_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, NULL, NULL, ?, ?)
    `).run(
      jobId,
      identity.tenantId,
      identity.parentGoalId,
      identity.requestId,
      envelope.capabilityMode,
      digest,
      JSON.stringify(envelope),
      timestamp,
      timestamp,
    );
    const row = this.row(identity.tenantId, jobId);
    if (!row) throw new Error("Capability-mode job was not persisted.");
    if (
      row.request_digest !== digest
      || row.request_id !== identity.requestId
      || row.capability_mode !== envelope.capabilityMode
    ) {
      throw new Error("This parent goal already belongs to a different request or capability mode.");
    }
    return { job: receipt(row), created: inserted.changes === 1 };
  }

  get(tenantId: string, jobId: string): CapabilityModeJobReceipt | undefined {
    const row = this.row(tenantId, jobId);
    return row ? receipt(row) : undefined;
  }

  events(tenantId: string, jobId: string, afterSequence = 0): CapabilityModeJobEvent[] {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new Error("Event cursor must be non-negative.");
    if (!this.row(tenantId, jobId)) return [];
    return (this.database.prepare(`
      SELECT sequence, job_id, tenant_id, capability_mode, event_type, status, attempts, occurred_at
      FROM capability_mode_job_events
      WHERE tenant_id = ? AND job_id = ? AND sequence > ?
      ORDER BY sequence ASC
    `).all(tenantId, jobId, afterSequence) as unknown as Array<{
      sequence: number;
      job_id: string;
      tenant_id: string;
      capability_mode: CapabilityMode;
      event_type: CapabilityModeJobEvent["type"];
      status: CapabilityModeJobStatus;
      attempts: number;
      occurred_at: string;
    }>).map((event) => ({
      sequence: event.sequence,
      jobId: event.job_id,
      tenantId: event.tenant_id,
      capabilityMode: event.capability_mode,
      type: event.event_type,
      status: event.status,
      attempts: event.attempts,
      occurredAt: event.occurred_at,
    }));
  }

  claim(tenantId: string, jobId: string): { job: CapabilityModeJobReceipt; envelope: CapabilityModeEnvelope } | undefined {
    const updated = this.database.prepare(`
      UPDATE capability_mode_jobs
      SET status = 'running', attempts = attempts + 1, error_text = NULL, updated_at = ?
      WHERE tenant_id = ? AND job_id = ? AND status = 'queued'
    `).run(nowIso(), tenantId, jobId);
    if (updated.changes !== 1) return undefined;
    const row = this.row(tenantId, jobId)!;
    return {
      job: receipt(row),
      envelope: capabilityModeEnvelopeSchema.parse(JSON.parse(row.envelope_json)),
    };
  }

  complete(tenantId: string, jobId: string, rawResult: CapabilityModeResult): CapabilityModeJobReceipt {
    const result = capabilityModeResultSchema.parse(rawResult);
    const row = this.row(tenantId, jobId);
    if (!row || row.status !== "running") throw new Error("Running capability-mode job was not found.");
    if (row.capability_mode !== result.capabilityMode) throw new Error("Capability-mode result does not match its durable job.");
    const updated = this.database.prepare(`
      UPDATE capability_mode_jobs
      SET status = ?, result_json = ?, error_text = NULL, updated_at = ?
      WHERE tenant_id = ? AND job_id = ? AND status = 'running'
    `).run(result.status, JSON.stringify(result), nowIso(), tenantId, jobId);
    if (updated.changes !== 1) throw new Error("Running capability-mode job could not be completed.");
    return receipt(this.row(tenantId, jobId)!);
  }

  markUnknown(tenantId: string, jobId: string, error: unknown): CapabilityModeJobReceipt {
    const message = redactText(error instanceof Error ? error.message : String(error)).slice(0, 1_000);
    const updated = this.database.prepare(`
      UPDATE capability_mode_jobs
      SET status = 'unknown', error_text = ?, updated_at = ?
      WHERE tenant_id = ? AND job_id = ? AND status = 'running'
    `).run(message, nowIso(), tenantId, jobId);
    if (updated.changes !== 1) throw new Error("Capability-mode job could not be marked unknown.");
    return receipt(this.row(tenantId, jobId)!);
  }

  recoverInterrupted(maxAttempts: number): CapabilityModeJobReceipt[] {
    this.database.prepare(`
      UPDATE capability_mode_jobs
      SET status = CASE WHEN attempts < ? THEN 'queued' ELSE 'unknown' END,
          error_text = CASE WHEN attempts < ? THEN NULL ELSE 'Recovery attempt ceiling reached.' END,
          updated_at = ?
      WHERE status = 'running'
    `).run(maxAttempts, maxAttempts, nowIso());
    return (this.database.prepare(
      "SELECT * FROM capability_mode_jobs WHERE status = 'queued' ORDER BY created_at ASC",
    ).all() as unknown as CapabilityModeJobRow[]).map(receipt);
  }

  health(): { status: "ready" | "degraded"; error?: string } {
    const row = this.database.prepare("PRAGMA quick_check").get() as unknown as Record<string, unknown>;
    const value = Object.values(row)[0];
    return value === "ok"
      ? { status: "ready" }
      : { status: "degraded", error: `Capability-mode job database check failed: ${String(value)}` };
  }

  close(): void {
    this.database.close();
  }

  private row(tenantId: string, jobId: string): CapabilityModeJobRow | undefined {
    return this.database.prepare(
      "SELECT * FROM capability_mode_jobs WHERE tenant_id = ? AND job_id = ?",
    ).get(tenantId, jobId) as unknown as CapabilityModeJobRow | undefined;
  }
}

export class CapabilityModeJobService {
  private tail: Promise<void> = Promise.resolve();
  private readonly scheduled = new Set<string>();
  private workerError: string | undefined;

  constructor(
    private readonly store: CapabilityModeJobStore,
    private readonly router: CapabilityModeRouter,
    private readonly maxAttempts = 2,
  ) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
      throw new Error("Capability-mode recovery allows between one and three attempts.");
    }
  }

  descriptors(): CapabilityModeDescriptor[] {
    return this.router.descriptors();
  }

  submit(envelope: unknown): { job: CapabilityModeJobReceipt; created: boolean } {
    const saved = this.store.create(envelope);
    if (saved.job.status === "queued") this.schedule(saved.job.tenantId, saved.job.jobId);
    return saved;
  }

  get(tenantId: string, jobId: string): CapabilityModeJobReceipt | undefined {
    return this.store.get(tenantId, jobId);
  }

  events(tenantId: string, jobId: string, afterSequence = 0): CapabilityModeJobEvent[] {
    return this.store.events(tenantId, jobId, afterSequence);
  }

  recover(): CapabilityModeJobReceipt[] {
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
        const claimed = this.store.claim(tenantId, jobId);
        if (!claimed) return;
        try {
          this.store.complete(tenantId, jobId, await this.router.execute(claimed.envelope));
          this.workerError = undefined;
        } catch (error) {
          this.store.markUnknown(tenantId, jobId, error);
          this.workerError = redactText(error instanceof Error ? error.message : String(error)).slice(0, 1_000);
        }
      })
      .finally(() => this.scheduled.delete(key));
  }
}
