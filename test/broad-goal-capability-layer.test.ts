import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startBroadGoalCapabilityLayer } from "../src/customer-world/broad-goal-capability-layer.js";
import {
  BroadGoalReferenceWorld,
  createBroadGoalPlanProposal,
  createBroadGoalTrustedScope,
} from "../src/customer-world/broad-goal-reference-world.js";
import { GoalPlanCompiler, type GoalPlanner } from "../src/product/goal-coordination.js";
import {
  FileGoalCoordinationStore,
  GoalScheduler,
  type GoalWorkItemExecutor,
} from "../src/product/goal-scheduler.js";

async function compile(parentGoalId: string, requestId: string) {
  const planner: GoalPlanner = { propose: async () => createBroadGoalPlanProposal() };
  const result = await new GoalPlanCompiler(planner, 1).compile(
    createBroadGoalTrustedScope(parentGoalId, requestId, "complete-authority"),
  );
  if (result.status !== "validated") throw new Error("Reference broad-goal plan did not validate.");
  return result.plan;
}

describe("broad-goal work item routed through the real capability core", () => {
  it("builds, probes, executes, verifies and retains once, then reuses in a fresh broad goal", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-broad-capability-"));
    const registry = join(directory, "registry");
    const firstWorld = new BroadGoalReferenceWorld(join(directory, "first-world.sqlite"));
    const firstLayer = await startBroadGoalCapabilityLayer(firstWorld, registry);
    try {
      const firstPlan = await compile("parent-capability-build", "request-capability-build");
      const first = await new GoalScheduler(
        new FileGoalCoordinationStore(join(directory, "first-coordination")),
        firstLayer.executor,
        firstWorld,
        firstWorld,
        firstWorld,
      ).run(firstPlan);
      const east = firstPlan.workItems.find((item) => item.key === "east-crates")!;
      expect(first.items[east.workItemId]?.execution).toMatchObject({
        status: "executed",
        path: "built-capability",
        writesAttempted: 1,
      });
      expect(firstLayer.builder.calls).toBe(1);
      expect(firstLayer.events.map((event) => event.type)).toEqual(expect.arrayContaining([
        "acquisition.requested",
        "capability.built",
        "capability.verified",
        "capability.executed",
        "outcome.verified",
        "goal.resumed",
      ]));
      expect(firstLayer.events.every((event) => event.correlation?.workItemId === east.workItemId)).toBe(true);
      expect(first.aggregate).toMatchObject({ result: "complete", passed: true, incorrectSideEffects: 0 });
      const eastRows = (firstWorld.stateSnapshot().restocks as Array<{ sku: string }>).filter(
        (row) => row.sku === "sku_insulated_crate",
      );
      expect(eastRows).toHaveLength(1);
    } finally {
      await firstLayer.close();
      firstWorld.close();
    }

    const secondWorld = new BroadGoalReferenceWorld(join(directory, "second-world.sqlite"));
    const secondLayer = await startBroadGoalCapabilityLayer(secondWorld, registry);
    try {
      const secondPlan = await compile("parent-capability-reuse", "request-capability-reuse");
      const second = await new GoalScheduler(
        new FileGoalCoordinationStore(join(directory, "second-coordination")),
        secondLayer.executor,
        secondWorld,
        secondWorld,
        secondWorld,
      ).run(secondPlan);
      const east = secondPlan.workItems.find((item) => item.key === "east-crates")!;
      expect(second.items[east.workItemId]?.execution).toMatchObject({
        status: "executed",
        path: "retained-capability",
        writesAttempted: 1,
      });
      expect(secondLayer.builder.calls).toBe(0);
      expect(secondLayer.events.map((event) => event.type)).toContain("capability.reused");
      expect(secondLayer.events.map((event) => event.type)).not.toContain("capability.built");
      expect(second.aggregate).toMatchObject({ result: "complete", passed: true, incorrectSideEffects: 0 });
      const eastRows = (secondWorld.stateSnapshot().restocks as Array<{ sku: string }>).filter(
        (row) => row.sku === "sku_insulated_crate",
      );
      expect(eastRows).toHaveLength(1);
    } finally {
      await secondLayer.close();
      secondWorld.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reconciles an interrupted capability-backed child without another supplier write", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-broad-capability-restart-"));
    const world = new BroadGoalReferenceWorld(join(directory, "world.sqlite"));
    const layer = await startBroadGoalCapabilityLayer(world, join(directory, "registry"));
    const plan = await compile("parent-capability-restart", "request-capability-restart");
    const store = new FileGoalCoordinationStore(join(directory, "coordination"));
    let interrupted = false;
    const interruptingExecutor: GoalWorkItemExecutor = {
      execute: async (input) => {
        const result = await layer.executor.execute(input);
        if (input.item.key === "east-crates" && !interrupted) {
          interrupted = true;
          throw new Error("Simulated coordinator loss after the capability-backed external outcome completed.");
        }
        return result;
      },
    };
    try {
      await expect(new GoalScheduler(store, interruptingExecutor, world, world, world).run(plan)).rejects.toThrow(/coordinator loss/);
      const restarted = await new GoalScheduler(store, layer.executor, world, world, world).run(plan);
      const east = plan.workItems.find((item) => item.key === "east-crates")!;
      expect(restarted.items[east.workItemId]).toMatchObject({
        lifecycle: "completed",
        lastMode: "reconcile",
        execution: { path: "retained-capability" },
      });
      expect(layer.builder.calls).toBe(1);
      expect(layer.events.map((event) => event.type)).toContain("capability.reused");
      const eastRows = (world.stateSnapshot().restocks as Array<{ sku: string }>).filter(
        (row) => row.sku === "sku_insulated_crate",
      );
      expect(eastRows).toHaveLength(1);
      expect(restarted.aggregate).toMatchObject({ result: "complete", incorrectSideEffects: 0 });
    } finally {
      await layer.close();
      world.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
