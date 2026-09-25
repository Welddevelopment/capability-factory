/**
 * Model draft gateway for the REVIEWED DATABASE family
 * (database-model-confirmation-v1).
 *
 * Mirrors src/product/openai-draft-gateway.ts: the model produces only a
 * strict structured draft of the *transaction shape*; every trusted field
 * (tenant, connection, allowlist, approvalKey, limits, expected outcome) is
 * injected later by trusted assembly and re-validated by
 * createScopedDatabaseProposal in src/product/scoped-database-factory.ts.
 */
import { zodTextFormat } from "openai/helpers/zod"; // same import as src/product/openai-draft-gateway.ts:1
import { z } from "zod";
import { EXPERIMENT_LIMITS } from "../config.js"; // exports verified: src/config.ts:3
import type { OpenAIModelGateway } from "../model-gateway.js"; // verified: src/model-gateway.ts:37
import type { ScopedDatabaseContract } from "./scoped-database-factory.js"; // verified export: scoped-database-factory.ts:31

// Draft-side identifier rules mirror the (unexported) internals of
// scoped-database-factory.ts:8-16; the assembled contract is re-parsed with
// the exported scopedDatabaseContractSchema, so any divergence fails closed.
const draftId = z.string().min(1).max(120).regex(/^[A-Za-z][A-Za-z0-9_]*$/);
const draftKey = z.string().min(1).max(180).regex(/^[A-Za-z0-9_.-]+$/);
const bindingSchema = z.object({ column: draftId, parameter: draftId }).strict();
const predicateSchema = z.object({ column: draftId, op: z.literal("eq"), parameter: draftId }).strict();

// INTEGRATION-CHECK: OpenAI strict structured outputs require every property
// to be required; z.literal and z.discriminatedUnion are known-good (the HTTP
// productCapabilityDraftSchema in src/product/builder.ts uses both), but this
// exact nesting has not been sent to the API yet. Verify on the first dry
// draft against the live schema validator before any paid campaign.
const draftStatementSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("insert"), table: draftId, values: z.array(bindingSchema).min(1), conflictColumns: z.array(draftId).min(1), expectedRows: z.literal(1) }).strict(),
  z.object({ kind: z.literal("update"), table: draftId, set: z.array(bindingSchema).min(1), where: z.array(predicateSchema).min(1), conflictColumns: z.array(draftId).min(1), expectedRows: z.literal(1) }).strict(),
  z.object({ kind: z.literal("delete"), table: draftId, where: z.array(predicateSchema).min(1), conflictColumns: z.array(draftId).min(1), expectedRows: z.literal(1) }).strict(),
]);

// INTEGRATION-CHECK: min/max are nullable (not optional) because strict-mode
// structured outputs reject non-required properties; trusted assembly strips
// nulls before parsing with the factory schema (whose min/max are optional).
const draftParameterSchema = z
  .object({
    name: draftId,
    type: z.enum(["string", "integer", "boolean"]),
    min: z.union([z.number().int(), z.null()]),
    max: z.union([z.number().int(), z.null()]),
  })
  .strict();

export const scopedDatabaseDraftSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    contractId: draftKey,
    contractVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().min(1),
    isolation: z.enum(["serializable", "repeatable-read"]),
    statement: draftStatementSchema,
    parameters: z.array(draftParameterSchema).min(1).max(16),
  })
  .strict();

export type ScopedDatabaseDraft = z.infer<typeof scopedDatabaseDraftSchema>;

export interface DatabaseDraftInput {
  need: {
    key: string;
    summary: string;
    operationKind: "insert" | "update" | "delete";
    requiredParameterNames: string[];
  };
  /** The exact frozen allowlist. Shown to the model; never writable by it. */
  allowlist: ScopedDatabaseContract["allowlist"];
  documentation: { content: Record<string, unknown>; sha256: string };
  previousError?: string;
  previousDraft?: ScopedDatabaseDraft;
}

export interface DatabaseDraftGateway {
  readonly modelLabel: string;
  draft(input: DatabaseDraftInput): Promise<unknown>;
}

const DATABASE_DRAFT_INSTRUCTIONS = `You draft the smallest declarative single-statement database transaction for a diagnosed missing ability.

Rules:
- Use only the supplied table documentation, the exact allowlist, and the required parameter names.
- Exactly one statement. expectedRows is always 1.
- Never write SQL text, table joins, subqueries, or expressions. Only named tables, column-to-parameter bindings, and eq predicates.
- Never bind the operation_key column; the trusted runtime supplies it.
- For update and delete, the where predicates must cover every rowScopeColumns entry of the target table, and conflictColumns must equal those row-scope columns.
- Declare every referenced parameter exactly once with a correct type; declare integer bounds when the documentation states them; use null for absent bounds.
- Never include a credential, identity, approval key, schema digest, or connection detail. Those are not yours to set.
- Produce only the strict structured scoped database draft.`;

/** Single-statement drafts are small; this bounds worst-case output spend. */
export const DATABASE_DRAFT_MAX_OUTPUT_TOKENS = 4_000;

export class OpenAIScopedDatabaseDraftGateway implements DatabaseDraftGateway {
  readonly modelLabel = EXPERIMENT_LIMITS.model;

  constructor(private readonly gateway: OpenAIModelGateway) {}

  async draft(input: DatabaseDraftInput): Promise<unknown> {
    const response = await this.gateway.create({
      model: EXPERIMENT_LIMITS.model,
      // Bounded documentation-to-schema translation, like the HTTP draft
      // gateway (src/product/openai-draft-gateway.ts:41): low reasoning keeps
      // the fixed output window for the complete draft.
      reasoning: { effort: "low" },
      instructions: DATABASE_DRAFT_INSTRUCTIONS,
      input: JSON.stringify({
        missingAbility: input.need,
        exactAllowlist: input.allowlist,
        tableDocumentation: input.documentation.content,
        documentationHash: input.documentation.sha256,
        previousValidationError: input.previousError ?? null,
        previousDraft: input.previousDraft ?? null,
      }),
      max_output_tokens: DATABASE_DRAFT_MAX_OUTPUT_TOKENS,
      store: true,
      text: { format: zodTextFormat(scopedDatabaseDraftSchema, "scoped_database_draft") },
    });
    if (response.status !== "completed") {
      throw new Error(`Model draft was ${response.status}: ${response.incomplete_details?.reason ?? "unknown"}`);
    }
    return JSON.parse(response.output_text) as unknown;
  }

  spentUsd(): number {
    return this.gateway.spentUsd();
  }

  callCount(): number {
    return this.gateway.callCount(); // verified: src/model-gateway.ts:150
  }
}
