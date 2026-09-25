import type { CapabilityRequest, GoalRunResult } from "./contracts.js";
import {
  blockedContextValidationReceiptSchema,
  type BlockedContextContract,
  type BlockedContextValidationReceipt,
} from "./blocked-context-contract.js";
import {
  isBroadGoalRunResult,
  type BroadGoalRequest,
  type BroadGoalRunResult,
} from "./broad-goal-sdk.js";
import type { GoalContinuationGrant } from "./continuation.js";
import {
  isSidecarGoalJobEvent,
  isSidecarGoalJobReceipt,
  type SidecarGoalJobEvent,
  type SidecarGoalJobReceipt,
} from "./sidecar-jobs.js";
import {
  capabilityModeDescriptorSchema,
  capabilityModeEnvelopeSchema,
  type CapabilityModeDescriptor,
  type CapabilityModeEnvelope,
} from "./capability-mode-contract.js";
import {
  isCapabilityModeJobEvent,
  isCapabilityModeJobReceipt,
  type CapabilityModeJobEvent,
  type CapabilityModeJobReceipt,
} from "./capability-mode-jobs.js";
import {
  runtimeFamilyDescriptorSchema,
  universalGoalSubmissionSchema,
  type RuntimeFamilyDescriptor,
  type UniversalGoalSubmission,
} from "./universal-capability-contract.js";
import {
  isUniversalResolutionReceipt,
  type UniversalResolutionReceipt,
} from "./universal-capability-coordinator.js";
import {
  isUniversalCompositionReceipt,
  type UniversalCompositionReceipt,
} from "./universal-composition.js";
import {
  isUniversalCompositionJobEvent,
  isUniversalCompositionJobReceipt,
  type UniversalCompositionJobEvent,
  type UniversalCompositionJobReceipt,
} from "./universal-composition-jobs.js";

export interface SidecarClientOptions {
  baseUrl: string;
  accessToken: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface WaitForGoalJobOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ObserveGoalJobOptions extends WaitForGoalJobOptions {
  afterSequence?: number;
  signal?: AbortSignal;
  onStatus?(receipt: SidecarGoalJobReceipt): void | Promise<void>;
  onEvent?(event: SidecarGoalJobEvent): void | Promise<void>;
}

function validateLocalBaseUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("The reference sidecar client accepts localhost HTTP endpoints only");
  }
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("The sidecar base URL must be an origin without credentials or a path");
  }
  return url;
}

function isGoalRunResult(value: unknown): value is GoalRunResult {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.status === "completed") {
    return (
      typeof record.requestId === "string" &&
      typeof record.capabilityId === "string" &&
      Array.isArray(record.actions) &&
      Boolean(record.outcome) &&
      Boolean(record.resume)
    );
  }
  return record.status === "handoff" && Boolean(record.handoff);
}

/** Thin developer-facing client for a customer-hosted localhost sidecar. */
export class CapabilityFactorySidecarClient {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: SidecarClientOptions) {
    if (options.accessToken.length < 16) throw new Error("Sidecar access token must contain at least 16 characters");
    this.baseUrl = validateLocalBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_000_000;
  }

  async completeBlockedGoal(request: CapabilityRequest): Promise<GoalRunResult> {
    const value = await this.post("/v1/blocked-goals", request);
    if (!isGoalRunResult(value)) throw new Error("Sidecar returned an invalid result envelope");
    return value;
  }

  /** Validate a standard non-authorizing blocked-context envelope through the authenticated customer-local sidecar. */
  async validateBlockedContext(contract: BlockedContextContract): Promise<BlockedContextValidationReceipt> {
    const value = await this.post("/v1/onboarding/blocked-context/validate", contract);
    return blockedContextValidationReceiptSchema.parse(value);
  }

  async completeGoal(request: BroadGoalRequest): Promise<BroadGoalRunResult> {
    const value = await this.post("/v1/goals", request);
    if (!isBroadGoalRunResult(value)) throw new Error("Sidecar returned an invalid broad-goal result envelope");
    return value;
  }

  async continueGoal(request: BroadGoalRequest, grant: GoalContinuationGrant): Promise<BroadGoalRunResult> {
    const value = await this.post("/v1/goals/continue", { request, grant });
    if (!isBroadGoalRunResult(value)) throw new Error("Sidecar returned an invalid broad-goal continuation result");
    return value;
  }

  async startGoal(request: BroadGoalRequest): Promise<SidecarGoalJobReceipt> {
    const value = await this.post("/v1/goal-jobs", request);
    if (!isSidecarGoalJobReceipt(value)) throw new Error("Sidecar returned an invalid goal-job receipt");
    return value;
  }

  async getGoalJob(tenantId: string, jobId: string): Promise<SidecarGoalJobReceipt> {
    const query = new URLSearchParams({ tenantId });
    const value = await this.request("GET", `/v1/goal-jobs/${encodeURIComponent(jobId)}?${query}`);
    if (!isSidecarGoalJobReceipt(value)) throw new Error("Sidecar returned an invalid goal-job receipt");
    return value;
  }

  async retryGoalJob(tenantId: string, jobId: string): Promise<SidecarGoalJobReceipt> {
    const value = await this.post(`/v1/goal-jobs/${encodeURIComponent(jobId)}/retry`, { tenantId });
    if (!isSidecarGoalJobReceipt(value)) throw new Error("Sidecar returned an invalid goal-job receipt");
    return value;
  }

  async continueGoalJob(
    tenantId: string,
    jobId: string,
    grant: GoalContinuationGrant,
  ): Promise<SidecarGoalJobReceipt> {
    const value = await this.post(`/v1/goal-jobs/${encodeURIComponent(jobId)}/continue`, { tenantId, grant });
    if (!isSidecarGoalJobReceipt(value)) throw new Error("Sidecar returned an invalid continued goal-job receipt");
    return value;
  }

  async getGoalJobEvents(tenantId: string, jobId: string, afterSequence = 0): Promise<SidecarGoalJobEvent[]> {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new Error("Event cursor must be a non-negative integer.");
    const query = new URLSearchParams({ tenantId, after: String(afterSequence) });
    const value = await this.request("GET", `/v1/goal-jobs/${encodeURIComponent(jobId)}/events?${query}`);
    if (!value || typeof value !== "object" || !Array.isArray((value as { events?: unknown }).events)) {
      throw new Error("Sidecar returned an invalid goal-job event page");
    }
    const events = (value as { events: unknown[] }).events;
    if (!events.every(isSidecarGoalJobEvent)) throw new Error("Sidecar returned an invalid goal-job event");
    return events;
  }

  async listCapabilityModes(): Promise<{
    schemaVersion: "1.0";
    selection: "trusted-explicit";
    inference: false;
    modes: CapabilityModeDescriptor[];
  }> {
    const value = await this.request("GET", "/v1/capability-modes");
    if (!value || typeof value !== "object") throw new Error("Sidecar returned an invalid capability-mode registry.");
    const record = value as Record<string, unknown>;
    if (
      record.schemaVersion !== "1.0"
      || record.selection !== "trusted-explicit"
      || record.inference !== false
      || !Array.isArray(record.modes)
    ) {
      throw new Error("Sidecar returned an invalid capability-mode registry.");
    }
    return {
      schemaVersion: "1.0",
      selection: "trusted-explicit",
      inference: false,
      modes: record.modes.map((mode) => capabilityModeDescriptorSchema.parse(mode)),
    };
  }

  async listRuntimeFamilies(): Promise<{
    schemaVersion: "1.0";
    selection: "trusted-automatic";
    callerSelectsMode: false;
    evidenceWarning: string;
    families: RuntimeFamilyDescriptor[];
  }> {
    const value = await this.request("GET", "/v1/runtime-families");
    if (!value || typeof value !== "object") throw new Error("Sidecar returned an invalid runtime-family registry.");
    const record = value as Record<string, unknown>;
    if (
      record.schemaVersion !== "1.0"
      || record.selection !== "trusted-automatic"
      || record.callerSelectsMode !== false
      || typeof record.evidenceWarning !== "string"
      || !Array.isArray(record.families)
    ) {
      throw new Error("Sidecar returned an invalid runtime-family registry.");
    }
    return {
      schemaVersion: "1.0",
      selection: "trusted-automatic",
      callerSelectsMode: false,
      evidenceWarning: record.evidenceWarning,
      families: record.families.map((family) => runtimeFamilyDescriptorSchema.parse(family)),
    };
  }

  async completeUniversalGoal(rawSubmission: UniversalGoalSubmission): Promise<UniversalResolutionReceipt> {
    const submission = universalGoalSubmissionSchema.parse(rawSubmission);
    const value = await this.post("/v1/universal-goals", submission);
    if (!isUniversalResolutionReceipt(value)) throw new Error("Sidecar returned an invalid universal-resolution receipt.");
    return value;
  }

  async completeUniversalComposition(rawSubmission: UniversalGoalSubmission): Promise<UniversalCompositionReceipt> {
    const submission = universalGoalSubmissionSchema.parse(rawSubmission);
    const value = await this.post("/v1/universal-compositions", submission);
    if (!isUniversalCompositionReceipt(value)) throw new Error("Sidecar returned an invalid universal-composition receipt.");
    return value;
  }

  async startUniversalComposition(rawSubmission: UniversalGoalSubmission): Promise<UniversalCompositionJobReceipt> {
    const submission = universalGoalSubmissionSchema.parse(rawSubmission);
    const value = await this.post("/v1/universal-composition-jobs", submission);
    if (!isUniversalCompositionJobReceipt(value)) throw new Error("Sidecar returned an invalid universal-composition job receipt.");
    return value;
  }

  async getUniversalCompositionJob(tenantId: string, jobId: string): Promise<UniversalCompositionJobReceipt> {
    const query = new URLSearchParams({ tenantId });
    const value = await this.request("GET", `/v1/universal-composition-jobs/${encodeURIComponent(jobId)}?${query}`);
    if (!isUniversalCompositionJobReceipt(value)) throw new Error("Sidecar returned an invalid universal-composition job receipt.");
    return value;
  }

  async getUniversalCompositionJobEvents(
    tenantId: string,
    jobId: string,
    afterSequence = 0,
  ): Promise<UniversalCompositionJobEvent[]> {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new Error("Event cursor must be a non-negative integer.");
    const query = new URLSearchParams({ tenantId, after: String(afterSequence) });
    const value = await this.request("GET", `/v1/universal-composition-jobs/${encodeURIComponent(jobId)}/events?${query}`);
    if (!value || typeof value !== "object" || !Array.isArray((value as { events?: unknown }).events)) {
      throw new Error("Sidecar returned an invalid universal-composition event page.");
    }
    const events = (value as { events: unknown[] }).events;
    if (!events.every(isUniversalCompositionJobEvent)) throw new Error("Sidecar returned an invalid universal-composition event.");
    return events;
  }

  async waitForUniversalCompositionJob(
    tenantId: string,
    jobId: string,
    options: WaitForGoalJobOptions = {},
  ): Promise<UniversalCompositionJobReceipt> {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const pollIntervalMs = options.pollIntervalMs ?? 250;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("Universal-composition job wait timeout must be positive.");
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 10_000) {
      throw new Error("Universal-composition polling interval must be between 10ms and 10s.");
    }
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const job = await this.getUniversalCompositionJob(tenantId, jobId);
      if (job.status !== "queued" && job.status !== "running") return job;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the universal-composition job.");
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))));
    }
  }

  async startCapabilityModeJob(rawEnvelope: CapabilityModeEnvelope): Promise<CapabilityModeJobReceipt> {
    const envelope = capabilityModeEnvelopeSchema.parse(rawEnvelope);
    const value = await this.post("/v1/capability-mode-jobs", envelope);
    if (!isCapabilityModeJobReceipt(value)) throw new Error("Sidecar returned an invalid capability-mode job receipt.");
    return value;
  }

  async getCapabilityModeJob(tenantId: string, jobId: string): Promise<CapabilityModeJobReceipt> {
    const query = new URLSearchParams({ tenantId });
    const value = await this.request("GET", `/v1/capability-mode-jobs/${encodeURIComponent(jobId)}?${query}`);
    if (!isCapabilityModeJobReceipt(value)) throw new Error("Sidecar returned an invalid capability-mode job receipt.");
    return value;
  }

  async getCapabilityModeJobEvents(
    tenantId: string,
    jobId: string,
    afterSequence = 0,
  ): Promise<CapabilityModeJobEvent[]> {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new Error("Event cursor must be a non-negative integer.");
    const query = new URLSearchParams({ tenantId, after: String(afterSequence) });
    const value = await this.request("GET", `/v1/capability-mode-jobs/${encodeURIComponent(jobId)}/events?${query}`);
    if (!value || typeof value !== "object" || !Array.isArray((value as { events?: unknown }).events)) {
      throw new Error("Sidecar returned an invalid capability-mode event page.");
    }
    const events = (value as { events: unknown[] }).events;
    if (!events.every(isCapabilityModeJobEvent)) throw new Error("Sidecar returned an invalid capability-mode event.");
    return events;
  }

  async waitForCapabilityModeJob(
    tenantId: string,
    jobId: string,
    options: WaitForGoalJobOptions = {},
  ): Promise<CapabilityModeJobReceipt> {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const pollIntervalMs = options.pollIntervalMs ?? 250;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("Capability-mode job wait timeout must be positive.");
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 10_000) {
      throw new Error("Capability-mode polling interval must be between 10ms and 10s.");
    }
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const job = await this.getCapabilityModeJob(tenantId, jobId);
      if (job.status !== "queued" && job.status !== "running") return job;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the capability-mode job.");
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))));
    }
  }

  async waitForGoalJob(
    tenantId: string,
    jobId: string,
    options: WaitForGoalJobOptions = {},
  ): Promise<SidecarGoalJobReceipt> {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const pollIntervalMs = options.pollIntervalMs ?? 250;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("Goal-job wait timeout must be positive.");
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 10_000) {
      throw new Error("Goal-job polling interval must be between 10ms and 10s.");
    }
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const job = await this.getGoalJob(tenantId, jobId);
      if (job.status !== "queued" && job.status !== "running") return job;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the sidecar goal job.");
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))));
    }
  }

  /** Polls the durable job and its append-only event cursor for framework-neutral callbacks. */
  async observeGoalJob(
    tenantId: string,
    jobId: string,
    options: ObserveGoalJobOptions = {},
  ): Promise<SidecarGoalJobReceipt> {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const pollIntervalMs = options.pollIntervalMs ?? 250;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("Goal-job observation timeout must be positive.");
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 10_000) {
      throw new Error("Goal-job polling interval must be between 10ms and 10s.");
    }
    let cursor = options.afterSequence ?? 0;
    if (!Number.isInteger(cursor) || cursor < 0) throw new Error("Event cursor must be a non-negative integer.");
    const deadline = Date.now() + timeoutMs;
    let lastStatus: SidecarGoalJobReceipt["status"] | undefined;
    while (true) {
      if (options.signal?.aborted) throw new Error("Goal-job observation was aborted.");
      const events = await this.getGoalJobEvents(tenantId, jobId, cursor);
      for (const event of events) {
        if (event.sequence <= cursor) throw new Error("Sidecar event sequence did not advance monotonically.");
        cursor = event.sequence;
        await options.onEvent?.(event);
      }
      const job = await this.getGoalJob(tenantId, jobId);
      if (job.status !== lastStatus) {
        lastStatus = job.status;
        await options.onStatus?.(job);
      }
      if (job.status !== "queued" && job.status !== "running") return job;
      if (Date.now() >= deadline) throw new Error("Timed out observing the sidecar goal job.");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
        options.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Goal-job observation was aborted.")); }, { once: true });
      });
    }
  }

  private async post(route: string, body: unknown): Promise<unknown> {
    return this.request("POST", route, body);
  }

  private async request(method: "GET" | "POST", route: string, body?: unknown): Promise<unknown> {
    const response = await fetch(new URL(route, this.baseUrl), {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "x-capability-sidecar-token": this.options.accessToken,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.maxResponseBytes) throw new Error("Sidecar response exceeded the configured size limit");
    const text = new TextDecoder().decode(bytes);
    if (!response.ok) throw new Error(`Sidecar request failed with HTTP ${response.status}`);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("Sidecar returned invalid JSON");
    }
    return value;
  }
}
