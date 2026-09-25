import { zodTextFormat } from "openai/helpers/zod";
import { EXPERIMENT_LIMITS } from "../config.js";
import type { OpenAIModelGateway } from "../model-gateway.js";
import {
  universalWorkflowProposalSchema,
  type UniversalWorkflowPlanner,
  type UniversalWorkflowPlanningInput,
  type UniversalWorkflowProposal,
} from "./universal-goal-preparation.js";

const INSTRUCTIONS = `You identify which predeclared customer workflow an ordinary goal requires.

You are not selecting a runtime, building a capability, granting authority or executing work.
Trusted code owns every action, target, permission, credential alias, verifier and route.

Rules:
- Select only a supplied workflow key.
- Cite only supplied evidence IDs and cite every evidence ID required by the selected workflow.
- If the goal is ambiguous or required evidence is absent, request information or return insufficient evidence.
- Never invent a workflow, capability, integration, runtime, tool, credential, approval, observation or completion claim.
- Return only the strict structured proposal.`;

export class OpenAIUniversalWorkflowPlanner implements UniversalWorkflowPlanner {
  constructor(private readonly gateway: OpenAIModelGateway) {}

  async propose(input: UniversalWorkflowPlanningInput): Promise<UniversalWorkflowProposal> {
    const response = await this.gateway.create({
      model: EXPERIMENT_LIMITS.model,
      reasoning: { effort: "medium" },
      instructions: INSTRUCTIONS,
      input: JSON.stringify(input),
      max_output_tokens: 2_000,
      store: true,
      text: { format: zodTextFormat(universalWorkflowProposalSchema, "universal_workflow_proposal") },
    });
    if (response.status !== "completed") {
      throw new Error(`Universal workflow planning was ${response.status}: ${response.incomplete_details?.reason ?? "unknown"}`);
    }
    return universalWorkflowProposalSchema.parse(JSON.parse(response.output_text) as unknown);
  }

  spentUsd(): number {
    return this.gateway.spentUsd();
  }
}

