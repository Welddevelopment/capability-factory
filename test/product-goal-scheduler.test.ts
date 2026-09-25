import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OutcomeReceipt } from "../src/product/contracts.js";
import type { ValidatedGoalPlan, ValidatedGoalWorkItem } from "../src/product/goal-coordination.js";
import {
  FileGoalCoordinationStore,
  GoalScheduler,
  type GoalAggregateOutcomeReceipt,
  type GoalAggregateOutcomeVerifier,
  type GoalCoordinationState,
  type GoalWorkItemExecutionInput,
  type GoalWorkItemExecutionResult,
  type GoalWorkItemExecutor,
} from "../src/product/goal-scheduler.js";

function item(
  key: string,
  order: number,
  dependencies: string[] = [],
  authorized = true,
): ValidatedGoalWorkItem {
  const workItemId = `work-${key}`;
  const groupId = `group-${key}`;
  return {
    workItemId,
    key,
    groupId,
    groupKey: groupId,
    groupLabel: `Group ${key}`,
    summary: `Complete ${key}.`,
    coverageKeys: [`coverage-${key}`],
    entityAliases: [`entity-${key}`],
    workflowKey: `workflow-${key}`,
    requiredActions: [`read_${key}`, `write_${key}`],
    targetAliases: [`target_${key}`],
    completionCriteria: [{ key: `criterion-${key}`, summary: `Verify ${key}.`, verifierKey: `verifier-${key}` }],
    dependencyWorkItemIds: dependencies,
    executionOrder: order,
    operationKey: `operation-${key}`,
    authority: {
      targetAliases: [`target_${key}`],
      credentialAliases: [`credential_${key}`],
      methods: ["GET", "POST"],
      writeRequired: true,
      currentlyAuthorized: authorized,
      missing: authorized ? [] : ["per-action-approval"],
    },
    correlation: { parentGoalId: "parent-a", workItemId, groupId },
  };
}

function plan(items: ValidatedGoalWorkItem[]): ValidatedGoalPlan {
  return {
    schemaVersion: "1.0",
    tenantId: "tenant-a",
    parentGoalId: "parent-a",
    requestId: "request-a",
    ordinaryGoal: "Complete all required fictional work.",
    deadline: { key: "today", description: "Today." },
    summary: "Validated fictional plan.",
    planVersion: 1,
    validationReceiptId: "validation-a",
    checks: [{ id: "all", passed: true, detail: "Trusted validation passed." }],
    executionMode: "conservative-sequential",
    workItems: items,
  };
}

function outcome(item: ValidatedGoalWorkItem): OutcomeReceipt {
  return {
    verifierVersion: "item-verifier-v1",
    passed: true,
    intendedWrites: 1,
    incorrectSideEffects: 0,
    stateDigest: `state-${item.key}`,
    checks: [{ id: "exact", passed: true, detail: "Exact external state matched." }],
    verifiedAt: new Date().toISOString(),
  };
}

function aggregate(state: GoalCoordinationState): GoalAggregateOutcomeReceipt {
  const values = Object.values(state.items);
  const completedItems = values.filter((entry) => entry.lifecycle === "completed").length;
  const blockedItems = values.filter((entry) => entry.lifecycle === "blocked").length;
  const failedItems = values.filter((entry) => entry.lifecycle === "failed").length;
  const unknownItems = values.filter((entry) => entry.lifecycle === "unknown" || entry.lifecycle === "pending" || entry.lifecycle === "running").length;
  const requiredItems = values.length;
  const result = completedItems === requiredItems
    ? "complete"
    : failedItems > 0
      ? "failed"
      : unknownItems > 0
        ? "unknown"
        : completedItems > 0
          ? "partially-complete"
          : "blocked";
  return {
    verifierVersion: "aggregate-v1",
    receiptId: `aggregate-${state.parentGoalId}-${state.version}`,
    result,
    passed: result === "complete",
    requiredItems,
    completedItems,
    blockedItems,
    failedItems,
    unknownItems,
    incorrectSideEffects: 0,
    stateDigest: `aggregate-state-${state.version}`,
    checks: [{ id: "external", passed: result === "complete", detail: "Independent aggregate inspection." }],
    verifiedAt: new Date().toISOString(),
  };
}

function successfulExecutor(calls: GoalWorkItemExecutionInput[]): GoalWorkItemExecutor {
  return {
    execute: async (input) => {
      calls.push(input);
      return {
        status: "executed",
        path: "existing-ability",
        childRunId: `child-${input.item.key}`,
        operationKey: input.item.operationKey,
        writesAttempted: 1,
        summary: "Synthetic action completed.",
      };
    },
  };
}

function scheduler(
  directory: string,
  executor: GoalWorkItemExecutor,
  aggregateVerifier: GoalAggregateOutcomeVerifier = { verify: async (_plan, state) => aggregate(state) },
) {
  return new GoalScheduler(
    new FileGoalCoordinationStore(directory),
    executor,
    { verify: async (_plan, workItem) => outcome(workItem) },
    aggregateVerifier,
    { resume: async () => ({ completed: true, summary: "Original broad goal resumed." }) },
  );
}

describe("restart-safe broad-goal scheduler", () => {
  it("executes in trusted dependency order, independently verifies, aggregates, and resumes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-goal-scheduler-"));
    try {
      const first = item("first", 1);
      const second = item("second", 2, [first.workItemId]);
      const calls: GoalWorkItemExecutionInput[] = [];
      const result = await scheduler(directory, successfulExecutor(calls)).run(plan([first, second]));
      expect(calls.map((call) => [call.item.key, call.mode])).toEqual([["first", "execute"], ["second", "execute"]]);
      expect(result.lifecycle).toBe("completed");
      expect(result.aggregate).toMatchObject({ result: "complete", passed: true, incorrectSideEffects: 0 });
      expect(result.resume?.completed).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("continues independent work around a zero-write authority block but does not complete the parent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-goal-scheduler-"));
    try {
      const blocked = item("blocked", 1, [], false);
      const independent = item("independent", 2);
      const dependent = item("dependent", 3, [blocked.workItemId]);
      const calls: GoalWorkItemExecutionInput[] = [];
      const result = await scheduler(directory, successfulExecutor(calls)).run(plan([blocked, independent, dependent]));
      expect(calls.map((call) => call.item.key)).toEqual(["independent"]);
      expect(result.items[blocked.workItemId]).toMatchObject({ lifecycle: "blocked", attempts: 0 });
      expect(result.items[independent.workItemId]?.lifecycle).toBe("completed");
      expect(result.items[dependent.workItemId]?.lifecycle).toBe("pending");
      expect(result.lifecycle).toBe("unknown");
      expect(result.resume).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reconciles a running operation after interruption instead of starting a duplicate", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-goal-scheduler-"));
    try {
      const work = item("recover", 1);
      let first = true;
      const modes: string[] = [];
      const executor: GoalWorkItemExecutor = {
        execute: async (input): Promise<GoalWorkItemExecutionResult> => {
          modes.push(input.mode);
          if (first) {
            first = false;
            throw new Error("Simulated process interruption after an uncertain external response.");
          }
          return {
            status: "executed",
            path: "retained-capability",
            childRunId: "child-recovered",
            operationKey: input.item.operationKey,
            writesAttempted: 0,
            summary: "Existing external outcome reconciled without another write.",
          };
        },
      };
      const firstScheduler = scheduler(directory, executor);
      await expect(firstScheduler.run(plan([work]))).rejects.toThrow(/interruption/);
      const restarted = await scheduler(directory, executor).run(plan([work]));
      expect(modes).toEqual(["execute", "reconcile"]);
      expect(restarted.items[work.workItemId]).toMatchObject({ lifecycle: "completed", attempts: 1, lastMode: "reconcile" });
      expect(restarted.lifecycle).toBe("completed");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not execute completed work again on replay", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-goal-scheduler-"));
    try {
      const work = item("once", 1);
      const calls: GoalWorkItemExecutionInput[] = [];
      const instance = scheduler(directory, successfulExecutor(calls));
      await instance.run(plan([work]));
      await instance.run(plan([work]));
      expect(calls).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an aggregate verifier that falsely calls incomplete work complete", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-goal-scheduler-"));
    try {
      const blocked = item("blocked", 1, [], false);
      const falseVerifier: GoalAggregateOutcomeVerifier = {
        verify: async (_plan, state) => ({
          ...aggregate(state),
          result: "complete",
          passed: true,
        }),
      };
      await expect(scheduler(directory, successfulExecutor([]), falseVerifier).run(plan([blocked]))).rejects.toThrow(/inconsistent/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a blocked result that may already have written externally", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-goal-scheduler-"));
    try {
      const work = item("unsafe-block", 1);
      const executor: GoalWorkItemExecutor = {
        execute: async (input) => ({
          status: "blocked",
          childRunId: "child-unsafe",
          operationKey: input.item.operationKey,
          writesAttempted: 1,
          handoff: {
            requestId: input.plan.requestId,
            tenantId: input.plan.tenantId,
            reason: "execution-failed",
            summary: "The external state is not known.",
            failedChecks: [],
            createdAt: new Date().toISOString(),
          },
        }),
      };
      await expect(scheduler(directory, executor).run(plan([work]))).rejects.toThrow(/cannot report external write attempts/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
