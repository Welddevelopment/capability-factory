import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetTracker, estimateGpt56SolCost } from "../src/budget.js";
import { startCompanyServer, type CompanyServerHandle } from "../src/company-server.js";
import { openCompanyDatabase, readPurchaseOrders, seedCompanyDatabase } from "../src/database.js";
import { createManualProcurementManifest } from "../src/manual-manifest.js";
import { CapabilityRegistry } from "../src/registry.js";
import { CapabilityRuntime } from "../src/runtime.js";
import { developmentScenario, developmentScenarioForCase, generateScenario } from "../src/scenario.js";
import { createTaskState, TaskStateStore } from "../src/task-state.js";
import { TraceWriter } from "../src/trace.js";
import { ToolHost } from "../src/tool-host.js";
import { verifyCapability, verifyCapabilityDefinition, verifyOutcome } from "../src/verifier.js";

const servers: CompanyServerHandle[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "capability-factory-test-"));
}

describe("offline company harness", () => {
  it("executes the manual capability, verifies the real state, and prevents duplicate orders", async () => {
    const directory = temporaryDirectory();
    const scenario = developmentScenario();
    const database = openCompanyDatabase(path.join(directory, "company.sqlite"));
    seedCompanyDatabase(database, scenario);
    const server = await startCompanyServer(database, scenario);
    servers.push(server);
    const trace = new TraceWriter("manual-thin-slice", path.join(directory, "trace"), [
      scenario.credential.secretValue,
    ]);
    const runtime = new CapabilityRuntime(
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
    const manifest = createManualProcurementManifest(scenario, server.documentation);
    const objectOutputManifest = structuredClone(manifest);
    objectOutputManifest.actions[1]!.response.outputPointers = { order: "/order" };
    expect(
      (await verifyCapability(
        objectOutputManifest,
        scenario,
        server.documentation,
        runtime,
        database,
        "full-capability-probe",
      )).passed,
    ).toBe(true);
    runtime.validateManifest(manifest);

    const shipment = scenario.shipments[0];
    expect(shipment).toBeDefined();
    const search = await runtime.execute(
      manifest,
      "search_equipment",
      {
        requiredMinTempC: shipment?.minTempC,
        requiredMaxTempC: shipment?.maxTempC,
        deliverBy: shipment?.arrivalAt,
      },
      { runId: "manual-thin-slice" },
    );
    const products = search.output.products as Array<Record<string, unknown>>;
    expect(products).toHaveLength(1);
    expect(products[0]?.product_sku).toBe("SENSOR-COLD-16");

    const input = {
      productSku: "SENSOR-COLD-16",
      quantity: 1,
      warehouseId: "WH-NORTH",
      deliverBy: shipment?.arrivalAt,
    };
    const first = await runtime.execute(manifest, "create_purchase_order", input, {
      runId: "manual-thin-slice",
    });
    const second = await runtime.execute(manifest, "create_purchase_order", input, {
      runId: "manual-thin-slice",
    });
    expect(first.output.orderId).toBe(second.output.orderId);
    expect(readPurchaseOrders(database)).toHaveLength(1);

    const state = createTaskState("manual-thin-slice", scenario.goal);
    state.status = "completed";
    state.finalAnswer = "The compatible monitor was ordered for the receiving warehouse.";
    state.remainingWork = [];
    const result = verifyOutcome(database, scenario, state);
    expect(result.passed).toBe(true);
    expect(result.incorrectSideEffects).toBe(0);
    database.close();
  });

  it("uses capability test mode without changing company state", async () => {
    const directory = temporaryDirectory();
    const scenario = developmentScenario();
    const database = openCompanyDatabase(path.join(directory, "company.sqlite"));
    seedCompanyDatabase(database, scenario);
    const server = await startCompanyServer(database, scenario);
    servers.push(server);
    const manifest = createManualProcurementManifest(scenario, server.documentation);
    const runtime = new CapabilityRuntime({
      targets: {
        procurement: {
          baseUrl: server.aliases.procurement ?? "",
          allowedPaths: server.allowedPaths.procurement ?? [],
        },
      },
      secrets: { [scenario.credential.secretAlias]: scenario.credential.secretValue },
    });
    await runtime.execute(
      manifest,
      "create_purchase_order",
      {
        productSku: "SENSOR-COLD-16",
        quantity: 1,
        warehouseId: "WH-NORTH",
        deliverBy: scenario.shipments[0]?.arrivalAt,
      },
      { runId: "capability-probe", testMode: true },
    );
    expect(readPurchaseOrders(database)).toHaveLength(0);
    database.close();
  });

  it("rejects routes outside the allowlist and literal secrets", async () => {
    const directory = temporaryDirectory();
    const scenario = developmentScenario();
    const database = openCompanyDatabase(path.join(directory, "company.sqlite"));
    seedCompanyDatabase(database, scenario);
    const server = await startCompanyServer(database, scenario);
    servers.push(server);
    const runtime = new CapabilityRuntime({
      targets: {
        procurement: {
          baseUrl: server.aliases.procurement ?? "",
          allowedPaths: server.allowedPaths.procurement ?? [],
        },
      },
      secrets: { [scenario.credential.secretAlias]: scenario.credential.secretValue },
    });
    const unsafeRoute = createManualProcurementManifest(scenario, server.documentation);
    unsafeRoute.actions[0]!.request.pathTemplate = "/not-documented";
    expect(() => runtime.validateManifest(unsafeRoute)).toThrow(/allowlisted/);

    const leaked = createManualProcurementManifest(scenario, server.documentation);
    leaked.description = `secret=${scenario.credential.secretValue}`;
    expect(() => runtime.validateManifest(leaked)).toThrow(/literal secret/);

    const literalAuthHeader = createManualProcurementManifest(scenario, server.documentation);
    literalAuthHeader.actions[0]!.request.headerTemplate = { Authorization: "hard-coded" };
    expect(() => runtime.validateManifest(literalAuthHeader)).toThrow(/secret alias/);

    const acceptedErrorStatus = createManualProcurementManifest(scenario, server.documentation);
    acceptedErrorStatus.actions[1]!.response.acceptedStatuses.push(403);
    expect(() => runtime.validateManifest(acceptedErrorStatus)).toThrow();
    database.close();
  });

  it("injects bearer authentication from an alias for a varied contract", async () => {
    const directory = temporaryDirectory();
    const scenario = generateScenario("bearer-contract-seed", "build");
    scenario.contract.auth = { kind: "bearer", secretAlias: "BEARER_TEST_ALIAS" };
    scenario.credential.secretAlias = "BEARER_TEST_ALIAS";
    const database = openCompanyDatabase(path.join(directory, "company.sqlite"));
    seedCompanyDatabase(database, scenario);
    const server = await startCompanyServer(database, scenario);
    servers.push(server);
    const runtime = new CapabilityRuntime({
      targets: {
        procurement: {
          baseUrl: server.aliases.procurement ?? "",
          allowedPaths: server.allowedPaths.procurement ?? [],
        },
      },
      secrets: { [scenario.credential.secretAlias]: scenario.credential.secretValue },
    });
    const manifest = createManualProcurementManifest(scenario, server.documentation);
    const result = await verifyCapability(
      manifest,
      scenario,
      server.documentation,
      runtime,
      database,
      "bearer-probe",
    );
    expect(result.passed).toBe(true);
    database.close();
  });

  it("surfaces a structured verifier failure and passes a clean general retry", async () => {
    const directory = temporaryDirectory();
    const scenario = developmentScenarioForCase("structured-error-retry");
    const database = openCompanyDatabase(path.join(directory, "company.sqlite"));
    seedCompanyDatabase(database, scenario);
    const server = await startCompanyServer(database, scenario);
    servers.push(server);
    const runtime = new CapabilityRuntime({
      targets: {
        procurement: {
          baseUrl: server.aliases.procurement ?? "",
          allowedPaths: server.allowedPaths.procurement ?? [],
        },
      },
      secrets: { [scenario.credential.secretAlias]: scenario.credential.secretValue },
    });
    const manifest = createManualProcurementManifest(scenario, server.documentation);
    const first = await verifyCapability(
      manifest,
      scenario,
      server.documentation,
      runtime,
      database,
      "structured-error-first",
    );
    expect(first.passed).toBe(false);
    expect(first.checks.some((check) => check.id === "write_probe" && !check.passed)).toBe(true);
    const retry = await verifyCapability(
      manifest,
      scenario,
      server.documentation,
      runtime,
      database,
      "structured-error-retry",
    );
    expect(retry.passed).toBe(true);
    expect(readPurchaseOrders(database)).toHaveLength(0);
    database.close();
  });

  it("enforces action timeouts", async () => {
    const scenario = developmentScenario();
    const manifest = createManualProcurementManifest(scenario, { openapi: "3.1.0" });
    manifest.actions[0]!.safety.timeoutMs = 100;
    const runtime = new CapabilityRuntime({
      targets: { procurement: { baseUrl: "http://127.0.0.1:65530", allowedPaths: [scenario.contract.catalogPath] } },
      secrets: { [scenario.credential.secretAlias]: scenario.credential.secretValue },
    });
    vi.stubGlobal(
      "fetch",
      (_url: URL, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    await expect(
      runtime.execute(
        { ...manifest, actions: [manifest.actions[0]!] },
        "search_equipment",
        { requiredMinTempC: -18, requiredMaxTempC: -14, deliverBy: scenario.shipments[0]?.arrivalAt },
        { runId: "timeout-probe" },
      ),
    ).rejects.toThrow(/aborted/);
  });

  it("rejects oversized responses and always disables redirects", async () => {
    const scenario = developmentScenario();
    const manifest = createManualProcurementManifest(scenario, { openapi: "3.1.0" });
    manifest.actions[0]!.safety.maxResponseBytes = 10;
    const runtime = new CapabilityRuntime({
      targets: { procurement: { baseUrl: "http://127.0.0.1:65530", allowedPaths: [scenario.contract.catalogPath] } },
      secrets: { [scenario.credential.secretAlias]: scenario.credential.secretValue },
    });
    let redirect: RequestInit["redirect"];
    vi.stubGlobal("fetch", (_url: URL, init: RequestInit) => {
      redirect = init.redirect;
      return Promise.resolve(new Response(JSON.stringify({ products: ["oversized"] }), { status: 200 }));
    });
    await expect(
      runtime.execute(
        { ...manifest, actions: [manifest.actions[0]!] },
        "search_equipment",
        { requiredMinTempC: -18, requiredMaxTempC: -14, deliverBy: scenario.shipments[0]?.arrivalAt },
        { runId: "size-probe" },
      ),
    ).rejects.toMatchObject({ category: "response_size" });
    expect(redirect).toBe("error");
  });
});

describe("persistence, evidence, and guardrails", () => {
  it("persists a verified capability across fresh registry instances", () => {
    const directory = temporaryDirectory();
    const scenario = developmentScenario();
    const manifest = createManualProcurementManifest(scenario, { openapi: "3.1.0" });
    const filename = path.join(directory, "registry.json");
    const first = new CapabilityRegistry(filename);
    first.register(manifest);
    expect(first.search("purchase equipment")[0]?.id).toBe(manifest.id);
    first.install(manifest.id);
    const freshSession = new CapabilityRegistry(filename);
    expect(freshSession.install(manifest.id).actions.map((action) => action.name)).toContain(
      "create_purchase_order",
    );
  });

  it("persists and restores the complete blocked task state", () => {
    const filename = path.join(temporaryDirectory(), "task-state.json");
    const store = new TaskStateStore(filename);
    const state = createTaskState("resume-run", "ordinary goal");
    state.observations.push("A required action is unavailable");
    state.completedSteps.push("inspect_current_state");
    state.remainingWork = ["perform blocked action", "confirm outcome"];
    state.blockedAction = "perform blocked action";
    state.requiredCapability = "external write capability";
    store.save(state);
    expect(store.load()).toEqual(state);
  });

  it("redacts secrets and authorization material from traces", () => {
    const directory = temporaryDirectory();
    const trace = new TraceWriter("redaction", directory, ["literal-secret"]);
    trace.record("test", {
      authorization: "Bearer literal-secret",
      nested: { token: "literal-secret", safe: "contains literal-secret" },
    });
    const content = fs.readFileSync(trace.filename, "utf8");
    expect(content).not.toContain("literal-secret");
    expect(content).toContain("[REDACTED]");
  });

  it("calculates cost and blocks projected overspend", () => {
    expect(
      estimateGpt56SolCost({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 }),
    ).toBeCloseTo(35);
    const tracker = new BudgetTracker(path.join(temporaryDirectory(), "budget.json"), {
      warnUsd: 35,
      maxUsd: 50,
      maxRunUsd: 3,
    });
    tracker.assertProjectedCall(2.5, 0);
    expect(() => tracker.assertProjectedCall(1, 2.5)).toThrow(/Per-run/);
  });

  it("accepts a safe permission handoff and rejects external writes", () => {
    const directory = temporaryDirectory();
    const scenario = generateScenario("fixed-test-seed", "handoff");
    const database = openCompanyDatabase(path.join(directory, "company.sqlite"));
    seedCompanyDatabase(database, scenario);
    const state = createTaskState("handoff-run", scenario.goal);
    state.status = "handed_off";
    state.handoffReason = "The available credential lacks permission to create the required order.";
    const result = verifyOutcome(database, scenario, state);
    expect(result.passed).toBe(true);
    expect(readPurchaseOrders(database)).toHaveLength(0);
    database.close();
  });

  it("verifies a generated capability against an expected permission denial", async () => {
    const directory = temporaryDirectory();
    const scenario = developmentScenarioForCase("missing-write-permission");
    const database = openCompanyDatabase(path.join(directory, "company.sqlite"));
    seedCompanyDatabase(database, scenario);
    const server = await startCompanyServer(database, scenario);
    servers.push(server);
    const runtime = new CapabilityRuntime({
      targets: {
        procurement: {
          baseUrl: server.aliases.procurement ?? "",
          allowedPaths: server.allowedPaths.procurement ?? [],
        },
      },
      secrets: { [scenario.credential.secretAlias]: scenario.credential.secretValue },
    });
    const manifest = createManualProcurementManifest(scenario, server.documentation);
    const verification = await verifyCapability(
      manifest,
      scenario,
      server.documentation,
      runtime,
      database,
      "permission-verification",
    );
    expect(verification.passed).toBe(true);
    expect(
      verification.checks.find((check) => check.id === "write_permission_probe")?.passed,
    ).toBe(true);
    expect(readPurchaseOrders(database)).toHaveLength(0);
    database.close();
  });

  it("drives the permission error through an installed capability into a persisted handoff", async () => {
    const directory = temporaryDirectory();
    const scenario = generateScenario("scripted-handoff-seed", "handoff");
    const database = openCompanyDatabase(path.join(directory, "company.sqlite"));
    seedCompanyDatabase(database, scenario);
    const server = await startCompanyServer(database, scenario);
    servers.push(server);
    const trace = new TraceWriter("scripted-handoff", path.join(directory, "trace"), [
      scenario.credential.secretValue,
    ]);
    const runtime = new CapabilityRuntime(
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
    const registry = new CapabilityRegistry(path.join(directory, "registry.json"), trace);
    const manifest = createManualProcurementManifest(scenario, server.documentation);
    runtime.validateManifest(manifest);
    registry.register(manifest);
    const stateStore = new TaskStateStore(path.join(directory, "task-state.json"));
    const state = createTaskState("scripted-handoff", scenario.goal);
    stateStore.save(state);
    const host = new ToolHost(server, scenario, registry, runtime, state, trace, undefined, stateStore);
    await host.execute("install_capability", { capabilityId: manifest.id });
    const expected = scenario.expected;
    if (expected.kind !== "handoff") throw new Error("Expected handoff scenario");
    const shipment = scenario.shipments[0];
    const product = scenario.catalog[0];
    if (!shipment || !product) throw new Error("Incomplete scripted handoff scenario");
    const attempted = (await host.execute("create_purchase_order", {
      productSku: product.productSku,
      quantity: 1,
      warehouseId: shipment.warehouseId,
      deliverBy: shipment.arrivalAt,
    })) as { error: boolean; category: string };
    expect(attempted).toMatchObject({ error: true, category: "permission" });
    await host.execute("request_human_help", { blocker: "The service credential lacks write permission." });
    expect(stateStore.load().status).toBe("handed_off");
    expect(verifyOutcome(database, scenario, state).passed).toBe(true);
    expect(readPurchaseOrders(database)).toHaveLength(0);
    database.close();
  });

  it("returns a recoverable policy error when documentation search is attempted after a registry match", async () => {
    const directory = temporaryDirectory();
    const scenario = developmentScenario();
    const database = openCompanyDatabase(path.join(directory, "company.sqlite"));
    seedCompanyDatabase(database, scenario);
    const server = await startCompanyServer(database, scenario);
    servers.push(server);
    const trace = new TraceWriter("recoverable-policy-error", path.join(directory, "trace"), [
      scenario.credential.secretValue,
    ]);
    const runtime = new CapabilityRuntime(
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
    const registry = new CapabilityRegistry(path.join(directory, "registry.json"), trace);
    registry.register(createManualProcurementManifest(scenario, server.documentation));
    const state = createTaskState("recoverable-policy-error", scenario.goal);
    const host = new ToolHost(server, scenario, registry, runtime, state, trace);

    const search = (await host.execute("search_capabilities", {
      need: "find and acquire suitable cold-storage equipment",
    })) as { matches: unknown[] };
    expect(search.matches).toHaveLength(1);
    const policyResult = await host.execute("search_service_docs", {
      need: "find another cold-storage route",
    });
    expect(policyResult).toMatchObject({
      error: true,
      category: "policy",
      message: expect.stringContaining("confirm no match"),
    });
    expect(state.status).toBe("running");
    expect(state.capabilitySearchResult).toBe("match");
    expect(state.completedSteps).toContain("search_service_docs");
    database.close();
  });

  it("hands off safely when an installed acquisition capability finds no compatible product", async () => {
    const directory = temporaryDirectory();
    const scenario = generateScenario("no-product-handoff-test", "confirmation");
    scenario.catalog = scenario.catalog.filter((product) => product.productSku.startsWith("WRONG-"));
    scenario.expected = { kind: "handoff", reason: "no-product" };
    const database = openCompanyDatabase(path.join(directory, "company.sqlite"));
    seedCompanyDatabase(database, scenario);
    const server = await startCompanyServer(database, scenario);
    servers.push(server);
    const trace = new TraceWriter("no-product-handoff", path.join(directory, "trace"), [
      scenario.credential.secretValue,
    ]);
    const runtime = new CapabilityRuntime(
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
    const registry = new CapabilityRegistry(path.join(directory, "registry.json"), trace);
    const manifest = createManualProcurementManifest(scenario, server.documentation);
    registry.register(manifest);
    const state = createTaskState("no-product-handoff", scenario.goal);
    const host = new ToolHost(server, scenario, registry, runtime, state, trace);
    await host.execute("install_capability", { capabilityId: manifest.id });
    const shipment = scenario.shipments[0];
    if (!shipment) throw new Error("No-product scenario has no shipment");
    const search = (await host.execute("search_equipment", {
      requiredMinTempC: shipment.minTempC,
      requiredMaxTempC: shipment.maxTempC,
      deliverBy: shipment.arrivalAt,
    })) as { output: { products: unknown[] } };
    expect(search.output.products).toEqual([]);
    await host.execute("request_human_help", {
      blocker: "No compatible product can arrive by the shipment deadline.",
    });
    expect(verifyOutcome(database, scenario, state).passed).toBe(true);
    expect(readPurchaseOrders(database)).toHaveLength(0);
    database.close();
  });

  it("accepts an already-prepared site only when no order is created", () => {
    const scenario = developmentScenarioForCase("already-ready");
    const database = openCompanyDatabase(path.join(temporaryDirectory(), "company.sqlite"));
    seedCompanyDatabase(database, scenario);
    const state = createTaskState("already-ready", scenario.goal);
    state.status = "completed";
    state.finalAnswer = "Existing installed equipment covers the full required range.";
    state.remainingWork = [];
    expect(verifyOutcome(database, scenario, state).passed).toBe(true);
    database.close();
  });

  it("rejects missing, wrong, late, and duplicate orders independently", () => {
    const directory = temporaryDirectory();
    const scenario = developmentScenario();
    const database = openCompanyDatabase(path.join(directory, "company.sqlite"));
    const arrivalAt = scenario.shipments[0]?.arrivalAt;
    if (!arrivalAt) throw new Error("Test scenario has no shipment");
    const completed = createTaskState("outcome-failures", scenario.goal);
    completed.status = "completed";
    completed.finalAnswer = "Claimed complete";
    completed.remainingWork = [];

    seedCompanyDatabase(database, scenario);
    expect(verifyOutcome(database, scenario, completed).passed).toBe(false);

    const insert = database.prepare(
      "INSERT INTO purchase_orders (id, idempotency_key, product_sku, quantity, warehouse_id, deliver_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("PO-WRONG", "wrong-key", "SENSOR-FREEZER-40", 1, "WH-NORTH", arrivalAt, scenario.now);
    let result = verifyOutcome(database, scenario, completed);
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.id === "correct_product")?.passed).toBe(false);
    expect(result.checks.find((check) => check.id === "product_compatible")?.passed).toBe(false);

    seedCompanyDatabase(database, scenario);
    insert.run("PO-LATE", "late-key-1", "SENSOR-COLD-16", 1, "WH-NORTH", "2026-07-30T15:00:00.000Z", scenario.now);
    result = verifyOutcome(database, scenario, completed);
    expect(result.checks.find((check) => check.id === "correct_deadline")?.passed).toBe(false);
    expect(result.checks.find((check) => check.id === "deliverable_before_deadline")?.passed).toBe(false);

    seedCompanyDatabase(database, scenario);
    insert.run("PO-ONE", "duplicate-key-1", "SENSOR-COLD-16", 1, "WH-NORTH", arrivalAt, scenario.now);
    insert.run("PO-TWO", "duplicate-key-2", "SENSOR-COLD-16", 1, "WH-NORTH", arrivalAt, scenario.now);
    result = verifyOutcome(database, scenario, completed);
    expect(result.passed).toBe(false);
    expect(result.incorrectSideEffects).toBe(1);
    database.close();
  });
});
