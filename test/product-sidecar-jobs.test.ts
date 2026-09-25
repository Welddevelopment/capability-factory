import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BROAD_GOAL_REQUEST_SCHEMA_VERSION,
  type BroadGoalRequest,
  type BroadGoalRunResult,
} from "../src/product/broad-goal-sdk.js";
import { CapabilityFactorySidecarClient } from "../src/product/client.js";
import { createCapabilitySidecar } from "../src/product/sidecar.js";
import { SidecarGoalJobService, SidecarGoalJobStore } from "../src/product/sidecar-jobs.js";

const TOKEN = "durable-sidecar-test-token";

function request(id: string): BroadGoalRequest {
  return {
    schemaVersion: BROAD_GOAL_REQUEST_SCHEMA_VERSION,
    tenantId: "tenant-a",
    parentGoalId: `parent-${id}`,
    requestId: `request-${id}`,
    scopeKey: "trusted-test-scope",
    ordinaryGoal: "Complete the bounded fictional goal.",
    visibility: "summary",
  };
}

function completed(input: BroadGoalRequest): BroadGoalRunResult {
  const timestamp = new Date().toISOString();
  return {
    status: "completed",
    tenantId: input.tenantId,
    parentGoalId: input.parentGoalId,
    requestId: input.requestId,
    planning: {
      source: "newly-validated",
      attempts: 1,
      validationReceiptId: `validation-${input.requestId}`,
      planDigest: "a".repeat(64),
      workItems: 1,
    },
    state: {
      schemaVersion: "1.0",
      tenantId: input.tenantId,
      parentGoalId: input.parentGoalId,
      requestId: input.requestId,
      planDigest: "a".repeat(64),
      version: 1,
      lifecycle: "completed",
      items: {},
      aggregate: {
        verifierVersion: "test-aggregate-v1",
        receiptId: `aggregate-${input.requestId}`,
        result: "complete",
        passed: true,
        requiredItems: 0,
        completedItems: 0,
        blockedItems: 0,
        failedItems: 0,
        unknownItems: 0,
        incorrectSideEffects: 0,
        stateDigest: "b".repeat(64),
        checks: [{ id: "test", passed: true, detail: "Test result completed." }],
        verifiedAt: timestamp,
      },
      resume: { completed: true, summary: "Parent resumed." },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

describe("durable sidecar broad-goal jobs", () => {
  it("checks durable database integrity and refuses a corrupted database at startup", () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-sidecar-corrupt-"));
    const databasePath = join(directory, "jobs.sqlite");
    try {
      const healthy = new SidecarGoalJobStore(databasePath);
      expect(healthy.health()).toEqual({ status: "ready" });
      healthy.close();
      writeFileSync(databasePath, "not-a-sqlite-database", { mode: 0o600 });
      expect(() => new SidecarGoalJobStore(databasePath)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns a job immediately, completes it in the background, and deduplicates submission", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-sidecar-job-"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const service = new SidecarGoalJobService(
      new SidecarGoalJobStore(join(directory, "jobs.sqlite")),
      {
        completeGoal: async (input) => {
          calls += 1;
          await gate;
          return completed(input);
        },
      },
    );
    try {
      const input = request("background");
      const submitted = service.submit(input);
      expect(submitted.created).toBe(true);
      expect(["queued", "running"]).toContain(service.get(input.tenantId, submitted.job.jobId)?.status);
      release();
      await service.idle();
      expect(service.get(input.tenantId, submitted.job.jobId)).toMatchObject({
        status: "completed",
        attempts: 1,
        result: { status: "completed" },
      });
      expect(service.events(input.tenantId, submitted.job.jobId).map((event) => event.type)).toEqual([
        "job.queued",
        "job.started",
        "job.completed",
      ]);
      const duplicate = service.submit(input);
      expect(duplicate.created).toBe(false);
      expect(duplicate.job.jobId).toBe(submitted.job.jobId);
      await service.idle();
      expect(calls).toBe(1);
      expect(() => service.submit({ ...input, requestId: "different-request", ordinaryGoal: "Different goal." })).toThrow(/different request/);
    } finally {
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers a job that was running when the old sidecar stopped", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-sidecar-recover-"));
    const databasePath = join(directory, "jobs.sqlite");
    const input = request("recover");
    const oldStore = new SidecarGoalJobStore(databasePath);
    const created = oldStore.create(input).job;
    expect(oldStore.claim(input.tenantId, created.jobId)?.job).toMatchObject({ status: "running", attempts: 1 });
    oldStore.close();

    const service = new SidecarGoalJobService(
      new SidecarGoalJobStore(databasePath),
      { completeGoal: async (received) => completed(received) },
    );
    try {
      expect(service.recover()).toHaveLength(1);
      await service.idle();
      expect(service.get(input.tenantId, created.jobId)).toMatchObject({
        status: "completed",
        attempts: 2,
      });
      expect(service.events(input.tenantId, created.jobId).map((event) => event.type)).toEqual([
        "job.queued",
        "job.started",
        "job.recovered",
        "job.started",
        "job.completed",
      ]);
    } finally {
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("marks an execution error unknown, redacts it, and allows one controlled retry", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-sidecar-retry-"));
    let fail = true;
    const service = new SidecarGoalJobService(
      new SidecarGoalJobStore(join(directory, "jobs.sqlite")),
      {
        completeGoal: async (input) => {
          if (fail) {
            fail = false;
            throw new Error("Lost response with Bearer private-pilot-token");
          }
          return completed(input);
        },
      },
      { maxAttempts: 2 },
    );
    try {
      const input = request("retry");
      const submitted = service.submit(input).job;
      await service.idle();
      const unknown = service.get(input.tenantId, submitted.jobId)!;
      expect(unknown).toMatchObject({ status: "unknown", attempts: 1 });
      expect(JSON.stringify(unknown)).not.toContain("private-pilot-token");
      expect(service.retry(input.tenantId, submitted.jobId)).toMatchObject({ status: "queued", attempts: 1 });
      await service.idle();
      expect(service.get(input.tenantId, submitted.jobId)).toMatchObject({ status: "completed", attempts: 2 });
      expect(service.events(input.tenantId, submitted.jobId).map((event) => event.type)).toEqual([
        "job.queued",
        "job.started",
        "job.unknown",
        "job.retry-queued",
        "job.started",
        "job.completed",
      ]);
      expect(() => service.retry(input.tenantId, submitted.jobId)).toThrow(/Only an interrupted job/);
    } finally {
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("stops automatic restart recovery after the configured attempt limit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-sidecar-limit-"));
    const databasePath = join(directory, "jobs.sqlite");
    const input = request("limit");
    const oldStore = new SidecarGoalJobStore(databasePath);
    const created = oldStore.create(input).job;
    oldStore.claim(input.tenantId, created.jobId);
    oldStore.close();
    const service = new SidecarGoalJobService(
      new SidecarGoalJobStore(databasePath),
      { completeGoal: async (received) => completed(received) },
      { maxAttempts: 1 },
    );
    try {
      expect(service.recover()).toHaveLength(0);
      expect(service.get(input.tenantId, created.jobId)).toMatchObject({ status: "unknown", attempts: 1 });
      expect(() => service.retry(input.tenantId, created.jobId)).toThrow(/retry limit/);
    } finally {
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("supports authenticated submit, status, wait, and readiness through the thin client", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-sidecar-http-job-"));
    const service = new SidecarGoalJobService(
      new SidecarGoalJobStore(join(directory, "jobs.sqlite")),
      { completeGoal: async (input) => completed(input) },
    );
    const app = createCapabilitySidecar(undefined, { resolve: () => undefined }, {
      accessToken: TOKEN,
      goalJobs: service,
    });
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      expect((await fetch(new URL("/health", baseUrl))).status).toBe(200);
      expect(await (await fetch(new URL("/ready", baseUrl))).json()).toEqual({ status: "ready" });
      const client = new CapabilityFactorySidecarClient({ baseUrl, accessToken: TOKEN });
      const input = request("http");
      const started = await client.startGoal(input);
      const finished = await client.waitForGoalJob(input.tenantId, started.jobId, {
        timeoutMs: 2_000,
        pollIntervalMs: 10,
      });
      expect(finished).toMatchObject({ status: "completed", attempts: 1, result: { status: "completed" } });
      const events = await client.getGoalJobEvents(input.tenantId, started.jobId);
      expect(events.map((event) => event.type)).toEqual(["job.queued", "job.started", "job.completed"]);
      expect(await client.getGoalJobEvents(input.tenantId, started.jobId, events[1]!.sequence)).toHaveLength(1);
      await expect(client.getGoalJob("tenant-b", started.jobId)).rejects.toThrow(/HTTP 404/);
      await expect(new CapabilityFactorySidecarClient({
        baseUrl,
        accessToken: "wrong-durable-job-token",
      }).getGoalJob(input.tenantId, started.jobId)).rejects.toThrow(/HTTP 401/);
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
