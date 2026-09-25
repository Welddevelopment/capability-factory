// Intended location: src/product/model-backed-file-adapter-builder.ts
// A FileTransferCapabilityBuilder whose only untrusted step is the model's
// declarative contract draft. Trusted code computes digests, proposes, confirms
// facts against the reviewer's ground truth, and binds. A wrong extraction leaves
// blockers, bind refuses, and the draft is retried with the failure fed back —
// the same repair shape as StructuredManifestBuilder in src/product/builder.ts.

import { createHash } from "node:crypto";
import type { FileTransferCapabilityBuilder } from "../experimental/file-transfer-capability-sdk.js";
// INTEGRATION-CHECK: verified interface `FileTransferCapabilityBuilder`
// (src/experimental/file-transfer-capability-sdk.ts line 18): { builderId; build(needKey, contractHash) }.
import type { ExperimentalFileTransferCapability } from "../experimental/file-transfer-driver.js";
// INTEGRATION-CHECK: verified type export (src/experimental/file-transfer-driver.ts line 40).
import {
  bindReviewedFileTransferAdapter,
  fileTransferContractMaterialSchema,
  proposeFileTransferAdapter,
  type FileTransferAdapterProposal,
  type FileTransferContractMaterial,
} from "./file-transfer-adapter-factory.js";
// INTEGRATION-CHECK: all five verified in src/product/file-transfer-adapter-factory.ts
// (schema line 13, propose line 67, bind line 100, types lines 31/33).
import {
  fileContractDraftSchema,
  type FileContractDraft,
  type FileContractDraftGateway,
} from "./openai-file-contract-draft-gateway.js";

/** The 13 consequential fact keys, kept in one place for confirmation and review. */
const FACT_KEYS = [
  "needKey",
  "inputRootAlias",
  "outputRootAlias",
  "inputFormat",
  "transportKind",
  "senderId",
  "receiverId",
  "allowedItemCodes",
  "maxLineItems",
  "maxQuantityPerLine",
  "maxInputBytes",
  "approvalKey",
  "outcomeVerifierKey",
] as const;
type FactKey = (typeof FACT_KEYS)[number];

/** Ground-truth contract values held by the trusted reviewer (the demo's stand-in customer). */
export type ConfirmedContractFacts = { [K in FactKey]: FileContractDraft[K]["value"] };

export interface ModelBackedFileAdapterBuildAttempt {
  attempt: number;
  accepted: boolean;
  unconfirmedFactKeys: string[];
  proposalDigest?: string;
  error?: string;
}

export interface ModelBackedFileAdapterBuilderOptions {
  gateway: FileContractDraftGateway;
  onboardingDocument: { content: string; sha256: string };
  needSummary: string;
  /** Trusted planning values the model must echo verbatim. */
  planningValues: {
    needKey: string;
    inputRootAlias: string;
    outputRootAlias: string;
    approvalKey: string;
    outcomeVerifierKey: string;
  };
  /** The reviewer's ground truth; only exact matches get confirmed. */
  groundTruth: ConfirmedContractFacts;
  reviewerAlias: string;
  maxAttempts?: number;
  /** Evidence sink; the runner writes these into the trial artifact directory. */
  onAttempt?(record: ModelBackedFileAdapterBuildAttempt): void;
  now?(): string;
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

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class ModelBackedFileAdapterBuilder implements FileTransferCapabilityBuilder {
  readonly builderId = "model-backed-file-adapter-builder-v1";
  private readonly maxAttempts: number;
  private readonly now: () => string;

  constructor(private readonly options: ModelBackedFileAdapterBuilderOptions) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.now = options.now ?? (() => new Date().toISOString());
    if (this.maxAttempts < 1 || this.maxAttempts > 5) {
      throw new Error("Contract draft attempts must be between 1 and 5");
    }
  }

  /**
   * Trusted planning computes the expected contract hash by proposing directly from
   * the reviewer's ground truth — the model is not involved. The goal request pins
   * this hash, so a divergent model draft can never bind.
   */
  expectedContractHash(): string {
    return this.confirmedProposal(this.groundTruthMaterial()).proposedManifest.contractHash;
  }

  async build(
    needKey: string,
    contractHash: string,
  ): Promise<ExperimentalFileTransferCapability | null> {
    if (needKey !== this.options.planningValues.needKey) return null;
    let previousError: string | undefined;
    let previousDraft: FileContractDraft | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const raw = await this.options.gateway.draft({
          needSummary: this.options.needSummary,
          onboardingDocument: this.options.onboardingDocument,
          trustedPlanningValues: this.options.planningValues,
          ...(previousError ? { previousError } : {}),
          ...(previousDraft ? { previousDraft } : {}),
        });
        const draft = fileContractDraftSchema.parse(raw);

        // First proposal: statuses come from the model, so every fact is a blocker
        // and the proposal is non-executable evidence, never a runnable manifest.
        const draftedMaterial = this.material(draft, "drafted");
        const draftedProposal = proposeFileTransferAdapter(draftedMaterial);
        if (draftedProposal.blockers.length === 0) {
          throw new Error(
            "A model-statused draft produced zero blockers; the review gate is not working.",
          );
        }

        // Trusted confirmation: a fact is confirmed only when its drafted value is
        // canonically identical to the reviewer's ground truth.
        const unconfirmed = FACT_KEYS.filter(
          (key) => canonical(draft[key].value) !== canonical(this.options.groundTruth[key]),
        );
        if (unconfirmed.length > 0) {
          previousError = `Reviewer refused to confirm: ${unconfirmed.join(", ")}. Re-extract these facts exactly from the onboarding document.`;
          previousDraft = draft;
          this.options.onAttempt?.({
            attempt,
            accepted: false,
            unconfirmedFactKeys: unconfirmed,
            proposalDigest: draftedProposal.proposalDigest,
          });
          continue;
        }

        const confirmedProposal = this.confirmedProposal(this.material(draft, "confirmed"));
        const { manifest } = bindReviewedFileTransferAdapter(confirmedProposal, {
          proposalDigest: confirmedProposal.proposalDigest,
          confirmedFactKeys: [...FACT_KEYS],
          confirmedByAlias: this.options.reviewerAlias,
          confirmedAt: this.now(),
          // Demo binding digests: hashes of the two trusted implementations this
          // adapter is being bound to. In a pilot these would be release digests.
          verifierImplementationDigest: sha256Hex("demo-network-direct-db-verifier-v1"),
          transportBindingDigest: sha256Hex("authenticated-network-file-transport-v1"),
        });
        this.options.onAttempt?.({
          attempt,
          accepted: manifest.contractHash === contractHash,
          unconfirmedFactKeys: [],
          proposalDigest: confirmedProposal.proposalDigest,
        });
        // The SDK asked for one exact contract. Anything else does not exist here.
        return manifest.contractHash === contractHash ? manifest : null;
      } catch (error) {
        previousError = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
        this.options.onAttempt?.({
          attempt,
          accepted: false,
          unconfirmedFactKeys: [],
          error: previousError,
        });
      }
    }
    return null;
  }

  private material(
    draft: FileContractDraft,
    phase: "drafted" | "confirmed",
  ): FileTransferContractMaterial {
    const fact = <T>(key: FactKey, value: T) =>
      phase === "confirmed"
        ? { value, status: "customer-confirmed" as const, sourceId: this.options.reviewerAlias }
        : { value, status: draft[key].status, sourceId: draft[key].sourceId };
    return fileTransferContractMaterialSchema.parse({
      schemaVersion: "1.0",
      materialId: `files-edi-demo-${phase}`,
      sourceDigest: this.options.onboardingDocument.sha256,
      ...Object.fromEntries(FACT_KEYS.map((key) => [key, fact(key, draft[key].value)])),
    });
  }

  private groundTruthMaterial(): FileTransferContractMaterial {
    return fileTransferContractMaterialSchema.parse({
      schemaVersion: "1.0",
      materialId: "files-edi-demo-confirmed",
      sourceDigest: this.options.onboardingDocument.sha256,
      ...Object.fromEntries(
        FACT_KEYS.map((key) => [
          key,
          {
            value: this.options.groundTruth[key],
            status: "customer-confirmed",
            sourceId: this.options.reviewerAlias,
          },
        ]),
      ),
    });
  }

  private confirmedProposal(material: FileTransferContractMaterial): FileTransferAdapterProposal {
    const proposal = proposeFileTransferAdapter(material);
    if (proposal.blockers.length > 0) {
      throw new Error(`Confirmed material still has blockers: ${proposal.blockers.join(", ")}`);
    }
    return proposal;
  }
  // INTEGRATION-CHECK: contractHash determinism — proposeFileTransferAdapter hashes
  // { sourceDigest, facts: [key, value][] } (file-transfer-adapter-factory.ts line 70),
  // so materialId and statuses do NOT affect the hash; a confirmed draft with correct
  // values always reproduces expectedContractHash(). Verified by reading the hash input.
}
