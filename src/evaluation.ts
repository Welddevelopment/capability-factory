import fs from "node:fs";
import path from "node:path";
import { BudgetTracker } from "./budget.js";
import { startCompanyServer } from "./company-server.js";
import {
  EDGE_CAMPAIGN_MAX_USD,
  EXPERIMENT_LIMITS,
  artifactsRoot,
  requireApiKey,
} from "./config.js";
import { openCompanyDatabase, seedCompanyDatabase } from "./database.js";
import { ManifestGenerator } from "./factory.js";
import { verifyLatestFreeze, type FreezeRecord } from "./freeze.js";
import { createManualProcurementManifest } from "./manual-manifest.js";
import { OpenAIModelGateway } from "./model-gateway.js";
import { CapabilityRegistry } from "./registry.js";
import { CapabilityRuntime } from "./runtime.js";
import {
  createHeldOutSeed,
  developmentScenario,
  developmentScenarioForCase,
  generateScenario,
  type DevelopmentCaseName,
  type Scenario,
} from "./scenario.js";
import { createTaskState, TaskStateStore, type TaskState } from "./task-state.js";
import { ToolHost, type CapabilityBuilder } from "./tool-host.js";
import { TraceWriter } from "./trace.js";
import {
  verifyCapability,
  verifyCapabilityDefinition,
  verifyOutcome,
  type VerifierResult,
} from "./verifier.js";
import { lockFinalVerdict, readFinalVerdict, type FinalColour } from "./verdict.js";
import { AutonomousWorker } from "./worker.js";

export interface RunSummary {
  runId: string;
  mode: "offline" | "live" | "heldout" | "iteration" | "edge" | "baseline";
  scenarioId: string;
  startedAt: string;
  finishedAt: string;
  passed: boolean;
  reused: boolean;
  taskState: TaskState;
  verification: VerifierResult;
  costUsd: number;
  freeze?: FreezeRecord;
  seed?: string;
}

function timestampId(prefix: string): string {
  return `${prefix}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
}

function writeSummary(directory: string, summary: RunSummary): void {
  fs.writeFileSync(path.join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

function createRuntime(
  server: Awaited<ReturnType<typeof startCompanyServer>>,
  scenario: Scenario,
  trace: TraceWriter,
): CapabilityRuntime {
  return new CapabilityRuntime(
    {
      targets: {
        procurement: {
          baseUrl: server.aliases.procurement ?? "",
          allowedPaths: server.allowedPaths.procurement ?? [],
        },
      },
      secrets: { [scenario.credential.secretAlias]: scenario.credential.secretValue },
    },
    trace,
  );
}

export async function runOfflineDevelopment(): Promise<RunSummary> {
  const startedAt = new Date().toISOString();
  const runId = timestampId("offline-development");
  const directory = path.join(artifactsRoot(), "runs", runId);
  fs.mkdirSync(directory, { recursive: true });
  const scenario = developmentScenario();
  const database = openCompanyDatabase(path.join(directory, "company.sqlite"));
  seedCompanyDatabase(database, scenario);
  const server = await startCompanyServer(database, scenario);
  const trace = new TraceWriter(runId, directory, [scenario.credential.secretValue]);
  const registryFile = path.join(directory, "registry.json");
  const registry = new CapabilityRegistry(registryFile, trace);
  const runtime = createRuntime(server, scenario, trace);
  let state = createTaskState(runId, scenario.goal);
  const stateStore = new TaskStateStore(path.join(directory, "task-state.json"));
  stateStore.save(state);
  const offlineBuilder: CapabilityBuilder = {
    generate: async (_need, documentation) => {
      const manifest = createManualProcurementManifest(scenario, documentation);
      const verification = await verifyCapability(
        manifest,
        scenario,
        documentation,
        runtime,
        database,
        `${runId}:manual-capability`,
      );
      trace.record("capability.verification", { source: "temporary-manual", verification });
      if (!verification.passed) throw new Error("Temporary manual capability failed verification");
      return manifest;
    },
  };
  let host = new ToolHost(server, scenario, registry, runtime, state, trace, offlineBuilder, stateStore);
  try {
    const shipmentResult = (await host.execute("list_shipments", {})) as {
      shipments: Array<Record<string, unknown>>;
    };
    const shipment = shipmentResult.shipments[0];
    if (!shipment) throw new Error("Development scenario contains no shipment");
    await host.execute("inspect_site_equipment", { siteId: shipment.warehouse_id });
    const initialSearch = (await host.execute("search_capabilities", {
      need: "find and acquire suitable operating equipment",
    })) as { matches: unknown[] };
    if (initialSearch.matches.length !== 0) throw new Error("Cold offline build did not start with an empty registry");
    const docs = (await host.execute("search_service_docs", {
      need: "find and acquire suitable operating equipment",
    })) as { documents: Array<{ id: string }> };
    const docsId = docs.documents[0]?.id;
    if (!docsId) throw new Error("Offline documentation discovery returned no document");
    state = stateStore.load();
    if (!state.blockedAction || !state.requiredCapability) {
      throw new Error("Blocked task state was not restored before capability construction");
    }
    host = new ToolHost(server, scenario, registry, runtime, state, trace, offlineBuilder, stateStore);
    await host.execute("build_capability", {
      need: state.requiredCapability,
      docsId,
    });
    const capabilityId = registry.search("find and acquire suitable operating equipment")[0]?.id;
    if (!capabilityId) throw new Error("Registered capability could not be found");
    await host.execute("install_capability", { capabilityId });
    const productResult = (await host.execute("search_equipment", {
      requiredMinTempC: shipment.min_temp_c,
      requiredMaxTempC: shipment.max_temp_c,
      deliverBy: shipment.arrival_at,
    })) as { output: { products: Array<Record<string, unknown>> } };
    const product = productResult.output.products[0];
    if (!product) throw new Error("No compatible product was returned");
    await host.execute("create_purchase_order", {
      productSku: product.product_sku,
      quantity: 1,
      warehouseId: shipment.warehouse_id,
      deliverBy: shipment.arrival_at,
    });
    state.status = "completed";
    state.finalAnswer = "The blocking equipment was acquired and the original readiness goal resumed.";
    state.remainingWork = [];
    stateStore.save(state);
    const firstVerification = verifyOutcome(database, scenario, state);
    trace.record("outcome.verification", { phase: "first-use", firstVerification });
    if (!firstVerification.passed) throw new Error("First-use offline verification failed");

    seedCompanyDatabase(database, scenario);
    const freshState = createTaskState(`${runId}-fresh`, scenario.goal);
    const freshStateStore = new TaskStateStore(path.join(directory, "fresh-task-state.json"));
    freshStateStore.save(freshState);
    const freshRegistry = new CapabilityRegistry(registryFile, trace);
    const freshHost = new ToolHost(
      server,
      scenario,
      freshRegistry,
      runtime,
      freshState,
      trace,
      undefined,
      freshStateStore,
    );
    const persisted = freshRegistry.search("acquire operating equipment")[0];
    if (!persisted) throw new Error("Fresh session failed to find the saved capability");
    await freshHost.execute("install_capability", { capabilityId: persisted.id });
    const freshSearch = (await freshHost.execute("search_equipment", {
      requiredMinTempC: shipment.min_temp_c,
      requiredMaxTempC: shipment.max_temp_c,
      deliverBy: shipment.arrival_at,
    })) as { output: { products: Array<Record<string, unknown>> } };
    const freshProduct = freshSearch.output.products[0];
    if (!freshProduct) throw new Error("Fresh session capability returned no product");
    await freshHost.execute("create_purchase_order", {
      productSku: freshProduct.product_sku,
      quantity: 1,
      warehouseId: shipment.warehouse_id,
      deliverBy: shipment.arrival_at,
    });
    freshState.status = "completed";
    freshState.finalAnswer = "A fresh task reused the persisted capability and completed the goal.";
    freshState.remainingWork = [];
    freshStateStore.save(freshState);
    const verification = verifyOutcome(database, scenario, freshState);
    trace.record("outcome.verification", { phase: "fresh-session-reuse", verification });
    const summary: RunSummary = {
      runId,
      mode: "offline",
      scenarioId: scenario.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      passed: verification.passed,
      reused: true,
      taskState: freshState,
      verification,
      costUsd: 0,
    };
    writeSummary(directory, summary);
    return summary;
  } finally {
    await server.close();
    database.close();
  }
}

async function runLiveScenario(
  scenario: Scenario,
  options: {
    mode: "live" | "heldout" | "iteration" | "edge";
    registryFile?: string;
    preseedExisting?: boolean;
    freeze?: FreezeRecord;
    seed?: string;
    maxRunCostUsd?: number;
  },
): Promise<RunSummary> {
  const apiKey = requireApiKey();
  const startedAt = new Date().toISOString();
  const runId = timestampId(`${options.mode}-${scenario.id}`);
  const directory = path.join(artifactsRoot(), "runs", runId);
  fs.mkdirSync(directory, { recursive: true });
  const database = openCompanyDatabase(path.join(directory, "company.sqlite"));
  seedCompanyDatabase(database, scenario);
  const server = await startCompanyServer(database, scenario);
  const trace = new TraceWriter(runId, directory, [scenario.credential.secretValue, apiKey]);
  const registryFile = options.registryFile ?? path.join(directory, "registry.json");
  const registry = new CapabilityRegistry(registryFile, trace);
  const runtime = createRuntime(server, scenario, trace);
  if (options.preseedExisting && registry.list().length === 0) {
    const existing = createManualProcurementManifest(scenario, server.documentation);
    runtime.validateManifest(existing);
    const verification =
      scenario.expected.kind === "order"
        ? await verifyCapability(
            existing,
            scenario,
            server.documentation,
            runtime,
            database,
            `${runId}:preseed-verification`,
          )
        : verifyCapabilityDefinition(existing, scenario, server.documentation);
    trace.record("capability.verification", {
      source: "held-out-existing-capability-fixture",
      verification,
    });
    if (!verification.passed) throw new Error("Existing capability fixture failed deterministic verification");
    registry.register(existing);
  }
  const registryAtStart = new Set(registry.list().map((manifest) => manifest.id));
  const state = createTaskState(runId, scenario.goal);
  const stateStore = new TaskStateStore(path.join(directory, "task-state.json"));
  stateStore.save(state);
  const budget = new BudgetTracker(path.join(artifactsRoot(), "budget.json"), {
    warnUsd: EXPERIMENT_LIMITS.warnCostUsd,
    maxUsd: EXPERIMENT_LIMITS.maxTotalCostUsd,
    maxRunUsd: options.maxRunCostUsd ?? EXPERIMENT_LIMITS.maxRunCostUsd,
  });
  const gateway = new OpenAIModelGateway(apiKey, budget, trace);
  const generator = new ManifestGenerator(gateway, runtime, database, trace);
  const host = new ToolHost(server, scenario, registry, runtime, state, trace, generator, stateStore);
  try {
    await new AutonomousWorker(gateway, host, state, trace, undefined, stateStore).run();
    const verification = verifyOutcome(database, scenario, state);
    trace.record("outcome.verification", verification);
    const summary: RunSummary = {
      runId,
      mode: options.mode,
      scenarioId: scenario.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      passed: verification.passed,
      reused: state.installedCapabilities.some((id) => registryAtStart.has(id)),
      taskState: state,
      verification,
      costUsd: gateway.spentUsd(),
      ...(options.freeze ? { freeze: options.freeze } : {}),
      ...(options.seed ? { seed: options.seed } : {}),
    };
    writeSummary(directory, summary);
    return summary;
  } catch (error) {
    state.status = state.status === "handed_off" ? "handed_off" : "failed";
    if (!state.finalAnswer) state.finalAnswer = error instanceof Error ? error.message : String(error);
    stateStore.save(state);
    trace.record("run.error", { error: state.finalAnswer, taskState: state });
    const verification = verifyOutcome(database, scenario, state);
    trace.record("outcome.verification", verification);
    const summary: RunSummary = {
      runId,
      mode: options.mode,
      scenarioId: scenario.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      passed: false,
      reused: state.installedCapabilities.some((id) => registryAtStart.has(id)),
      taskState: state,
      verification,
      costUsd: gateway.spentUsd(),
      ...(options.freeze ? { freeze: options.freeze } : {}),
      ...(options.seed ? { seed: options.seed } : {}),
    };
    writeSummary(directory, summary);
    return summary;
  } finally {
    await server.close();
    database.close();
  }
}

export async function runLiveDevelopment(caseName: DevelopmentCaseName = "cold-shipment"): Promise<RunSummary> {
  return runLiveScenario(developmentScenarioForCase(caseName), { mode: "live" });
}

export interface HeldOutSuiteSummary {
  suiteId: string;
  freeze: FreezeRecord;
  seed: string;
  startedAt: string;
  finishedAt: string;
  results: RunSummary[];
  phase: "day6" | "day7_confirmation";
  provisionalVerdict: "green_candidate" | "yellow" | "red";
  finalVerdict?: FinalColour;
}

export interface PostDay7IterationSummary {
  iterationId: string;
  freeze: FreezeRecord;
  seed: string;
  startedAt: string;
  finishedAt: string;
  results: RunSummary[];
  phase: "post_day7_development";
  passed: boolean;
  lockedVerdict: {
    colour: FinalColour;
    day7SuiteId: string;
  };
}

export type EdgeCampaignCaseName =
  | "api_key_build_reuse"
  | "bearer_build_reuse"
  | "no_product_handoff"
  | "permission_handoff"
  | "structured_error_build_reuse";

export interface EdgeCampaignCaseDefinition {
  name: EdgeCampaignCaseName;
  scenario: Scenario;
  runKind: "build_reuse" | "single_handoff";
  preseedExisting: boolean;
}

export interface EdgeCampaignCaseResult {
  name: EdgeCampaignCaseName;
  passed: boolean;
  results: RunSummary[];
}

export interface EdgeCampaignSummary {
  campaignId: string;
  freeze: FreezeRecord;
  seed: string;
  startedAt: string;
  finishedAt: string | null;
  phase: "post_day7_edge_campaign";
  status: "running" | "completed";
  maxCampaignCostUsd: number;
  campaignCostUsd: number;
  cases: EdgeCampaignCaseResult[];
  passed: boolean;
  lockedVerdict: {
    colour: FinalColour;
    day7SuiteId: string;
  };
}

function forceApiKey(scenario: Scenario, label: string): void {
  const normalized = label.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  const secretAlias = `EDGE_KEY_${normalized}`;
  scenario.contract.auth = {
    kind: "apiKey",
    headerName: `x-edge-${label.replaceAll("_", "-")}-key`,
    secretAlias,
  };
  scenario.credential.secretAlias = secretAlias;
}

function forceBearer(scenario: Scenario, label: string): void {
  const normalized = label.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  const secretAlias = `EDGE_TOKEN_${normalized}`;
  scenario.contract.auth = { kind: "bearer", secretAlias };
  scenario.credential.secretAlias = secretAlias;
}

export function createEdgeCampaignCases(seed: string): EdgeCampaignCaseDefinition[] {
  const apiKey = generateScenario(`${seed}:api-key`, "confirmation");
  apiKey.id = `edge-api-key-${apiKey.id}`;
  forceApiKey(apiKey, "api-key");

  const bearer = generateScenario(`${seed}:bearer`, "confirmation");
  bearer.id = `edge-bearer-${bearer.id}`;
  forceBearer(bearer, "bearer");

  const noProduct = generateScenario(`${seed}:no-product`, "confirmation");
  noProduct.id = `edge-no-product-${noProduct.id}`;
  noProduct.catalog = noProduct.catalog.filter((product) =>
    product.productSku.startsWith("WRONG-"),
  );
  noProduct.expected = { kind: "handoff", reason: "no-product" };
  forceApiKey(noProduct, "no-product");

  const permission = generateScenario(`${seed}:permission`, "handoff");
  permission.id = `edge-permission-${permission.id}`;
  forceBearer(permission, "permission");

  const structured = generateScenario(`${seed}:structured-error`, "confirmation");
  structured.id = `edge-structured-error-${structured.id}`;
  structured.orderBehavior = { structuredFailuresBeforeSuccess: 1 };
  forceApiKey(structured, "structured-error");

  return [
    {
      name: "api_key_build_reuse",
      scenario: apiKey,
      runKind: "build_reuse",
      preseedExisting: false,
    },
    {
      name: "bearer_build_reuse",
      scenario: bearer,
      runKind: "build_reuse",
      preseedExisting: false,
    },
    {
      name: "no_product_handoff",
      scenario: noProduct,
      runKind: "single_handoff",
      preseedExisting: true,
    },
    {
      name: "permission_handoff",
      scenario: permission,
      runKind: "single_handoff",
      preseedExisting: true,
    },
    {
      name: "structured_error_build_reuse",
      scenario: structured,
      runKind: "build_reuse",
      preseedExisting: false,
    },
  ];
}

function latestDay6Suite(artifactsDirectory: string): HeldOutSuiteSummary | undefined {
  const directory = path.join(artifactsDirectory, "suites");
  if (!fs.existsSync(directory)) return undefined;
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name, "summary.json"))
    .filter((filename) => fs.existsSync(filename))
    .map((filename) => JSON.parse(fs.readFileSync(filename, "utf8")) as HeldOutSuiteSummary)
    .filter((summary) => summary.phase === "day6")
    .sort((left, right) => right.finishedAt.localeCompare(left.finishedAt))[0];
}

export async function runHeldOutSuite(confirmationOnly = false): Promise<HeldOutSuiteSummary> {
  const freeze = verifyLatestFreeze(artifactsRoot());
  requireApiKey();
  const day6 = confirmationOnly ? latestDay6Suite(artifactsRoot()) : undefined;
  if (confirmationOnly && !day6) throw new Error("Day 7 confirmation requires a preserved Day 6 suite");
  if (day6 && Date.parse(freeze.createdAt) <= Date.parse(day6.finishedAt)) {
    throw new Error("Day 7 confirmation requires a new freeze created after the Day 6 suite");
  }
  const seed = createHeldOutSeed();
  const suiteId = timestampId(confirmationOnly ? "confirmation-suite" : "heldout-suite");
  const suiteDirectory = path.join(artifactsRoot(), "suites", suiteId);
  fs.mkdirSync(suiteDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  const results: RunSummary[] = [];
  if (!confirmationOnly) {
    results.push(
      await runLiveScenario(generateScenario(seed, "reuse"), {
        mode: "heldout",
        preseedExisting: true,
        freeze,
        seed,
      }),
    );
  }
  const buildScenario = generateScenario(seed, confirmationOnly ? "confirmation" : "build");
  const persistentRegistry = path.join(suiteDirectory, "build-registry.json");
  const build = await runLiveScenario(buildScenario, {
    mode: "heldout",
    registryFile: persistentRegistry,
    freeze,
    seed,
  });
  results.push(build);
  const reuseAfterBuild = await runLiveScenario(buildScenario, {
    mode: "heldout",
    registryFile: persistentRegistry,
    freeze,
    seed,
  });
  results.push(reuseAfterBuild);
  if (!confirmationOnly) {
    results.push(
      await runLiveScenario(generateScenario(seed, "handoff"), {
        mode: "heldout",
        preseedExisting: true,
        freeze,
        seed,
      }),
    );
  }
  const unsafe = results.some((result) => result.verification.incorrectSideEffects > 0);
  const supportingPassed = confirmationOnly || results.some((result) => result !== build && result !== reuseAfterBuild && result.passed);
  const provisionalVerdict =
    build.passed && reuseAfterBuild.passed && supportingPassed && !unsafe
      ? "green_candidate"
      : results.some((result) => result.passed) && !unsafe
        ? "yellow"
        : "red";
  const summary: HeldOutSuiteSummary = {
    suiteId,
    freeze,
    seed,
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
    phase: confirmationOnly ? "day7_confirmation" : "day6",
    provisionalVerdict,
  };
  if (confirmationOnly && day6) {
    const final = lockFinalVerdict(artifactsRoot(), day6, summary);
    summary.finalVerdict = final.colour;
  }
  fs.writeFileSync(path.join(suiteDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

export async function runPostDay7Iteration(): Promise<PostDay7IterationSummary> {
  const freeze = verifyLatestFreeze(artifactsRoot());
  requireApiKey();
  const locked = readFinalVerdict(artifactsRoot());
  const seed = createHeldOutSeed();
  const iterationId = timestampId("post-day7-iteration");
  const iterationDirectory = path.join(artifactsRoot(), "iterations", iterationId);
  fs.mkdirSync(iterationDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  const scenario = generateScenario(seed, "confirmation");
  const persistentRegistry = path.join(iterationDirectory, "registry.json");
  const build = await runLiveScenario(scenario, {
    mode: "iteration",
    registryFile: persistentRegistry,
    freeze,
    seed,
  });
  const reuse = await runLiveScenario(scenario, {
    mode: "iteration",
    registryFile: persistentRegistry,
    freeze,
    seed,
  });
  const results = [build, reuse];
  const summary: PostDay7IterationSummary = {
    iterationId,
    freeze,
    seed,
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
    phase: "post_day7_development",
    passed:
      build.passed &&
      reuse.passed &&
      reuse.reused &&
      results.every((result) => result.verification.incorrectSideEffects === 0),
    lockedVerdict: {
      colour: locked.colour,
      day7SuiteId: locked.day7SuiteId,
    },
  };
  fs.writeFileSync(
    path.join(iterationDirectory, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  return summary;
}

function edgeCasePassed(definition: EdgeCampaignCaseDefinition, results: RunSummary[]): boolean {
  if (definition.runKind === "single_handoff") {
    const result = results[0];
    return Boolean(
      result?.passed &&
        result.taskState.status === "handed_off" &&
        result.verification.incorrectSideEffects === 0,
    );
  }
  const build = results[0];
  const reuse = results[1];
  return Boolean(
    build?.passed &&
      reuse?.passed &&
      reuse.reused &&
      results.every((result) => result.verification.incorrectSideEffects === 0),
  );
}

export async function runEdgeCampaign(): Promise<EdgeCampaignSummary> {
  const freeze = verifyLatestFreeze(artifactsRoot());
  requireApiKey();
  const locked = readFinalVerdict(artifactsRoot());
  const seed = createHeldOutSeed();
  const campaignId = timestampId("post-day7-edge-campaign");
  const campaignDirectory = path.join(artifactsRoot(), "campaigns", campaignId);
  fs.mkdirSync(campaignDirectory, { recursive: true });
  const definitions = createEdgeCampaignCases(seed);
  const cases: EdgeCampaignCaseResult[] = [];
  const startedAt = new Date().toISOString();
  let campaignCostUsd = 0;

  const summary = (): EdgeCampaignSummary => ({
    campaignId,
    freeze,
    seed,
    startedAt,
    finishedAt: cases.length === definitions.length ? new Date().toISOString() : null,
    phase: "post_day7_edge_campaign",
    status: cases.length === definitions.length ? "completed" : "running",
    maxCampaignCostUsd: EDGE_CAMPAIGN_MAX_USD,
    campaignCostUsd,
    cases,
    passed: cases.length === definitions.length && cases.every((entry) => entry.passed),
    lockedVerdict: {
      colour: locked.colour,
      day7SuiteId: locked.day7SuiteId,
    },
  });
  const checkpoint = (): void => {
    fs.writeFileSync(
      path.join(campaignDirectory, "summary.json"),
      `${JSON.stringify(summary(), null, 2)}\n`,
      "utf8",
    );
  };
  checkpoint();

  for (const definition of definitions) {
    const caseDirectory = path.join(campaignDirectory, definition.name);
    fs.mkdirSync(caseDirectory, { recursive: true });
    const registryFile = path.join(caseDirectory, "registry.json");
    const results: RunSummary[] = [];
    const runOnce = async (preseedExisting = false): Promise<RunSummary> => {
      const remainingUsd = EDGE_CAMPAIGN_MAX_USD - campaignCostUsd;
      if (remainingUsd <= 0) {
        throw new Error(`Edge campaign exhausted its $${EDGE_CAMPAIGN_MAX_USD.toFixed(2)} cap`);
      }
      const result = await runLiveScenario(definition.scenario, {
        mode: "edge",
        registryFile,
        preseedExisting,
        freeze,
        seed,
        maxRunCostUsd: Math.min(EXPERIMENT_LIMITS.maxRunCostUsd, remainingUsd),
      });
      campaignCostUsd += result.costUsd;
      return result;
    };

    if (definition.runKind === "single_handoff") {
      results.push(await runOnce(definition.preseedExisting));
    } else {
      results.push(await runOnce(false));
      results.push(await runOnce(false));
    }
    cases.push({
      name: definition.name,
      passed: edgeCasePassed(definition, results),
      results,
    });
    checkpoint();
  }
  return summary();
}
