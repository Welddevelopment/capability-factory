import fs from "node:fs";
import path from "node:path";
import type { FunctionTool } from "openai/resources/responses/responses";
import { BudgetTracker } from "./budget.js";
import { startCompanyServer, type CompanyServerHandle } from "./company-server.js";
import { EXPERIMENT_LIMITS, artifactsRoot, requireApiKey } from "./config.js";
import { openCompanyDatabase, seedCompanyDatabase } from "./database.js";
import { OpenAIModelGateway } from "./model-gateway.js";
import { BASELINE_SYSTEM_PROMPT } from "./prompts.js";
import { generateScenario, type Scenario } from "./scenario.js";
import { createTaskState, type TaskState } from "./task-state.js";
import { TraceWriter } from "./trace.js";
import { verifyOutcome, type VerifierResult } from "./verifier.js";
import { readFinalVerdict } from "./verdict.js";
import { AutonomousWorker, type WorkerToolHost } from "./worker.js";

class BaselineToolHost implements WorkerToolHost {
  constructor(
    private readonly server: CompanyServerHandle,
    private readonly scenario: Scenario,
    private readonly state: TaskState,
    private readonly trace: TraceWriter,
  ) {}

  definitions(): FunctionTool[] {
    return [
      {
        type: "function",
        name: "list_shipments",
        description: "List incoming shipments and their operational requirements.",
        strict: true,
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      },
      {
        type: "function",
        name: "inspect_site_equipment",
        description: "Inspect equipment installed at an operating site.",
        strict: true,
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["siteId"],
          properties: { siteId: { type: "string" } },
        },
      },
      {
        type: "function",
        name: "read_service_documentation",
        description: "Read API documentation for unavailable external operations.",
        strict: true,
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      },
      {
        type: "function",
        name: "http_request",
        description: "Make one allowlisted documented HTTP request using a runtime-resolved test credential.",
        strict: true,
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["method", "path", "query", "bodyJson", "idempotencyKey"],
          properties: {
            method: { type: "string", enum: ["GET", "POST"] },
            path: { type: "string" },
            query: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["key", "value"],
                properties: { key: { type: "string" }, value: { type: "string" } },
              },
            },
            bodyJson: { type: "string", description: "JSON object string, or {} for no body" },
            idempotencyKey: { type: "string", description: "Stable key for writes; empty string for reads" },
          },
        },
      },
      {
        type: "function",
        name: "request_human_help",
        description: "Stop safely when a legitimate permission, credential, route, or authority is unavailable.",
        strict: true,
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["blocker"],
          properties: { blocker: { type: "string" } },
        },
      },
    ];
  }

  async execute(name: string, input: Record<string, unknown>): Promise<unknown> {
    this.trace.record("baseline.tool.call", { name, input });
    let output: unknown;
    if (name === "list_shipments") {
      output = await this.readJson(`${this.server.baseUrl}/shipments/v1/shipments`);
    } else if (name === "inspect_site_equipment") {
      output = await this.readJson(
        `${this.server.baseUrl}/warehouses/v1/warehouses/${encodeURIComponent(String(input.siteId))}/equipment`,
      );
    } else if (name === "read_service_documentation") {
      output = this.server.documentation;
    } else if (name === "request_human_help") {
      this.state.status = "handed_off";
      this.state.handoffReason = String(input.blocker ?? "Unspecified blocker");
      this.state.remainingWork = [];
      output = { handedOff: true, blocker: this.state.handoffReason };
    } else if (name === "http_request") {
      output = await this.httpRequest(input);
    } else {
      throw new Error(`Unknown baseline tool: ${name}`);
    }
    this.state.observations.push(`${name}: ${JSON.stringify(output).slice(0, 2_000)}`);
    this.state.completedSteps.push(name);
    this.trace.record("baseline.tool.result", { name, output });
    return output;
  }

  private async httpRequest(input: Record<string, unknown>): Promise<unknown> {
    const method = input.method === "POST" ? "POST" : "GET";
    const requestedPath = String(input.path ?? "");
    if (!(this.server.allowedPaths.procurement ?? []).includes(requestedPath)) {
      throw new Error("Baseline attempted an undocumented route");
    }
    const url = new URL(requestedPath, this.server.baseUrl);
    const query = Array.isArray(input.query) ? input.query : [];
    for (const entry of query) {
      if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        url.searchParams.set(String(record.key), String(record.value));
      }
    }
    const headers = new Headers({ accept: "application/json" });
    const auth = this.scenario.contract.auth;
    if (auth.kind === "bearer") headers.set("authorization", `Bearer ${this.scenario.credential.secretValue}`);
    else headers.set(auth.headerName, this.scenario.credential.secretValue);
    let body: string | undefined;
    if (method === "POST") {
      const idempotencyKey = String(input.idempotencyKey ?? "");
      if (idempotencyKey.length < 8) throw new Error("Baseline write requires a stable idempotency key");
      headers.set("idempotency-key", idempotencyKey);
      headers.set("content-type", "application/json");
      body = String(input.bodyJson ?? "{}");
      JSON.parse(body);
    }
    const response = await fetch(url, {
      method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
      ...(body === undefined ? {} : { body }),
    });
    return { status: response.status, body: (await response.json()) as unknown };
  }

  private async readJson(url: string): Promise<unknown> {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Baseline read failed with HTTP ${response.status}`);
    return response.json();
  }
}

export interface BaselinePhase {
  runId: string;
  startedAt: string;
  finishedAt: string;
  costUsd: number;
  taskState: TaskState;
  verification: VerifierResult;
}

export interface BaselineSummary {
  baselineId: string;
  sourceSuiteId: string;
  seed: string;
  firstUse: BaselinePhase;
  freshSession: BaselinePhase;
  note: string;
}

async function runPhase(scenario: Scenario, phase: string): Promise<BaselinePhase> {
  const apiKey = requireApiKey();
  const startedAt = new Date().toISOString();
  const runId = `baseline-${phase}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  const directory = path.join(artifactsRoot(), "runs", runId);
  fs.mkdirSync(directory, { recursive: true });
  const database = openCompanyDatabase(path.join(directory, "company.sqlite"));
  seedCompanyDatabase(database, scenario);
  const server = await startCompanyServer(database, scenario);
  const trace = new TraceWriter(runId, directory, [scenario.credential.secretValue, apiKey]);
  const state = createTaskState(runId, scenario.goal);
  const budget = new BudgetTracker(path.join(artifactsRoot(), "budget.json"), {
    warnUsd: EXPERIMENT_LIMITS.warnCostUsd,
    maxUsd: EXPERIMENT_LIMITS.maxTotalCostUsd,
    maxRunUsd: EXPERIMENT_LIMITS.maxRunCostUsd,
  });
  const gateway = new OpenAIModelGateway(apiKey, budget, trace);
  try {
    const host = new BaselineToolHost(server, scenario, state, trace);
    await new AutonomousWorker(gateway, host, state, trace, BASELINE_SYSTEM_PROMPT).run();
    return {
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      costUsd: gateway.spentUsd(),
      taskState: state,
      verification: verifyOutcome(database, scenario, state),
    };
  } catch (error) {
    state.status = state.status === "handed_off" ? "handed_off" : "failed";
    state.finalAnswer = error instanceof Error ? error.message : String(error);
    trace.record("baseline.error", { error: state.finalAnswer, taskState: state });
    return {
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      costUsd: gateway.spentUsd(),
      taskState: state,
      verification: verifyOutcome(database, scenario, state),
    };
  } finally {
    await server.close();
    database.close();
  }
}

export async function runBaseline(sourceSuiteId: string): Promise<BaselineSummary> {
  const verdict = readFinalVerdict(artifactsRoot());
  if (sourceSuiteId !== verdict.day7SuiteId) {
    throw new Error(`Baseline must use the locked Day 7 suite: ${verdict.day7SuiteId}`);
  }
  const source = path.join(artifactsRoot(), "suites", sourceSuiteId, "summary.json");
  if (!fs.existsSync(source)) throw new Error(`Held-out suite not found: ${sourceSuiteId}`);
  const suite = JSON.parse(fs.readFileSync(source, "utf8")) as {
    seed?: string;
    phase?: "day6" | "day7_confirmation";
  };
  if (!suite.seed) throw new Error("Source suite does not contain its post-run seed");
  const scenario = generateScenario(
    suite.seed,
    suite.phase === "day7_confirmation" ? "confirmation" : "build",
  );
  const baselineId = `baseline-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  const summary: BaselineSummary = {
    baselineId,
    sourceSuiteId,
    seed: suite.seed,
    firstUse: await runPhase(scenario, "first-use"),
    freshSession: await runPhase(scenario, "fresh-session"),
    note: "Single illustrative ad-hoc HTTP baseline; not statistically conclusive and not part of colour classification.",
  };
  const directory = path.join(artifactsRoot(), "baselines", baselineId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}
