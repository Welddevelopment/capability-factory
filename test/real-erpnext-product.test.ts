import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { CapabilityManifest } from "../src/manifest.js";
import { CapabilityRuntime } from "../src/runtime.js";
import {
  createRealErpNextReferenceCapability,
  startRealErpNextWorld,
  type RealErpNextWorldHandle,
} from "../src/customer-world/real-erpnext-world.js";
import type { ActionReceipt, CapabilityRequest, OutcomeReceipt } from "../src/product/contracts.js";
import {
  CapabilityCoordinator,
  manifestDigest,
  type CapabilityBuilder,
  type CapabilityVerifier,
  type RuntimeResolver,
} from "../src/product/coordinator.js";
import { CapabilityFactorySdk, type CapabilityWorkflow } from "../src/product/sdk.js";
import { FileTenantCapabilityStore } from "../src/product/store.js";

const enabled = process.env.CF_REAL_ERPNEXT === "1";
const integrationDescribe = enabled ? describe : describe.skip;

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "capability-factory-real-product-"));
}

function requestFor(world: RealErpNextWorldHandle, caseId: string, requestId: string): CapabilityRequest {
  const secretAlias = world.secretAlias(caseId);
  return {
    context: {
      tenantId: "real-erpnext-development-tenant",
      requestId,
      workflowKey: "dispatch-preparation",
      ordinaryGoal: world.cases.find((candidate) => candidate.id === caseId)!.ordinaryGoal,
      blockedAt: "2026-07-26T11:00:00.000Z",
      blockedReason: "The configured abilities cannot prepare the required dispatch state.",
      visibility: "full",
    },
    need: {
      key: "prepare-dispatch-record",
      summary: "Prepare one authorized dispatch record and update its source order.",
      requiredActions: ["read_sales_order", "create_delivery_note", "update_sales_order"],
      targetAliases: ["customer_system"],
      secretAliases: [secretAlias],
      documentationHash: world.documentation.sha256,
    },
    authority: {
      allowedTargetAliases: ["customer_system"],
      allowedSecretAliases: [secretAlias],
      allowedMethods: ["GET", "POST", "PUT"],
      writeAuthority: "preauthorized",
      approvedWriteActions: [],
    },
    runtimeProfile: caseId,
  };
}

class RealRuntimeResolver implements RuntimeResolver {
  constructor(private readonly world: RealErpNextWorldHandle) {}
  resolve(request: CapabilityRequest): CapabilityRuntime {
    return new CapabilityRuntime(this.world.runtimeConfiguration(request.runtimeProfile));
  }
}

class RealReferenceBuilder implements CapabilityBuilder {
  calls = 0;
  constructor(private readonly world: RealErpNextWorldHandle) {}
  async build(request: CapabilityRequest): Promise<CapabilityManifest> {
    this.calls += 1;
    return createRealErpNextReferenceCapability(this.world.documentation, request.need.secretAliases[0]!);
  }
}

class RealReferenceVerifier implements CapabilityVerifier {
  async verify(request: CapabilityRequest, manifest: CapabilityManifest, runtime: CapabilityRuntime) {
    runtime.validateManifest(manifest);
    const names = new Set(manifest.actions.map((action) => action.name));
    const required = request.need.requiredActions.map((name) => ({
      id: `required-${name}`,
      passed: names.has(name),
      detail: `The proposed capability must contain ${name}.`,
    }));
    return {
      verifierVersion: "real-erpnext-reference-1",
      manifestDigest: manifestDigest(manifest),
      documentationHash: request.need.documentationHash,
      passed: required.every((check) => check.passed),
      checks: [{ id: "runtime-policy", passed: true, detail: "Trusted runtime policy accepted the manifest." }, ...required],
      verifiedAt: "2026-07-26T11:00:01.000Z",
    };
  }
}

class RealWorkflow implements CapabilityWorkflow {
  constructor(
    private readonly world: RealErpNextWorldHandle,
    private readonly caseId: string,
    private readonly orderId: string,
  ) {}

  async execute(_request: CapabilityRequest, manifest: CapabilityManifest, runtime: CapabilityRuntime) {
    const runId = `real-product-${this.caseId}`;
    const read = await runtime.execute(manifest, "read_sales_order", { salesOrderId: this.orderId }, { runId });
    const input = {
      salesOrderId: this.orderId,
      salesOrderItemId: String(read.output.salesOrderItemId),
      customerId: String(read.output.customerId),
      trackingNumber: `PF-${this.orderId}`,
      labelReference: `LABEL-${this.orderId}`,
      idempotencyKey: `delivery-${this.orderId}`,
    };
    const create = await runtime.execute(manifest, "create_delivery_note", input, { runId });
    const update = await runtime.execute(
      manifest,
      "update_sales_order",
      {
        salesOrderId: this.orderId,
        trackingNumber: `PF-${this.orderId}`,
        labelReference: `LABEL-${this.orderId}`,
      },
      { runId },
    );
    return [read, create, update].map<ActionReceipt>((result, index) => ({
      action: ["read_sales_order", "create_delivery_note", "update_sales_order"][index]!,
      status: result.status,
      output: result.output,
    }));
  }

  async verifyOutcome(): Promise<OutcomeReceipt> {
    const result = this.world.verify(this.caseId);
    return {
      verifierVersion: "real-erpnext-direct-database-1",
      passed: result.passed,
      intendedWrites: result.intendedWrites,
      incorrectSideEffects: result.incorrectSideEffects,
      stateDigest: result.stateHash,
      checks: result.issues.length
        ? result.issues.map((issue) => ({ id: issue.code, passed: false, detail: issue.message }))
        : [{ id: "exact-external-state", passed: true, detail: "Direct ERPNext database state matched the contract." }],
      verifiedAt: "2026-07-26T11:00:02.000Z",
    };
  }

  async resume() {
    return {
      completed: this.world.verify(this.caseId).passed,
      summary: "The ordinary dispatch-readiness goal resumed after the missing capability completed.",
    };
  }
}

integrationDescribe("shared product core against genuine local ERPNext", () => {
  let world: RealErpNextWorldHandle;

  beforeAll(async () => {
    world = await startRealErpNextWorld({ repositoryRoot: process.cwd() });
  }, 30_000);

  it("builds once, completes the real outcome, and reuses through a fresh SDK process", async () => {
    const store = new FileTenantCapabilityStore(path.join(temporaryDirectory(), "registry"));
    const builder = new RealReferenceBuilder(world);
    const runtimeResolver = new RealRuntimeResolver(world);
    const makeSdk = () =>
      new CapabilityFactorySdk({
        coordinator: new CapabilityCoordinator({
          store,
          builder,
          verifier: new RealReferenceVerifier(),
          runtimeResolver,
        }),
        runtimeResolver,
      });

    world.reset("first-build");
    const first = await makeSdk().completeBlockedGoal(
      requestFor(world, "first-build", "real-product-build"),
      new RealWorkflow(world, "first-build", "SO-REAL-0002"),
    );
    expect(first).toMatchObject({ status: "completed", capabilitySource: "built" });
    expect(world.verify("first-build")).toMatchObject({ passed: true, incorrectSideEffects: 0 });

    world.reset("fresh-session-reuse");
    const reused = await makeSdk().completeBlockedGoal(
      requestFor(world, "fresh-session-reuse", "real-product-reuse"),
      new RealWorkflow(world, "fresh-session-reuse", "SO-REAL-0003"),
    );
    expect(reused).toMatchObject({ status: "completed", capabilitySource: "reused" });
    expect(world.verify("fresh-session-reuse")).toMatchObject({ passed: true, incorrectSideEffects: 0 });
    expect(builder.calls).toBe(1);
  }, 90_000);
});
