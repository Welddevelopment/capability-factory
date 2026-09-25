import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { CapabilityManifest } from "../manifest.js";
import { hashDocumentation } from "../manifest.js";
import { CapabilityRuntime, type RuntimeConfiguration } from "../runtime.js";
import type {
  ActionReceipt,
  CapabilityEvent,
  CapabilityRequest,
  OutcomeReceipt,
} from "../product/contracts.js";
import {
  CapabilityCoordinator,
  manifestDigest,
  type CapabilityBuilder,
  type CapabilityEventSink,
  type CapabilityVerifier,
  type RuntimeResolver,
} from "../product/coordinator.js";
import type { ValidatedGoalPlan, ValidatedGoalWorkItem } from "../product/goal-coordination.js";
import type {
  GoalWorkItemExecutionInput,
  GoalWorkItemExecutionResult,
  GoalWorkItemExecutor,
} from "../product/goal-scheduler.js";
import { CapabilityFactorySdk, type CapabilityWorkflow } from "../product/sdk.js";
import { FileTenantCapabilityStore } from "../product/store.js";
import { BroadGoalReferenceWorld } from "./broad-goal-reference-world.js";

const TARGET_ALIAS = "supplier_east";
const SECRET_ALIAS = "supplier_east_key";
const SECRET_VALUE = "local-reference-east-key";
const CAPABILITY_ID = "east-industrial-restock";

const documentation = {
  openapi: "3.1.0",
  info: {
    title: "Fictional East Industrial restock API",
    version: "1.0.0",
    description: "Local development-only API for a constrained restock capability.",
  },
  servers: [{ url: `BASE_URL_ALIAS:${TARGET_ALIAS}` }],
  security: [{ apiKey: [] }],
  paths: {
    "/api/inventory/{sku}": { get: { operationId: "readStock" } },
    "/api/restocks": {
      get: { operationId: "findRestock", parameters: [{ name: "operation_key", in: "query", required: true }] },
      post: { operationId: "createRestock", description: "Idempotent by operation_key and Idempotency-Key." },
    },
  },
};

const DOCUMENTATION_HASH = hashDocumentation(documentation);

function stringProperty(description: string) {
  return { type: "string" as const, description };
}

export function createEastIndustrialReferenceCapability(): CapabilityManifest {
  return {
    schemaVersion: "1",
    id: CAPABILITY_ID,
    version: "1.0.0",
    service: "Fictional East Industrial restock API",
    description: "Read one stock record, reconcile an operation, and create one exact restock.",
    baseUrlAlias: TARGET_ALIAS,
    auth: { kind: "apiKey", secretAlias: SECRET_ALIAS, headerName: "x-api-key" },
    actions: [
      {
        name: "read_stock",
        description: "Read the exact trusted inventory item.",
        inputSchema: {
          type: "object",
          properties: { sku: stringProperty("Exact trusted inventory SKU") },
          required: ["sku"],
          additionalProperties: false,
        },
        request: {
          method: "GET",
          pathTemplate: "/api/inventory/{{input.sku}}",
          queryTemplate: {},
          headerTemplate: {},
          bodyTemplate: null,
        },
        response: { acceptedStatuses: [200], outputPointers: { data: "/data" } },
        safety: { idempotency: "none", timeoutMs: 2_000, maxResponseBytes: 100_000 },
      },
      {
        name: "find_restock",
        description: "Find an existing restock by the scheduler's stable operation key.",
        inputSchema: {
          type: "object",
          properties: { operationKey: stringProperty("Stable trusted scheduler operation key") },
          required: ["operationKey"],
          additionalProperties: false,
        },
        request: {
          method: "GET",
          pathTemplate: "/api/restocks",
          queryTemplate: { operation_key: "{{input.operationKey}}" },
          headerTemplate: {},
          bodyTemplate: null,
        },
        response: { acceptedStatuses: [200], outputPointers: { data: "/data", found: "/found" } },
        safety: { idempotency: "none", timeoutMs: 2_000, maxResponseBytes: 100_000 },
      },
      {
        name: "create_restock",
        description: "Create exactly one restock for the trusted SKU and stable operation key.",
        inputSchema: {
          type: "object",
          properties: {
            sku: stringProperty("Exact trusted inventory SKU"),
            operationKey: stringProperty("Stable trusted scheduler operation key"),
          },
          required: ["sku", "operationKey"],
          additionalProperties: false,
        },
        request: {
          method: "POST",
          pathTemplate: "/api/restocks",
          queryTemplate: {},
          headerTemplate: {},
          bodyTemplate: { sku: "{{input.sku}}", operation_key: "{{input.operationKey}}" },
        },
        response: {
          acceptedStatuses: [200, 201],
          outputPointers: { data: "/data", idempotentReplay: "/idempotent_replay" },
        },
        safety: { idempotency: "required", timeoutMs: 2_000, maxResponseBytes: 100_000 },
      },
    ],
    provenance: {
      documentationHash: DOCUMENTATION_HASH,
      model: "deterministic-reference-no-model",
      createdAt: "2026-07-27T00:00:00.000Z",
    },
  };
}

interface InventoryRow {
  sku: string;
  available_quantity: number;
  required_quantity: number;
  supplier: string;
}

interface RestockRow {
  sku: string;
  supplier: string;
  quantity: number;
  operation_key: string;
}

function objectBody(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

class BroadGoalHttpServer {
  private constructor(
    readonly app: FastifyInstance,
    readonly baseUrl: string,
    private readonly world: BroadGoalReferenceWorld,
  ) {}

  static async start(world: BroadGoalReferenceWorld): Promise<BroadGoalHttpServer> {
    const app = Fastify({ logger: false, bodyLimit: 100_000 });
    app.addHook("preHandler", async (request, reply) => {
      if (request.headers["x-api-key"] !== SECRET_VALUE) {
        return reply.code(401).send({ error: "invalid-api-key" });
      }
    });
    app.get<{ Params: { sku: string } }>("/api/inventory/:sku", async (request, reply) => {
      const row = world.database.prepare(
        "SELECT sku, available_quantity, required_quantity, supplier FROM inventory WHERE sku = ?",
      ).get(request.params.sku) as unknown as InventoryRow | undefined;
      if (!row) return reply.code(404).send({ error: "inventory-not-found" });
      return { data: row };
    });
    app.get<{ Querystring: { operation_key?: string } }>("/api/restocks", async (request, reply) => {
      if (!request.query.operation_key) return reply.code(400).send({ error: "operation-key-required" });
      const row = world.database.prepare(
        "SELECT sku, supplier, quantity, operation_key FROM restocks WHERE operation_key = ?",
      ).get(request.query.operation_key) as unknown as RestockRow | undefined;
      return { found: Boolean(row), data: row ?? null };
    });
    app.post("/api/restocks", async (request, reply) => {
      const body = objectBody(request.body);
      const sku = typeof body.sku === "string" ? body.sku : "";
      const operationKey = typeof body.operation_key === "string" ? body.operation_key : "";
      if (!sku || !operationKey || typeof request.headers["idempotency-key"] !== "string") {
        return reply.code(400).send({ error: "sku-operation-and-idempotency-key-required" });
      }
      const existing = world.database.prepare(
        "SELECT sku, supplier, quantity, operation_key FROM restocks WHERE operation_key = ?",
      ).get(operationKey) as unknown as RestockRow | undefined;
      if (existing) return reply.code(200).send({ data: existing, idempotent_replay: true });
      const inventory = world.database.prepare(
        "SELECT sku, available_quantity, required_quantity, supplier FROM inventory WHERE sku = ?",
      ).get(sku) as unknown as InventoryRow | undefined;
      if (!inventory || inventory.supplier !== TARGET_ALIAS) {
        return reply.code(422).send({ error: "sku-is-not-an-east-industrial-item" });
      }
      const row: RestockRow = {
        sku: inventory.sku,
        supplier: inventory.supplier,
        quantity: inventory.required_quantity,
        operation_key: operationKey,
      };
      if (request.headers["x-capability-test"] === "1") {
        return reply.code(201).send({ data: row, test_mode: true, idempotent_replay: false });
      }
      world.database.prepare(
        "INSERT INTO restocks (sku, supplier, quantity, operation_key) VALUES (?, ?, ?, ?)",
      ).run(row.sku, row.supplier, row.quantity, row.operation_key);
      return reply.code(201).send({ data: row, idempotent_replay: false });
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Broad-goal HTTP server did not expose a local port.");
    return new BroadGoalHttpServer(app, `http://127.0.0.1:${address.port}`, world);
  }

  runtimeConfiguration(): RuntimeConfiguration {
    return {
      targets: {
        [TARGET_ALIAS]: {
          baseUrl: this.baseUrl,
          allowedPaths: ["/api/inventory/:sku", "/api/restocks"],
          allowedMethods: {
            GET: ["/api/inventory/:sku", "/api/restocks"],
            POST: ["/api/restocks"],
          },
        },
      },
      secrets: { [SECRET_ALIAS]: SECRET_VALUE },
    };
  }

  close(): Promise<void> {
    return this.app.close();
  }
}

class StaticReferenceBuilder implements CapabilityBuilder {
  calls = 0;
  async build(): Promise<CapabilityManifest> {
    this.calls += 1;
    return createEastIndustrialReferenceCapability();
  }
}

class StaticRuntimeResolver implements RuntimeResolver {
  constructor(private readonly configuration: RuntimeConfiguration) {}
  resolve(): CapabilityRuntime {
    return new CapabilityRuntime(this.configuration);
  }
}

class EastIndustrialCapabilityVerifier implements CapabilityVerifier {
  constructor(
    private readonly world: BroadGoalReferenceWorld,
    private readonly runtimeResolver: RuntimeResolver,
  ) {}

  async verify(request: CapabilityRequest, manifest: CapabilityManifest, runtime: CapabilityRuntime) {
    const before = createHash("sha256").update(JSON.stringify(this.world.stateSnapshot())).digest("hex");
    runtime.validateManifest(manifest);
    const actionsPresent = request.need.requiredActions.every((name) => manifest.actions.some((action) => action.name === name));
    const runId = `probe-${request.context.requestId}`;
    let probePassed = false;
    try {
      await runtime.execute(manifest, "read_stock", { sku: "sku_insulated_crate" }, { runId, testMode: true });
      await runtime.execute(manifest, "find_restock", { operationKey: "probe-operation" }, { runId, testMode: true });
      await runtime.execute(
        manifest,
        "create_restock",
        { sku: "sku_insulated_crate", operationKey: "probe-operation" },
        { runId, testMode: true },
      );
      probePassed = true;
    } catch {
      probePassed = false;
    }
    const after = createHash("sha256").update(JSON.stringify(this.world.stateSnapshot())).digest("hex");
    const statePreserved = before === after;
    return {
      verifierVersion: "east-industrial-disposable-probe-v1",
      manifestDigest: manifestDigest(manifest),
      documentationHash: request.need.documentationHash,
      passed: actionsPresent && probePassed && statePreserved,
      checks: [
        { id: "required-actions", passed: actionsPresent, detail: "The minimum trusted action set is present." },
        { id: "disposable-http-probe", passed: probePassed, detail: "Read, reconciliation, and test-mode write paths completed through the allowlisted runtime." },
        { id: "probe-state-reset", passed: statePreserved, detail: "The disposable capability probe did not change business state." },
      ],
      verifiedAt: new Date().toISOString(),
    };
  }
}

class EastIndustrialWorkflow implements CapabilityWorkflow {
  constructor(
    private readonly world: BroadGoalReferenceWorld,
    private readonly plan: ValidatedGoalPlan,
    private readonly item: ValidatedGoalWorkItem,
  ) {}

  async execute(_request: CapabilityRequest, manifest: CapabilityManifest, runtime: CapabilityRuntime): Promise<ActionReceipt[]> {
    const runId = this.item.operationKey;
    const read = await runtime.execute(manifest, "read_stock", { sku: this.item.entityAliases[0]! }, { runId });
    const found = await runtime.execute(manifest, "find_restock", { operationKey: this.item.operationKey }, { runId });
    const receipts = [read, found];
    if (found.output.found !== true) {
      receipts.push(await runtime.execute(
        manifest,
        "create_restock",
        { sku: this.item.entityAliases[0]!, operationKey: this.item.operationKey },
        { runId },
      ));
    }
    return receipts.map((receipt, index) => ({
      action: ["read_stock", "find_restock", "create_restock"][index]!,
      status: receipt.status,
      output: receipt.output,
    }));
  }

  async verifyOutcome(): Promise<OutcomeReceipt> {
    return this.world.verify(this.plan, this.item, {
      status: "executed",
      path: "built-capability",
      childRunId: `child-${this.item.workItemId}`,
      operationKey: this.item.operationKey,
      writesAttempted: 1,
      summary: "Capability workflow completed.",
    });
  }

  async resume(): Promise<{ completed: boolean; summary: string }> {
    const outcome = await this.verifyOutcome();
    return {
      completed: outcome.passed && outcome.incorrectSideEffects === 0,
      summary: "The coordinator resumed the East Industrial work item from independently verified external state.",
    };
  }
}

export interface BroadGoalCapabilityLayerHandle {
  executor: GoalWorkItemExecutor;
  events: CapabilityEvent[];
  builder: StaticReferenceBuilder;
  close(): Promise<void>;
}

export async function startBroadGoalCapabilityLayer(
  world: BroadGoalReferenceWorld,
  registryDirectory: string,
  options: Pick<RuntimeConfiguration, "secretProvider" | "operationGuard"> = {},
): Promise<BroadGoalCapabilityLayerHandle> {
  const server = await BroadGoalHttpServer.start(world);
  const baseConfiguration = server.runtimeConfiguration();
  const runtimeResolver = new StaticRuntimeResolver({
    ...baseConfiguration,
    ...(options.secretProvider ? { secrets: {}, secretProvider: options.secretProvider } : {}),
    ...(options.operationGuard ? { operationGuard: options.operationGuard } : {}),
  });
  const builder = new StaticReferenceBuilder();
  const events: CapabilityEvent[] = [];
  const eventSink: CapabilityEventSink = { record: (event) => void events.push(event) };
  const coordinator = new CapabilityCoordinator({
    store: new FileTenantCapabilityStore(registryDirectory),
    builder,
    verifier: new EastIndustrialCapabilityVerifier(world, runtimeResolver),
    runtimeResolver,
    events: eventSink,
  });
  const sdk = new CapabilityFactorySdk({ coordinator, runtimeResolver, events: eventSink });
  const executor: GoalWorkItemExecutor = {
    execute: async (input: GoalWorkItemExecutionInput): Promise<GoalWorkItemExecutionResult> => {
      if (!input.item.coverageKeys.includes("coverage-crates")) return world.execute(input);
      const childRunId = `child-${input.item.workItemId}`;
      const request: CapabilityRequest = {
        context: {
          tenantId: input.plan.tenantId,
          requestId: childRunId,
          workflowKey: input.item.workflowKey,
          ordinaryGoal: input.item.summary,
          blockedAt: new Date().toISOString(),
          blockedReason: "The configured customer abilities do not expose the documented East Industrial restock API.",
          visibility: "full",
          correlation: input.item.correlation,
        },
        need: {
          key: "east-industrial-restock",
          summary: "Read stock, reconcile the stable operation, and create one exact restock if absent.",
          requiredActions: [...input.item.requiredActions],
          targetAliases: [...input.item.targetAliases],
          secretAliases: [...input.item.authority.credentialAliases],
          documentationHash: DOCUMENTATION_HASH,
        },
        authority: {
          allowedTargetAliases: [...input.item.authority.targetAliases],
          allowedSecretAliases: [...input.item.authority.credentialAliases],
          allowedMethods: [...input.item.authority.methods],
          writeAuthority: "per-action-approval",
          approvedWriteActions: ["create_restock"],
        },
        runtimeProfile: "broad-goal-reference",
      };
      const result = await sdk.completeBlockedGoal(request, new EastIndustrialWorkflow(world, input.plan, input.item));
      if (result.status === "completed") {
        return {
          status: "executed",
          path: result.capabilitySource === "built"
            ? "built-capability"
            : result.capabilitySource === "reused"
              ? "retained-capability"
              : "trusted-tool",
          childRunId,
          operationKey: input.item.operationKey,
          writesAttempted: result.outcome.intendedWrites,
          summary: `Capability Factory completed the work item through a ${result.capabilitySource} capability.`,
        };
      }
      const safeBeforeExecution = ["authority-missing", "policy-denied", "build-failed", "verification-failed"].includes(result.handoff.reason);
      if (safeBeforeExecution) {
        return {
          status: "blocked",
          childRunId,
          operationKey: input.item.operationKey,
          writesAttempted: 0,
          handoff: result.handoff,
        };
      }
      return {
        status: result.handoff.incident?.externalOutcome === "incorrect" ? "failed" : "unknown",
        childRunId,
        operationKey: input.item.operationKey,
        writesAttempted: result.handoff.incident?.externalOutcome === "not-started" ? 0 : 1,
        summary: result.handoff.summary,
      };
    },
  };
  return { executor, events, builder, close: () => server.close() };
}
