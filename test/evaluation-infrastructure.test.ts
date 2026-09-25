import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zodTextFormat } from "openai/helpers/zod";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEVELOPMENT_GOAL,
  EDGE_CAMPAIGN_MAX_USD,
  EXPERIMENT_LIMITS,
  requireApiKey,
} from "../src/config.js";
import type { CompanyDatabase } from "../src/database.js";
import { createEdgeCampaignCases, runOfflineDevelopment } from "../src/evaluation.js";
import type { HeldOutSuiteSummary, RunSummary } from "../src/evaluation.js";
import { ManifestGenerator } from "../src/factory.js";
import { assertCleanRepository } from "../src/freeze.js";
import {
  capabilityManifestFromOutput,
  capabilityManifestOutputSchema,
} from "../src/manifest.js";
import type { OpenAIModelGateway } from "../src/model-gateway.js";
import {
  FACTORY_SYSTEM_PROMPT,
  PROMPT_BANNED_SCENARIO_TERMS,
  WORKER_SYSTEM_PROMPT,
} from "../src/prompts.js";
import { generateSanitizedReport } from "../src/report.js";
import type { CapabilityRuntime } from "../src/runtime.js";
import { generateScenario } from "../src/scenario.js";
import { createTaskState } from "../src/task-state.js";
import { TraceWriter } from "../src/trace.js";
import { AutonomousWorker, type WorkerToolHost } from "../src/worker.js";
import { classifyFinalVerdict } from "../src/verdict.js";

const originalArtifactsDirectory = process.env.CF_ARTIFACTS_DIR;
const originalApiKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  if (originalArtifactsDirectory === undefined) delete process.env.CF_ARTIFACTS_DIR;
  else process.env.CF_ARTIFACTS_DIR = originalArtifactsDirectory;
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
});

describe("frozen experiment infrastructure", () => {
  it("keeps worker and factory system prompts free of scenario routing hints", () => {
    for (const term of PROMPT_BANNED_SCENARIO_TERMS) {
      expect(WORKER_SYSTEM_PROMPT.toLowerCase()).not.toContain(term);
      expect(FACTORY_SYSTEM_PROMPT.toLowerCase()).not.toContain(term);
    }
  });

  it("uses the preregistered model and hard execution limits", () => {
    expect(EXPERIMENT_LIMITS).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      maxTurns: 20,
      maxRepairs: 3,
      runTimeoutMs: 600_000,
      maxRunCostUsd: 3,
      warnCostUsd: 35,
      maxTotalCostUsd: 50,
    });
  });

  it("aligns the development goal with the externally verified procurement outcome", () => {
    expect(DEVELOPMENT_GOAL).toContain("order one compatible unit");
    expect(DEVELOPMENT_GOAL).toContain("delivery by the shipment's arrival");
    expect(DEVELOPMENT_GOAL).not.toContain("store it safely");
  });

  it("defines five contract-varied edge cases under a two-dollar campaign cap", () => {
    expect(EDGE_CAMPAIGN_MAX_USD).toBe(2);
    const cases = createEdgeCampaignCases("edge-campaign-test-seed");
    expect(cases.map((entry) => entry.name)).toEqual([
      "api_key_build_reuse",
      "bearer_build_reuse",
      "no_product_handoff",
      "permission_handoff",
      "structured_error_build_reuse",
    ]);
    expect(cases[0]?.scenario.contract.auth.kind).toBe("apiKey");
    expect(cases[1]?.scenario.contract.auth.kind).toBe("bearer");
    expect(cases[2]?.scenario.expected).toEqual({ kind: "handoff", reason: "no-product" });
    expect(cases[2]?.scenario.catalog.every((product) => product.productSku.startsWith("WRONG-"))).toBe(true);
    expect(cases[3]?.scenario.expected).toEqual({ kind: "handoff", reason: "permission" });
    expect(cases[3]?.scenario.credential.canWrite).toBe(false);
    expect(cases[4]?.scenario.orderBehavior).toEqual({ structuredFailuresBeforeSuccess: 1 });
  });

  it("builds an OpenAI-compatible transport and converts it to the runtime manifest", () => {
    const format = zodTextFormat(capabilityManifestOutputSchema, "capability_manifest");
    expect(format.type).toBe("json_schema");
    expect(format.strict).toBe(true);
    expect(JSON.stringify(format.schema)).toContain('"additionalProperties":false');
    expect(JSON.stringify(format.schema)).not.toContain('"propertyNames"');

    const output = capabilityManifestOutputSchema.parse({
      schemaVersion: "1",
      id: "generated-procurement",
      version: "1.0.0",
      service: "equipment acquisition",
      description: "Find equipment",
      baseUrlAlias: "procurement",
      auth: { kind: "apiKey", secretAlias: "PROCUREMENT_KEY", headerName: "x-key" },
      actions: [
        {
          name: "find_equipment",
          description: "Find compatible equipment",
          inputProperties: [
            { name: "minimum", type: "number", description: "Minimum temperature" },
          ],
          request: {
            method: "GET",
            pathTemplate: "/catalog",
            queryTemplate: [{ name: "min", value: "{{input.minimum}}" }],
            headerTemplate: [],
            bodyTemplate: null,
          },
          response: {
            acceptedStatuses: [200],
            outputPointers: [{ name: "products", pointer: "/products" }],
          },
          safety: {
            idempotency: "none",
            timeoutMs: 5_000,
            maxResponseBytes: 100_000,
          },
        },
      ],
    });
    const provenance = {
      documentationHash: "a".repeat(64),
      model: "gpt-5.6-sol",
      createdAt: "2026-07-24T00:00:00.000Z",
    };
    const manifest = capabilityManifestFromOutput(output, provenance);

    expect(manifest.actions[0]?.inputSchema.required).toEqual(["minimum"]);
    expect(manifest.actions[0]?.request.queryTemplate).toEqual({
      min: "{{input.minimum}}",
    });

    output.actions[0]?.inputProperties.push({
      name: "minimum",
      type: "number",
      description: "Duplicate minimum temperature",
    });
    expect(() => capabilityManifestFromOutput(output, provenance)).toThrow(
      "Duplicate input property entry: minimum",
    );
  });

  it("separates incomplete transports from semantic repairs and supplies the latest draft", async () => {
    const oneActionDraft = {
      schemaVersion: "1",
      id: "generated-procurement",
      version: "1.0.0",
      service: "equipment acquisition",
      description: "Find equipment",
      baseUrlAlias: "procurement",
      auth: { kind: "apiKey", secretAlias: "PROCUREMENT_KEY", headerName: "x-key" },
      actions: [
        {
          name: "find_equipment",
          description: "Find compatible equipment",
          inputProperties: [
            { name: "minimum", type: "number", description: "Minimum temperature" },
          ],
          request: {
            method: "GET",
            pathTemplate: "/catalog",
            queryTemplate: [{ name: "min", value: "{{input.minimum}}" }],
            headerTemplate: [],
            bodyTemplate: null,
          },
          response: {
            acceptedStatuses: [200],
            outputPointers: [{ name: "products", pointer: "/products" }],
          },
          safety: {
            idempotency: "none",
            timeoutMs: 5_000,
            maxResponseBytes: 100_000,
          },
        },
      ],
    };
    const requests: Array<{ input?: unknown }> = [];
    let calls = 0;
    const gateway = {
      create: async (params: { input?: unknown }) => {
        requests.push(params);
        calls += 1;
        if (calls <= 2 || calls === 4) {
          return {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output_text: "",
          };
        }
        return {
          status: "completed",
          output_text: JSON.stringify(oneActionDraft),
        };
      },
    } as unknown as OpenAIModelGateway;
    const runtime = {
      validateManifest: () => undefined,
    } as unknown as CapabilityRuntime;
    const database = {} as CompanyDatabase;
    const trace = new TraceWriter(
      "factory-repair-budget",
      fs.mkdtempSync(path.join(os.tmpdir(), "factory-repair-budget-")),
    );
    const scenario = generateScenario("factory-repair-budget", "build");
    const generator = new ManifestGenerator(gateway, runtime, database, trace);

    await expect(generator.generate("acquire equipment", {}, scenario)).rejects.toThrow(
      /one initial attempt and 3 repairs/,
    );
    expect(calls).toBe(7);
    const firstSemanticRepairInput = JSON.parse(String(requests[4]?.input)) as {
      previousDraft: { actions: Array<{ name: string }> } | null;
      previousValidationErrors: string[];
      previousResponseError: string | null;
    };
    expect(firstSemanticRepairInput.previousDraft?.actions.map((action) => action.name)).toEqual([
      "find_equipment",
    ]);
    expect(firstSemanticRepairInput.previousValidationErrors).toContainEqual(
      expect.stringContaining("read_and_write_actions"),
    );
    expect(firstSemanticRepairInput.previousResponseError).toContain(
      "Model output was incomplete",
    );
  });

  it("produces deterministic but contract-varied post-freeze cases", () => {
    const first = generateScenario("held-out-seed-a", "build");
    const repeat = generateScenario("held-out-seed-a", "build");
    const other = generateScenario("held-out-seed-b", "build");
    expect(repeat).toEqual(first);
    expect(other.contract.catalogPath).not.toBe(first.contract.catalogPath);
    expect(other.contract.queryFields).not.toEqual(first.contract.queryFields);
    const compatibleName = first.catalog[0]?.name.toLowerCase() ?? "";
    expect(compatibleName).toMatch(/storage|refrigerated|temperature-controlled/);
    expect(compatibleName).not.toContain("monitor");
  });

  it("stops at the funding gate before any live run without a key", () => {
    delete process.env.OPENAI_API_KEY;
    expect(() => requireApiKey()).toThrow(/funding gate/);
  });

  it("fails closed after the configured worker turn cutoff", async () => {
    let calls = 0;
    const gateway = {
      create: async () => {
        calls += 1;
        return {
          id: `response-${calls}`,
          output_text: "",
          output: [
            {
              type: "function_call",
              call_id: `call-${calls}`,
              name: "noop",
              arguments: "{}",
            },
          ],
        };
      },
    } as unknown as OpenAIModelGateway;
    const host: WorkerToolHost = {
      definitions: () => [],
      execute: async () => ({ ok: true }),
    };
    const state = createTaskState("turn-limit", "ordinary goal");
    const trace = new TraceWriter("turn-limit", fs.mkdtempSync(path.join(os.tmpdir(), "turn-limit-")));
    await new AutonomousWorker(gateway, host, state, trace).run();
    expect(calls).toBe(EXPERIMENT_LIMITS.maxTurns);
    expect(state.status).toBe("failed");
  });

  it("refuses to freeze a dirty repository", () => {
    const marker = path.resolve(".freeze-dirty-probe");
    fs.writeFileSync(marker, "test\n", "utf8");
    try {
      expect(() => assertCleanRepository()).toThrow(/clean committed repository/);
    } finally {
      fs.rmSync(marker);
    }
  });

  it("keeps internal observations and service documents out of sanitized reports", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "capability-factory-report-"));
    const artifactsDirectory = path.join(directory, "artifacts");
    const suiteId = "confirmation-suite-test";
    const suiteDirectory = path.join(artifactsDirectory, "suites", suiteId);
    fs.mkdirSync(suiteDirectory, { recursive: true });
    fs.mkdirSync(path.join(artifactsDirectory, "verdict"), { recursive: true });
    fs.writeFileSync(
      path.join(suiteDirectory, "summary.json"),
      JSON.stringify({
        suiteId,
        phase: "day7_confirmation",
        freeze: { commitSha: "frozen-commit", limits: EXPERIMENT_LIMITS },
        seed: "post-run-seed",
        startedAt: "2026-07-25T00:00:00.000Z",
        finishedAt: "2026-07-25T00:00:01.000Z",
        results: [
          {
            runId: "fresh-build",
            mode: "heldout",
            scenarioId: "confirmation-test",
            startedAt: "2026-07-25T00:00:00.000Z",
            finishedAt: "2026-07-25T00:00:01.000Z",
            passed: true,
            reused: false,
            costUsd: 0.1,
            taskState: {
              status: "completed",
              completedSteps: ["build_capability"],
              capabilitySearchResult: "no_match",
              installedCapabilities: ["test-capability"],
              blockedAction: null,
              handoffReason: null,
              finalAnswer: "done",
              observations: ["PRIVATE_OPENAPI_DOCUMENT", "literal credential"],
            },
            verification: {
              passed: true,
              checks: [{ id: "goal_resumed", passed: true, detail: "completed" }],
              incorrectSideEffects: 0,
            },
          },
        ],
        provisionalVerdict: "yellow",
        finalVerdict: "yellow",
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(artifactsDirectory, "verdict", "final.json"),
      JSON.stringify({ colour: "yellow" }),
      "utf8",
    );

    const originalWorkingDirectory = process.cwd();
    process.env.CF_ARTIFACTS_DIR = artifactsDirectory;
    try {
      process.chdir(directory);
      const filename = generateSanitizedReport(suiteId);
      const report = fs.readFileSync(filename, "utf8");
      expect(report).toContain("fresh build");
      expect(report).toContain('"completedSteps"');
      expect(report).not.toContain("PRIVATE_OPENAPI_DOCUMENT");
      expect(report).not.toContain("literal credential");
      expect(report).not.toContain('"observations"');
    } finally {
      process.chdir(originalWorkingDirectory);
    }
  });

  it("runs the complete manual build, outcome check, and fresh-session reuse offline", async () => {
    const artifactsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "capability-factory-artifacts-"));
    process.env.CF_ARTIFACTS_DIR = artifactsDirectory;
    const summary = await runOfflineDevelopment();
    expect(summary.passed).toBe(true);
    expect(summary.reused).toBe(true);
    expect(summary.costUsd).toBe(0);
    expect(summary.verification.incorrectSideEffects).toBe(0);
    expect(summary.taskState.status).toBe("completed");
    const runDirectory = path.join(artifactsDirectory, "runs", summary.runId);
    const firstState = JSON.parse(fs.readFileSync(path.join(runDirectory, "task-state.json"), "utf8")) as {
      completedSteps: string[];
    };
    expect(firstState.completedSteps).toEqual(
      expect.arrayContaining([
        "search_capabilities",
        "search_service_docs",
        "build_capability",
        "install_capability",
        "create_purchase_order",
      ]),
    );
    const registry = JSON.parse(fs.readFileSync(path.join(runDirectory, "registry.json"), "utf8")) as {
      entries: Array<{ installCount: number; reuseCount: number; testStatus: string }>;
    };
    expect(registry.entries[0]).toMatchObject({ installCount: 2, reuseCount: 1, testStatus: "passed" });
  });

  it("applies the preregistered green, yellow, and red verdict boundaries", () => {
    const run = (
      id: string,
      passed: boolean,
      reused: boolean,
      status: RunSummary["taskState"]["status"] = passed ? "completed" : "failed",
      sideEffects = 0,
    ): RunSummary => ({
      runId: id,
      mode: "heldout",
      scenarioId: id,
      startedAt: "2026-07-21T00:00:00.000Z",
      finishedAt: "2026-07-21T00:00:01.000Z",
      passed,
      reused,
      taskState: {
        ...createTaskState(id, "goal"),
        status,
        finalAnswer: status === "completed" ? "done" : null,
      },
      verification: { passed, checks: [], incorrectSideEffects: sideEffects },
      costUsd: 0,
    });
    const suite = (
      id: string,
      phase: HeldOutSuiteSummary["phase"],
      results: RunSummary[],
    ): HeldOutSuiteSummary =>
      ({
        suiteId: id,
        phase,
        seed: `${id}-seed`,
        startedAt: "2026-07-21T00:00:00.000Z",
        finishedAt: "2026-07-21T00:01:00.000Z",
        results,
        provisionalVerdict: "green_candidate",
        freeze: { commitSha: `${id}-commit` },
      }) as HeldOutSuiteSummary;
    const day6 = suite("day6", "day6", [
      run("reuse", true, true),
      run("build", true, false),
      run("reuse-built", true, true),
      run("handoff", true, true, "handed_off"),
    ]);
    const day7 = suite("day7", "day7_confirmation", [
      run("fresh-build", true, false),
      run("fresh-reuse", true, true),
    ]);
    expect(classifyFinalVerdict(day6, day7).colour).toBe("green");

    day7.results[1] = run("fresh-reuse", false, false);
    expect(classifyFinalVerdict(day6, day7).colour).toBe("yellow");

    day6.results[1] = run("build", false, false);
    day7.results[0] = run("fresh-build", false, false);
    expect(classifyFinalVerdict(day6, day7).colour).toBe("red");
  });
});
