// Intended repo path: src/experimental/model-document-capability-builder.ts
// Pattern source: src/experimental/model-browser-capability-builder.ts (verified 2026-08-24).
//
// The one untrusted seam of the pinned-documents family: a model translates a
// hashed, customer-trusted PDF template contract into the family's declarative
// manifest. Trusted code rebuilds the deterministic manifest from the same
// contract and requires canonical equality, so the model cannot invent an item
// code, widen a bound, or change identity/aliases/approvals.

import { z } from "zod";
import {
  experimentalDocumentCapabilitySchema,
  type ExperimentalDocumentCapability,
} from "./document-driver.js";
import type { DocumentCapabilityBuilder } from "./document-capability-sdk.js";

const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.-]+$/);
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * One customer-trusted document template contract. The `documentationLines`
 * prose is what the model reads to derive the bounded values; every field in
 * `bounds` is trusted ground truth used only to check the model's answer.
 */
export const trustedDocumentTemplateContractSchema = z
  .object({
    capabilityId: identifier,
    needKey: identifier,
    inputRootAlias: identifier,
    outputRootAlias: identifier,
    contractHash: sha256Hex,
    approvalKey: identifier,
    outcomeVerifierKey: identifier,
    bounds: z
      .object({
        inputFormat: z.enum([
          "machine-readable-pdf-order-v1",
          "machine-readable-pdf-order-table-v2",
        ]),
        templateTitle: z.string().min(1).max(160),
        templateVersion: z.enum(["1", "2"]),
        allowedItemCodes: z.array(identifier).min(1).max(200),
        maxLineItems: z.number().int().positive().max(200),
        maxQuantityPerLine: z.number().int().positive().max(1_000_000),
        maxInputBytes: z.number().int().positive().max(10_000_000),
      })
      .strict(),
    documentationLines: z.array(z.string().min(1).max(500)).min(3).max(60),
  })
  .strict();

export type TrustedDocumentTemplateContract = z.infer<typeof trustedDocumentTemplateContractSchema>;

/**
 * OpenAI-structured-outputs-safe transport mirror of
 * experimentalDocumentCapabilitySchema (document-driver.ts lines 16-50) without
 * the superRefine cross-field rules; those are re-applied when the draft is
 * parsed through the real trusted schema below.
 */
export const modelDocumentCapabilityOutputSchema = z
  .object({
    schemaVersion: z.literal("0.1"),
    capabilityMode: z.literal("experimental-document-actions"),
    id: z.string(),
    needKey: z.string(),
    inputRootAlias: z.string(),
    outputRootAlias: z.string(),
    contractHash: z.string(),
    inputFormat: z.enum([
      "machine-readable-pdf-order-v1",
      "machine-readable-pdf-order-table-v2",
    ]),
    outputFormat: z.literal("canonical-draft-order-json"),
    templateTitle: z.string(),
    templateVersion: z.enum(["1", "2"]),
    allowedItemCodes: z.array(z.string()),
    maxLineItems: z.number().int(),
    maxQuantityPerLine: z.number().int(),
    maxInputBytes: z.number().int(),
    approvalKey: z.string(),
    outcomeVerifierKey: z.string(),
  })
  .strict();

export type ModelDocumentCapabilityOutput = z.infer<typeof modelDocumentCapabilityOutputSchema>;

export interface DocumentCapabilityModelDraftInput {
  needKey: string;
  contractHash: string;
  trustedIdentity: {
    capabilityId: string;
    inputRootAlias: string;
    outputRootAlias: string;
    approvalKey: string;
    outcomeVerifierKey: string;
  };
  templateDocumentation: string[];
  previousError?: string;
  previousDraft?: unknown;
}

export interface DocumentCapabilityModelDraftGateway {
  readonly modelLabel: string;
  draft(input: DocumentCapabilityModelDraftInput): Promise<unknown>;
  spentUsd?(): number;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The trusted answer: the manifest is fully determined by the contract. */
export function deterministicManifestFromContract(
  contract: TrustedDocumentTemplateContract,
): ExperimentalDocumentCapability {
  const safe = trustedDocumentTemplateContractSchema.parse(contract);
  return experimentalDocumentCapabilitySchema.parse({
    schemaVersion: "0.1",
    capabilityMode: "experimental-document-actions",
    id: safe.capabilityId,
    needKey: safe.needKey,
    inputRootAlias: safe.inputRootAlias,
    outputRootAlias: safe.outputRootAlias,
    contractHash: safe.contractHash,
    inputFormat: safe.bounds.inputFormat,
    outputFormat: "canonical-draft-order-json",
    templateTitle: safe.bounds.templateTitle,
    templateVersion: safe.bounds.templateVersion,
    allowedItemCodes: [...safe.bounds.allowedItemCodes],
    maxLineItems: safe.bounds.maxLineItems,
    maxQuantityPerLine: safe.bounds.maxQuantityPerLine,
    maxInputBytes: safe.bounds.maxInputBytes,
    approvalKey: safe.approvalKey,
    outcomeVerifierKey: safe.outcomeVerifierKey,
  });
}

/** Transport parse followed by the real trusted schema (including superRefine). */
export function documentCapabilityFromModelOutput(raw: unknown): ExperimentalDocumentCapability {
  const output = modelDocumentCapabilityOutputSchema.parse(raw);
  return experimentalDocumentCapabilitySchema.parse(output);
}

/**
 * Field-by-field canonical equality against the deterministic manifest. A named
 * field in the error message gives the bounded repair attempt something exact
 * to fix, mirroring the browser family's contract-binding assertion.
 */
export function assertCandidateBoundToContract(
  candidate: ExperimentalDocumentCapability,
  contract: TrustedDocumentTemplateContract,
): void {
  const expected = deterministicManifestFromContract(contract);
  for (const key of Object.keys(expected) as Array<keyof ExperimentalDocumentCapability>) {
    if (canonical(candidate[key]) !== canonical(expected[key])) {
      throw new Error(
        `The model document candidate diverged from the trusted template contract at "${key}": expected ${canonical(expected[key])}, received ${canonical(candidate[key])}.`,
      );
    }
  }
  if (canonical(candidate) !== canonical(expected)) {
    throw new Error("The model document candidate contains fields outside the trusted template contract.");
  }
}

/**
 * Optional model-backed translator from one trusted document template contract
 * to the same constrained manifest the deterministic builder produces. It cannot
 * discover templates, item codes, bounds, roots, approvals, or verifiers.
 */
export class StructuredModelDocumentCapabilityBuilder implements DocumentCapabilityBuilder {
  readonly builderId: string;

  constructor(
    private readonly gateway: DocumentCapabilityModelDraftGateway,
    private readonly contracts: TrustedDocumentTemplateContract[],
    private readonly maxAttempts = 2,
  ) {
    this.builderId = `model-document-builder-${gateway.modelLabel}`.replaceAll(/[^a-zA-Z0-9_.-]/g, "-");
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
      throw new Error("Model document construction attempts must be between one and three.");
    }
    for (const contract of contracts) trustedDocumentTemplateContractSchema.parse(contract);
  }

  async build(needKey: string, contractHash: string): Promise<ExperimentalDocumentCapability | null> {
    const contract = this.contracts.find(
      (candidate) => candidate.needKey === needKey && candidate.contractHash === contractHash,
    );
    if (!contract) return null;
    let previousError: string | undefined;
    let previousDraft: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const draft = await this.gateway.draft({
          needKey,
          contractHash,
          trustedIdentity: {
            capabilityId: contract.capabilityId,
            inputRootAlias: contract.inputRootAlias,
            outputRootAlias: contract.outputRootAlias,
            approvalKey: contract.approvalKey,
            outcomeVerifierKey: contract.outcomeVerifierKey,
          },
          templateDocumentation: [...contract.documentationLines],
          ...(previousError ? { previousError, previousDraft } : {}),
        });
        previousDraft = draft;
        const candidate = documentCapabilityFromModelOutput(draft);
        assertCandidateBoundToContract(candidate, contract);
        return candidate;
      } catch (error) {
        previousError = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
      }
    }
    throw new Error(
      `Model document construction failed after ${this.maxAttempts} bounded attempts: ${previousError ?? "unknown error"}`,
    );
  }
}
