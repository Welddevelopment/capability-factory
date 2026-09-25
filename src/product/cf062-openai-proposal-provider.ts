import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { EXPERIMENT_LIMITS } from "../config.js";
import type { OpenAIModelGateway } from "../model-gateway.js";
import type { Cf062ProposalProvider, Cf062ProviderInput } from "./cf062-frozen-benchmark-runner.js";

const bounded = z.string().min(1).max(500);
const proposalSchema = z.object({
  schemaVersion: z.literal("1.0"),
  caseId: z.string().min(1).max(180),
  actionOperationKeys: z.array(bounded).max(64),
  observerOperationKeys: z.array(bounded).max(64),
  credentialAliases: z.array(bounded).max(64),
  verifier: z.object({
    status: z.enum(["proposed", "blocked"]),
    observationSource: z.enum(["independent-read", "action-response", "none"]),
    predicates: z.array(bounded).max(64),
    duplicateCheck: z.string().max(500).nullable(),
    freshness: z.string().max(500).nullable(),
    unknowns: z.array(bounded).max(64),
  }).strict(),
  clarifyingQuestions: z.array(bounded).max(64),
  blockers: z.array(bounded).max(64),
  writeAuthorized: z.literal(false),
  executable: z.literal(false),
  evidenceState: z.literal("proposal-only"),
}).strict();

const instructions = `You produce one bounded, non-executable adapter and independent-outcome-verifier proposal from approved local API material.

Rules:
- Use only operations, targets, authentication aliases, schemas and observable fields present in the supplied approved material.
- Select the smallest action operation set needed for the ordinary workflow.
- Select an independent read-side observation only when the supplied material exposes one that can prove the business outcome.
- Never treat an action response, documentation prose, or a provider claim as independent outcome proof.
- Never infer customer authority, credentials, approval, passed acceptance, activation, production readiness or executable status.
- If semantically similar actions are ambiguous, select none and ask one precise question.
- If independent verification cannot be constructed, keep the verifier blocked and name the missing observation.
- Credential aliases may be referenced by name only. Never output a credential value.
- Preserve every consequential blocker. Return only the strict structured proposal.`;

export class Cf062OpenAIProposalProvider implements Cf062ProposalProvider {
  readonly providerId = `openai-${EXPERIMENT_LIMITS.model}-cf062-v1`;
  constructor(private readonly gateway: OpenAIModelGateway) {}
  async propose(input: Cf062ProviderInput): Promise<unknown> {
    const response = await this.gateway.create({
      model: EXPERIMENT_LIMITS.model,
      reasoning: { effort: "medium" },
      instructions,
      input: JSON.stringify(input),
      max_output_tokens: 4_000,
      store: true,
      text: { format: zodTextFormat(proposalSchema, "cf062_adapter_verifier_proposal") },
    });
    if (response.status !== "completed") throw new Error(`CF-062 model proposal was ${response.status}: ${response.incomplete_details?.reason ?? "unknown"}`);
    return JSON.parse(response.output_text) as unknown;
  }
}
