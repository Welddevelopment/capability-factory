import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { HandoffEnvelope, OutcomeReceipt, ResumeReceipt } from "./contracts.js";
import {
  authenticateGoalContinuationGrant,
  validateGoalContinuationGrant,
  type GoalContinuationGrant,
  type GoalContinuationLivePreconditionVerifier,
  type GoalContinuationRevocationVerifier,
  type GoalContinuationGrantVerifier,
} from "./continuation.js";
import type { ValidatedGoalPlan, ValidatedGoalWorkItem } from "./goal-coordination.js";
import { redactValue } from "./redaction.js";

export type GoalWorkItemLifecycle =
  | "pending"
  | "running"
  | "completed"
  | "blocked"
  | "failed"
  | "unknown";

export type GoalExecutionPath =
  | "already-satisfied"
  | "existing-ability"
  | "retained-capability"
  | "trusted-tool"
  | "built-capability";

export interface GoalWorkItemReconciliationReceipt {
  reason: "post-write-response-lost";
  action: string;
  recoveryAction: string;
  externalMatches: 1;
  responseReceived: false;
  writeRetried: false;
  duplicatePrevented: true;
}

export interface GoalWorkItemExecutionReceipt {
  status: "executed" | "already-satisfied";
  path: GoalExecutionPath;
  childRunId: string;
  operationKey: string;
  writesAttempted: number;
  summary: string;
  reconciliation?: GoalWorkItemReconciliationReceipt;
}

export type GoalWorkItemExecutionResult =
  | GoalWorkItemExecutionReceipt
  | {
      status: "blocked";
      childRunId: string;
      operationKey: string;
      writesAttempted: number;
      handoff: HandoffEnvelope;
    }
  | {
      status: "failed";
      childRunId: string;
      operationKey: string;
      writesAttempted: number;
      summary: string;
    }
  | {
      status: "unknown";
      childRunId: string;
      operationKey: string;
      writesAttempted: number;
      summary: string;
    };

export interface GoalWorkItemExecutionInput {
  plan: ValidatedGoalPlan;
  item: ValidatedGoalWorkItem;
  mode: "execute" | "reconcile";
}

export interface GoalWorkItemExecutor {
  execute(input: GoalWorkItemExecutionInput): Promise<GoalWorkItemExecutionResult>;
}

export interface GoalWorkItemOutcomeVerifier {
  verify(
    plan: ValidatedGoalPlan,
    item: ValidatedGoalWorkItem,
    execution: Extract<GoalWorkItemExecutionResult, { status: "executed" | "already-satisfied" }>,
  ): Promise<OutcomeReceipt>;
}

export type GoalAggregateResult = "complete" | "partially-complete" | "blocked" | "failed" | "unknown";

export interface GoalAggregateOutcomeReceipt {
  verifierVersion: string;
  receiptId: string;
  result: GoalAggregateResult;
  passed: boolean;
  requiredItems: number;
  completedItems: number;
  blockedItems: number;
  failedItems: number;
  unknownItems: number;
  incorrectSideEffects: number;
  stateDigest: string;
  checks: Array<{ id: string; passed: boolean; detail: string }>;
  verifiedAt: string;
}

export interface GoalAggregateOutcomeVerifier {
  verify(plan: ValidatedGoalPlan, state: GoalCoordinationState): Promise<GoalAggregateOutcomeReceipt>;
}

export interface GoalAggregateResumer {
  resume(plan: ValidatedGoalPlan, receipt: GoalAggregateOutcomeReceipt): Promise<ResumeReceipt>;
}

export interface GoalWorkItemState {
  workItemId: string;
  lifecycle: GoalWorkItemLifecycle;
  attempts: number;
  lastMode?: "execute" | "reconcile";
  childRunId?: string;
  execution?: GoalWorkItemExecutionResult;
  outcome?: OutcomeReceipt;
  handoff?: HandoffEnvelope;
  continuation?: {
    grantId: string;
    kind: GoalContinuationGrant["kind"];
    issuedBy: string;
    authorizedMissing: string[];
    continuedAt: string;
  };
  updatedAt: string;
}

export interface GoalCoordinationState {
  schemaVersion: "1.0";
  tenantId: string;
  parentGoalId: string;
  requestId: string;
  planDigest: string;
  version: number;
  lifecycle: "active" | "completed" | "partially-complete" | "blocked" | "failed" | "unknown";
  items: Record<string, GoalWorkItemState>;
  aggregate?: GoalAggregateOutcomeReceipt;
  resume?: ResumeReceipt;
  createdAt: string;
  updatedAt: string;
}

export interface GoalCoordinationStore {
  load(tenantId: string, parentGoalId: string): GoalCoordinationState | null;
  save(state: GoalCoordinationState, expectedVersion: number | null): GoalCoordinationState;
}

export interface GoalCoordinationEvent {
  tenantId: string;
  parentGoalId: string;
  requestId: string;
  workItemId?: string;
  type:
    | "goal-plan.activated"
    | "work-item.running"
    | "work-item.completed"
    | "work-item.blocked"
    | "work-item.failed"
    | "work-item.unknown"
    | "work-item.continuation-authorized"
    | "goal-outcome.verified"
    | "goal.resumed";
  detail: Record<string, unknown>;
  occurredAt: string;
}

export interface GoalCoordinationEventSink {
  record(event: GoalCoordinationEvent): void;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function goalPlanDigest(plan: ValidatedGoalPlan): string {
  return createHash("sha256").update(canonical(plan)).digest("hex");
}

export class FileGoalCoordinationStore implements GoalCoordinationStore {
  constructor(private readonly rootDirectory: string) {
    fs.mkdirSync(rootDirectory, { recursive: true, mode: 0o700 });
  }

  load(tenantId: string, parentGoalId: string): GoalCoordinationState | null {
    const filename = this.filename(tenantId, parentGoalId);
    if (!fs.existsSync(filename)) return null;
    return JSON.parse(fs.readFileSync(filename, "utf8")) as GoalCoordinationState;
  }

  save(state: GoalCoordinationState, expectedVersion: number | null): GoalCoordinationState {
    const current = this.load(state.tenantId, state.parentGoalId);
    if (expectedVersion === null && current) throw new Error("Goal coordination state already exists.");
    if (expectedVersion !== null && current?.version !== expectedVersion) {
      throw new Error("Goal coordination state changed concurrently.");
    }
    const next = redactValue({
      ...structuredClone(state),
      version: (current?.version ?? 0) + 1,
    }) as GoalCoordinationState;
    const filename = this.filename(state.tenantId, state.parentGoalId);
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, filename);
    return structuredClone(next);
  }

  private filename(tenantId: string, parentGoalId: string): string {
    const digest = createHash("sha256").update(`${tenantId}\u001f${parentGoalId}`).digest("hex");
    return path.join(this.rootDirectory, `${digest}.json`);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function initialState(plan: ValidatedGoalPlan): GoalCoordinationState {
  const now = nowIso();
  return {
    schemaVersion: "1.0",
    tenantId: plan.tenantId,
    parentGoalId: plan.parentGoalId,
    requestId: plan.requestId,
    planDigest: goalPlanDigest(plan),
    version: 0,
    lifecycle: "active",
    items: Object.fromEntries(
      plan.workItems.map((item) => [
        item.workItemId,
        {
          workItemId: item.workItemId,
          lifecycle: "pending",
          attempts: 0,
          updatedAt: now,
        } satisfies GoalWorkItemState,
      ]),
    ),
    createdAt: now,
    updatedAt: now,
  };
}

function parentLifecycle(receipt: GoalAggregateOutcomeReceipt): GoalCoordinationState["lifecycle"] {
  return receipt.result === "complete" ? "completed" : receipt.result;
}

export class GoalScheduler {
  constructor(
    private readonly store: GoalCoordinationStore,
    private readonly executor: GoalWorkItemExecutor,
    private readonly itemVerifier: GoalWorkItemOutcomeVerifier,
    private readonly aggregateVerifier: GoalAggregateOutcomeVerifier,
    private readonly resumer: GoalAggregateResumer,
    private readonly events?: GoalCoordinationEventSink,
    private readonly continuationAuthority?: GoalContinuationGrantVerifier,
    private readonly continuationPreconditions?: GoalContinuationLivePreconditionVerifier,
    private readonly continuationRevocations?: GoalContinuationRevocationVerifier,
  ) {}

  async run(plan: ValidatedGoalPlan): Promise<GoalCoordinationState> {
    return this.runInternal(plan, new Set());
  }

  async continue(plan: ValidatedGoalPlan, rawGrant: GoalContinuationGrant): Promise<GoalCoordinationState> {
    if (!this.continuationAuthority) throw new Error("Customer-local continuation authority is not configured.");
    authenticateGoalContinuationGrant(rawGrant, this.continuationAuthority);
    let state = this.store.load(plan.tenantId, plan.parentGoalId);
    if (!state) throw new Error("Cannot continue a goal that has no durable coordination state.");
    const prior = state.items[rawGrant.workItemId];
    if (prior?.continuation?.grantId === rawGrant.grantId) {
      if (state.lifecycle === "completed" && state.resume?.completed) return state;
    }
    const revocation = this.continuationRevocations?.get(rawGrant.grantId);
    if (revocation) throw new Error(`Continuation grant was revoked: ${revocation.reason}`);
    if (prior?.continuation?.grantId === rawGrant.grantId) return this.runInternal(plan, new Set([rawGrant.workItemId]));
    const grant = validateGoalContinuationGrant(rawGrant, plan, state, this.continuationAuthority);
    if (this.continuationPreconditions) {
      const live = await this.continuationPreconditions.verify(grant, plan, state);
      if (live.length === 0 || live.some((check) => !check.passed)) {
        throw new Error("Customer-local continuation preconditions no longer pass.");
      }
    }
    const item = state.items[grant.workItemId]!;
    const continuedAt = nowIso();
    const { aggregate: _previousAggregate, resume: _previousResume, ...activeState } = state;
    state = this.saveState({
      ...activeState,
      lifecycle: "active",
      items: {
        ...state.items,
        [grant.workItemId]: {
          ...item,
          lifecycle: "running",
          attempts: item.attempts + 1,
          lastMode: "reconcile",
          continuation: {
            grantId: grant.grantId,
            kind: grant.kind,
            issuedBy: grant.issuedBy,
            authorizedMissing: [...grant.authorizedMissing],
            continuedAt,
          },
          updatedAt: continuedAt,
        },
      },
      updatedAt: continuedAt,
    });
    this.record(plan, "work-item.continuation-authorized", {
      grantId: grant.grantId,
      authorizedMissing: grant.authorizedMissing,
      reconciliationRequired: true,
    }, grant.workItemId);
    return this.runInternal(plan, new Set([grant.workItemId]));
  }

  private async runInternal(plan: ValidatedGoalPlan, continuedItems: ReadonlySet<string>): Promise<GoalCoordinationState> {
    const digest = goalPlanDigest(plan);
    let state = this.store.load(plan.tenantId, plan.parentGoalId);
    if (!state) {
      state = this.store.save(initialState(plan), null);
      this.record(plan, "goal-plan.activated", { planDigest: digest, workItems: plan.workItems.length });
    } else if (state.planDigest !== digest) {
      throw new Error("A different validated plan cannot replace an active parent goal.");
    }

    if (state.lifecycle === "completed" && state.resume?.completed) return state;

    for (const item of plan.workItems) {
      const current = state.items[item.workItemId]!;
      if (["completed", "blocked", "failed", "unknown"].includes(current.lifecycle)) continue;
      const dependencies = item.dependencyWorkItemIds.map((id) => state!.items[id]);
      if (dependencies.some((dependency) => dependency?.lifecycle !== "completed")) continue;

      const continued = continuedItems.has(item.workItemId) && current.continuation !== undefined;
      if (!item.authority.currentlyAuthorized && !continued) {
        const timestamp = nowIso();
        const handoff: HandoffEnvelope = {
          requestId: plan.requestId,
          tenantId: plan.tenantId,
          reason: "authority-missing",
          summary: `Trusted authority is missing: ${item.authority.missing.join(", ")}.`,
          failedChecks: item.authority.missing.map((missing) => ({
            id: `authority:${missing}`,
            passed: false,
            detail: "The required authority comes from customer configuration and cannot be granted by the plan.",
          })),
          createdAt: timestamp,
        };
        state = this.updateItem(state, item.workItemId, {
          ...current,
          lifecycle: "blocked",
          handoff,
          updatedAt: timestamp,
        });
        this.record(plan, "work-item.blocked", { missing: item.authority.missing, writesAttempted: 0 }, item.workItemId);
        continue;
      }

      const mode = current.lifecycle === "running" ? "reconcile" : "execute";
      if (current.lifecycle !== "running") {
        state = this.updateItem(state, item.workItemId, {
          ...current,
          lifecycle: "running",
          attempts: current.attempts + 1,
          lastMode: mode,
          updatedAt: nowIso(),
        });
        this.record(plan, "work-item.running", { operationKey: item.operationKey, mode }, item.workItemId);
      } else if (current.lastMode !== "reconcile") {
        state = this.updateItem(state, item.workItemId, {
          ...current,
          lastMode: "reconcile",
          updatedAt: nowIso(),
        });
        this.record(plan, "work-item.running", { operationKey: item.operationKey, mode }, item.workItemId);
      }

      const effectiveItem = continued
        ? { ...item, authority: { ...item.authority, currentlyAuthorized: true, missing: [] } }
        : item;
      const execution = await this.executor.execute({ plan, item: effectiveItem, mode });
      if (execution.operationKey !== item.operationKey) {
        throw new Error(`Executor returned the wrong operation key for ${item.workItemId}.`);
      }
      if (execution.status === "blocked") {
        if (execution.writesAttempted !== 0) {
          throw new Error(`A blocked work item cannot report external write attempts: ${item.workItemId}.`);
        }
        state = this.updateItem(state, item.workItemId, {
          ...state.items[item.workItemId]!,
          lifecycle: "blocked",
          childRunId: execution.childRunId,
          execution,
          handoff: execution.handoff,
          updatedAt: nowIso(),
        });
        this.record(plan, "work-item.blocked", { writesAttempted: execution.writesAttempted }, item.workItemId);
        continue;
      }
      if (execution.status === "failed" || execution.status === "unknown") {
        state = this.updateItem(state, item.workItemId, {
          ...state.items[item.workItemId]!,
          lifecycle: execution.status,
          childRunId: execution.childRunId,
          execution,
          updatedAt: nowIso(),
        });
        this.record(plan, execution.status === "failed" ? "work-item.failed" : "work-item.unknown", {
          writesAttempted: execution.writesAttempted,
        }, item.workItemId);
        continue;
      }

      const outcome = await this.itemVerifier.verify(plan, effectiveItem, execution);
      const lifecycle: GoalWorkItemLifecycle = outcome.passed && outcome.incorrectSideEffects === 0
        ? "completed"
        : outcome.incorrectSideEffects > 0
          ? "failed"
          : "unknown";
      state = this.updateItem(state, item.workItemId, {
        ...state.items[item.workItemId]!,
        lifecycle,
        childRunId: execution.childRunId,
        execution,
        outcome,
        updatedAt: nowIso(),
      });
      this.record(
        plan,
        lifecycle === "completed" ? "work-item.completed" : lifecycle === "failed" ? "work-item.failed" : "work-item.unknown",
        { outcomePassed: outcome.passed, incorrectSideEffects: outcome.incorrectSideEffects },
        item.workItemId,
      );
    }

    const aggregate = await this.aggregateVerifier.verify(plan, state);
    const actualCounts = Object.values(state.items).reduce(
      (counts, item) => {
        if (item.lifecycle === "completed") counts.completedItems += 1;
        else if (item.lifecycle === "blocked") counts.blockedItems += 1;
        else if (item.lifecycle === "failed") counts.failedItems += 1;
        else counts.unknownItems += 1;
        return counts;
      },
      { completedItems: 0, blockedItems: 0, failedItems: 0, unknownItems: 0 },
    );
    const aggregateValid =
      aggregate.requiredItems === plan.workItems.length &&
      aggregate.completedItems + aggregate.blockedItems + aggregate.failedItems + aggregate.unknownItems === aggregate.requiredItems &&
      aggregate.completedItems === actualCounts.completedItems &&
      aggregate.blockedItems === actualCounts.blockedItems &&
      aggregate.failedItems === actualCounts.failedItems &&
      aggregate.unknownItems === actualCounts.unknownItems &&
      (aggregate.result !== "complete" ||
        (aggregate.passed &&
          aggregate.completedItems === aggregate.requiredItems &&
          aggregate.blockedItems === 0 &&
          aggregate.failedItems === 0 &&
          aggregate.unknownItems === 0 &&
          aggregate.incorrectSideEffects === 0));
    if (!aggregateValid) throw new Error("Aggregate verifier returned an internally inconsistent receipt.");

    state = this.saveState({
      ...state,
      aggregate,
      lifecycle: parentLifecycle(aggregate),
      updatedAt: nowIso(),
    });
    this.record(plan, "goal-outcome.verified", {
      result: aggregate.result,
      passed: aggregate.passed,
      incorrectSideEffects: aggregate.incorrectSideEffects,
    });

    if (aggregate.result === "complete" && aggregate.passed && aggregate.incorrectSideEffects === 0) {
      const resume = await this.resumer.resume(plan, aggregate);
      state = this.saveState({
        ...state,
        resume,
        lifecycle: resume.completed ? "completed" : "unknown",
        updatedAt: nowIso(),
      });
      this.record(plan, "goal.resumed", { completed: resume.completed });
    }
    return state;
  }

  private updateItem(
    state: GoalCoordinationState,
    workItemId: string,
    item: GoalWorkItemState,
  ): GoalCoordinationState {
    return this.saveState({
      ...state,
      items: { ...state.items, [workItemId]: item },
      updatedAt: nowIso(),
    });
  }

  private saveState(state: GoalCoordinationState): GoalCoordinationState {
    return this.store.save(state, state.version);
  }

  private record(
    plan: ValidatedGoalPlan,
    type: GoalCoordinationEvent["type"],
    detail: Record<string, unknown>,
    workItemId?: string,
  ): void {
    this.events?.record({
      tenantId: plan.tenantId,
      parentGoalId: plan.parentGoalId,
      requestId: plan.requestId,
      ...(workItemId ? { workItemId } : {}),
      type,
      detail: redactValue(detail) as Record<string, unknown>,
      occurredAt: nowIso(),
    });
  }
}
