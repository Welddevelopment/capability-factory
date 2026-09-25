import "dotenv/config";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BudgetTracker } from "../budget.js";
import { OpenAIModelGateway } from "../model-gateway.js";
import { TraceWriter } from "../trace.js";
import { StructuredManifestBuilder } from "../product/builder.js";
import { OpenAIStructuredManifestDraftGateway } from "../product/openai-draft-gateway.js";
import { createConsoleApp } from "../../apps/console/server/app.js";
import { FileValidatedGoalPlanStore } from "../product/broad-goal-sdk.js";
import { CapabilityFactorySidecarClient } from "../product/client.js";
import { createControlledPilotSdk } from "../product/pilot-adapter.js";
import { createCapabilitySidecar } from "../product/sidecar.js";
import { SidecarGoalJobService, SidecarGoalJobStore } from "../product/sidecar-jobs.js";
import { HmacGoalContinuationAuthority } from "../product/continuation.js";
import { CustomerLocalOperationalControl } from "../product/operations.js";
import {
  REAL_ERPNEXT_PILOT_GOAL,
  REAL_ERPNEXT_PILOT_SCOPE_KEY,
  createRealErpNextBroadGoalPilotAdapter,
  type PilotCapabilityConstruction,
  realErpNextBroadGoalPlanner,
} from "./real-erpnext-broad-goal-pilot-adapter.js";
import {
  REAL_ERPNEXT_BROAD_GOAL_REQUEST_IDS,
  startRealErpNextProcurementWorld,
} from "./real-erpnext-procurement-world.js";

function port(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} must be a valid port.`);
  return value;
}

function token(): string {
  const value = process.env.CF_SIDECAR_TOKEN?.trim();
  if (!value || value.length < 16) throw new Error("Set CF_SIDECAR_TOKEN to a private value containing at least 16 characters.");
  return value;
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

type DemoMode = "reference" | "genuine";

function demoMode(): DemoMode {
  const value = (process.env.CF_DEMO_MODE ?? "reference").trim().toLowerCase();
  if (value !== "reference" && value !== "genuine") {
    throw new Error(`CF_DEMO_MODE must be "reference" or "genuine", not "${value}".`);
  }
  return value;
}

/**
 * PROP-0007: genuine mode refuses to start with a named reason rather than
 * failing halfway through in front of an audience. The key-validity probe is
 * a free request (no tokens are billed for listing models); funding cannot be
 * verified without a paid call, so it is stated, not checked.
 */
async function genuinePreflight(): Promise<string> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error("genuine mode refused to start: OPENAI_API_KEY is missing from the environment (.env). No model call was made.");
  }
  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
  } catch (error) {
    throw new Error(`genuine mode refused to start: the OpenAI API could not be reached (${(error as Error).message}). No model call was made.`);
  }
  if (response.status === 401) {
    throw new Error("genuine mode refused to start: the OpenAI key was rejected as invalid (HTTP 401). No model call was made.");
  }
  if (response.status === 403) {
    // A restricted project key without api.model.read cannot list models but may
    // still be allowed to make the responses calls the demo actually uses
    // (openai.responses.create). That cannot be verified without a paid call.
    const body = await response.text();
    if (body.includes("api.model.read")) {
      console.log("genuine preflight: OPENAI_API_KEY present; it is a restricted project key without model-list permission, so validity for responses calls could NOT be verified without a paid call. If the key lacks responses permission the first run will fail visibly.");
      return key;
    }
    throw new Error(`genuine mode refused to start: the OpenAI key was refused (HTTP 403: ${body.slice(0, 200)}). No model call was made.`);
  }
  if (!response.ok) {
    throw new Error(`genuine mode refused to start: the OpenAI key was rejected (HTTP ${response.status}). No model call was made.`);
  }
  console.log("genuine preflight: OPENAI_API_KEY present and accepted (models list, free request). Funding is NOT verified by this check.");
  return key;
}

async function main(): Promise<void> {
  const root = path.resolve(process.env.CF_PILOT_DATA ?? "artifacts/pilot-runs/local-reference");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const sidecarPort = port("CF_SIDECAR_PORT", 4321);
  const consolePort = port("CF_CONSOLE_PORT", 4317);
  const accessToken = token();
  const continuation = continuationAuthority();
  const operations = new CustomerLocalOperationalControl(
    path.join(root, "operations.sqlite"),
    "local-erpnext-pilot",
    { maxWriteAttemptsPerRun: 20, maxWriteAttemptsPerHour: 200, maxModelSpendUsdPerDay: 5 },
  );
  const mode = demoMode();
  const apiKey = mode === "genuine" ? await genuinePreflight() : undefined;
  const world = await startRealErpNextProcurementWorld({ repositoryRoot: process.cwd() });
  if (process.env.CF_ERPNEXT_PILOT_RESET === "1") world.resetBroadGoal();
  const injectLostResponse = process.env.CF_DEMO_LOST_RESPONSE === "1";
  // PROP-0005 hard ceiling: $2 for the filming session, enforced mechanically.
  // The tracker file persists across restarts so retakes share one ceiling.
  const capabilityConstruction: PilotCapabilityConstruction | undefined = mode === "genuine"
    ? {
        createBuilder: () => new StructuredManifestBuilder({
          documentation: { resolve: async () => world.documentation },
          gateway: new OpenAIStructuredManifestDraftGateway(new OpenAIModelGateway(
            apiKey!,
            new BudgetTracker(path.join(root, "genuine-model-budget.json"), { warnUsd: 1, maxUsd: 2, maxRunUsd: 1 }),
            new TraceWriter(`genuine-demo-${randomUUID()}`, path.join(root, "genuine-trace")),
          )),
          maxAttempts: 3,
        }),
        maxVerificationRepairs: 2,
        label: "model-backed",
      }
    : undefined;
  fs.writeFileSync(path.join(root, "demo-mode.json"), `${JSON.stringify({
    schemaVersion: "1",
    mode,
    capabilityConstruction: mode === "genuine"
      ? { builder: "StructuredManifestBuilder", draftGateway: "OpenAIStructuredManifestDraftGateway", maxVerificationRepairs: 2, budgetCeilingUsd: 2 }
      : { builder: "StaticProcurementBuilder", maxVerificationRepairs: 0 },
    startedAt: new Date().toISOString(),
    entryPoint: "src/customer-world/run-real-erpnext-pilot-stack.ts",
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const adapter = createRealErpNextBroadGoalPilotAdapter({
    world,
    dataDirectory: path.join(root, "product"),
    operationGuard: operations,
    continuationAuthority: continuation,
    ...(capabilityConstruction ? { capabilityConstruction } : {}),
    ...(injectLostResponse ? {
      faultInjection: {
        loseCreateResponseAfterCommitFor: REAL_ERPNEXT_BROAD_GOAL_REQUEST_IDS[0],
      },
    } : {}),
  });
  const coordinator = await createControlledPilotSdk(adapter, {
    planner: realErpNextBroadGoalPlanner,
    plans: new FileValidatedGoalPlanStore(path.join(root, "product", "plans")),
    maxPlanningAttempts: 1,
  });
  const jobs = new SidecarGoalJobService(
    new SidecarGoalJobStore(path.join(root, "sidecar-jobs.sqlite")),
    coordinator,
  );
  const sidecar = createCapabilitySidecar(undefined, { resolve: () => undefined }, {
    accessToken,
    broadGoals: coordinator,
    goalJobs: jobs,
  });
  const sidecarUrl = await sidecar.listen({ host: "127.0.0.1", port: sidecarPort });
  const client = new CapabilityFactorySidecarClient({ baseUrl: sidecarUrl, accessToken });
  const { app: consoleApp } = createConsoleApp({
    databasePath: path.join(root, "console.sqlite"),
    goalDataDirectory: path.join(root, "console-goals"),
    demoMode: mode,
    sidecar: {
      client,
      tenantId: "local-erpnext-pilot",
      scopeKey: REAL_ERPNEXT_PILOT_SCOPE_KEY,
      fixtureLabel: mode === "genuine"
        ? "Genuine disposable local ERPNext · model-backed capability construction · fictional procurement batch"
        : "Genuine disposable local ERPNext · fictional procurement batch",
      workflowLabel: mode === "genuine"
        ? "Durable sidecar · approved ERPNext procurement · model-backed"
        : "Durable sidecar · approved ERPNext procurement",
      suggestedGoal: REAL_ERPNEXT_PILOT_GOAL,
      continuationAuthority: continuation,
    },
    operationalControl: operations,
    recordingProfile: mode === "genuine"
      ? { routeBadge: "model-backed · disposable ERPNext · independently verified", suggestedGoal: REAL_ERPNEXT_PILOT_GOAL, defaultMode: "sidecar-live" }
      : { routeBadge: "deterministic reference · disposable ERPNext · verified" },
  });
  const consoleUrl = await consoleApp.listen({ host: "127.0.0.1", port: consolePort });
  console.log(`Capability Factory controlled-pilot stack: ${consoleUrl}/playground`);
  console.log(`Demo mode: ${mode}${mode === "genuine"
    ? " - capability manifests are drafted by the model (StructuredManifestBuilder); failures stay visible, there is no fallback to the reference builder. Spend ceiling $2 (genuine-model-budget.json)."
    : " - capability construction uses the deterministic reference builder; no model calls are made."}`);
  console.log(`Customer-local sidecar: ${sidecarUrl}`);
  console.log(`Private data: ${root}`);
  if (injectLostResponse) {
    console.log("Fault injection: the first approved create response will be discarded after commit; reconciliation must recover it without retrying the write.");
  }
  console.log("Boundary: genuine disposable local ERPNext with fictional data; not a customer or production system.");

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await consoleApp.close();
    await sidecar.close();
    await world.close();
    operations.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

await main();
