import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { CapabilityManifest } from "../src/manifest.js";
import { CapabilityExecutionError, CapabilityRuntime } from "../src/runtime.js";
import {
  createProcurementReferenceCapability,
  startRealErpNextProcurementWorld,
  type RealErpNextProcurementWorld,
} from "../src/customer-world/real-erpnext-procurement-world.js";
import {
  executeProcurementPlan,
  findExistingPurchaseOrder,
} from "../src/customer-world/real-erpnext-procurement-execution.js";
import type { CapabilityRequest, OutcomeReceipt } from "../src/product/contracts.js";
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "cf-procurement-confirmation-"));
}

function requestFor(
  world: RealErpNextProcurementWorld,
  caseId: string,
  requestId: string,
): CapabilityRequest {
  const secretAlias = world.secretAlias(caseId);
  return {
    context: {
      tenantId: "procurement-confirmation-preflight",
      requestId,
      workflowKey: "approved-material-request-to-purchase-order",
      ordinaryGoal: world.cases.find((candidate) => candidate.id === caseId)!.ordinaryGoal,
      blockedAt: "2026-07-26T12:00:00.000Z",
      blockedReason: "The configured abilities cannot create the required linked procurement record.",
      visibility: "full",
    },
    need: {
      key: "create-linked-purchase-order",
      summary:
        "Read the exact approved Material Request, safely reconcile or create one linked Purchase Order, and record the created order reference on the source request.",
      requiredActions: [
        "read_material_request",
        "find_purchase_order",
        "create_purchase_order",
        "update_material_request",
      ],
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

class Resolver implements RuntimeResolver {
  constructor(private readonly world: RealErpNextProcurementWorld) {}
  resolve(request: CapabilityRequest): CapabilityRuntime {
    return new CapabilityRuntime(this.world.runtimeConfiguration(request.runtimeProfile));
  }
}

class ReferenceBuilder implements CapabilityBuilder {
  calls = 0;
  constructor(private readonly world: RealErpNextProcurementWorld) {}
  async build(request: CapabilityRequest): Promise<CapabilityManifest> {
    this.calls += 1;
    return createProcurementReferenceCapability(this.world.documentation, request.need.secretAliases[0]!);
  }
}

class ReferenceVerifier implements CapabilityVerifier {
  constructor(
    private readonly world: RealErpNextProcurementWorld,
    private readonly probeCase: string,
  ) {}

  async verify(request: CapabilityRequest, manifest: CapabilityManifest, runtime: CapabilityRuntime) {
    const checks = request.need.requiredActions.map((name) => ({
      id: `required-${name}`,
      passed: manifest.actions.some((action) => action.name === name),
      detail: `The capability must contain ${name}.`,
    }));
    try {
      runtime.validateManifest(manifest);
      this.world.reset(this.probeCase);
      await executeProcurementPlan(
        manifest,
        new CapabilityRuntime(this.world.runtimeConfiguration(this.probeCase)),
        this.world.requestId(this.probeCase),
        "deterministic-probe",
      );
      const direct = this.world.verify(this.probeCase);
      checks.push({
        id: "disposable-procurement-probe",
        passed: direct.passed && direct.incorrectSideEffects === 0,
        detail: direct.passed ? "Direct ERPNext procurement state matched." : JSON.stringify(direct.issues),
      });
    } finally {
      this.world.reset(request.runtimeProfile);
    }
    return {
      verifierVersion: "procurement-preflight-probe-1",
      manifestDigest: manifestDigest(manifest),
      documentationHash: request.need.documentationHash,
      passed: checks.every((check) => check.passed),
      checks,
      verifiedAt: "2026-07-26T12:00:01.000Z",
    };
  }
}

class Workflow implements CapabilityWorkflow {
  constructor(
    private readonly world: RealErpNextProcurementWorld,
    private readonly caseId: string,
  ) {}

  execute(_request: CapabilityRequest, manifest: CapabilityManifest, runtime: CapabilityRuntime) {
    return executeProcurementPlan(
      manifest,
      runtime,
      this.world.requestId(this.caseId),
      `procurement-preflight-${this.caseId}`,
    );
  }

  async verifyOutcome(): Promise<OutcomeReceipt> {
    const result = this.world.verify(this.caseId);
    return {
      verifierVersion: "procurement-direct-database-1",
      passed: result.passed,
      intendedWrites: result.intendedWrites,
      incorrectSideEffects: result.incorrectSideEffects,
      stateDigest: result.stateHash,
      checks: result.issues.length
        ? result.issues.map((issue) => ({ id: issue.code, passed: false, detail: issue.message }))
        : [{ id: "exact-procurement-state", passed: true, detail: "Direct ERPNext state matched." }],
      verifiedAt: "2026-07-26T12:00:02.000Z",
    };
  }

  async resume() {
    return {
      completed: this.world.verify(this.caseId).passed,
      summary: "The procurement goal resumed after the verified capability completed.",
    };
  }
}

integrationDescribe("ERPNext procurement model-campaign preflight", () => {
  let world: RealErpNextProcurementWorld;

  beforeAll(async () => {
    world = await startRealErpNextProcurementWorld({ repositoryRoot: process.cwd() });
  }, 30_000);

  it("resets the new world to a stable direct-database hash", () => {
    const first = world.reset("preflight-build");
    const second = world.reset("preflight-build");
    expect(second).toBe(first);
    expect(world.stateHash()).toBe(first);
  }, 90_000);

  it("performs the complete reference workflow through genuine ERPNext APIs", async () => {
    world.reset("preflight-build");
    const manifest = createProcurementReferenceCapability(
      world.documentation,
      world.secretAlias("preflight-build"),
    );
    const runtime = new CapabilityRuntime(world.runtimeConfiguration("preflight-build"));
    runtime.validateManifest(manifest);
    await executeProcurementPlan(
      manifest,
      runtime,
      world.requestId("preflight-build"),
      "reference-real-api",
    );
    expect(world.verify("preflight-build")).toMatchObject({
      passed: true,
      intendedWrites: 2,
      incorrectSideEffects: 0,
    });
  }, 90_000);

  it("denies the read-only credential before any business write", async () => {
    const resetHash = world.reset("preflight-permission");
    const manifest = createProcurementReferenceCapability(
      world.documentation,
      world.secretAlias("preflight-permission"),
    );
    const runtime = new CapabilityRuntime(world.runtimeConfiguration("preflight-permission"));
    await expect(
      executeProcurementPlan(
        manifest,
        runtime,
        world.requestId("preflight-permission"),
        "permission-preflight",
      ),
    ).rejects.toBeInstanceOf(CapabilityExecutionError);
    expect(world.stateHash()).toBe(resetHash);
    expect(world.verify("preflight-permission")).toMatchObject({ passed: true, intendedWrites: 0 });
  }, 90_000);

  it("reconciles a simulated lost response without a duplicate", async () => {
    world.reset("preflight-lost-response");
    const materialRequestId = world.requestId("preflight-lost-response");
    const manifest = createProcurementReferenceCapability(
      world.documentation,
      world.secretAlias("preflight-lost-response"),
    );
    const runtime = new CapabilityRuntime(world.runtimeConfiguration("preflight-lost-response"));
    await executeProcurementPlan(manifest, runtime, materialRequestId, "lost-response-create");
    const reconciliation = await findExistingPurchaseOrder(
      manifest,
      runtime,
      materialRequestId,
      "lost-response-reconcile",
    );
    const rawData = (reconciliation.raw as Record<string, unknown>).data;
    expect(rawData).toHaveLength(1);
    expect(world.verify("preflight-lost-response")).toMatchObject({
      passed: true,
      incorrectSideEffects: 0,
    });
  }, 90_000);

  it("does not require a model-generated reconciliation output to use the reference alias", async () => {
    world.reset("preflight-lost-response");
    const materialRequestId = world.requestId("preflight-lost-response");
    const manifest = structuredClone(
      createProcurementReferenceCapability(
        world.documentation,
        world.secretAlias("preflight-lost-response"),
      ),
    );
    const findAction = manifest.actions.find((action) => action.name === "find_purchase_order")!;
    findAction.response.outputPointers = { purchase_orders: "/data", first_order_name: "/data/0/name" };
    const runtime = new CapabilityRuntime(world.runtimeConfiguration("preflight-lost-response"));
    await executeProcurementPlan(manifest, runtime, materialRequestId, "alternate-output-alias-create");
    const reconciliation = await findExistingPurchaseOrder(
      manifest,
      runtime,
      materialRequestId,
      "alternate-output-alias-reconcile",
    );
    expect(reconciliation.output.matches).toBeUndefined();
    expect(reconciliation.output.purchase_orders).toHaveLength(1);
    expect((reconciliation.raw as Record<string, unknown>).data).toHaveLength(1);
    expect(world.verify("preflight-lost-response")).toMatchObject({
      passed: true,
      incorrectSideEffects: 0,
    });
  }, 90_000);

  it("builds through the shared product core and reuses from a fresh SDK process", async () => {
    const builder = new ReferenceBuilder(world);
    const resolver = new Resolver(world);
    const store = new FileTenantCapabilityStore(path.join(temporaryDirectory(), "registry"));
    const makeSdk = () =>
      new CapabilityFactorySdk({
        coordinator: new CapabilityCoordinator({
          store,
          builder,
          verifier: new ReferenceVerifier(world, "campaign-a-probe"),
          runtimeResolver: resolver,
        }),
        runtimeResolver: resolver,
      });

    world.reset("preflight-build");
    const built = await makeSdk().completeBlockedGoal(
      requestFor(world, "preflight-build", "procurement-reference-build"),
      new Workflow(world, "preflight-build"),
    );
    expect(built).toMatchObject({ status: "completed", capabilitySource: "built" });

    world.reset("preflight-reuse");
    const reused = await makeSdk().completeBlockedGoal(
      requestFor(world, "preflight-reuse", "procurement-reference-reuse"),
      new Workflow(world, "preflight-reuse"),
    );
    expect(reused).toMatchObject({ status: "completed", capabilitySource: "reused" });
    expect(builder.calls).toBe(1);
    expect(world.verify("preflight-reuse")).toMatchObject({ passed: true, incorrectSideEffects: 0 });
  }, 180_000);
});
