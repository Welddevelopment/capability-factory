import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConsoleApp } from "../apps/console/server/app.js";
import { CapabilityFactorySidecarClient } from "../src/product/client.js";
import { createGoalContinuationGrant } from "../src/product/continuation.js";
import { createCapabilitySidecar } from "../src/product/sidecar.js";
import { SidecarGoalJobService, SidecarGoalJobStore } from "../src/product/sidecar-jobs.js";
import {
  BROWSER_BROAD_GOAL_TENANT,
  BrowserBroadGoalWorld,
} from "../src/customer-world/browser-broad-goal-world.js";

const enabled = process.env.CF_REAL_BROWSER === "1";
const testIfEnabled = enabled ? it : it.skip;
const worlds: BrowserBroadGoalWorld[] = [];
const apps: Array<{ close(): Promise<void> }> = [];
const services: SidecarGoalJobService[] = [];
const SIDECAR_TOKEN = "real-browser-broad-goal-sidecar-token";

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(worlds.splice(0).map((world) => world.close()));
});

function capabilityPaths(result: Awaited<ReturnType<ReturnType<BrowserBroadGoalWorld["coordinator"]>["completeGoal"]>>): string[] {
  if (!("state" in result)) return [];
  return Object.values(result.state.items).map((item) =>
    item.execution && "path" in item.execution ? item.execution.path : "none",
  );
}

describe("genuine Chromium broad-goal route", () => {
  testIfEnabled("splits one ordinary goal into three verified browser tasks, builds once, reuses twice, and resumes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-real-browser-broad-goal-"));
    const world = await BrowserBroadGoalWorld.start(root);
    worlds.push(world);

    const request = world.request("complete");
    const result = await world.coordinator().completeGoal(request);

    expect(result).toMatchObject({
      status: "completed",
      planning: { source: "newly-validated", attempts: 1, workItems: 3 },
      state: {
        aggregate: {
          result: "complete",
          passed: true,
          completedItems: 3,
          incorrectSideEffects: 0,
        },
        resume: { completed: true },
      },
    });
    expect(capabilityPaths(result)).toEqual([
      "built-capability",
      "retained-capability",
      "retained-capability",
    ]);
    expect(world.portal.count()).toBe(3);
    expect(world.portal.records()).toEqual([
      expect.objectContaining({ reference: "RESTOCK-COOLANT", quantity: 3, status: "complete" }),
      expect.objectContaining({ reference: "RESTOCK-CRATES", quantity: 2, status: "complete" }),
      expect.objectContaining({ reference: "RESTOCK-LABELS", quantity: 5, status: "complete" }),
    ]);
    expect(world.registryRecords()).toEqual([
      expect.objectContaining({
        tenantId: BROWSER_BROAD_GOAL_TENANT,
        origin: "built:browser-ui-contract-builder-v1",
        status: "active",
        reuseCount: 2,
      }),
    ]);
    expect(world.operations.verifyAuditChain()).toMatchObject({ passed: true });
  }, 120_000);

  testIfEnabled("stops every browser task before action when write authority is absent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-real-browser-broad-blocked-"));
    const world = await BrowserBroadGoalWorld.start(root);
    worlds.push(world);
    world.setWriteAuthority(false);

    const result = await world.coordinator().completeGoal(world.request("blocked"));

    expect(result).toMatchObject({
      status: "blocked",
      planning: { source: "newly-validated", attempts: 1, workItems: 3 },
      state: {
        aggregate: {
          result: "blocked",
          passed: false,
          completedItems: 0,
          blockedItems: 3,
          incorrectSideEffects: 0,
        },
      },
    });
    expect(world.portal.count()).toBe(0);
    expect(world.operations.verifyAuditChain()).toMatchObject({ passed: true });
  }, 120_000);

  testIfEnabled("runs the same browser coordinator as an authenticated durable sidecar job with idempotent submission", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-real-browser-sidecar-"));
    const world = await BrowserBroadGoalWorld.start(root);
    worlds.push(world);
    const coordinator = world.coordinator();
    const service = new SidecarGoalJobService(
      new SidecarGoalJobStore(path.join(root, "jobs.sqlite")),
      coordinator,
    );
    const app = createCapabilitySidecar(undefined, { resolve: () => undefined }, {
      accessToken: SIDECAR_TOKEN,
      broadGoals: coordinator,
      goalJobs: service,
    });
    apps.push(app);
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new CapabilityFactorySidecarClient({ baseUrl, accessToken: SIDECAR_TOKEN });
    const request = world.request("durable");

    const started = await client.startGoal(request);
    const completed = await client.waitForGoalJob(request.tenantId, started.jobId, {
      timeoutMs: 120_000,
      pollIntervalMs: 10,
    });
    expect(completed).toMatchObject({
      status: "completed",
      attempts: 1,
      result: {
        status: "completed",
        state: {
          aggregate: { passed: true, completedItems: 3, incorrectSideEffects: 0 },
          resume: { completed: true },
        },
      },
    });
    const duplicate = await client.startGoal(request);
    expect(duplicate.jobId).toBe(started.jobId);
    expect(duplicate).toMatchObject({ status: "completed", attempts: 1 });
    await expect(client.startGoal({ ...request, requestId: "conflicting-browser-request" }))
      .rejects.toThrow(/HTTP 409/);
    const events = await client.getGoalJobEvents(request.tenantId, started.jobId);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "job.queued",
      "job.started",
      "job.completed",
    ]));
    expect(world.portal.count()).toBe(3);
  }, 120_000);

  testIfEnabled("recovers a claimed browser job after a simulated sidecar restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-real-browser-restart-"));
    const world = await BrowserBroadGoalWorld.start(root);
    worlds.push(world);
    const databasePath = path.join(root, "jobs.sqlite");
    const request = world.request("restart");
    const interrupted = new SidecarGoalJobStore(databasePath);
    const saved = interrupted.create(request).job;
    expect(interrupted.claim(request.tenantId, saved.jobId)?.job.status).toBe("running");
    interrupted.close();

    const recovered = new SidecarGoalJobService(
      new SidecarGoalJobStore(databasePath),
      world.coordinator(),
    );
    services.push(recovered);
    expect(recovered.recover()).toEqual([
      expect.objectContaining({ jobId: saved.jobId, status: "queued", attempts: 1 }),
    ]);
    await recovered.idle();
    expect(recovered.get(request.tenantId, saved.jobId)).toMatchObject({
      status: "completed",
      attempts: 2,
      result: { status: "completed" },
    });
    expect(recovered.events(request.tenantId, saved.jobId).map((event) => event.type)).toContain("job.recovered");
    expect(world.portal.count()).toBe(3);
  }, 120_000);

  testIfEnabled("continues each exact permission-blocked browser item under fresh signed customer-local grants", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-real-browser-continuation-"));
    const world = await BrowserBroadGoalWorld.start(root);
    worlds.push(world);
    world.setWriteAuthority(false);
    const coordinator = world.coordinator();
    const service = new SidecarGoalJobService(
      new SidecarGoalJobStore(path.join(root, "jobs.sqlite")),
      coordinator,
    );
    const app = createCapabilitySidecar(undefined, { resolve: () => undefined }, {
      accessToken: SIDECAR_TOKEN,
      broadGoals: coordinator,
      goalJobs: service,
    });
    apps.push(app);
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new CapabilityFactorySidecarClient({ baseUrl, accessToken: SIDECAR_TOKEN });
    const request = world.request("continued");
    const started = await client.startGoal(request);
    let receipt = await client.waitForGoalJob(request.tenantId, started.jobId, {
      timeoutMs: 120_000,
      pollIntervalMs: 10,
    });
    expect(receipt).toMatchObject({ status: "blocked", result: { status: "blocked" } });
    expect(world.portal.count()).toBe(0);

    for (let index = 0; index < 3; index += 1) {
      if (!receipt.result || !("state" in receipt.result) || !receipt.result.plan) {
        throw new Error("Expected a durable blocked browser plan and coordination state.");
      }
      const blocked = receipt.result.plan.workItems.find(
        (item) => receipt.result && "state" in receipt.result && receipt.result.state.items[item.workItemId]?.lifecycle === "blocked",
      );
      if (!blocked) throw new Error("Expected another blocked browser work item.");
      const grant = createGoalContinuationGrant({
        plan: receipt.result.plan,
        state: receipt.result.state,
        workItemId: blocked.workItemId,
        kind: "permission-approved",
        authorizedMissing: blocked.authority.missing,
        preconditions: [{ id: "customer-browser-write-approval", passed: true, detail: "The customer-local operator approved this exact fictional browser action." }],
        issuedBy: "customer-local-operator",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        authority: world.continuationAuthority,
      });
      expect(await client.continueGoalJob(request.tenantId, started.jobId, grant)).toMatchObject({
        status: "queued",
        continuationGrantId: grant.grantId,
      });
      receipt = await client.waitForGoalJob(request.tenantId, started.jobId, {
        timeoutMs: 120_000,
        pollIntervalMs: 10,
      });
      expect(world.portal.count()).toBe(index + 1);
    }

    expect(receipt).toMatchObject({
      status: "completed",
      attempts: 4,
      result: {
        status: "completed",
        planning: { source: "retained-validated-plan", attempts: 0 },
        state: {
          aggregate: { passed: true, completedItems: 3, incorrectSideEffects: 0 },
          resume: { completed: true },
        },
      },
    });
    expect(world.registryRecords()).toEqual([
      expect.objectContaining({ status: "active", reuseCount: 2 }),
    ]);
  }, 180_000);

  testIfEnabled("projects a live browser-backed durable job into the existing operator console contract", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-real-browser-console-"));
    const world = await BrowserBroadGoalWorld.start(root);
    worlds.push(world);
    const coordinator = world.coordinator();
    const service = new SidecarGoalJobService(
      new SidecarGoalJobStore(path.join(root, "jobs.sqlite")),
      coordinator,
    );
    const sidecarApp = createCapabilitySidecar(undefined, { resolve: () => undefined }, {
      accessToken: SIDECAR_TOKEN,
      broadGoals: coordinator,
      goalJobs: service,
    });
    apps.push(sidecarApp);
    const baseUrl = await sidecarApp.listen({ host: "127.0.0.1", port: 0 });
    const client = new CapabilityFactorySidecarClient({ baseUrl, accessToken: SIDECAR_TOKEN });
    const { app: consoleApp } = createConsoleApp({
      databasePath: path.join(root, "console.sqlite"),
      goalDataDirectory: path.join(root, "console-goals"),
      sidecar: {
        client,
        tenantId: BROWSER_BROAD_GOAL_TENANT,
        scopeKey: "browser-restock-scope",
        fixtureLabel: "Disposable customer-local browser portal · fictional restock batch",
        workflowLabel: "Experimental browser capability · durable sidecar",
        suggestedGoal: "Create every approved dealer restock request due in this batch, verify each one, and continue the original inventory goal.",
        capabilityFormat: "constrained browser capability from a hashed trusted UI contract",
        capabilityVerifierLabel: "customer-local bounded Chromium probe",
        pollIntervalMs: 10,
      },
    });
    apps.push(consoleApp);

    const created = await consoleApp.inject({
      method: "POST",
      url: "/api/playground/runs",
      payload: {
        goal: "Create every approved dealer restock request due in this batch, verify each one, and continue the original inventory goal.",
        mode: "sidecar-live",
      },
    });
    expect(created.statusCode).toBe(202);
    const { runId } = created.json<{ runId: string }>();
    const deadline = Date.now() + 120_000;
    let projected: Record<string, any> | undefined;
    while (Date.now() < deadline) {
      const response = await consoleApp.inject({ method: "GET", url: `/api/runs/${runId}` });
      projected = response.json<Record<string, any>>();
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
    const projectedItems = projected?.goalPlan.groups.flatMap((group: { items: unknown[] }) => group.items) ?? [];
    expect(projectedItems).toHaveLength(3);
    expect(projectedItems.map((item: { acquisitionPath: string }) => item.acquisitionPath)).toEqual([
      "new-capability",
      "retained-reuse",
      "retained-reuse",
    ]);
    const firstChild = projectedItems[0] as { childRunId: string };
    const childProjection = (await consoleApp.inject({ method: "GET", url: `/api/runs/${firstChild.childRunId}` })).json<Record<string, any>>();
    const buildEvent = childProjection.events.find((event: { type: string }) => event.type === "build.completed");
    expect(buildEvent?.payload.format).toBe("constrained browser capability from a hashed trusted UI contract");
    expect(projected?.events.some((event: { type: string }) => event.type === "sidecar.job.status")).toBe(true);
    expect(world.portal.count()).toBe(3);
  }, 180_000);
});
