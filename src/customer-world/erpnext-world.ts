import path from "node:path";
import type { CapabilityManifest } from "../manifest.js";
import type { RuntimeConfiguration } from "../runtime.js";
import type {
  CustomerWorldHandle,
  CustomerWorldModule,
  DirectVerificationResult,
  DocumentationBundle,
} from "./contract.js";
import {
  businessSnapshot,
  ERP_NEXT_CASES,
  openErpNextFixture,
  resetErpNextFixture,
  stateHash,
  verifyErpNextFixture,
  type ErpNextDatabase,
} from "./erpnext-fixture.js";
import {
  SECRET_ALIASES,
  SECRET_VALUES,
  startErpNextFixtureServer,
  type ErpNextFixtureServerHandle,
} from "./erpnext-server.js";

function property(type: "string" | "boolean", description: string) {
  return { type, description } as const;
}

export function createErpNextReferenceCapability(
  documentation: DocumentationBundle,
  secretAlias: string,
): CapabilityManifest {
  return {
    schemaVersion: "1",
    id: "erpnext-dispatch-preparation",
    version: "1.0.0",
    service: "ERPNext REST resource API",
    description: "Read one sales order, create its delivery record, and record the resulting dispatch fields.",
    baseUrlAlias: "customer_system",
    auth: { kind: "apiKey", secretAlias, headerName: "Authorization" },
    actions: [
      {
        name: "read_sales_order",
        description: "Read one sales order by its exact document name.",
        inputSchema: {
          type: "object",
          properties: { salesOrderId: property("string", "Exact sales order document name") },
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
        response: { acceptedStatuses: [200], outputPointers: { document: "/data" } },
        safety: { idempotency: "none", timeoutMs: 2_000, maxResponseBytes: 100_000 },
      },
      {
        name: "create_delivery_note",
        description: "Create the one submitted delivery record required by the target sales order.",
        inputSchema: {
          type: "object",
          properties: {
            salesOrderId: property("string", "Exact target sales order document name"),
            trackingNumber: property("string", "Tracking reference for the prepared dispatch"),
            labelReference: property("string", "Label reference for the prepared dispatch"),
            injectLostResponse: property("boolean", "Development-only retry fault switch"),
          },
          required: ["salesOrderId", "trackingNumber", "labelReference", "injectLostResponse"],
          additionalProperties: false,
        },
        request: {
          method: "POST",
          pathTemplate: "/api/resource/Delivery%20Note",
          queryTemplate: {},
          headerTemplate: { "x-inject-lost-response": "{{input.injectLostResponse}}" },
          bodyTemplate: {
            sales_order: "{{input.salesOrderId}}",
            carrier: "ParcelFlow",
            service: "Standard Overnight",
            tracking_number: "{{input.trackingNumber}}",
            label_reference: "{{input.labelReference}}",
          },
        },
        response: {
          acceptedStatuses: [200, 201],
          outputPointers: { documentName: "/data/name", idempotentReplay: "/idempotent_replay" },
        },
        safety: { idempotency: "required", timeoutMs: 2_000, maxResponseBytes: 100_000 },
      },
      {
        name: "update_sales_order",
        description: "Record the prepared delivery details on the exact target sales order.",
        inputSchema: {
          type: "object",
          properties: {
            salesOrderId: property("string", "Exact target sales order document name"),
            trackingNumber: property("string", "Tracking reference already used on the delivery record"),
            labelReference: property("string", "Label reference already used on the delivery record"),
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
            cf_dispatch_status: "Prepared",
            cf_carrier: "ParcelFlow",
            cf_service: "Standard Overnight",
            cf_tracking_number: "{{input.trackingNumber}}",
            cf_label_reference: "{{input.labelReference}}",
          },
        },
        response: { acceptedStatuses: [200], outputPointers: { document: "/data" } },
        safety: { idempotency: "required", timeoutMs: 2_000, maxResponseBytes: 100_000 },
      },
    ],
    provenance: {
      documentationHash: documentation.sha256,
      model: "deterministic-reference-no-model",
      createdAt: "2026-07-26T09:00:00.000Z",
    },
  };
}

export class ErpNextDevelopmentWorldHandle implements CustomerWorldHandle {
  readonly id = "erpnext-dispatch-development-world";
  readonly adapterKind = "ERPNext REST-compatible local fixture; not a full Frappe/ERPNext installation";
  readonly startingCapabilities = [
    { id: "ordinary-goal-reader", description: "Read the ordinary user goal and report completion or a precise block." },
  ];
  readonly cases = ERP_NEXT_CASES;
  readonly baseUrl: string;
  readonly documentation: DocumentationBundle;
  private activeCaseId = "first-build";
  private resetSnapshot: Record<string, unknown[]>;

  constructor(
    readonly database: ErpNextDatabase,
    private readonly server: ErpNextFixtureServerHandle,
  ) {
    this.baseUrl = server.baseUrl;
    this.documentation = server.documentation;
    resetErpNextFixture(this.database, this.activeCaseId);
    this.resetSnapshot = businessSnapshot(this.database);
  }

  reset(caseId: string): string {
    if (!this.cases.some((candidate) => candidate.id === caseId)) {
      throw new Error(`Unknown customer-world case: ${caseId}`);
    }
    this.activeCaseId = caseId;
    this.server.clearFaults();
    const hash = resetErpNextFixture(this.database, caseId);
    this.resetSnapshot = businessSnapshot(this.database);
    return hash;
  }

  runtimeConfiguration(caseId: string): RuntimeConfiguration {
    const testCase = this.cases.find((candidate) => candidate.id === caseId);
    if (!testCase) throw new Error(`Unknown customer-world case: ${caseId}`);
    const profile = testCase.credentialProfile as keyof typeof SECRET_ALIASES;
    const alias = SECRET_ALIASES[profile];
    const secret = SECRET_VALUES[alias];
    if (!alias || !secret) throw new Error(`Missing credential profile configuration: ${testCase.credentialProfile}`);
    return {
      targets: {
        customer_system: {
          baseUrl: this.baseUrl,
          allowedPaths: [
            "/api/resource/Sales%20Order/:name",
            "/api/resource/Delivery%20Note",
            "/api/resource/Delivery%20Note/:name",
          ],
          allowedMethods: {
            GET: ["/api/resource/Sales%20Order/:name", "/api/resource/Delivery%20Note/:name"],
            POST: ["/api/resource/Delivery%20Note"],
            PUT: ["/api/resource/Sales%20Order/:name"],
          },
        },
      },
      secrets: { [alias]: secret },
    };
  }

  secretAlias(caseId: string): string {
    const testCase = this.cases.find((candidate) => candidate.id === caseId);
    if (!testCase) throw new Error(`Unknown customer-world case: ${caseId}`);
    return SECRET_ALIASES[testCase.credentialProfile as keyof typeof SECRET_ALIASES];
  }

  verify(caseId: string): DirectVerificationResult {
    if (caseId !== this.activeCaseId) {
      throw new Error(`Case ${caseId} is not active; reset it before direct verification.`);
    }
    return verifyErpNextFixture(this.database, caseId, this.resetSnapshot);
  }

  stateHash(): string {
    return stateHash(this.database);
  }

  async close(): Promise<void> {
    await this.server.close();
    this.database.close();
  }
}

export const erpNextDevelopmentWorld: CustomerWorldModule = {
  id: "erpnext-dispatch-development-world",
  description:
    "Replaceable synthetic customer world using ERPNext REST and DocType conventions for local transfer-plumbing development.",
  developmentOnly: true,
  async start(workDirectory: string): Promise<CustomerWorldHandle> {
    const database = openErpNextFixture(path.join(workDirectory, "erpnext-development.sqlite"));
    const server = await startErpNextFixtureServer(database);
    return new ErpNextDevelopmentWorldHandle(database, server);
  },
  createReferenceCapability: createErpNextReferenceCapability,
};

export async function startErpNextDevelopmentWorld(
  workDirectory: string,
): Promise<ErpNextDevelopmentWorldHandle> {
  const database = openErpNextFixture(path.join(workDirectory, "erpnext-development.sqlite"));
  const server = await startErpNextFixtureServer(database);
  return new ErpNextDevelopmentWorldHandle(database, server);
}
