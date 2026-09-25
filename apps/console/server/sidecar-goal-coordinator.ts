import type { BroadGoalRequest, BroadGoalRunResult } from "../../../src/product/broad-goal-sdk.js";
import type { ValidatedGoalPlan } from "../../../src/product/goal-coordination.js";
import type { GoalCoordinationState, GoalWorkItemState } from "../../../src/product/goal-scheduler.js";
import type { SidecarGoalJobEvent, SidecarGoalJobReceipt } from "../../../src/product/sidecar-jobs.js";
import type { CapabilityModeDescriptor } from "../../../src/product/capability-mode-contract.js";
import {
  createGoalContinuationGrant,
  type GoalContinuationGrant,
  type GoalContinuationGrantSigner,
} from "../../../src/product/continuation.js";
import type { ConsoleEvent } from "../shared/contracts.js";
import { makeConsoleEvent, stableConsoleId } from "../shared/contracts.js";

export interface ConsoleSidecarClient {
  startGoal(request: BroadGoalRequest): Promise<SidecarGoalJobReceipt>;
  getGoalJob(tenantId: string, jobId: string): Promise<SidecarGoalJobReceipt>;
  getGoalJobEvents(tenantId: string, jobId: string, afterSequence?: number): Promise<SidecarGoalJobEvent[]>;
  continueGoalJob(tenantId: string, jobId: string, grant: GoalContinuationGrant): Promise<SidecarGoalJobReceipt>;
  listCapabilityModes?(): Promise<{
    schemaVersion: "1.0";
    selection: "trusted-explicit";
    inference: false;
    modes: CapabilityModeDescriptor[];
  }>;
}

export interface ConsoleSidecarConfiguration {
  client: ConsoleSidecarClient;
  tenantId: string;
  scopeKey: string;
  fixtureLabel: string;
  workflowLabel: string;
  suggestedGoal: string;
  capabilityFormat?: string;
  capabilityVerifierLabel?: string;
  pollIntervalMs?: number;
  continuationAuthority?: GoalContinuationGrantSigner;
}

export interface ConsoleSidecarRunIdentity {
  runId: string;
  requestId: string;
  parentGoalId: string;
  jobId: string;
  ordinaryGoal: string;
}

type AppendConsoleEvent = (event: ConsoleEvent) => unknown;

function acquisitionPath(state: GoalWorkItemState): "none" | "existing-ability" | "retained-reuse" | "new-capability" | "authority-handoff" {
  if (state.lifecycle === "blocked") return "authority-handoff";
  if (!state.execution || !("path" in state.execution)) return "none";
  if (state.execution.path === "already-satisfied") return "none";
  if (state.execution.path === "retained-capability") return "retained-reuse";
  if (state.execution.path === "built-capability") return "new-capability";
  return "existing-ability";
}

function aggregateResultForConsole(result: GoalCoordinationState["aggregate"] extends infer _T ? string : never): "complete" | "partially-complete" | "blocked" | "unknown" {
  return result === "complete" || result === "partially-complete" || result === "blocked" ? result : "unknown";
}

/**
 * Turns the sidecar's trusted product result into the console's sanitized event model.
 * It projects receipts already produced by product code; it does not independently
 * decide that a run succeeded.
 */
export function projectSidecarGoalResult(
  identity: ConsoleSidecarRunIdentity,
  result: BroadGoalRunResult,
  configuration: ConsoleSidecarConfiguration,
  consoleTenantId: string,
): ConsoleEvent[] {
  const events: ConsoleEvent[] = [];
  let sequence = 0;
  const add = (
    runId: string,
    type: ConsoleEvent["type"],
    payload: Record<string, unknown>,
    classification: ConsoleEvent["sensitivity"]["classification"] = "tenant-confidential",
  ) => {
    sequence += 1;
    events.push(makeConsoleEvent({
      eventId: stableConsoleId("sidecar-console-result-v1", identity.runId, runId, type, String(sequence)),
      tenantId: consoleTenantId,
      runId,
      requestId: identity.requestId,
      type,
      occurredAt: new Date(Date.now() + sequence).toISOString(),
      payload,
      sensitivity: { classification, source: "console-adapter", sanitized: true },
    }));
  };

  if (!("state" in result)) {
    const reason = result.status === "handoff" ? result.handoff.reason : "plan-rejected";
    const summary = result.status === "handoff"
      ? result.handoff.summary
      : "The proposed plan did not pass trusted validation. No work was started.";
    add(identity.runId, "handoff.created", {
      handoffId: stableConsoleId("sidecar-root-handoff-v1", identity.parentGoalId, reason),
      reason,
      missing: reason,
      summary,
      parentGoalId: identity.parentGoalId,
    }, "security-sensitive");
    return events;
  }

  if (!result.plan) {
    add(identity.runId, "execution.failed", {
      reason: "missing-sanitized-plan",
      summary: "The sidecar result did not include the validated plan needed for console projection.",
    }, "security-sensitive");
    return events;
  }
  const plan: ValidatedGoalPlan = result.plan;
  const state: GoalCoordinationState = result.state;
  add(identity.runId, "goal.plan.proposed", {
    parentGoalId: plan.parentGoalId,
    planVersion: plan.planVersion,
    fixture: configuration.fixtureLabel,
    itemCount: plan.workItems.length,
    summary: plan.summary,
  });
  add(identity.runId, "goal.plan.validated", {
    parentGoalId: plan.parentGoalId,
    planVersion: plan.planVersion,
    passed: plan.checks.every((check) => check.passed),
    validationReceipt: plan.validationReceiptId,
    checks: plan.checks.map((check) => check.id).slice(0, 24),
    checkCount: plan.checks.length,
    scope: plan.summary,
    deadline: plan.deadline.description,
    targetAliases: [...new Set(plan.workItems.flatMap((item) => item.authority.targetAliases))],
    credentialAliases: [...new Set(plan.workItems.flatMap((item) => item.authority.credentialAliases))],
    authorityState: plan.workItems.every((item) => item.authority.currentlyAuthorized)
      ? "All planned actions are inside customer-trusted authority"
      : "At least one planned action is waiting at an authority boundary",
  }, "security-sensitive");

  for (const item of plan.workItems) {
    const itemState = state.items[item.workItemId];
    if (!itemState) continue;
    const childRunId = itemState.childRunId ?? stableConsoleId("sidecar-child-run-v1", identity.runId, item.workItemId);
    const path = acquisitionPath(itemState);
    const alreadySatisfied = itemState.execution?.status === "already-satisfied";
    add(identity.runId, "work-item.created", {
      parentGoalId: plan.parentGoalId,
      planVersion: plan.planVersion,
      workItemId: item.workItemId,
      groupId: item.groupId,
      groupLabel: item.groupLabel,
      groupReason: "The trusted plan keeps each independently verifiable operation inside a conservative execution group.",
      entityAlias: item.entityAliases[0] ?? "approved-target",
      workflowKey: item.workflowKey,
      summary: item.summary,
      dependencies: item.dependencyWorkItemIds,
      executionOrder: item.executionOrder,
      initialStatus: alreadySatisfied ? "already-satisfied" : item.dependencyWorkItemIds.length > 0 ? "waiting" : "ready",
      acquisitionPath: path,
      childRunId,
      required: true,
    });
    if (itemState.attempts > 0 && !alreadySatisfied) {
      add(identity.runId, "work-item.started", {
        parentGoalId: plan.parentGoalId,
        workItemId: item.workItemId,
        operationId: item.operationKey,
        idempotencyKey: item.operationKey,
        startedAt: itemState.updatedAt,
      });
    }
    add(childRunId, "goal.received", {
      source: "coordinator-work-item",
      workflow: item.workflowKey,
      goal: item.summary,
      parentGoalId: plan.parentGoalId,
      workItemId: item.workItemId,
    });

    if (itemState.lifecycle === "blocked") {
      const handoffId = stableConsoleId("sidecar-work-handoff-v1", identity.parentGoalId, item.workItemId);
      const missing = item.authority.missing.join(", ") || itemState.handoff?.reason || "required authority";
      add(identity.runId, "work-item.blocked", {
        parentGoalId: plan.parentGoalId,
        workItemId: item.workItemId,
        operationId: item.operationKey,
        handoffId,
        reason: itemState.handoff?.reason ?? "authority-missing",
        missing,
        writesAttempted: 0,
        blockedAt: itemState.updatedAt,
      });
      add(childRunId, "authority.checked", { passed: false, methods: item.authority.methods, parentGoalId: plan.parentGoalId, workItemId: item.workItemId }, "security-sensitive");
      add(childRunId, "handoff.created", {
        handoffId,
        reason: itemState.handoff?.reason ?? "authority-missing",
        missing,
        summary: itemState.handoff?.summary ?? "The work item stopped before execution because trusted authority was unavailable.",
        parentGoalId: plan.parentGoalId,
        workItemId: item.workItemId,
        expectedStateVersion: state.version,
      }, "security-sensitive");
      continue;
    }

    if (itemState.lifecycle === "failed" || itemState.lifecycle === "unknown") {
      add(childRunId, "execution.failed", {
        reason: itemState.lifecycle,
        summary: itemState.execution && "summary" in itemState.execution ? itemState.execution.summary : "The result was not safe to claim as complete.",
        parentGoalId: plan.parentGoalId,
        workItemId: item.workItemId,
      }, "security-sensitive");
      continue;
    }
    if (itemState.lifecycle !== "completed" || !itemState.execution || !itemState.outcome) continue;

    add(childRunId, "authority.checked", {
      passed: true,
      targetAliases: item.authority.targetAliases,
      credentialAliases: item.authority.credentialAliases,
      methods: item.authority.methods,
      writeAuthority: item.authority.writeRequired ? "customer-approved-write" : "read-only",
      parentGoalId: plan.parentGoalId,
      workItemId: item.workItemId,
    }, "security-sensitive");
    const capabilityId = stableConsoleId("sidecar-capability-v1", configuration.scopeKey, item.workflowKey);
    if (path === "retained-reuse") add(childRunId, "search.retained.completed", { result: "verified-match", candidates: 1, capabilityId, parentGoalId: plan.parentGoalId, workItemId: item.workItemId });
    if (path === "existing-ability") add(childRunId, "search.trusted.completed", { result: "verified-match", candidates: 1, capabilityId, parentGoalId: plan.parentGoalId, workItemId: item.workItemId });
    if (path === "new-capability") {
      add(childRunId, "search.retained.completed", { result: "no-match", candidates: 0, parentGoalId: plan.parentGoalId, workItemId: item.workItemId });
      add(childRunId, "search.trusted.completed", { result: "no-match", candidates: 0, parentGoalId: plan.parentGoalId, workItemId: item.workItemId });
      add(childRunId, "build.completed", { result: "candidate-created", format: configuration.capabilityFormat ?? "constrained declarative HTTP manifest", attempts: 1, capabilityId, parentGoalId: plan.parentGoalId, workItemId: item.workItemId });
      add(childRunId, "capability.verification.completed", { passed: true, verifier: configuration.capabilityVerifierLabel ?? "customer-local disposable capability probe", capabilityId, checks: ["trusted policy", "required actions", "disposable write", "probe reset"], parentGoalId: plan.parentGoalId, workItemId: item.workItemId });
    }
    if ("reconciliation" in itemState.execution && itemState.execution.reconciliation) {
      const reconciliation = itemState.execution.reconciliation;
      add(childRunId, "execution.reconciled", {
        reason: reconciliation.reason,
        summary: "The create committed but its response was unavailable. Customer-local reconciliation found exactly one matching Purchase Order, so the write was not retried.",
        action: reconciliation.action,
        recoveryAction: reconciliation.recoveryAction,
        externalMatches: reconciliation.externalMatches,
        responseReceived: reconciliation.responseReceived,
        writeRetried: reconciliation.writeRetried,
        duplicatePrevented: reconciliation.duplicatePrevented,
        parentGoalId: plan.parentGoalId,
        workItemId: item.workItemId,
      }, "security-sensitive");
    }
    if (!alreadySatisfied) add(childRunId, "execution.completed", {
      capabilityId,
      receipt: stableConsoleId("sidecar-execution-receipt-v1", item.operationKey),
      actionsCompleted: "writesAttempted" in itemState.execution ? itemState.execution.writesAttempted : 0,
      executionPath: path,
      parentGoalId: plan.parentGoalId,
      workItemId: item.workItemId,
    });
    add(childRunId, "outcome.verification.completed", {
      passed: itemState.outcome.passed,
      verifier: itemState.outcome.verifierVersion,
      intendedWrites: itemState.outcome.intendedWrites,
      incorrectSideEffects: itemState.outcome.incorrectSideEffects,
      checks: itemState.outcome.checks.map((check) => check.id),
      parentGoalId: plan.parentGoalId,
      workItemId: item.workItemId,
    });
    add(childRunId, "resumption.completed", { completed: true, summary: "The coordinator accepted the verified item result and continued the parent plan.", parentGoalId: plan.parentGoalId, workItemId: item.workItemId });
    add(childRunId, "run.completed", { outcome: "completed", parentGoalId: plan.parentGoalId, workItemId: item.workItemId });
    add(identity.runId, "work-item.completed", {
      parentGoalId: plan.parentGoalId,
      workItemId: item.workItemId,
      operationId: item.operationKey,
      outcomeReceipt: stableConsoleId("sidecar-item-outcome-v1", item.workItemId, itemState.outcome.stateDigest),
      passed: itemState.outcome.passed,
      intendedWrites: itemState.outcome.intendedWrites,
      incorrectSideEffects: itemState.outcome.incorrectSideEffects,
      completedAt: itemState.updatedAt,
    });
  }

  const aggregate = state.aggregate;
  if (!aggregate) return events;
  add(identity.runId, "goal.outcome.verified", {
    parentGoalId: plan.parentGoalId,
    planVersion: plan.planVersion,
    aggregateReceipt: aggregate.receiptId,
    result: aggregateResultForConsole(aggregate.result),
    passed: aggregate.passed,
    requiredItems: aggregate.requiredItems,
    completedItems: aggregate.completedItems,
    alreadySatisfiedItems: Object.values(state.items).filter((item) => item.execution?.status === "already-satisfied").length,
    blockedItems: aggregate.blockedItems,
    failedItems: aggregate.failedItems,
    unknownItems: aggregate.unknownItems,
    incorrectSideEffects: aggregate.incorrectSideEffects,
    verifiedAt: aggregate.verifiedAt,
    summary: aggregate.result === "complete" ? "Every required item passed direct external-state verification." : "The external result is not complete; the console has not claimed success.",
  });
  if (state.resume?.completed && aggregate.result === "complete" && aggregate.passed && aggregate.incorrectSideEffects === 0) {
    add(identity.runId, "outcome.verification.completed", { passed: true, verifier: aggregate.verifierVersion, intendedWrites: Object.values(state.items).reduce((total, item) => total + (item.outcome?.intendedWrites ?? 0), 0), incorrectSideEffects: 0, checks: aggregate.checks.map((check) => check.id) });
    add(identity.runId, "resumption.completed", { completed: true, summary: state.resume.summary });
    add(identity.runId, "run.completed", { outcome: "completed" });
  } else {
    add(identity.runId, "handoff.created", {
      handoffId: stableConsoleId("sidecar-root-handoff-v1", plan.parentGoalId, state.lifecycle),
      reason: state.lifecycle,
      missing: "A required verified result or resumption receipt is missing.",
      summary: "Verified work was preserved, but the parent goal did not claim completion.",
      parentGoalId: plan.parentGoalId,
    }, "security-sensitive");
  }
  return events;
}

export class ConsoleSidecarGoalBridge {
  private readonly active = new Map<string, Promise<void>>();
  private readonly continuations = new Map<string, { handoffId: string; handoffRunId: string; parentHandoffId: string }>();
  private closed = false;

  constructor(
    private readonly configuration: ConsoleSidecarConfiguration,
    private readonly consoleTenantId: string,
    private readonly append: AppendConsoleEvent,
  ) {}

  async start(input: Omit<ConsoleSidecarRunIdentity, "jobId">): Promise<ConsoleSidecarRunIdentity> {
    const request: BroadGoalRequest = {
      schemaVersion: "1.0",
      tenantId: this.configuration.tenantId,
      parentGoalId: input.parentGoalId,
      requestId: input.requestId,
      scopeKey: this.configuration.scopeKey,
      ordinaryGoal: input.ordinaryGoal,
      visibility: "full",
    };
    const receipt = await this.configuration.client.startGoal(request);
    const identity = { ...input, jobId: receipt.jobId };
    this.append(makeConsoleEvent({
      eventId: stableConsoleId("sidecar-console-root-v1", identity.runId),
      tenantId: this.consoleTenantId,
      runId: identity.runId,
      requestId: identity.requestId,
      type: "goal.received",
      occurredAt: new Date().toISOString(),
      payload: {
        source: "customer-sidecar",
        workflow: this.configuration.workflowLabel,
        goal: identity.ordinaryGoal,
        fixture: this.configuration.fixtureLabel,
        jobId: identity.jobId,
        parentGoalId: identity.parentGoalId,
        sidecarTenantId: this.configuration.tenantId,
        scopeKey: this.configuration.scopeKey,
      },
      sensitivity: { classification: "tenant-confidential", source: "console-adapter", sanitized: true },
    }));
    this.monitor(identity);
    return identity;
  }

  resume(identity: ConsoleSidecarRunIdentity): void {
    this.monitor(identity);
  }

  continuationConfigured(): boolean {
    return Boolean(this.configuration.continuationAuthority);
  }

  async continue(input: {
    identity: ConsoleSidecarRunIdentity;
    handoffId: string;
    handoffRunId: string;
    workItemId: string;
    expectedStateVersion: number;
    issuedBy: string;
  }): Promise<SidecarGoalJobReceipt> {
    const authority = this.configuration.continuationAuthority;
    if (!authority) throw new Error("Customer-local signed continuation is not configured.");
    await this.active.get(input.identity.jobId);
    const receipt = await this.configuration.client.getGoalJob(this.configuration.tenantId, input.identity.jobId);
    const result = receipt.result;
    if (!result || !("state" in result) || !result.plan) throw new Error("The durable job has no saved blocked state to continue.");
    if (result.state.version !== input.expectedStateVersion) throw new Error("The handoff changed after it was displayed. Refresh before approving it.");
    const planned = result.plan.workItems.find((item) => item.workItemId === input.workItemId);
    const state = result.state.items[input.workItemId];
    if (!planned || !state || state.lifecycle !== "blocked" || !state.handoff) {
      throw new Error("The exact work item is no longer an open blocked handoff.");
    }
    const missing = planned.authority.missing;
    if (missing.some((value) => /credential|secret|account/i.test(value))) {
      throw new Error("A credential handoff must be satisfied inside the customer secret provider before continuation can be approved.");
    }
    const grant = createGoalContinuationGrant({
      plan: result.plan,
      state: result.state,
      workItemId: input.workItemId,
      kind: "permission-approved",
      authorizedMissing: missing,
      preconditions: [{
        id: "explicit-customer-approval",
        passed: true,
        detail: "The customer-local operator confirmed the exact blocked action in the console.",
      }],
      issuedBy: input.issuedBy,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      authority,
    });
    const continued = await this.configuration.client.continueGoalJob(
      this.configuration.tenantId,
      input.identity.jobId,
      grant,
    );
    const parentHandoffId = stableConsoleId(
      "sidecar-root-handoff-v1",
      result.plan.parentGoalId,
      result.state.lifecycle,
    );
    this.continuations.set(input.identity.jobId, {
      handoffId: input.handoffId,
      handoffRunId: input.handoffRunId,
      parentHandoffId,
    });
    const occurredAt = new Date().toISOString();
    this.append(makeConsoleEvent({
      tenantId: this.consoleTenantId,
      runId: input.handoffRunId,
      requestId: input.identity.requestId,
      type: "handoff.continuation.authorized",
      occurredAt,
      payload: {
        handoffId: input.handoffId,
        grantId: grant.grantId,
        workItemId: input.workItemId,
        expectedStateVersion: input.expectedStateVersion,
        issuedBy: input.issuedBy,
        expiresAt: grant.expiresAt,
      },
      sensitivity: { classification: "security-sensitive", source: "console-adapter", sanitized: true },
    }));
    this.append(makeConsoleEvent({
      tenantId: this.consoleTenantId,
      runId: input.handoffRunId,
      requestId: input.identity.requestId,
      type: "handoff.lifecycle.changed",
      occurredAt,
      payload: { handoffId: input.handoffId, lifecycle: "continuing", continuationRunId: input.identity.runId },
      sensitivity: { classification: "tenant-confidential", source: "console-adapter", sanitized: true },
    }));
    this.monitor(input.identity);
    return continued;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.active.values());
  }

  private monitor(identity: ConsoleSidecarRunIdentity): void {
    if (this.active.has(identity.jobId) || this.closed) return;
    const task = this.runMonitor(identity)
      .catch((error: unknown) => {
        this.append(makeConsoleEvent({
          eventId: stableConsoleId("sidecar-console-projection-error-v1", identity.jobId),
          tenantId: this.consoleTenantId,
          runId: identity.runId,
          requestId: identity.requestId,
          type: "execution.failed",
          occurredAt: new Date().toISOString(),
          payload: {
            reason: "console-projection-error",
            summary: error instanceof Error ? error.message : "The console could not project the durable sidecar result.",
          },
          sensitivity: { classification: "security-sensitive", source: "console-adapter", sanitized: true },
        }));
      })
      .finally(() => this.active.delete(identity.jobId));
    this.active.set(identity.jobId, task);
  }

  private async runMonitor(identity: ConsoleSidecarRunIdentity): Promise<void> {
    let cursor = 0;
    while (!this.closed) {
      const jobEvents = await this.configuration.client.getGoalJobEvents(this.configuration.tenantId, identity.jobId, cursor);
      for (const event of jobEvents) {
        cursor = Math.max(cursor, event.sequence);
        this.append(makeConsoleEvent({
          eventId: stableConsoleId("sidecar-console-job-event-v1", identity.jobId, String(event.sequence)),
          tenantId: this.consoleTenantId,
          runId: identity.runId,
          requestId: identity.requestId,
          type: "sidecar.job.status",
          occurredAt: event.occurredAt,
          payload: { jobId: event.jobId, status: event.status, eventType: event.type, attempts: event.attempts, sequence: event.sequence },
          sensitivity: { classification: "tenant-confidential", source: "console-adapter", sanitized: true },
        }));
      }
      const receipt = await this.configuration.client.getGoalJob(this.configuration.tenantId, identity.jobId);
      if (receipt.status !== "queued" && receipt.status !== "running") {
        if (receipt.result) projectSidecarGoalResult(identity, receipt.result, this.configuration, this.consoleTenantId).forEach(this.append);
        else this.append(makeConsoleEvent({
          eventId: stableConsoleId("sidecar-console-monitor-failure-v1", identity.jobId),
          tenantId: this.consoleTenantId,
          runId: identity.runId,
          requestId: identity.requestId,
          type: "execution.failed",
          occurredAt: new Date().toISOString(),
          payload: { reason: receipt.status, summary: receipt.error ?? "The durable sidecar job ended without a trusted result." },
          sensitivity: { classification: "security-sensitive", source: "console-adapter", sanitized: true },
        }));
        const continuation = this.continuations.get(identity.jobId);
        if (continuation && receipt.status === "completed") {
          const occurredAt = new Date().toISOString();
          for (const target of [
            { runId: continuation.handoffRunId, handoffId: continuation.handoffId },
            { runId: identity.runId, handoffId: continuation.parentHandoffId },
          ]) {
            this.append(makeConsoleEvent({
              tenantId: this.consoleTenantId,
              runId: target.runId,
              requestId: identity.requestId,
              type: "handoff.lifecycle.changed",
              occurredAt,
              payload: { handoffId: target.handoffId, lifecycle: "resolved", continuationRunId: identity.runId },
              sensitivity: { classification: "tenant-confidential", source: "console-adapter", sanitized: true },
            }));
          }
          this.continuations.delete(identity.jobId);
        }
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, this.configuration.pollIntervalMs ?? 100));
    }
  }
}
