import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import type { CapabilityAction, CapabilityManifest } from "../manifest.js";
import { BudgetTracker } from "../budget.js";
import { requireApiKey } from "../config.js";
import { OpenAIModelGateway } from "../model-gateway.js";
import { CapabilityRuntime } from "../runtime.js";
import { TraceWriter } from "../trace.js";
import type { ActionReceipt, CapabilityRequest, OutcomeReceipt } from "../product/contracts.js";
import {
  CapabilityCoordinator,
  manifestDigest,
  type CapabilityVerifier,
  type RuntimeResolver,
} from "../product/coordinator.js";
import { StructuredManifestBuilder } from "../product/builder.js";
import { OpenAIStructuredManifestDraftGateway } from "../product/openai-draft-gateway.js";
import { CapabilityFactorySdk, type CapabilityWorkflow } from "../product/sdk.js";
import { FileTenantCapabilityStore } from "../product/store.js";
import { startRealErpNextWorld, type RealErpNextWorldHandle } from "./real-erpnext-world.js";

interface PlanValues {
  orderId: string;
  orderItemId: string;
  customerId: string;
  trackingNumber: string;
  labelReference: string;
  idempotencyKey: string;
}

function inputFor(action: CapabilityAction, values: PlanValues): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(action.inputSchema.properties).map(([name, property]) => {
      const semantic = `${name} ${property.description}`.toLowerCase();
      let value: unknown;
      if (/sales.*order.*item|order.*item.*row|so.?detail/.test(semantic)) value = values.orderItemId;
      else if (/customer/.test(semantic)) value = values.customerId;
      else if (/sales.*order|order.*name|source.*order|order.*id/.test(semantic)) value = values.orderId;
      else if (/tracking/.test(semantic)) value = values.trackingNumber;
      else if (/label/.test(semantic)) value = values.labelReference;
      else if (/idempot/.test(semantic)) value = values.idempotencyKey;
      else if (property.type === "boolean") value = false;
      else throw new Error(`Cannot safely map generated input ${name} for ${action.name}`);
      return [name, value];
    }),
  );
}

function requiredAction(manifest: CapabilityManifest, name: string): CapabilityAction {
  const action = manifest.actions.find((candidate) => candidate.name === name);
  if (!action) throw new Error(`Generated capability is missing required action: ${name}`);
  return action;
}

async function executePlan(
  manifest: CapabilityManifest,
  runtime: CapabilityRuntime,
  orderId: string,
  runId: string,
): Promise<ActionReceipt[]> {
  const readAction = requiredAction(manifest, "read_sales_order");
  const provisional: PlanValues = {
    orderId,
    orderItemId: "pending-read",
    customerId: "pending-read",
    trackingNumber: `PF-${orderId}`,
    labelReference: `LABEL-${orderId}`,
    idempotencyKey: `delivery-${orderId}`,
  };
  const read = await runtime.execute(manifest, readAction.name, inputFor(readAction, provisional), { runId });
  const data = (read.raw as Record<string, unknown>).data as Record<string, unknown>;
  const items = data.items as Array<Record<string, unknown>>;
  const values: PlanValues = {
    ...provisional,
    customerId: String(data.customer),
    orderItemId: String(items[0]?.name),
  };
  const createAction = requiredAction(manifest, "create_delivery_note");
  const create = await runtime.execute(manifest, createAction.name, inputFor(createAction, values), { runId });
  const updateAction = requiredAction(manifest, "update_sales_order");
  const update = await runtime.execute(manifest, updateAction.name, inputFor(updateAction, values), { runId });
  return [read, create, update].map<ActionReceipt>((result, index) => ({
    action: [readAction.name, createAction.name, updateAction.name][index]!,
    status: result.status,
    output: result.output,
  }));
}

function requestFor(world: RealErpNextWorldHandle, caseId: string, requestId: string): CapabilityRequest {
  const secretAlias = world.secretAlias(caseId);
  return {
    context: {
      tenantId: "real-erpnext-model-development",
      requestId,
      workflowKey: "dispatch-preparation",
      ordinaryGoal: world.cases.find((candidate) => candidate.id === caseId)!.ordinaryGoal,
      blockedAt: new Date().toISOString(),
      blockedReason: "The configured abilities cannot prepare the required dispatch state.",
      visibility: "full",
    },
    need: {
      key: "prepare-dispatch-record",
      summary: "Read the target order, safely reconcile or create one dispatch record, and update the exact source order.",
      requiredActions: [
        "read_sales_order",
        "find_delivery_note",
        "create_delivery_note",
        "update_sales_order",
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

class RealRuntimeResolver implements RuntimeResolver {
  constructor(private readonly world: RealErpNextWorldHandle) {}
  resolve(request: CapabilityRequest): CapabilityRuntime {
    return new CapabilityRuntime(this.world.runtimeConfiguration(request.runtimeProfile));
  }
}

class ProbingVerifier implements CapabilityVerifier {
  constructor(private readonly world: RealErpNextWorldHandle) {}

  async verify(request: CapabilityRequest, manifest: CapabilityManifest, runtime: CapabilityRuntime) {
    const checks = [
      {
        id: "required-actions",
        passed: request.need.requiredActions.every((name) => manifest.actions.some((action) => action.name === name)),
        detail: "Every diagnosed required action must be present.",
      },
    ];
    try {
      runtime.validateManifest(manifest);
      this.world.reset("first-build");
      await executePlan(manifest, runtime, "SO-REAL-0002", "model-capability-probe");
      const direct = this.world.verify("first-build");
      checks.push({
        id: "disposable-real-system-probe",
        passed: direct.passed && direct.incorrectSideEffects === 0,
        detail: direct.passed
          ? "Direct ERPNext database state matched with zero incorrect side effects."
          : direct.issues.map((issue) => `${issue.code}: ${issue.message}`).join(" | "),
      });
    } catch (error) {
      checks.push({
        id: "disposable-real-system-probe",
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.world.reset("first-build");
    }
    return {
      verifierVersion: "real-erpnext-probing-verifier-1",
      manifestDigest: manifestDigest(manifest),
      documentationHash: request.need.documentationHash,
      passed: checks.every((check) => check.passed),
      checks,
      verifiedAt: new Date().toISOString(),
    };
  }
}

class RealWorkflow implements CapabilityWorkflow {
  constructor(
    private readonly world: RealErpNextWorldHandle,
    private readonly caseId: string,
    private readonly orderId: string,
  ) {}

  execute(_request: CapabilityRequest, manifest: CapabilityManifest, runtime: CapabilityRuntime) {
    return executePlan(manifest, runtime, this.orderId, `model-product-${this.caseId}`);
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
        : [{ id: "exact-external-state", passed: true, detail: "Direct ERPNext state matched the contract." }],
      verifiedAt: new Date().toISOString(),
    };
  }

  async resume() {
    return {
      completed: this.world.verify(this.caseId).passed,
      summary: "The ordinary goal resumed after the verified capability completed.",
    };
  }
}

async function main(): Promise<void> {
  const apiKey = requireApiKey();
  const runId = `real-model-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  const runDirectory = path.resolve("artifacts", "product-live", runId);
  fs.mkdirSync(runDirectory, { recursive: true });
  const budget = new BudgetTracker(path.resolve("artifacts", "product-live", "budget.json"), {
    warnUsd: 18,
    maxUsd: 23,
    maxRunUsd: 3,
  });
  const trace = new TraceWriter(runId, runDirectory);
  const modelGateway = new OpenAIModelGateway(apiKey, budget, trace);
  const draftGateway = new OpenAIStructuredManifestDraftGateway(modelGateway);
  const world = await startRealErpNextWorld({ repositoryRoot: process.cwd() });
  try {
    const runtimeResolver = new RealRuntimeResolver(world);
    const builder = new StructuredManifestBuilder({
      documentation: { resolve: async () => world.documentation },
      gateway: draftGateway,
      maxAttempts: 3,
    });
    const store = new FileTenantCapabilityStore(path.join(runDirectory, "registry"));
    const makeSdk = () =>
      new CapabilityFactorySdk({
        coordinator: new CapabilityCoordinator({
          store,
          builder,
          verifier: new ProbingVerifier(world),
          runtimeResolver,
        }),
        runtimeResolver,
      });

    world.reset("first-build");
    const build = await makeSdk().completeBlockedGoal(
      requestFor(world, "first-build", `${runId}-build`),
      new RealWorkflow(world, "first-build", "SO-REAL-0002"),
    );
    world.reset("fresh-session-reuse");
    const reuse =
      build.status === "completed"
        ? await makeSdk().completeBlockedGoal(
            requestFor(world, "fresh-session-reuse", `${runId}-reuse`),
            new RealWorkflow(world, "fresh-session-reuse", "SO-REAL-0003"),
          )
        : null;
    const summary = {
      runId,
      passed: build.status === "completed" && reuse?.status === "completed",
      build,
      reuse,
      spentUsd: draftGateway.spentUsd(),
      cumulativeProductBudget: budget.snapshot(),
    };
    fs.writeFileSync(path.join(runDirectory, "result.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      runId,
      passed: summary.passed,
      buildStatus: build.status,
      reuseStatus: reuse?.status ?? "not-run",
      spentUsd: summary.spentUsd,
      result: path.join(runDirectory, "result.json"),
    }));
    if (!summary.passed) process.exitCode = 1;
  } finally {
    await world.close();
  }
}

await main();
