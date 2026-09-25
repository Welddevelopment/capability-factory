import { zodTextFormat } from "openai/helpers/zod";
import { EXPERIMENT_LIMITS } from "../config.js";
import type { OpenAIModelGateway } from "../model-gateway.js";
import {
  modelBrowserCapabilityOutputSchema,
  type BrowserCapabilityModelDraftGateway,
  type BrowserCapabilityModelDraftInput,
} from "./model-browser-capability-builder.js";

const INSTRUCTIONS = `You translate one customer-trusted UI contract into the smallest constrained declarative browser capability.

Rules:
- Use only the exact capability identity, target alias, verifier key, hash, paths, fields, locators, input keys, secret aliases and approval key in the supplied trusted contract.
- Do not invent selectors, hosts, paths, controls, credentials, secrets, approvals, verifiers, scripts, code, browser evaluation, downloads, uploads or extra actions.
- Preserve session authentication when the contract requires it.
- Use exactly one consequential business-write click. Only bounded confirmation observations may follow it.
- Session authentication is not a business write and must list its supplied secret aliases.
- Use exact semantic locators. A role locator uses value=null and role; test-id/label/placeholder locators use role=null and value.
- Use null for every transport field that a step kind does not use, and [] when sessionSecretAliases are unused.
- A role named main has name=null and exact=false. Other roles have the exact supplied name and exact=true.
- Do not claim success. Trusted code will validate the candidate, probe it without the business write, enforce network policy, execute it once under authority, and verify external state independently.
- On a repair attempt, change only what the supplied validation error requires.
- Return only the strict structured draft.`;

export class OpenAIStructuredBrowserCapabilityGateway implements BrowserCapabilityModelDraftGateway {
  readonly modelLabel = EXPERIMENT_LIMITS.model;

  constructor(private readonly gateway: OpenAIModelGateway) {}

  async draft(input: BrowserCapabilityModelDraftInput): Promise<unknown> {
    const response = await this.gateway.create({
      model: EXPERIMENT_LIMITS.model,
      reasoning: { effort: "low" },
      instructions: INSTRUCTIONS,
      input: JSON.stringify({
        needKey: input.needKey,
        uiContractHash: input.uiContractHash,
        trustedUiContract: input.trustedUiContract,
        previousValidationError: input.previousError ?? null,
        previousDraft: input.previousDraft ?? null,
      }),
      max_output_tokens: 8_000,
      store: true,
      text: { format: zodTextFormat(modelBrowserCapabilityOutputSchema, "experimental_browser_capability") },
    });
    if (response.status !== "completed") {
      throw new Error(`Model browser draft was ${response.status}: ${response.incomplete_details?.reason ?? "unknown"}`);
    }
    return JSON.parse(response.output_text) as unknown;
  }

  spentUsd(): number {
    return this.gateway.spentUsd();
  }
}
