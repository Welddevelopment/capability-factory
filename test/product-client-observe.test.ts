import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilityFactorySidecarClient } from "../src/product/client.js";

afterEach(() => vi.unstubAllGlobals());

describe("existing-agent observation callbacks", () => {
  it("delivers append-only events once and status transitions only when they change", async () => {
    const now = new Date().toISOString(); let eventCalls = 0; let receiptCalls = 0;
    const queued = { schemaVersion: "1.0", jobId: "a".repeat(32), tenantId: "tenant", parentGoalId: "goal", requestId: "request", status: "queued", attempts: 0, createdAt: now, updatedAt: now };
    const completed = { ...queued, status: "completed", attempts: 1 };
    vi.stubGlobal("fetch", vi.fn(async (url: URL | string) => {
      const value = String(url);
      if (value.includes("/events")) {
        eventCalls += 1;
        return new Response(JSON.stringify({ events: eventCalls === 1 ? [{ sequence: 1, jobId: queued.jobId, tenantId: "tenant", type: "job.queued", status: "queued", attempts: 0, occurredAt: now }] : [{ sequence: 2, jobId: queued.jobId, tenantId: "tenant", type: "job.completed", status: "completed", attempts: 1, occurredAt: now }] }), { status: 200 });
      }
      receiptCalls += 1;
      return new Response(JSON.stringify(receiptCalls === 1 ? queued : completed), { status: 200 });
    }));
    const statuses: string[] = []; const sequences: number[] = [];
    const client = new CapabilityFactorySidecarClient({ baseUrl: "http://127.0.0.1:4317", accessToken: "t".repeat(32) });
    const result = await client.observeGoalJob("tenant", queued.jobId, { pollIntervalMs: 10, timeoutMs: 1_000,
      onStatus: (receipt) => { statuses.push(receipt.status); }, onEvent: (event) => { sequences.push(event.sequence); } });
    expect(result.status).toBe("completed"); expect(statuses).toEqual(["queued", "completed"]); expect(sequences).toEqual([1, 2]);
  });
});
