import { zodTextFormat } from "openai/helpers/zod";
import { EXPERIMENT_LIMITS } from "../config.js";
import type { OpenAIModelGateway } from "../model-gateway.js";
import {
  diagnosisProposalSchema,
  type DiagnosisGateway,
  type DiagnosisInput,
} from "./diagnosis.js";

const DIAGNOSIS_INSTRUCTIONS = `You diagnose why an agent cannot yet finish an ordinary user goal.

You are not told that a capability is missing. Decide among:
- the goal is already complete;
- the current agent can continue or should retry an existing ability;
- information, credentials, permission, or approval are missing;
- policy prohibits the action;
- a specific capability is genuinely missing; or
- evidence is insufficient.

Rules:
- Use only the supplied observations, trusted state, configured abilities, candidate systems, and authority envelope.
- Do not treat an execution error as proof that a new capability is missing.
- Search the listed existing abilities before proposing acquisition.
- If proposing acquisition, identify the smallest documented action set required for the ordinary goal.
- For an acquire, credential, permission, or approval decision, populate contemplatedAction with the exact documented actions, targets, and credential aliases that would be used. This is not a claim that a capability is missing.
- Populate missingCapability only when the decision is acquire-capability.
- When a write has a documented reconciliation/search action, include that read in the contemplated action set so a lost response can be resolved without a duplicate.
- Every requiredCompanionActions entry must be covered either by the contemplated action or by a healthy listed existing ability.
- Use only exact action names, target aliases, and secret aliases listed in the candidate systems.
- Never infer or grant credentials, permissions, approvals, or policy authority.
- Cite only supplied observation IDs.
- Do not produce an integration, code, credentials, or instructions for bypassing a gate.
- Return only the strict structured diagnosis.`;

export class OpenAIStructuredDiagnosisGateway implements DiagnosisGateway {
  constructor(private readonly gateway: OpenAIModelGateway) {}

  async diagnose(input: DiagnosisInput): Promise<unknown> {
    const response = await this.gateway.create({
      model: EXPERIMENT_LIMITS.model,
      reasoning: { effort: "medium" },
      instructions: DIAGNOSIS_INSTRUCTIONS,
      input: JSON.stringify({
        ordinaryGoal: input.context.ordinaryGoal,
        currentStep: input.context.currentStep,
        observations: input.observations,
        trustedState: input.state,
        customerAuthority: input.authority,
      }),
      max_output_tokens: 4_000,
      store: true,
      text: { format: zodTextFormat(diagnosisProposalSchema, "goal_diagnosis") },
    });
    if (response.status !== "completed") {
      throw new Error(`Model diagnosis was ${response.status}: ${response.incomplete_details?.reason ?? "unknown"}`);
    }
    return JSON.parse(response.output_text) as unknown;
  }

  spentUsd(): number {
    return this.gateway.spentUsd();
  }
}
