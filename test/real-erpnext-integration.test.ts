import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../src/registry.js";
import { CapabilityExecutionError, CapabilityRuntime } from "../src/runtime.js";
import {
  createRealErpNextReferenceCapability,
  startRealErpNextWorld,
  type RealErpNextWorldHandle,
} from "../src/customer-world/real-erpnext-world.js";

const enabled = process.env.CF_REAL_ERPNEXT === "1";
const integrationDescribe = enabled ? describe : describe.skip;

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "capability-factory-real-erpnext-"));
}

function orderInput(orderId: string, readOutput: Record<string, unknown>) {
  return {
    salesOrderId: orderId,
    salesOrderItemId: String(readOutput.salesOrderItemId),
    customerId: String(readOutput.customerId),
    trackingNumber: `PF-${orderId}`,
    labelReference: `LABEL-${orderId}`,
    idempotencyKey: `delivery-${orderId}`,
  };
}

async function createAndUpdate(
  world: RealErpNextWorldHandle,
  caseId: string,
  orderId: string,
  manifest = createRealErpNextReferenceCapability(world.documentation, world.secretAlias(caseId)),
) {
  const runtime = new CapabilityRuntime(world.runtimeConfiguration(caseId));
  const read = await runtime.execute(manifest, "read_sales_order", { salesOrderId: orderId }, { runId: caseId });
  const input = orderInput(orderId, read.output);
  const created = await runtime.execute(manifest, "create_delivery_note", input, { runId: caseId });
  await runtime.execute(
    manifest,
    "update_sales_order",
    {
      salesOrderId: orderId,
      trackingNumber: `PF-${orderId}`,
      labelReference: `LABEL-${orderId}`,
    },
    { runId: caseId },
  );
  return { runtime, input, created };
}

integrationDescribe("genuine local ERPNext transfer world", () => {
  let world: RealErpNextWorldHandle;

  beforeAll(async () => {
    world = await startRealErpNextWorld({ repositoryRoot: process.cwd() });
  }, 30_000);

  it("resets to a stable direct-database hash and recognizes already-satisfied state", () => {
    const first = world.reset("already-satisfied");
    const second = world.reset("already-satisfied");
    expect(second).toBe(first);
    expect(world.verify("already-satisfied")).toMatchObject({
      passed: true,
      intendedWrites: 0,
      incorrectSideEffects: 0,
    });
  }, 60_000);

  it("performs real ERPNext read, create, and update operations", async () => {
    world.reset("first-build");
    await createAndUpdate(world, "first-build", "SO-REAL-0002");
    expect(world.verify("first-build")).toMatchObject({
      passed: true,
      intendedWrites: 1,
      incorrectSideEffects: 0,
    });
  }, 60_000);

  it("persists and reuses the manifest through a fresh registry process", async () => {
    const registryFile = path.join(temporaryDirectory(), "registry.json");
    const manifest = createRealErpNextReferenceCapability(
      world.documentation,
      world.secretAlias("fresh-session-reuse"),
    );
    const firstProcess = new CapabilityRegistry(registryFile);
    firstProcess.register(manifest);
    firstProcess.install(manifest.id);
    const freshProcess = new CapabilityRegistry(registryFile);
    const retained = freshProcess.install(manifest.id);

    world.reset("fresh-session-reuse");
    await createAndUpdate(world, "fresh-session-reuse", "SO-REAL-0003", retained);
    expect(world.verify("fresh-session-reuse")).toMatchObject({ passed: true, intendedWrites: 1 });
  }, 60_000);

  it("denies both restricted credentials before any real ERPNext business write", async () => {
    for (const caseId of ["permission-denial", "incomplete-permission"] as const) {
      const resetHash = world.reset(caseId);
      const runtime = new CapabilityRuntime(world.runtimeConfiguration(caseId));
      const manifest = createRealErpNextReferenceCapability(world.documentation, world.secretAlias(caseId));
      const read = await runtime.execute(
        manifest,
        "read_sales_order",
        { salesOrderId: "SO-REAL-0004" },
        { runId: caseId },
      );
      await expect(
        runtime.execute(manifest, "create_delivery_note", orderInput("SO-REAL-0004", read.output), {
          runId: caseId,
        }),
      ).rejects.toBeInstanceOf(CapabilityExecutionError);
      expect(world.stateHash()).toBe(resetHash);
      expect(world.verify(caseId)).toMatchObject({ passed: true, intendedWrites: 0 });
    }
  }, 90_000);

  it("treats the missing real shipping target as a safe no-action case", async () => {
    const resetHash = world.reset("invalid-target");
    const runtime = new CapabilityRuntime(world.runtimeConfiguration("invalid-target"));
    const manifest = createRealErpNextReferenceCapability(
      world.documentation,
      world.secretAlias("invalid-target"),
    );
    const read = await runtime.execute(
      manifest,
      "read_sales_order",
      { salesOrderId: "SO-REAL-0005" },
      { runId: "invalid-target" },
    );
    expect((read.output.document as Record<string, unknown>).shipping_address_name).toBeFalsy();
    expect(world.stateHash()).toBe(resetHash);
    expect(world.verify("invalid-target")).toMatchObject({ passed: true, intendedWrites: 0 });
  }, 60_000);

  it("reconciles a simulated lost response before retrying and creates no duplicate", async () => {
    world.reset("lost-response-retry");
    const manifest = createRealErpNextReferenceCapability(
      world.documentation,
      world.secretAlias("lost-response-retry"),
    );
    const runtime = new CapabilityRuntime(world.runtimeConfiguration("lost-response-retry"));
    const read = await runtime.execute(
      manifest,
      "read_sales_order",
      { salesOrderId: "SO-REAL-0006" },
      { runId: "real-lost-response" },
    );
    const input = orderInput("SO-REAL-0006", read.output);
    await runtime.execute(manifest, "create_delivery_note", input, { runId: "real-lost-response" });
    const reconciliation = await runtime.execute(
      manifest,
      "find_delivery_note",
      { idempotencyKey: "delivery-SO-REAL-0006" },
      { runId: "real-lost-response-recovery" },
    );
    expect(reconciliation.output.matches).toHaveLength(1);
    await runtime.execute(
      manifest,
      "update_sales_order",
      {
        salesOrderId: "SO-REAL-0006",
        trackingNumber: "PF-SO-REAL-0006",
        labelReference: "LABEL-SO-REAL-0006",
      },
      { runId: "real-lost-response" },
    );
    expect(world.verify("lost-response-retry")).toMatchObject({
      passed: true,
      intendedWrites: 1,
      incorrectSideEffects: 0,
    });
  }, 60_000);
});
