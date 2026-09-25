import type { CapabilityRequest, GoalRunResult, HandoffReason } from "./contracts.js";
import { sanitizeCapabilityRequest } from "./redaction.js";
import type { CapabilityFactorySdk, CapabilityWorkflow } from "./sdk.js";

export interface AcquisitionJob {
  id: string;
  tenantId: string;
  request: CapabilityRequest;
  status: "queued" | "leased" | "completed";
  leasedBy?: string;
  result?: ControlPlaneResult;
}

export type ControlPlaneResult =
  | {
      status: "completed";
      requestId: string;
      capabilityId: string;
      capabilitySource: "built" | "reused" | "trusted-tool";
      outcomePassed: true;
      goalCompleted: true;
    }
  | {
      status: "handoff";
      requestId: string;
      reason: HandoffReason;
    };

/** Reference control-plane contract. It carries no secret values and cannot execute customer actions. */
export class InMemoryControlPlaneQueue {
  private readonly jobs = new Map<string, AcquisitionJob>();

  enqueue(request: CapabilityRequest): string {
    if (this.jobs.has(request.context.requestId)) throw new Error("Duplicate request ID");
    const safeRequest = sanitizeCapabilityRequest(request);
    this.jobs.set(request.context.requestId, {
      id: request.context.requestId,
      tenantId: request.context.tenantId,
      request: safeRequest,
      status: "queued",
    });
    return request.context.requestId;
  }

  lease(tenantId: string, runnerId: string): AcquisitionJob | undefined {
    const job = [...this.jobs.values()].find(
      (candidate) => candidate.tenantId === tenantId && candidate.status === "queued",
    );
    if (!job) return undefined;
    job.status = "leased";
    job.leasedBy = runnerId;
    return structuredClone(job);
  }

  complete(tenantId: string, runnerId: string, jobId: string, result: GoalRunResult): void {
    const job = this.jobs.get(jobId);
    if (!job || job.tenantId !== tenantId) throw new Error("Job not found for tenant");
    if (job.status !== "leased" || job.leasedBy !== runnerId) throw new Error("Runner does not own this lease");
    job.status = "completed";
    job.result =
      result.status === "completed"
        ? {
            status: "completed",
            requestId: result.requestId,
            capabilityId: result.capabilityId,
            capabilitySource: result.capabilitySource,
            outcomePassed: true,
            goalCompleted: true,
          }
        : {
            status: "handoff",
            requestId: result.handoff.requestId,
            reason: result.handoff.reason,
          };
  }

  get(tenantId: string, jobId: string): AcquisitionJob | undefined {
    const job = this.jobs.get(jobId);
    return job?.tenantId === tenantId ? structuredClone(job) : undefined;
  }
}

export interface WorkerWorkflowResolver {
  resolve(workflowKey: string): CapabilityWorkflow | undefined;
}

export interface LocalRequestResolver {
  resolve(requestId: string): CapabilityRequest | undefined;
}

/** Customer-side data-plane runner. Credentials remain behind the SDK's local runtime resolver. */
export class CustomerDataPlaneWorker {
  constructor(
    private readonly tenantId: string,
    private readonly runnerId: string,
    private readonly queue: InMemoryControlPlaneQueue,
    private readonly sdk: CapabilityFactorySdk,
    private readonly workflows: WorkerWorkflowResolver,
    private readonly localRequests: LocalRequestResolver,
  ) {}

  async runOnce(): Promise<boolean> {
    const job = this.queue.lease(this.tenantId, this.runnerId);
    if (!job) return false;
    const localRequest = this.localRequests.resolve(job.id);
    const workflow = localRequest ? this.workflows.resolve(localRequest.context.workflowKey) : undefined;
    const result: GoalRunResult = workflow
      ? await this.sdk.completeBlockedGoal(localRequest!, workflow)
      : {
          status: "handoff",
          handoff: {
            requestId: job.request.context.requestId,
            tenantId: this.tenantId,
            reason: "execution-failed",
            summary: "The customer data plane does not have the requested workflow installed.",
            failedChecks: [{ id: "workflow", passed: false, detail: "Unknown workflow key" }],
            createdAt: new Date().toISOString(),
          },
        };
    this.queue.complete(this.tenantId, this.runnerId, job.id, result);
    return true;
  }
}
