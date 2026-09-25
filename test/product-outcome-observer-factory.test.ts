import { describe, expect, it } from "vitest";
import {
  bindOutcomeObserver,
  outcomeObserverSourceDigest,
  proposeOutcomeObserver,
  type OutcomeObserverFactoryInput,
  type OutcomeObserverHttpTransport,
} from "../src/product/outcome-observer-factory.js";
import { UniversalVerifierFactory } from "../src/product/universal-verifier.js";

const NOW = Date.parse("2026-08-12T08:00:00.000Z");

function material(): OutcomeObserverFactoryInput["approvedOpenApiMaterial"] {
  return {
    kind: "openapi",
    materialId: "dockflow-observer-openapi",
    localReference: "fixtures/dockflow-observer-openapi.json",
    approved: true,
    targetAlias: "dockflow_sandbox",
    document: {
      openapi: "3.1.0",
      info: { title: "DockFlow Observer API", version: "1.0.0" },
      security: [{ observerBearer: [] }],
      paths: {
        "/shipments/{shipmentId}": {
          get: {
            operationId: "getShipment",
            parameters: [{ name: "shipmentId", in: "path", required: true, schema: { type: "string" } }],
            responses: { "200": { description: "Shipment state" } },
          },
        },
        "/allocations": {
          get: {
            operationId: "listAllocations",
            parameters: [{ name: "shipmentId", in: "query", required: true, schema: { type: "string" } }],
            responses: { "200": { description: "Allocation collection" } },
          },
        },
        "/audit": {
          get: {
            operationId: "listAuditChanges",
            parameters: [{ name: "shipmentId", in: "query", required: true, schema: { type: "string" } }],
            responses: { "200": { description: "Collateral-state audit" } },
          },
        },
      },
      components: { securitySchemes: { observerBearer: { type: "http", scheme: "bearer" } } },
    },
  };
}

function input(): OutcomeObserverFactoryInput {
  const shipmentId = { kind: "context-reference" as const, referenceKey: "shipment-id", confirmed: true as const };
  return {
    schemaVersion: "1.0",
    observerKey: "dock-allocation-outcome",
    targetAlias: "dockflow_sandbox",
    ordinaryBusinessOutcome: "Exactly one fresh draft dock allocation exists for the approved shipment and no unrelated state changes.",
    outcomeConfirmed: true,
    executionDriverId: "dockflow-action-driver",
    observationDriverId: "dockflow-read-driver",
    approvedOpenApiMaterial: material(),
    reads: [
      {
        key: "shipment",
        primitive: "fetch-resource",
        operationName: "getShipment",
        parameterBindings: [{ name: "shipmentId", location: "path", role: "stable-id", valueSource: shipmentId, confirmed: true }],
        resultPath: ["resource"], expectedStatuses: [200], confirmed: true,
      },
      {
        key: "allocations",
        primitive: "query-collection",
        operationName: "listAllocations",
        parameterBindings: [{ name: "shipmentId", location: "query", role: "confirmed-filter", valueSource: shipmentId, confirmed: true }],
        resultPath: ["items"], expectedStatuses: [200], confirmed: true,
      },
      {
        key: "allocationQuantities",
        primitive: "query-collection",
        operationName: "listAllocations",
        parameterBindings: [{ name: "shipmentId", location: "query", role: "confirmed-filter", valueSource: shipmentId, confirmed: true }],
        resultPath: ["quantities"], expectedStatuses: [200], confirmed: true,
      },
      {
        key: "allocationStatuses",
        primitive: "query-collection",
        operationName: "listAllocations",
        parameterBindings: [{ name: "shipmentId", location: "query", role: "confirmed-filter", valueSource: shipmentId, confirmed: true }],
        resultPath: ["statuses"], expectedStatuses: [200], confirmed: true,
      },
      {
        key: "collateralChanges",
        primitive: "query-collection",
        operationName: "listAuditChanges",
        parameterBindings: [{ name: "shipmentId", location: "query", role: "confirmed-filter", valueSource: shipmentId, confirmed: true }],
        resultPath: ["unrelatedChanges"], expectedStatuses: [200], confirmed: true,
      },
    ],
    successPredicates: [
      { key: "shipment-processed", observationKey: "shipment", path: ["status"], operator: "equals", expected: "processed", confirmed: true },
      { key: "shipment-labelled", observationKey: "shipment", path: ["labels"], operator: "contains", expected: "allocated", confirmed: true },
      { key: "shipment-label-set", observationKey: "shipment", path: ["labels"], operator: "set-includes", expected: ["allocated"], confirmed: true },
      { key: "shipment-label-exclusion", observationKey: "shipment", path: ["labels"], operator: "set-excludes", forbidden: ["forbidden"], confirmed: true },
      { key: "shipment-labels-changed", observationKey: "shipment", path: ["labels"], operator: "changed-from-baseline", baseline: [], confirmed: true },
      { key: "one-allocation", observationKey: "allocations", path: [], operator: "count-equals", expected: 1, confirmed: true },
      { key: "unique-allocation", observationKey: "allocations", path: [], operator: "unique-by-key", itemPath: ["id"], confirmed: true },
      { key: "quantity-bounded", observationKey: "allocations", path: [0, "quantity"], operator: "bounded-number", minimum: 1, maximum: 10, confirmed: true },
      { key: "quantity-relational", observationKey: "allocations", path: [0, "quantity"], operator: "relational-equals", otherObservationKey: "allocationQuantities", otherPath: [0], confirmed: true },
      { key: "quantity-invariant", observationKey: "allocationQuantities", path: [], operator: "sum-equals", expected: 4, confirmed: true },
      { key: "statuses-invariant", observationKey: "allocationStatuses", path: [], operator: "all-equal", expected: "draft", confirmed: true },
    ],
    notStartedPredicates: [
      { key: "no-allocation", observationKey: "allocations", path: [], operator: "count-equals", expected: 0, confirmed: true },
    ],
    duplicateCheck: { observationKey: "allocations", path: [], expectedCount: 1, confirmed: true },
    collateralChecks: [
      { key: "no-unrelated-change", observationKey: "collateralChanges", path: [], operator: "count-equals", expected: 0, confirmed: true },
    ],
    freshness: {
      observationKey: "observerObservedAt",
      source: { kind: "version-body", readKey: "shipment", path: ["resource", "version"], baseline: { kind: "literal", value: 1, confirmed: true }, confirmed: true },
      maximumAgeSeconds: 30,
      maximumFutureSkewSeconds: 5,
      confirmed: true,
    },
  };
}

function dependencies(overrides: { allocations?: unknown[]; collateral?: unknown[]; version?: number; quantity?: number } = {}) {
  const allocations = overrides.allocations ?? [{ id: "ALLOC-1", shipmentId: "SHIP-42", status: "draft", quantity: overrides.quantity ?? 4 }];
  const transport: OutcomeObserverHttpTransport = {
    driverId: "dockflow-read-driver",
    sourceId: "dockflow-independent-read-api",
    implementationDigest: "a".repeat(64),
    approvedMaterialDigest: outcomeObserverSourceDigest(material()),
    readOnlyCredentialAliases: ["observerBearer"],
    independentFromExecutionDriverIds: ["dockflow-action-driver"],
    independenceReview: {
      reviewId: "dockflow-observer-review-v1",
      reviewDigest: outcomeObserverSourceDigest({ review: "dockflow-observer-review-v1", passed: true }),
      status: "independently-reviewed",
    },
    async read(request) {
      expect(request.credentialAliases).toEqual(["observerBearer"]);
      if (request.requestKey === "shipment") return { status: 200, headers: {}, body: { resource: { id: "SHIP-42", status: "processed", labels: ["allocated"], version: overrides.version ?? 2 } } };
      if (request.requestKey === "allocations") return { status: 200, headers: {}, body: { items: allocations } };
      if (request.requestKey === "allocationQuantities") return { status: 200, headers: {}, body: { quantities: allocations.map((row) => (row as { quantity?: unknown }).quantity) } };
      if (request.requestKey === "allocationStatuses") return { status: 200, headers: {}, body: { statuses: allocations.map((row) => (row as { status?: unknown }).status) } };
      return { status: 200, headers: {}, body: { unrelatedChanges: overrides.collateral ?? [] } };
    },
  };
  const resolver = {
    resolverId: "dockflow-context-resolver",
    implementationDigest: "b".repeat(64),
    async resolve(referenceKey: string) { return referenceKey === "shipment-id" ? "SHIP-42" : undefined; },
  };
  return { transport, resolver, now: () => NOW };
}

function bound(overrides: Parameters<typeof dependencies>[0] = {}) {
  const proposal = proposeOutcomeObserver(input());
  const deps = dependencies(overrides);
  const result = bindOutcomeObserver(proposal, {
    proposalDigest: proposal.proposalDigest,
    approvedMaterialDigest: proposal.approvedMaterialDigest,
    observationDriverDigest: deps.transport.implementationDigest,
    observationSourceId: deps.transport.sourceId,
    observationSourceDigest: outcomeObserverSourceDigest({
      sourceId: deps.transport.sourceId,
      driverId: deps.transport.driverId,
      implementationDigest: deps.transport.implementationDigest,
      approvedMaterialDigest: deps.transport.approvedMaterialDigest,
    }),
    readOnlyCredentialAliasesDigest: outcomeObserverSourceDigest([...deps.transport.readOnlyCredentialAliases].sort()),
    independenceReviewDigest: deps.transport.independenceReview.reviewDigest,
    valueResolverDigest: deps.resolver.implementationDigest,
    confirmedByAlias: "platformEngineer",
    confirmedAt: "2026-08-12T07:59:00.000Z",
    operationStartedAtEpochMs: NOW - 1_000,
    freshnessBaselineCapturedAtEpochMs: NOW - 2_000,
    factsConfirmed: true,
  }, { transport: deps.transport, valueResolver: deps.resolver, now: deps.now });
  return { proposal, result };
}

const context = { tenantId: "local", requestId: "request-1", parentGoalId: "goal-1", operationKey: "allocate-SHIP-42" };

describe("Outcome Observer Factory v1", () => {
  it("proposes a non-executable observer with exact read primitives and provenance digests", () => {
    const proposal = proposeOutcomeObserver(input());
    expect(proposal).toMatchObject({ status: "review-required", executable: false, activation: "blocked", blockers: [] });
    expect(proposal.reads.map((read) => read.primitive)).toContain("fetch-resource");
    expect(proposal.reads.map((read) => read.primitive)).toContain("query-collection");
    expect(proposal.credentialAliases).toEqual(["observerBearer"]);
    expect(proposal.proposalDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(proposal.approvedMaterialDigest).toBe(outcomeObserverSourceDigest(material()));
  });

  it("binds only a separate digest-matched observation driver and executes reusable primitives", async () => {
    const { result } = bound();
    const inspected = await result.adapter.inspect(context);
    expect(inspected.receipt).toMatchObject({ classification: "completed", passed: true, duplicateDetected: false, collateralDetected: false });
    expect(inspected.observations).toMatchObject({
      "cf-success-shipment-processed": true,
      "cf-success-one-allocation": true,
      "cf-success-quantity-bounded": true,
      "cf-success-quantity-invariant": true,
      "cf-success-statuses-invariant": true,
      "cf-collateral-effect-count": 0,
    });
    expect(result.verifierContract.status).toBe("provisional-review-required");
    const compiled = new UniversalVerifierFactory([result.adapter], () => "2026-08-12T08:00:00.000Z")
      .compile(result.verifierContract.criterionContractDraft);
    expect(compiled.status).toBe("compiled");
    if (compiled.status === "compiled") expect((await compiled.verifier.verify(context)).passed).toBe(true);
  });

  it("classifies partial, duplicate, collateral, stale, and unknown outcomes without passing them", async () => {
    expect((await bound({ quantity: 3 }).result.adapter.inspect(context)).receipt).toMatchObject({ classification: "partial", passed: false });
    expect((await bound({ allocations: [
      { id: "ALLOC-1", status: "draft", quantity: 4 },
      { id: "ALLOC-2", status: "draft", quantity: 4 },
    ] }).result.adapter.inspect(context)).receipt).toMatchObject({ classification: "duplicate", passed: false, duplicateDetected: true });
    expect((await bound({ collateral: [{ id: "OTHER-1" }] }).result.adapter.inspect(context)).receipt).toMatchObject({ classification: "collateral", passed: false, collateralDetected: true });
    expect((await bound({ version: 1 }).result.adapter.inspect(context)).receipt).toMatchObject({ classification: "stale", passed: false });

    const { proposal } = bound();
    const deps = dependencies();
    deps.transport.read = async () => { throw new Error("observer unavailable"); };
    const unavailable = bindOutcomeObserver(proposal, {
      proposalDigest: proposal.proposalDigest, approvedMaterialDigest: proposal.approvedMaterialDigest,
      observationDriverDigest: deps.transport.implementationDigest, valueResolverDigest: deps.resolver.implementationDigest,
      observationSourceId: deps.transport.sourceId,
      observationSourceDigest: outcomeObserverSourceDigest({ sourceId: deps.transport.sourceId, driverId: deps.transport.driverId, implementationDigest: deps.transport.implementationDigest, approvedMaterialDigest: deps.transport.approvedMaterialDigest }),
      readOnlyCredentialAliasesDigest: outcomeObserverSourceDigest([...deps.transport.readOnlyCredentialAliases].sort()),
      independenceReviewDigest: deps.transport.independenceReview.reviewDigest,
      confirmedByAlias: "platformEngineer", confirmedAt: "2026-08-12T07:59:00.000Z",
      operationStartedAtEpochMs: NOW - 1_000, freshnessBaselineCapturedAtEpochMs: NOW - 2_000, factsConfirmed: true,
    }, { transport: deps.transport, valueResolver: deps.resolver, now: deps.now });
    expect((await unavailable.adapter.inspect(context)).receipt).toMatchObject({ classification: "unknown", passed: false });
  });

  it("requires exact completion cardinality and treats an unchanged trusted baseline only as not-started", async () => {
    const empty = bound({ allocations: [], version: 1 });
    expect((await empty.result.adapter.inspect(context)).receipt).toMatchObject({
      classification: "not-started",
      passed: false,
      duplicateDetected: false,
    });
  });

  it("rejects an observer binding whose trusted operation boundary has aged out", async () => {
    const proposal = proposeOutcomeObserver(input());
    const deps = dependencies();
    const staleBoundary = bindOutcomeObserver(proposal, {
      proposalDigest: proposal.proposalDigest, approvedMaterialDigest: proposal.approvedMaterialDigest,
      observationDriverDigest: deps.transport.implementationDigest, valueResolverDigest: deps.resolver.implementationDigest,
      observationSourceId: deps.transport.sourceId,
      observationSourceDigest: outcomeObserverSourceDigest({ sourceId: deps.transport.sourceId, driverId: deps.transport.driverId, implementationDigest: deps.transport.implementationDigest, approvedMaterialDigest: deps.transport.approvedMaterialDigest }),
      readOnlyCredentialAliasesDigest: outcomeObserverSourceDigest([...deps.transport.readOnlyCredentialAliases].sort()),
      independenceReviewDigest: deps.transport.independenceReview.reviewDigest,
      confirmedByAlias: "platformEngineer", confirmedAt: "2026-08-12T07:59:00.000Z",
      operationStartedAtEpochMs: NOW - 31_000, freshnessBaselineCapturedAtEpochMs: NOW - 32_000, factsConfirmed: true,
    }, { transport: deps.transport, valueResolver: deps.resolver, now: deps.now });
    expect((await staleBoundary.adapter.inspect(context)).receipt).toMatchObject({ classification: "stale", passed: false });
  });

  it("fails closed on missing stable IDs, undocumented filters, action-coupled drivers, and digest drift", () => {
    const missingStable = input();
    missingStable.reads[0]!.parameterBindings = [];
    expect(proposeOutcomeObserver(missingStable).blockers.map((item) => item.blockerId)).toContain("stable-id-unbound");

    const undocumented = input();
    undocumented.reads[1]!.parameterBindings[0]!.name = "inventedFilter";
    expect(proposeOutcomeObserver(undocumented).blockers.map((item) => item.blockerId)).toContain("unknown-observation-parameter");

    const proposal = proposeOutcomeObserver(input());
    const deps = dependencies();
    expect(() => bindOutcomeObserver(proposal, {
      proposalDigest: proposal.proposalDigest, approvedMaterialDigest: proposal.approvedMaterialDigest,
      observationDriverDigest: "c".repeat(64), valueResolverDigest: deps.resolver.implementationDigest,
      observationSourceId: deps.transport.sourceId,
      observationSourceDigest: outcomeObserverSourceDigest({ sourceId: deps.transport.sourceId, driverId: deps.transport.driverId, implementationDigest: deps.transport.implementationDigest, approvedMaterialDigest: deps.transport.approvedMaterialDigest }),
      readOnlyCredentialAliasesDigest: outcomeObserverSourceDigest([...deps.transport.readOnlyCredentialAliases].sort()),
      independenceReviewDigest: deps.transport.independenceReview.reviewDigest,
      confirmedByAlias: "platformEngineer", confirmedAt: "2026-08-12T07:59:00.000Z",
      operationStartedAtEpochMs: NOW - 1_000, freshnessBaselineCapturedAtEpochMs: NOW - 2_000, factsConfirmed: true,
    }, { transport: deps.transport, valueResolver: deps.resolver, now: deps.now })).toThrow(/digest does not match/);

    const coupled = dependencies();
    coupled.transport.driverId = "dockflow-action-driver";
    expect(() => bindOutcomeObserver(proposal, {
      proposalDigest: proposal.proposalDigest, approvedMaterialDigest: proposal.approvedMaterialDigest,
      observationDriverDigest: coupled.transport.implementationDigest, valueResolverDigest: coupled.resolver.implementationDigest,
      observationSourceId: coupled.transport.sourceId,
      observationSourceDigest: outcomeObserverSourceDigest({ sourceId: coupled.transport.sourceId, driverId: coupled.transport.driverId, implementationDigest: coupled.transport.implementationDigest, approvedMaterialDigest: coupled.transport.approvedMaterialDigest }),
      readOnlyCredentialAliasesDigest: outcomeObserverSourceDigest([...coupled.transport.readOnlyCredentialAliases].sort()),
      independenceReviewDigest: coupled.transport.independenceReview.reviewDigest,
      confirmedByAlias: "platformEngineer", confirmedAt: "2026-08-12T07:59:00.000Z",
      operationStartedAtEpochMs: NOW - 1_000, freshnessBaselineCapturedAtEpochMs: NOW - 2_000, factsConfirmed: true,
    }, { transport: coupled.transport, valueResolver: coupled.resolver, now: coupled.now })).toThrow(/does not match the reviewed observation driver|not independently bound/);

    const mutated = structuredClone(proposal);
    mutated.successPredicates[0] = { ...mutated.successPredicates[0]!, expected: "wrong-status" } as typeof mutated.successPredicates[number];
    expect(() => bindOutcomeObserver(mutated, {
      proposalDigest: proposal.proposalDigest, approvedMaterialDigest: proposal.approvedMaterialDigest,
      observationDriverDigest: deps.transport.implementationDigest, valueResolverDigest: deps.resolver.implementationDigest,
      observationSourceId: deps.transport.sourceId,
      observationSourceDigest: outcomeObserverSourceDigest({ sourceId: deps.transport.sourceId, driverId: deps.transport.driverId, implementationDigest: deps.transport.implementationDigest, approvedMaterialDigest: deps.transport.approvedMaterialDigest }),
      readOnlyCredentialAliasesDigest: outcomeObserverSourceDigest([...deps.transport.readOnlyCredentialAliases].sort()),
      independenceReviewDigest: deps.transport.independenceReview.reviewDigest,
      confirmedByAlias: "platformEngineer", confirmedAt: "2026-08-12T07:59:00.000Z",
      operationStartedAtEpochMs: NOW - 1_000, freshnessBaselineCapturedAtEpochMs: NOW - 2_000, factsConfirmed: true,
    }, { transport: deps.transport, valueResolver: deps.resolver, now: deps.now })).toThrow(/integrity digest/);
  });

  it("rejects credential-shaped literals and does not accept an action response as an observation driver", () => {
    const secret = input();
    secret.reads[0]!.parameterBindings[0]!.valueSource = { kind: "literal", value: "Bearer abcdefghijklmnopqrstuvwxyz", confirmed: true };
    expect(() => proposeOutcomeObserver(secret)).toThrow(/credential-shaped/);

    const sameDriver = input();
    sameDriver.observationDriverId = sameDriver.executionDriverId;
    expect(() => proposeOutcomeObserver(sameDriver)).toThrow(/separate driver identities/);
  });
});
