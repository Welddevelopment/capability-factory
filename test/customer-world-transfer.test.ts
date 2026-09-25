import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../src/registry.js";
import { CapabilityExecutionError, CapabilityRuntime } from "../src/runtime.js";
import type { CapabilityManifest } from "../src/manifest.js";
import {
  createErpNextReferenceCapability,
  startErpNextDevelopmentWorld,
  type ErpNextDevelopmentWorldHandle,
} from "../src/customer-world/erpnext-world.js";
import { SECRET_VALUES } from "../src/customer-world/erpnext-server.js";

const worlds: ErpNextDevelopmentWorldHandle[] = [];

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.close()));
});

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "capability-factory-transfer-"));
}

async function startWorld(): Promise<ErpNextDevelopmentWorldHandle> {
  const world = await startErpNextDevelopmentWorld(temporaryDirectory());
  worlds.push(world);
  return world;
}

function manifestFor(world: ErpNextDevelopmentWorldHandle, caseId: string): CapabilityManifest {
  return createErpNextReferenceCapability(world.documentation, world.secretAlias(caseId));
}

function actionInput(salesOrderId: string, injectLostResponse = false) {
  return {
    salesOrderId,
    trackingNumber: `PF-${salesOrderId}`,
    labelReference: `LABEL-${salesOrderId}`,
    injectLostResponse,
  };
}

async function prepareOrder(
  world: ErpNextDevelopmentWorldHandle,
  caseId: string,
  salesOrderId: string,
  options: { runId?: string; injectLostResponse?: boolean } = {},
): Promise<void> {
  const manifest = manifestFor(world, caseId);
  const runtime = new CapabilityRuntime(world.runtimeConfiguration(caseId));
  const runId = options.runId ?? `deterministic-${caseId}`;
  await runtime.execute(manifest, "read_sales_order", { salesOrderId }, { runId });
  const input = actionInput(salesOrderId, options.injectLostResponse ?? false);
  if (options.injectLostResponse) {
    await expect(runtime.execute(manifest, "create_delivery_note", input, { runId })).rejects.toMatchObject({
      category: "service",
      status: 503,
    });
    const replay = await runtime.execute(manifest, "create_delivery_note", input, { runId });
    expect(replay.output.idempotentReplay).toBe(true);
  } else {
    await runtime.execute(manifest, "create_delivery_note", input, { runId });
  }
  await runtime.execute(
    manifest,
    "update_sales_order",
    {
      salesOrderId,
      trackingNumber: `PF-${salesOrderId}`,
      labelReference: `LABEL-${salesOrderId}`,
    },
    { runId },
  );
}

describe("replaceable customer-world contract", () => {
  it("contains the complete reusable case matrix and keeps hints out of ordinary goals", async () => {
    const world = await startWorld();
    expect(world.cases.map((testCase) => testCase.kind)).toEqual([
      "already-satisfied",
      "build",
      "reuse",
      "permission-denial",
      "permission-denial",
      "invalid-target",
      "retry-idempotency",
    ]);
    for (const testCase of world.cases) {
      expect(testCase.ordinaryGoal).not.toMatch(/\b(api|endpoint|route|manifest|integration|capability)\b/i);
      expect(testCase.expected.maxMatchingWrites).toBeLessThanOrEqual(1);
    }
    expect(world.adapterKind).toMatch(/not a full Frappe\/ERPNext installation/i);
  });

  it("supplies neutral documentation and a stable hash without secrets or build hints", async () => {
    const world = await startWorld();
    const serialized = JSON.stringify(world.documentation.content);
    expect(world.documentation.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(serialized).not.toMatch(/\b(capability|manifest|integration|tool)\b/i);
    for (const secret of Object.values(SECRET_VALUES)) expect(serialized).not.toContain(secret);

    const manifest = manifestFor(world, "first-build");
    const serializedManifest = JSON.stringify(manifest);
    for (const secret of Object.values(SECRET_VALUES)) expect(serializedManifest).not.toContain(secret);
    expect(manifest.provenance.documentationHash).toBe(world.documentation.sha256);
  });

  it("enforces exact host, route, and method policies", async () => {
    const world = await startWorld();
    const runtime = new CapabilityRuntime(world.runtimeConfiguration("first-build"));
    const manifest = manifestFor(world, "first-build");
    expect(() => runtime.validateManifest(manifest)).not.toThrow();

    const wrongRoute = structuredClone(manifest);
    wrongRoute.actions[0]!.request.pathTemplate = "/api/resource/Customer/{{input.salesOrderId}}";
    expect(() => runtime.validateManifest(wrongRoute)).toThrow(/route is not allowlisted/);

    const wrongMethod = structuredClone(manifest);
    wrongMethod.actions[0]!.request.method = "DELETE";
    wrongMethod.actions[0]!.safety.idempotency = "required";
    expect(() => runtime.validateManifest(wrongMethod)).toThrow(/method and route are not allowlisted/);

    const externalHost = world.runtimeConfiguration("first-build");
    externalHost.targets.customer_system!.baseUrl = "https://example.com";
    expect(() => new CapabilityRuntime(externalHost).validateManifest(manifest)).toThrow(/approved localhost/);
  });
});

describe("deterministic ERPNext-compatible development proof", () => {
  it("performs allowed read, create, and update operations and passes direct verification", async () => {
    const world = await startWorld();
    world.reset("first-build");
    await prepareOrder(world, "first-build", "SO-DEV-0002");
    const result = world.verify("first-build");
    expect(result).toMatchObject({ passed: true, intendedWrites: 1, incorrectSideEffects: 0 });
    expect(result.issues).toEqual([]);
  });

  it("recognizes the already-satisfied case without creating a new write", async () => {
    const world = await startWorld();
    const before = world.reset("already-satisfied");
    const result = world.verify("already-satisfied");
    expect(result).toMatchObject({ passed: true, intendedWrites: 0, incorrectSideEffects: 0 });
    expect(world.stateHash()).toBe(before);
  });

  it("fails safely for both read-only and deliberately incomplete credentials", async () => {
    const world = await startWorld();
    for (const caseId of ["permission-denial", "incomplete-permission"] as const) {
      const resetHash = world.reset(caseId);
      const runtime = new CapabilityRuntime(world.runtimeConfiguration(caseId));
      const manifest = manifestFor(world, caseId);
      await runtime.execute(manifest, "read_sales_order", { salesOrderId: "SO-DEV-0004" }, { runId: caseId });
      await expect(
        runtime.execute(manifest, "create_delivery_note", actionInput("SO-DEV-0004"), { runId: caseId }),
      ).rejects.toBeInstanceOf(CapabilityExecutionError);
      expect(world.stateHash()).toBe(resetHash);
      expect(world.verify(caseId)).toMatchObject({ passed: true, intendedWrites: 0, incorrectSideEffects: 0 });
    }
  });

  it("rejects invalid business data without a partial write", async () => {
    const world = await startWorld();
    const resetHash = world.reset("invalid-target");
    const runtime = new CapabilityRuntime(world.runtimeConfiguration("invalid-target"));
    const manifest = manifestFor(world, "invalid-target");
    await expect(
      runtime.execute(manifest, "create_delivery_note", actionInput("SO-DEV-0005"), { runId: "invalid-target" }),
    ).rejects.toMatchObject({ category: "request", status: 422 });
    expect(world.stateHash()).toBe(resetHash);
    expect(world.verify("invalid-target")).toMatchObject({ passed: true, intendedWrites: 0, incorrectSideEffects: 0 });
  });

  it("returns the same state hash after every deterministic reset", async () => {
    const world = await startWorld();
    const first = world.reset("first-build");
    await prepareOrder(world, "first-build", "SO-DEV-0002");
    expect(world.stateHash()).not.toBe(first);
    const second = world.reset("first-build");
    const third = world.reset("first-build");
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("retains a verified capability across a fresh registry process and reuses it on a new case", async () => {
    const directory = temporaryDirectory();
    const registryFile = path.join(directory, "registry.json");
    const world = await startWorld();
    const manifest = manifestFor(world, "first-build");
    const firstProcess = new CapabilityRegistry(registryFile);
    firstProcess.register(manifest);
    firstProcess.install(manifest.id);

    const freshProcess = new CapabilityRegistry(registryFile);
    const retained = freshProcess.get(manifest.id);
    expect(retained).toEqual(manifest);
    expect(freshProcess.search("dispatch sales order").map((item) => item.id)).toContain(manifest.id);
    const reused = freshProcess.install(manifest.id);

    world.reset("fresh-session-reuse");
    const runtime = new CapabilityRuntime(world.runtimeConfiguration("fresh-session-reuse"));
    await runtime.execute(reused, "create_delivery_note", actionInput("SO-DEV-0003"), { runId: "fresh-process" });
    await runtime.execute(
      reused,
      "update_sales_order",
      {
        salesOrderId: "SO-DEV-0003",
        trackingNumber: "PF-SO-DEV-0003",
        labelReference: "LABEL-SO-DEV-0003",
      },
      { runId: "fresh-process" },
    );
    expect(world.verify("fresh-session-reuse")).toMatchObject({ passed: true, intendedWrites: 1 });
  });

  it("survives an injected lost response without creating a duplicate", async () => {
    const world = await startWorld();
    world.reset("lost-response-retry");
    await prepareOrder(world, "lost-response-retry", "SO-DEV-0006", {
      runId: "stable-retry-run",
      injectLostResponse: true,
    });
    const count = world.database
      .prepare("SELECT COUNT(*) AS count FROM tabDeliveryNote WHERE sales_order = ?")
      .get("SO-DEV-0006") as Record<string, number>;
    expect(count.count).toBe(1);
    expect(world.verify("lost-response-retry")).toMatchObject({
      passed: true,
      intendedWrites: 1,
      incorrectSideEffects: 0,
    });
  });
});

describe("independent verifier negative controls", () => {
  it("detects a write to the wrong record", async () => {
    const world = await startWorld();
    world.reset("first-build");
    world.database.prepare("DELETE FROM tabSalesOrderItem WHERE parent = ?").run("SO-DEV-0002");
    world.database.prepare("DELETE FROM tabSalesOrder WHERE name = ?").run("SO-DEV-0002");
    const result = world.verify("first-build");
    expect(result.passed).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("wrong-record");
  });

  it("detects wrong fields, duplicates, and collateral writes", async () => {
    const world = await startWorld();

    world.reset("first-build");
    await prepareOrder(world, "first-build", "SO-DEV-0002");
    world.database.prepare("UPDATE tabDeliveryNote SET carrier = ? WHERE sales_order = ?").run("WrongCarrier", "SO-DEV-0002");
    expect(world.verify("first-build").issues.map((issue) => issue.code)).toContain("wrong-field");

    world.reset("first-build");
    await prepareOrder(world, "first-build", "SO-DEV-0002");
    world.database
      .prepare(
        `INSERT INTO tabDeliveryNote
          (name, customer, sales_order, posting_date, status, docstatus, carrier, service,
           tracking_number, label_reference, idempotency_key, modified)
         SELECT ?, customer, sales_order, posting_date, status, docstatus, carrier, service,
           tracking_number, label_reference, ?, modified FROM tabDeliveryNote WHERE sales_order = ?`,
      )
      .run("DN-DUPLICATE", "duplicate-idempotency-key", "SO-DEV-0002");
    expect(world.verify("first-build").issues.map((issue) => issue.code)).toContain("duplicate-write");

    world.reset("first-build");
    world.database.prepare("UPDATE tabItem SET item_name = ? WHERE item_code = ?").run("Tampered", "DEMO-WIDGET");
    expect(world.verify("first-build").issues.map((issue) => issue.code)).toContain("collateral-write");
  });
});
