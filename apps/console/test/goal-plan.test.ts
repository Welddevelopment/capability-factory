import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOrderOperationsGoalPlan, ORDER_OPERATIONS_FIXTURE } from "../server/goal-plan-fixture.js";
import { projectGoalPlan, projectRuns } from "../server/projections.js";
import { ConsoleEventStore } from "../server/store.js";
import { makeConsoleEvent, stableConsoleId } from "../shared/contracts.js";

const goal = "Complete every fictional order due before 9pm and restock every item without sufficient stock.";

describe("bounded reference goal coordinator", () => {
  it("creates one validated deterministic plan with stable ordering and grouping", () => {
    const first = createOrderOperationsGoalPlan("parent-run", "request-1", goal, "partial-authority");
    const second = createOrderOperationsGoalPlan("parent-run", "request-1", goal, "partial-authority");
    expect(second.events.map((event) => event.eventId)).toEqual(first.events.map((event) => event.eventId));
    const plan = projectGoalPlan(first.events, "parent-run")!;
    expect(plan.validation.passed).toBe(true); expect(plan.groups.map((group) => group.groupId)).toEqual(["orders-ready", "order-details", "supplier-north", "supplier-east", "supplier-regulated", "order-finalization"]);
    expect(plan.groups.flatMap((group) => group.items).map((item) => item.executionOrder)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(plan.groups.find((group) => group.groupId === "supplier-north")!.items).toHaveLength(2);
  });
  it("preserves partial success and zero-write approval handoff while independent work completes", () => {
    const fixture = createOrderOperationsGoalPlan("partial-run", "request-2", goal, "partial-authority");
    const plan = projectGoalPlan(fixture.events, "partial-run")!;
    expect(plan.rollup).toMatchObject({ result: "partially-complete", passed: false, completedItems: 6, blockedItems: 1, incorrectSideEffects: 0 });
    const blocked = plan.groups.flatMap((group) => group.items).find((item) => item.status === "blocked")!;
    expect(blocked.missing).toContain("approval");
    const blockedEvent = fixture.events.find((event) => event.type === "work-item.blocked")!;
    expect(blockedEvent.payload.writesAttempted).toBe(0);
    expect(fixture.events.filter((event) => event.runId === blocked.childRunId).map((event) => event.type)).not.toContain("execution.completed");
    expect(projectRuns(fixture.events.filter((event) => event.runId === "partial-run"))[0]!.status).toBe("handoff");
  });
  it("requires a separate passing aggregate receipt before parent completion", () => {
    const fixture = createOrderOperationsGoalPlan("complete-run", "request-3", goal, "complete-authority");
    const plan = projectGoalPlan(fixture.events, "complete-run")!;
    expect(plan.rollup).toMatchObject({ result: "complete", passed: true, requiredItems: 7, blockedItems: 0, unknownItems: 0 });
    expect(fixture.events.map((event) => event.type)).toContain("goal.outcome.verified");
    expect(projectRuns(fixture.events.filter((event) => event.runId === "complete-run"))[0]!.status).toBe("completed");
  });
  it("replays after restart without duplicate work items or events", () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-console-plan-")); const path = join(directory, "events.sqlite");
    const fixture = createOrderOperationsGoalPlan("restart-run", "request-4", goal, "partial-authority");
    const first = new ConsoleEventStore(path); fixture.events.forEach((event) => first.append(event)); const count = first.list("local-alpha").length; first.close();
    const restarted = new ConsoleEventStore(path); fixture.events.forEach((event) => expect(restarted.append(event).inserted).toBe(false));
    const events = restarted.list("local-alpha").map((row) => row.event); expect(events).toHaveLength(count); expect(projectGoalPlan(events, "restart-run")!.groups.flatMap((group) => group.items)).toHaveLength(7);
    restarted.close(); rmSync(directory, { recursive: true, force: true });
  });
  it("rejects unknown plan fields, excessive payload arrays, and secret-shaped values", () => {
    const base = { tenantId: "local-alpha", runId: "run", requestId: "request", occurredAt: "2026-07-27T00:00:00.000Z", sensitivity: { classification: "tenant-confidential" as const, source: "console-adapter" as const, sanitized: true as const } };
    expect(() => makeConsoleEvent({ ...base, type: "goal.plan.proposed", payload: { parentGoalId: "goal", planVersion: 1, fixture: ORDER_OPERATIONS_FIXTURE, itemCount: 1, summary: "safe", unknown: "not allowed" } })).toThrow();
    expect(() => makeConsoleEvent({ ...base, type: "goal.plan.validated", payload: { parentGoalId: "goal", planVersion: 1, passed: true, validationReceipt: "receipt", checks: Array.from({ length: 25 }, (_, index) => `check-${index}`), scope: "scope", deadline: "21:00", targetAliases: ["orders"], credentialAliases: ["orders_key"], authorityState: "read" } })).toThrow();
    expect(() => makeConsoleEvent({ ...base, type: "goal.plan.proposed", payload: { parentGoalId: "goal", planVersion: 1, fixture: ORDER_OPERATIONS_FIXTURE, itemCount: 1, summary: "Bearer unsafe.value" } })).toThrow(/secret/i);
    expect(stableConsoleId("work", "tenant", "entity")).toMatch(/^[a-f0-9-]{36}$/);
  });
});
