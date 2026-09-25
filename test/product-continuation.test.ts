import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BroadGoalReferenceWorld,
  createBroadGoalPlanProposal,
  createBroadGoalTrustedScope,
} from "../src/customer-world/broad-goal-reference-world.js";
import {
  assessGoalContinuationChange,
  createGoalContinuationGrant,
  FileGoalContinuationRevocationStore,
  HmacGoalContinuationAuthority,
  type GoalContinuationLivePreconditionVerifier,
} from "../src/product/continuation.js";
import { GoalPlanCompiler, type GoalPlanner, type ValidatedGoalPlan } from "../src/product/goal-coordination.js";
import {
  FileGoalCoordinationStore,
  GoalScheduler,
  type GoalWorkItemExecutionInput,
  type GoalWorkItemExecutor,
} from "../src/product/goal-scheduler.js";

const directories: string[] = [];
const worlds: BroadGoalReferenceWorld[] = [];
const authority = new HmacGoalContinuationAuthority("test-continuation-key", "test-continuation-secret-that-is-at-least-32-bytes");

afterEach(() => {
  for (const world of worlds.splice(0)) world.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function fixture(options: {
  preconditions?: GoalContinuationLivePreconditionVerifier;
  revocations?: FileGoalContinuationRevocationStore;
  execute?: (input: GoalWorkItemExecutionInput, world: BroadGoalReferenceWorld) => ReturnType<GoalWorkItemExecutor["execute"]>;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "cf-continuation-"));
  directories.push(directory);
  const world = new BroadGoalReferenceWorld(join(directory, "world.sqlite"));
  worlds.push(world);
  const planner: GoalPlanner = { propose: async () => createBroadGoalPlanProposal() };
  const compiled = await new GoalPlanCompiler(planner, 1).compile(
    createBroadGoalTrustedScope("parent-continuation", "request-continuation", "partial-authority"),
  );
  if (compiled.status !== "validated") throw new Error("Reference plan did not validate.");
  const modes: GoalWorkItemExecutionInput[] = [];
  const executor: GoalWorkItemExecutor = {
    execute: async (input) => {
      modes.push(structuredClone(input));
      return options.execute ? options.execute(input, world) : world.execute(input);
    },
  };
  const scheduler = new GoalScheduler(
    new FileGoalCoordinationStore(join(directory, "coordination")),
    executor,
    world,
    world,
    world,
    undefined,
    authority,
    options.preconditions,
    options.revocations,
  );
  return { world, scheduler, plan: compiled.plan, modes };
}

function blockedItem(plan: ValidatedGoalPlan) {
  return plan.workItems.find((item) => item.key === "regulated-sensors")!;
}

describe("customer-issued goal continuation", () => {
  it("reconciles the exact blocked item before acting and then resumes the unchanged parent goal", async () => {
    const { world, scheduler, plan, modes } = await fixture();
    const partial = await scheduler.run(plan);
    const item = blockedItem(plan);
    expect(partial.lifecycle).toBe("partially-complete");
    expect(partial.resume).toBeUndefined();
    expect(partial.items[item.workItemId]).toMatchObject({ lifecycle: "blocked", attempts: 0 });

    const grant = createGoalContinuationGrant({
      plan,
      state: partial,
      workItemId: item.workItemId,
      kind: "permission-approved",
      authorizedMissing: item.authority.missing,
      preconditions: [
        { id: "customer-approved-regulated-write", passed: true, detail: "A customer authority adapter recorded the exact approval." },
        { id: "credential-alias-present", passed: true, detail: "The customer-local secret provider can resolve the configured alias." },
      ],
      issuedBy: "customer-operator-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      authority,
    });
    const completed = await scheduler.continue(plan, grant);

    expect(completed.lifecycle).toBe("completed");
    expect(completed.resume?.completed).toBe(true);
    expect(completed.items[item.workItemId]).toMatchObject({
      lifecycle: "completed",
      attempts: 1,
      lastMode: "reconcile",
      continuation: { grantId: grant.grantId, issuedBy: "customer-operator-1" },
    });
    expect(modes.filter((input) => input.item.workItemId === item.workItemId)).toHaveLength(1);
    expect(modes.find((input) => input.item.workItemId === item.workItemId)).toMatchObject({
      mode: "reconcile",
      item: { authority: { currentlyAuthorized: true, missing: [] } },
    });
    expect(world.stateSnapshot().restocks).toHaveLength(4);

    const repeated = await scheduler.continue(plan, grant);
    expect(repeated.version).toBe(completed.version);
    expect(world.stateSnapshot().restocks).toHaveLength(4);
  });

  it("rejects partial, expired, and stale grants without another external write", async () => {
    const { world, scheduler, plan } = await fixture();
    const partial = await scheduler.run(plan);
    const item = blockedItem(plan);
    expect(() => createGoalContinuationGrant({
      plan,
      state: partial,
      workItemId: item.workItemId,
      kind: "permission-approved",
      authorizedMissing: [],
      preconditions: [{ id: "approval", passed: true, detail: "Approval present." }],
      issuedBy: "customer-operator-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      authority,
    })).toThrow(/exact missing authority set/);

    const expired = createGoalContinuationGrant({
      plan,
      state: partial,
      workItemId: item.workItemId,
      kind: "permission-approved",
      authorizedMissing: item.authority.missing,
      preconditions: [{ id: "approval", passed: true, detail: "Approval present." }],
      issuedBy: "customer-operator-1",
      issuedAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-01T00:01:00.000Z",
      authority,
    });
    await expect(scheduler.continue(plan, expired)).rejects.toThrow(/expired/);

    const stale = createGoalContinuationGrant({
      plan,
      state: partial,
      workItemId: item.workItemId,
      kind: "permission-approved",
      authorizedMissing: item.authority.missing,
      preconditions: [{ id: "approval", passed: true, detail: "Approval present." }],
      issuedBy: "customer-operator-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      authority,
    });
    const anotherScheduler = new GoalScheduler(
      new FileGoalCoordinationStore(join(directories[0]!, "coordination")),
      world,
      world,
      world,
      world,
      undefined,
      authority,
    );
    const completed = await anotherScheduler.continue(plan, stale);
    expect(completed.lifecycle).toBe("completed");
    await expect(scheduler.continue(plan, { ...stale, grantId: "0".repeat(32) })).rejects.toThrow();
    expect(world.stateSnapshot().restocks).toHaveLength(4);
  });

  it("rechecks a newly added credential immediately before resumption", async () => {
    let credentialPresent = false;
    const preconditions: GoalContinuationLivePreconditionVerifier = {
      verify: async () => [{ id: "credential-alias-present", passed: credentialPresent, detail: "Customer-local secret alias is resolved at continuation time." }],
    };
    const { world, scheduler, plan } = await fixture({ preconditions });
    const partial = await scheduler.run(plan); const item = blockedItem(plan);
    const grant = createGoalContinuationGrant({ plan, state: partial, workItemId: item.workItemId, kind: "credential-provided",
      authorizedMissing: item.authority.missing, preconditions: [{ id: "credential-added", passed: true, detail: "Operator reported the local credential addition." }],
      issuedBy: "customer-operator-1", expiresAt: new Date(Date.now() + 60_000).toISOString(), authority });
    await expect(scheduler.continue(plan, grant)).rejects.toThrow(/preconditions no longer pass/);
    expect(world.stateSnapshot().restocks).toHaveLength(3);
    credentialPresent = true;
    const completed = await scheduler.continue(plan, grant);
    expect(completed.lifecycle).toBe("completed"); expect(world.stateSnapshot().restocks).toHaveLength(4);
  });

  it("honors a durable customer-local revocation before any continuation action", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-continuation-revocations-")); directories.push(directory);
    const revocations = new FileGoalContinuationRevocationStore(directory);
    const { world, scheduler, plan } = await fixture({ revocations });
    const partial = await scheduler.run(plan); const item = blockedItem(plan);
    const grant = createGoalContinuationGrant({ plan, state: partial, workItemId: item.workItemId, kind: "permission-approved",
      authorizedMissing: item.authority.missing, preconditions: [{ id: "approval", passed: true, detail: "Approval was present." }],
      issuedBy: "customer-operator-1", expiresAt: new Date(Date.now() + 60_000).toISOString(), authority });
    revocations.revoke(grant.grantId, "Operator withdrew the approval.", "customer-operator-1");
    await expect(scheduler.continue(plan, grant)).rejects.toThrow(/revoked/);
    expect(world.stateSnapshot().restocks).toHaveLength(3);
  });

  it("requires changed approvals to enter trusted planning as a new parent goal", async () => {
    const { plan } = await fixture(); const item = blockedItem(plan);
    expect(assessGoalContinuationChange({ item, operationKey: item.operationKey, targetAliases: item.targetAliases,
      methods: item.authority.methods, authorizedMissing: item.authority.missing })).toMatchObject({ decision: "exact-resume" });
    expect(assessGoalContinuationChange({ item, operationKey: `${item.operationKey}-changed`, targetAliases: [...item.targetAliases, "another_system"],
      methods: [...item.authority.methods, "DELETE"], authorizedMissing: item.authority.missing })).toMatchObject({
        decision: "new-validated-goal-required", changed: ["operation", "targets", "methods"],
      });
  });

  it("stops on unknown reconciled state and never blindly repeats the action", async () => {
    let calls = 0;
    const { world, scheduler, plan } = await fixture({ execute: async (input, fixtureWorld) => {
      if (input.item.key !== "regulated-sensors") return fixtureWorld.execute(input);
      calls += 1;
      return { status: "unknown", childRunId: "reconcile-unknown", operationKey: input.item.operationKey, writesAttempted: 0,
        summary: "External state could not be proven; operator resolution is required." };
    } });
    const partial = await scheduler.run(plan); const item = blockedItem(plan);
    const grant = createGoalContinuationGrant({ plan, state: partial, workItemId: item.workItemId, kind: "permission-approved",
      authorizedMissing: item.authority.missing, preconditions: [{ id: "approval", passed: true, detail: "Approval present." }],
      issuedBy: "customer-operator-1", expiresAt: new Date(Date.now() + 60_000).toISOString(), authority });
    const unknown = await scheduler.continue(plan, grant);
    expect(unknown.lifecycle).toBe("unknown"); expect(unknown.items[item.workItemId]).toMatchObject({ lifecycle: "unknown", lastMode: "reconcile" });
    const repeated = await scheduler.continue(plan, grant);
    expect(repeated.lifecycle).toBe("unknown"); expect(calls).toBe(1); expect(world.stateSnapshot().restocks).toHaveLength(3);
  });
});
