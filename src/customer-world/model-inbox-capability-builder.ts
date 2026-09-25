// Intended location: src/customer-world/model-inbox-capability-builder.ts
// Trusted assembly around the model's mapping draft.
//
// CRITICAL BOUNDARY: this builder is the ONLY place the model touches the
// family. Signature verification, replay refusal, and ingress trust are the
// existing trusted implementations and are not imported, wrapped, or altered
// here. The model drafts the message-to-action mapping; trusted code pins
// contractHash, root aliases, approval key, and verifier key, then validates
// and probes before the manifest can ever be used.

import {
  experimentalInboxMessageCapabilitySchema,
  parseBoundedInboxOrder,
  type ExperimentalInboxMessageCapability,
} from "../experimental/inbox-message-driver.js";
import type { InboxMessageCapabilityBuilder } from "../experimental/inbox-message-capability-sdk.js";
import {
  inboxContractMappingDraftSchema,
  type InboxContractDraftGateway,
  type InboxContractMappingDraft,
} from "../product/openai-inbox-draft-gateway.js";

/** Values the model can never supply. All fixed by trusted code before drafting. */
export interface TrustedInboxCapabilityPins {
  needKey: string;
  /** Independently computed by trusted code from the trusted contract document. */
  contractSha256: string;
  contractDocument: Record<string, unknown>;
  inboxRootAlias: string;
  outputRootAlias: string;
  approvalKey: string;
  outcomeVerifierKey: string;
  /**
   * Fictional probe message used for the trusted in-builder pre-probe. The
   * model never sees it; only parse failures (trusted text) are fed back.
   */
  probeMessage: string;
}

export class ModelInboxCapabilityBuilder implements InboxMessageCapabilityBuilder {
  readonly builderId = "model-inbox-mapping-builder-v1";
  private readonly maxAttempts: number;

  constructor(
    private readonly gateway: InboxContractDraftGateway,
    private readonly pins: TrustedInboxCapabilityPins,
    maxAttempts = 3,
  ) {
    if (maxAttempts < 1 || maxAttempts > 5) throw new Error("Inbox mapping draft attempts must be between 1 and 5");
    this.maxAttempts = maxAttempts;
  }

  async build(needKey: string, contractHash: string): Promise<ExperimentalInboxMessageCapability | null> {
    // Trusted refusal: this builder only drafts for the exact pinned need and
    // the exact independently computed contract hash. A caller-supplied hash
    // that differs from the trusted pin is refused, not trusted.
    if (needKey !== this.pins.needKey || contractHash !== this.pins.contractSha256) return null;

    let previousError: string | undefined;
    let previousDraft: InboxContractMappingDraft | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const raw = await this.gateway.draft({
          needKey,
          contractDocument: structuredClone(this.pins.contractDocument),
          contractSha256: this.pins.contractSha256,
          ...(previousError ? { previousError } : {}),
          ...(previousDraft ? { previousDraft: structuredClone(previousDraft) } : {}),
        });
        const draft = inboxContractMappingDraftSchema.parse(raw);
        previousDraft = draft;

        // Trusted assembly: mapping fields come from the draft; everything
        // identity- or authority-bearing comes from the pins.
        const manifest = experimentalInboxMessageCapabilitySchema.parse({
          schemaVersion: "0.1",
          capabilityMode: "experimental-inbox-message-actions",
          id: draft.id,
          needKey: this.pins.needKey,
          inboxRootAlias: this.pins.inboxRootAlias,
          outputRootAlias: this.pins.outputRootAlias,
          contractHash: this.pins.contractSha256,
          inputFormat: "rfc822-plain-text-order",
          outputFormat: "canonical-draft-order-json",
          allowedFromAddress: draft.allowedFromAddress,
          allowedToAddress: draft.allowedToAddress,
          subjectPrefix: draft.subjectPrefix,
          allowedItemCodes: [...draft.allowedItemCodes],
          maxLineItems: draft.maxLineItems,
          maxQuantityPerLine: draft.maxQuantityPerLine,
          maxInputBytes: draft.maxInputBytes,
          approvalKey: this.pins.approvalKey,
          outcomeVerifierKey: this.pins.outcomeVerifierKey,
        });

        // Trusted pre-probe. The experimental inbox SDK has no
        // verification-repair loop (unlike the HTTP CapabilityCoordinator's
        // maxVerificationRepairs), so a mapping that cannot parse the probe
        // message is caught here and fed back to the model within the same
        // bounded attempt budget. parseBoundedInboxOrder is the driver's own
        // trusted parser — the same one verifyCapability probes with later.
        parseBoundedInboxOrder(this.pins.probeMessage, manifest);
        return manifest;
      } catch (error) {
        previousError = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
      }
    }
    throw new Error(`Inbox mapping drafting failed after ${this.maxAttempts} attempts: ${previousError}`);
  }
}
