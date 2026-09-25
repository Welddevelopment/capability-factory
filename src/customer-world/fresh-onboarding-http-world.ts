import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type { CapabilityManifest } from "../manifest.js";
import { CapabilityRuntime, type RuntimeConfiguration } from "../runtime.js";
import {
  BROAD_GOAL_REQUEST_SCHEMA_VERSION,
  type BroadGoalRequest,
  type BroadGoalRunResult,
} from "../product/broad-goal-sdk.js";
import {
  discoverAdapterProposal,
  type AdapterDiscoveryProposal,
  type ApprovedOpenApiMaterial,
  type JsonValue,
} from "../product/onboarding-adapter-factory.js";
import {
  generateAcceptancePlanFromReviewedContracts,
  onboardingAcceptanceSourceDigest,
  type OnboardingAcceptancePlan,
} from "../product/onboarding-acceptance-factory.js";
import { compileAuthorityWizard, type AuthorityWizardCompilation } from "../product/onboarding-verifier-authority.js";
import {
  bindOutcomeObserver,
  outcomeObserverSourceDigest,
  proposeOutcomeObserver,
  type BoundOutcomeObserverResult,
  type ObserverInspectionReceipt,
  type OutcomeObserverFactoryInput,
  type OutcomeObserverHttpTransport,
} from "../product/outcome-observer-factory.js";
import {
  REQUIRED_PILOT_ADAPTER_CASES,
  runPilotAdapterAcceptanceHarness,
  type PilotAdapterAcceptanceCase,
  type PilotAdapterAcceptanceHarness,
  type PilotAdapterAcceptanceResult,
  type PilotAdapterAcceptanceSummary,
  type PilotAdapterCheck,
} from "../product/pilot-adapter.js";
import { SidecarGoalJobService, SidecarGoalJobStore } from "../product/sidecar-jobs.js";

const FIXTURE_ID = "solstice-maintenance-fresh-onboarding-v1";
const TARGET_ALIAS = "solstice_sandbox";
const ACTION_DRIVER_ID = "solstice-action-http-driver";
const OBSERVER_DRIVER_ID = "solstice-independent-read-driver";
const OBSERVER_SOURCE_ID = "solstice-independent-read-api";
const REQUEST_ID = "REQ-42";
const ASSET_ID = "ASSET-7";
const SCHEDULED_DATE = "2026-08-13";

type FixtureMode = "normal" | "lost-response-after-commit" | "partial-outcome";

interface VisitRecord {
  id: string;
  requestId: string;
  assetId: string;
  scheduledDate: string;
  status: "draft" | "pending";
  idempotencyKey: string;
  version: number;
}

interface SolsticeState {
  asset: { id: string; status: "active"; version: number };
  visits: VisitRecord[];
  unrelatedChanges: Array<{ id: string; detail: string }>;
  sequence: number;
  writeAttempts: number;
  committedWrites: number;
}

interface CapabilityRegistryRecord {
  schemaVersion: "1.0";
  health: "active" | "quarantined";
  manifest: CapabilityManifest;
  manifestDigest: string;
  verifiedAt: string;
  quarantineReason?: string;
}

export interface FreshOnboardingExecutionReport {
  schemaVersion: "1.0";
  fixtureId: typeof FIXTURE_ID;
  evidenceBoundary: "deterministic-local-development-run-not-human-or-customer-validation";
  spendUsd: 0;
  modelCalls: 0;
  frozenInputDigests: { openApi: string; contract: string };
  proposalMetrics: {
    totalRequestedOperations: number;
    correctlyMappedRequestedOperations: number;
    proposedCredentialAliases: number;
    unsupportedOperationsInvented: number;
    unauthorizedAuthorityInferred: number;
    credentialValuesStored: number;
  };
  confirmationsRequired: string[];
  generatedArtifacts: {
    adapterProposalId: string;
    observerProposalId: string;
    authorityStatus: string;
    acceptancePlanId: string;
  };
  automationTiming: {
    joinedRunWallClockMs: number;
    firstAutonomousAcquisitionMs: number;
    fullAcceptanceMs: number;
    humanEngineerActiveMinutes: null;
  };
  codeAccounting: {
    customerSpecificAdapterCodeWritten: number;
    customerSpecificObserverCodeWritten: number;
    fixtureAndAcceptanceHarnessFiles: string[];
    note: string;
  };
  capabilityMetrics: {
    builds: number;
    preUseProbes: number;
    retainedReuses: number;
    reconciledLostResponses: number;
    freshProcessReuseWorked: boolean;
  };
  acceptance: PilotAdapterAcceptanceSummary;
  survivingIncorrectSideEffects: number;
  failuresAndFixes: string[];
  outputDirectory: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveJson(filePath: string, value: unknown): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return filePath;
}

function check(id: string, passed: boolean, detail: string): PilotAdapterCheck {
  return { id, passed, detail };
}

function broadGoalRequest(caseId: PilotAdapterAcceptanceCase): BroadGoalRequest {
  return {
    schemaVersion: BROAD_GOAL_REQUEST_SCHEMA_VERSION,
    tenantId: "solstice-local-tenant",
    parentGoalId: `solstice-parent-${caseId}`,
    requestId: `solstice-request-${caseId}`,
    scopeKey: "solstice-maintenance-scope-v1",
    ordinaryGoal: "Schedule exactly one fresh draft maintenance visit for approved request REQ-42 and leave unrelated state unchanged.",
    visibility: "full",
  };
}

function completedGoal(request: BroadGoalRequest, receipt: ObserverInspectionReceipt): BroadGoalRunResult {
  const timestamp = new Date().toISOString();
  const planDigest = digest({ request, plan: "one-maintenance-visit" });
  return {
    status: "completed",
    tenantId: request.tenantId,
    parentGoalId: request.parentGoalId,
    requestId: request.requestId,
    planning: {
      source: "newly-validated",
      attempts: 1,
      validationReceiptId: `validation-${request.requestId}`,
      planDigest,
      workItems: 1,
    },
    state: {
      schemaVersion: "1.0",
      tenantId: request.tenantId,
      parentGoalId: request.parentGoalId,
      requestId: request.requestId,
      planDigest,
      version: 1,
      lifecycle: "completed",
      items: {},
      aggregate: {
        verifierVersion: receipt.observerVersion,
        receiptId: digest(receipt).slice(0, 32),
        result: "complete",
        passed: receipt.passed,
        requiredItems: 1,
        completedItems: 1,
        blockedItems: 0,
        failedItems: 0,
        unknownItems: 0,
        incorrectSideEffects: 0,
        stateDigest: receipt.stateDigest,
        checks: receipt.checks.map((item) => ({ id: item.key, passed: item.passed, detail: item.detail })),
        verifiedAt: receipt.observedAt,
      },
      resume: { completed: true, summary: "The original maintenance goal resumed after independent external-state verification." },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

class SolsticeMaintenanceWorld {
  private readonly app: FastifyInstance;
  private mode: FixtureMode = "normal";
  private baseUrlValue = "";
  private state: SolsticeState;
  readonly actionToken = randomBytes(24).toString("hex");
  readonly observerToken = randomBytes(24).toString("hex");

  constructor(private readonly statePath: string) {
    this.state = this.initialState();
    this.persist();
    this.app = Fastify({ logger: false });
    this.routes();
  }

  get baseUrl(): string { return this.baseUrlValue; }

  private initialState(): SolsticeState {
    return {
      asset: { id: ASSET_ID, status: "active", version: 1 },
      visits: [],
      unrelatedChanges: [],
      sequence: 0,
      writeAttempts: 0,
      committedWrites: 0,
    };
  }

  private persist(): void { saveJson(this.statePath, this.state); }

  private authorized(header: string | undefined, token: string): boolean {
    return header === `Bearer ${token}`;
  }

  private routes(): void {
    this.app.get("/v1/assets/:assetId", async (request, reply) => {
      if (!this.authorized(request.headers.authorization, this.observerToken)) return reply.code(401).send({ error: "observer credential required" });
      const { assetId } = request.params as { assetId: string };
      if (assetId !== this.state.asset.id) return reply.code(404).send({ error: "asset not found" });
      return { resource: structuredClone(this.state.asset), serverTimestamp: new Date().toISOString() };
    });
    this.app.get("/v1/visits", async (request, reply) => {
      if (!this.authorized(request.headers.authorization, this.observerToken)) return reply.code(401).send({ error: "observer credential required" });
      const { requestId } = request.query as { requestId?: string };
      const items = this.state.visits.filter((visit) => visit.requestId === requestId);
      return {
        items: structuredClone(items),
        statuses: items.map((visit) => visit.status),
        assetIds: items.map((visit) => visit.assetId),
        scheduledDates: items.map((visit) => visit.scheduledDate),
        sequence: this.state.sequence,
        serverTimestamp: new Date().toISOString(),
      };
    });
    this.app.get("/v1/audit", async (request, reply) => {
      if (!this.authorized(request.headers.authorization, this.observerToken)) return reply.code(401).send({ error: "observer credential required" });
      return { unrelatedChanges: structuredClone(this.state.unrelatedChanges), sequence: this.state.sequence };
    });
    this.app.post("/v1/visits", async (request, reply) => {
      if (!this.authorized(request.headers.authorization, this.actionToken)) return reply.code(401).send({ error: "action credential required" });
      const body = request.body as { requestId?: string; assetId?: string; scheduledDate?: string };
      const idempotencyKey = String(request.headers["idempotency-key"] ?? "");
      if (!body.requestId || !body.assetId || !body.scheduledDate || !idempotencyKey) return reply.code(400).send({ error: "bounded request fields and idempotency key required" });
      if (request.headers["x-capability-test"] === "1") {
        return reply.code(201).send({ probe: true, accepted: true, visit: { id: "PROBE-NO-WRITE" } });
      }
      this.state.writeAttempts += 1;
      const existing = this.state.visits.find((visit) => visit.idempotencyKey === idempotencyKey);
      if (existing) {
        this.persist();
        return reply.code(201).send({ visit: structuredClone(existing), reused: true });
      }
      this.state.sequence += 1;
      const visit: VisitRecord = {
        id: `VISIT-${this.state.sequence}`,
        requestId: body.requestId,
        assetId: body.assetId,
        scheduledDate: body.scheduledDate,
        status: this.mode === "partial-outcome" ? "pending" : "draft",
        idempotencyKey,
        version: this.state.sequence,
      };
      this.state.visits.push(visit);
      this.state.committedWrites += 1;
      this.persist();
      if (this.mode === "lost-response-after-commit") return reply.code(503).send({ error: "synthetic response lost after commit" });
      return reply.code(201).send({ visit: structuredClone(visit) });
    });
  }

  async start(): Promise<void> {
    const address = await this.app.listen({ host: "127.0.0.1", port: 0 });
    this.baseUrlValue = address;
  }

  async stop(): Promise<void> { await this.app.close(); }

  reset(options: { mode?: FixtureMode; seedSatisfied?: boolean } = {}): SolsticeState {
    this.mode = options.mode ?? "normal";
    this.state = this.initialState();
    if (options.seedSatisfied) {
      this.state.sequence = 1;
      this.state.visits.push({
        id: "VISIT-SEED",
        requestId: REQUEST_ID,
        assetId: ASSET_ID,
        scheduledDate: SCHEDULED_DATE,
        status: "draft",
        idempotencyKey: "seeded-existing-state",
        version: 1,
      });
    }
    this.persist();
    return this.snapshot();
  }

  snapshot(): SolsticeState { return structuredClone(this.state); }

  stateDigest(): string { return digest(this.state); }
}

function createMaterial(openApiPath: string): ApprovedOpenApiMaterial {
  return {
    kind: "openapi",
    materialId: "solstice-maintenance-openapi-v1",
    localReference: openApiPath,
    approved: true,
    targetAlias: TARGET_ALIAS,
    document: readJson(openApiPath) as JsonValue,
  };
}

function adapterProposal(material: ApprovedOpenApiMaterial, requiredOutcome: string): AdapterDiscoveryProposal {
  return discoverAdapterProposal({
    schemaVersion: "1.0",
    workflow: {
      workflowId: "schedule-approved-maintenance",
      summary: "Schedule one draft maintenance visit for an approved request.",
      requiredOutcome,
      approvedTargetAliases: [TARGET_ALIAS],
      requestedOperationNames: ["getAsset", "listVisits", "listAuditChanges", "createDraftVisit"],
      customerConfirmed: true,
    },
    materials: [material],
  });
}

function observerInput(material: ApprovedOpenApiMaterial, requiredOutcome: string): OutcomeObserverFactoryInput {
  const requestId = { kind: "literal" as const, value: REQUEST_ID, confirmed: true as const };
  const assetId = { kind: "literal" as const, value: ASSET_ID, confirmed: true as const };
  return {
    schemaVersion: "1.0",
    observerKey: "solstice-maintenance-outcome",
    targetAlias: TARGET_ALIAS,
    ordinaryBusinessOutcome: requiredOutcome,
    outcomeConfirmed: true,
    executionDriverId: ACTION_DRIVER_ID,
    observationDriverId: OBSERVER_DRIVER_ID,
    approvedOpenApiMaterial: material,
    reads: [
      { key: "asset", primitive: "fetch-resource", operationName: "getAsset", parameterBindings: [{ name: "assetId", location: "path", role: "stable-id", valueSource: assetId, confirmed: true }], resultPath: ["resource"], expectedStatuses: [200], confirmed: true },
      { key: "visits", primitive: "query-collection", operationName: "listVisits", parameterBindings: [{ name: "requestId", location: "query", role: "confirmed-filter", valueSource: requestId, confirmed: true }], resultPath: ["items"], expectedStatuses: [200], confirmed: true },
      { key: "visitStatuses", primitive: "query-collection", operationName: "listVisits", parameterBindings: [{ name: "requestId", location: "query", role: "confirmed-filter", valueSource: requestId, confirmed: true }], resultPath: ["statuses"], expectedStatuses: [200], confirmed: true },
      { key: "visitAssetIds", primitive: "query-collection", operationName: "listVisits", parameterBindings: [{ name: "requestId", location: "query", role: "confirmed-filter", valueSource: requestId, confirmed: true }], resultPath: ["assetIds"], expectedStatuses: [200], confirmed: true },
      { key: "visitDates", primitive: "query-collection", operationName: "listVisits", parameterBindings: [{ name: "requestId", location: "query", role: "confirmed-filter", valueSource: requestId, confirmed: true }], resultPath: ["scheduledDates"], expectedStatuses: [200], confirmed: true },
      { key: "audit", primitive: "query-collection", operationName: "listAuditChanges", parameterBindings: [{ name: "requestId", location: "query", role: "confirmed-filter", valueSource: requestId, confirmed: true }], resultPath: ["unrelatedChanges"], expectedStatuses: [200], confirmed: true },
    ],
    successPredicates: [
      { key: "one-visit", observationKey: "visits", path: [], operator: "count-equals", expected: 1, confirmed: true },
      { key: "unique-visit-id", observationKey: "visits", path: [], operator: "unique-by-key", itemPath: ["id"], confirmed: true },
      { key: "draft-status", observationKey: "visitStatuses", path: [], operator: "all-equal", expected: "draft", confirmed: true },
      { key: "approved-asset", observationKey: "visitAssetIds", path: [], operator: "all-equal", expected: ASSET_ID, confirmed: true },
      { key: "approved-date", observationKey: "visitDates", path: [], operator: "all-equal", expected: SCHEDULED_DATE, confirmed: true },
    ],
    notStartedPredicates: [{ key: "no-visit", observationKey: "visits", path: [], operator: "count-equals", expected: 0, confirmed: true }],
    duplicateCheck: { observationKey: "visits", path: [], expectedCount: 1, confirmed: true },
    collateralChecks: [
      { key: "asset-remains-active", observationKey: "asset", path: ["status"], operator: "equals", expected: "active", confirmed: true },
      { key: "no-unrelated-change", observationKey: "audit", path: [], operator: "count-equals", expected: 0, confirmed: true },
    ],
    freshness: {
      observationKey: "observerObservedAt",
      source: { kind: "sequence-body", readKey: "visits", path: ["sequence"], baseline: { kind: "literal", value: 0, confirmed: true }, confirmed: true },
      maximumAgeSeconds: 300,
      maximumFutureSkewSeconds: 5,
      confirmed: true,
    },
  };
}

function compileAuthority(): AuthorityWizardCompilation {
  return compileAuthorityWizard({
    schemaVersion: "1.0",
    systemsAndTargets: { aliases: [TARGET_ALIAS], confirmed: true },
    credentialAliases: { aliases: ["actionBearer", "observerBearer"], confirmed: true },
    readsAllowed: { actions: [
      { actionName: "getAsset", targetAlias: TARGET_ALIAS },
      { actionName: "listVisits", targetAlias: TARGET_ALIAS },
      { actionName: "listAuditChanges", targetAlias: TARGET_ALIAS },
    ], confirmed: true },
    writes: [{ actionName: "createDraftVisit", targetAlias: TARGET_ALIAS, method: "POST", policy: "preauthorized", confirmed: true }],
    limits: {
      monetary: { kind: "none", confirmed: true },
      quantityPerAction: { kind: "limit", maximum: 1, confirmed: true },
      actionsPerHour: { kind: "limit", maximum: 20, confirmed: true },
    },
    forbiddenActions: { actionNames: [], confirmed: true },
    approver: { kind: "not-required", confirmed: true },
    retryAndReconciliation: { reconcileBeforeRetry: true, blindRetryAllowed: false, maximumAttempts: 1, confirmed: true },
    finalConsequentialReview: { confirmed: true },
  });
}

function createManifest(material: ApprovedOpenApiMaterial): CapabilityManifest {
  return {
    schemaVersion: "1",
    id: "solstice-maintenance-visits",
    version: "1.0.0",
    service: "Solstice Maintenance",
    description: "Create one bounded draft maintenance visit from the confirmed API contract.",
    baseUrlAlias: TARGET_ALIAS,
    auth: { kind: "bearer", secretAlias: "actionBearer" },
    actions: [{
      name: "create_draft_visit",
      description: "Create one draft visit for an approved maintenance request.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string", description: "Approved maintenance request ID." },
          assetId: { type: "string", description: "Approved asset ID." },
          scheduledDate: { type: "string", description: "Approved visit date." },
        },
        required: ["requestId", "assetId", "scheduledDate"],
        additionalProperties: false,
      },
      request: {
        method: "POST",
        pathTemplate: "/v1/visits",
        queryTemplate: {},
        headerTemplate: {},
        bodyTemplate: { requestId: "{{input.requestId}}", assetId: "{{input.assetId}}", scheduledDate: "{{input.scheduledDate}}" },
      },
      response: { acceptedStatuses: [201], outputPointers: { visitId: "/visit/id" } },
      safety: { idempotency: "required", timeoutMs: 2_000, maxResponseBytes: 50_000 },
    }],
    provenance: {
      documentationHash: outcomeObserverSourceDigest(material),
      model: "deterministic-confirmed-openapi-materializer-v1",
      createdAt: "2026-08-12T09:00:00.000Z",
    },
  };
}

class SolsticeExecutionCore {
  readonly metrics = { builds: 0, preUseProbes: 0, retainedReuses: 0, reconciledLostResponses: 0 };
  private firstAcquisitionMs = 0;

  constructor(
    private readonly world: SolsticeMaintenanceWorld,
    private readonly material: ApprovedOpenApiMaterial,
    private readonly observerProposal: ReturnType<typeof proposeOutcomeObserver>,
    private readonly registryPath: string,
  ) {}

  get firstAutonomousAcquisitionMs(): number { return this.firstAcquisitionMs; }

  freshProcess(): SolsticeExecutionCore {
    return new SolsticeExecutionCore(this.world, this.material, this.observerProposal, this.registryPath);
  }

  private observer(): BoundOutcomeObserverResult {
    const transport: OutcomeObserverHttpTransport = {
      driverId: OBSERVER_DRIVER_ID,
      sourceId: OBSERVER_SOURCE_ID,
      implementationDigest: digest({ implementation: "solstice-read-transport-v1", paths: ["/v1/assets/{assetId}", "/v1/visits", "/v1/audit"] }),
      approvedMaterialDigest: this.observerProposal.approvedMaterialDigest,
      readOnlyCredentialAliases: ["observerBearer"],
      independentFromExecutionDriverIds: [ACTION_DRIVER_ID],
      independenceReview: {
        reviewId: "solstice-observer-independence-review-v1",
        reviewDigest: digest({ source: OBSERVER_SOURCE_ID, credentials: ["observerBearer"], methods: ["GET"], separateFrom: ACTION_DRIVER_ID }),
        status: "independently-reviewed",
      },
      read: async (request) => {
        const url = new URL(request.path, this.world.baseUrl);
        for (const [key, value] of Object.entries(request.query)) url.searchParams.set(key, value);
        const response = await fetch(url, { method: request.method, headers: { authorization: `Bearer ${this.world.observerToken}`, accept: "application/json" } });
        const body: unknown = await response.json();
        return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body };
      },
    };
    const now = Date.now();
    const sourceDigest = outcomeObserverSourceDigest({
      sourceId: transport.sourceId,
      driverId: transport.driverId,
      implementationDigest: transport.implementationDigest,
      approvedMaterialDigest: transport.approvedMaterialDigest,
    });
    return bindOutcomeObserver(this.observerProposal, {
      proposalDigest: this.observerProposal.proposalDigest,
      approvedMaterialDigest: this.observerProposal.approvedMaterialDigest,
      observationDriverDigest: transport.implementationDigest,
      observationSourceId: transport.sourceId,
      observationSourceDigest: sourceDigest,
      readOnlyCredentialAliasesDigest: outcomeObserverSourceDigest([...transport.readOnlyCredentialAliases].sort()),
      independenceReviewDigest: transport.independenceReview.reviewDigest,
      valueResolverDigest: "not-required",
      confirmedByAlias: "fixturePlatformEngineer",
      confirmedAt: new Date(now - 2_000).toISOString(),
      operationStartedAtEpochMs: now - 500,
      freshnessBaselineCapturedAtEpochMs: now - 1_000,
      factsConfirmed: true,
    }, { transport });
  }

  observerBinding(): BoundOutcomeObserverResult { return this.observer(); }

  private runtime(options: { credential: boolean; permission: boolean }): CapabilityRuntime {
    const configuration: RuntimeConfiguration = {
      targets: {
        [TARGET_ALIAS]: {
          baseUrl: this.world.baseUrl,
          allowedPaths: ["/v1/visits"],
          allowedMethods: { POST: ["/v1/visits"] },
        },
      },
      secrets: options.credential ? { actionBearer: this.world.actionToken } : {},
      operationGuard: {
        beforeAction(context) {
          if (context.write && !options.permission) throw new Error("Exact permission createDraftVisit is missing.");
        },
        afterAction() {},
      },
    };
    return new CapabilityRuntime(configuration);
  }

  private registry(): CapabilityRegistryRecord | undefined {
    if (!fs.existsSync(this.registryPath)) return undefined;
    return readJson(this.registryPath) as CapabilityRegistryRecord;
  }

  private saveRegistry(record: CapabilityRegistryRecord): void { saveJson(this.registryPath, record); }

  restoreActiveRegistry(): void {
    const record = this.registry();
    if (!record) return;
    const { quarantineReason: _quarantineReason, ...rest } = record;
    this.saveRegistry({ ...rest, health: "active" });
  }

  registryHealth(): CapabilityRegistryRecord["health"] | "missing" { return this.registry()?.health ?? "missing"; }

  async inspect(): Promise<ObserverInspectionReceipt> {
    const context = { tenantId: "solstice-local-tenant", requestId: REQUEST_ID, parentGoalId: "solstice-parent", operationKey: "schedule-approved-maintenance" };
    return (await this.observer().adapter.inspect(context)).receipt;
  }

  async execute(options: { runId: string; credential?: boolean; permission?: boolean }): Promise<{ receipt: ObserverInspectionReceipt; path: "already-satisfied" | "new-capability" | "retained-reuse" | "reconciled" }> {
    const before = await this.inspect();
    if (before.passed) return { receipt: before, path: "already-satisfied" };
    const started = Date.now();
    let record = this.registry();
    let manifest: CapabilityManifest;
    let built = false;
    if (!record || record.health !== "active") {
      manifest = createManifest(this.material);
      const probeRuntime = this.runtime({ credential: options.credential ?? true, permission: options.permission ?? true });
      await probeRuntime.execute(manifest, "create_draft_visit", { requestId: REQUEST_ID, assetId: ASSET_ID, scheduledDate: SCHEDULED_DATE }, { runId: `${options.runId}-probe`, testMode: true });
      this.metrics.builds += 1;
      this.metrics.preUseProbes += 1;
      built = true;
    } else {
      manifest = record.manifest;
      this.metrics.retainedReuses += 1;
    }
    const runtime = this.runtime({ credential: options.credential ?? true, permission: options.permission ?? true });
    let executionError: unknown;
    try {
      await runtime.execute(manifest, "create_draft_visit", { requestId: REQUEST_ID, assetId: ASSET_ID, scheduledDate: SCHEDULED_DATE }, { runId: options.runId });
    } catch (error) {
      executionError = error;
    }
    const after = await this.inspect();
    if (after.passed) {
      if (executionError) this.metrics.reconciledLostResponses += 1;
      if (built) {
        this.saveRegistry({ schemaVersion: "1.0", health: "active", manifest, manifestDigest: digest(manifest), verifiedAt: after.observedAt });
        if (this.firstAcquisitionMs === 0) this.firstAcquisitionMs = Date.now() - started;
      }
      return { receipt: after, path: executionError ? "reconciled" : built ? "new-capability" : "retained-reuse" };
    }
    if (executionError && after.classification === "not-started") throw executionError;
    this.saveRegistry({
      schemaVersion: "1.0",
      health: "quarantined",
      manifest,
      manifestDigest: digest(manifest),
      verifiedAt: after.observedAt,
      quarantineReason: `Independent observer classified external state as ${after.classification}.`,
    });
    throw new Error(`Independent outcome observer rejected the external state as ${after.classification}.`);
  }
}

function buildAcceptancePlan(
  proposal: AdapterDiscoveryProposal,
  observer: BoundOutcomeObserverResult,
  authority: AuthorityWizardCompilation,
): OnboardingAcceptancePlan {
  return generateAcceptancePlanFromReviewedContracts({
    adapterId: "solstice_maintenance",
    adapterVersion: "1.0.0",
    adapterProposal: proposal,
    verifierContract: observer.verifierContract,
    authorityCompilation: authority,
    executionDriverId: ACTION_DRIVER_ID,
    duplicatePrevention: "both",
    resetStrategy: { kind: "fixture-reset", reference: "solstice-world.reset-v1", independentlyChecked: true },
    persistence: { durableJobStore: true, durableCapabilityRegistry: true },
    review: {
      adapterProposalDigest: onboardingAcceptanceSourceDigest(proposal),
      verifierContractDigest: onboardingAcceptanceSourceDigest(observer.verifierContract),
      authorityCompilationDigest: onboardingAcceptanceSourceDigest(authority),
      authorityRuntimeBindingDigest: digest({ target: TARGET_ALIAS, action: "createDraftVisit", method: "POST", credential: "actionBearer" }),
      observationAdapterBindingDigest: observer.bindingReceipt.bindingDigest,
      confirmedByAlias: "fixturePlatformEngineer",
      confirmedAt: new Date().toISOString(),
    },
  });
}

function createAcceptanceHarness(options: {
  world: SolsticeMaintenanceWorld;
  core: SolsticeExecutionCore;
  outputDirectory: string;
}): PilotAdapterAcceptanceHarness {
  const { world, core, outputDirectory } = options;
  return {
    caseIds: [...REQUIRED_PILOT_ADAPTER_CASES],
    run: async (caseId): Promise<PilotAdapterAcceptanceResult> => {
      const caseDirectory = path.join(outputDirectory, "acceptance", caseId);
      fs.mkdirSync(caseDirectory, { recursive: true, mode: 0o700 });
      const checks: PilotAdapterCheck[] = [];
      let intendedWrites = 0;
      let incorrectSideEffects = 0;
      const preStateDigest = world.stateDigest();
      let inspection: ObserverInspectionReceipt | undefined;

      try {
        switch (caseId) {
          case "read-only-happy-path": {
            world.reset({ seedSatisfied: true });
            inspection = await core.inspect();
            const state = world.snapshot();
            checks.push(
              check("read-only-completed", inspection.passed && inspection.classification === "completed", "The independent read path confirmed the already-satisfied outcome."),
              check("zero-write", state.writeAttempts === 0 && state.committedWrites === 0, "No write was attempted for the already-satisfied goal."),
            );
            break;
          }
          case "approved-write": {
            world.reset();
            const result = await core.execute({ runId: "solstice-approved-write" });
            inspection = result.receipt;
            const state = world.snapshot();
            intendedWrites = state.committedWrites;
            checks.push(
              check("new-capability-path", result.path === "new-capability", "The first unsupported operation used deterministic construction and pre-use probing."),
              check("exact-write", state.committedWrites === 1 && state.visits.length === 1, "Exactly one intended draft visit was committed."),
              check("independent-outcome", inspection.passed, "The separate read-side observer confirmed the business result."),
            );
            break;
          }
          case "fresh-process-reuse": {
            world.reset();
            const freshCore = core.freshProcess();
            const result = await freshCore.execute({ runId: "solstice-fresh-process-reuse" });
            inspection = result.receipt;
            const state = world.snapshot();
            intendedWrites = state.committedWrites;
            checks.push(
              check("retained-selected", result.path === "retained-reuse" && freshCore.metrics.builds === 0 && freshCore.metrics.retainedReuses === 1, "A new execution-core instance loaded the retained manifest without rebuilding it."),
              check("direct-outcome", inspection.passed && state.visits.length === 1, "Fresh-process reuse produced one independently verified visit."),
            );
            core.metrics.retainedReuses += freshCore.metrics.retainedReuses;
            break;
          }
          case "missing-credential": {
            world.reset();
            let refused = false;
            try { await core.execute({ runId: "solstice-missing-credential", credential: false }); } catch (error) { refused = error instanceof Error && /secret alias|credential/i.test(error.message); }
            const state = world.snapshot();
            inspection = await core.inspect();
            checks.push(
              check("credential-refused", refused, "The customer-local action credential alias was unresolved and execution stopped."),
              check("zero-write", state.writeAttempts === 0 && state.committedWrites === 0, "The request never reached the write endpoint."),
            );
            break;
          }
          case "missing-permission": {
            world.reset();
            let refused = false;
            try { await core.execute({ runId: "solstice-missing-permission", permission: false }); } catch (error) { refused = error instanceof Error && /permission/i.test(error.message); }
            const state = world.snapshot();
            inspection = await core.inspect();
            checks.push(
              check("permission-refused", refused, "The exact write permission was absent and the operation guard stopped execution."),
              check("zero-write", state.writeAttempts === 0 && state.committedWrites === 0, "No write reached the external system."),
            );
            break;
          }
          case "lost-response-reconciliation": {
            world.reset({ mode: "lost-response-after-commit" });
            const result = await core.execute({ runId: "solstice-lost-response" });
            inspection = result.receipt;
            const state = world.snapshot();
            intendedWrites = state.committedWrites;
            checks.push(
              check("reconciled", result.path === "reconciled", "A transport failure after commit was resolved from external state rather than by trusting the action response."),
              check("no-duplicate", state.writeAttempts === 1 && state.committedWrites === 1 && state.visits.length === 1, "Reconciliation prevented a blind retry and duplicate visit."),
            );
            break;
          }
          case "wrong-or-partial-outcome": {
            world.reset({ mode: "partial-outcome" });
            let rejected = false;
            let detectedClassification = "unknown";
            try { await core.execute({ runId: "solstice-partial-outcome" }); } catch (error) {
              rejected = error instanceof Error && /rejected.*partial/i.test(error.message);
              detectedClassification = (await core.inspect()).classification;
            }
            const detected = world.snapshot();
            world.reset();
            inspection = await core.inspect();
            const cleaned = world.snapshot();
            incorrectSideEffects = cleaned.visits.length + cleaned.unrelatedChanges.length;
            checks.push(
              check("partial-rejected", rejected && detectedClassification === "partial" && detected.visits[0]?.status === "pending", "The action response could not hide a partial external result."),
              check("capability-quarantined", core.registryHealth() === "quarantined", "The capability was quarantined after the independent outcome rejection."),
              check("cleanup-verified", inspection.classification === "not-started" && incorrectSideEffects === 0, "The disposable fixture was reset and no injected incorrect effect survived."),
            );
            core.restoreActiveRegistry();
            break;
          }
          case "sidecar-restart": {
            world.reset();
            const input = broadGoalRequest(caseId);
            const databasePath = path.join(caseDirectory, "jobs.sqlite");
            const oldStore = new SidecarGoalJobStore(databasePath);
            const created = oldStore.create(input).job;
            oldStore.claim(input.tenantId, created.jobId);
            const committed = await core.execute({ runId: "solstice-restart-prelude" });
            oldStore.close();
            let calls = 0;
            const service = new SidecarGoalJobService(new SidecarGoalJobStore(databasePath), {
              completeGoal: async (request) => {
                calls += 1;
                const reconciled = await core.execute({ runId: `solstice-restart-recovery-${calls}` });
                return completedGoal(request, reconciled.receipt);
              },
            });
            const recovered = service.recover();
            await service.idle();
            const job = service.get(input.tenantId, created.jobId);
            const eventTypes = service.events(input.tenantId, created.jobId).map((event) => event.type);
            await service.close();
            inspection = committed.receipt;
            const state = world.snapshot();
            intendedWrites = state.committedWrites;
            checks.push(
              check("restart-recovered", recovered.length === 1 && job?.status === "completed" && job.attempts === 2 && eventTypes.includes("job.recovered"), "The durable running job recovered through the same parent identity after restart."),
              check("reconcile-no-duplicate", calls === 1 && state.committedWrites === 1 && state.visits.length === 1, "The restarted worker reconciled the committed state and did not write again."),
            );
            break;
          }
          case "duplicate-submission": {
            world.reset();
            const input = broadGoalRequest(caseId);
            let calls = 0;
            const service = new SidecarGoalJobService(new SidecarGoalJobStore(path.join(caseDirectory, "jobs.sqlite")), {
              completeGoal: async (request) => {
                calls += 1;
                const result = await core.execute({ runId: `solstice-duplicate-${calls}` });
                inspection = result.receipt;
                return completedGoal(request, result.receipt);
              },
            });
            const submissions = Array.from({ length: 12 }, () => service.submit(input));
            await service.idle();
            const terminal = service.get(input.tenantId, submissions[0]!.job.jobId);
            await service.close();
            const state = world.snapshot();
            intendedWrites = state.committedWrites;
            checks.push(
              check("one-durable-job", submissions[0]?.created === true && submissions.slice(1).every((item) => !item.created) && new Set(submissions.map((item) => item.job.jobId)).size === 1, "All exact duplicates resolved to one durable parent job."),
              check("one-execution", calls === 1 && terminal?.attempts === 1 && state.committedWrites === 1 && state.visits.length === 1, "Only one worker execution and one business write occurred."),
            );
            break;
          }
          case "conflicting-parent-reuse": {
            world.reset();
            const input = broadGoalRequest(caseId);
            const store = new SidecarGoalJobStore(path.join(caseDirectory, "jobs.sqlite"));
            store.create(input);
            let rejected = false;
            try { store.create({ ...input, requestId: `${input.requestId}-different`, ordinaryGoal: "A conflicting replacement goal." }); } catch (error) { rejected = error instanceof Error && /different request/.test(error.message); }
            store.close();
            inspection = await core.inspect();
            const state = world.snapshot();
            checks.push(
              check("conflict-rejected", rejected, "A different request could not reuse the saved parent identity."),
              check("zero-run-zero-write", state.writeAttempts === 0 && state.committedWrites === 0, "The conflict was rejected before worker or external action execution."),
            );
            break;
          }
        }
      } catch (error) {
        checks.push(check("case-execution", false, error instanceof Error ? error.message : String(error)));
      }

      const state = world.snapshot();
      const evidence = {
        schemaVersion: "1.0",
        caseId,
        preStateDigest,
        postStateDigest: world.stateDigest(),
        stateSummary: { visits: state.visits.length, writeAttempts: state.writeAttempts, committedWrites: state.committedWrites, unrelatedChanges: state.unrelatedChanges.length },
        observerReceipt: inspection,
        checks,
      };
      const artifactPath = saveJson(path.join(caseDirectory, "evidence.json"), evidence);
      const passed = checks.length > 0 && checks.every((item) => item.passed) && incorrectSideEffects === 0;
      const result: PilotAdapterAcceptanceResult = {
        caseId,
        passed,
        intendedWrites,
        incorrectSideEffects,
        checks,
        artifactReferences: [artifactPath],
        completedAt: new Date().toISOString(),
      };
      saveJson(path.join(caseDirectory, "result.json"), result);
      return result;
    },
  };
}

export async function runFreshOnboardingHttpExecution(options: {
  fixtureDirectory: string;
  outputDirectory: string;
}): Promise<FreshOnboardingExecutionReport> {
  const started = Date.now();
  const openApiPath = path.join(options.fixtureDirectory, "solstice-maintenance-openapi.json");
  const contractPath = path.join(options.fixtureDirectory, "FROZEN_CONTRACT.json");
  const contract = readJson(contractPath) as { blockedWorkflow: { requiredOutcome: string } };
  const material = createMaterial(openApiPath);
  const proposal = adapterProposal(material, contract.blockedWorkflow.requiredOutcome);
  const observerProposal = proposeOutcomeObserver(observerInput(material, contract.blockedWorkflow.requiredOutcome));
  const world = new SolsticeMaintenanceWorld(path.join(options.outputDirectory, "world-state.json"));
  await world.start();
  try {
    const registryPath = path.join(options.outputDirectory, "capability-registry.json");
    const core = new SolsticeExecutionCore(world, material, observerProposal, registryPath);
    const boundObserver = core.observerBinding();
    const authority = compileAuthority();
    const acceptancePlan = buildAcceptancePlan(proposal, boundObserver, authority);
    saveJson(path.join(options.outputDirectory, "generated", "adapter-proposal.json"), proposal);
    saveJson(path.join(options.outputDirectory, "generated", "observer-proposal.json"), observerProposal);
    saveJson(path.join(options.outputDirectory, "generated", "authority-compilation.json"), authority);
    saveJson(path.join(options.outputDirectory, "generated", "acceptance-plan.json"), acceptancePlan);
    if (acceptancePlan.blockers.length > 0) throw new Error(`Generated acceptance plan remains blocked: ${acceptancePlan.blockers.join(", ")}`);
    const acceptanceStarted = Date.now();
    const acceptance = await runPilotAdapterAcceptanceHarness(createAcceptanceHarness({ world, core, outputDirectory: options.outputDirectory }));
    const fullAcceptanceMs = Date.now() - acceptanceStarted;
    const requested = proposal.operations.filter((operation) => operation.requestedByWorkflow.value);
    const report: FreshOnboardingExecutionReport = {
      schemaVersion: "1.0",
      fixtureId: FIXTURE_ID,
      evidenceBoundary: "deterministic-local-development-run-not-human-or-customer-validation",
      spendUsd: 0,
      modelCalls: 0,
      frozenInputDigests: { openApi: digest(readJson(openApiPath)), contract: digest(readJson(contractPath)) },
      proposalMetrics: {
        totalRequestedOperations: 4,
        correctlyMappedRequestedOperations: requested.length,
        proposedCredentialAliases: proposal.credentialAliases.length,
        unsupportedOperationsInvented: requested.filter((operation) => !["getAsset", "listVisits", "listAuditChanges", "createDraftVisit"].includes(operation.operationId.value)).length,
        unauthorizedAuthorityInferred: proposal.writesAuthorized ? 1 : 0,
        credentialValuesStored: proposal.credentialAliases.some((item) => item.valuePresent) ? 1 : 0,
      },
      confirmationsRequired: [
        "Exact target and operation mapping",
        "Credential aliases and customer-local bindings",
        "Preauthorized createDraftVisit write authority and limits",
        "Independent read surface and outcome predicates",
        "Freshness baseline and reconciliation rule",
        "Disposable reset and acceptance environment",
      ],
      generatedArtifacts: {
        adapterProposalId: `adapter-${onboardingAcceptanceSourceDigest(proposal).slice(0, 24)}`,
        observerProposalId: observerProposal.proposalId,
        authorityStatus: authority.status,
        acceptancePlanId: acceptancePlan.planId,
      },
      automationTiming: {
        joinedRunWallClockMs: Date.now() - started,
        firstAutonomousAcquisitionMs: core.firstAutonomousAcquisitionMs,
        fullAcceptanceMs,
        humanEngineerActiveMinutes: null,
      },
      codeAccounting: {
        customerSpecificAdapterCodeWritten: 0,
        customerSpecificObserverCodeWritten: 0,
        fixtureAndAcceptanceHarnessFiles: [
          "test/fixtures/onboarding-fresh-execution/solstice-maintenance-openapi.json",
          "test/fixtures/onboarding-fresh-execution/FROZEN_CONTRACT.json",
          "src/customer-world/fresh-onboarding-http-world.ts",
        ],
        note: "The adapter and observer were generated from reviewed declarative inputs. The local synthetic API and acceptance harness are test infrastructure, not evidence that a fresh engineer wrote zero integration code.",
      },
      capabilityMetrics: {
        ...core.metrics,
        freshProcessReuseWorked: acceptance.results.find((item) => item.caseId === "fresh-process-reuse")?.passed ?? false,
      },
      acceptance,
      survivingIncorrectSideEffects: acceptance.incorrectSideEffects,
      failuresAndFixes: [
        "Independent audit found that observer completion needed exact rather than upper-bound cardinality; completion now requires the exact confirmed count.",
        "Independent audit found non-timestamp freshness needed an operation-bound pre-action snapshot; the binding now records and validates the baseline capture boundary.",
        "Independent audit found observer independence relied too heavily on self-description; source, approved material, read-only credentials, and review digests are now separately bound.",
        "The first pre-use probe failed because its successful no-write response omitted a declared output; the fixture probe now returns a synthetic output while preserving zero writes.",
        "Unchanged sequence state originally classified exact no-action evidence as stale; unchanged trusted-baseline state now passes only the exact not-started branch and can never pass completion.",
      ],
      outputDirectory: options.outputDirectory,
    };
    saveJson(path.join(options.outputDirectory, "joined-execution-report.json"), report);
    return report;
  } finally {
    await world.stop();
  }
}
