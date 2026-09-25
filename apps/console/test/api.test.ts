import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HmacGoalContinuationAuthority, type GoalContinuationGrant } from "../../../src/product/continuation.js";
import type { BroadGoalRequest, BroadGoalRunResult } from "../../../src/product/broad-goal-sdk.js";
import { goalPlanDigest } from "../../../src/product/goal-scheduler.js";
import type { SidecarGoalJobReceipt } from "../../../src/product/sidecar-jobs.js";
import { createConsoleApp } from "../server/app.js";
import { runLiveBroadGoalReference } from "../server/live-goal-coordinator.js";

describe("console API", () => {
  it("shows the connected sidecar's explicit capability-mode registry without merging maturity claims", async () => {
    const { app } = createConsoleApp({
      sidecar: {
        client: {
          startGoal: async () => { throw new Error("Not used by this test."); },
          getGoalJob: async () => { throw new Error("Not used by this test."); },
          getGoalJobEvents: async () => [],
          continueGoalJob: async () => { throw new Error("Not used by this test."); },
          listCapabilityModes: async () => ({
            schemaVersion: "1.0",
            selection: "trusted-explicit",
            inference: false,
            modes: [
              {
                capabilityMode: "constrained-http-api",
                label: "Constrained HTTP API",
                driverVersion: "http-v1",
                maturity: "working-local-pilot-mvp",
                configured: true,
                claimBoundary: "Working local HTTP pilot MVP.",
              },
              {
                capabilityMode: "experimental-document-actions",
                label: "Machine-readable document actions",
                driverVersion: "document-v0.1",
                maturity: "experimental-local",
                configured: true,
                claimBoundary: "Bounded local PDF experiment.",
              },
            ],
          }),
        },
        tenantId: "mode-registry-test",
        scopeKey: "mode-registry-scope",
        fixtureLabel: "Mode registry fixture",
        workflowLabel: "Mode registry workflow",
        suggestedGoal: "Inspect configured modes.",
      },
    });
    const response = await app.inject({ method: "GET", url: "/api/capability-modes" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configured: true,
      selection: "trusted-explicit",
      inference: false,
    });
    expect(response.json().modes).toEqual([
      expect.objectContaining({ capabilityMode: "constrained-http-api", maturity: "working-local-pilot-mvp" }),
      expect.objectContaining({ capabilityMode: "experimental-document-actions", maturity: "experimental-local" }),
    ]);
    const page = await app.inject({ method: "GET", url: "/capability-modes" });
    expect(page.body).toContain("HTTP local pilot MVP · adjacent modes experimental");
    await app.close();
  });
  it("exposes a bounded recording profile and persistent evidence boundary without changing the product route", async () => {
    const recordingProfile = {
      suggestedGoal: "Complete every fictional order due by 21:00 today, and place one safe restock for every required item that is short.",
      defaultMode: "goal-plan-complete" as const,
    };
    const { app } = createConsoleApp({ recordingProfile });
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json().recordingProfile).toEqual(recordingProfile);
    const page = await app.inject({ method: "GET", url: "/playground" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("HTTP local pilot MVP · adjacent modes experimental");
    await app.close();
  });
  it("renders recorded and live paths through the same run API", async () => {
    const { app } = createConsoleApp(); const runs = await app.inject({ method: "GET", url: "/api/runs" });
    expect(runs.statusCode).toBe(200); expect(runs.json()[0]).toMatchObject({ source: "recorded-run", recorded: true });
    const created = await app.inject({ method: "POST", url: "/api/playground/runs", payload: { goal: "Create the approved fictional record and verify it directly.", mode: "complete" } });
    const run = await app.inject({ method: "GET", url: `/api/runs/${created.json().runId}` });
    expect(run.json()).toMatchObject({ source: "agent-playground", recorded: false, status: "completed" }); expect(run.json().events.map((event: { type: string }) => event.type)).toContain("outcome.verification.completed"); await app.close();
  });
  it("stops the read-only playground before execution", async () => {
    const { app } = createConsoleApp(); const created = await app.inject({ method: "POST", url: "/api/playground/runs", payload: { goal: "Attempt the approved fictional write under the selected read-only policy.", mode: "permission-handoff" } });
    const run = (await app.inject({ method: "GET", url: `/api/runs/${created.json().runId}` })).json(); expect(run.status).toBe("handoff"); expect(run.events.map((event: { type: string }) => event.type)).not.toContain("execution.completed"); await app.close();
  });
  it("does not activate an untested policy", async () => {
    const { app } = createConsoleApp(); const draft = (await app.inject({ method: "POST", url: "/api/policies", payload: { name: "Read policy v2", allowedTargets: ["fictional_erp"], credentialAliases: ["erp_sandbox_key"], methods: ["GET"], writeAuthority: "denied", approvedActions: [] } })).json();
    const activation = await app.inject({ method: "POST", url: `/api/policies/${draft.version}/activate`, payload: {} }); expect(activation.statusCode).toBe(500); await app.close();
  });
  it("creates a parent goal plan and returns it from the existing run route", async () => {
    const { app } = createConsoleApp();
    const created = await app.inject({ method: "POST", url: "/api/playground/runs", payload: { goal: "Complete every fictional order due before 9pm and restock every item without sufficient stock.", fixture: "fictional-order-operations-2100-v1", mode: "goal-plan-partial" } });
    expect(created.statusCode).toBe(201); expect(created.json()).toMatchObject({ execution: "verified-reference" }); expect(created.json()).toHaveProperty("parentGoalId");
    const run = (await app.inject({ method: "GET", url: `/api/runs/${created.json().runId}` })).json();
    expect(run.goalPlan).toMatchObject({ lifecycle: "partially-completed", rollup: { result: "partially-complete", blockedItems: 1 } });
    expect(run.goalPlan.groups.flatMap((group: { items: unknown[] }) => group.items)).toHaveLength(7);
    expect(run.events.find((event: { type: string }) => event.type === "goal.plan.validated").sensitivity.source).toBe("product-core");
    expect(run.events.find((event: { type: string }) => event.type === "work-item.blocked").payload.writesAttempted).toBe(0);
    expect(run.events.map((event: { type: string }) => event.type)).not.toContain("build.completed");
    await app.close();
  });
  it("runs all seven authorized items through real scheduler state before aggregate completion", async () => {
    const { app } = createConsoleApp();
    const created = await app.inject({ method: "POST", url: "/api/playground/runs", payload: { goal: "Complete every fictional order due before 9pm and restock every item without sufficient stock.", fixture: "fictional-order-operations-2100-v1", mode: "goal-plan-complete" } });
    const run = (await app.inject({ method: "GET", url: `/api/runs/${created.json().runId}` })).json();
    expect(run.status).toBe("completed");
    expect(run.goalPlan.rollup).toMatchObject({ result: "complete", passed: true, completedItems: 7, blockedItems: 0, incorrectSideEffects: 0 });
    expect(run.events.filter((event: { type: string }) => event.type === "work-item.completed")).toHaveLength(7);
    expect(run.events.map((event: { type: string }) => event.type)).toContain("resumption.completed");
    const east = run.goalPlan.groups.flatMap((group: { items: Array<{ workflowKey: string; acquisitionPath: string; childRunId: string }> }) => group.items).find((item: { workflowKey: string }) => item.workflowKey === "restock-east-industrial");
    expect(east).toMatchObject({ acquisitionPath: "new-capability" });
    if (!east) throw new Error("East Industrial work item missing from live console plan.");
    const eastBuild = (await app.inject({ method: "GET", url: `/api/runs/${east.childRunId}` })).json();
    expect(eastBuild.events.map((event: { type: string }) => event.type)).toEqual(expect.arrayContaining(["diagnosis.completed", "search.retained.completed", "search.trusted.completed", "build.completed", "capability.verification.completed", "execution.completed", "outcome.verification.completed", "resumption.completed"]));

    const reusedCreated = await app.inject({ method: "POST", url: "/api/playground/runs", payload: { goal: "Complete every fictional order due before 9pm and restock every item without sufficient stock.", fixture: "fictional-order-operations-2100-v1", mode: "goal-plan-complete" } });
    const reusedRun = (await app.inject({ method: "GET", url: `/api/runs/${reusedCreated.json().runId}` })).json();
    const reusedEast = reusedRun.goalPlan.groups.flatMap((group: { items: Array<{ workflowKey: string; acquisitionPath: string; childRunId: string }> }) => group.items).find((item: { workflowKey: string }) => item.workflowKey === "restock-east-industrial");
    expect(reusedEast).toMatchObject({ acquisitionPath: "retained-reuse" });
    if (!reusedEast) throw new Error("Reused East Industrial work item missing from live console plan.");
    const eastReuse = (await app.inject({ method: "GET", url: `/api/runs/${reusedEast.childRunId}` })).json();
    expect(eastReuse.events.map((event: { type: string }) => event.type)).toContain("search.retained.completed");
    expect(eastReuse.events.map((event: { type: string }) => event.type)).not.toContain("build.completed");
    await app.close();
  });
  it("rejects unknown playground fields", async () => {
    const { app } = createConsoleApp();
    const response = await app.inject({ method: "POST", url: "/api/playground/runs", payload: { goal: "A sufficiently long fictional goal for testing.", mode: "goal-plan-partial", fixture: "fictional-order-operations-2100-v1", rawCustomerPayload: "must not enter browser contract" } });
    expect(response.statusCode).toBe(500); await app.close();
  });
  it("does not pretend the durable customer sidecar exists when it is not configured", async () => {
    const { app } = createConsoleApp();
    const response = await app.inject({ method: "POST", url: "/api/playground/runs", payload: { goal: "Complete the approved test batch through the customer-local runtime.", mode: "sidecar-live" } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatch(/No customer-local sidecar/);
    await app.close();
  });
  it("shows activation as blocked when pilot evidence is not configured", async () => {
    const { app } = createConsoleApp();
    const response = await app.inject({ method: "GET", url: "/api/pilot-setup" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      posture: "private-alpha-controlled-pilot",
      activationReady: false,
      summary: { configured: 0, passed: 0, total: 6 },
      boundary: { currentCapabilityMode: "constrained-http-api", productionAccess: false },
    });
    expect(response.json().gates).toHaveLength(6);
    await app.close();
  });
  it("requires an exact confirmation before changing the customer-local operational mode", async () => {
    const { app } = createConsoleApp();
    const before = (await app.inject({ method: "GET", url: "/api/operations" })).json();
    expect(before).toMatchObject({ mode: "running", audit: { passed: true } });
    const rejected = await app.inject({
      method: "POST",
      url: "/api/operations/mode",
      payload: { expectedMode: "running", mode: "halted", reason: "Operator safety rehearsal.", confirmation: "halt" },
    });
    expect(rejected.statusCode).toBe(400);
    const accepted = await app.inject({
      method: "POST",
      url: "/api/operations/mode",
      payload: { expectedMode: "running", mode: "halted", reason: "Operator safety rehearsal.", confirmation: "SET HALTED" },
    });
    expect(accepted.json()).toMatchObject({ mode: "halted", audit: { passed: true } });
    await app.close();
  });
  it("issues a signed exact continuation for a durable sidecar handoff", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-console-continuation-"));
    const authority = new HmacGoalContinuationAuthority(
      "console-test-continuation-v1",
      "console-test-continuation-secret-with-more-than-thirty-two-bytes",
    );
    let submittedGrant: GoalContinuationGrant | undefined;
    try {
      const live = await runLiveBroadGoalReference({
        runId: "sidecar-console-test",
        requestId: "sidecar-console-request",
        ordinaryGoal: "Complete every fictional order due before 9pm and restock every item without sufficient stock.",
        scenario: "partial-authority",
        dataDirectory: directory,
      });
      let result: BroadGoalRunResult = {
        status: live.state.lifecycle,
        tenantId: live.state.tenantId,
        parentGoalId: live.parentGoalId,
        requestId: live.state.requestId,
        planning: {
          source: "newly-validated",
          attempts: 1,
          validationReceiptId: live.plan.validationReceiptId,
          planDigest: live.state.planDigest,
          workItems: live.plan.workItems.length,
        },
        plan: live.plan,
        state: live.state,
      };
      const receipt = (status: SidecarGoalJobReceipt["status"]): SidecarGoalJobReceipt => ({
        schemaVersion: "1.0",
        jobId: "console-continuation-job",
        tenantId: "sidecar-test-tenant",
        parentGoalId: live.parentGoalId,
        requestId: "sidecar-console-request",
        status,
        attempts: 1,
        ...(status === "partially-complete" ? { result } : {}),
        ...(submittedGrant ? { continuationGrantId: submittedGrant.grantId } : {}),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const client = {
        startGoal: async (request: BroadGoalRequest) => {
          if (!("state" in result) || !result.plan) throw new Error("Expected a stateful test result.");
          const plan = {
            ...result.plan,
            tenantId: request.tenantId,
            parentGoalId: request.parentGoalId,
            requestId: request.requestId,
            ordinaryGoal: request.ordinaryGoal,
          };
          result = {
            ...result,
            tenantId: request.tenantId,
            parentGoalId: request.parentGoalId,
            requestId: request.requestId,
            plan,
            state: {
              ...result.state,
              tenantId: request.tenantId,
              parentGoalId: request.parentGoalId,
              requestId: request.requestId,
              planDigest: goalPlanDigest(plan),
            },
          };
          return receipt("partially-complete");
        },
        getGoalJob: async () => receipt(submittedGrant ? "queued" : "partially-complete"),
        getGoalJobEvents: async () => [],
        continueGoalJob: async (_tenantId: string, _jobId: string, grant: GoalContinuationGrant) => {
          submittedGrant = grant;
          return receipt("queued");
        },
      };
      const { app } = createConsoleApp({
        sidecar: {
          client,
          tenantId: "sidecar-test-tenant",
          scopeKey: "sidecar-test-scope",
          fixtureLabel: "Signed continuation fixture",
          workflowLabel: "Durable signed continuation",
          suggestedGoal: "Continue one exact approved action.",
          continuationAuthority: authority,
          pollIntervalMs: 10,
        },
      });
      const started = await app.inject({
        method: "POST",
        url: "/api/playground/runs",
        payload: { goal: "Continue one exact approved fictional action through the durable sidecar.", mode: "sidecar-live" },
      });
      expect(started.statusCode).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const handoffs = (await app.inject({ method: "GET", url: "/api/handoffs" })).json() as Array<Record<string, unknown>>;
      const exact = handoffs.find((item) => item.continuable === true);
      expect(exact).toMatchObject({ lifecycle: "open", expectedStateVersion: live.state.version });
      const continued = await app.inject({
        method: "POST",
        url: `/api/handoffs/${String(exact?.handoffId)}/continue`,
        payload: {
          expectedStateVersion: live.state.version,
          issuedBy: "customer-operator",
          confirmation: "APPROVE EXACT BLOCKED ACTION",
        },
      });
      expect(continued.statusCode).toBe(202);
      expect(submittedGrant).toMatchObject({
        workItemId: exact?.workItemId,
        expectedStateVersion: live.state.version,
        kind: "permission-approved",
        authorityKeyId: authority.keyId,
      });
      await app.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
