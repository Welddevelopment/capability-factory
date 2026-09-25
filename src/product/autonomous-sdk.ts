import type { CapabilityRequest, GoalRunResult } from "./contracts.js";
import type { DiagnosisInput, DiagnosisResult, GoalDiagnostician } from "./diagnosis.js";
import type { CapabilityWorkflow } from "./sdk.js";

export interface BlockedGoalCompleter {
  completeBlockedGoal(request: CapabilityRequest, workflow: CapabilityWorkflow): Promise<GoalRunResult>;
}

export type AutonomousGoalResult =
  | {
      status: "completed";
      completionSource: "already-satisfied";
      diagnosis: DiagnosisResult;
    }
  | {
      status: "completed";
      completionSource: "capability-loop";
      diagnosis: DiagnosisResult & { decision: "acquire-capability" };
      run: Extract<GoalRunResult, { status: "completed" }>;
    }
  | {
      status: "continue";
      mode: "continue-current" | "retry-current";
      diagnosis: DiagnosisResult;
    }
  | {
      status: "handoff";
      diagnosis: DiagnosisResult;
      run?: Extract<GoalRunResult, { status: "handoff" }>;
    };

/**
 * Product-reference orchestration from an ordinary goal. The diagnostician is
 * the only new front door; the existing acquisition SDK remains unchanged.
 */
export class AutonomousCapabilityFactorySdk {
  constructor(
    private readonly diagnostician: GoalDiagnostician,
    private readonly blockedGoalCompleter: BlockedGoalCompleter,
  ) {}

  async completeGoal(
    input: DiagnosisInput,
    workflowFor: (request: CapabilityRequest) => CapabilityWorkflow,
  ): Promise<AutonomousGoalResult> {
    const diagnosis = await this.diagnostician.diagnose(input);

    if (diagnosis.decision === "goal-complete") {
      return { status: "completed", completionSource: "already-satisfied", diagnosis };
    }
    if (diagnosis.decision === "continue-current" || diagnosis.decision === "retry-current") {
      return { status: "continue", mode: diagnosis.decision, diagnosis };
    }
    if (diagnosis.decision !== "acquire-capability") {
      return { status: "handoff", diagnosis };
    }

    const run = await this.blockedGoalCompleter.completeBlockedGoal(
      diagnosis.request,
      workflowFor(diagnosis.request),
    );
    if (run.status === "handoff") return { status: "handoff", diagnosis, run };
    return { status: "completed", completionSource: "capability-loop", diagnosis, run };
  }
}
