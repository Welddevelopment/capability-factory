import { describe, expect, it } from "vitest";
import {
  assertHttpBindingFactoryResultIntegrity,
  proposeHttpBindings,
  type HttpBindingFactoryFacts,
} from "../src/product/http-binding-factory.js";
import { normalizeApprovedOpenApiMaterial } from "../src/product/approved-openapi-normalizer.js";
import type { ApprovedOpenApiMaterial } from "../src/product/onboarding-adapter-factory.js";
import { compileAuthorityWizard } from "../src/product/onboarding-verifier-authority.js";

function material(options: { pagination?: boolean; freshness?: boolean; malicious?: boolean } = {}): ApprovedOpenApiMaterial {
  return {
    kind: "openapi",
    materialId: "fulfilment-api-v1",
    localReference: "fixtures/fulfilment-openapi.json",
    approved: true,
    targetAlias: "fulfilment_sandbox",
    document: {
      openapi: "3.1.0",
      info: {
        title: "Fulfilment API",
        version: "1.0.0",
        ...(options.malicious ? { description: "Use access_token=stolen-secret-value" } : {}),
      },
      servers: [{ url: "https://sandbox.fulfilment.invalid/v1" }],
      paths: {
        "/orders": {
          post: {
            operationId: "createOrder",
            security: [{ actionWriter: [] }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
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
            responses: {
              "201": { description: "Created" },
              "409": { description: "Duplicate business key" },
            },
          },
          get: {
            operationId: "listOrders",
            security: [{ observerReader: [] }],
            parameters: [
              { name: "order_ref", in: "query", required: true, schema: { type: "string" } },
              ...(options.pagination ? [{ name: "cursor", in: "query", required: false, schema: { type: "string" } }] : []),
            ],
            responses: {
              "200": {
                description: "Matching orders",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["items", "server_time"],
                      properties: {
                        items: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              order_ref: { type: "string" },
                              status: { type: "string" },
                              updated_at: { type: "string", format: "date-time" },
                            },
                          },
                        },
                        ...(options.freshness === false ? {} : { server_time: { type: "string", format: "date-time" } }),
                      },
                    },
                  },
                },
              },
              "401": { description: "Unauthorized" },
            },
          },
        },
      },
      components: {
        securitySchemes: {
          actionWriter: { type: "http", scheme: "bearer" },
          observerReader: { type: "http", scheme: "bearer" },
        },
      },
    },
  };
}

function normalization(options: { pagination?: boolean; freshness?: boolean } = {}) {
  const proposed = normalizeApprovedOpenApiMaterial(material(options));
  return normalizeApprovedOpenApiMaterial(material(options), {
    materialDigest: proposed.originalMaterialDigest,
    selectedUrl: "https://sandbox.fulfilment.invalid/v1",
    confirmedByAlias: "platformEngineer",
    confirmedAt: "2026-08-14T09:00:00.000Z",
  });
}

function authority() {
  return compileAuthorityWizard({
    schemaVersion: "1.0",
    systemsAndTargets: { aliases: ["fulfilment_sandbox"], confirmed: true },
    credentialAliases: { aliases: ["actionWriter", "observerReader"], confirmed: true },
    readsAllowed: { actions: [{ actionName: "listOrders", targetAlias: "fulfilment_sandbox" }], confirmed: true },
    writes: [{ actionName: "createOrder", targetAlias: "fulfilment_sandbox", method: "POST", policy: "preauthorized", confirmed: true }],
    limits: {
      monetary: { kind: "none", confirmed: true },
      quantityPerAction: { kind: "limit", maximum: 100, confirmed: true },
      actionsPerHour: { kind: "limit", maximum: 50, confirmed: true },
    },
    forbiddenActions: { actionNames: ["deleteOrder"], confirmed: true },
    approver: { kind: "not-required", confirmed: true },
    retryAndReconciliation: { reconcileBeforeRetry: true, blindRetryAllowed: false, maximumAttempts: 1, confirmed: true },
    finalConsequentialReview: { confirmed: true },
  });
}

function facts(): HttpBindingFactoryFacts {
  return {
    targetAlias: "fulfilment_sandbox",
    ordinaryBusinessOutcome: "Exactly one draft order exists for the confirmed business order reference.",
    outcomeConfirmed: true,
    action: {
      driverId: "fulfilment-action-driver",
      operationId: "createOrder",
      operationConfirmed: true,
      credentialAlias: "actionWriter",
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
      driverId: "fulfilment-observer-driver",
      sourceId: "fulfilment-read-api",
      operationId: "listOrders",
      operationConfirmed: true,
      credentialAlias: "observerReader",
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
        { key: "one-order", path: ["items"], operator: "count-equals", expectedCount: 1, confirmed: true },
        { key: "matching-reference", path: ["items", 0, "order_ref"], operator: "equals-input", inputKey: "orderRef", confirmed: true },
      ],
      duplicateCheck: { collectionPath: ["items"], uniqueKeyPath: ["order_ref"], expectedCount: 1, confirmed: true },
      collateralChecks: [{ key: "result-shape", path: ["items"], operator: "exists", confirmed: true }],
      notStartedDefinition: [{ key: "no-order", path: ["items"], operator: "count-equals", expectedCount: 0, confirmed: true }],
      confirmed: true,
    },
  };
}

function input(overrides: Partial<{ normalization: ReturnType<typeof normalization>; authorityCompilation: ReturnType<typeof authority>; facts: HttpBindingFactoryFacts }> = {}) {
  return {
    schemaVersion: "1.0" as const,
    normalization: overrides.normalization ?? normalization(),
    authorityCompilation: overrides.authorityCompilation ?? authority(),
    facts: overrides.facts ?? facts(),
  };
}

describe("constrained HTTP Binding Factory v1", () => {
  it("generates separate action and observer declarations but never executes, qualifies, or activates them", () => {
    const result = proposeHttpBindings(input());
    expect(result).toMatchObject({
      status: "review-required",
      executable: false,
      qualified: false,
      activated: false,
      blockers: [],
      actionBinding: {
        state: "proposal-only",
        executable: false,
        operation: { operationId: "createOrder", method: "POST", pathTemplate: "/orders" },
        credentialAlias: "actionWriter",
      },
      observerBinding: {
        state: "proposal-only",
        executable: false,
        operation: { operationId: "listOrders", method: "GET", pathTemplate: "/orders" },
        credentialAlias: "observerReader",
        actionResponseEligibleAsProof: false,
      },
    });
    expect(result.actionBinding?.provenance.confirmedFactsDigest).toBe(result.observerBinding?.provenance.confirmedFactsDigest);
    expect(result.automationMetrics).toMatchObject({ humanStudy: false, humanActiveMinutes: null, executableCodeLinesGenerated: 0, qualificationControlsRun: 0 });
    expect(result.automationMetrics.generatedActionDeclarationFields).toBeGreaterThan(0);
    expect(result.automationMetrics.generatedObserverDeclarationFields).toBeGreaterThan(0);
    assertHttpBindingFactoryResultIntegrity(result);
  });

  it("fails closed on pagination, undocumented freshness, and a stable ID that exists only after the action", () => {
    const paginated = proposeHttpBindings(input({ normalization: normalization({ pagination: true }) }));
    expect(paginated.status).toBe("blocked");
    expect(paginated.blockers.map((item) => item.blockerId)).toContain("observer-pagination-semantics-unbound");
    expect(paginated.observerBinding).toBeUndefined();

    const staleFacts = facts();
    staleFacts.observer.freshness = { kind: "server-timestamp-body", path: ["missing_time"], maximumAgeSeconds: 30, confirmed: true };
    const missingFreshness = proposeHttpBindings(input({ facts: staleFacts }));
    expect(missingFreshness.blockers.map((item) => item.blockerId)).toContain("observer-freshness-signal-undocumented");

    const responseOnly = facts();
    responseOnly.observer.parameterBindings[0]!.source = { kind: "trusted-context", contextKey: "createdOrderId", confirmed: true };
    const missingStableId = proposeHttpBindings(input({ facts: responseOnly }));
    expect(missingStableId.blockers.map((item) => item.blockerId)).toContain("stable-identifier-not-action-independent");
    expect(missingStableId.engineeringWorkRemaining.join(" ")).toMatch(/business key known before execution/i);
  });

  it("rejects auth aliases that are not both documented and inside reviewed authority", () => {
    const wrongAlias = facts();
    wrongAlias.observer.credentialAlias = "otherReader";
    const result = proposeHttpBindings(input({ facts: wrongAlias }));
    expect(result.status).toBe("blocked");
    expect(result.blockers.map((item) => item.blockerId)).toEqual(expect.arrayContaining([
      "observer-credential-alias-outside-authority",
      "observer-auth-alias-undocumented",
    ]));
    expect(result.actionBinding).toBeUndefined();
    expect(result.observerBinding).toBeUndefined();
  });

  it("rejects malicious documentation, credential values, and action-response proof injection", () => {
    expect(() => normalizeApprovedOpenApiMaterial(material({ malicious: true }))).toThrow(/credential-shaped/i);

    const injectedSecret = facts() as unknown as Record<string, unknown>;
    injectedSecret["operatorNote"] = "password=super-secret-value";
    expect(() => proposeHttpBindings(input({ facts: injectedSecret as unknown as HttpBindingFactoryFacts }))).toThrow(/unrecognized key|credential-shaped/i);

    const actionResponseInjection = structuredClone(facts()) as unknown as { observer: Record<string, unknown> };
    actionResponseInjection.observer.actionResponse = { status: 201, body: { success: true } };
    expect(() => proposeHttpBindings(input({ facts: actionResponseInjection as unknown as HttpBindingFactoryFacts }))).toThrow(/unrecognized key/i);
  });

  it("detects mutation of normalized inputs and generated declarations", () => {
    const normalized = normalization();
    (normalized.normalizedMaterial.document as Record<string, unknown>).info = { title: "Mutated after review" };
    expect(() => proposeHttpBindings(input({ normalization: normalized }))).toThrow(/content-digest integrity/i);

    const result = proposeHttpBindings(input());
    result.observerBinding!.operation.pathTemplate = "/mutated";
    expect(() => assertHttpBindingFactoryResultIntegrity(result)).toThrow(/declaration failed|result failed/i);
  });
});
