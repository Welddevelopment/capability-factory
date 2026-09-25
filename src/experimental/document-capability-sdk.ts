import {
  ExperimentalDocumentDriver,
  ExperimentalDocumentPolicyError,
  type ExperimentalDocumentCapability,
  type ExperimentalDocumentOutcomeVerifier,
  type ExperimentalDocumentRunResult,
} from "./document-driver.js";
import type {
  DocumentCapabilityRegistry,
  VerifiedDocumentCapabilityRecord,
} from "./document-registry.js";

export interface TrustedDocumentCapabilitySource {
  readonly sourceId: string;
  find(needKey: string, contractHash: string): Promise<ExperimentalDocumentCapability | null>;
}

export interface DocumentCapabilityBuilder {
  readonly builderId: string;
  build(needKey: string, contractHash: string): Promise<ExperimentalDocumentCapability | null>;
}

export interface DocumentCapabilityGoalRequest {
  tenantId: string;
  requestId: string;
  parentGoalId: string;
  ordinaryGoal: string;
  needKey: string;
  contractHash: string;
  operationKey: string;
  inputDocumentAlias: string;
  expectedDocumentSha256: string;
  approvals: string[];
  simulateLostResponseAfterCommit?: boolean;
}

export type DocumentCapabilityAcquisitionPath = "retained-capability" | "trusted-capability" | "built-capability";

export interface DocumentCapabilityEvent {
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

export type DocumentCapabilityGoalResult =
  | {
      status: "completed";
      tenantId: string;
      requestId: string;
      parentGoalId: string;
      ordinaryGoal: string;
      path: DocumentCapabilityAcquisitionPath;
      capabilityId: string;
      execution: Extract<ExperimentalDocumentRunResult, { status: "completed" }>;
      events: DocumentCapabilityEvent[];
      parent: { resumed: true; completed: true; summary: string; verifiedAt: string };
    }
  | {
      status: "blocked" | "unknown";
      tenantId: string;
      requestId: string;
      parentGoalId: string;
      ordinaryGoal: string;
      path?: DocumentCapabilityAcquisitionPath;
      capabilityId?: string;
      execution?: Extract<ExperimentalDocumentRunResult, { status: "blocked" | "unknown" }>;
      events: DocumentCapabilityEvent[];
      parent: { resumed: false; completed: false; summary: string };
      handoff: {
        reason: "capability-unavailable" | "authority-missing" | "document-outcome-unsafe";
        summary: string;
        writesAttempted: number;
      };
    };

export interface DocumentCapabilitySdkDependencies {
  driver: ExperimentalDocumentDriver;
  registry: DocumentCapabilityRegistry;
  trustedSource: TrustedDocumentCapabilitySource;
  builder?: DocumentCapabilityBuilder;
  outcomeVerifier(request: DocumentCapabilityGoalRequest): ExperimentalDocumentOutcomeVerifier;
}

export class ExperimentalDocumentCapabilitySdk {
  constructor(private readonly dependencies: DocumentCapabilitySdkDependencies) {}

  async completeGoal(request: DocumentCapabilityGoalRequest): Promise<DocumentCapabilityGoalResult> {
    this.validateRequest(request);
    const events: DocumentCapabilityEvent[] = [];
    const emit = (stage: DocumentCapabilityEvent["stage"], summary: string) => {
      events.push({ sequence: events.length + 1, stage, summary });
    };
    emit("diagnosis.completed", "The ordinary goal requires one trusted PDF order to become one draft.");

    let record = this.dependencies.registry.findActive(request.tenantId, request.needKey, request.contractHash);
    let acquisitionPath: DocumentCapabilityAcquisitionPath;
    if (record) {
      acquisitionPath = "retained-capability";
      emit("search.retained.completed", "A retained, verified document capability matched the exact template contract.");
    } else {
      emit("search.retained.completed", "No active retained document capability matched the exact template contract.");
      const contained = this.dependencies.registry.list(request.tenantId).find((candidate) =>
        candidate.needKey === request.needKey &&
        candidate.manifest.contractHash === request.contractHash &&
        candidate.status !== "active",
      );
      if (contained) {
        return this.handoff(request, events, "capability-unavailable", `The matching document capability is ${contained.status}; automatic reacquisition is refused.`, 0);
      }
      let candidate = await this.dependencies.trustedSource.find(request.needKey, request.contractHash);
      let origin: VerifiedDocumentCapabilityRecord["origin"] = `trusted:${this.dependencies.trustedSource.sourceId}`;
      acquisitionPath = "trusted-capability";
      if (candidate) {
        emit("search.trusted.completed", "A trusted source supplied a document capability pinned to the exact contract.");
      } else {
        emit("search.trusted.completed", "No reviewed existing document capability matched the exact contract.");
        if (this.dependencies.builder) {
          candidate = await this.dependencies.builder.build(request.needKey, request.contractHash);
          origin = `built:${this.dependencies.builder.builderId}`;
          acquisitionPath = "built-capability";
        }
        if (candidate) emit("build.completed", "The minimum PDF capability was constructed from trusted template metadata.");
      }
      if (!candidate) {
        return this.handoff(request, events, "capability-unavailable", "No retained, trusted, or constructible document capability matched.", 0);
      }
      let verification: Awaited<ReturnType<ExperimentalDocumentDriver["verifyCapability"]>>;
      try {
        verification = await this.dependencies.driver.verifyCapability(candidate);
      } catch (error) {
        return this.handoff(
          request,
          events,
          error instanceof ExperimentalDocumentPolicyError ? "authority-missing" : "capability-unavailable",
          `The candidate document capability could not be verified: ${error instanceof Error ? error.message : String(error)}`,
          0,
        );
      }
      if (!verification.passed) {
        return this.handoff(
          request,
          events,
          "capability-unavailable",
          `Pre-use verification failed: ${verification.checks.filter((check) => !check.passed).map((check) => check.detail).join(" ")}`,
          0,
        );
      }
      emit("capability.verification.completed", "The exact capability passed a disposable, no-business-write PDF probe.");
      const verifiedRecord: VerifiedDocumentCapabilityRecord = {
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
      emit("capability.retained", "The verified document capability was retained only for this tenant and template contract.");
      record = verifiedRecord;
    }
    if (!record) throw new Error("Document capability resolution ended without an active record.");

    let execution: ExperimentalDocumentRunResult;
    try {
      execution = await this.dependencies.driver.execute(
        record.manifest,
        {
          operationKey: request.operationKey,
          runId: request.requestId,
          inputDocumentAlias: request.inputDocumentAlias,
          expectedDocumentSha256: request.expectedDocumentSha256,
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
        error instanceof ExperimentalDocumentPolicyError ? "authority-missing" : "document-outcome-unsafe",
        `The bounded document action was refused: ${error instanceof Error ? error.message : String(error)}`,
        0,
        acquisitionPath,
        record.manifest.id,
      );
    }
    if (execution.status === "completed") {
      emit(execution.reconciled ? "execution.reconciled" : "execution.completed", execution.reason);
      emit("outcome.verification.completed", "The customer-local draft store independently proved the exact expected order.");
      if (acquisitionPath === "retained-capability") {
        this.dependencies.registry.markUsed(request.tenantId, record.manifest.id);
      }
      emit("resumption.completed", "The parent goal resumed only after verified document-backed draft creation.");
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
          summary: "The exact document-backed draft was independently verified; the original goal resumed.",
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
      execution.writesAttempted === 0 && !execution.quarantined ? "authority-missing" : "document-outcome-unsafe",
      execution.reason,
      execution.writesAttempted,
      acquisitionPath,
      record.manifest.id,
      execution,
    );
  }

  private validateRequest(request: DocumentCapabilityGoalRequest): void {
    for (const [key, value] of Object.entries({
      tenantId: request.tenantId,
      requestId: request.requestId,
      parentGoalId: request.parentGoalId,
      ordinaryGoal: request.ordinaryGoal,
      needKey: request.needKey,
      operationKey: request.operationKey,
      inputDocumentAlias: request.inputDocumentAlias,
    })) {
      if (!value || value.length > 2_000) throw new Error(`Document goal request has an invalid ${key}.`);
    }
    if (!/^[a-f0-9]{64}$/.test(request.contractHash)) throw new Error("Document request requires a SHA-256 contract hash.");
    if (!/^[a-f0-9]{64}$/.test(request.expectedDocumentSha256)) throw new Error("Document request requires the trusted source SHA-256.");
  }

  private handoff(
    request: DocumentCapabilityGoalRequest,
    events: DocumentCapabilityEvent[],
    reason: Extract<DocumentCapabilityGoalResult, { handoff: unknown }>["handoff"]["reason"],
    summary: string,
    writesAttempted: number,
    path?: DocumentCapabilityAcquisitionPath,
    capabilityId?: string,
    execution?: Extract<ExperimentalDocumentRunResult, { status: "blocked" | "unknown" }>,
  ): Extract<DocumentCapabilityGoalResult, { handoff: unknown }> {
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
        summary: "The original goal remains blocked because safe document completion was not proved.",
      },
      handoff: { reason, summary, writesAttempted },
    };
  }
}

export class StaticTrustedDocumentCapabilitySource implements TrustedDocumentCapabilitySource {
  constructor(readonly sourceId: string, private readonly manifests: ExperimentalDocumentCapability[]) {}

  async find(needKey: string, contractHash: string): Promise<ExperimentalDocumentCapability | null> {
    return structuredClone(
      this.manifests.find((manifest) => manifest.needKey === needKey && manifest.contractHash === contractHash) ?? null,
    );
  }
}
