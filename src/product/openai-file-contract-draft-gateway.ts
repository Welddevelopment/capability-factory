// Intended location: src/product/openai-file-contract-draft-gateway.ts
// Mirrors src/product/openai-draft-gateway.ts for the files/EDI family: the model
// drafts only the declarative partner-contract facts; everything executable stays
// in trusted code.

import { zodTextFormat } from "openai/helpers/zod";
// INTEGRATION-CHECK: verified export `zodTextFormat` — openai ^6.7.0 in package.json.
import { z } from "zod";
import { EXPERIMENT_LIMITS } from "../config.js";
// INTEGRATION-CHECK: verified `EXPERIMENT_LIMITS` (src/config.ts line 3), model "gpt-5.6-sol".
import type { OpenAIModelGateway } from "../model-gateway.js";
// INTEGRATION-CHECK: verified class `OpenAIModelGateway` (src/model-gateway.ts line 37)
// with `create(params)` and `spentUsd()`.

const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.-]+$/);

/**
 * The model may only claim a fact was extracted or inferred. It can never mark a
 * fact confirmed — confirmation statuses are granted by trusted review code only.
 */
const draftFactStatus = z.enum(["extracted", "inferred-proposal"]);
const draftFact = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ value, status: draftFactStatus, sourceId: identifier }).strict();

/**
 * Model-facing transport schema. Field-for-field subset of
 * `fileTransferContractMaterialSchema` in src/product/file-transfer-adapter-factory.ts:
 * the trusted caller adds `schemaVersion`, `materialId` and `sourceDigest` (computed
 * from the onboarding document, never model-chosen).
 */
export const fileContractDraftSchema = z
  .object({
    needKey: draftFact(identifier),
    inputRootAlias: draftFact(identifier),
    outputRootAlias: draftFact(identifier),
    inputFormat: draftFact(z.enum(["x12-850", "edifact-orders-d96a"])),
    transportKind: draftFact(z.enum(["local-directory", "authenticated-network"])),
    senderId: draftFact(identifier),
    receiverId: draftFact(identifier),
    allowedItemCodes: draftFact(z.array(identifier).min(1).max(200)),
    maxLineItems: draftFact(z.number().int().positive().max(200)),
    maxQuantityPerLine: draftFact(z.number().int().positive().max(1_000_000)),
    maxInputBytes: draftFact(z.number().int().positive().max(5_000_000)),
    approvalKey: draftFact(identifier),
    outcomeVerifierKey: draftFact(identifier),
  })
  .strict();
// INTEGRATION-CHECK: keys and value shapes match the 13 `consequentialFacts` in
// src/product/file-transfer-adapter-factory.ts (line 61). If that list changes,
// this schema must change with it.

export type FileContractDraft = z.infer<typeof fileContractDraftSchema>;

const FILE_CONTRACT_DRAFT_INSTRUCTIONS = `You extract the declarative partner file-transfer contract for a diagnosed missing ability.

Rules:
- Use only the supplied partner onboarding document and the supplied trusted planning values.
- Return needKey, inputRootAlias, outputRootAlias, approvalKey and outcomeVerifierKey exactly as supplied in trustedPlanningValues, each with status "extracted" and sourceId "trusted-planning".
- Extract senderId, receiverId, allowedItemCodes, maxLineItems, maxQuantityPerLine, maxInputBytes, inputFormat and transportKind from the onboarding document. Cite the document section name as sourceId.
- Use status "extracted" only when the document states the value explicitly; otherwise "inferred-proposal".
- Item codes must be listed exactly as documented, without additions, renames or reordering beyond document order.
- Never include credentials, tokens, URLs, hostnames, file paths, executable code, or values from anywhere except the two supplied inputs.
- Numbers must be plain integers within the documented limits.
- Produce only the strict structured contract draft.`;

/** Contract drafts are small; a modest window keeps truncation and cost down. */
export const FILE_CONTRACT_DRAFT_MAX_OUTPUT_TOKENS = 4_000;

export interface FileContractDraftInput {
  needSummary: string;
  onboardingDocument: { content: string; sha256: string };
  trustedPlanningValues: {
    needKey: string;
    inputRootAlias: string;
    outputRootAlias: string;
    approvalKey: string;
    outcomeVerifierKey: string;
  };
  previousError?: string;
  previousDraft?: FileContractDraft;
}

export interface FileContractDraftGateway {
  readonly modelLabel: string;
  draft(input: FileContractDraftInput): Promise<unknown>;
  spentUsd(): number;
}

export class OpenAIFileContractDraftGateway implements FileContractDraftGateway {
  readonly modelLabel = EXPERIMENT_LIMITS.model;

  constructor(private readonly gateway: OpenAIModelGateway) {}

  async draft(input: FileContractDraftInput): Promise<unknown> {
    const response = await this.gateway.create({
      model: EXPERIMENT_LIMITS.model,
      // Bounded extraction, not open-ended planning — same rationale as the low
      // effort setting in src/product/openai-draft-gateway.ts.
      reasoning: { effort: "low" },
      instructions: FILE_CONTRACT_DRAFT_INSTRUCTIONS,
      input: JSON.stringify({
        missingAbility: input.needSummary,
        onboardingDocument: input.onboardingDocument.content,
        onboardingDocumentSha256: input.onboardingDocument.sha256,
        trustedPlanningValues: input.trustedPlanningValues,
        previousValidationError: input.previousError ?? null,
        previousDraft: input.previousDraft ?? null,
      }),
      max_output_tokens: FILE_CONTRACT_DRAFT_MAX_OUTPUT_TOKENS,
      store: true,
      text: { format: zodTextFormat(fileContractDraftSchema, "file_contract_draft") },
    });
    // INTEGRATION-CHECK: response handling copied from
    // src/product/openai-draft-gateway.ts lines 55-58 (status + incomplete_details).
    if (response.status !== "completed") {
      throw new Error(
        `Model draft was ${response.status}: ${response.incomplete_details?.reason ?? "unknown"}`,
      );
    }
    return JSON.parse(response.output_text) as unknown;
  }

  spentUsd(): number {
    return this.gateway.spentUsd();
  }
}
