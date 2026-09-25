import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { FileValidatedGoalPlanStore } from "../product/broad-goal-sdk.js";
import { createControlledPilotSdk } from "../product/pilot-adapter.js";
import { createCapabilitySidecar } from "../product/sidecar.js";
import { SidecarGoalJobService, SidecarGoalJobStore } from "../product/sidecar-jobs.js";
import { HmacGoalContinuationAuthority } from "../product/continuation.js";
import { CustomerLocalOperationalControl } from "../product/operations.js";
import {
  REAL_ERPNEXT_PILOT_SCOPE_KEY,
  createRealErpNextBroadGoalPilotAdapter,
  realErpNextBroadGoalPlanner,
} from "./real-erpnext-broad-goal-pilot-adapter.js";
import { startRealErpNextProcurementWorld } from "./real-erpnext-procurement-world.js";

function requiredToken(): string {
  const token = process.env.CF_SIDECAR_TOKEN?.trim();
  if (!token || token.length < 16) throw new Error("Set CF_SIDECAR_TOKEN to a private value containing at least 16 characters.");
  return token;
}

function port(): number {
  const parsed = Number(process.env.CF_SIDECAR_PORT ?? 4321);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error("CF_SIDECAR_PORT must be a valid port.");
  return parsed;
}

function continuationAuthority(): HmacGoalContinuationAuthority {
  const secret = process.env.CF_CONTINUATION_AUTHORITY_SECRET?.trim();
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error("Set CF_CONTINUATION_AUTHORITY_SECRET to a separate customer-local value containing at least 32 bytes.");
  }
  return new HmacGoalContinuationAuthority(
    process.env.CF_CONTINUATION_AUTHORITY_KEY_ID?.trim() || "local-pilot-continuation-v1",
    secret,
  );
}

async function main(): Promise<void> {
  const root = path.resolve(process.env.CF_SIDECAR_DATA ?? "artifacts/real-erpnext-pilot-sidecar");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const continuation = continuationAuthority();
  const operations = new CustomerLocalOperationalControl(
    path.join(root, "operations.sqlite"),
    "local-erpnext-pilot",
    { maxWriteAttemptsPerRun: 20, maxWriteAttemptsPerHour: 200, maxModelSpendUsdPerDay: 5 },
  );
  const world = await startRealErpNextProcurementWorld({ repositoryRoot: process.cwd() });
  if (process.env.CF_ERPNEXT_PILOT_RESET === "1") world.resetBroadGoal();
  const adapter = createRealErpNextBroadGoalPilotAdapter({
    world,
    dataDirectory: root,
    operationGuard: operations,
    continuationAuthority: continuation,
  });
  const coordinator = await createControlledPilotSdk(adapter, {
    planner: realErpNextBroadGoalPlanner,
    plans: new FileValidatedGoalPlanStore(path.join(root, "plans")),
    maxPlanningAttempts: 1,
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
  console.log(`Capability Factory ERPNext pilot sidecar: ${address}`);
  console.log(`Trusted scope key: ${REAL_ERPNEXT_PILOT_SCOPE_KEY}`);
  console.log("Environment: genuine disposable local ERPNext; fictional data only");

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    await world.close();
    operations.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

await main();
