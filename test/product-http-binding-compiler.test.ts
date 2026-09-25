import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeApprovedOpenApiMaterial } from "../src/product/approved-openapi-normalizer.js";
import {
  assertCompiledHttpBindingPairIntegrity,
  compileReviewedHttpBindings,
  httpActionGrantDigest,
  type CompiledHttpBindingPair,
  type CompiledHttpRequest,
  type CustomerLocalCredentialResolver,
  type CustomerLocalHttpTransport,
  type HttpActionExecutionGrant,
} from "../src/product/http-binding-compiler.js";
import { proposeHttpBindings, type HttpBindingFactoryFacts } from "../src/product/http-binding-factory.js";
import { createLocalFixtureBindingQualification } from "../src/product/customer-local-binding-qualification.js";
import {
  JsonFileGenericAcceptanceCampaignStore,
  runGenericAcceptanceCampaign,
  type GenericAcceptanceAttemptContext,
  type GenericAcceptanceBinding,
} from "../src/product/generic-acceptance-executor.js";
import type { ApprovedOpenApiMaterial } from "../src/product/onboarding-adapter-factory.js";
import { compileAuthorityWizard } from "../src/product/onboarding-verifier-authority.js";
import {
  REQUIRED_PILOT_ADAPTER_CASES,
  type PilotAdapterAcceptanceCase,
  type PilotAdapterAcceptanceResult,
} from "../src/product/pilot-adapter.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const nowEpoch = Date.parse("2026-08-14T12:00:00.000Z");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function openApi(): ApprovedOpenApiMaterial {
  return {
    kind: "openapi",
    materialId: "northstar-orders-v1",
    localReference: "fixtures/northstar-orders-openapi.json",
    approved: true,
    targetAlias: "northstar_sandbox",
    document: {
      openapi: "3.1.0",
      info: { title: "Northstar Orders", version: "1.0.0" },
      servers: [{ url: "https://northstar.local.invalid/v1" }],
      paths: {
        "/orders": {
          post: {
            operationId: "createOrder",
            security: [{ northstarWriter: [] }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["order_ref", "sku", "quantity"],
                    properties: {
                      order_ref: { type: "string" },
                      sku: { type: "string" },
                      quantity: { type: "integer" },
                    },
                  },
                },
              },
            },
            responses: { "201": { description: "Created" }, "409": { description: "Conflict" } },
          },
          get: {
            operationId: "listOrders",
            security: [{ northstarObserver: [] }],
            parameters: [{ name: "order_ref", in: "query", required: true, schema: { type: "string" } }],
            responses: {
              "200": {
                description: "Matching orders",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        items: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              order_ref: { type: "string" },
                              sku: { type: "string" },
                              quantity: { type: "integer" },
                              status: { type: "string" },
                            },
                          },
                        },
                        server_time: { type: "string", format: "date-time" },
                        collateral_clean: { type: "boolean" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        securitySchemes: {
          northstarWriter: { type: "http", scheme: "bearer" },
          northstarObserver: { type: "http", scheme: "bearer" },
        },
      },
    },
  };
}

function reviewedNormalization() {
  const first = normalizeApprovedOpenApiMaterial(openApi());
  return normalizeApprovedOpenApiMaterial(openApi(), {
    materialDigest: first.originalMaterialDigest,
    selectedUrl: "https://northstar.local.invalid/v1",
    confirmedByAlias: "fixtureEngineer",
    confirmedAt: "2026-08-14T11:00:00.000Z",
  });
}

function reviewedAuthority() {
  return compileAuthorityWizard({
    schemaVersion: "1.0",
    systemsAndTargets: { aliases: ["northstar_sandbox"], confirmed: true },
    credentialAliases: { aliases: ["northstarWriter", "northstarObserver"], confirmed: true },
    readsAllowed: { actions: [{ actionName: "listOrders", targetAlias: "northstar_sandbox" }], confirmed: true },
    writes: [{ actionName: "createOrder", targetAlias: "northstar_sandbox", method: "POST", policy: "preauthorized", confirmed: true }],
    limits: {
      monetary: { kind: "none", confirmed: true },
      quantityPerAction: { kind: "limit", maximum: 100, confirmed: true },
      actionsPerHour: { kind: "limit", maximum: 100, confirmed: true },
    },
    forbiddenActions: { actionNames: ["deleteOrder"], confirmed: true },
    approver: { kind: "not-required", confirmed: true },
    retryAndReconciliation: { reconcileBeforeRetry: true, blindRetryAllowed: false, maximumAttempts: 1, confirmed: true },
    finalConsequentialReview: { confirmed: true },
  });
}

function confirmedFacts(): HttpBindingFactoryFacts {
  return {
    targetAlias: "northstar_sandbox",
    ordinaryBusinessOutcome: "Exactly one draft order exists for the requested order reference, SKU and quantity.",
    outcomeConfirmed: true,
    action: {
      driverId: "northstar-action-driver",
      operationId: "createOrder",
      operationConfirmed: true,
      credentialAlias: "northstarWriter",
      requestMappings: [
        { source: { kind: "workflow-input", inputKey: "orderRef", confirmed: true }, destination: { location: "json-body", path: ["order_ref"] }, transform: "identity", confirmed: true },
        { source: { kind: "workflow-input", inputKey: "sku", confirmed: true }, destination: { location: "json-body", path: ["sku"] }, transform: "identity", confirmed: true },
        { source: { kind: "workflow-input", inputKey: "quantity", confirmed: true }, destination: { location: "json-body", path: ["quantity"] }, transform: "identity", confirmed: true },
      ],
      requestMappingsConfirmed: true,
      reconcileBeforeRetry: true,
      blindRetryAllowed: false,
    },
    observer: {
      driverId: "northstar-observer-driver",
      sourceId: "northstar-read-model",
      operationId: "listOrders",
      operationConfirmed: true,
      credentialAlias: "northstarObserver",
      independentlyAuthenticated: true,
      independentFromActionDriver: true,
      parameterBindings: [{
        name: "order_ref",
        location: "query",
        source: { kind: "workflow-input", inputKey: "orderRef", confirmed: true },
        purpose: "stable-identifier",
        confirmed: true,
      }],
      resultPath: ["items"],
      resultPathConfirmed: true,
      pagination: { kind: "not-paginated", confirmed: true },
      freshness: { kind: "server-timestamp-body", path: ["server_time"], maximumAgeSeconds: 30, confirmed: true },
    },
    outcome: {
      predicates: [
        { key: "single-order", path: ["items"], operator: "count-equals", expectedCount: 1, confirmed: true },
        { key: "matching-reference", path: ["items", 0, "order_ref"], operator: "equals-input", inputKey: "orderRef", confirmed: true },
        { key: "matching-sku", path: ["items", 0, "sku"], operator: "equals-input", inputKey: "sku", confirmed: true },
        { key: "matching-quantity", path: ["items", 0, "quantity"], operator: "equals-input", inputKey: "quantity", confirmed: true },
      ],
      duplicateCheck: { collectionPath: ["items"], uniqueKeyPath: ["order_ref"], expectedCount: 1, confirmed: true },
      collateralChecks: [{ key: "collateral-clean", path: ["collateral_clean"], operator: "equals-confirmed", expected: true, confirmed: true }],
      notStartedDefinition: [{ key: "no-order", path: ["items"], operator: "count-equals", expectedCount: 0, confirmed: true }],
      confirmed: true,
    },
  };
}

function reviewedDeclarations() {
  return proposeHttpBindings({
    schemaVersion: "1.0",
    normalization: reviewedNormalization(),
    authorityCompilation: reviewedAuthority(),
    facts: confirmedFacts(),
  });
}

interface Order {
  order_ref: string;
  sku: string;
  quantity: number;
  status: "draft";
}

class NorthstarWorld {
  readonly orders = new Map<string, Order>();
  writes = 0;
  loseNextActionResponse = false;
  collateralClean = true;
  observedAt = "2026-08-14T12:00:00.000Z";

  reset(): void {
    this.orders.clear();
    this.writes = 0;
    this.loseNextActionResponse = false;
    this.collateralClean = true;
    this.observedAt = "2026-08-14T12:00:00.000Z";
  }

  actionTransport(): CustomerLocalHttpTransport {
    return {
      driverId: "northstar-action-driver",
      sourceId: "northstar-write-api",
      serverUrl: "https://northstar.local.invalid/v1",
      implementationDigest: hash("northstar isolated action transport v1"),
      supportedMethods: ["POST"],
      independentlyAuthenticated: true,
      independentFromDriverIds: [],
      perform: async (request, credential) => {
        if (credential.alias !== "northstarWriter" || request.operationId !== "createOrder" || request.method !== "POST") throw new Error("Action boundary mismatch.");
        const body = request.body as { order_ref?: unknown; sku?: unknown; quantity?: unknown };
        const candidate: Order = {
          order_ref: String(body.order_ref),
          sku: String(body.sku),
          quantity: Number(body.quantity),
          status: "draft",
        };
        const existing = this.orders.get(request.reconciliationKey);
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(candidate)) throw new Error("Conflicting reconciliation-key reuse.");
        } else {
          this.orders.set(request.reconciliationKey, candidate);
          this.writes += 1;
        }
        if (this.loseNextActionResponse) {
          this.loseNextActionResponse = false;
          throw new Error("Simulated response loss after commit.");
        }
        return { status: 201, headers: {}, body: { accepted: true } };
      },
    };
  }

  observerTransport(): CustomerLocalHttpTransport {
    return {
      driverId: "northstar-observer-driver",
      sourceId: "northstar-read-model",
      serverUrl: "https://northstar.local.invalid/v1",
      implementationDigest: hash("northstar separately authenticated observer transport v1"),
      supportedMethods: ["GET"],
      independentlyAuthenticated: true,
      independentFromDriverIds: ["northstar-action-driver"],
      perform: async (request, credential) => {
        if (credential.alias !== "northstarObserver" || request.operationId !== "listOrders" || request.method !== "GET") throw new Error("Observer boundary mismatch.");
        const reference = request.query.order_ref;
        const order = reference ? this.orders.get(reference) : undefined;
        return {
          status: 200,
          headers: {},
          body: {
            items: order ? [structuredClone(order)] : [],
            server_time: this.observedAt,
            collateral_clean: this.collateralClean,
          },
        };
      },
    };
  }
}

class LocalResolver implements CustomerLocalCredentialResolver {
  readonly resolverId = "northstar-local-resolver";
  readonly implementationDigest = hash("northstar local resolver implementation v1");
  readonly allowedAliases = ["northstarWriter", "northstarObserver"];
  missing = new Set<string>();

  async resolve(alias: string) {
    return this.missing.has(alias) ? null : { alias, value: `opaque-local-handle-for-${alias}` };
  }
}

function compile(world: NorthstarWorld, resolver: LocalResolver): CompiledHttpBindingPair {
  const factoryResult = reviewedDeclarations();
  const actionTransport = world.actionTransport();
  const observerTransport = world.observerTransport();
  const qualification = createLocalFixtureBindingQualification({ tenantId: "northstar-tenant", sessionId: "northstar-session", packageDigest: hash("northstar-package"), sourceDigest: factoryResult.actionBinding!.provenance.normalizedMaterialDigest, factoryResult, actionTransport, observerTransport, credentialResolver: resolver, qualifiedAt: "2026-08-14T11:30:00.000Z", expiresAt: "2026-09-13T11:30:00.000Z" });
  return compileReviewedHttpBindings({
    factoryResult,
    actionTransport,
    observerTransport,
    credentialResolver: resolver,
    primitiveRegistryDigest: hash("constrained HTTP primitive registry v1"),
    verifierRegistryDigest: hash("compiled observer registry v1"),
    qualifiedAt: "2026-08-14T11:30:00.000Z",
    expiresAt: "2026-09-13T11:30:00.000Z",
    customerLocalQualification: qualification,
    now: () => nowEpoch,
  });
}

function workflow(reference: string, sku = "SKU-RED", quantity = 3) {
  return { orderRef: reference, sku, quantity };
}

function grant(pair: CompiledHttpBindingPair, reference: string): HttpActionExecutionGrant {
  const payload: Omit<HttpActionExecutionGrant, "grantDigest"> = {
    schemaVersion: "1.0",
    decision: "authorized",
    authorityCompilationDigest: reviewedDeclarations().actionBinding!.provenance.authorityCompilationDigest,
    actionDeclarationDigest: pair.action.declarationDigest,
    targetAlias: "northstar_sandbox",
    operationId: "createOrder",
    method: "POST",
    parentGoalId: `goal-${reference.toLowerCase()}`,
    workItemId: `item-${reference.toLowerCase()}`,
    authorizedAt: "2026-08-14T11:59:00.000Z",
    expiresAt: "2026-08-14T12:01:00.000Z",
  };
  return { ...payload, grantDigest: httpActionGrantDigest(payload) };
}

function actionInput(pair: CompiledHttpBindingPair, reference: string, sku = "SKU-RED", quantity = 3) {
  return {
    requestId: `request-${reference.toLowerCase()}`,
    parentGoalId: `goal-${reference.toLowerCase()}`,
    workItemId: `item-${reference.toLowerCase()}`,
    workflowInput: workflow(reference, sku, quantity),
    trustedContext: {},
    grant: grant(pair, reference),
  };
}

function observationInput(reference: string, sku = "SKU-RED", quantity = 3) {
  return {
    requestId: `observe-${reference.toLowerCase()}`,
    parentGoalId: `goal-${reference.toLowerCase()}`,
    workItemId: `item-${reference.toLowerCase()}`,
    workflowInput: workflow(reference, sku, quantity),
    trustedContext: {},
    operationStartedAtEpochMs: Date.parse("2026-08-14T11:59:59.000Z"),
  };
}

function acceptanceResult(caseId: PilotAdapterAcceptanceCase, passed: boolean, intendedWrites: number, details: string[]): PilotAdapterAcceptanceResult {
  return {
    caseId,
    passed,
    intendedWrites,
    incorrectSideEffects: 0,
    checks: details.map((detail, index) => ({ id: `${caseId}-${index + 1}`, passed, detail })),
    artifactReferences: [`memory://northstar/${caseId}`],
    completedAt: "2026-08-14T12:00:00.000Z",
  };
}

class CompiledPairAcceptanceBinding implements GenericAcceptanceBinding {
  readonly bindingId = "northstar-compiled-http-pair";
  readonly bindingVersion = "1.0.0";
  readonly caseIds = [...REQUIRED_PILOT_ADAPTER_CASES];
  readonly bindingDigest: string;
  loseApprovedWriteForExecutorRestart: boolean;

  constructor(
    private readonly world: NorthstarWorld,
    private readonly resolver: LocalResolver,
    private pair: CompiledHttpBindingPair,
    options: { interruptApprovedWrite?: boolean } = {},
  ) {
    this.bindingDigest = pair.pairDigest;
    this.loseApprovedWriteForExecutorRestart = options.interruptApprovedWrite ?? false;
  }

  private async writeAndObserve(reference: string, options: { loseResponse?: boolean; pair?: CompiledHttpBindingPair; sku?: string } = {}) {
    const pair = options.pair ?? this.pair;
    if (options.loseResponse) this.world.loseNextActionResponse = true;
    let actionLost = false;
    try {
      await pair.action.execute(actionInput(pair, reference, options.sku));
    } catch (error) {
      actionLost = /response loss/i.test(String(error));
      if (!actionLost) throw error;
    }
    const observed = await pair.observer.observe(observationInput(reference, options.sku));
    return { observed, actionLost };
  }

  async execute(caseId: PilotAdapterAcceptanceCase, _context: GenericAcceptanceAttemptContext): Promise<PilotAdapterAcceptanceResult> {
    this.world.reset();
    this.resolver.missing.clear();
    if (caseId === "read-only-happy-path") {
      this.world.orders.set("READ-1", { order_ref: "READ-1", sku: "SKU-RED", quantity: 3, status: "draft" });
      const observed = await this.pair.observer.observe(observationInput("READ-1"));
      return acceptanceResult(caseId, observed.classification === "completed" && this.world.writes === 0, 0, ["Independent read completed without a write."]);
    }
    if (caseId === "approved-write") {
      if (this.loseApprovedWriteForExecutorRestart) {
        this.loseApprovedWriteForExecutorRestart = false;
        this.world.loseNextActionResponse = true;
        await this.pair.action.execute(actionInput(this.pair, "APPROVED-1"));
        throw new Error("Expected simulated response loss did not occur.");
      }
      const { observed } = await this.writeAndObserve("APPROVED-1");
      return acceptanceResult(caseId, observed.classification === "completed" && this.world.writes === 1, 1, ["Approved action and independent outcome check passed."]);
    }
    if (caseId === "fresh-process-reuse") {
      const freshPair = compile(this.world, this.resolver);
      const { observed } = await this.writeAndObserve("REUSE-1", { pair: freshPair });
      return acceptanceResult(caseId, observed.classification === "completed" && freshPair.pairDigest === this.pair.pairDigest, 1, ["A fresh compiled pair preserved the exact reviewed identity."]);
    }
    if (caseId === "missing-credential") {
      this.resolver.missing.add("northstarWriter");
      await expect(this.pair.action.execute(actionInput(this.pair, "NO-CRED-1"))).rejects.toThrow(/credential alias.*unavailable/i);
      return acceptanceResult(caseId, this.world.writes === 0, 0, ["Missing action credential stopped before transport."]);
    }
    if (caseId === "missing-permission") {
      const input = actionInput(this.pair, "NO-PERM-1");
      const { grant: _grant, ...withoutGrant } = input;
      await expect(this.pair.action.execute(withoutGrant)).rejects.toThrow(/authorization is missing/i);
      return acceptanceResult(caseId, this.world.writes === 0, 0, ["Missing exact authorization stopped before transport."]);
    }
    if (caseId === "lost-response-reconciliation") {
      const { observed, actionLost } = await this.writeAndObserve("LOST-1", { loseResponse: true });
      return acceptanceResult(caseId, actionLost && observed.classification === "completed" && this.world.writes === 1, 1, ["Lost response was reconciled through the independent observer without retry."]);
    }
    if (caseId === "wrong-or-partial-outcome") {
      this.world.orders.set("PARTIAL-1", { order_ref: "PARTIAL-1", sku: "WRONG-SKU", quantity: 3, status: "draft" });
      const observed = await this.pair.observer.observe(observationInput("PARTIAL-1"));
      return acceptanceResult(caseId, observed.classification === "partial" && !observed.passed, 0, ["A partial external outcome was rejected."]);
    }
    if (caseId === "sidecar-restart") {
      const before = await this.writeAndObserve("RESTART-1");
      const restarted = compile(this.world, this.resolver);
      const after = await restarted.observer.observe(observationInput("RESTART-1"));
      return acceptanceResult(caseId, before.observed.passed && after.passed && restarted.pairDigest === this.pair.pairDigest, 1, ["A new compiled process recovered the same reviewed pair and state."]);
    }
    if (caseId === "duplicate-submission") {
      await this.pair.action.execute(actionInput(this.pair, "DUP-1"));
      await this.pair.action.execute(actionInput(this.pair, "DUP-1"));
      const observed = await this.pair.observer.observe(observationInput("DUP-1"));
      return acceptanceResult(caseId, this.world.writes === 1 && observed.classification === "completed", 1, ["Exact duplicate submission produced one external write."]);
    }
    await this.pair.action.execute(actionInput(this.pair, "CONFLICT-1"));
    await expect(this.pair.action.execute(actionInput(this.pair, "CONFLICT-1", "DIFFERENT-SKU"))).rejects.toThrow(/conflicting reconciliation-key reuse/i);
    return acceptanceResult(caseId, this.world.writes === 1, 1, ["Conflicting reuse was rejected without a second write."]);
  }

  async reconcileInterrupted(caseId: PilotAdapterAcceptanceCase): Promise<PilotAdapterAcceptanceResult> {
    if (caseId !== "approved-write") throw new Error(`No reconciliation fixture exists for ${caseId}.`);
    const observed = await this.pair.observer.observe(observationInput("APPROVED-1"));
    return acceptanceResult(caseId, observed.classification === "completed" && this.world.writes === 1, 1, ["Restart reconciliation inspected independent external state and did not repeat the write."]);
  }
}

describe("reviewed HTTP binding compiler", () => {
  it("compiles exact declarations, qualifies the observer, and never activates the pair", () => {
    const world = new NorthstarWorld();
    const resolver = new LocalResolver();
    const pair = compile(world, resolver);
    expect(pair).toMatchObject({
      state: "compiled-acceptance-only",
      activated: false,
      customerValidated: false,
      action: { activated: false },
      observer: { activated: false },
      observerQualificationReceipt: { status: "qualified", controls: expect.any(Array) },
    });
    expect(pair.observerQualificationReceipt.controls).toHaveLength(11);
    expect(pair.observerQualificationReceipt.controls.every((control) => control.passed)).toBe(true);
    assertCompiledHttpBindingPairIntegrity(pair);
  });

  it("rejects mismatched transports, credential scope and mutated declarations", () => {
    const world = new NorthstarWorld();
    const resolver = new LocalResolver();
    expect(() => compileReviewedHttpBindings({
      factoryResult: reviewedDeclarations(),
      actionTransport: { ...world.actionTransport(), serverUrl: "https://wrong.invalid" },
      observerTransport: world.observerTransport(),
      credentialResolver: resolver,
      primitiveRegistryDigest: hash("constrained HTTP primitive registry v1"),
      verifierRegistryDigest: hash("compiled observer registry v1"),
      qualifiedAt: "2026-08-14T11:30:00.000Z",
      expiresAt: "2026-09-13T11:30:00.000Z",
    })).toThrow(/exact reviewed driver, server, and method/i);

    const declaration = reviewedDeclarations();
    declaration.actionBinding!.operation.pathTemplate = "/widened";
    expect(() => compileReviewedHttpBindings({
      factoryResult: declaration,
      actionTransport: world.actionTransport(),
      observerTransport: world.observerTransport(),
      credentialResolver: resolver,
      primitiveRegistryDigest: hash("constrained HTTP primitive registry v1"),
      verifierRegistryDigest: hash("compiled observer registry v1"),
      qualifiedAt: "2026-08-14T11:30:00.000Z",
      expiresAt: "2026-09-13T11:30:00.000Z",
    })).toThrow(/integrity/i);
  });

  it("fails observer access closed without its separately scoped credential and cannot accept an action response as proof", async () => {
    const world = new NorthstarWorld();
    const resolver = new LocalResolver();
    const pair = compile(world, resolver);
    world.orders.set("OBS-CRED-1", { order_ref: "OBS-CRED-1", sku: "SKU-RED", quantity: 3, status: "draft" });
    resolver.missing.add("northstarObserver");
    const observed = await pair.observer.observe(observationInput("OBS-CRED-1"));
    expect(observed).toMatchObject({
      classification: "unavailable",
      passed: false,
      nextAction: "handoff",
      incorrectSideEffects: 0,
      actionResponseUsedAsProof: false,
    });
    expect(pair.observerQualificationReceipt.controls.find((item) => item.controlId === "adversarial-action-response")).toMatchObject({ passed: true });
  });

  it("runs the compiled pair through all ten fixed cases with restart reconciliation and zero surviving incorrect effects", async () => {
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "cf-compiled-http-acceptance-"));
    temporaryDirectories.push(stateDirectory);
    const world = new NorthstarWorld();
    const resolver = new LocalResolver();
    const pair = compile(world, resolver);
    const first = await runGenericAcceptanceCampaign({
      campaignId: "compiled-http-v1-campaign",
      declarationDigest: pair.pairDigest,
      binding: new CompiledPairAcceptanceBinding(world, resolver, pair, { interruptApprovedWrite: true }),
      store: new JsonFileGenericAcceptanceCampaignStore(stateDirectory),
      now: () => "2026-08-14T12:00:00.000Z",
    });
    expect(first).toMatchObject({ status: "awaiting-reconciliation", passed: false, executedCases: 1 });
    expect(world.writes).toBe(1);

    const restartedPair = compile(world, resolver);
    const completed = await runGenericAcceptanceCampaign({
      campaignId: "compiled-http-v1-campaign",
      declarationDigest: pair.pairDigest,
      binding: new CompiledPairAcceptanceBinding(world, resolver, restartedPair),
      store: new JsonFileGenericAcceptanceCampaignStore(stateDirectory),
      now: () => "2026-08-14T12:00:00.000Z",
    });
    expect(completed).toMatchObject({
      status: "completed",
      passed: true,
      declaredCases: 10,
      executedCases: 10,
      reconciledCases: 1,
      passedCases: 10,
      incorrectSideEffects: 0,
    });
    expect(completed.state.receipts).toHaveLength(10);
    expect(completed.state.receipts.find((receipt) => receipt.caseId === "approved-write")?.source).toBe("interrupted-reconciliation");
    expect(completed.state.receipts.find((receipt) => receipt.caseId === "lost-response-reconciliation")?.result.passed).toBe(true);
    expect(completed.state.receipts.find((receipt) => receipt.caseId === "duplicate-submission")?.result.intendedWrites).toBe(1);

    const replayed = await runGenericAcceptanceCampaign({
      campaignId: "compiled-http-v1-campaign",
      declarationDigest: pair.pairDigest,
      binding: new CompiledPairAcceptanceBinding(world, resolver, compile(world, resolver)),
      store: new JsonFileGenericAcceptanceCampaignStore(stateDirectory),
      now: () => "2026-08-14T12:00:00.000Z",
    });
    expect(replayed.state.cases.every((record) => record.attemptCount === 1)).toBe(true);
    expect(replayed.state.receipts).toHaveLength(10);
  });
});
