import type { ConsoleEvent, RunSource } from "../shared/contracts.js";

export type RunStatus = "running" | "completed" | "handoff" | "failed";
export interface RunProjection {
  runId: string;
  requestId: string;
  source: RunSource;
  recorded: boolean;
  goal: string;
  workflow: string;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  capabilityId?: string;
  capabilitySource?: string;
  eventCount: number;
  events: ConsoleEvent[];
}

export type WorkItemStatus = "already-satisfied" | "ready" | "active" | "waiting" | "completed" | "blocked" | "failed";
export interface GoalPlanWorkItem {
  workItemId: string; groupId: string; groupLabel: string; groupReason: string; entityAlias: string;
  workflowKey: string; summary: string; dependencies: string[]; executionOrder: number;
  status: WorkItemStatus; acquisitionPath: string; childRunId: string; required: boolean;
  operationId?: string; outcomeReceipt?: string; handoffId?: string; blockedReason?: string; missing?: string;
}
export interface GoalPlanProjection {
  parentGoalId: string; planVersion: number; fixture: string; lifecycle: "proposed" | "validated" | "active" | "completed" | "partially-completed" | "blocked";
  validation: { passed: boolean; receipt: string; checks: string[]; checkCount: number };
  scope: { description: string; deadline: string; targetAliases: string[]; credentialAliases: string[]; authorityState: string };
  groups: Array<{ groupId: string; label: string; reason: string; items: GoalPlanWorkItem[] }>;
  rollup?: { receipt: string; result: string; passed: boolean; requiredItems: number; completedItems: number; alreadySatisfiedItems: number; blockedItems: number; failedItems: number; unknownItems: number; incorrectSideEffects: number; summary: string };
}

function text(payload: ConsoleEvent["payload"], key: string, fallback = "") {
  const value = payload[key];
  return typeof value === "string" ? value : fallback;
}

export function projectRuns(events: ConsoleEvent[]): RunProjection[] {
  const grouped = new Map<string, ConsoleEvent[]>();
  for (const event of events) grouped.set(event.runId, [...(grouped.get(event.runId) ?? []), event]);
  return [...grouped.values()].map((runEvents) => {
    const first = runEvents[0]!;
    const goal = runEvents.find((event) => event.type === "goal.received");
    const completionClaim = runEvents.findLast((event) => event.type === "run.completed");
    const outcome = runEvents.findLast((event) => event.type === "outcome.verification.completed");
    const resumption = runEvents.findLast((event) => event.type === "resumption.completed");
    const completion = completionClaim && outcome?.payload.passed === true &&
      outcome.payload.incorrectSideEffects === 0 && resumption?.payload.completed === true;
    const handoff = runEvents.findLast((event) => event.type === "handoff.created");
    const handoffLifecycle = handoff
      ? runEvents.findLast((event) => event.type === "handoff.lifecycle.changed" && text(event.payload, "handoffId") === text(handoff.payload, "handoffId"))
      : undefined;
    const handoffOpen = handoff && text(handoffLifecycle?.payload ?? {}, "lifecycle", "open") !== "resolved";
    const failed = runEvents.findLast((event) => event.type === "execution.failed");
    const retained = runEvents.findLast((event) => event.type === "capability.retained");
    const source = (text(goal?.payload ?? {}, "source", "recorded-run")) as RunSource;
    const status: RunStatus = completion ? "completed" : handoffOpen ? "handoff" : failed ? "failed" : "running";
    return {
      runId: first.runId,
      requestId: first.requestId,
      source,
      recorded: source === "recorded-run",
      goal: text(goal?.payload ?? {}, "goal", "Approved goal summary unavailable"),
      workflow: text(goal?.payload ?? {}, "workflow", "Unspecified workflow"),
      status,
      startedAt: first.occurredAt,
      updatedAt: runEvents.at(-1)!.occurredAt,
      ...(retained ? { capabilityId: text(retained.payload, "capabilityId"), capabilitySource: text(retained.payload, "origin") } : {}),
      eventCount: runEvents.length,
      events: runEvents,
    };
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function projectHandoffs(events: ConsoleEvent[]) {
  return events.filter((event) => event.type === "handoff.created").map((event) => {
    const changes = events.filter((candidate) => candidate.runId === event.runId && candidate.type === "handoff.lifecycle.changed");
    return {
      handoffId: text(event.payload, "handoffId"), runId: event.runId,
      reason: text(event.payload, "reason"), summary: text(event.payload, "summary"),
      lifecycle: text(changes.at(-1)?.payload ?? {}, "lifecycle", "open"), occurredAt: event.occurredAt,
      missing: text(event.payload, "missing"), continuationRunId: text(changes.at(-1)?.payload ?? {}, "continuationRunId"),
      workItemId: text(event.payload, "workItemId"), parentGoalId: text(event.payload, "parentGoalId"),
      expectedStateVersion: typeof event.payload.expectedStateVersion === "number" ? event.payload.expectedStateVersion : undefined,
    };
  });
}

export function projectCapabilities(events: ConsoleEvent[]) {
  const capabilities = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    const id = text(event.payload, "capabilityId");
    if (!id) continue;
    const prior = capabilities.get(id) ?? { capabilityId: id, status: "active", runs: [] as string[] };
    if (event.type === "capability.retained") Object.assign(prior, {
      status: "active", origin: text(event.payload, "origin"), documentationHash: text(event.payload, "documentationHash"),
      actions: event.payload.actions ?? [], verifiedAt: text(event.payload, "verifiedAt"),
    });
    if (event.type === "capability.quarantined") prior.status = "quarantined";
    if (event.type === "capability.revoked") prior.status = "revoked";
    if (["capability.retained", "execution.completed"].includes(event.type)) {
      prior.runs = [...new Set([...(prior.runs as string[]), event.runId])];
    }
    capabilities.set(id, prior);
  }
  return [...capabilities.values()];
}

function strings(payload: ConsoleEvent["payload"], key: string) {
  const value = payload[key]; return Array.isArray(value) ? value : [];
}

export function projectGoalPlan(events: ConsoleEvent[], parentRunId: string): GoalPlanProjection | undefined {
  const proposed = events.find((event) => event.runId === parentRunId && event.type === "goal.plan.proposed");
  if (!proposed) return undefined;
  const parentGoalId = text(proposed.payload, "parentGoalId");
  const validated = events.find((event) => event.runId === parentRunId && event.type === "goal.plan.validated" && text(event.payload, "parentGoalId") === parentGoalId);
  if (!validated) return undefined;
  const created = events.filter((event) => event.runId === parentRunId && event.type === "work-item.created" && text(event.payload, "parentGoalId") === parentGoalId);
  const items = created.map((event): GoalPlanWorkItem => {
    const workItemId = text(event.payload, "workItemId");
    const started = events.findLast((candidate) => candidate.runId === parentRunId && candidate.type === "work-item.started" && text(candidate.payload, "workItemId") === workItemId);
    const completed = events.findLast((candidate) => candidate.runId === parentRunId && candidate.type === "work-item.completed" && text(candidate.payload, "workItemId") === workItemId);
    const blocked = events.findLast((candidate) => candidate.runId === parentRunId && candidate.type === "work-item.blocked" && text(candidate.payload, "workItemId") === workItemId);
    const initial = text(event.payload, "initialStatus") as WorkItemStatus;
    const blockedIndex = blocked ? events.lastIndexOf(blocked) : -1;
    const completedIndex = completed ? events.lastIndexOf(completed) : -1;
    const status: WorkItemStatus = completedIndex > blockedIndex
      ? (initial === "already-satisfied" ? "already-satisfied" : "completed")
      : blocked
        ? "blocked"
        : started
          ? "active"
          : initial;
    return {
      workItemId, groupId: text(event.payload, "groupId"), groupLabel: text(event.payload, "groupLabel"), groupReason: text(event.payload, "groupReason"),
      entityAlias: text(event.payload, "entityAlias"), workflowKey: text(event.payload, "workflowKey"), summary: text(event.payload, "summary"),
      dependencies: strings(event.payload, "dependencies"), executionOrder: Number(event.payload.executionOrder ?? 0), status,
      acquisitionPath: text(event.payload, "acquisitionPath"), childRunId: text(event.payload, "childRunId"), required: event.payload.required === true,
      ...(started ? { operationId: text(started.payload, "operationId") } : {}),
      ...(completed ? { outcomeReceipt: text(completed.payload, "outcomeReceipt") } : {}),
      ...(blockedIndex > completedIndex ? { handoffId: text(blocked!.payload, "handoffId"), blockedReason: text(blocked!.payload, "reason"), missing: text(blocked!.payload, "missing") } : {}),
    };
  }).sort((a, b) => a.executionOrder - b.executionOrder);
  const grouped = new Map<string, GoalPlanProjection["groups"][number]>();
  for (const item of items) {
    const group = grouped.get(item.groupId) ?? { groupId: item.groupId, label: item.groupLabel, reason: item.groupReason, items: [] };
    group.items.push(item); grouped.set(item.groupId, group);
  }
  const aggregate = events.findLast((event) => event.runId === parentRunId && event.type === "goal.outcome.verified" && text(event.payload, "parentGoalId") === parentGoalId);
  const result = aggregate ? text(aggregate.payload, "result") : "";
  const lifecycle: GoalPlanProjection["lifecycle"] = aggregate ? result === "complete" ? "completed" : result === "partially-complete" ? "partially-completed" : "blocked" : items.some((item) => item.status === "active") ? "active" : "validated";
  return {
    parentGoalId, planVersion: Number(validated.payload.planVersion ?? 1), fixture: text(proposed.payload, "fixture"), lifecycle,
    validation: { passed: validated.payload.passed === true, receipt: text(validated.payload, "validationReceipt"), checks: strings(validated.payload, "checks"), checkCount: Number(validated.payload.checkCount ?? strings(validated.payload, "checks").length) },
    scope: { description: text(validated.payload, "scope"), deadline: text(validated.payload, "deadline"), targetAliases: strings(validated.payload, "targetAliases"), credentialAliases: strings(validated.payload, "credentialAliases"), authorityState: text(validated.payload, "authorityState") },
    groups: [...grouped.values()],
    ...(aggregate ? { rollup: { receipt: text(aggregate.payload, "aggregateReceipt"), result, passed: aggregate.payload.passed === true, requiredItems: Number(aggregate.payload.requiredItems ?? 0), completedItems: Number(aggregate.payload.completedItems ?? 0), alreadySatisfiedItems: Number(aggregate.payload.alreadySatisfiedItems ?? 0), blockedItems: Number(aggregate.payload.blockedItems ?? 0), failedItems: Number(aggregate.payload.failedItems ?? 0), unknownItems: Number(aggregate.payload.unknownItems ?? 0), incorrectSideEffects: Number(aggregate.payload.incorrectSideEffects ?? 0), summary: text(aggregate.payload, "summary") } } : {}),
  };
}
