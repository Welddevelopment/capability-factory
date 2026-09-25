import { EXPERIMENT_LIMITS } from "./config.js";
import { hashDocumentation, type CapabilityManifest } from "./manifest.js";
import type { Scenario } from "./scenario.js";

export function createManualProcurementManifest(
  scenario: Scenario,
  documentation: unknown,
  createdAt = "2026-07-21T20:38:29.000Z",
): CapabilityManifest {
  const contract = scenario.contract;
  return {
    schemaVersion: "1",
    id: `manual-${scenario.id.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").slice(0, 48)}`,
    version: "1.0.0",
    service: "equipment acquisition",
    description: "Search for compatible equipment and create idempotent purchase orders",
    baseUrlAlias: "procurement",
    auth:
      contract.auth.kind === "bearer"
        ? { kind: "bearer", secretAlias: contract.auth.secretAlias }
        : {
            kind: "apiKey",
            secretAlias: contract.auth.secretAlias,
            headerName: contract.auth.headerName,
          },
    actions: [
      {
        name: "search_equipment",
        description: "Find equipment covering a required range that can arrive by a deadline",
        inputSchema: {
          type: "object",
          properties: {
            requiredMinTempC: { type: "number", description: "Lowest required supported temperature" },
            requiredMaxTempC: { type: "number", description: "Highest required supported temperature" },
            deliverBy: { type: "string", description: "Latest acceptable ISO-8601 delivery time" },
          },
          required: ["requiredMinTempC", "requiredMaxTempC", "deliverBy"],
          additionalProperties: false,
        },
        request: {
          method: "GET",
          pathTemplate: contract.catalogPath,
          queryTemplate: {
            [contract.queryFields.requiredMinTemp]: "{{input.requiredMinTempC}}",
            [contract.queryFields.requiredMaxTemp]: "{{input.requiredMaxTempC}}",
            [contract.queryFields.deliverBy]: "{{input.deliverBy}}",
          },
          headerTemplate: {},
          bodyTemplate: null,
        },
        response: {
          acceptedStatuses: [200],
          outputPointers: { products: "/products" },
        },
        safety: { idempotency: "none", timeoutMs: 5_000, maxResponseBytes: 100_000 },
      },
      {
        name: "create_purchase_order",
        description: "Create a purchase order for selected equipment",
        inputSchema: {
          type: "object",
          properties: {
            productSku: { type: "string", description: "Selected catalogue product identifier" },
            quantity: { type: "integer", description: "Positive number of units" },
            warehouseId: { type: "string", description: "Destination warehouse identifier" },
            deliverBy: { type: "string", description: "Latest acceptable ISO-8601 delivery time" },
          },
          required: ["productSku", "quantity", "warehouseId", "deliverBy"],
          additionalProperties: false,
        },
        request: {
          method: "POST",
          pathTemplate: contract.orderPath,
          queryTemplate: {},
          headerTemplate: {},
          bodyTemplate: {
            [contract.orderFields.productSku]: "{{input.productSku}}",
            [contract.orderFields.quantity]: "{{input.quantity}}",
            [contract.orderFields.warehouseId]: "{{input.warehouseId}}",
            [contract.orderFields.deliverBy]: "{{input.deliverBy}}",
          },
        },
        response: {
          acceptedStatuses: [200, 201],
          outputPointers: {
            orderId: "/order/id",
            productSku: "/order/product_sku",
            quantity: "/order/quantity",
            warehouseId: "/order/warehouse_id",
            deliverBy: "/order/deliver_by",
          },
        },
        safety: { idempotency: "required", timeoutMs: 5_000, maxResponseBytes: 100_000 },
      },
    ],
    provenance: {
      documentationHash: hashDocumentation(documentation),
      model: `manual-plumbing-proof-before-${EXPERIMENT_LIMITS.model}`,
      createdAt,
    },
  };
}
