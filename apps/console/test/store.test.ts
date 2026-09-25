import { describe, expect, it } from "vitest";
import { makeConsoleEvent } from "../shared/contracts.js";
import { ConsoleEventStore } from "../server/store.js";
import { projectRuns } from "../server/projections.js";

function event(tenantId: string, eventId: string) { return makeConsoleEvent({ eventId, tenantId, runId: "run-a", requestId: "request-a", type: "goal.received", occurredAt: "2026-07-27T00:00:00.000Z", payload: { source: "embedded-sdk", goal: "Approved safe goal summary" }, sensitivity: { classification: "tenant-confidential", source: "product-core", sanitized: true } }); }

describe("append-only console event store", () => {
  it("inserts idempotently and keeps tenant reads separate", () => {
    const store = new ConsoleEventStore(); const id = "26338122-5f8e-46e7-85f8-f75930262ea1";
    expect(store.append(event("tenant-a", id)).inserted).toBe(true); expect(store.append(event("tenant-a", id)).inserted).toBe(false); expect(store.append(event("tenant-b", id)).inserted).toBe(true);
    expect(store.list("tenant-a")).toHaveLength(1); expect(store.list("tenant-b")).toHaveLength(1); expect(store.listRun("tenant-b", "run-a")[0]!.event.tenantId).toBe("tenant-b"); store.close();
  });
  it("does not project a forged completion without outcome and resumption evidence", () => {
    const goal = event("tenant-a", "26338122-5f8e-46e7-85f8-f75930262ea2");
    const forged = makeConsoleEvent({ ...goal, eventId: "26338122-5f8e-46e7-85f8-f75930262ea3", type: "run.completed", occurredAt: "2026-07-27T00:00:01.000Z", payload: { outcome: "completed" } });
    expect(projectRuns([goal, forged])[0]!.status).toBe("running");
  });
});
