import "dotenv/config";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BudgetTracker } from "../budget.js";
import { requireApiKey } from "../config.js";
import { OpenAIModelGateway } from "../model-gateway.js";
import { GoalPlanCompiler } from "../product/goal-coordination.js";
import { FileGoalCoordinationStore, GoalScheduler } from "../product/goal-scheduler.js";
import { OpenAIStructuredGoalPlanner } from "../product/openai-goal-planner.js";
import { TraceWriter } from "../trace.js";
import { startBroadGoalCapabilityLayer } from "./broad-goal-capability-layer.js";
import { BroadGoalReferenceWorld, createBroadGoalTrustedScope } from "./broad-goal-reference-world.js";

const PROTOCOL = "broad-goal-confirmation-v1";
const cases = [
  {
    id: "confirmation-build",
    ordinaryGoal: "By the fictional 21:00 cutoff, make every due order operationally ready. Resolve each trusted stock shortage exactly once through its assigned supplier, preserve approval boundaries, and finish dependent order work only after the prerequisite is verified.",
    expectedCapabilityPath: "built-capability",
    expectedBuilderCalls: 1,
  },
  {
    id: "confirmation-fresh-reuse",
    ordinaryGoal: "Prepare all fictional orders due at 9pm today: complete anything missing, safely replenish every item they require, avoid duplicate purchases, and do not mark dependent work complete before checking the real result.",
    expectedCapabilityPath: "retained-capability",
    expectedBuilderCalls: 0,
  },
] as const;

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function artifactDirectory(): string {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  return path.resolve("artifacts", `broad-goal-model-confirmation-${timestamp}`);
}

async function main(): Promise<void> {
  if (process.env.CF_BROAD_GOAL_CONFIRM_ACK !== PROTOCOL) {
    throw new Error(`Set CF_BROAD_GOAL_CONFIRM_ACK=${PROTOCOL} to authorize this bounded paid confirmation.`);
  }
  const startingCommit = git("rev-parse", "HEAD");
  const startingStatus = git("status", "--porcelain", "--untracked-files=no");
  if (startingStatus !== "") throw new Error("Refusing to freeze a dirty tracked worktree.");

  const directory = artifactDirectory();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const budget = new BudgetTracker(path.join(directory, "budget.json"), {
    warnUsd: 0.5,
    maxUsd: 1,
    maxRunUsd: 1,
  });
  const apiKey = requireApiKey();
  const registryDirectory = path.join(directory, "capability-registry");
  const freeze = {
    protocol: PROTOCOL,
    frozenAt: new Date().toISOString(),
    gitCommit: startingCommit,
    worktreeClean: true,
    modelPlanningAttemptsPerCase: 1,
    maximumCampaignSpendUsd: 1,
    cases: cases.map(({ id, ordinaryGoal, expectedCapabilityPath, expectedBuilderCalls }) => ({
      id,
      ordinaryGoal,
      expectedCapabilityPath,
      expectedBuilderCalls,
    })),
    successRule: "Both unseen phrasings pass trusted plan validation on the first model proposal, complete all seven verified jobs, produce zero incorrect side effects, resume the parent goal, build once, and then reuse from a fresh coordinator/world.",
  };
  fs.writeFileSync(path.join(directory, "campaign-freeze.json"), `${JSON.stringify(freeze, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  const results: Array<Record<string, unknown>> = [];
  for (const [index, testCase] of cases.entries()) {
    const caseDirectory = path.join(directory, testCase.id);
    fs.mkdirSync(caseDirectory, { recursive: true, mode: 0o700 });
    const gateway = new OpenAIModelGateway(
      apiKey,
      budget,
      new TraceWriter(testCase.id, path.join(caseDirectory, "trace")),
    );
    const result: Record<string, unknown> = {
      id: testCase.id,
      ordinaryGoal: testCase.ordinaryGoal,
      startedAt: new Date().toISOString(),
    };
    try {
      const scope = createBroadGoalTrustedScope(
        `confirmation-parent-${index + 1}`,
        `confirmation-request-${index + 1}`,
        "complete-authority",
        testCase.ordinaryGoal,
      );
      const compiled = await new GoalPlanCompiler(new OpenAIStructuredGoalPlanner(gateway), 1).compile(scope);
      result.planning = compiled.status === "validated"
        ? {
            status: compiled.status,
            attempts: compiled.attempts,
            validationReceiptId: compiled.plan.validationReceiptId,
            checksPassed: compiled.plan.checks.filter((check) => check.passed).length,
            workItems: compiled.plan.workItems.map((item) => ({
              key: item.key,
              coverageKeys: item.coverageKeys,
              workflowKey: item.workflowKey,
              dependencyWorkItemIds: item.dependencyWorkItemIds,
              executionOrder: item.executionOrder,
              currentlyAuthorized: item.authority.currentlyAuthorized,
            })),
          }
        : {
            status: compiled.status,
            attempts: compiled.attempts,
            failedChecks: compiled.checks.filter((check) => !check.passed),
          };
      if (compiled.status !== "validated") throw new Error("The frozen first proposal did not pass trusted plan validation.");

      const world = new BroadGoalReferenceWorld(path.join(caseDirectory, "world.sqlite"));
      const layer = await startBroadGoalCapabilityLayer(world, registryDirectory);
      try {
        const state = await new GoalScheduler(
          new FileGoalCoordinationStore(path.join(caseDirectory, "coordination")),
          layer.executor,
          world,
          world,
          world,
        ).run(compiled.plan);
        const capabilityItem = compiled.plan.workItems.find((item) => item.coverageKeys.includes("coverage-crates"));
        const capabilityExecution = capabilityItem ? state.items[capabilityItem.workItemId]?.execution : undefined;
        const capabilityPath = capabilityExecution && "path" in capabilityExecution ? capabilityExecution.path : null;
        const passed = state.lifecycle === "completed"
          && state.resume?.completed === true
          && state.aggregate?.passed === true
          && state.aggregate.incorrectSideEffects === 0
          && capabilityPath === testCase.expectedCapabilityPath
          && layer.builder.calls === testCase.expectedBuilderCalls;
        result.execution = {
          lifecycle: state.lifecycle,
          aggregate: state.aggregate,
          resume: state.resume,
          capabilityPath,
          builderCalls: layer.builder.calls,
          capabilityEventTypes: layer.events.map((event) => event.type),
        };
        result.passed = passed;
      } finally {
        await layer.close();
        world.close();
      }
    } catch (error) {
      result.passed = false;
      result.error = error instanceof Error ? { name: error.name, message: error.message } : String(error);
    } finally {
      result.modelCalls = gateway.callCount();
      result.spentUsd = gateway.spentUsd();
      result.completedAt = new Date().toISOString();
      results.push(result);
      fs.writeFileSync(path.join(directory, `${testCase.id}.json`), `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    }
  }

  const endingCommit = git("rev-parse", "HEAD");
  const endingStatus = git("status", "--porcelain", "--untracked-files=no");
  const sourceUnchanged = endingCommit === startingCommit && endingStatus === "";
  const passed = sourceUnchanged
    && results.length === cases.length
    && results.every((result) => result.passed === true && result.modelCalls === 1);
  const summary = {
    protocol: PROTOCOL,
    passed,
    gitCommit: startingCommit,
    sourceUnchanged,
    casesPassed: results.filter((result) => result.passed === true).length,
    casesAttempted: results.length,
    modelCalls: results.reduce((sum, result) => sum + Number(result.modelCalls ?? 0), 0),
    spentUsd: results.reduce((sum, result) => sum + Number(result.spentUsd ?? 0), 0),
    results,
  };
  fs.writeFileSync(path.join(directory, "result.json"), `${JSON.stringify(summary, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({ directory, ...summary, results: results.map((result) => ({ id: result.id, passed: result.passed, modelCalls: result.modelCalls, spentUsd: result.spentUsd })) }, null, 2));
  if (!passed) process.exitCode = 1;
}

await main();
