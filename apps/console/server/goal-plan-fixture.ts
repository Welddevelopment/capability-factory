import type { ConsoleEvent } from "../shared/contracts.js";
import { makeConsoleEvent, stableConsoleId } from "../shared/contracts.js";

const TENANT = "local-alpha";
export const ORDER_OPERATIONS_FIXTURE = "fictional-order-operations-2100-v1";

type PlanScenario = "partial-authority" | "complete-authority";
type AcquisitionPath = "none" | "existing-ability" | "retained-reuse" | "new-capability" | "authority-handoff";
interface FixtureWorkItem {
  key: string; groupId: string; groupLabel: string; groupReason: string; entityAlias: string;
  workflowKey: string; summary: string; dependencies: string[]; order: number;
  initialStatus: "already-satisfied" | "ready" | "waiting"; acquisitionPath: AcquisitionPath;
}

const workItems: FixtureWorkItem[] = [
  { key: "order-1042-ready", groupId: "orders-ready", groupLabel: "No action required", groupReason: "Trusted state already satisfies the same completion criteria.", entityAlias: "order_1042", workflowKey: "inspect-order-readiness", summary: "Order 1042 already has complete dispatch details and sufficient stock.", dependencies: [], order: 1, initialStatus: "already-satisfied", acquisitionPath: "none" },
  { key: "order-1048-details", groupId: "order-details", groupLabel: "Complete order details", groupReason: "Uses the same approved order system and existing configured ability.", entityAlias: "order_1048", workflowKey: "complete-order-details", summary: "Complete the missing delivery reference for order 1048.", dependencies: [], order: 2, initialStatus: "ready", acquisitionPath: "existing-ability" },
  { key: "north-coolant", groupId: "supplier-north", groupLabel: "North Supply restock", groupReason: "Same supplier, target system, retained capability, and independent inventory records.", entityAlias: "sku_coolant_pack", workflowKey: "restock-north-supply", summary: "Restock coolant packs required by orders due before 21:00.", dependencies: [], order: 3, initialStatus: "ready", acquisitionPath: "retained-reuse" },
  { key: "north-labels", groupId: "supplier-north", groupLabel: "North Supply restock", groupReason: "Same supplier, target system, retained capability, and independent inventory records.", entityAlias: "sku_cold_chain_labels", workflowKey: "restock-north-supply", summary: "Restock cold-chain labels required by orders due before 21:00.", dependencies: [], order: 4, initialStatus: "ready", acquisitionPath: "retained-reuse" },
  { key: "east-crates", groupId: "supplier-east", groupLabel: "East Industrial restock", groupReason: "One unsupported supplier API requires one minimum verified capability.", entityAlias: "sku_insulated_crate", workflowKey: "restock-east-industrial", summary: "Restock insulated crates through the documented East Industrial API.", dependencies: [], order: 5, initialStatus: "ready", acquisitionPath: "new-capability" },
  { key: "regulated-sensors", groupId: "supplier-regulated", groupLabel: "Regulated supplier restock", groupReason: "Consequential purchase requires separate customer approval under the selected authority policy.", entityAlias: "sku_calibrated_sensor", workflowKey: "restock-regulated-supplier", summary: "Place the required calibrated-sensor restock order only with explicit approval.", dependencies: [], order: 6, initialStatus: "ready", acquisitionPath: "authority-handoff" },
  { key: "order-1051-rollup", groupId: "order-finalization", groupLabel: "Finalize dependent order", groupReason: "This order can finalize only after its independent stock requirement is externally verified.", entityAlias: "order_1051", workflowKey: "finalize-order-readiness", summary: "Finalize order 1051 after the insulated-crate restock outcome is verified.", dependencies: ["east-crates"], order: 7, initialStatus: "waiting", acquisitionPath: "existing-ability" },
];

function event(parentRunId: string, requestId: string, type: ConsoleEvent["type"], sequence: number, payload: Record<string, unknown>, runId = parentRunId): ConsoleEvent {
  return makeConsoleEvent({
    eventId: stableConsoleId("order-plan-event-v1", parentRunId, runId, type, String(sequence), String(payload.workItemId ?? "parent")),
    tenantId: TENANT, runId, requestId, type,
    occurredAt: new Date(Date.UTC(2026, 6, 27, 12, 0, 0, sequence * 20)).toISOString(), payload,
    sensitivity: { classification: "tenant-confidential", source: "console-adapter", sanitized: true },
  });
}

export function createOrderOperationsGoalPlan(parentRunId: string, requestId: string, ordinaryGoal: string, scenario: PlanScenario) {
  const parentGoalId = stableConsoleId("parent-goal-v1", TENANT, parentRunId);
  const workIds = new Map(workItems.map((item) => [item.key, stableConsoleId("work-item-v1", parentGoalId, item.key)]));
  const events: ConsoleEvent[] = [];
  let sequence = 1;
  events.push(event(parentRunId, requestId, "goal.received", sequence++, { source: "agent-playground", workflow: "Reference coordinator · fictional order operations", goal: ordinaryGoal, fixture: ORDER_OPERATIONS_FIXTURE }));
  events.push(event(parentRunId, requestId, "goal.plan.proposed", sequence++, { parentGoalId, planVersion: 1, fixture: ORDER_OPERATIONS_FIXTURE, itemCount: workItems.length, summary: "The constrained reference coordinator proposed smaller order-detail, restock, and finalization jobs from the trusted fictional fixture." }));
  events.push(event(parentRunId, requestId, "goal.plan.validated", sequence++, { parentGoalId, planVersion: 1, passed: true, validationReceipt: stableConsoleId("plan-validation-v1", parentGoalId), checks: ["fixture entities exist", "operations documented", "dependencies acyclic", "deadline bounded", "authority cannot expand", "completion criteria present"], scope: "Fictional orders due by 21:00 today", deadline: "21:00 local fixture time", targetAliases: ["fictional_orders", "supplier_north", "supplier_east", "supplier_regulated"], credentialAliases: ["orders_key", "north_supplier_key", "east_supplier_key", "regulated_supplier_key"], authorityState: scenario === "complete-authority" ? "All fixture actions preauthorized" : "Regulated supplier write requires per-action approval" }));

  for (const item of workItems) {
    const workItemId = workIds.get(item.key)!;
    const childRunId = `cf-${workItemId}`;
    events.push(event(parentRunId, requestId, "work-item.created", sequence++, { parentGoalId, planVersion: 1, workItemId, groupId: item.groupId, groupLabel: item.groupLabel, groupReason: item.groupReason, entityAlias: item.entityAlias, workflowKey: item.workflowKey, summary: item.summary, dependencies: item.dependencies.map((key) => workIds.get(key)!), executionOrder: item.order, initialStatus: item.initialStatus, acquisitionPath: item.acquisitionPath, childRunId, required: true }));
    const operationId = stableConsoleId("operation-v1", workItemId);
    if (item.initialStatus !== "already-satisfied") events.push(event(parentRunId, requestId, "work-item.started", sequence++, { parentGoalId, workItemId, operationId, idempotencyKey: `op_${operationId.replaceAll("-", "")}`, startedAt: new Date(Date.UTC(2026, 6, 27, 12, 0, 0, sequence * 20)).toISOString() }));

    const isBlocked = item.key === "regulated-sensors" && scenario === "partial-authority";
    if (isBlocked) {
      const handoffId = stableConsoleId("handoff-v1", workItemId, "approval");
      events.push(event(parentRunId, requestId, "work-item.blocked", sequence++, { parentGoalId, workItemId, operationId, handoffId, reason: "approval", missing: "Per-action approval to create the regulated supplier purchase", writesAttempted: 0, blockedAt: new Date(Date.UTC(2026, 6, 27, 12, 0, 0, sequence * 20)).toISOString() }));
      events.push(event(parentRunId, requestId, "goal.received", sequence++, { source: "agent-playground", workflow: item.workflowKey, goal: item.summary, parentGoalId, workItemId }, childRunId));
      events.push(event(parentRunId, requestId, "authority.checked", sequence++, { passed: false, writeAuthority: "per-action-approval", methods: ["GET"], parentGoalId, workItemId }, childRunId));
      events.push(event(parentRunId, requestId, "handoff.created", sequence++, { handoffId, reason: "approval", missing: "Approval for regulated supplier purchase", summary: "Stopped before execution. The blocked context was sent through the Capability Factory SDK contract; zero writes were attempted.", parentGoalId, workItemId }, childRunId));
      continue;
    }

    const receipt = stableConsoleId("item-outcome-v1", workItemId);
    events.push(event(parentRunId, requestId, "work-item.completed", sequence++, { parentGoalId, workItemId, operationId, outcomeReceipt: receipt, passed: true, intendedWrites: item.initialStatus === "already-satisfied" ? 0 : 1, incorrectSideEffects: 0, completedAt: new Date(Date.UTC(2026, 6, 27, 12, 0, 0, sequence * 20)).toISOString() }));
    const childEvents = childCapabilityEvents(parentRunId, requestId, parentGoalId, workItemId, childRunId, item, sequence);
    events.push(...childEvents);
    sequence += childEvents.length;
  }

  const blocked = scenario === "partial-authority" ? 1 : 0;
  const aggregateResult = blocked ? "partially-complete" : "complete";
  events.push(event(parentRunId, requestId, "goal.outcome.verified", sequence++, { parentGoalId, planVersion: 1, aggregateReceipt: stableConsoleId("aggregate-outcome-v1", parentGoalId, scenario), result: aggregateResult, passed: blocked === 0, requiredItems: workItems.length, completedItems: workItems.length - blocked, alreadySatisfiedItems: 1, blockedItems: blocked, failedItems: 0, unknownItems: 0, incorrectSideEffects: 0, verifiedAt: new Date(Date.UTC(2026, 6, 27, 12, 0, 0, sequence * 20)).toISOString(), summary: blocked ? "Six required work items are independently satisfied; one regulated supplier purchase remains blocked on explicit approval. The overall goal is not complete." : "All required work items and the aggregate external-state contract are independently verified. The broad fictional goal is complete." }));
  if (!blocked) {
    events.push(event(parentRunId, requestId, "outcome.verification.completed", sequence++, { passed: true, verifier: "aggregate fictional order-state verifier", intendedWrites: 6, incorrectSideEffects: 0, checks: ["all required items satisfied", "no blocked or unknown items", "no duplicate supplier orders"] }));
    events.push(event(parentRunId, requestId, "resumption.completed", sequence++, { completed: true, summary: "The simulated customer agent received the verified aggregate result." }));
    events.push(event(parentRunId, requestId, "run.completed", sequence++, { outcome: "completed" }));
  } else {
    events.push(event(parentRunId, requestId, "handoff.created", sequence++, { handoffId: stableConsoleId("parent-handoff-v1", parentGoalId), reason: "approval", missing: "Approval for one regulated supplier purchase", summary: "Independent work completed safely. The parent goal remains partially complete until the required approval is supplied.", parentGoalId }));
  }
  return { parentGoalId, events, workItemIds: Object.fromEntries(workIds) };
}

function childCapabilityEvents(parentRunId: string, requestId: string, parentGoalId: string, workItemId: string, childRunId: string, item: FixtureWorkItem, start: number) {
  let sequence = start;
  const payloadBase = { parentGoalId, workItemId };
  const output = [event(parentRunId, requestId, "goal.received", sequence++, { source: "agent-playground", workflow: item.workflowKey, goal: item.summary, ...payloadBase }, childRunId)];
  if (item.initialStatus === "already-satisfied") {
    output.push(event(parentRunId, requestId, "diagnosis.completed", sequence++, { decision: "goal-complete", summary: "Trusted external state already satisfies this work item.", ...payloadBase }, childRunId));
  } else if (item.acquisitionPath === "new-capability") {
    output.push(event(parentRunId, requestId, "diagnosis.completed", sequence++, { decision: "acquire-capability", summary: "The documented East Industrial operations are not exposed by a configured ability.", ...payloadBase }, childRunId));
    output.push(event(parentRunId, requestId, "search.retained.completed", sequence++, { result: "not-found", candidates: 0, ...payloadBase }, childRunId));
    output.push(event(parentRunId, requestId, "search.trusted.completed", sequence++, { result: "unsupported-residual", candidates: 0, ...payloadBase }, childRunId));
    output.push(event(parentRunId, requestId, "build.completed", sequence++, { result: "deterministic-reference-candidate", format: "constrained declarative HTTP manifest", attempts: 1, ...payloadBase }, childRunId));
    output.push(event(parentRunId, requestId, "authority.checked", sequence++, { passed: true, targetAliases: ["supplier_east"], credentialAliases: ["east_supplier_key"], methods: ["GET", "POST"], writeAuthority: "preauthorized", ...payloadBase }, childRunId));
    output.push(event(parentRunId, requestId, "capability.verification.completed", sequence++, { passed: true, verifier: "deterministic supplier fixture probe", checks: ["minimum actions", "authority", "idempotency reconciliation"], ...payloadBase }, childRunId));
  } else {
    output.push(event(parentRunId, requestId, "diagnosis.completed", sequence++, { decision: item.acquisitionPath === "retained-reuse" ? "reuse-capability" : "continue-current", summary: item.acquisitionPath === "retained-reuse" ? "A verified retained supplier capability matches the work item and documentation version." : "The customer agent already exposes the required approved ability.", ...payloadBase }, childRunId));
    if (item.acquisitionPath === "retained-reuse") output.push(event(parentRunId, requestId, "search.retained.completed", sequence++, { result: "verified-match", candidates: 1, ...payloadBase }, childRunId));
    output.push(event(parentRunId, requestId, "authority.checked", sequence++, { passed: true, targetAliases: [item.groupId], credentialAliases: ["configured_alias"], methods: ["GET", "POST"], writeAuthority: "preauthorized", ...payloadBase }, childRunId));
  }
  output.push(event(parentRunId, requestId, "execution.completed", sequence++, { capabilityId: item.acquisitionPath === "new-capability" ? "east-supplier-reference-capability" : item.acquisitionPath === "retained-reuse" ? "north-supplier-retained-capability" : "customer-existing-ability", receipt: stableConsoleId("execution-receipt-v1", workItemId), actionsCompleted: item.initialStatus === "already-satisfied" ? 0 : 1, ...payloadBase }, childRunId));
  output.push(event(parentRunId, requestId, "outcome.verification.completed", sequence++, { passed: true, verifier: "direct fictional external-state verifier", intendedWrites: item.initialStatus === "already-satisfied" ? 0 : 1, incorrectSideEffects: 0, checks: ["required item state", "no duplicate operation"], ...payloadBase }, childRunId));
  output.push(event(parentRunId, requestId, "resumption.completed", sequence++, { completed: true, summary: "The simulated customer agent resumed this work item.", ...payloadBase }, childRunId));
  if (item.acquisitionPath === "new-capability") output.push(event(parentRunId, requestId, "capability.retained", sequence++, { capabilityId: "east-supplier-reference-capability", origin: "built", documentationHash: "sha256:east-supplier-fixture-v1", actions: ["read_stock", "find_order", "create_order"], verifiedAt: new Date(Date.UTC(2026, 6, 27, 12, 0, 0, sequence * 20)).toISOString(), ...payloadBase }, childRunId));
  output.push(event(parentRunId, requestId, "run.completed", sequence++, { outcome: "completed", ...payloadBase }, childRunId));
  return output;
}
