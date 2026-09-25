import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { JsonValue } from "../manifest.js";
import type { DocumentationBundle } from "./contract.js";
import type { ErpNextDatabase } from "./erpnext-fixture.js";

type HttpMethod = "GET" | "POST" | "PUT";
type CredentialProfile = "full" | "read-only" | "incomplete" | "verifier";

const TOKENS: Record<CredentialProfile, string> = {
  full: "token dev-full-key:dev-full-secret",
  "read-only": "token dev-read-key:dev-read-secret",
  incomplete: "token dev-incomplete-key:dev-incomplete-secret",
  verifier: "token dev-verifier-key:dev-verifier-secret",
};

const PERMISSIONS: Record<CredentialProfile, ReadonlySet<HttpMethod>> = {
  full: new Set(["GET", "POST", "PUT"]),
  "read-only": new Set(["GET"]),
  incomplete: new Set(["GET", "PUT"]),
  verifier: new Set(["GET"]),
};

export const SECRET_ALIASES: Record<CredentialProfile, string> = {
  full: "ERPNEXT_DEV_FULL_TOKEN",
  "read-only": "ERPNEXT_DEV_READ_ONLY_TOKEN",
  incomplete: "ERPNEXT_DEV_INCOMPLETE_TOKEN",
  verifier: "ERPNEXT_DEV_VERIFIER_TOKEN",
};

export const SECRET_VALUES: Record<string, string> = Object.fromEntries(
  (Object.keys(TOKENS) as CredentialProfile[]).map((profile) => [SECRET_ALIASES[profile], TOKENS[profile]]),
);

export interface ErpNextFixtureServerHandle {
  app: FastifyInstance;
  baseUrl: string;
  documentation: DocumentationBundle;
  clearFaults(): void;
  close(): Promise<void>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function documentationBundle(): DocumentationBundle {
  const content: Record<string, JsonValue> = {
    openapi: "3.1.0",
    info: {
      title: "ERPNext REST-compatible development fixture",
      version: "1.0.0",
      description:
        "Local synthetic fixture implementing the documented ERPNext resource request shape for development tests.",
    },
    servers: [{ url: "BASE_URL_ALIAS:customer_system" }],
    security: [{ tokenAuthentication: [] }],
    components: {
      securitySchemes: {
        tokenAuthentication: {
          type: "apiKey",
          in: "header",
          name: "Authorization",
          description: "ERPNext token authentication in the form token api_key:api_secret.",
        },
      },
    },
    paths: {
      "/api/resource/Sales%20Order/{name}": {
        get: {
          operationId: "readSalesOrder",
          parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Document envelope with a data property." } },
        },
        put: {
          operationId: "updateSalesOrder",
          parameters: [
            { name: "name", in: "path", required: true, schema: { type: "string" } },
            { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "cf_dispatch_status",
                    "cf_carrier",
                    "cf_service",
                    "cf_tracking_number",
                    "cf_label_reference",
                  ],
                },
              },
            },
          },
          responses: { "200": { description: "Updated document envelope." }, "403": { description: "Not permitted." } },
        },
      },
      "/api/resource/Delivery%20Note": {
        post: {
          operationId: "createDeliveryNote",
          parameters: [
            { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "sales_order",
                    "carrier",
                    "service",
                    "tracking_number",
                    "label_reference",
                  ],
                },
              },
            },
          },
          responses: {
            "201": { description: "Created document envelope." },
            "200": { description: "Existing document returned for an idempotent retry." },
            "403": { description: "Not permitted." },
            "422": { description: "Business precondition failed." },
          },
        },
      },
      "/api/resource/Delivery%20Note/{name}": {
        get: {
          operationId: "readDeliveryNote",
          parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Document envelope with a data property." } },
        },
      },
    },
  };
  return {
    mediaType: "application/json",
    content,
    sha256: createHash("sha256").update(canonical(content)).digest("hex"),
  };
}

function authenticate(authorization: unknown): CredentialProfile | undefined {
  if (typeof authorization !== "string") return undefined;
  return (Object.keys(TOKENS) as CredentialProfile[]).find((profile) => TOKENS[profile] === authorization);
}

function documentFor(database: ErpNextDatabase, doctype: string, name: string): Record<string, unknown> | undefined {
  const tables: Record<string, string> = {
    "Sales Order": "tabSalesOrder",
    "Delivery Note": "tabDeliveryNote",
  };
  const table = tables[doctype];
  if (!table) return undefined;
  return database.prepare(`SELECT * FROM ${table} WHERE name = ?`).get(name) as Record<string, unknown> | undefined;
}

function bodyObject(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function requiredStrings(body: Record<string, unknown>, fields: string[]): string[] | undefined {
  const values = fields.map((field) => body[field]);
  return values.every((value) => typeof value === "string" && value.length > 0) ? (values as string[]) : undefined;
}

export async function startErpNextFixtureServer(database: ErpNextDatabase): Promise<ErpNextFixtureServerHandle> {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  const lostResponses = new Set<string>();

  app.addHook("preHandler", async (request, reply) => {
    if (request.url === "/health") return;
    const profile = authenticate(request.headers.authorization);
    if (!profile) return reply.code(401).send({ exc_type: "AuthenticationError", message: "Invalid token." });
    const method = request.method as HttpMethod;
    if (!PERMISSIONS[profile].has(method)) {
      return reply.code(403).send({ exc_type: "PermissionError", message: `${profile} cannot perform ${method}.` });
    }
    request.headers["x-fixture-profile"] = profile;
  });

  app.get("/health", async () => ({ ok: true, adapter: "erpnext-rest-compatible-fixture-v1" }));

  app.get<{ Params: { doctype: string; name: string } }>(
    "/api/resource/:doctype/:name",
    async (request, reply) => {
      const document = documentFor(database, request.params.doctype, request.params.name);
      if (!document) return reply.code(404).send({ exc_type: "DoesNotExistError", message: "Document not found." });
      return { data: document };
    },
  );

  app.post<{ Params: { doctype: string } }>("/api/resource/:doctype", async (request, reply) => {
    if (request.params.doctype !== "Delivery Note") {
      return reply.code(404).send({ exc_type: "DoesNotExistError", message: "Unsupported DocType." });
    }
    const profile = String(request.headers["x-fixture-profile"] ?? "unknown");
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 16) {
      return reply.code(400).send({ exc_type: "ValidationError", message: "Idempotency-Key is required." });
    }
    const existing = database
      .prepare("SELECT * FROM tabDeliveryNote WHERE idempotency_key = ?")
      .get(idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) return reply.code(200).send({ data: existing, idempotent_replay: true });
    const body = bodyObject(request.body);
    const values = requiredStrings(body, [
      "sales_order",
      "carrier",
      "service",
      "tracking_number",
      "label_reference",
    ]);
    if (!values) {
      return reply.code(400).send({ exc_type: "ValidationError", message: "Required delivery fields are missing." });
    }
    const salesOrderId = values[0]!;
    const carrier = values[1]!;
    const service = values[2]!;
    const trackingNumber = values[3]!;
    const labelReference = values[4]!;
    const order = database
      .prepare("SELECT * FROM tabSalesOrder WHERE name = ?")
      .get(salesOrderId) as Record<string, unknown> | undefined;
    if (!order) return reply.code(422).send({ exc_type: "ValidationError", message: "Sales order does not exist." });
    const address = database
      .prepare("SELECT name FROM tabAddress WHERE customer_name = ? AND address_type = 'Shipping'")
      .get(String(order.customer));
    if (!address) {
      return reply.code(422).send({ exc_type: "ValidationError", message: "A valid shipping address is required." });
    }
    const item = database
      .prepare("SELECT * FROM tabSalesOrderItem WHERE parent = ?")
      .get(salesOrderId) as Record<string, unknown> | undefined;
    if (!item) return reply.code(422).send({ exc_type: "ValidationError", message: "Sales order has no items." });
    const stock = database
      .prepare("SELECT actual_qty, reserved_qty FROM tabBin WHERE item_code = ? AND warehouse = ?")
      .get(String(item.item_code), String(item.warehouse)) as Record<string, unknown> | undefined;
    if (!stock || Number(stock.actual_qty) - Number(stock.reserved_qty) < Number(item.qty)) {
      return reply.code(422).send({ exc_type: "ValidationError", message: "Insufficient available stock." });
    }
    const documentName = `DN-${salesOrderId}`;
    if (request.headers["x-capability-test"] === "1") {
      return reply.code(201).send({
        data: { name: documentName, sales_order: salesOrderId, carrier, service, tracking_number: trackingNumber },
        test_mode: true,
      });
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(
          `INSERT INTO tabDeliveryNote
            (name, customer, sales_order, posting_date, status, docstatus, carrier,
             service, tracking_number, label_reference, idempotency_key, modified)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          documentName,
          String(order.customer),
          salesOrderId,
          "2026-07-26",
          "Submitted",
          1,
          carrier,
          service,
          trackingNumber,
          labelReference,
          idempotencyKey,
          "2026-07-26T09:00:00.000Z",
        );
      database
        .prepare("INSERT INTO tabDeliveryNoteItem VALUES (?, ?, ?, ?, ?)")
        .run(`DNI-${salesOrderId}`, documentName, String(item.item_code), Number(item.qty), String(item.warehouse));
      database
        .prepare(
          `INSERT INTO world_write_audit
            (credential_profile, method, route, doctype, document_name, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(profile, "POST", "/api/resource/Delivery Note", "Delivery Note", documentName, idempotencyKey, "2026-07-26T09:00:00.000Z");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const created = documentFor(database, "Delivery Note", documentName);
    if (request.headers["x-inject-lost-response"] === "true" && !lostResponses.has(idempotencyKey)) {
      lostResponses.add(idempotencyKey);
      return reply.code(503).send({ exc_type: "SimulatedLostResponse", message: "The write committed but the response was lost." });
    }
    return reply.code(201).send({ data: created, idempotent_replay: false });
  });

  app.put<{ Params: { doctype: string; name: string } }>(
    "/api/resource/:doctype/:name",
    async (request, reply) => {
      if (request.params.doctype !== "Sales Order") {
        return reply.code(404).send({ exc_type: "DoesNotExistError", message: "Unsupported DocType." });
      }
      const profile = String(request.headers["x-fixture-profile"] ?? "unknown");
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || idempotencyKey.length < 16) {
        return reply.code(400).send({ exc_type: "ValidationError", message: "Idempotency-Key is required." });
      }
      const body = bodyObject(request.body);
      const values = requiredStrings(body, [
        "cf_dispatch_status",
        "cf_carrier",
        "cf_service",
        "cf_tracking_number",
        "cf_label_reference",
      ]);
      if (!values) return reply.code(400).send({ exc_type: "ValidationError", message: "Required fields are missing." });
      const status = values[0]!;
      const carrier = values[1]!;
      const service = values[2]!;
      const trackingNumber = values[3]!;
      const labelReference = values[4]!;
      const note = database
        .prepare("SELECT name FROM tabDeliveryNote WHERE sales_order = ?")
        .get(request.params.name);
      if (!note) {
        return reply.code(422).send({ exc_type: "ValidationError", message: "A submitted delivery record is required first." });
      }
      if (request.headers["x-capability-test"] !== "1") {
        const result = database
          .prepare(
            `UPDATE tabSalesOrder SET cf_dispatch_status = ?, cf_carrier = ?, cf_service = ?,
              cf_tracking_number = ?, cf_label_reference = ?, modified = ? WHERE name = ?`,
          )
          .run(
            status,
            carrier,
            service,
            trackingNumber,
            labelReference,
            "2026-07-26T09:00:00.000Z",
            request.params.name,
          );
        if (Number(result.changes) !== 1) {
          return reply.code(404).send({ exc_type: "DoesNotExistError", message: "Sales order not found." });
        }
        database
          .prepare(
            `INSERT INTO world_write_audit
              (credential_profile, method, route, doctype, document_name, idempotency_key, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(profile, "PUT", "/api/resource/Sales Order/:name", "Sales Order", request.params.name, idempotencyKey, "2026-07-26T09:00:00.000Z");
      }
      return { data: documentFor(database, "Sales Order", request.params.name), test_mode: request.headers["x-capability-test"] === "1" };
    },
  );

  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    app,
    baseUrl: address,
    documentation: documentationBundle(),
    clearFaults: () => lostResponses.clear(),
    close: () => app.close(),
  };
}
