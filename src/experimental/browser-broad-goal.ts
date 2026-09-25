import { createHash } from "node:crypto";
import type { HandoffEnvelope, OutcomeReceipt, ResumeReceipt } from "../product/contracts.js";
import type { GoalContinuationGrantVerifier } from "../product/continuation.js";
import type { ValidatedGoalPlan, ValidatedGoalWorkItem } from "../product/goal-coordination.js";
import {
  GoalScheduler,
  type GoalAggregateOutcomeReceipt,
  type GoalAggregateOutcomeVerifier,
  type GoalAggregateResumer,
  type GoalCoordinationEventSink,
  type GoalCoordinationStore,
  type GoalWorkItemExecutionInput,
  type GoalWorkItemExecutionResult,
  type GoalWorkItemExecutor,
  type GoalWorkItemOutcomeVerifier,
} from "../product/goal-scheduler.js";
import type {
  BrowserCapabilityGoalRequest,
  BrowserCapabilityGoalResult,
  ExperimentalBrowserCapabilitySdk,
} from "./browser-capability-sdk.js";
import type { ExperimentalBrowserOutcomeVerifier } from "./browser-driver.js";

export interface BrowserBroadGoalWorkflowBinding {
  workflowKey: string;
  needKey: string;
  uiContractHash: string;
  approvalKey: string;
  input(plan: ValidatedGoalPlan, item: ValidatedGoalWorkItem): Record<string, string>;
  outcomeVerifier(
    plan: ValidatedGoalPlan,
    item: ValidatedGoalWorkItem,
    input: Record<string, string>,
  ): ExperimentalBrowserOutcomeVerifier;
}

export interface BrowserBroadGoalAggregateEvidence {
  passed: boolean;
  incorrectSideEffects: number;
  stateDigest: string;
  checks: Array<{ id: string; passed: boolean; detail: string }>;
}

function childRunId(plan: ValidatedGoalPlan, item: ValidatedGoalWorkItem): string {
  return createHash("sha256")
    .update(`browser-child-v1\u001f${plan.tenantId}\u001f${plan.parentGoalId}\u001f${item.workItemId}`)
    .digest("hex")
    .slice(0, 32);
}

function handoff(
  plan: ValidatedGoalPlan,
  item: ValidatedGoalWorkItem,
  result: Extract<BrowserCapabilityGoalResult, { handoff: unknown }>,
): HandoffEnvelope {
  return {
    requestId: plan.requestId,
    tenantId: plan.tenantId,
    reason: result.handoff.reason === "authority-or-credential-missing"
      ? "authority-missing"
      : result.handoff.reason === "capability-unavailable"
        ? "build-failed"
        : "outcome-failed",
    summary: result.handoff.summary,
    ...(result.capabilityId ? { attemptedCapabilityId: result.capabilityId } : {}),
    failedChecks: [{
      id: `browser:${result.handoff.reason}`,
      passed: false,
      detail: result.handoff.summary,
    }],
    createdAt: new Date().toISOString(),
  };
}

/** Maps one validated broad-goal work item into the isolated browser SDK. */
export class BrowserBroadGoalWorkItemExecutor implements GoalWorkItemExecutor {
  private readonly bindings: Map<string, BrowserBroadGoalWorkflowBinding>;

  constructor(
    private readonly sdk: ExperimentalBrowserCapabilitySdk,
    bindings: BrowserBroadGoalWorkflowBinding[],
  ) {
    this.bindings = new Map(bindings.map((binding) => [binding.workflowKey, binding]));
    if (this.bindings.size !== bindings.length) throw new Error("Browser broad-goal workflow bindings must be unique.");
  }

  async execute({ plan, item }: GoalWorkItemExecutionInput): Promise<GoalWorkItemExecutionResult> {
    const binding = this.bindings.get(item.workflowKey);
    const runId = childRunId(plan, item);
    if (!binding) {
      return {
        status: "blocked",
        childRunId: runId,
        operationKey: item.operationKey,
        writesAttempted: 0,
        handoff: {
          requestId: plan.requestId,
          tenantId: plan.tenantId,
          reason: "build-failed",
          summary: `No trusted browser workflow binding exists for ${item.workflowKey}.`,
          failedChecks: [{ id: "browser:workflow-binding", passed: false, detail: "The runtime cannot invent a workflow binding." }],
          createdAt: new Date().toISOString(),
        },
      };
    }
    const input = binding.input(plan, item);
    const request: BrowserCapabilityGoalRequest = {
      tenantId: plan.tenantId,
      requestId: runId,
      parentGoalId: plan.parentGoalId,
      ordinaryGoal: item.summary,
      needKey: binding.needKey,
      uiContractHash: binding.uiContractHash,
      operationKey: item.operationKey,
      input,
      approvals: item.authority.currentlyAuthorized ? [binding.approvalKey] : [],
    };
    const result = await this.sdk.completeGoal(request);
    if (result.status === "completed") {
      const path = result.path === "retained-capability"
        ? "retained-capability"
        : result.path === "built-capability"
          ? "built-capability"
          : "trusted-tool";
      return {
        status: result.execution.writePerformed ? "executed" : "already-satisfied",
        path,
        childRunId: runId,
        operationKey: item.operationKey,
        writesAttempted: result.execution.writePerformed ? 1 : 0,
        summary: result.parent.summary,
      };
    }
    if (result.handoff.writesAttempted === 0) {
      return {
        status: "blocked",
        childRunId: runId,
        operationKey: item.operationKey,
        writesAttempted: 0,
        handoff: handoff(plan, item, result),
      };
    }
    return {
      status: result.status === "unknown" ? "unknown" : "failed",
      childRunId: runId,
      operationKey: item.operationKey,
      writesAttempted: result.handoff.writesAttempted,
      summary: result.handoff.summary,
    };
  }
}

/** Rechecks external state after the browser SDK's own direct verifier. */
export class BrowserBroadGoalOutcomeVerifier implements GoalWorkItemOutcomeVerifier {
  private readonly bindings: Map<string, BrowserBroadGoalWorkflowBinding>;

  constructor(bindings: BrowserBroadGoalWorkflowBinding[]) {
    this.bindings = new Map(bindings.map((binding) => [binding.workflowKey, binding]));
  }

  async verify(
    plan: ValidatedGoalPlan,
    item: ValidatedGoalWorkItem,
  ): Promise<OutcomeReceipt> {
    const binding = this.bindings.get(item.workflowKey);
    if (!binding) throw new Error(`Missing browser outcome binding for ${item.workflowKey}.`);
    const input = binding.input(plan, item);
    const direct = await binding.outcomeVerifier(plan, item, input).verify(item.operationKey);
    const passed = direct.outcome === "complete";
    return {
      verifierVersion: binding.outcomeVerifier(plan, item, input).key,
      passed,
      intendedWrites: passed ? 1 : 0,
      incorrectSideEffects: direct.outcome === "incorrect" || direct.outcome === "partial" ? 1 : 0,
      stateDigest: direct.stateDigest ?? createHash("sha256").update(direct.detail).digest("hex"),
      checks: [{ id: "browser-direct-external-state", passed, detail: direct.detail }],
      verifiedAt: new Date().toISOString(),
    };
  }
}

export class BrowserBroadGoalAggregateVerifier implements GoalAggregateOutcomeVerifier {
  constructor(
    private readonly external?: (
      plan: ValidatedGoalPlan,
      state: Parameters<GoalAggregateOutcomeVerifier["verify"]>[1],
    ) => Promise<BrowserBroadGoalAggregateEvidence>,
  ) {}

  async verify(plan: ValidatedGoalPlan, state: Parameters<GoalAggregateOutcomeVerifier["verify"]>[1]): Promise<GoalAggregateOutcomeReceipt> {
    const values = Object.values(state.items);
    const completedItems = values.filter((item) => item.lifecycle === "completed").length;
    const blockedItems = values.filter((item) => item.lifecycle === "blocked").length;
    const failedItems = values.filter((item) => item.lifecycle === "failed").length;
    const unknownItems = values.filter((item) => item.lifecycle === "unknown").length;
    const itemIncorrectSideEffects = values.reduce((total, item) => total + (item.outcome?.incorrectSideEffects ?? 0), 0);
    const external = this.external
      ? await this.external(plan, state)
      : {
          passed: true,
          incorrectSideEffects: 0,
          stateDigest: "no-additional-aggregate-check",
          checks: [] as BrowserBroadGoalAggregateEvidence["checks"],
        };
    const incorrectSideEffects = itemIncorrectSideEffects + external.incorrectSideEffects;
    const passed = completedItems === plan.workItems.length && incorrectSideEffects === 0 && external.passed;
    const result = passed
      ? "complete"
      : unknownItems > 0
        ? "unknown"
        : failedItems > 0
          ? "failed"
          : blockedItems > 0
            ? completedItems > 0 ? "partially-complete" : "blocked"
            : "partially-complete";
    const stateDigest = createHash("sha256").update(JSON.stringify({
      items: values.map((item) => ({
        workItemId: item.workItemId,
        lifecycle: item.lifecycle,
        outcome: item.outcome?.stateDigest,
      })),
      external: external.stateDigest,
    })).digest("hex");
    return {
      verifierVersion: "browser-broad-goal-aggregate-v1",
      receiptId: createHash("sha256").update(`${plan.parentGoalId}\u001f${stateDigest}`).digest("hex").slice(0, 32),
      result,
      passed,
      requiredItems: plan.workItems.length,
      completedItems,
      blockedItems,
      failedItems,
      unknownItems,
      incorrectSideEffects,
      stateDigest,
      checks: [{
        id: "browser-parent-complete",
        passed,
        detail: passed
          ? "Every browser-backed work item passed a second direct external-state check."
          : "The parent remains incomplete because one or more browser-backed items lack clean direct proof.",
      }, ...external.checks],
      verifiedAt: new Date().toISOString(),
    };
  }
}

export class BrowserBroadGoalResumer implements GoalAggregateResumer {
  async resume(_plan: ValidatedGoalPlan, receipt: GoalAggregateOutcomeReceipt): Promise<ResumeReceipt> {
    return {
      completed: receipt.passed && receipt.result === "complete",
      summary: receipt.passed
        ? "Every required browser-backed outcome was independently verified; the original goal resumed."
        : "The original goal did not resume because aggregate browser outcomes are incomplete.",
    };
  }
}

export function createBrowserBroadGoalScheduler(options: {
  sdk: ExperimentalBrowserCapabilitySdk;
  bindings: BrowserBroadGoalWorkflowBinding[];
  store: GoalCoordinationStore;
  events?: GoalCoordinationEventSink;
  continuationAuthority?: GoalContinuationGrantVerifier;
  aggregateEvidence?: (
    plan: ValidatedGoalPlan,
    state: Parameters<GoalAggregateOutcomeVerifier["verify"]>[1],
  ) => Promise<BrowserBroadGoalAggregateEvidence>;
}): GoalScheduler {
  return new GoalScheduler(
    options.store,
    new BrowserBroadGoalWorkItemExecutor(options.sdk, options.bindings),
    new BrowserBroadGoalOutcomeVerifier(options.bindings),
    new BrowserBroadGoalAggregateVerifier(options.aggregateEvidence),
    new BrowserBroadGoalResumer(),
    options.events,
    options.continuationAuthority,
  );
}
