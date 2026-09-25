import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConsoleApp } from "../apps/console/server/app.js";
import { FileValidatedGoalPlanStore } from "../src/product/broad-goal-sdk.js";
import { CapabilityFactorySidecarClient } from "../src/product/client.js";
import { createControlledPilotSdk, preflightControlledPilotAdapter } from "../src/product/pilot-adapter.js";
import { createCapabilitySidecar } from "../src/product/sidecar.js";
import { SidecarGoalJobService, SidecarGoalJobStore } from "../src/product/sidecar-jobs.js";
import { FileTenantCapabilityStore } from "../src/product/store.js";
import { CustomerLocalOperationalControl } from "../src/product/operations.js";
import {
  REAL_ERPNEXT_PILOT_GOAL,
  REAL_ERPNEXT_PILOT_SCOPE_KEY,
  createRealErpNextBroadGoalPilotAdapter,
  realErpNextBroadGoalPlanner,
} from "../src/customer-world/real-erpnext-broad-goal-pilot-adapter.js";
import {
  REAL_ERPNEXT_BROAD_GOAL_REQUEST_IDS,
  startRealErpNextProcurementWorld,
  type RealErpNextProcurementWorld,
} from "../src/customer-world/real-erpnext-procurement-world.js";

const enabled = process.env.CF_REAL_ERPNEXT === "1";
const testIfEnabled = enabled ? it : it.skip;
const TOKEN = "real-erpnext-pilot-test-token";
const apps: Array<{ close(): Promise<void> }> = [];
let world: RealErpNextProcurementWorld | undefined;

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await world?.close();
  world = undefined;
});

describe("genuine ERPNext durable pilot route", () => {
  testIfEnabled("completes one broad goal through sidecar build, reuse, direct verification and resumption", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-real-erpnext-sidecar-"));
    world = await startRealErpNextProcurementWorld({ repositoryRoot: process.cwd() });
    const initial = world.resetBroadGoal();
    expect(initial).toMatch(/^[a-f0-9]{64}$/);
    const adapter = createRealErpNextBroadGoalPilotAdapter({ world, dataDirectory: root });
    const preflight = await preflightControlledPilotAdapter(adapter);
    expect(preflight.filter((check) => !check.passed)).toEqual([]);
    const coordinator = await createControlledPilotSdk(adapter, {
      planner: realErpNextBroadGoalPlanner,
      plans: new FileValidatedGoalPlanStore(path.join(root, "plans")),
      maxPlanningAttempts: 1,
    });
    const jobs = new SidecarGoalJobService(
      new SidecarGoalJobStore(path.join(root, "jobs.sqlite")),
      coordinator,
    );
    const app = createCapabilitySidecar(undefined, { resolve: () => undefined }, {
      accessToken: TOKEN,
      broadGoals: coordinator,
      goalJobs: jobs,
    });
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Test sidecar did not bind a local port.");
    const client = new CapabilityFactorySidecarClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      accessToken: TOKEN,
    });
    const request = {
      schemaVersion: "1.0" as const,
      tenantId: "local-erpnext-pilot",
      parentGoalId: "erpnext-batch-2100",
      requestId: "erpnext-batch-request-2100",
      scopeKey: REAL_ERPNEXT_PILOT_SCOPE_KEY,
      ordinaryGoal: REAL_ERPNEXT_PILOT_GOAL,
      visibility: "full" as const,
    };
    const started = await client.startGoal(request);
    expect(started.status).toMatch(/queued|running|completed/);
    const completed = await client.waitForGoalJob(request.tenantId, started.jobId, { timeoutMs: 120_000, pollIntervalMs: 50 });
    expect(completed.status).toBe("completed");
    expect(completed.result?.status).toBe("completed");
    if (!completed.result || !("state" in completed.result)) throw new Error("Completed job has no coordination state.");
    expect(completed.result.state.resume?.completed).toBe(true);
    expect(completed.result.state.aggregate).toMatchObject({ passed: true, incorrectSideEffects: 0, completedItems: 3 });
    expect(Object.values(completed.result.state.items).some((item) =>
      item.execution?.status === "executed" && item.execution.reconciliation !== undefined
    )).toBe(false);
    const paths = Object.values(completed.result.state.items).map((item) => item.execution && "path" in item.execution ? item.execution.path : "none");
    expect(paths).toEqual(["built-capability", "retained-capability", "retained-capability"]);
    const direct = world.verifyBroadGoal();
    expect(direct).toMatchObject({ passed: true, intendedWrites: 6, incorrectSideEffects: 0, completedRequests: 3, requiredRequests: 3 });
    const registry = new FileTenantCapabilityStore(path.join(root, "capability-registry")).list(request.tenantId);
    expect(registry).toHaveLength(1);
    expect(registry[0]).toMatchObject({ status: "active", origin: "built", reuseCount: 2 });
    const events = await client.getGoalJobEvents(request.tenantId, started.jobId);
    expect(events.some((event) => event.type === "job.completed")).toBe(true);
  }, 180_000);

  testIfEnabled("projects the genuine durable sidecar run into the real console", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-real-erpnext-console-"));
    world = await startRealErpNextProcurementWorld({ repositoryRoot: process.cwd() });
    world.resetBroadGoal();
    const adapter = createRealErpNextBroadGoalPilotAdapter({
      world,
      dataDirectory: root,
      faultInjection: {
        loseCreateResponseAfterCommitFor: REAL_ERPNEXT_BROAD_GOAL_REQUEST_IDS[0],
      },
    });
    const coordinator = await createControlledPilotSdk(adapter, {
      planner: realErpNextBroadGoalPlanner,
      plans: new FileValidatedGoalPlanStore(path.join(root, "plans")),
      maxPlanningAttempts: 1,
    });
    const jobs = new SidecarGoalJobService(
      new SidecarGoalJobStore(path.join(root, "jobs.sqlite")),
      coordinator,
    );
    const sidecarApp = createCapabilitySidecar(undefined, { resolve: () => undefined }, {
      accessToken: TOKEN,
      broadGoals: coordinator,
      goalJobs: jobs,
    });
    apps.push(sidecarApp);
    await sidecarApp.listen({ host: "127.0.0.1", port: 0 });
    const address = sidecarApp.server.address();
    if (!address || typeof address === "string") throw new Error("Test sidecar did not bind a local port.");
    const client = new CapabilityFactorySidecarClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      accessToken: TOKEN,
    });
    const { app: consoleApp } = createConsoleApp({
      databasePath: path.join(root, "console.sqlite"),
      goalDataDirectory: path.join(root, "console-goals"),
      sidecar: {
        client,
        tenantId: "local-erpnext-pilot",
        scopeKey: REAL_ERPNEXT_PILOT_SCOPE_KEY,
        fixtureLabel: "Genuine disposable local ERPNext · fictional procurement batch",
        workflowLabel: "Durable sidecar · approved ERPNext procurement",
        suggestedGoal: REAL_ERPNEXT_PILOT_GOAL,
        pollIntervalMs: 10,
      },
    });
    apps.push(consoleApp);
    const created = await consoleApp.inject({
      method: "POST",
      url: "/api/playground/runs",
      payload: { goal: REAL_ERPNEXT_PILOT_GOAL, mode: "sidecar-live" },
    });
    expect(created.statusCode).toBe(202);
    const { runId } = created.json<{ runId: string }>();
    const deadline = Date.now() + 120_000;
    let projected: ReturnType<typeof JSON.parse>;
    while (Date.now() < deadline) {
      const response = await consoleApp.inject({ method: "GET", url: `/api/runs/${runId}` });
      projected = response.json();
      if (projected.status !== "running") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    expect(projected).toMatchObject({
      source: "customer-sidecar",
      status: "completed",
      goalPlan: {
        lifecycle: "completed",
        rollup: { passed: true, completedItems: 3, incorrectSideEffects: 0 },
      },
    });
    expect(projected.goalPlan.groups.flatMap((group: { items: unknown[] }) => group.items)).toHaveLength(3);
    expect(projected.events.some((event: { type: string }) => event.type === "sidecar.job.status")).toBe(true);
    const items = projected.goalPlan.groups
      .flatMap((group: { items: Array<{ childRunId: string; executionOrder: number }> }) => group.items)
      .sort((left: { executionOrder: number }, right: { executionOrder: number }) => left.executionOrder - right.executionOrder);
    const childRuns = await Promise.all(items.map((item: { childRunId: string }) =>
      consoleApp.inject({ method: "GET", url: `/api/runs/${item.childRunId}` })
    ));
    const reconciled = childRuns.flatMap((response) =>
      (response.json() as { events: Array<{ type: string; payload: Record<string, unknown> }> }).events
    )
      .filter((event) => event.type === "execution.reconciled");
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.payload).toMatchObject({
      reason: "post-write-response-lost",
      action: "create_purchase_order",
      recoveryAction: "find_purchase_order",
      externalMatches: 1,
      responseReceived: false,
      writeRetried: false,
      duplicatePrevented: true,
    });
    expect(world.verifyBroadGoal()).toMatchObject({ passed: true, intendedWrites: 6, incorrectSideEffects: 0 });
  }, 180_000);

  testIfEnabled("joins the console kill switch to the genuine ERPNext capability runtime before any external action", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-real-erpnext-stop-control-"));
    world = await startRealErpNextProcurementWorld({ repositoryRoot: process.cwd() });
    const before = world.resetBroadGoal();
    const operations = new CustomerLocalOperationalControl(
      path.join(root, "operations.sqlite"),
      "local-erpnext-pilot",
      { maxWriteAttemptsPerRun: 20, maxWriteAttemptsPerHour: 200, maxModelSpendUsdPerDay: 5 },
    );
    try {
      operations.setMode("halted", "Genuine-system stop-control acceptance test.");
      const adapter = createRealErpNextBroadGoalPilotAdapter({
        world,
        dataDirectory: root,
        includeAcceptance: false,
        operationGuard: operations,
      });
      const coordinator = await createControlledPilotSdk(adapter, {
        planner: realErpNextBroadGoalPlanner,
        plans: new FileValidatedGoalPlanStore(path.join(root, "plans")),
        maxPlanningAttempts: 1,
      });
      const result = await coordinator.completeGoal({
        schemaVersion: "1.0",
        tenantId: "local-erpnext-pilot",
        parentGoalId: "erpnext-halted-control",
        requestId: "erpnext-halted-control-request",
        scopeKey: REAL_ERPNEXT_PILOT_SCOPE_KEY,
        ordinaryGoal: REAL_ERPNEXT_PILOT_GOAL,
        visibility: "full",
      });
      expect(result.status).not.toBe("completed");
      expect(world.broadGoalStateHash()).toBe(before);
      expect(world.verifyBroadGoal()).toMatchObject({ passed: false, intendedWrites: 0, incorrectSideEffects: 0 });
      expect(operations.verifyAuditChain()).toMatchObject({ passed: true });
    } finally {
      operations.close();
    }
  }, 180_000);
});
