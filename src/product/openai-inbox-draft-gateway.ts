// Intended location: src/product/openai-inbox-draft-gateway.ts
// Pattern source: src/product/openai-draft-gateway.ts (verified 2026-08-24).
// The model drafts ONLY the message-to-action mapping fields of an inbox
// capability. It never sees secrets, signatures, receipts, or business messages.

import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { EXPERIMENT_LIMITS } from "../config.js";
import type { OpenAIModelGateway } from "../model-gateway.js";

/**
 * Mapping-only draft transport. Deliberately excludes contractHash, root
 * aliases, approval key, and verifier key: those are trusted pins that the
 * builder injects and that a model draft can never influence.
 *
 * Keyword set (regex, min/max, strict objects) stays within what
 * productCapabilityDraftSchema already proves works with zodTextFormat.
 * z.email() is intentionally not used here; the authoritative
 * experimentalInboxMessageCapabilitySchema enforces it after assembly.
 */
export const inboxContractMappingDraftSchema = z
  .object({
    schemaVersion: z.literal("0.1"),
    id: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
    allowedFromAddress: z.string().regex(/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+$/).max(254),
    allowedToAddress: z.string().regex(/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+$/).max(254),
    subjectPrefix: z.string().min(1).max(120),
    allowedItemCodes: z.array(z.string().regex(/^[a-zA-Z0-9_.-]{1,160}$/)).min(1).max(200),
    maxLineItems: z.number().int().min(1).max(200),
    maxQuantityPerLine: z.number().int().min(1).max(1_000_000),
    maxInputBytes: z.number().int().min(1).max(5_000_000),
  })
  .strict();

export type InboxContractMappingDraft = z.infer<typeof inboxContractMappingDraftSchema>;

export interface InboxContractDraftInput {
  needKey: string;
  /** The trusted contract document. Trusted code hashes it independently. */
  contractDocument: Record<string, unknown>;
  contractSha256: string;
  previousError?: string;
  previousDraft?: InboxContractMappingDraft;
}

/** Local or hosted structured-generation adapter for the inbox mapping draft. */
export interface InboxContractDraftGateway {
  readonly modelLabel: string;
  draft(input: InboxContractDraftInput): Promise<unknown>;
  spentUsd(): number;
}

const INBOX_DRAFT_INSTRUCTIONS = `You draft the smallest message-to-action mapping contract for a bounded inbox capability.

Rules:
- Use only the supplied trusted contract document. Copy its sender, recipient, subject prefix, item codes, and bounds exactly. Do not invent addresses, item codes, or looser limits.
- The mapping must be at most as permissive as the document: never widen an allowlist, raise a quantity or byte bound, or generalize the subject prefix.
- Never include credentials, signatures, hashes, executable code, or fields outside the strict schema.
- Choose a short lowercase capability id that names the sender and workflow.
- Produce only the strict structured mapping draft.`;

/** The mapping is small; this window is generous. */
export const INBOX_DRAFT_MAX_OUTPUT_TOKENS = 4_000;

export class OpenAIInboxContractDraftGateway implements InboxContractDraftGateway {
  readonly modelLabel = EXPERIMENT_LIMITS.model;

  constructor(private readonly gateway: OpenAIModelGateway) {}

  async draft(input: InboxContractDraftInput): Promise<unknown> {
    const response = await this.gateway.create({
      model: EXPERIMENT_LIMITS.model,
      // Bounded document-to-schema translation, not open-ended planning.
      reasoning: { effort: "low" },
      instructions: INBOX_DRAFT_INSTRUCTIONS,
      input: JSON.stringify({
        needKey: input.needKey,
        trustedContractDocument: input.contractDocument,
        contractDocumentSha256: input.contractSha256,
        previousValidationError: input.previousError ?? null,
        previousDraft: input.previousDraft ?? null,
      }),
      max_output_tokens: INBOX_DRAFT_MAX_OUTPUT_TOKENS,
      store: true,
      // INTEGRATION-CHECK: zodTextFormat with this schema shape mirrors the
      // proven productCapabilityDraftSchema usage; confirm once against the
      // installed openai@^6.7.0 + zod@^4.1.12 pair before the paid take.
      text: { format: zodTextFormat(inboxContractMappingDraftSchema, "inbox_contract_mapping_draft") },
    });
    if (response.status !== "completed") {
      throw new Error(`Model draft was ${response.status}: ${response.incomplete_details?.reason ?? "unknown"}`);
    }
    return JSON.parse(response.output_text) as unknown;
  }

  spentUsd(): number {
    return this.gateway.spentUsd();
  }
}
