import type { CapabilityManifest } from "../manifest.js";
import type { CapabilityRuntime } from "../runtime.js";
import type {
  ActionReceipt,
  CapabilityEvent,
  CapabilityRequest,
  ExternalOutcomeClassification,
  GoalRunResult,
  HandoffEnvelope,
  HandoffReason,
  IncidentNextStep,
  IncidentReport,
  OutcomeReceipt,
  ResumeReceipt,
  VerificationCheck,
} from "./contracts.js";
import type { CapabilityCoordinator, CapabilityEventSink, RuntimeResolver } from "./coordinator.js";
import { redactText, redactValue } from "./redaction.js";

export function classifyExternalOutcome(outcome: OutcomeReceipt): ExternalOutcomeClassification {
  if (outcome.passed && outcome.incorrectSideEffects === 0) return "completed";
  if (outcome.incorrectSideEffects > 0) return "incorrect";
  if (outcome.intendedWrites === 0) return "not-started";
  return "partial";
}

function nextStepFor(classification: ExternalOutcomeClassification): IncidentNextStep {
  if (classification === "unknown") return "restore-verification";
  if (classification === "not-started") return "review-before-retry";
  if (classification === "partial") return "inspect-or-authorize-mitigation";
  if (classification === "incorrect") return "contain-and-authorize-mitigation";
  return "resume-from-verified-state";
}

export interface CapabilityWorkflow {
  execute(
    request: CapabilityRequest,
    manifest: CapabilityManifest,
    runtime: CapabilityRuntime,
  ): Promise<ActionReceipt[]>;
  verifyOutcome(request: CapabilityRequest): Promise<OutcomeReceipt>;
  resume(request: CapabilityRequest, actions: ActionReceipt[]): Promise<ResumeReceipt>;
  /**
   * Optional trusted workflow hook for the narrow case where execution threw
   * but independent read-only inspection proved the complete external outcome.
   * It must resume from external state and must not repeat the failed action.
   */
  resumeAfterVerifiedExecutionError?(
    request: CapabilityRequest,
    outcome: OutcomeReceipt,
  ): Promise<ResumeReceipt>;
}

export interface SdkDependencies {
  coordinator: CapabilityCoordinator;
  runtimeResolver: RuntimeResolver;
  events?: CapabilityEventSink;
  now?: () => string;
}

/** In-process reference SDK: diagnose is upstream; acquire, execute, verify, and resume are one call. */
export class CapabilityFactorySdk {
  private readonly now: () => string;

  constructor(private readonly dependencies: SdkDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async completeBlockedGoal(request: CapabilityRequest, workflow: CapabilityWorkflow): Promise<GoalRunResult> {
    const acquisition = await this.dependencies.coordinator.acquire(request);
    if (acquisition.status === "handoff") return acquisition;

    const { acquired } = acquisition;
    let actions: ActionReceipt[] = [];
    let executionError: unknown;
    try {
      actions = await workflow.execute(
        request,
        acquired.manifest,
        this.dependencies.runtimeResolver.resolve(request),
      );
      await this.event(request, "capability.executed", {
        capabilityId: acquired.manifest.id,
        actionCount: actions.length,
      });
    } catch (error) {
      executionError = error;
    }

    let outcome: OutcomeReceipt;
    try {
      outcome = await workflow.verifyOutcome(request);
    } catch (error) {
      const containment = await this.dependencies.coordinator.quarantine(
        request,
        acquired.manifest.id,
        "outcome-unverified",
      );
      return this.handoff(
        request,
        executionError ? "execution-failed" : "outcome-failed",
        executionError
          ? "Execution returned an error and independent inspection could not establish the external result. The capability was removed from automatic reuse; no blind retry was attempted."
          : "The independent outcome verifier could not establish the external result. The capability was removed from automatic reuse pending investigation.",
        [
          ...(executionError
            ? [{
                id: "execution-error",
                passed: false,
                detail: redactText(executionError instanceof Error ? executionError.message : String(executionError)),
              }]
            : []),
          {
            id: "outcome-verifier",
            passed: false,
            detail: redactText(error instanceof Error ? error.message : String(error)),
          },
          containment,
        ],
        acquired.manifest.id,
        this.incident(
          "unknown",
          Boolean(executionError),
          containment.passed,
        ),
      );
    }
    await this.event(request, "outcome.verified", {
      capabilityId: acquired.manifest.id,
      passed: outcome.passed,
      incorrectSideEffects: outcome.incorrectSideEffects,
      stateDigest: outcome.stateDigest,
    });
    if (!outcome.passed || outcome.incorrectSideEffects !== 0) {
      const classification = classifyExternalOutcome(outcome);
      const containment = await this.dependencies.coordinator.quarantine(
        request,
        acquired.manifest.id,
        outcome.incorrectSideEffects !== 0 ? "incorrect-side-effect" : "outcome-mismatch",
      );
      return this.handoff(
        request,
        executionError ? "execution-failed" : "outcome-failed",
        executionError
          ? "Execution returned an error and independent inspection did not find a clean completed result. The capability was removed from automatic reuse; no blind retry was attempted."
          : "The externally observed result did not satisfy the task contract. The capability was removed from automatic reuse pending investigation.",
        [
          ...(executionError
            ? [{
                id: "execution-error",
                passed: false,
                detail: redactText(executionError instanceof Error ? executionError.message : String(executionError)),
              }]
            : []),
          ...outcome.checks,
          ...(!outcome.passed && outcome.checks.every((check) => check.passed)
            ? [{ id: "outcome-contract", passed: false, detail: "The outcome receipt did not pass its contract." }]
            : []),
          ...(outcome.incorrectSideEffects !== 0
            ? [
                {
                  id: "incorrect-side-effects",
                  passed: false,
                  detail: `Independent verification observed ${outcome.incorrectSideEffects} incorrect side effect(s).`,
                },
              ]
            : []),
          containment,
        ],
        acquired.manifest.id,
        this.incident(
          classification,
          Boolean(executionError),
          containment.passed,
          outcome.stateDigest,
        ),
      );
    }

    if (executionError) {
      if (!workflow.resumeAfterVerifiedExecutionError) {
        const containment = await this.dependencies.coordinator.quarantine(
          request,
          acquired.manifest.id,
          "outcome-unverified",
        );
        return this.handoff(
          request,
          "execution-failed",
          "Independent inspection proved the external outcome, but this workflow has no verified-state resumption path. The capability was quarantined and the failed action was not repeated.",
          [
            {
              id: "execution-error",
              passed: false,
              detail: redactText(executionError instanceof Error ? executionError.message : String(executionError)),
            },
            {
              id: "verified-state-resumption",
              passed: false,
              detail: "The workflow must explicitly support resuming from independently verified external state.",
            },
            containment,
          ],
          acquired.manifest.id,
          this.incident("completed", true, containment.passed, outcome.stateDigest),
        );
      }

      let reconciledResume: ResumeReceipt;
      try {
        reconciledResume = await workflow.resumeAfterVerifiedExecutionError(request, outcome);
      } catch (error) {
        const containment = await this.dependencies.coordinator.quarantine(
          request,
          acquired.manifest.id,
          "outcome-unverified",
        );
        return this.handoff(
          request,
          "resume-failed",
          "The external outcome was verified after an execution error, but verified-state resumption failed. The capability was quarantined and the action was not repeated.",
          [
            {
              id: "verified-state-resumption",
              passed: false,
              detail: redactText(error instanceof Error ? error.message : String(error)),
            },
            containment,
          ],
          acquired.manifest.id,
          this.incident("completed", true, containment.passed, outcome.stateDigest),
        );
      }
      if (!reconciledResume.completed) {
        const containment = await this.dependencies.coordinator.quarantine(
          request,
          acquired.manifest.id,
          "outcome-unverified",
        );
        return this.handoff(
          request,
          "resume-failed",
          "The external outcome was verified after an execution error, but the original goal did not complete. The capability was quarantined and the action was not repeated.",
          [
            { id: "goal-completion", passed: false, detail: reconciledResume.summary },
            containment,
          ],
          acquired.manifest.id,
          this.incident("completed", true, containment.passed, outcome.stateDigest),
        );
      }
      await this.event(request, "execution.reconciled", {
        capabilityId: acquired.manifest.id,
        outcomeStateDigest: outcome.stateDigest,
        resumedFromVerifiedState: true,
      });
      await this.event(request, "goal.resumed", { capabilityId: acquired.manifest.id, completed: true });
      return {
        status: "completed",
        requestId: request.context.requestId,
        capabilitySource: acquired.source,
        capabilityId: acquired.manifest.id,
        actions,
        outcome,
        resume: reconciledResume,
        reconciliation: {
          reason: "execution-error",
          outcomeEstablished: true,
          actionReceiptsComplete: false,
          resumedFromVerifiedState: true,
          reconciledAt: this.now(),
        },
      };
    }

    let resume: ResumeReceipt;
    try {
      resume = await workflow.resume(request, actions);
    } catch (error) {
      return this.handoff(
        request,
        "resume-failed",
        "The original agent did not resume successfully after the capability action.",
        error,
        acquired.manifest.id,
      );
    }
    if (!resume.completed) {
      return this.handoff(
        request,
        "resume-failed",
        "The capability succeeded, but the original goal was not completed.",
        [{ id: "goal-completion", passed: false, detail: resume.summary }],
        acquired.manifest.id,
      );
    }
    await this.event(request, "goal.resumed", { capabilityId: acquired.manifest.id, completed: true });
    return {
      status: "completed",
      requestId: request.context.requestId,
      capabilitySource: acquired.source,
      capabilityId: acquired.manifest.id,
      actions,
      outcome,
      resume,
    };
  }

  private async handoff(
    request: CapabilityRequest,
    reason: HandoffReason,
    summary: string,
    errorOrChecks: unknown,
    capabilityId: string,
    incident?: IncidentReport,
  ): Promise<GoalRunResult> {
    const failedChecks: VerificationCheck[] = Array.isArray(errorOrChecks)
      ? (errorOrChecks as VerificationCheck[]).filter((check) => !check.passed)
      : [
          {
            id: reason,
            passed: false,
            detail: redactText(errorOrChecks instanceof Error ? errorOrChecks.message : String(errorOrChecks)),
          },
        ];
    const handoff: HandoffEnvelope = {
      requestId: request.context.requestId,
      tenantId: request.context.tenantId,
      reason,
      summary,
      attemptedCapabilityId: capabilityId,
      failedChecks,
      ...(incident ? { incident } : {}),
      createdAt: this.now(),
    };
    if (incident) {
      await this.event(request, "incident.created", {
        capabilityId,
        ...incident,
      });
    }
    await this.event(request, "handoff.created", { reason, summary });
    return { status: "handoff", handoff };
  }

  private incident(
    externalOutcome: ExternalOutcomeClassification,
    executionErrorObserved: boolean,
    capabilityQuarantined: boolean,
    stateDigest?: string,
  ): IncidentReport {
    return {
      externalOutcome,
      executionErrorObserved,
      ...(stateDigest ? { stateDigest } : {}),
      automaticRetryBlocked: true,
      capabilityQuarantined,
      mitigationAttempted: false,
      nextStep: nextStepFor(externalOutcome),
      observedAt: this.now(),
    };
  }

  private async event(request: CapabilityRequest, type: CapabilityEvent["type"], detail: Record<string, unknown>) {
    await this.dependencies.events?.record({
      tenantId: request.context.tenantId,
      requestId: request.context.requestId,
      ...(request.context.correlation ? { correlation: structuredClone(request.context.correlation) } : {}),
      type,
      detail: redactValue(detail) as Record<string, unknown>,
      occurredAt: this.now(),
    });
  }
}
