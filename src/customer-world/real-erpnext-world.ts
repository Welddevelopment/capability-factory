import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CapabilityManifest, JsonValue } from "../manifest.js";
import type { RuntimeConfiguration } from "../runtime.js";
import type {
  CustomerWorldCase,
  CustomerWorldHandle,
  DirectVerificationResult,
  DocumentationBundle,
} from "./contract.js";
import { ERP_NEXT_CASES } from "./erpnext-fixture.js";

const REAL_CASES: readonly CustomerWorldCase[] = ERP_NEXT_CASES.map((testCase) => ({
  ...testCase,
  ordinaryGoal: testCase.ordinaryGoal.replaceAll("SO-DEV-", "SO-REAL-"),
}));

const REAL_TOKENS = {
  full: "token cffullkey000001:cffullsecret000001",
  "read-only": "token cfreadkey000001:cfreadsecret000001",
  incomplete: "token cfincompletekey1:cfincompletesecret1",
} as const;

const REAL_ALIASES = {
  full: "ERPNEXT_REAL_FULL_TOKEN",
  "read-only": "ERPNEXT_REAL_READ_ONLY_TOKEN",
  incomplete: "ERPNEXT_REAL_INCOMPLETE_TOKEN",
} as const;

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

function realDocumentation(): DocumentationBundle {
  const content: Record<string, JsonValue> = {
    openapi: "3.1.0",
    info: { title: "ERPNext resource API", version: "16.29.0" },
    servers: [{ url: "BASE_URL_ALIAS:customer_system" }],
    security: [{ tokenAuthentication: [] }],
    components: {
      securitySchemes: {
        tokenAuthentication: {
          type: "apiKey",
          in: "header",
          name: "Authorization",
          description: "Trusted runtime supplies the configured token credential alias. Never place a token literal in a request template.",
        },
      },
      schemas: {
        DeliveryNoteCreate: {
          type: "object",
          required: [
            "company",
            "customer",
            "posting_date",
            "currency",
            "selling_price_list",
            "price_list_currency",
            "conversion_rate",
            "plc_conversion_rate",
            "custom_cf_dispatch_status",
            "custom_cf_carrier",
            "custom_cf_service",
            "custom_cf_tracking_number",
            "custom_cf_label_reference",
            "custom_cf_idempotency_key",
            "items",
          ],
          properties: {
            company: { type: "string", const: "Capability Factory Development" },
            customer: { type: "string", description: "Exact customer from the source Sales Order." },
            posting_date: { type: "string", const: "2026-07-26" },
            currency: { type: "string", const: "GBP" },
            selling_price_list: { type: "string", const: "Standard Selling" },
            price_list_currency: { type: "string", const: "GBP" },
            conversion_rate: { type: "number", const: 1 },
            plc_conversion_rate: { type: "number", const: 1 },
            custom_cf_dispatch_status: { type: "string", const: "Prepared" },
            custom_cf_carrier: { type: "string", const: "ParcelFlow" },
            custom_cf_service: { type: "string", const: "Standard Overnight" },
            custom_cf_tracking_number: { type: "string" },
            custom_cf_label_reference: { type: "string" },
            custom_cf_idempotency_key: {
              type: "string",
              description: "Unique operation key. Search this field before retrying because the resource API has no native idempotency header.",
            },
            items: {
              type: "array",
              minItems: 1,
              maxItems: 1,
              items: {
                type: "object",
                required: [
                  "item_code",
                  "item_name",
                  "description",
                  "qty",
                  "uom",
                  "stock_uom",
                  "conversion_factor",
                  "rate",
                  "amount",
                  "warehouse",
                  "against_sales_order",
                  "so_detail",
                ],
                properties: {
                  item_code: { type: "string", const: "DEMO-WIDGET" },
                  item_name: { type: "string", const: "Fictional Demo Widget" },
                  description: { type: "string", const: "Synthetic item for local testing." },
                  qty: { type: "number", const: 1 },
                  uom: { type: "string", const: "Nos" },
                  stock_uom: { type: "string", const: "Nos" },
                  conversion_factor: { type: "number", const: 1 },
                  rate: { type: "number", const: 100 },
                  amount: { type: "number", const: 100 },
                  warehouse: { type: "string", const: "Stores - CFD" },
                  against_sales_order: { type: "string", description: "Exact source Sales Order name." },
                  so_detail: { type: "string", description: "Exact source Sales Order Item row name." },
                },
              },
            },
          },
        },
        SalesOrderDispatchUpdate: {
          type: "object",
          required: [
            "custom_cf_dispatch_status",
            "custom_cf_carrier",
            "custom_cf_service",
            "custom_cf_tracking_number",
            "custom_cf_label_reference",
          ],
          properties: {
            custom_cf_dispatch_status: { type: "string", const: "Prepared" },
            custom_cf_carrier: { type: "string", const: "ParcelFlow" },
            custom_cf_service: { type: "string", const: "Standard Overnight" },
            custom_cf_tracking_number: { type: "string" },
            custom_cf_label_reference: { type: "string" },
          },
        },
      },
    },
    paths: {
      "/api/resource/Sales%20Order/{name}": {
        get: {
          operationId: "readSalesOrder",
          description: "Returns data.name, data.customer, data.shipping_address_name, and data.items. The first item exposes name, item_code, qty, and warehouse.",
          responses: { "200": { description: "Sales Order document wrapped in data" } },
        },
        put: {
          operationId: "updateSalesOrder",
          requestBody: { required: true, schema: { "$ref": "#/components/schemas/SalesOrderDispatchUpdate" } },
          responses: { "200": { description: "Updated Sales Order document" }, "403": { description: "Not permitted" } },
        },
      },
      "/api/resource/Delivery%20Note": {
        get: {
          operationId: "listDeliveryNotes",
          description: "Use fields as a JSON-array query and filters as a JSON array of [field, operator, value]. Search custom_cf_idempotency_key before retrying a create.",
          responses: { "200": { description: "Filtered Delivery Note list wrapped in data" } },
        },
        post: {
          operationId: "createDeliveryNote",
          requestBody: { required: true, schema: { "$ref": "#/components/schemas/DeliveryNoteCreate" } },
          responses: {
            "200": { description: "Created Delivery Note document" },
            "403": { description: "Not permitted" },
            "409": { description: "Unique-field conflict" },
          },
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

function property(type: "string", description: string) {
  return { type, description } as const;
}

export function createRealErpNextReferenceCapability(
  documentation: DocumentationBundle,
  secretAlias: string,
): CapabilityManifest {
  return {
    schemaVersion: "1",
    id: "erpnext-real-dispatch-preparation",
    version: "1.0.0",
    service: "ERPNext v16 REST resource API",
    description: "Read one Sales Order, create its Delivery Note, reconcile safe retries, and record dispatch fields.",
    baseUrlAlias: "customer_system",
    auth: { kind: "apiKey", secretAlias, headerName: "Authorization" },
    actions: [
      {
        name: "read_sales_order",
        description: "Read one submitted Sales Order by exact document name.",
        inputSchema: {
          type: "object",
          properties: { salesOrderId: property("string", "Exact Sales Order name") },
          required: ["salesOrderId"],
          additionalProperties: false,
        },
        request: {
          method: "GET",
          pathTemplate: "/api/resource/Sales%20Order/{{input.salesOrderId}}",
          queryTemplate: {},
          headerTemplate: {},
          bodyTemplate: null,
        },
        response: {
          acceptedStatuses: [200],
          outputPointers: {
            document: "/data",
            customerId: "/data/customer",
            salesOrderItemId: "/data/items/0/name",
          },
        },
        safety: { idempotency: "none", timeoutMs: 5_000, maxResponseBytes: 500_000 },
      },
      {
        name: "find_delivery_note",
        description: "Find an existing Delivery Note by its unique idempotency field before retrying a write.",
        inputSchema: {
          type: "object",
          properties: { idempotencyKey: property("string", "Unique operation key") },
          required: ["idempotencyKey"],
          additionalProperties: false,
        },
        request: {
          method: "GET",
          pathTemplate: "/api/resource/Delivery%20Note",
          queryTemplate: {
            fields: '["name","custom_cf_idempotency_key","custom_cf_tracking_number"]',
            filters: '[["custom_cf_idempotency_key","=","{{input.idempotencyKey}}"]]',
          },
          headerTemplate: {},
          bodyTemplate: null,
        },
        response: { acceptedStatuses: [200], outputPointers: { matches: "/data" } },
        safety: { idempotency: "none", timeoutMs: 5_000, maxResponseBytes: 100_000 },
      },
      {
        name: "create_delivery_note",
        description: "Create one draft Delivery Note for the exact submitted Sales Order.",
        inputSchema: {
          type: "object",
          properties: {
            salesOrderId: property("string", "Exact source Sales Order name"),
            salesOrderItemId: property("string", "Exact source Sales Order Item row name"),
            customerId: property("string", "Exact linked Customer name"),
            trackingNumber: property("string", "Tracking reference"),
            labelReference: property("string", "Label reference"),
            idempotencyKey: property("string", "Unique operation key retained on the document"),
          },
          required: [
            "salesOrderId",
            "salesOrderItemId",
            "customerId",
            "trackingNumber",
            "labelReference",
            "idempotencyKey",
          ],
          additionalProperties: false,
        },
        request: {
          method: "POST",
          pathTemplate: "/api/resource/Delivery%20Note",
          queryTemplate: {},
          headerTemplate: {},
          bodyTemplate: {
            company: "Capability Factory Development",
            customer: "{{input.customerId}}",
            posting_date: "2026-07-26",
            currency: "GBP",
            selling_price_list: "Standard Selling",
            price_list_currency: "GBP",
            conversion_rate: 1,
            plc_conversion_rate: 1,
            custom_cf_dispatch_status: "Prepared",
            custom_cf_carrier: "ParcelFlow",
            custom_cf_service: "Standard Overnight",
            custom_cf_tracking_number: "{{input.trackingNumber}}",
            custom_cf_label_reference: "{{input.labelReference}}",
            custom_cf_idempotency_key: "{{input.idempotencyKey}}",
            items: [
              {
                item_code: "DEMO-WIDGET",
                item_name: "Fictional Demo Widget",
                description: "Synthetic item for local testing.",
                qty: 1,
                uom: "Nos",
                stock_uom: "Nos",
                conversion_factor: 1,
                rate: 100,
                amount: 100,
                warehouse: "Stores - CFD",
                against_sales_order: "{{input.salesOrderId}}",
                so_detail: "{{input.salesOrderItemId}}",
              },
            ],
          },
        },
        response: { acceptedStatuses: [200, 201], outputPointers: { documentName: "/data/name" } },
        safety: { idempotency: "required", timeoutMs: 10_000, maxResponseBytes: 500_000 },
      },
      {
        name: "update_sales_order",
        description: "Record the prepared Delivery Note details on the exact submitted Sales Order.",
        inputSchema: {
          type: "object",
          properties: {
            salesOrderId: property("string", "Exact Sales Order name"),
            trackingNumber: property("string", "Tracking reference"),
            labelReference: property("string", "Label reference"),
          },
          required: ["salesOrderId", "trackingNumber", "labelReference"],
          additionalProperties: false,
        },
        request: {
          method: "PUT",
          pathTemplate: "/api/resource/Sales%20Order/{{input.salesOrderId}}",
          queryTemplate: {},
          headerTemplate: {},
          bodyTemplate: {
            custom_cf_dispatch_status: "Prepared",
            custom_cf_carrier: "ParcelFlow",
            custom_cf_service: "Standard Overnight",
            custom_cf_tracking_number: "{{input.trackingNumber}}",
            custom_cf_label_reference: "{{input.labelReference}}",
          },
        },
        response: { acceptedStatuses: [200], outputPointers: { document: "/data" } },
        safety: { idempotency: "required", timeoutMs: 10_000, maxResponseBytes: 500_000 },
      },
    ],
    provenance: {
      documentationHash: documentation.sha256,
      model: "deterministic-reference-no-model",
      createdAt: "2026-07-26T09:00:00.000Z",
    },
  };
}

interface RealWorldOptions {
  repositoryRoot: string;
  composeDirectory?: string;
  dockerBinary?: string;
  dockerConfigDirectory?: string;
  baseUrl?: string;
}

interface SeedResult {
  state_hash: string;
}

interface VerifyResult {
  case_id: string;
  passed: boolean;
  intended_writes: number;
  incorrect_side_effects: number;
  state_hash: string;
  issues: DirectVerificationResult["issues"];
}

function lastJsonObject(output: string): Record<string, unknown> {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  throw new Error(`ERPNext command did not return a JSON object: ${output.slice(-1_000)}`);
}

export class RealErpNextWorldHandle implements CustomerWorldHandle {
  readonly id = "erpnext-real-dispatch-development-world";
  readonly adapterKind = "Genuine local Frappe 16.28.0 / ERPNext 16.29.0 disposable application";
  readonly documentation = realDocumentation();
  readonly startingCapabilities = [
    { id: "ordinary-goal-reader", description: "Read the ordinary goal and report completion or a precise block." },
  ];
  readonly cases = REAL_CASES;
  readonly baseUrl: string;
  private readonly composeDirectory: string;
  private readonly dockerBinary: string;
  private readonly dockerConfigDirectory: string;
  private readonly seedScript: string;
  private activeCaseId = "first-build";

  constructor(options: RealWorldOptions) {
    this.baseUrl = options.baseUrl ?? process.env.CF_ERPNEXT_BASE_URL ?? "http://127.0.0.1:8080";
    this.composeDirectory =
      options.composeDirectory ??
      process.env.CF_ERPNEXT_COMPOSE_DIR ??
      path.join(options.repositoryRoot, "fixtures", "erpnext");
    this.dockerBinary =
      options.dockerBinary ??
      process.env.CF_DOCKER_BIN ??
      path.join(options.repositoryRoot, ".local-tools", "bin", "docker");
    this.dockerConfigDirectory =
      options.dockerConfigDirectory ??
      process.env.CF_DOCKER_CONFIG ??
      path.join(options.repositoryRoot, ".local-tools", "docker-config");
    this.seedScript = path.join(options.repositoryRoot, "scripts", "erpnext", "seed_real_world.py");
  }

  private docker(args: string[], extraEnvironment: Record<string, string> = {}): string {
    return execFileSync(this.dockerBinary, args, {
      cwd: this.composeDirectory,
      encoding: "utf8",
      maxBuffer: 10_000_000,
      env: { ...process.env, DOCKER_CONFIG: this.dockerConfigDirectory, ...extraEnvironment },
    });
  }

  installSeedModule(): void {
    if (!fs.existsSync(this.seedScript)) throw new Error(`Missing real ERPNext seed module: ${this.seedScript}`);
    this.docker([
      "compose",
      "-p",
      "capability-factory-erpnext",
      "-f",
      "compose.yml",
      "cp",
      this.seedScript,
      "backend:/home/frappe/frappe-bench/apps/frappe/frappe/cf_seed_real_world.py",
    ]);
  }

  reset(caseId: string): string {
    if (!this.cases.some((candidate) => candidate.id === caseId)) throw new Error(`Unknown real ERPNext case: ${caseId}`);
    this.activeCaseId = caseId;
    this.installSeedModule();
    const output = this.docker([
      "compose",
      "-p",
      "capability-factory-erpnext",
      "-f",
      "compose.yml",
      "exec",
      "-T",
      "-e",
      `CF_CASE=${caseId}`,
      "backend",
      "bench",
      "--site",
      "frontend",
      "execute",
      "frappe.cf_seed_real_world.main",
    ]);
    const result = lastJsonObject(output) as unknown as SeedResult;
    return result.state_hash;
  }

  runtimeConfiguration(caseId: string): RuntimeConfiguration {
    const testCase = this.cases.find((candidate) => candidate.id === caseId);
    if (!testCase) throw new Error(`Unknown real ERPNext case: ${caseId}`);
    const profile = testCase.credentialProfile as keyof typeof REAL_ALIASES;
    const alias = REAL_ALIASES[profile];
    const token = REAL_TOKENS[profile];
    return {
      targets: {
        customer_system: {
          baseUrl: this.baseUrl,
          allowedPaths: ["/api/resource/Sales%20Order/:name", "/api/resource/Delivery%20Note"],
          allowedMethods: {
            GET: ["/api/resource/Sales%20Order/:name", "/api/resource/Delivery%20Note"],
            POST: ["/api/resource/Delivery%20Note"],
            PUT: ["/api/resource/Sales%20Order/:name"],
          },
        },
      },
      secrets: { [alias]: token },
    };
  }

  secretAlias(caseId: string): string {
    const testCase = this.cases.find((candidate) => candidate.id === caseId);
    if (!testCase) throw new Error(`Unknown real ERPNext case: ${caseId}`);
    return REAL_ALIASES[testCase.credentialProfile as keyof typeof REAL_ALIASES];
  }

  verify(caseId: string): DirectVerificationResult {
    if (caseId !== this.activeCaseId) throw new Error(`Case ${caseId} is not active; reset it first.`);
    const output = this.docker([
      "compose",
      "-p",
      "capability-factory-erpnext",
      "-f",
      "compose.yml",
      "exec",
      "-T",
      "backend",
      "bench",
      "--site",
      "frontend",
      "execute",
      "frappe.cf_seed_real_world.verify_case",
      "--args",
      JSON.stringify([caseId]),
    ]);
    const result = lastJsonObject(output) as unknown as VerifyResult;
    return {
      caseId: result.case_id,
      passed: result.passed,
      intendedWrites: result.intended_writes,
      incorrectSideEffects: result.incorrect_side_effects,
      stateHash: result.state_hash,
      issues: result.issues,
    };
  }

  stateHash(): string {
    const output = this.docker([
      "compose",
      "-p",
      "capability-factory-erpnext",
      "-f",
      "compose.yml",
      "exec",
      "-T",
      "backend",
      "bench",
      "--site",
      "frontend",
      "execute",
      "frappe.cf_seed_real_world.evidence_for_case",
      "--args",
      JSON.stringify([this.activeCaseId]),
    ]);
    return String(lastJsonObject(output).state_hash);
  }

  async close(): Promise<void> {
    // The genuine local stack is intentionally left running for subsequent overnight cases.
  }
}

export async function startRealErpNextWorld(options: RealWorldOptions): Promise<RealErpNextWorldHandle> {
  const baseUrl = options.baseUrl ?? process.env.CF_ERPNEXT_BASE_URL ?? "http://127.0.0.1:8080";
  const response = await fetch(`${baseUrl}/api/method/ping`);
  if (!response.ok) throw new Error(`Real ERPNext health check failed with HTTP ${response.status}.`);
  const handle = new RealErpNextWorldHandle({ ...options, baseUrl });
  handle.installSeedModule();
  return handle;
}
