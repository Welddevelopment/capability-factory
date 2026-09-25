import type { CapabilityManifest } from "../manifest.js";
import type { SupportedCapabilityMode } from "./pilot-readiness.js";

export type VisibilityMode = "exceptions-only" | "summary" | "full";
export type WriteAuthority = "denied" | "preauthorized" | "per-action-approval";

/** Stable parent/child correlation for optional broad-goal coordination. */
export interface GoalCorrelation {
  parentGoalId: string;
  workItemId: string;
  groupId: string;
}

/**
 * The ordinary task and the precise point where the customer's agent stopped.
 * This contains no credentials and is safe to move between trusted product planes
 * after application-specific redaction.
 */
export interface BlockedGoalContext {
  tenantId: string;
  requestId: string;
  workflowKey: string;
  ordinaryGoal: string;
  blockedAt: string;
  blockedReason: string;
  visibility: VisibilityMode;
  correlation?: GoalCorrelation;
}

/** A stable, product-neutral description of the smallest missing ability. */
export interface HttpCapabilityNeed {
  key: string;
  summary: string;
  requiredActions: string[];
  targetAliases: string[];
  secretAliases: string[];
  documentationHash: string;
}

/** Compatibility name for the only acquisition mode implemented today. */
export type CapabilityNeed = HttpCapabilityNeed;

/** Authority comes from customer configuration, never from model output. */
export interface HttpAuthorityEnvelope {
  allowedTargetAliases: string[];
  allowedSecretAliases: string[];
  allowedMethods: Array<"GET" | "POST" | "PUT" | "PATCH" | "DELETE">;
  writeAuthority: WriteAuthority;
  /** Required only when writeAuthority is per-action-approval; contains action names, not credentials. */
  approvedWriteActions: string[];
}

/** Compatibility name for the current constrained HTTP authority policy. */
export type AuthorityEnvelope = HttpAuthorityEnvelope;

export interface HttpCapabilityRequest {
  context: BlockedGoalContext;
  need: CapabilityNeed;
  authority: AuthorityEnvelope;
  runtimeProfile: string;
}

/**
 * The proven acquisition core currently accepts only constrained HTTP API
 * requests. A future top-level mode router may add browser, code, device or
 * delegation drivers without widening this trusted request type.
 */
export type CapabilityRequest = HttpCapabilityRequest;

export interface CapabilityModeBoundary {
  mode: SupportedCapabilityMode;
  request: HttpCapabilityRequest;
}

export interface VerificationCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface VerificationReceipt {
  verifierVersion: string;
  manifestDigest: string;
  documentationHash: string;
  passed: boolean;
  checks: VerificationCheck[];
  verifiedAt: string;
}

export interface OutcomeReceipt {
  verifierVersion: string;
  passed: boolean;
  intendedWrites: number;
  incorrectSideEffects: number;
  stateDigest: string;
  checks: VerificationCheck[];
  verifiedAt: string;
}

/** A conservative external-state classification derived from independent evidence. */
export type ExternalOutcomeClassification =
  | "completed"
  | "not-started"
  | "partial"
  | "incorrect"
  | "unknown";

export type IncidentNextStep =
  | "restore-verification"
  | "review-before-retry"
  | "inspect-or-authorize-mitigation"
  | "contain-and-authorize-mitigation"
  | "resume-from-verified-state";

/**
 * Structured, redacted incident context for operators. This never claims that
 * reversal is safe: mitigation remains a separate defined and authorized act.
 */
export interface IncidentReport {
  externalOutcome: ExternalOutcomeClassification;
  executionErrorObserved: boolean;
  stateDigest?: string;
  automaticRetryBlocked: true;
  capabilityQuarantined: boolean;
  mitigationAttempted: false;
  nextStep: IncidentNextStep;
  observedAt: string;
}

export type HandoffReason =
  | "authority-missing"
  | "policy-denied"
  | "build-failed"
  | "verification-failed"
  | "execution-failed"
  | "outcome-failed"
  | "resume-failed";

export interface HandoffEnvelope {
  requestId: string;
  tenantId: string;
  reason: HandoffReason;
  summary: string;
  attemptedCapabilityId?: string;
  failedChecks: VerificationCheck[];
  incident?: IncidentReport;
  createdAt: string;
}

export interface AcquiredCapability {
  source: "built" | "reused" | "trusted-tool";
  manifest: CapabilityManifest;
  verification: VerificationReceipt;
}

export type AcquisitionResult =
  | { status: "acquired"; acquired: AcquiredCapability }
  | { status: "handoff"; handoff: HandoffEnvelope };

export interface ActionReceipt {
  action: string;
  status: number;
  output: Record<string, unknown>;
}

export interface ResumeReceipt {
  completed: boolean;
  summary: string;
}

/**
 * Records the conservative recovery path used when execution returned an
 * error even though independent inspection later established a clean final
 * outcome. Action receipts may be incomplete because the transport response
 * was lost; the external outcome remains the source of truth.
 */
export interface ExecutionReconciliationReceipt {
  reason: "execution-error";
  outcomeEstablished: true;
  actionReceiptsComplete: false;
  resumedFromVerifiedState: true;
  reconciledAt: string;
}

export type GoalRunResult =
  | {
      status: "completed";
      requestId: string;
      capabilitySource: "built" | "reused" | "trusted-tool";
      capabilityId: string;
      actions: ActionReceipt[];
      outcome: OutcomeReceipt;
      resume: ResumeReceipt;
      reconciliation?: ExecutionReconciliationReceipt;
    }
  | { status: "handoff"; handoff: HandoffEnvelope };

export interface CapabilityEvent {
  tenantId: string;
  requestId: string;
  correlation?: GoalCorrelation;
  type:
    | "acquisition.requested"
    | "capability.discovered"
    | "capability.reused"
    | "capability.built"
    | "capability.repaired"
    | "capability.verified"
    | "capability.rejected"
    | "capability.quarantined"
    | "capability.executed"
    | "execution.reconciled"
    | "outcome.verified"
    | "incident.created"
    | "goal.resumed"
    | "handoff.created";
  detail: Record<string, unknown>;
  occurredAt: string;
}
