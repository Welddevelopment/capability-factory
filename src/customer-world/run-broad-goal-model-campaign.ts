import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { BudgetTracker } from "../budget.js";
import { requireApiKey } from "../config.js";
import { OpenAIModelGateway } from "../model-gateway.js";
import { OpenAIStructuredGoalPlanner } from "../product/openai-goal-planner.js";
import { GoalPlanCompiler } from "../product/goal-coordination.js";
import { FileGoalCoordinationStore, GoalScheduler } from "../product/goal-scheduler.js";
import { TraceWriter } from "../trace.js";
import { startBroadGoalCapabilityLayer } from "./broad-goal-capability-layer.js";
import {
  BroadGoalReferenceWorld,
  createBroadGoalTrustedScope,
} from "./broad-goal-reference-world.js";

const cases = [
  {
    id: "broad-goal-direct",
    ordinaryGoal: "Complete every fictional order due by 21:00 today, fill any missing delivery details, and place exactly one safe restock for every required item that is short.",
  },
  {
    id: "broad-goal-paraphrase",
    ordinaryGoal: "Before tonight's 9pm cutoff, make all due fictional orders ready and restock everything those orders need when current stock is insufficient.",
  },
  {
    id: "broad-goal-supplier-emphasis",
    ordinaryGoal: "Get all fictional orders due tonight ready without making duplicate purchases: complete their details, handle each supplier's stock shortage, and only finalize dependent orders after the required restock is verified.",
  },
] as const;

function campaignDirectory(): string {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  return path.resolve("artifacts", `broad-goal-model-development-${timestamp}`);
}

async function main() {
  const directory = campaignDirectory();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const budget = new BudgetTracker(path.join(directory, "budget.json"), {
    warnUsd: 3,
    maxUsd: 7,
    maxRunUsd: 3,
  });
  const apiKey = requireApiKey();
  const registryDirectory = path.join(directory, "capability-registry");
  const report: {
    campaignVersion: string;
    startedAt: string;
    completedAt?: string;
    limits: { globalUsd: number; perPlannerUsd: number; maximumPlanningAttempts: number };
    cases: Array<Record<string, unknown>>;
    total: { calls: number; spentUsd: number; passed: number; attempted: number };
  } = {
    campaignVersion: "broad-goal-model-development-v1",
    startedAt: new Date().toISOString(),
    limits: { globalUsd: 7, perPlannerUsd: 3, maximumPlanningAttempts: 2 },
    cases: [],
    total: { calls: 0, spentUsd: 0, passed: 0, attempted: 0 },
  };

  for (const [index, testCase] of cases.entries()) {
    const caseDirectory = path.join(directory, testCase.id);
    fs.mkdirSync(caseDirectory, { recursive: true, mode: 0o700 });
    const gateway = new OpenAIModelGateway(
      apiKey,
      budget,
      new TraceWriter(testCase.id, path.join(caseDirectory, "trace")),
    );
    const planner = new OpenAIStructuredGoalPlanner(gateway);
    const scope = createBroadGoalTrustedScope(
      `model-parent-${index + 1}`,
      `model-request-${index + 1}`,
      "complete-authority",
      testCase.ordinaryGoal,
    );
    const caseReport: Record<string, unknown> = {
      id: testCase.id,
      ordinaryGoal: testCase.ordinaryGoal,
      startedAt: new Date().toISOString(),
    };
    report.total.attempted += 1;
    try {
      const compiled = await new GoalPlanCompiler(planner, 2).compile(scope);
      caseReport.planning = compiled.status === "validated"
        ? {
            status: compiled.status,
            attempts: compiled.attempts,
            validationReceiptId: compiled.plan.validationReceiptId,
            checksPassed: compiled.plan.checks.filter((check) => check.passed).length,
            items: compiled.plan.workItems.map((item) => ({
              key: item.key,
              groupKey: item.groupKey,
              groupLabel: item.groupLabel,
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
      if (compiled.status !== "validated") {
        caseReport.passed = false;
        continue;
      }

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
        const east = compiled.plan.workItems.find((item) => item.coverageKeys.includes("coverage-crates"));
        const eastExecution = east ? state.items[east.workItemId]?.execution : undefined;
        const passed = state.lifecycle === "completed" &&
          state.resume?.completed === true &&
          state.aggregate?.passed === true &&
          state.aggregate.incorrectSideEffects === 0;
        caseReport.execution = {
          lifecycle: state.lifecycle,
          aggregate: state.aggregate,
          resume: state.resume,
          eastCapabilityPath: eastExecution && "path" in eastExecution ? eastExecution.path : null,
          builderCalls: layer.builder.calls,
          capabilityEventTypes: layer.events.map((event) => event.type),
          externalStateDigest: state.aggregate?.stateDigest,
        };
        caseReport.passed = passed;
        if (passed) report.total.passed += 1;
      } finally {
        await layer.close();
        world.close();
      }
    } catch (error) {
      caseReport.passed = false;
      caseReport.error = error instanceof Error ? error.message : String(error);
    } finally {
      caseReport.modelCalls = gateway.callCount();
      caseReport.spentUsd = gateway.spentUsd();
      caseReport.completedAt = new Date().toISOString();
      report.total.calls += gateway.callCount();
      report.total.spentUsd += gateway.spentUsd();
      report.cases.push(caseReport);
      fs.writeFileSync(path.join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    }
  }
  report.completedAt = new Date().toISOString();
  fs.writeFileSync(path.join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({ directory, total: report.total, cases: report.cases.map((entry) => ({ id: entry.id, passed: entry.passed, modelCalls: entry.modelCalls, spentUsd: entry.spentUsd, error: entry.error })) }, null, 2));
}

await main();
