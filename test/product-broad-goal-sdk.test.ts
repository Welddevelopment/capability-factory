import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startBroadGoalCapabilityLayer } from "../src/customer-world/broad-goal-capability-layer.js";
import {
  BroadGoalReferenceWorld,
  createBroadGoalPlanProposal,
  createBroadGoalTrustedScope,
} from "../src/customer-world/broad-goal-reference-world.js";
import {
  BROAD_GOAL_REQUEST_SCHEMA_VERSION,
  BroadGoalCoordinatorSdk,
  FileValidatedGoalPlanStore,
  type BroadGoalRequest,
} from "../src/product/broad-goal-sdk.js";
import { CapabilityFactorySidecarClient } from "../src/product/client.js";
import { createGoalContinuationGrant, HmacGoalContinuationAuthority } from "../src/product/continuation.js";
import type { GoalPlanner } from "../src/product/goal-coordination.js";
import { FileGoalCoordinationStore, GoalScheduler } from "../src/product/goal-scheduler.js";
import { createCapabilitySidecar } from "../src/product/sidecar.js";
import { SidecarGoalJobService, SidecarGoalJobStore } from "../src/product/sidecar-jobs.js";

const TOKEN = "broad-goal-sidecar-test-token";
const continuationAuthority = new HmacGoalContinuationAuthority(
  "sdk-test-continuation-key",
  "sdk-test-continuation-secret-that-is-at-least-32-bytes",
);

function request(id: string, scopeKey = "fictional-orders-full"): BroadGoalRequest {
  return {
    schemaVersion: BROAD_GOAL_REQUEST_SCHEMA_VERSION,
    tenantId: "local-alpha",
    parentGoalId: `parent-${id}`,
    requestId: `request-${id}`,
    scopeKey,
    ordinaryGoal: "Make every fictional order due by 21:00 ready and safely restock every required shortage.",
    visibility: "summary",
  };
}

function capabilityPaths(result: Awaited<ReturnType<BroadGoalCoordinatorSdk["completeGoal"]>>): string[] {
  if (!("state" in result)) return [];
  return Object.values(result.state.items).flatMap((item) => {
    const execution = item.execution;
    return execution && "path" in execution ? [execution.path] : [];
  });
}

function referenceSdk(
  directory: string,
  options: { interruptAfterFirstCompletion?: boolean; mismatchedScope?: boolean } = {},
) {
  let plannerCalls = 0;
  let interrupt = options.interruptAfterFirstCompletion === true;
  const planner: GoalPlanner = {
    propose: async () => {
      plannerCalls += 1;
      return createBroadGoalPlanProposal();
    },
  };
  const sdk = new BroadGoalCoordinatorSdk({
    planner,
    maxPlanningAttempts: 1,
    plans: new FileValidatedGoalPlanStore(join(directory, "plans")),
    scopes: {
      resolve: async (input) => {
        if (!input.scopeKey.startsWith("fictional-orders-")) return undefined;
        const scenario = input.scopeKey === "fictional-orders-limited" ? "partial-authority" : "complete-authority";
        const scope = createBroadGoalTrustedScope(input.parentGoalId, input.requestId, scenario, input.ordinaryGoal);
        return options.mismatchedScope ? { ...scope, requestId: "different-request" } : scope;
      },
    },
    runtimes: {
      open: async (scope) => {
        const runDirectory = join(directory, "runs", scope.parentGoalId);
        const world = new BroadGoalReferenceWorld(join(runDirectory, "world.sqlite"));
        const layer = await startBroadGoalCapabilityLayer(world, join(directory, "registry"));
        const scheduler = new GoalScheduler(
          new FileGoalCoordinationStore(join(runDirectory, "coordination")),
          layer.executor,
          world,
          world,
          world,
          undefined,
          continuationAuthority,
        );
        return {
          runner: {
            run: async (plan) => {
              const state = await scheduler.run(plan);
              if (interrupt) {
                interrupt = false;
                throw new Error("Simulated lost sidecar response after verified completion.");
              }
              return state;
            },
            continue: async (plan, grant) => scheduler.continue(plan, grant),
          },
          close: async () => {
            await layer.close();
            world.close();
          },
        };
      },
    },
  });
  return { sdk, plannerCalls: () => plannerCalls };
}

describe("broad-goal SDK and sidecar installation shapes", () => {
  it("produces the same verified parent result through direct SDK and authenticated sidecar routes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-broad-sdk-sidecar-"));
    const reference = referenceSdk(directory);
    try {
      const direct = await reference.sdk.completeGoal(request("direct"));
      expect(direct).toMatchObject({
        status: "completed",
        planning: { source: "newly-validated", attempts: 1, workItems: 7 },
        state: {
          aggregate: { result: "complete", passed: true, completedItems: 7, incorrectSideEffects: 0 },
          resume: { completed: true },
        },
      });
      expect(capabilityPaths(direct)).toContain("built-capability");
      const savedPlanText = readFileSync(join(directory, "plans", readdirSync(join(directory, "plans"))[0]!), "utf8");
      expect(savedPlanText).toContain("supplier_east_key");
      expect(savedPlanText).not.toContain("local-reference-east-key");

      const goalJobs = new SidecarGoalJobService(
        new SidecarGoalJobStore(join(directory, "sidecar-jobs.sqlite")),
        reference.sdk,
      );
      const app = createCapabilitySidecar(undefined, { resolve: () => undefined }, {
        accessToken: TOKEN,
        broadGoals: reference.sdk,
        goalJobs,
      });
      const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
      try {
        const throughSidecar = await new CapabilityFactorySidecarClient({ baseUrl, accessToken: TOKEN })
          .completeGoal(request("sidecar"));
        expect(throughSidecar).toMatchObject({
          status: "completed",
          planning: { source: "newly-validated", attempts: 1, workItems: 7 },
          state: {
            aggregate: { result: "complete", passed: true, completedItems: 7, incorrectSideEffects: 0 },
            resume: { completed: true },
          },
        });
        expect(capabilityPaths(throughSidecar)).toContain("retained-capability");
        const asyncInput = request("async-sidecar");
        const started = await new CapabilityFactorySidecarClient({ baseUrl, accessToken: TOKEN }).startGoal(asyncInput);
        const finished = await new CapabilityFactorySidecarClient({ baseUrl, accessToken: TOKEN }).waitForGoalJob(
          asyncInput.tenantId,
          started.jobId,
          { timeoutMs: 5_000, pollIntervalMs: 10 },
        );
        expect(finished).toMatchObject({
          status: "completed",
          result: {
            status: "completed",
            state: {
              aggregate: { result: "complete", passed: true, completedItems: 7, incorrectSideEffects: 0 },
              resume: { completed: true },
            },
          },
        });
        if (!finished.result) throw new Error("Expected asynchronous sidecar result.");
        expect(capabilityPaths(finished.result)).toContain("retained-capability");
        await expect(new CapabilityFactorySidecarClient({
          baseUrl,
          accessToken: "wrong-broad-goal-token",
        }).completeGoal(request("wrong-token"))).rejects.toThrow(/HTTP 401/);
      } finally {
        await app.close();
      }
      expect(reference.plannerCalls()).toBe(3);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reuses the exact saved plan after a lost response instead of asking the model to plan again", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-broad-sdk-restart-"));
    const reference = referenceSdk(directory, { interruptAfterFirstCompletion: true });
    const input = request("restart");
    try {
      await expect(reference.sdk.completeGoal(input)).rejects.toThrow(/lost sidecar response/);
      const retried = await reference.sdk.completeGoal(input);
      expect(retried).toMatchObject({
        status: "completed",
        planning: { source: "retained-validated-plan", attempts: 0, workItems: 7 },
        state: { aggregate: { result: "complete", incorrectSideEffects: 0 }, resume: { completed: true } },
      });
      expect(reference.plannerCalls()).toBe(1);
      const world = new BroadGoalReferenceWorld(join(directory, "runs", input.parentGoalId, "world.sqlite"));
      try {
        expect((world.stateSnapshot().restocks as unknown[])).toHaveLength(4);
      } finally {
        world.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("stops before work when trusted scope is missing, mismatched, or changes after planning", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-broad-sdk-scope-"));
    try {
      const reference = referenceSdk(directory);
      expect(await reference.sdk.completeGoal(request("missing", "unknown-scope"))).toMatchObject({
        status: "handoff",
        handoff: { reason: "scope-unavailable", writesAttempted: 0 },
      });

      const mismatched = referenceSdk(join(directory, "mismatch"), { mismatchedScope: true });
      expect(await mismatched.sdk.completeGoal(request("mismatch"))).toMatchObject({
        status: "handoff",
        handoff: { reason: "scope-mismatch", writesAttempted: 0 },
      });

      const input = request("changed-scope");
      expect((await reference.sdk.completeGoal(input)).status).toBe("completed");
      expect(await reference.sdk.completeGoal({ ...input, scopeKey: "fictional-orders-limited" })).toMatchObject({
        status: "handoff",
        handoff: { reason: "trusted-scope-changed", writesAttempted: 0 },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps independent work moving around an authority block without claiming parent completion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-broad-sdk-authority-"));
    try {
      const result = await referenceSdk(directory).sdk.completeGoal(request("limited", "fictional-orders-limited"));
      expect(result).toMatchObject({
        status: "partially-complete",
        state: {
          aggregate: {
            result: "partially-complete",
            passed: false,
            completedItems: 6,
            blockedItems: 1,
            incorrectSideEffects: 0,
          },
        },
      });
      if (!("state" in result)) throw new Error("Expected coordination state.");
      expect(result.state.resume).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("continues the exact saved handoff through both the SDK and durable sidecar without replanning", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-broad-sdk-continuation-"));
    const reference = referenceSdk(directory);
    try {
      const input = request("continue-direct", "fictional-orders-limited");
      const partial = await reference.sdk.completeGoal(input);
      if (!("state" in partial) || !partial.plan) throw new Error("Expected a retained partial plan.");
      const blocked = partial.plan.workItems.find((item) => partial.state.items[item.workItemId]?.lifecycle === "blocked")!;
      const grant = createGoalContinuationGrant({
        plan: partial.plan,
        state: partial.state,
        workItemId: blocked.workItemId,
        kind: "permission-approved",
        authorizedMissing: blocked.authority.missing,
        preconditions: [{ id: "customer-approval", passed: true, detail: "Customer-local approval was recorded." }],
        issuedBy: "customer-operator",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        authority: continuationAuthority,
      });
      expect(await reference.sdk.continueGoal(input, grant)).toMatchObject({
        status: "completed",
        planning: { source: "retained-validated-plan", attempts: 0 },
        state: { aggregate: { completedItems: 7, incorrectSideEffects: 0 }, resume: { completed: true } },
      });
      expect(reference.plannerCalls()).toBe(1);

      const goalJobs = new SidecarGoalJobService(
        new SidecarGoalJobStore(join(directory, "continuation-jobs.sqlite")),
        reference.sdk,
      );
      const app = createCapabilitySidecar(undefined, { resolve: () => undefined }, {
        accessToken: TOKEN,
        broadGoals: reference.sdk,
        goalJobs,
      });
      const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
      try {
        const client = new CapabilityFactorySidecarClient({ baseUrl, accessToken: TOKEN });
        const asyncInput = request("continue-job", "fictional-orders-limited");
        const started = await client.startGoal(asyncInput);
        const stopped = await client.waitForGoalJob(asyncInput.tenantId, started.jobId, { timeoutMs: 5_000, pollIntervalMs: 10 });
        if (!(stopped.result && "state" in stopped.result) || !stopped.result.plan) throw new Error("Expected a blocked durable result.");
        const asyncBlocked = stopped.result.plan.workItems.find(
          (item) => stopped.result && "state" in stopped.result && stopped.result.state.items[item.workItemId]?.lifecycle === "blocked",
        )!;
        const asyncGrant = createGoalContinuationGrant({
          plan: stopped.result.plan,
          state: stopped.result.state,
          workItemId: asyncBlocked.workItemId,
          kind: "permission-approved",
          authorizedMissing: asyncBlocked.authority.missing,
          preconditions: [{ id: "customer-approval", passed: true, detail: "Customer-local approval was recorded." }],
          issuedBy: "customer-operator",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          authority: continuationAuthority,
        });
        expect(await client.continueGoalJob(asyncInput.tenantId, started.jobId, asyncGrant)).toMatchObject({
          status: "queued",
          continuationGrantId: asyncGrant.grantId,
        });
        const finished = await client.waitForGoalJob(asyncInput.tenantId, started.jobId, { timeoutMs: 5_000, pollIntervalMs: 10 });
        expect(finished).toMatchObject({ status: "completed", result: { status: "completed" } });
        expect((await client.getGoalJobEvents(asyncInput.tenantId, started.jobId)).map((event) => event.type)).toContain("job.continuation-queued");
      } finally {
        await app.close();
      }
      expect(reference.plannerCalls()).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects missing authentication, malformed bodies, and unconfigured broad-goal routes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-broad-sidecar-boundary-"));
    const reference = referenceSdk(directory);
    const configured = createCapabilitySidecar(undefined, { resolve: () => undefined }, {
      accessToken: TOKEN,
      broadGoals: reference.sdk,
    });
    const unconfigured = createCapabilitySidecar(undefined, { resolve: () => undefined }, { accessToken: TOKEN });
    try {
      expect((await configured.inject({ method: "POST", url: "/v1/goals", payload: request("unauthorized") })).statusCode).toBe(401);
      expect((await configured.inject({
        method: "POST",
        url: "/v1/goals",
        headers: { "x-capability-sidecar-token": TOKEN },
        payload: { ordinaryGoal: "Incomplete" },
      })).statusCode).toBe(400);
      expect((await unconfigured.inject({
        method: "POST",
        url: "/v1/goals",
        headers: { "x-capability-sidecar-token": TOKEN },
        payload: request("unconfigured"),
      })).statusCode).toBe(404);
      expect(reference.plannerCalls()).toBe(0);
    } finally {
      await configured.close();
      await unconfigured.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
