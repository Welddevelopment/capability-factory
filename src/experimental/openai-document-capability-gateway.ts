// Intended repo path: src/experimental/openai-document-capability-gateway.ts
// Pattern source: src/experimental/openai-browser-capability-gateway.ts and
// src/product/openai-draft-gateway.ts (both verified 2026-08-24).

import { zodTextFormat } from "openai/helpers/zod";
import { EXPERIMENT_LIMITS } from "../config.js";
import type { OpenAIModelGateway } from "../model-gateway.js";
import {
  modelDocumentCapabilityOutputSchema,
  type DocumentCapabilityModelDraftGateway,
  type DocumentCapabilityModelDraftInput,
} from "./model-document-capability-builder.js";

const INSTRUCTIONS = `You translate one customer-trusted PDF template description into the smallest constrained declarative document capability.

Rules:
- Use only the supplied capability identity, need key, root aliases, contract hash, approval key, verifier key, and the plain-language template documentation.
- Copy every identity value exactly as supplied. Do not rename, shorten, or normalize anything.
- Derive templateTitle, templateVersion, inputFormat, allowedItemCodes, and every numeric bound only from the template documentation. Quote the title exactly; list item codes in their documented order; never add, drop, or relax anything.
- Template version 1 documentation describes labeled fields (Document-ID, PO-Number, Ship-To) and pairs with machine-readable-pdf-order-v1. Template version 2 describes a slash-delimited table with a control total and pairs with machine-readable-pdf-order-table-v2.
- The input and output root aliases are distinct and must stay as supplied.
- Never include a credential, file path, executable code, shell command, or any field not in the schema.
- Do not claim success. Trusted code will validate the draft, probe it against a disposable PDF without a business write, execute it once under pin and approval, and verify the outcome independently.
- On a repair attempt, change only what the supplied validation error names.
- Return only the strict structured draft.`;

/** The manifest is small and flat; reasoning and JSON share this window. */
export const DOCUMENT_DRAFT_MAX_OUTPUT_TOKENS = 4_000;

export class OpenAIStructuredDocumentCapabilityGateway implements DocumentCapabilityModelDraftGateway {
  readonly modelLabel = EXPERIMENT_LIMITS.model;

  constructor(private readonly gateway: OpenAIModelGateway) {}

  async draft(input: DocumentCapabilityModelDraftInput): Promise<unknown> {
    const response = await this.gateway.create({
      model: EXPERIMENT_LIMITS.model,
      // Bounded documentation-to-schema translation, not open-ended planning;
      // low effort preserves the output window (same rationale as the HTTP
      // family's product draft gateway).
      reasoning: { effort: "low" },
      instructions: INSTRUCTIONS,
      input: JSON.stringify({
        needKey: input.needKey,
        contractHash: input.contractHash,
        trustedIdentity: input.trustedIdentity,
        templateDocumentation: input.templateDocumentation,
        previousValidationError: input.previousError ?? null,
        previousDraft: input.previousDraft ?? null,
      }),
      max_output_tokens: DOCUMENT_DRAFT_MAX_OUTPUT_TOKENS,
      store: true,
      // INTEGRATION-CHECK: zodTextFormat with this schema was not exercised
      // against the live API (no paid calls were made). The schema deliberately
      // avoids superRefine and uses only literals, enums, ints, strings, and a
      // string array — all shapes productCapabilityDraftSchema already ships
      // through zodTextFormat successfully.
      text: { format: zodTextFormat(modelDocumentCapabilityOutputSchema, "experimental_document_capability") },
    });
    if (response.status !== "completed") {
      throw new Error(`Model document draft was ${response.status}: ${response.incomplete_details?.reason ?? "unknown"}`);
    }
    return JSON.parse(response.output_text) as unknown;
  }

  spentUsd(): number {
    return this.gateway.spentUsd();
  }
}
