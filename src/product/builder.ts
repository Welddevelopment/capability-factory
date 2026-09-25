import { z } from "zod";
import {
  capabilityManifestSchema,
  type CapabilityManifest,
  type JsonValue,
} from "../manifest.js";
import type { CapabilityRequest, VerificationReceipt } from "./contracts.js";
import type { RepairableCapabilityBuilder } from "./coordinator.js";

export interface ProductDocumentation {
  content: Record<string, JsonValue>;
  sha256: string;
}

export interface ProductDocumentationResolver {
  resolve(request: CapabilityRequest): Promise<ProductDocumentation>;
}

export type DraftTemplateNode =
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "input"; name: string }
  | { kind: "template"; value: string }
  | { kind: "array"; items: DraftTemplateNode[] }
  | { kind: "object"; entries: Array<{ name: string; value: DraftTemplateNode }> };

const primitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const draftTemplateNodeSchema: z.ZodType<DraftTemplateNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("literal"), value: primitiveSchema }).strict(),
    z.object({ kind: z.literal("input"), name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/) }).strict(),
    z.object({ kind: z.literal("template"), value: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("array"), items: z.array(draftTemplateNodeSchema) }).strict(),
    z
      .object({
        kind: z.literal("object"),
        entries: z.array(
          z.object({ name: z.string().min(1), value: draftTemplateNodeSchema }).strict(),
        ),
      })
      .strict(),
  ]),
);

const draftAuthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("apiKey"), secretAlias: z.string().min(1), headerName: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("bearer"), secretAlias: z.string().min(1) }).strict(),
]);

/**
 * Product-only model transport. Named entry arrays avoid dynamic map schemas,
 * while recursive nodes support real nested request bodies without generated code.
 */
export const productCapabilityDraftSchema = z
  .object({
    schemaVersion: z.literal("1"),
    id: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    service: z.string().min(1),
    description: z.string().min(1),
    baseUrlAlias: z.string().min(1),
    auth: draftAuthSchema,
    actions: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
            description: z.string().min(1),
            inputProperties: z.array(
              z
                .object({
                  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
                  type: z.enum(["string", "number", "integer", "boolean"]),
                  description: z.string().min(1),
                })
                .strict(),
            ),
            request: z
              .object({
                method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
                pathTemplate: z.string().startsWith("/"),
                queryTemplate: draftTemplateNodeSchema,
                headerTemplate: draftTemplateNodeSchema,
                bodyTemplate: z.union([draftTemplateNodeSchema, z.null()]),
              })
              .strict(),
            response: z
              .object({
                acceptedStatuses: z.array(z.number().int().min(200).max(299)).min(1),
                outputPointers: z.array(
                  z.object({ name: z.string().min(1), pointer: z.string().startsWith("/") }).strict(),
                ),
              })
              .strict(),
            safety: z
              .object({
                idempotency: z.enum(["none", "required"]),
                timeoutMs: z.number().int().min(100).max(10_000),
                maxResponseBytes: z.number().int().min(1).max(1_000_000),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();

export type ProductCapabilityDraft = z.infer<typeof productCapabilityDraftSchema>;

export interface ManifestDraftInput {
  need: CapabilityRequest["need"];
  authority: CapabilityRequest["authority"];
  documentation: ProductDocumentation;
  previousError?: string;
  previousDraft?: ProductCapabilityDraft;
}

/** Local or hosted structured-generation adapter. It receives the diagnosed need, not the ordinary goal. */
export interface ManifestDraftGateway {
  readonly modelLabel: string;
  draft(input: ManifestDraftInput): Promise<unknown>;
}

export interface StructuredManifestBuilderOptions {
  documentation: ProductDocumentationResolver;
  gateway: ManifestDraftGateway;
  maxAttempts?: number;
  now?: () => string;
}

function entriesToRecord(entries: Array<{ name: string; value: DraftTemplateNode }>): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {};
  for (const entry of entries) {
    if (entry.name in output) throw new Error(`Duplicate draft object entry: ${entry.name}`);
    output[entry.name] = nodeToJson(entry.value);
  }
  return output;
}

function nodeToJson(node: DraftTemplateNode): JsonValue {
  if (node.kind === "literal") return node.value;
  if (node.kind === "input") return `{{input.${node.name}}}`;
  if (node.kind === "template") return node.value;
  if (node.kind === "array") return node.items.map(nodeToJson);
  return entriesToRecord(node.entries);
}

function nodeToRecord(node: DraftTemplateNode, field: string): Record<string, JsonValue> {
  const value = nodeToJson(node);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a named object node`);
  }
  return value;
}

function jsonToNode(value: JsonValue): DraftTemplateNode {
  if (Array.isArray(value)) return { kind: "array", items: value.map(jsonToNode) };
  if (value && typeof value === "object") {
    return {
      kind: "object",
      entries: Object.entries(value).map(([name, item]) => ({ name, value: jsonToNode(item) })),
    };
  }
  if (typeof value === "string") {
    const exact = value.match(/^\{\{input\.([a-zA-Z][a-zA-Z0-9_]*)\}\}$/);
    if (exact?.[1]) return { kind: "input", name: exact[1] };
    if (value.includes("{{input.")) return { kind: "template", value };
  }
  return { kind: "literal", value };
}

function draftToManifest(
  draft: ProductCapabilityDraft,
  provenance: CapabilityManifest["provenance"],
): CapabilityManifest {
  return capabilityManifestSchema.parse({
    ...draft,
    actions: draft.actions.map((action) => ({
      name: action.name,
      description: action.description,
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(
          action.inputProperties.map(({ name, type, description }) => [name, { type, description }]),
        ),
        required: action.inputProperties.map(({ name }) => name),
        additionalProperties: false,
      },
      request: {
        method: action.request.method,
        pathTemplate: action.request.pathTemplate,
        queryTemplate: nodeToRecord(action.request.queryTemplate, "queryTemplate"),
        headerTemplate: nodeToRecord(action.request.headerTemplate, "headerTemplate"),
        bodyTemplate: action.request.bodyTemplate === null ? null : nodeToJson(action.request.bodyTemplate),
      },
      response: {
        acceptedStatuses: action.response.acceptedStatuses,
        outputPointers: Object.fromEntries(
          action.response.outputPointers.map(({ name, pointer }) => [name, pointer]),
        ),
      },
      safety: action.safety,
    })),
    provenance,
  });
}

/** Domain-independent builder for only the residual left after retained and trusted-source search. */
export class StructuredManifestBuilder implements RepairableCapabilityBuilder {
  private readonly maxAttempts: number;
  private readonly now: () => string;

  constructor(private readonly options: StructuredManifestBuilderOptions) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.now = options.now ?? (() => new Date().toISOString());
    if (this.maxAttempts < 1 || this.maxAttempts > 5) throw new Error("Manifest draft attempts must be between 1 and 5");
  }

  async build(request: CapabilityRequest): Promise<CapabilityManifest> {
    const documentation = await this.options.documentation.resolve(request);
    if (documentation.sha256 !== request.need.documentationHash) {
      throw new Error("Resolved documentation does not match the diagnosed need");
    }
    return this.draft(request, documentation);
  }

  async repair(
    request: CapabilityRequest,
    previousManifest: CapabilityManifest,
    verification: VerificationReceipt,
  ): Promise<CapabilityManifest> {
    const documentation = await this.options.documentation.resolve(request);
    if (documentation.sha256 !== request.need.documentationHash) {
      throw new Error("Resolved documentation does not match the diagnosed need");
    }
    const failure = verification.checks
      .filter((check) => !check.passed)
      .map((check) => `${check.id}: ${check.detail}`)
      .join(" | ");
    return this.draft(request, documentation, failure, manifestToDraftOutput(previousManifest));
  }

  private async draft(
    request: CapabilityRequest,
    documentation: ProductDocumentation,
    initialError?: string,
    initialDraft?: ProductCapabilityDraft,
  ): Promise<CapabilityManifest> {
    let previousError = initialError;
    let previousDraft = initialDraft;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const raw = await this.options.gateway.draft({
          need: structuredClone(request.need),
          authority: structuredClone(request.authority),
          documentation: structuredClone(documentation),
          ...(previousError ? { previousError } : {}),
          ...(previousDraft ? { previousDraft: structuredClone(previousDraft) } : {}),
        });
        const draft = productCapabilityDraftSchema.parse(raw);
        return draftToManifest(draft, {
          documentationHash: documentation.sha256,
          model: this.options.gateway.modelLabel,
          createdAt: this.now(),
        });
      } catch (error) {
        previousError = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
      }
    }
    throw new Error(`Structured capability drafting failed after ${this.maxAttempts} attempts: ${previousError}`);
  }
}

/** Test/provider adapter helper. It strips trusted provenance before crossing the draft boundary. */
export function manifestToDraftOutput(manifest: CapabilityManifest): ProductCapabilityDraft {
  return productCapabilityDraftSchema.parse({
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    version: manifest.version,
    service: manifest.service,
    description: manifest.description,
    baseUrlAlias: manifest.baseUrlAlias,
    auth: manifest.auth,
    actions: manifest.actions.map((action) => ({
      name: action.name,
      description: action.description,
      inputProperties: Object.entries(action.inputSchema.properties).map(([name, property]) => ({
        name,
        type: property.type,
        description: property.description,
      })),
      request: {
        method: action.request.method,
        pathTemplate: action.request.pathTemplate,
        queryTemplate: jsonToNode(action.request.queryTemplate),
        headerTemplate: jsonToNode(action.request.headerTemplate),
        bodyTemplate: action.request.bodyTemplate === null ? null : jsonToNode(action.request.bodyTemplate),
      },
      response: {
        acceptedStatuses: action.response.acceptedStatuses,
        outputPointers: Object.entries(action.response.outputPointers).map(([name, pointer]) => ({ name, pointer })),
      },
      safety: action.safety,
    })),
  });
}
