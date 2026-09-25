import {
  ExperimentalInboxMessageDriver,
  ExperimentalInboxMessagePolicyError,
  type ExperimentalInboxMessageCapability,
  type ExperimentalInboxMessageOutcomeVerifier,
  type ExperimentalInboxMessageRunResult,
} from "./inbox-message-driver.js";
import type {
  InboxMessageCapabilityRegistry,
  VerifiedInboxMessageCapabilityRecord,
} from "./inbox-message-registry.js";

export interface TrustedInboxMessageCapabilitySource {
  readonly sourceId: string;
  find(needKey: string, contractHash: string): Promise<ExperimentalInboxMessageCapability | null>;
}

export interface InboxMessageCapabilityBuilder {
  readonly builderId: string;
  build(needKey: string, contractHash: string): Promise<ExperimentalInboxMessageCapability | null>;
}

export interface InboxMessageCapabilityGoalRequest {
  tenantId: string;
  requestId: string;
  parentGoalId: string;
  ordinaryGoal: string;
  needKey: string;
  contractHash: string;
  operationKey: string;
  inputMessageAlias: string;
  expectedMessageSha256: string;
  approvals: string[];
  simulateLostResponseAfterCommit?: boolean;
}

export type InboxMessageCapabilityAcquisitionPath =
  | "retained-capability"
  | "trusted-capability"
  | "built-capability";

export interface InboxMessageCapabilityEvent {
  sequence: number;
  stage:
    | "diagnosis.completed"
    | "search.retained.completed"
    | "search.trusted.completed"
    | "build.completed"
    | "capability.verification.completed"
    | "execution.completed"
    | "execution.reconciled"
    | "outcome.verification.completed"
    | "capability.retained"
    | "resumption.completed"
    | "handoff.created";
  summary: string;
}

export type InboxMessageCapabilityGoalResult =
  | {
      status: "completed";
      tenantId: string;
      requestId: string;
      parentGoalId: string;
      ordinaryGoal: string;
      path: InboxMessageCapabilityAcquisitionPath;
      capabilityId: string;
      execution: Extract<ExperimentalInboxMessageRunResult, { status: "completed" }>;
      events: InboxMessageCapabilityEvent[];
      parent: { resumed: true; completed: true; summary: string; verifiedAt: string };
    }
  | {
      status: "blocked" | "unknown";
      tenantId: string;
      requestId: string;
      parentGoalId: string;
      ordinaryGoal: string;
      path?: InboxMessageCapabilityAcquisitionPath;
      capabilityId?: string;
      execution?: Extract<ExperimentalInboxMessageRunResult, { status: "blocked" | "unknown" }>;
      events: InboxMessageCapabilityEvent[];
      parent: { resumed: false; completed: false; summary: string };
      handoff: {
        reason: "capability-unavailable" | "authority-missing" | "inbox-outcome-unsafe";
        summary: string;
        writesAttempted: number;
      };
    };

export interface InboxMessageCapabilitySdkDependencies {
  driver: ExperimentalInboxMessageDriver;
  registry: InboxMessageCapabilityRegistry;
  trustedSource: TrustedInboxMessageCapabilitySource;
  builder?: InboxMessageCapabilityBuilder;
  outcomeVerifier(request: InboxMessageCapabilityGoalRequest): ExperimentalInboxMessageOutcomeVerifier;
}

export class ExperimentalInboxMessageCapabilitySdk {
  constructor(private readonly dependencies: InboxMessageCapabilitySdkDependencies) {}

  async completeGoal(request: InboxMessageCapabilityGoalRequest): Promise<InboxMessageCapabilityGoalResult> {
    this.validateRequest(request);
    const events: InboxMessageCapabilityEvent[] = [];
    const emit = (stage: InboxMessageCapabilityEvent["stage"], summary: string) => {
      events.push({ sequence: events.length + 1, stage, summary });
    };
    emit("diagnosis.completed", "The ordinary goal requires one approved inbox order to become one draft.");

    let record = this.dependencies.registry.findActive(request.tenantId, request.needKey, request.contractHash);
    let acquisitionPath: InboxMessageCapabilityAcquisitionPath;
    if (record) {
      acquisitionPath = "retained-capability";
      emit("search.retained.completed", "A retained, verified inbox capability matched the exact sender/template contract.");
    } else {
      emit("search.retained.completed", "No active retained inbox capability matched the exact contract.");
      const contained = this.dependencies.registry.list(request.tenantId).find((candidate) =>
        candidate.needKey === request.needKey &&
        candidate.manifest.contractHash === request.contractHash &&
        candidate.status !== "active",
      );
      if (contained) {
        return this.handoff(
          request,
          events,
          "capability-unavailable",
          `The matching inbox capability is ${contained.status}; automatic reacquisition is refused.`,
          0,
        );
      }

      let candidate = await this.dependencies.trustedSource.find(request.needKey, request.contractHash);
      let origin: VerifiedInboxMessageCapabilityRecord["origin"] =
        `trusted:${this.dependencies.trustedSource.sourceId}`;
      acquisitionPath = "trusted-capability";
      if (candidate) {
        emit("search.trusted.completed", "A trusted source supplied an inbox capability pinned to the exact contract.");
      } else {
        emit("search.trusted.completed", "No reviewed existing inbox capability matched the exact contract.");
        if (this.dependencies.builder) {
          candidate = await this.dependencies.builder.build(request.needKey, request.contractHash);
          origin = `built:${this.dependencies.builder.builderId}`;
          acquisitionPath = "built-capability";
        }
        if (candidate) {
          emit("build.completed", "The minimum inbox capability was constructed from trusted sender/template metadata.");
        }
      }
      if (!candidate) {
        return this.handoff(
          request,
          events,
          "capability-unavailable",
          "No retained, trusted, or constructible inbox capability matched the required contract.",
          0,
        );
      }

      let verification: Awaited<ReturnType<ExperimentalInboxMessageDriver["verifyCapability"]>>;
      try {
        verification = await this.dependencies.driver.verifyCapability(candidate);
      } catch (error) {
        return this.handoff(
          request,
          events,
          error instanceof ExperimentalInboxMessagePolicyError ? "authority-missing" : "capability-unavailable",
          `The candidate inbox capability could not be verified: ${error instanceof Error ? error.message : String(error)}`,
          0,
        );
      }
      if (!verification.passed) {
        return this.handoff(
          request,
          events,
          "capability-unavailable",
          `Pre-use verification failed: ${verification.checks
            .filter((check) => !check.passed)
            .map((check) => check.detail)
            .join(" ")}`,
          0,
        );
      }
      emit("capability.verification.completed", "The exact capability passed a disposable, no-business-write inbox probe.");
      const verifiedRecord: VerifiedInboxMessageCapabilityRecord = {
        tenantId: request.tenantId,
        needKey: request.needKey,
        manifest: candidate,
        verification,
        origin,
        status: "active",
        registeredAt: new Date().toISOString(),
        reuseCount: 0,
      };
      this.dependencies.registry.register(verifiedRecord);
      emit("capability.retained", "The verified inbox capability was retained only for this tenant and contract.");
      record = verifiedRecord;
    }
    if (!record) throw new Error("Inbox capability resolution ended without an active record.");

    let execution: ExperimentalInboxMessageRunResult;
    try {
      execution = await this.dependencies.driver.execute(
        record.manifest,
        {
          operationKey: request.operationKey,
          runId: request.requestId,
          inputMessageAlias: request.inputMessageAlias,
          expectedMessageSha256: request.expectedMessageSha256,
          approvals: request.approvals,
          verification: record.verification,
          ...(request.simulateLostResponseAfterCommit ? { simulateLostResponseAfterCommit: true } : {}),
        },
        this.dependencies.outcomeVerifier(request),
      );
    } catch (error) {
      return this.handoff(
        request,
        events,
        error instanceof ExperimentalInboxMessagePolicyError ? "authority-missing" : "inbox-outcome-unsafe",
        `The bounded inbox action was refused: ${error instanceof Error ? error.message : String(error)}`,
        0,
        acquisitionPath,
        record.manifest.id,
      );
    }

    if (execution.status === "completed") {
      emit(execution.reconciled ? "execution.reconciled" : "execution.completed", execution.reason);
      emit("outcome.verification.completed", "The customer-local draft store independently proved exactly one correct order.");
      if (acquisitionPath === "retained-capability") {
        this.dependencies.registry.markUsed(request.tenantId, record.manifest.id);
      }
      emit("resumption.completed", "The interrupted parent goal resumed only after verified draft creation.");
      return {
        status: "completed",
        tenantId: request.tenantId,
        requestId: request.requestId,
        parentGoalId: request.parentGoalId,
        ordinaryGoal: request.ordinaryGoal,
        path: acquisitionPath,
        capabilityId: record.manifest.id,
        execution,
        events,
        parent: {
          resumed: true,
          completed: true,
          summary: "The exact draft was independently verified; the original goal resumed and completed.",
          verifiedAt: new Date().toISOString(),
        },
      };
    }
    if (execution.quarantined) {
      this.dependencies.registry.setStatus(request.tenantId, record.manifest.id, "quarantined", execution.reason);
    }
    return this.handoff(
      request,
      events,
      execution.writesAttempted === 0 && !execution.quarantined ? "authority-missing" : "inbox-outcome-unsafe",
      execution.reason,
      execution.writesAttempted,
      acquisitionPath,
      record.manifest.id,
      execution,
    );
  }

  private validateRequest(request: InboxMessageCapabilityGoalRequest): void {
    for (const [key, value] of Object.entries({
      tenantId: request.tenantId,
      requestId: request.requestId,
      parentGoalId: request.parentGoalId,
      ordinaryGoal: request.ordinaryGoal,
      needKey: request.needKey,
      operationKey: request.operationKey,
      inputMessageAlias: request.inputMessageAlias,
    })) {
      if (!value || value.length > 2_000) throw new Error(`Inbox goal request has an invalid ${key}.`);
    }
    if (!/^[a-f0-9]{64}$/.test(request.contractHash)) {
      throw new Error("Inbox goal request requires a SHA-256 contract hash.");
    }
    if (!/^[a-f0-9]{64}$/.test(request.expectedMessageSha256)) {
      throw new Error("Inbox goal request requires the trusted message SHA-256.");
    }
  }

  private handoff(
    request: InboxMessageCapabilityGoalRequest,
    events: InboxMessageCapabilityEvent[],
    reason: Extract<InboxMessageCapabilityGoalResult, { handoff: unknown }>["handoff"]["reason"],
    summary: string,
    writesAttempted: number,
    path?: InboxMessageCapabilityAcquisitionPath,
    capabilityId?: string,
    execution?: Extract<ExperimentalInboxMessageRunResult, { status: "blocked" | "unknown" }>,
  ): Extract<InboxMessageCapabilityGoalResult, { handoff: unknown }> {
    events.push({ sequence: events.length + 1, stage: "handoff.created", summary });
    return {
      status: execution?.status ?? "blocked",
      tenantId: request.tenantId,
      requestId: request.requestId,
      parentGoalId: request.parentGoalId,
      ordinaryGoal: request.ordinaryGoal,
      ...(path ? { path } : {}),
      ...(capabilityId ? { capabilityId } : {}),
      ...(execution ? { execution } : {}),
      events,
      parent: {
        resumed: false,
        completed: false,
        summary: "The original goal remains blocked because safe inbox completion was not proved.",
      },
      handoff: { reason, summary, writesAttempted },
    };
  }
}

export class StaticTrustedInboxMessageCapabilitySource implements TrustedInboxMessageCapabilitySource {
  constructor(
    readonly sourceId: string,
    private readonly manifests: ExperimentalInboxMessageCapability[],
  ) {}

  async find(needKey: string, contractHash: string): Promise<ExperimentalInboxMessageCapability | null> {
    return structuredClone(
      this.manifests.find((manifest) =>
        manifest.needKey === needKey && manifest.contractHash === contractHash,
      ) ?? null,
    );
  }
}
