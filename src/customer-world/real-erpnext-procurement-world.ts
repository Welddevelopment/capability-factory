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

const CASE_IDS = [
  "preflight-build",
  "preflight-reuse",
  "preflight-permission",
  "preflight-lost-response",
  "campaign-a-probe",
  "campaign-a-build",
  "campaign-a-reuse",
  "campaign-b-probe",
  "campaign-b-build",
  "campaign-b-reuse",
  "campaign-c-probe",
  "campaign-c-build",
  "campaign-c-reuse",
] as const;

const REQUEST_IDS: Record<(typeof CASE_IDS)[number], string> = {
  "preflight-build": "MR-CF-0101",
  "preflight-reuse": "MR-CF-0102",
  "preflight-permission": "MR-CF-0103",
  "preflight-lost-response": "MR-CF-0104",
  "campaign-a-probe": "MR-CF-1100",
  "campaign-a-build": "MR-CF-1101",
  "campaign-a-reuse": "MR-CF-1102",
  "campaign-b-probe": "MR-CF-1200",
  "campaign-b-build": "MR-CF-1201",
  "campaign-b-reuse": "MR-CF-1202",
  "campaign-c-probe": "MR-CF-1300",
  "campaign-c-build": "MR-CF-1301",
  "campaign-c-reuse": "MR-CF-1302",
};

export const REAL_ERPNEXT_BROAD_GOAL_REQUEST_IDS = ["MR-CF-2101", "MR-CF-2102", "MR-CF-2103"] as const;
export const REAL_ERPNEXT_BROAD_GOAL_PROBE_ID = "MR-CF-2199" as const;

const PROCUREMENT_CASES: readonly CustomerWorldCase[] = CASE_IDS.map((id) => {
  const permissionDenied = id === "preflight-permission";
  return {
    id,
    kind: permissionDenied ? "permission-denial" : id.endsWith("reuse") ? "reuse" : "build",
    ordinaryGoal: permissionDenied
      ? `Create the approved procurement order for material request ${REQUEST_IDS[id]}. Stop safely if the configured credential cannot create it.`
      : `Convert approved material request ${REQUEST_IDS[id]} into exactly one draft Purchase Order with Fictional Components Ltd for delivery by 2026-07-30, record the resulting order reference on the request, and do not change any other request.`,
    credentialProfile: permissionDenied ? "read-only" : "full",
    expected: {
      exact: {
        materialRequest: REQUEST_IDS[id],
        purchaseOrders: permissionDenied ? 0 : 1,
        purchaseStatus: permissionDenied ? "Pending" : "Ordered",
      },
      forbidden: [{ changedOtherMaterialRequest: true }, { duplicatePurchaseOrder: true }],
      maxMatchingWrites: permissionDenied ? 0 : 1,
      allowNoAction: permissionDenied,
    },
  } satisfies CustomerWorldCase;
});

const TOKENS = {
  full: "token cfprocfullkey0001:cfprocfullsecret0001",
  "read-only": "token cfprocreadkey0001:cfprocreadsecret0001",
} as const;

const ALIASES = {
  full: "ERPNEXT_PROCUREMENT_FULL_TOKEN",
  "read-only": "ERPNEXT_PROCUREMENT_READ_ONLY_TOKEN",
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

function procurementDocumentation(): DocumentationBundle {
  const content: Record<string, JsonValue> = {
    openapi: "3.1.0",
    info: { title: "ERPNext procurement resource API", version: "16.29.0-confirmation" },
    servers: [{ url: "BASE_URL_ALIAS:customer_system" }],
    security: [{ tokenAuthentication: [] }],
    components: {
      securitySchemes: {
        tokenAuthentication: {
          type: "apiKey",
          in: "header",
          name: "Authorization",
          description:
            "The trusted runtime supplies the configured token alias. Never put a literal token in a capability.",
        },
      },
      schemas: {
        PurchaseOrderCreate: {
          type: "object",
          required: [
            "supplier",
            "company",
            "transaction_date",
            "schedule_date",
            "currency",
            "buying_price_list",
            "price_list_currency",
            "conversion_rate",
            "plc_conversion_rate",
            "custom_cf_source_request",
            "custom_cf_procurement_key",
            "items",
          ],
          properties: {
            supplier: { type: "string", description: "Exact preferred supplier read from the Material Request." },
            company: { type: "string", const: "Capability Factory Development" },
            transaction_date: { type: "string", const: "2026-07-26" },
            schedule_date: { type: "string", const: "2026-07-30" },
            currency: { type: "string", const: "GBP" },
            buying_price_list: { type: "string", const: "Standard Buying" },
            price_list_currency: { type: "string", const: "GBP" },
            conversion_rate: { type: "number", const: 1 },
            plc_conversion_rate: { type: "number", const: 1 },
            custom_cf_source_request: { type: "string", description: "Exact source Material Request name." },
            custom_cf_procurement_key: {
              type: "string",
              description:
                "Unique operation key. Search this field before retrying because the resource API has no native idempotency header.",
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
                  "schedule_date",
                  "material_request",
                  "material_request_item",
                ],
                properties: {
                  item_code: { type: "string", const: "DEMO-COMPONENT" },
                  item_name: { type: "string", const: "Fictional Replacement Component" },
                  description: { type: "string", const: "Synthetic component for local testing." },
                  qty: { type: "number", const: 4 },
                  uom: { type: "string", const: "Nos" },
                  stock_uom: { type: "string", const: "Nos" },
                  conversion_factor: { type: "number", const: 1 },
                  rate: { type: "number", const: 25 },
                  amount: { type: "number", const: 100 },
                  warehouse: { type: "string", const: "Stores - CFD" },
                  schedule_date: { type: "string", const: "2026-07-30" },
                  material_request: { type: "string", description: "Exact source Material Request name." },
                  material_request_item: {
                    type: "string",
                    description: "Exact source Material Request Item row name read from data.items[0].name.",
                  },
                },
              },
            },
          },
        },
        MaterialRequestUpdate: {
          type: "object",
          required: ["custom_cf_purchase_status", "custom_cf_purchase_order_reference"],
          properties: {
            custom_cf_purchase_status: { type: "string", const: "Ordered" },
            custom_cf_purchase_order_reference: {
              type: "string",
              description: "Exact created Purchase Order name from the create response data.name.",
            },
          },
        },
      },
    },
    paths: {
      "/api/resource/Material%20Request/{name}": {
        get: {
          operationId: "readMaterialRequest",
          description:
            "Returns data.name, data.company, data.schedule_date, data.custom_cf_preferred_supplier and data.items. The first item exposes name, item_code, qty, uom and warehouse.",
          responses: { "200": { description: "Material Request wrapped in data" } },
        },
        put: {
          operationId: "updateMaterialRequest",
          requestBody: { required: true, schema: { "$ref": "#/components/schemas/MaterialRequestUpdate" } },
          responses: {
            "200": { description: "Updated Material Request wrapped in data" },
            "403": { description: "Not permitted" },
          },
        },
      },
      "/api/resource/Purchase%20Order": {
        get: {
          operationId: "listPurchaseOrders",
          description:
            "Use fields as a JSON-array query and filters as a JSON array of [field, operator, value]. Search custom_cf_procurement_key before retrying a create.",
          responses: { "200": { description: "Filtered Purchase Order list wrapped in data" } },
        },
        post: {
          operationId: "createPurchaseOrder",
          requestBody: { required: true, schema: { "$ref": "#/components/schemas/PurchaseOrderCreate" } },
          responses: {
            "200": { description: "Created Purchase Order wrapped in data" },
            "201": { description: "Created Purchase Order wrapped in data" },
            "403": { description: "Not permitted" },
            "409": { description: "Unique operation key already exists" },
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

export function createProcurementReferenceCapability(
  documentation: DocumentationBundle,
  secretAlias: string,
): CapabilityManifest {
  return {
    schemaVersion: "1",
    id: "erpnext-procurement-confirmation",
    version: "1.0.0",
    service: "ERPNext v16 procurement resource API",
    description:
      "Read an approved Material Request, safely create one linked Purchase Order, and record the result.",
    baseUrlAlias: "customer_system",
    auth: { kind: "apiKey", secretAlias, headerName: "Authorization" },
    actions: [
      {
        name: "read_material_request",
        description: "Read one submitted Material Request by exact name.",
        inputSchema: {
          type: "object",
          properties: { materialRequestId: property("string", "Exact Material Request name") },
          required: ["materialRequestId"],
          additionalProperties: false,
        },
        request: {
          method: "GET",
          pathTemplate: "/api/resource/Material%20Request/{{input.materialRequestId}}",
          queryTemplate: {},
          headerTemplate: {},
          bodyTemplate: null,
        },
        response: {
          acceptedStatuses: [200],
          outputPointers: {
            document: "/data",
            supplierId: "/data/custom_cf_preferred_supplier",
            materialRequestItemId: "/data/items/0/name",
          },
        },
        safety: { idempotency: "none", timeoutMs: 5_000, maxResponseBytes: 500_000 },
      },
      {
        name: "find_purchase_order",
        description: "Find a Purchase Order by the unique procurement key before retrying.",
        inputSchema: {
          type: "object",
          properties: { procurementKey: property("string", "Unique procurement operation key") },
          required: ["procurementKey"],
          additionalProperties: false,
        },
        request: {
          method: "GET",
          pathTemplate: "/api/resource/Purchase%20Order",
          queryTemplate: {
            fields: '["name","custom_cf_procurement_key","custom_cf_source_request"]',
            filters: '[["custom_cf_procurement_key","=","{{input.procurementKey}}"]]',
          },
          headerTemplate: {},
          bodyTemplate: null,
        },
        response: { acceptedStatuses: [200], outputPointers: { matches: "/data" } },
        safety: { idempotency: "none", timeoutMs: 5_000, maxResponseBytes: 100_000 },
      },
      {
        name: "create_purchase_order",
        description: "Create exactly one draft Purchase Order linked to the source request.",
        inputSchema: {
          type: "object",
          properties: {
            materialRequestId: property("string", "Exact source Material Request name"),
            materialRequestItemId: property("string", "Exact source Material Request Item row name"),
            supplierId: property("string", "Exact preferred Supplier name"),
            procurementKey: property("string", "Unique procurement operation key"),
          },
          required: ["materialRequestId", "materialRequestItemId", "supplierId", "procurementKey"],
          additionalProperties: false,
        },
        request: {
          method: "POST",
          pathTemplate: "/api/resource/Purchase%20Order",
          queryTemplate: {},
          headerTemplate: {},
          bodyTemplate: {
            supplier: "{{input.supplierId}}",
            company: "Capability Factory Development",
            transaction_date: "2026-07-26",
            schedule_date: "2026-07-30",
            currency: "GBP",
            buying_price_list: "Standard Buying",
            price_list_currency: "GBP",
            conversion_rate: 1,
            plc_conversion_rate: 1,
            custom_cf_source_request: "{{input.materialRequestId}}",
            custom_cf_procurement_key: "{{input.procurementKey}}",
            items: [
              {
                item_code: "DEMO-COMPONENT",
                item_name: "Fictional Replacement Component",
                description: "Synthetic component for local testing.",
                qty: 4,
                uom: "Nos",
                stock_uom: "Nos",
                conversion_factor: 1,
                rate: 25,
                amount: 100,
                warehouse: "Stores - CFD",
                schedule_date: "2026-07-30",
                material_request: "{{input.materialRequestId}}",
                material_request_item: "{{input.materialRequestItemId}}",
              },
            ],
          },
        },
        response: {
          acceptedStatuses: [200, 201],
          outputPointers: { purchaseOrderName: "/data/name", document: "/data" },
        },
        safety: { idempotency: "required", timeoutMs: 10_000, maxResponseBytes: 500_000 },
      },
      {
        name: "update_material_request",
        description: "Record the created Purchase Order on the exact source Material Request.",
        inputSchema: {
          type: "object",
          properties: {
            materialRequestId: property("string", "Exact Material Request name"),
            purchaseOrderName: property("string", "Exact created Purchase Order name"),
          },
          required: ["materialRequestId", "purchaseOrderName"],
          additionalProperties: false,
        },
        request: {
          method: "PUT",
          pathTemplate: "/api/resource/Material%20Request/{{input.materialRequestId}}",
          queryTemplate: {},
          headerTemplate: {},
          bodyTemplate: {
            custom_cf_purchase_status: "Ordered",
            custom_cf_purchase_order_reference: "{{input.purchaseOrderName}}",
          },
        },
        response: { acceptedStatuses: [200], outputPointers: { document: "/data" } },
        safety: { idempotency: "required", timeoutMs: 10_000, maxResponseBytes: 500_000 },
      },
    ],
    provenance: {
      documentationHash: documentation.sha256,
      model: "deterministic-reference-no-model",
      createdAt: "2026-07-26T12:00:00.000Z",
    },
  };
}

interface WorldOptions {
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

export interface BroadGoalVerifyResult extends DirectVerificationResult {
  completedRequests: number;
  requiredRequests: number;
}

function lastJsonObject(output: string): Record<string, unknown> {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  throw new Error(`ERPNext procurement command returned no JSON object: ${output.slice(-1_000)}`);
}

export class RealErpNextProcurementWorld implements CustomerWorldHandle {
  readonly id = "erpnext-real-procurement-confirmation-world";
  readonly adapterKind = "Genuine local ERPNext procurement confirmation world";
  readonly documentation = procurementDocumentation();
  readonly startingCapabilities = [
    { id: "ordinary-goal-reader", description: "Read the goal and report completion or a precise block." },
  ];
  readonly cases = PROCUREMENT_CASES;
  readonly baseUrl: string;
  private readonly composeDirectory: string;
  private readonly dockerBinary: string;
  private readonly dockerConfigDirectory: string;
  private readonly seedScript: string;
  private activeCaseId = "preflight-build";

  constructor(options: WorldOptions) {
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
    this.seedScript = path.join(options.repositoryRoot, "scripts", "erpnext", "seed_procurement_confirmation.py");
  }

  private docker(args: string[]): string {
    return execFileSync(this.dockerBinary, args, {
      cwd: this.composeDirectory,
      encoding: "utf8",
      maxBuffer: 10_000_000,
      env: { ...process.env, DOCKER_CONFIG: this.dockerConfigDirectory },
    });
  }

  installSeedModule(): void {
    if (!fs.existsSync(this.seedScript)) throw new Error(`Missing procurement seed module: ${this.seedScript}`);
    this.docker([
      "compose",
      "-p",
      "capability-factory-erpnext",
      "-f",
      "compose.yml",
      "cp",
      this.seedScript,
      "backend:/home/frappe/frappe-bench/apps/frappe/frappe/cf_seed_procurement_confirmation.py",
    ]);
  }

  reset(caseId: string): string {
    if (!this.cases.some((candidate) => candidate.id === caseId)) {
      throw new Error(`Unknown procurement case: ${caseId}`);
    }
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
      "frappe.cf_seed_procurement_confirmation.main",
    ]);
    return (lastJsonObject(output) as unknown as SeedResult).state_hash;
  }

  runtimeConfiguration(caseId: string): RuntimeConfiguration {
    const testCase = this.cases.find((candidate) => candidate.id === caseId);
    if (!testCase) throw new Error(`Unknown procurement case: ${caseId}`);
    const profile = testCase.credentialProfile as keyof typeof ALIASES;
    return this.runtimeConfigurationForProfile(profile);
  }

  runtimeConfigurationForProfile(profile: keyof typeof ALIASES): RuntimeConfiguration {
    const alias = ALIASES[profile];
    return {
      targets: {
        customer_system: {
          baseUrl: this.baseUrl,
          allowedPaths: ["/api/resource/Material%20Request/:name", "/api/resource/Purchase%20Order"],
          allowedMethods: {
            GET: ["/api/resource/Material%20Request/:name", "/api/resource/Purchase%20Order"],
            POST: ["/api/resource/Purchase%20Order"],
            PUT: ["/api/resource/Material%20Request/:name"],
          },
        },
      },
      secrets: { [alias]: TOKENS[profile] },
    };
  }

  secretAlias(caseId: string): string {
    const testCase = this.cases.find((candidate) => candidate.id === caseId);
    if (!testCase) throw new Error(`Unknown procurement case: ${caseId}`);
    return ALIASES[testCase.credentialProfile as keyof typeof ALIASES];
  }

  secretAliasForProfile(profile: keyof typeof ALIASES): string {
    return ALIASES[profile];
  }

  requestId(caseId: string): string {
    const value = REQUEST_IDS[caseId as keyof typeof REQUEST_IDS];
    if (!value) throw new Error(`Unknown procurement case: ${caseId}`);
    return value;
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
      "frappe.cf_seed_procurement_confirmation.verify_case",
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

  resetBroadGoal(): string {
    this.installSeedModule();
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
      "frappe.cf_seed_procurement_confirmation.reset_broad_goal",
    ]);
    return String(lastJsonObject(output).state_hash);
  }

  resetBroadGoalProbe(): string {
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
      "frappe.cf_seed_procurement_confirmation.reset_broad_probe",
    ]);
    return String(lastJsonObject(output).state_hash);
  }

  verifyBroadGoalRequest(requestId: string): DirectVerificationResult {
    if (![...REAL_ERPNEXT_BROAD_GOAL_REQUEST_IDS, REAL_ERPNEXT_BROAD_GOAL_PROBE_ID].includes(requestId as never)) {
      throw new Error(`Unknown broad-goal procurement request: ${requestId}`);
    }
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
      "frappe.cf_seed_procurement_confirmation.verify_broad_request",
      "--args",
      JSON.stringify([requestId]),
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

  verifyBroadGoal(): BroadGoalVerifyResult {
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
      "frappe.cf_seed_procurement_confirmation.verify_broad_goal",
    ]);
    const result = lastJsonObject(output) as unknown as VerifyResult & {
      completed_requests: number;
      required_requests: number;
    };
    return {
      caseId: result.case_id,
      passed: result.passed,
      intendedWrites: result.intended_writes,
      incorrectSideEffects: result.incorrect_side_effects,
      stateHash: result.state_hash,
      issues: result.issues,
      completedRequests: result.completed_requests,
      requiredRequests: result.required_requests,
    };
  }

  broadGoalStateHash(): string {
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
      "frappe.cf_seed_procurement_confirmation.evidence_for_broad_goal",
    ]);
    return String(lastJsonObject(output).state_hash);
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
      "frappe.cf_seed_procurement_confirmation.evidence_for_case",
      "--args",
      JSON.stringify([this.activeCaseId]),
    ]);
    return String(lastJsonObject(output).state_hash);
  }

  async close(): Promise<void> {
    // The disposable stack is intentionally retained until the campaign finishes.
  }
}

export async function startRealErpNextProcurementWorld(
  options: WorldOptions,
): Promise<RealErpNextProcurementWorld> {
  const baseUrl = options.baseUrl ?? process.env.CF_ERPNEXT_BASE_URL ?? "http://127.0.0.1:8080";
  const response = await fetch(`${baseUrl}/api/method/ping`);
  if (!response.ok) throw new Error(`Real ERPNext health check failed with HTTP ${response.status}.`);
  const handle = new RealErpNextProcurementWorld({ ...options, baseUrl });
  handle.installSeedModule();
  return handle;
}
