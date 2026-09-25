import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { startBroadGoalCapabilityLayer } from "./broad-goal-capability-layer.js";
import {
  BroadGoalReferenceWorld,
  createBroadGoalPlanProposal,
  createBroadGoalTrustedScope,
} from "./broad-goal-reference-world.js";
import { BroadGoalCoordinatorSdk, FileValidatedGoalPlanStore } from "../product/broad-goal-sdk.js";
import type { GoalPlanner } from "../product/goal-coordination.js";
import { FileGoalCoordinationStore, GoalScheduler } from "../product/goal-scheduler.js";
import { createCapabilitySidecar } from "../product/sidecar.js";
import { SidecarGoalJobService, SidecarGoalJobStore } from "../product/sidecar-jobs.js";

const SCOPE_KEY = "fictional-order-operations-2100-v1";

function requiredToken(): string {
  const token = process.env.CF_SIDECAR_TOKEN?.trim();
  if (!token || token.length < 16) {
    throw new Error("Set CF_SIDECAR_TOKEN to a private value containing at least 16 characters.");
  }
  return token;
}

function port(): number {
  const value = Number(process.env.CF_SIDECAR_PORT ?? 4321);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error("CF_SIDECAR_PORT must be a valid port.");
  return value;
}

async function main(): Promise<void> {
  const root = path.resolve(process.env.CF_SIDECAR_DATA ?? "artifacts/sidecar-reference");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const planner: GoalPlanner = { propose: async () => createBroadGoalPlanProposal() };
  const coordinator = new BroadGoalCoordinatorSdk({
    planner,
    maxPlanningAttempts: 1,
    plans: new FileValidatedGoalPlanStore(path.join(root, "plans")),
    scopes: {
      resolve: async (request) => request.scopeKey === SCOPE_KEY && request.tenantId === "local-alpha"
        ? createBroadGoalTrustedScope(
            request.parentGoalId,
            request.requestId,
            process.env.CF_REFERENCE_COMPLETE_AUTHORITY === "1" ? "complete-authority" : "partial-authority",
            request.ordinaryGoal,
          )
        : undefined,
    },
    runtimes: {
      open: async (scope) => {
        const runDirectory = path.join(root, "runs", scope.parentGoalId);
        const world = new BroadGoalReferenceWorld(path.join(runDirectory, "world.sqlite"));
        const capabilityLayer = await startBroadGoalCapabilityLayer(world, path.join(root, "capability-registry"));
        return {
          runner: new GoalScheduler(
            new FileGoalCoordinationStore(path.join(runDirectory, "coordination")),
            capabilityLayer.executor,
            world,
            world,
            world,
          ),
          close: async () => {
            await capabilityLayer.close();
            world.close();
          },
        };
      },
    },
  });
  const jobs = new SidecarGoalJobService(
    new SidecarGoalJobStore(path.join(root, "sidecar-jobs.sqlite")),
    coordinator,
  );
  const app = createCapabilitySidecar(undefined, { resolve: () => undefined }, {
    accessToken: requiredToken(),
    broadGoals: coordinator,
    goalJobs: jobs,
  });
  const address = await app.listen({ host: "127.0.0.1", port: port() });
  console.log(`Capability Factory reference sidecar: ${address}`);
  console.log(`Trusted scope key: ${SCOPE_KEY}`);
  console.log(process.env.CF_REFERENCE_COMPLETE_AUTHORITY === "1"
    ? "Reference authority: complete fictional write authority"
    : "Reference authority: one fictional supplier action intentionally requires approval");

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await app.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

await main();
