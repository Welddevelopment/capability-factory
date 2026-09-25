import { createHash } from "node:crypto";
import { z } from "zod";

const jsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([jsonPrimitiveSchema, z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);

export const inputPropertySchema = z
  .object({
    type: z.enum(["string", "number", "integer", "boolean"]),
    description: z.string().min(1),
  })
  .strict();

export const inputObjectSchema = z
  .object({
    type: z.literal("object"),
    properties: z.record(z.string(), inputPropertySchema),
    required: z.array(z.string()),
    additionalProperties: z.literal(false),
  })
  .strict()
  .refine(
    (value) =>
      value.required.length === Object.keys(value.properties).length &&
      value.required.every((name) => name in value.properties),
    "Strict tool inputs must list every declared property as required",
  );

const authSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("apiKey"),
      secretAlias: z.string().min(1),
      headerName: z.string().min(1),
    })
    .strict(),
  z
    .object({ kind: z.literal("bearer"), secretAlias: z.string().min(1) })
    .strict(),
]);

export const capabilityActionSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
    description: z.string().min(1),
    inputSchema: inputObjectSchema,
    request: z
      .object({
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        pathTemplate: z.string().startsWith("/"),
        queryTemplate: z.record(z.string(), jsonValueSchema),
        headerTemplate: z.record(z.string(), jsonValueSchema),
        bodyTemplate: z.union([jsonValueSchema, z.null()]),
      })
      .strict(),
    response: z
      .object({
        acceptedStatuses: z.array(z.number().int().min(200).max(299)).min(1),
        outputPointers: z.record(z.string(), z.string().startsWith("/")),
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
  .strict();

export const capabilityManifestSchema = z
  .object({
    schemaVersion: z.literal("1"),
    id: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    service: z.string().min(1),
    description: z.string().min(1),
    baseUrlAlias: z.string().min(1),
    auth: authSchema,
    actions: z.array(capabilityActionSchema).min(1).max(8),
    provenance: z
      .object({
        documentationHash: z.string().regex(/^[a-f0-9]{64}$/),
        model: z.string().min(1),
        createdAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict();

export type CapabilityManifest = z.infer<typeof capabilityManifestSchema>;
export type CapabilityAction = z.infer<typeof capabilityActionSchema>;

const modelTemplateValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const modelNamedTemplateValueSchema = z
  .object({
    name: z.string().min(1),
    value: modelTemplateValueSchema,
  })
  .strict();

const modelInputPropertySchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
    type: z.enum(["string", "number", "integer", "boolean"]),
    description: z.string().min(1),
  })
  .strict();

const modelAuthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("apiKey"),
      secretAlias: z.string().min(1),
      headerName: z.string().min(1),
    })
    .strict(),
  z
    .object({ kind: z.literal("bearer"), secretAlias: z.string().min(1) })
    .strict(),
]);

const modelCapabilityActionSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
    description: z.string().min(1),
    inputProperties: z.array(modelInputPropertySchema),
    request: z
      .object({
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        pathTemplate: z.string().startsWith("/"),
        queryTemplate: z.array(modelNamedTemplateValueSchema),
        headerTemplate: z.array(modelNamedTemplateValueSchema),
        bodyTemplate: z.union([z.array(modelNamedTemplateValueSchema), z.null()]),
      })
      .strict(),
    response: z
      .object({
        acceptedStatuses: z.array(z.number().int().min(200).max(299)).min(1),
        outputPointers: z.array(
          z
            .object({
              name: z.string().min(1),
              pointer: z.string().startsWith("/"),
            })
            .strict(),
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
  .strict();

/**
 * Model-facing transport schema. Strict structured outputs reject the
 * `propertyNames` JSON Schema keyword emitted for dynamic-key Zod records, so
 * map-shaped fields cross the model boundary as arrays of named entries.
 */
export const capabilityManifestOutputSchema = z
  .object({
    schemaVersion: z.literal("1"),
    id: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    service: z.string().min(1),
    description: z.string().min(1),
    baseUrlAlias: z.string().min(1),
    auth: modelAuthSchema,
    actions: z.array(modelCapabilityActionSchema).min(1).max(8),
  })
  .strict();

export type CapabilityManifestOutput = z.infer<typeof capabilityManifestOutputSchema>;

function entriesToRecord<T>(
  entries: readonly { name: string; value: T }[],
  field: string,
): Record<string, T> {
  const record: Record<string, T> = {};
  for (const entry of entries) {
    if (entry.name in record) throw new Error(`Duplicate ${field} entry: ${entry.name}`);
    record[entry.name] = entry.value;
  }
  return record;
}

export function capabilityManifestFromOutput(
  output: CapabilityManifestOutput,
  provenance: CapabilityManifest["provenance"],
): CapabilityManifest {
  return capabilityManifestSchema.parse({
    ...output,
    actions: output.actions.map((action) => ({
      name: action.name,
      description: action.description,
      inputSchema: {
        type: "object",
        properties: entriesToRecord(
          action.inputProperties.map(({ name, type, description }) => ({
            name,
            value: { type, description },
          })),
          "input property",
        ),
        required: action.inputProperties.map(({ name }) => name),
        additionalProperties: false,
      },
      request: {
        ...action.request,
        queryTemplate: entriesToRecord(action.request.queryTemplate, "query template"),
        headerTemplate: entriesToRecord(action.request.headerTemplate, "header template"),
        bodyTemplate:
          action.request.bodyTemplate === null
            ? null
            : entriesToRecord(action.request.bodyTemplate, "body template"),
      },
      response: {
        acceptedStatuses: action.response.acceptedStatuses,
        outputPointers: entriesToRecord(
          action.response.outputPointers.map(({ name, pointer }) => ({ name, value: pointer })),
          "output pointer",
        ),
      },
      safety: action.safety,
    })),
    provenance,
  });
}

export function hashDocumentation(documentation: unknown): string {
  const canonical = typeof documentation === "string" ? documentation : JSON.stringify(documentation);
  return createHash("sha256").update(canonical).digest("hex");
}

export function validateNoLiteralSecrets(
  manifest: CapabilityManifest,
  secretValues: readonly string[],
): void {
  const serialized = JSON.stringify(manifest);
  for (const secret of secretValues) {
    if (secret && serialized.includes(secret)) {
      throw new Error("Capability manifest contains a literal secret");
    }
  }
}
