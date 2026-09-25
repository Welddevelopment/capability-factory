import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { CompanyDatabase } from "./database.js";
import type { ProcurementContract, Scenario } from "./scenario.js";

function openApiDocument(baseUrl: string, contract: ProcurementContract): Record<string, unknown> {
  const query = contract.queryFields;
  const order = contract.orderFields;
  const securityScheme =
    contract.auth.kind === "bearer"
      ? { type: "http", scheme: "bearer" }
      : {
          type: "apiKey",
          in: "header",
          name: contract.auth.kind === "apiKey" ? contract.auth.headerName : "unused",
        };
  return {
    openapi: "3.1.0",
    info: { title: "Equipment acquisition service", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    components: { securitySchemes: { serviceCredential: securityScheme } },
    security: [{ serviceCredential: [] }],
    paths: {
      [contract.catalogPath]: {
        get: {
          operationId: "searchAvailableEquipment",
          description:
            "Find products whose supported range covers the complete required temperature range and that can arrive by the deadline.",
          parameters: [
            { in: "query", name: query.requiredMinTemp, required: true, schema: { type: "number" } },
            { in: "query", name: query.requiredMaxTemp, required: true, schema: { type: "number" } },
            { in: "query", name: query.deliverBy, required: true, schema: { type: "string", format: "date-time" } },
          ],
          responses: {
            200: {
              description: "Matching products",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["products"],
                    properties: {
                      products: {
                        type: "array",
                        items: {
                          type: "object",
                          required: [
                            "product_sku",
                            "name",
                            "min_temp_c",
                            "max_temp_c",
                            "lead_time_hours",
                            "price_cents",
                          ],
                          properties: {
                            product_sku: { type: "string" },
                            name: { type: "string" },
                            min_temp_c: { type: "number" },
                            max_temp_c: { type: "number" },
                            lead_time_hours: { type: "integer" },
                            price_cents: { type: "integer" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      [contract.orderPath]: {
        post: {
          operationId: "createPurchaseOrder",
          description:
            "Create one purchase order. The Idempotency-Key header is mandatory and makes safe retries return the original order.",
          parameters: [
            { in: "header", name: "Idempotency-Key", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: [order.productSku, order.quantity, order.warehouseId, order.deliverBy],
                  properties: {
                    [order.productSku]: { type: "string", description: "Catalogue product identifier" },
                    [order.quantity]: { type: "integer", minimum: 1 },
                    [order.warehouseId]: { type: "string", description: "Receiving warehouse identifier" },
                    [order.deliverBy]: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          responses: {
            201: {
              description: "Order created",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["order", "idempotentReplay"],
                    properties: {
                      order: {
                        type: "object",
                        required: ["id", "product_sku", "quantity", "warehouse_id", "deliver_by"],
                        properties: {
                          id: { type: "string" },
                          product_sku: { type: "string" },
                          quantity: { type: "integer" },
                          warehouse_id: { type: "string" },
                          deliver_by: { type: "string", format: "date-time" },
                        },
                      },
                      idempotentReplay: { type: "boolean" },
                    },
                  },
                },
              },
            },
            200: { description: "Existing idempotent order returned; same schema as 201" },
            403: { description: "Credential lacks write permission" },
            422: { description: "Request is valid JSON but cannot be fulfilled" },
          },
        },
      },
    },
  };
}

function queryValue(query: Record<string, unknown>, field: string): string | undefined {
  const value = query[field];
  return typeof value === "string" ? value : undefined;
}

function authenticate(headers: Record<string, unknown>, scenario: Scenario): boolean {
  const auth = scenario.contract.auth;
  if (auth.kind === "bearer") {
    return headers.authorization === `Bearer ${scenario.credential.secretValue}`;
  }
  const supplied = headers[auth.headerName.toLowerCase()];
  return supplied === scenario.credential.secretValue;
}

export interface CompanyServerHandle {
  app: FastifyInstance;
  baseUrl: string;
  aliases: Record<string, string>;
  allowedPaths: Record<string, string[]>;
  documentation: Record<string, unknown>;
  close(): Promise<void>;
}

export async function startCompanyServer(
  database: CompanyDatabase,
  scenario: Scenario,
): Promise<CompanyServerHandle> {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  let structuredFailuresRemaining = scenario.orderBehavior?.structuredFailuresBeforeSuccess ?? 0;

  app.get("/health", async () => ({ ok: true, scenarioId: scenario.id }));

  app.get("/shipments/v1/shipments", async () => ({
    shipments: database.prepare("SELECT id, arrival_at, warehouse_id, min_temp_c, max_temp_c FROM shipments ORDER BY id").all(),
  }));

  app.get<{ Params: { warehouseId: string } }>(
    "/warehouses/v1/warehouses/:warehouseId/equipment",
    async (request) => ({
      warehouseId: request.params.warehouseId,
      equipment: database
        .prepare(
          "SELECT id, product_sku, min_temp_c, max_temp_c FROM installed_equipment WHERE warehouse_id = ? ORDER BY id",
        )
        .all(request.params.warehouseId),
    }),
  );

  app.get(scenario.contract.catalogPath, async (request, reply) => {
    if (!authenticate(request.headers, scenario)) {
      return reply.code(401).send({ error: "invalid_credential" });
    }
    const query = request.query as Record<string, unknown>;
    const minRaw = queryValue(query, scenario.contract.queryFields.requiredMinTemp);
    const maxRaw = queryValue(query, scenario.contract.queryFields.requiredMaxTemp);
    const deliverBy = queryValue(query, scenario.contract.queryFields.deliverBy);
    const requiredMin = Number(minRaw);
    const requiredMax = Number(maxRaw);
    if (!Number.isFinite(requiredMin) || !Number.isFinite(requiredMax) || !deliverBy) {
      return reply.code(400).send({ error: "missing_or_invalid_search_fields" });
    }
    const availableHours = (Date.parse(deliverBy) - Date.parse(scenario.now)) / 3_600_000;
    const products = database
      .prepare(
        `SELECT product_sku, name, min_temp_c, max_temp_c, lead_time_hours, price_cents
         FROM catalog
         WHERE min_temp_c <= ? AND max_temp_c >= ? AND lead_time_hours <= ?
         ORDER BY price_cents, product_sku`,
      )
      .all(requiredMin, requiredMax, availableHours);
    return { products };
  });

  app.post(scenario.contract.orderPath, async (request, reply) => {
    if (!authenticate(request.headers, scenario)) {
      return reply.code(401).send({ error: "invalid_credential" });
    }
    if (!scenario.credential.canWrite) {
      return reply.code(403).send({ error: "missing_write_permission" });
    }
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8) {
      return reply.code(400).send({ error: "idempotency_key_required" });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const fields = scenario.contract.orderFields;
    const productSku = body[fields.productSku];
    const quantity = body[fields.quantity];
    const warehouseId = body[fields.warehouseId];
    const deliverBy = body[fields.deliverBy];
    if (
      typeof productSku !== "string" ||
      typeof quantity !== "number" ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      typeof warehouseId !== "string" ||
      typeof deliverBy !== "string"
    ) {
      return reply.code(400).send({ error: "missing_or_invalid_order_fields" });
    }
    const product = database
      .prepare("SELECT * FROM catalog WHERE product_sku = ?")
      .get(productSku) as Record<string, unknown> | undefined;
    const warehouse = database.prepare("SELECT id FROM warehouses WHERE id = ?").get(warehouseId);
    if (!product || !warehouse) {
      return reply.code(422).send({ error: "unknown_product_or_warehouse" });
    }
    const availableHours = (Date.parse(deliverBy) - Date.parse(scenario.now)) / 3_600_000;
    if (Number(product.lead_time_hours) > availableHours) {
      return reply.code(422).send({ error: "cannot_deliver_before_deadline" });
    }
    if (structuredFailuresRemaining > 0) {
      structuredFailuresRemaining -= 1;
      return reply.code(422).send({
        error: "temporary_contract_validation",
        category: "request_validation",
        retryable: true,
      });
    }
    const existing = database
      .prepare("SELECT * FROM purchase_orders WHERE idempotency_key = ?")
      .get(idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) return reply.code(200).send({ order: existing, idempotentReplay: true });

    const order = {
      id: `PO-${randomUUID()}`,
      idempotency_key: idempotencyKey,
      product_sku: productSku,
      quantity,
      warehouse_id: warehouseId,
      deliver_by: deliverBy,
      created_at: scenario.now,
    };
    if (request.headers["x-capability-test"] === "1") {
      return reply.code(201).send({ order, testMode: true });
    }
    database
      .prepare(
        `INSERT INTO purchase_orders
          (id, idempotency_key, product_sku, quantity, warehouse_id, deliver_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        order.id,
        order.idempotency_key,
        order.product_sku,
        order.quantity,
        order.warehouse_id,
        order.deliver_by,
        order.created_at,
      );
    return reply.code(201).send({ order, idempotentReplay: false });
  });

  const documentation = openApiDocument("BASE_URL_ALIAS:procurement", scenario.contract);
  app.get(scenario.contract.docsPath, async () => documentation);
  app.get("/service-directory/v1/docs", async () => ({
    documents: [
      {
        id: `docs-${scenario.id}`,
        description: "API documentation for finding equipment and requesting acquisition",
        url: scenario.contract.docsPath,
        documentationHashHint: "Compute SHA-256 over the fetched JSON document",
      },
    ],
  }));

  const address = await app.listen({ host: "127.0.0.1", port: 0 });

  return {
    app,
    baseUrl: address,
    aliases: {
      procurement: address,
      shipments: address,
      warehouses: address,
    },
    allowedPaths: {
      procurement: [scenario.contract.catalogPath, scenario.contract.orderPath],
      shipments: ["/shipments/v1/shipments"],
      warehouses: ["/warehouses/v1/warehouses/:warehouseId/equipment"],
    },
    documentation,
    close: () => app.close(),
  };
}
