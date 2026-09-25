import { zodTextFormat } from "openai/helpers/zod";
import { EXPERIMENT_LIMITS } from "../config.js";
import type { OpenAIModelGateway } from "../model-gateway.js";
import {
  productCapabilityDraftSchema,
  type ManifestDraftGateway,
  type ManifestDraftInput,
} from "./builder.js";

const PRODUCT_DRAFT_INSTRUCTIONS = `You draft the smallest constrained declarative HTTP capability for a diagnosed missing ability.

Rules:
- Use only the supplied API documentation, required action names, trusted base URL aliases, credential aliases, and allowed HTTP methods.
- Return every required action name exactly as supplied. Do not add unrelated actions.
- Search/reconciliation reads may be included only when the documentation requires them for safe retry behavior.
- Never include a literal credential, executable code, shell command, JavaScript, or an unapproved host.
- Use secret aliases through the auth object. Authentication headers must not appear in headerTemplate.
- Every write must declare idempotency "required".
- queryTemplate and headerTemplate must be object nodes, including when empty.
- Convert every OpenAPI path placeholder such as {name} to the runtime form {{input.name}} and declare that input property. Never leave single-brace placeholders in pathTemplate.
- Use recursive object and array nodes for nested JSON bodies. Use input nodes for runtime values and literal nodes only for documented constants.
- Input properties must include every input node referenced by the request and no unused fields.
- Keep timeouts and response limits conservative.
- Produce only the strict structured capability draft.`;

/** Product manifests can contain deeply nested request bodies; reasoning and JSON share this window. */
export const PRODUCT_DRAFT_MAX_OUTPUT_TOKENS = 16_000;

export class OpenAIStructuredManifestDraftGateway implements ManifestDraftGateway {
  readonly modelLabel = EXPERIMENT_LIMITS.model;

  constructor(private readonly gateway: OpenAIModelGateway) {}

  async draft(input: ManifestDraftInput): Promise<unknown> {
    const response = await this.gateway.create({
      model: EXPERIMENT_LIMITS.model,
      // This is a bounded documentation-to-schema translation, not open-ended
      // planning. Low reasoning preserves more of the fixed output window for
      // the complete nested manifest and avoids wasting calls on truncated
      // hidden reasoning. The frozen historical evaluations remain unchanged.
      reasoning: { effort: "low" },
      instructions: PRODUCT_DRAFT_INSTRUCTIONS,
      input: JSON.stringify({
        missingAbility: input.need,
        customerAuthority: input.authority,
        apiDocumentation: input.documentation.content,
        documentationHash: input.documentation.sha256,
        previousValidationError: input.previousError ?? null,
        previousDraft: input.previousDraft ?? null,
      }),
      max_output_tokens: PRODUCT_DRAFT_MAX_OUTPUT_TOKENS,
      store: true,
      text: { format: zodTextFormat(productCapabilityDraftSchema, "product_capability_draft") },
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
