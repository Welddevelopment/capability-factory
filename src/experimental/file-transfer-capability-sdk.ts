import {
  ExperimentalFileTransferDriver,
  ExperimentalFileTransferPolicyError,
  type ExperimentalFileTransferCapability,
  type ExperimentalFileTransferOutcomeVerifier,
  type ExperimentalFileTransferRunResult,
} from "./file-transfer-driver.js";
import type {
  FileTransferCapabilityRegistry,
  VerifiedFileTransferCapabilityRecord,
} from "./file-transfer-registry.js";

export interface TrustedFileTransferCapabilitySource {
  readonly sourceId: string;
  find(needKey: string, contractHash: string): Promise<ExperimentalFileTransferCapability | null>;
}

export interface FileTransferCapabilityBuilder {
  readonly builderId: string;
  build(needKey: string, contractHash: string): Promise<ExperimentalFileTransferCapability | null>;
}

export interface FileTransferCapabilityGoalRequest {
  tenantId: string;
  requestId: string;
  parentGoalId: string;
  ordinaryGoal: string;
  needKey: string;
  contractHash: string;
  operationKey: string;
  inputFileAlias: string;
  expectedInputSha256: string;
  approvals: string[];
  simulateLostResponseAfterCommit?: boolean;
}

export type FileTransferCapabilityAcquisitionPath =
  | "retained-capability"
  | "trusted-capability"
  | "built-capability";

export interface FileTransferCapabilityEvent {
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

export type FileTransferCapabilityGoalResult =
  | {
      status: "completed";
      tenantId: string;
      requestId: string;
      parentGoalId: string;
      ordinaryGoal: string;
      path: FileTransferCapabilityAcquisitionPath;
      capabilityId: string;
      execution: Extract<ExperimentalFileTransferRunResult, { status: "completed" }>;
      events: FileTransferCapabilityEvent[];
      parent: {
        resumed: true;
        completed: true;
        summary: string;
        verifiedAt: string;
      };
    }
  | {
      status: "blocked" | "unknown";
      tenantId: string;
      requestId: string;
      parentGoalId: string;
      ordinaryGoal: string;
      path?: FileTransferCapabilityAcquisitionPath;
      capabilityId?: string;
      execution?: Extract<ExperimentalFileTransferRunResult, { status: "blocked" | "unknown" }>;
      events: FileTransferCapabilityEvent[];
      parent: {
        resumed: false;
        completed: false;
        summary: string;
      };
      handoff: {
        reason: "capability-unavailable" | "authority-missing" | "file-outcome-unsafe";
        summary: string;
        writesAttempted: number;
      };
    };

export interface FileTransferCapabilitySdkDependencies {
  driver: ExperimentalFileTransferDriver;
  registry: FileTransferCapabilityRegistry;
  trustedSource: TrustedFileTransferCapabilitySource;
  builder?: FileTransferCapabilityBuilder;
  outcomeVerifier(request: FileTransferCapabilityGoalRequest): ExperimentalFileTransferOutcomeVerifier;
}

/**
 * A deliberately separate acquisition mode. It never widens the HTTP or browser
 * manifests and resumes the parent goal only after a direct outbox-state check.
 */
export class ExperimentalFileTransferCapabilitySdk {
  constructor(private readonly dependencies: FileTransferCapabilitySdkDependencies) {}

  async completeGoal(request: FileTransferCapabilityGoalRequest): Promise<FileTransferCapabilityGoalResult> {
    this.validateRequest(request);
    const events: FileTransferCapabilityEvent[] = [];
    const emit = (stage: FileTransferCapabilityEvent["stage"], summary: string) => {
      events.push({ sequence: events.length + 1, stage, summary });
    };
    emit("diagnosis.completed", "The ordinary goal requires one approved partner-order file import.");

    let record = this.dependencies.registry.findActive(request.tenantId, request.needKey, request.contractHash);
    let acquisitionPath: FileTransferCapabilityAcquisitionPath;
    if (record) {
      acquisitionPath = "retained-capability";
      emit("search.retained.completed", "A retained, verified file capability matched the exact partner contract.");
    } else {
      emit("search.retained.completed", "No active retained capability matched the exact partner contract.");
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
          `The matching file capability is ${contained.status}; automatic reacquisition is refused.`,
          0,
        );
      }

      let candidate = await this.dependencies.trustedSource.find(request.needKey, request.contractHash);
      let origin: VerifiedFileTransferCapabilityRecord["origin"] =
        `trusted:${this.dependencies.trustedSource.sourceId}`;
      acquisitionPath = "trusted-capability";
      if (candidate) {
        emit("search.trusted.completed", "A trusted source supplied a capability pinned to the exact contract.");
      } else {
        emit("search.trusted.completed", "No reviewed existing capability matched the exact contract.");
        if (this.dependencies.builder) {
          candidate = await this.dependencies.builder.build(request.needKey, request.contractHash);
          origin = `built:${this.dependencies.builder.builderId}`;
          acquisitionPath = "built-capability";
        }
        if (candidate) {
          emit("build.completed", "The minimum bounded file capability was constructed from trusted contract metadata.");
        }
      }
      if (!candidate) {
        return this.handoff(
          request,
          events,
          "capability-unavailable",
          "No retained, trusted, or constructible file capability matched the required contract.",
          0,
        );
      }

      let verification: Awaited<ReturnType<ExperimentalFileTransferDriver["verifyCapability"]>>;
      try {
        verification = await this.dependencies.driver.verifyCapability(candidate);
      } catch (error) {
        return this.handoff(
          request,
          events,
          error instanceof ExperimentalFileTransferPolicyError ? "authority-missing" : "capability-unavailable",
          `The candidate file capability could not be verified: ${error instanceof Error ? error.message : String(error)}`,
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
      emit("capability.verification.completed", "The exact capability passed a disposable, no-business-write probe.");
      const verifiedRecord: VerifiedFileTransferCapabilityRecord = {
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
      emit("capability.retained", "The verified capability was retained only for this tenant and contract.");
      record = verifiedRecord;
    }

    if (!record) throw new Error("File capability resolution ended without an active record.");

    let execution: ExperimentalFileTransferRunResult;
    try {
      execution = await this.dependencies.driver.execute(
        record.manifest,
        {
          operationKey: request.operationKey,
          runId: request.requestId,
          inputFileAlias: request.inputFileAlias,
          expectedInputSha256: request.expectedInputSha256,
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
        error instanceof ExperimentalFileTransferPolicyError ? "authority-missing" : "file-outcome-unsafe",
        `The bounded file action was refused: ${error instanceof Error ? error.message : String(error)}`,
        0,
        acquisitionPath,
        record.manifest.id,
      );
    }

    if (execution.status === "completed") {
      emit(
        execution.reconciled ? "execution.reconciled" : "execution.completed",
        execution.reason,
      );
      emit("outcome.verification.completed", "The customer-local outbox independently proved exactly one correct order.");
      if (acquisitionPath === "retained-capability") {
        this.dependencies.registry.markUsed(request.tenantId, record.manifest.id);
      }
      emit("resumption.completed", "The interrupted parent goal resumed only after verified external completion.");
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
          summary: "The exact file outcome was independently verified; the original goal resumed and completed.",
          verifiedAt: new Date().toISOString(),
        },
      };
    }

    if (execution.quarantined) {
      this.dependencies.registry.setStatus(
        request.tenantId,
        record.manifest.id,
        "quarantined",
        execution.reason,
      );
    }
    return this.handoff(
      request,
      events,
      execution.writesAttempted === 0 && !execution.quarantined
        ? "authority-missing"
        : "file-outcome-unsafe",
      execution.reason,
      execution.writesAttempted,
      acquisitionPath,
      record.manifest.id,
      execution,
    );
  }

  private validateRequest(request: FileTransferCapabilityGoalRequest): void {
    for (const [key, value] of Object.entries({
      tenantId: request.tenantId,
      requestId: request.requestId,
      parentGoalId: request.parentGoalId,
      ordinaryGoal: request.ordinaryGoal,
      needKey: request.needKey,
      operationKey: request.operationKey,
      inputFileAlias: request.inputFileAlias,
    })) {
      if (!value || value.length > 2_000) throw new Error(`File goal request has an invalid ${key}.`);
    }
    if (!/^[a-f0-9]{64}$/.test(request.contractHash)) {
      throw new Error("File goal request requires a SHA-256 contract hash.");
    }
    if (!/^[a-f0-9]{64}$/.test(request.expectedInputSha256)) {
      throw new Error("File goal request requires the trusted input SHA-256.");
    }
  }

  private handoff(
    request: FileTransferCapabilityGoalRequest,
    events: FileTransferCapabilityEvent[],
    reason: Extract<FileTransferCapabilityGoalResult, { handoff: unknown }>["handoff"]["reason"],
    summary: string,
    writesAttempted: number,
    path?: FileTransferCapabilityAcquisitionPath,
    capabilityId?: string,
    execution?: Extract<ExperimentalFileTransferRunResult, { status: "blocked" | "unknown" }>,
  ): Extract<FileTransferCapabilityGoalResult, { handoff: unknown }> {
    events.push({
      sequence: events.length + 1,
      stage: "handoff.created",
      summary,
    });
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
        summary: "The original goal remains blocked because safe file completion was not proved.",
      },
      handoff: { reason, summary, writesAttempted },
    };
  }
}

export class StaticTrustedFileTransferCapabilitySource implements TrustedFileTransferCapabilitySource {
  constructor(
    readonly sourceId: string,
    private readonly manifests: ExperimentalFileTransferCapability[],
  ) {}

  async find(needKey: string, contractHash: string): Promise<ExperimentalFileTransferCapability | null> {
    return structuredClone(
      this.manifests.find((manifest) =>
        manifest.needKey === needKey && manifest.contractHash === contractHash,
      ) ?? null,
    );
  }
}
