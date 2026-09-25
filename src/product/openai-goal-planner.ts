import { zodTextFormat } from "openai/helpers/zod";
import { EXPERIMENT_LIMITS } from "../config.js";
import type { OpenAIModelGateway } from "../model-gateway.js";
import {
  goalPlanProposalSchema,
  type GoalPlanProposal,
  type GoalPlanner,
  type GoalPlanValidationCheck,
  type TrustedGoalScope,
} from "./goal-coordination.js";

const GOAL_PLANNER_INSTRUCTIONS = `You propose a conservative work plan for one ordinary operational goal.

You are not executing work and you cannot grant authority. Trusted code will reject the plan unless it exactly preserves scope.

Rules:
- Cover every supplied coverage requirement exactly once. Do not invent or omit coverage keys.
- Use only supplied entity aliases, workflow keys, target aliases, action names, completion-criterion keys, and the exact deadline key.
- Preserve every required action and documented safety companion action.
- Preserve every trusted coverage dependency. Add no dependency unless it is necessary to prevent unsafe or logically premature execution.
- Prefer separate work items when equivalence or safe batching is uncertain.
- Groups are for calm display and shared context; they do not authorize concurrent or batched writes.
- Never include credential aliases, credentials, permissions, approval claims, code, integrations, prompts, or instructions for bypassing a gate.
- Do not claim the goal is complete.
- On a repair attempt, change only what the supplied failed checks require.
- Return only the strict structured plan proposal.`;

function plannerInput(
  scope: TrustedGoalScope,
  repair?: { previousProposal: GoalPlanProposal; failedChecks: GoalPlanValidationCheck[] },
) {
  return {
    ordinaryGoal: scope.ordinaryGoal,
    deadline: scope.deadline,
    trustedEntities: scope.entities,
    trustedSystems: scope.systems.map((system) => ({
      targetAlias: system.targetAlias,
      operations: system.operations,
    })),
    trustedCompletionCriteria: scope.completionCriteria,
    requiredCoverage: scope.requiredCoverage,
    previousProposal: repair?.previousProposal ?? null,
    failedTrustedChecks: repair?.failedChecks ?? [],
  };
}

export class OpenAIStructuredGoalPlanner implements GoalPlanner {
  constructor(private readonly gateway: OpenAIModelGateway) {}

  async propose(
    scope: TrustedGoalScope,
    repair?: { previousProposal: GoalPlanProposal; failedChecks: GoalPlanValidationCheck[] },
  ): Promise<GoalPlanProposal> {
    const response = await this.gateway.create({
      model: EXPERIMENT_LIMITS.model,
      reasoning: { effort: "medium" },
      instructions: GOAL_PLANNER_INSTRUCTIONS,
      input: JSON.stringify(plannerInput(scope, repair)),
      max_output_tokens: 8_000,
      store: true,
      text: { format: zodTextFormat(goalPlanProposalSchema, "goal_plan_proposal") },
    });
    if (response.status !== "completed") {
      throw new Error(`Model goal planning was ${response.status}: ${response.incomplete_details?.reason ?? "unknown"}`);
    }
    return goalPlanProposalSchema.parse(JSON.parse(response.output_text) as unknown);
  }

  spentUsd(): number {
    return this.gateway.spentUsd();
  }
}
