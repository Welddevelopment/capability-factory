import { describe, expect, it } from "vitest";
import { normalizeApprovedOpenApiMaterial } from "../src/product/approved-openapi-normalizer.js";
import type { ApprovedOpenApiMaterial } from "../src/product/onboarding-adapter-factory.js";

function material(): ApprovedOpenApiMaterial {
  return {
    kind: "openapi",
    materialId: "warehouse-api",
    localReference: "fixtures/warehouse-openapi.json",
    approved: true,
    targetAlias: "warehouse_sandbox",
    document: {
      openapi: "3.1.0",
      info: { title: "Warehouse API", version: "1.0.0" },
      servers: [{ url: "https://sandbox.warehouse.invalid/v1" }],
      security: [{ warehouseBearer: [] }],
      paths: {
        "/orders": {
          get: {
            operationId: "listOrders",
            parameters: [
              { name: "cursor", in: "query", schema: { type: "string" } },
              { "$ref": "#/components/parameters/PageLimit" },
            ],
            responses: {
              "200": { description: "Orders", content: { "application/json": { schema: { "$ref": "#/components/schemas/OrderList" } } } },
              "429": { description: "Rate limited" },
            },
          },
          post: {
            operationId: "createOrder",
            requestBody: { content: { "application/json": { schema: { "$ref": "#/components/schemas/CreateOrder" } } } },
            responses: { "201": { description: "Created" }, "409": { description: "Duplicate" } },
          },
        },
      },
      components: {
        securitySchemes: { warehouseBearer: { type: "http", scheme: "bearer" } },
        parameters: { PageLimit: { name: "limit", in: "query", schema: { type: "integer", maximum: 100 } } },
        schemas: {
          OrderList: { type: "object", properties: { items: { type: "array", items: { type: "object" } } } },
          CreateOrder: { type: "object", required: ["sku"], properties: { sku: { type: "string" } } },
        },
      },
    },
  };
}

describe("approved OpenAPI normalizer", () => {
  it("resolves bounded local references but remains blocked until server confirmation", () => {
    const result = normalizeApprovedOpenApiMaterial(material());
    expect(result).toMatchObject({
      status: "blocked",
      executable: false,
      serverCandidates: ["https://sandbox.warehouse.invalid/v1"],
      blockers: ["server-url-not-confirmed"],
    });
    const list = result.operations.find((operation) => operation.operationId === "listOrders");
    expect(list).toMatchObject({
      consequence: "read",
      documentedErrorStatuses: ["429"],
      paginationParameterCandidates: ["cursor", "limit"],
      securitySchemeAliases: ["warehouseBearer"],
    });
    const serialized = JSON.stringify(result.normalizedMaterial.document);
    expect(serialized).not.toContain("$ref");
    expect(result.normalizationReceiptDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("binds exact server review to the approved material without making it executable", () => {
    const proposed = normalizeApprovedOpenApiMaterial(material());
    const reviewed = normalizeApprovedOpenApiMaterial(material(), {
      materialDigest: proposed.originalMaterialDigest,
      selectedUrl: "https://sandbox.warehouse.invalid/v1",
      confirmedByAlias: "platformEngineer",
      confirmedAt: "2026-08-14T00:00:00.000Z",
    });
    expect(reviewed).toMatchObject({ status: "review-required", executable: false, blockers: [], confirmedServerUrl: "https://sandbox.warehouse.invalid/v1" });
    const create = reviewed.operations.find((operation) => operation.operationId === "createOrder");
    expect(create).toMatchObject({ consequence: "write", documentedErrorStatuses: ["409"] });
  });

  it("rejects external, cyclic, sibling-bearing and mismatched references or confirmations", () => {
    const external = material();
    (external.document as Record<string, unknown>).paths = { "/orders": { get: { "$ref": "https://example.invalid/operation.json" } } };
    expect(() => normalizeApprovedOpenApiMaterial(external)).toThrow(/external|non-local/i);

    const cyclic = material();
    (cyclic.document as Record<string, unknown>).paths = { "/orders": { get: { "$ref": "#/components/schemas/A" } } };
    (cyclic.document as Record<string, unknown>).components = { schemas: { A: { "$ref": "#/components/schemas/B" }, B: { "$ref": "#/components/schemas/A" } } };
    expect(() => normalizeApprovedOpenApiMaterial(cyclic)).toThrow(/cyclic/i);

    const sibling = material();
    (sibling.document as Record<string, unknown>).paths = { "/orders": { get: { "$ref": "#/components/schemas/A", description: "Ambiguous sibling" } } };
    (sibling.document as Record<string, unknown>).components = { schemas: { A: { type: "object" } } };
    expect(() => normalizeApprovedOpenApiMaterial(sibling)).toThrow(/sibling/i);

    const proposed = normalizeApprovedOpenApiMaterial(material());
    expect(() => normalizeApprovedOpenApiMaterial(material(), {
      materialDigest: "a".repeat(64),
      selectedUrl: proposed.serverCandidates[0]!,
      confirmedByAlias: "platformEngineer",
      confirmedAt: "2026-08-14T00:00:00.000Z",
    })).toThrow(/different approved/i);
  });

  it("keeps undocumented operational behavior explicit instead of inferring it", () => {
    const current = material();
    (current.document as Record<string, unknown>).servers = [];
    const result = normalizeApprovedOpenApiMaterial(current);
    expect(result.blockers).toContain("server-url-unavailable");
    expect(result.operations.every((operation) => operation.operationalUnknowns.some((unknown) => /rate limits.*not proved/i.test(unknown)))).toBe(true);
  });
});
