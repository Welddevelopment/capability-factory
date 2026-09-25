import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BroadGoalReferenceWorld,
  createBroadGoalPlanProposal,
  createBroadGoalTrustedScope,
} from "../src/customer-world/broad-goal-reference-world.js";
import { GoalPlanCompiler, type GoalPlanner } from "../src/product/goal-coordination.js";
import {
  FileGoalCoordinationStore,
  GoalScheduler,
  type GoalWorkItemExecutionInput,
  type GoalWorkItemExecutor,
} from "../src/product/goal-scheduler.js";

async function compile(scenario: "partial-authority" | "complete-authority", parentGoalId = `parent-${scenario}`) {
  const planner: GoalPlanner = { propose: async () => createBroadGoalPlanProposal() };
  const result = await new GoalPlanCompiler(planner, 1).compile(
    createBroadGoalTrustedScope(parentGoalId, `request-${scenario}`, scenario),
  );
  if (result.status !== "validated") throw new Error("Reference plan did not pass trusted validation.");
  return result.plan;
}

function scheduler(directory: string, world: BroadGoalReferenceWorld, executor: GoalWorkItemExecutor = world) {
  return new GoalScheduler(
    new FileGoalCoordinationStore(join(directory, "coordination")),
    executor,
    world,
    world,
    world,
  );
}

describe("independently verified broad-goal reference world", () => {
  it("completes independent work and its dependent branch while one authority-gated item stops with zero writes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-broad-goal-"));
    const world = new BroadGoalReferenceWorld(join(directory, "world.sqlite"));
    try {
      const plan = await compile("partial-authority");
      const result = await scheduler(directory, world).run(plan);
      expect(result.lifecycle).toBe("partially-complete");
      expect(result.aggregate).toMatchObject({
        result: "partially-complete",
        passed: false,
        completedItems: 6,
        blockedItems: 1,
        failedItems: 0,
        incorrectSideEffects: 0,
      });
      const regulated = plan.workItems.find((item) => item.key === "regulated-sensors")!;
      const finalization = plan.workItems.find((item) => item.key === "order-1051-rollup")!;
      expect(result.items[regulated.workItemId]).toMatchObject({ lifecycle: "blocked", attempts: 0 });
      expect(result.items[finalization.workItemId]?.lifecycle).toBe("completed");
      const snapshot = world.stateSnapshot();
      expect(snapshot.restocks).toHaveLength(3);
      expect((snapshot.restocks as Array<{ sku: string }>).some((row) => row.sku === "sku_calibrated_sensor")).toBe(false);
      expect(result.resume).toBeUndefined();
    } finally {
      world.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("completes and resumes the broad goal only after all seven external outcomes pass", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-broad-goal-"));
    const world = new BroadGoalReferenceWorld(join(directory, "world.sqlite"));
    try {
      const plan = await compile("complete-authority");
      expect(plan.workItems.map((item) => item.key)).toEqual([
        "order-1042-ready",
        "order-1048-details",
        "north-coolant",
        "north-labels",
        "east-crates",
        "regulated-sensors",
        "order-1051-rollup",
      ]);
      const result = await scheduler(directory, world).run(plan);
      expect(result.lifecycle).toBe("completed");
      expect(result.aggregate).toMatchObject({
        result: "complete",
        passed: true,
        completedItems: 7,
        blockedItems: 0,
        incorrectSideEffects: 0,
      });
      expect(result.resume?.completed).toBe(true);
      const pathByKey = Object.fromEntries(plan.workItems.map((item) => {
        const execution = result.items[item.workItemId]?.execution;
        return [item.key, execution && "path" in execution ? execution.path : undefined];
      }));
      expect(pathByKey).toMatchObject({
        "order-1042-ready": "already-satisfied",
        "order-1048-details": "existing-ability",
        "north-coolant": "existing-ability",
        "north-labels": "existing-ability",
        "east-crates": "existing-ability",
        "regulated-sensors": "existing-ability",
        "order-1051-rollup": "existing-ability",
      });
      expect(world.stateSnapshot().restocks).toHaveLength(4);
    } finally {
      world.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("survives a lost response by reconciling the persisted external operation without a duplicate", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-broad-goal-"));
    const databasePath = join(directory, "world.sqlite");
    const firstWorld = new BroadGoalReferenceWorld(databasePath);
    const plan = await compile("complete-authority", "parent-restart");
    let interrupted = false;
    const modes: Array<[string, string]> = [];
    const interruptingExecutor: GoalWorkItemExecutor = {
      execute: async (input: GoalWorkItemExecutionInput) => {
        modes.push([input.item.key, input.mode]);
        const receipt = await firstWorld.execute(input);
        if (input.item.key === "east-crates" && !interrupted) {
          interrupted = true;
          throw new Error("Simulated process loss after the external commit but before scheduler receipt persistence.");
        }
        return receipt;
      },
    };
    try {
      await expect(scheduler(directory, firstWorld, interruptingExecutor).run(plan)).rejects.toThrow(/process loss/);
    } finally {
      firstWorld.close();
    }

    const restartedWorld = new BroadGoalReferenceWorld(databasePath);
    try {
      const restartedExecutor: GoalWorkItemExecutor = {
        execute: async (input) => {
          modes.push([input.item.key, input.mode]);
          return restartedWorld.execute(input);
        },
      };
      const result = await scheduler(directory, restartedWorld, restartedExecutor).run(plan);
      expect(modes).toContainEqual(["east-crates", "execute"]);
      expect(modes).toContainEqual(["east-crates", "reconcile"]);
      expect(result.lifecycle).toBe("completed");
      const crateRows = (restartedWorld.stateSnapshot().restocks as Array<{ sku: string }>).filter(
        (row) => row.sku === "sku_insulated_crate",
      );
      expect(crateRows).toHaveLength(1);
      expect(result.aggregate?.incorrectSideEffects).toBe(0);
    } finally {
      restartedWorld.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses completion when direct inspection finds an extra side effect", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-broad-goal-"));
    const world = new BroadGoalReferenceWorld(join(directory, "world.sqlite"));
    const plan = await compile("complete-authority", "parent-side-effect");
    const corruptingExecutor: GoalWorkItemExecutor = {
      execute: async (input) => {
        const receipt = await world.execute(input);
        if (input.item.key === "north-coolant" && receipt.status === "executed") {
          world.database.prepare(
            "INSERT INTO restocks (sku, supplier, quantity, operation_key) VALUES (?, ?, ?, ?)",
          ).run("sku_coolant_pack", "supplier_north", 5, "unexpected-duplicate-operation");
        }
        return receipt;
      },
    };
    try {
      const result = await scheduler(directory, world, corruptingExecutor).run(plan);
      expect(result.lifecycle).toBe("failed");
      expect(result.aggregate).toMatchObject({ result: "failed", passed: false });
      expect(result.aggregate!.incorrectSideEffects).toBeGreaterThan(0);
      expect(result.resume).toBeUndefined();
    } finally {
      world.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("routes by trusted coverage rather than planner-selected work-item names", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-broad-goal-renamed-"));
    const world = new BroadGoalReferenceWorld(join(directory, "world.sqlite"));
    try {
      const renamed = createBroadGoalPlanProposal();
      const keyMap = new Map(renamed.workItems.map((item, index) => [item.key, `proposed-job-${index + 1}`]));
      renamed.workItems = renamed.workItems.map((item) => ({
        ...item,
        key: keyMap.get(item.key)!,
        dependsOnKeys: item.dependsOnKeys.map((key) => keyMap.get(key)!),
      }));
      const planner: GoalPlanner = { propose: async () => renamed };
      const compiled = await new GoalPlanCompiler(planner, 1).compile(
        createBroadGoalTrustedScope("parent-renamed", "request-renamed", "complete-authority"),
      );
      if (compiled.status !== "validated") throw new Error("Renamed trusted plan did not validate.");
      const result = await scheduler(directory, world).run(compiled.plan);
      expect(result.lifecycle).toBe("completed");
      expect(result.aggregate).toMatchObject({ result: "complete", completedItems: 7, incorrectSideEffects: 0 });
    } finally {
      world.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
