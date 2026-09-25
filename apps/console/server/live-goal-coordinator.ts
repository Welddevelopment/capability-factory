import { join } from "node:path";
import { startBroadGoalCapabilityLayer } from "../../../src/customer-world/broad-goal-capability-layer.js";
import {
  BroadGoalReferenceWorld,
  BROAD_GOAL_REFERENCE_WORLD_VERSION,
  createBroadGoalPlanProposal,
  createBroadGoalTrustedScope,
  type BroadGoalAuthorityScenario,
} from "../../../src/customer-world/broad-goal-reference-world.js";
import {
  BROAD_GOAL_REQUEST_SCHEMA_VERSION,
  BroadGoalCoordinatorSdk,
  FileValidatedGoalPlanStore,
} from "../../../src/product/broad-goal-sdk.js";
import { type GoalPlanner, type ValidatedGoalPlan } from "../../../src/product/goal-coordination.js";
import type { CapabilityEvent } from "../../../src/product/contracts.js";
import {
  FileGoalCoordinationStore,
  GoalScheduler,
  type GoalCoordinationState,
  type GoalWorkItemState,
} from "../../../src/product/goal-scheduler.js";
import type { ConsoleEvent } from "../shared/contracts.js";
import { makeConsoleEvent, stableConsoleId } from "../shared/contracts.js";

export const LIVE_ORDER_OPERATIONS_FIXTURE = "fictional-order-operations-2100-v1";
const TENANT = "local-alpha";

const groupReasons: Record<string, string> = {
  "orders-ready": "Trusted external state already satisfies the same completion criteria.",
  "order-details": "A separate approved order-system change has its own outcome contract.",
  "supplier-north": "The two items share a supplier and system, but remain separately verified operations.",
  "supplier-east": "This supplier route stays isolated so a missing capability can be acquired without widening other work.",
  "supplier-regulated": "Consequential purchasing remains behind its configured action-specific authority boundary.",
  "order-finalization": "The order can finalize only after its stock dependency passes direct verification.",
};

function acquisitionPath(item: GoalWorkItemState): "none" | "existing-ability" | "retained-reuse" | "new-capability" | "authority-handoff" {
  if (item.lifecycle === "blocked") return "authority-handoff";
  if (!item.execution || !("path" in item.execution)) return "none";
  if (item.execution.path === "already-satisfied") return "none";
  if (item.execution.path === "retained-capability") return "retained-reuse";
  if (item.execution.path === "built-capability") return "new-capability";
  return "existing-ability";
}

export interface LiveBroadGoalRunInput {
  runId: string;
  requestId: string;
  ordinaryGoal: string;
  scenario: BroadGoalAuthorityScenario;
  dataDirectory: string;
}

export interface LiveBroadGoalRunResult {
  parentGoalId: string;
  plan: ValidatedGoalPlan;
  state: GoalCoordinationState;
  events: ConsoleEvent[];
}

export async function runLiveBroadGoalReference(input: LiveBroadGoalRunInput): Promise<LiveBroadGoalRunResult> {
  const parentGoalId = stableConsoleId("live-parent-goal-v1", TENANT, input.runId);
  const scope = createBroadGoalTrustedScope(parentGoalId, input.requestId, input.scenario, input.ordinaryGoal);
  const proposal = createBroadGoalPlanProposal();
  const planner: GoalPlanner = { propose: async () => structuredClone(proposal) };
  const runDirectory = join(input.dataDirectory, input.runId);
  const plans = new FileValidatedGoalPlanStore(join(runDirectory, "plans"));
  let capabilityEvents: CapabilityEvent[] = [];
  const sdk = new BroadGoalCoordinatorSdk({
    planner,
    maxPlanningAttempts: 1,
    plans,
    scopes: {
      resolve: async (request) => request.scopeKey === LIVE_ORDER_OPERATIONS_FIXTURE ? scope : undefined,
    },
    runtimes: {
      open: async () => {
        const world = new BroadGoalReferenceWorld(join(runDirectory, "world.sqlite"));
        const capabilityLayer = await startBroadGoalCapabilityLayer(
          world,
          join(input.dataDirectory, "capability-registry"),
        );
        capabilityEvents = capabilityLayer.events;
        return {
          runner: new GoalScheduler(
            new FileGoalCoordinationStore(join(runDirectory, "coordination")),
            capabilityLayer.executor,
            world,
            world,
            world,
          ),
          close: async () => {
            await capabilityLayer.close();
            world.close();
          },
        };
      },
    },
  });
  const result = await sdk.completeGoal({
    schemaVersion: BROAD_GOAL_REQUEST_SCHEMA_VERSION,
    tenantId: TENANT,
    parentGoalId,
    requestId: input.requestId,
    scopeKey: LIVE_ORDER_OPERATIONS_FIXTURE,
    ordinaryGoal: input.ordinaryGoal,
    visibility: "full",
  });
  if (!("state" in result)) throw new Error(`Broad-goal SDK did not start the trusted console run: ${result.status}`);
  const savedPlan = plans.load(TENANT, parentGoalId)?.plan;
  if (!savedPlan) throw new Error("Broad-goal SDK completed without a saved validated plan.");
  const state: GoalCoordinationState = result.state;

  return {
    parentGoalId,
    plan: savedPlan,
    state,
    events: projectLiveEvents(input, scope, proposal.summary, savedPlan, state, capabilityEvents),
  };
}

function projectLiveEvents(
  input: LiveBroadGoalRunInput,
  scope: ReturnType<typeof createBroadGoalTrustedScope>,
  proposalSummary: string,
  plan: ValidatedGoalPlan,
  state: GoalCoordinationState,
  capabilityEvents: CapabilityEvent[],
): ConsoleEvent[] {
  const events: ConsoleEvent[] = [];
  const startedAt = Date.now();
  let sequence = 0;
  const add = (
    runId: string,
    type: ConsoleEvent["type"],
    payload: Record<string, unknown>,
    classification: ConsoleEvent["sensitivity"]["classification"] = "tenant-confidential",
  ) => {
    sequence += 1;
    events.push(makeConsoleEvent({
      eventId: stableConsoleId("live-goal-event-v1", input.runId, runId, type, String(sequence)),
      tenantId: TENANT,
      runId,
      requestId: input.requestId,
      type,
      occurredAt: new Date(startedAt + sequence).toISOString(),
      payload,
      sensitivity: { classification, source: "product-core", sanitized: true },
    }));
  };

  add(input.runId, "goal.received", {
    source: "agent-playground",
    workflow: "Verified broad-goal coordinator · fictional order operations",
    goal: input.ordinaryGoal,
    fixture: LIVE_ORDER_OPERATIONS_FIXTURE,
  });
  add(input.runId, "goal.plan.proposed", {
    parentGoalId: plan.parentGoalId,
    planVersion: plan.planVersion,
    fixture: LIVE_ORDER_OPERATIONS_FIXTURE,
    itemCount: plan.workItems.length,
    summary: proposalSummary,
  });
  add(input.runId, "goal.plan.validated", {
    parentGoalId: plan.parentGoalId,
    planVersion: plan.planVersion,
    passed: true,
    validationReceipt: plan.validationReceiptId,
    checks: [
      "complete trusted coverage",
      "known entities and systems",
      "documented operations and safety companions",
      "acyclic dependencies",
      "trusted dependency preservation",
      "authority derived outside planner",
    ],
    scope: "Fictional orders due by 21:00 today",
    deadline: scope.deadline.description,
    targetAliases: scope.systems.map((system) => system.targetAlias),
    credentialAliases: scope.systems.flatMap((system) => system.credentialAliases),
    authorityState: input.scenario === "complete-authority"
      ? "All fictional write actions approved in trusted policy"
      : "Regulated supplier write requires separate action approval",
  }, "security-sensitive");

  for (const item of plan.workItems) {
    const itemState = state.items[item.workItemId]!;
    const childRunId = itemState.childRunId ?? `child-${item.workItemId}`;
    const childCapabilityEvents = capabilityEvents.filter((event) => event.correlation?.workItemId === item.workItemId);
    const path = acquisitionPath(itemState);
    const initiallySatisfied = itemState.execution?.status === "already-satisfied";
    add(input.runId, "work-item.created", {
      parentGoalId: plan.parentGoalId,
      planVersion: plan.planVersion,
      workItemId: item.workItemId,
      groupId: item.groupKey,
      groupLabel: item.groupLabel,
      groupReason: groupReasons[item.groupKey] ?? "Separately bounded and independently verified work.",
      entityAlias: item.entityAliases[0]!,
      workflowKey: item.workflowKey,
      summary: item.summary,
      dependencies: item.dependencyWorkItemIds,
      executionOrder: item.executionOrder,
      initialStatus: initiallySatisfied ? "already-satisfied" : item.dependencyWorkItemIds.length > 0 ? "waiting" : "ready",
      acquisitionPath: path,
      childRunId,
      required: true,
    });
    if (itemState.attempts > 0 && !initiallySatisfied) {
      add(input.runId, "work-item.started", {
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
      const handoffId = stableConsoleId("live-work-handoff-v1", item.workItemId);
      const missing = item.authority.missing.join(", ");
      add(input.runId, "work-item.blocked", {
        parentGoalId: plan.parentGoalId,
        workItemId: item.workItemId,
        operationId: item.operationKey,
        handoffId,
        reason: itemState.handoff?.reason ?? "authority-missing",
        missing,
        writesAttempted: 0,
        blockedAt: itemState.updatedAt,
      });
      add(childRunId, "authority.checked", {
        passed: false,
        writeAuthority: scope.authority.writeAuthority,
        methods: item.authority.methods,
        parentGoalId: plan.parentGoalId,
        workItemId: item.workItemId,
      }, "security-sensitive");
      add(childRunId, "handoff.created", {
        handoffId,
        reason: itemState.handoff?.reason ?? "authority-missing",
        missing,
        summary: itemState.handoff?.summary ?? "Trusted authority was missing. The work item stopped before execution with zero writes.",
        parentGoalId: plan.parentGoalId,
        workItemId: item.workItemId,
      }, "security-sensitive");
      continue;
    }
    if (itemState.lifecycle !== "completed" || !itemState.outcome || !itemState.execution) continue;

    add(childRunId, "authority.checked", {
      passed: true,
      targetAliases: item.authority.targetAliases,
      credentialAliases: item.authority.credentialAliases,
      methods: item.authority.methods,
      writeAuthority: scope.authority.writeAuthority,
      parentGoalId: plan.parentGoalId,
      workItemId: item.workItemId,
    }, "security-sensitive");
    if (childCapabilityEvents.length > 0) {
      const acquisitionRequested = childCapabilityEvents.find((event) => event.type === "acquisition.requested");
      const builtCapability = childCapabilityEvents.find((event) => event.type === "capability.built");
      const discoveredCapability = childCapabilityEvents.find((event) => event.type === "capability.discovered");
      if (acquisitionRequested) {
        add(childRunId, "diagnosis.completed", {
          result: "missing-capability",
          needKey: acquisitionRequested.detail.needKey,
          summary: "The trusted plan required an ability that was not configured for this work item.",
          parentGoalId: plan.parentGoalId,
          workItemId: item.workItemId,
        });
      }
      if (builtCapability || discoveredCapability) {
        add(childRunId, "search.retained.completed", {
          result: "no-active-match",
          candidates: 0,
          parentGoalId: plan.parentGoalId,
          workItemId: item.workItemId,
        });
      }
      if (builtCapability) {
        add(childRunId, "search.trusted.completed", {
          result: "no-verified-match",
          candidates: 0,
          parentGoalId: plan.parentGoalId,
          workItemId: item.workItemId,
        });
      }
      for (const capabilityEvent of childCapabilityEvents) {
        const capabilityId = typeof capabilityEvent.detail.capabilityId === "string"
          ? capabilityEvent.detail.capabilityId
          : "capability-unavailable";
        if (capabilityEvent.type === "capability.reused") {
          add(childRunId, "search.retained.completed", {
            result: "verified-match",
            candidates: 1,
            capabilityId,
            parentGoalId: plan.parentGoalId,
            workItemId: item.workItemId,
          });
        } else if (capabilityEvent.type === "capability.discovered") {
          add(childRunId, "search.trusted.completed", {
            result: "verified-match",
            candidates: 1,
            capabilityId,
            parentGoalId: plan.parentGoalId,
            workItemId: item.workItemId,
          });
        } else if (capabilityEvent.type === "capability.built") {
          add(childRunId, "build.completed", {
            result: "candidate-created",
            format: "constrained declarative HTTP manifest",
            attempts: 1,
            capabilityId,
            parentGoalId: plan.parentGoalId,
            workItemId: item.workItemId,
          });
        } else if (capabilityEvent.type === "capability.verified") {
          add(childRunId, "capability.verification.completed", {
            passed: true,
            verifier: "disposable allowlisted HTTP probe",
            capabilityId,
            checks: ["required actions", "runtime policy", "test-mode write", "probe state preserved"],
            parentGoalId: plan.parentGoalId,
            workItemId: item.workItemId,
          });
        } else if (capabilityEvent.type === "capability.executed") {
          add(childRunId, "execution.completed", {
            capabilityId,
            receipt: stableConsoleId("live-execution-receipt-v1", item.workItemId, item.operationKey),
            actionsCompleted: Number(capabilityEvent.detail.actionCount ?? 0),
            executionPath: path,
            parentGoalId: plan.parentGoalId,
            workItemId: item.workItemId,
          });
        } else if (capabilityEvent.type === "outcome.verified") {
          add(childRunId, "outcome.verification.completed", {
            passed: capabilityEvent.detail.passed === true,
            verifier: "direct fictional external-state verifier",
            intendedWrites: itemState.outcome.intendedWrites,
            incorrectSideEffects: Number(capabilityEvent.detail.incorrectSideEffects ?? 0),
            checks: itemState.outcome.checks.map((check) => check.id),
            parentGoalId: plan.parentGoalId,
            workItemId: item.workItemId,
          });
        } else if (capabilityEvent.type === "execution.reconciled") {
          add(childRunId, "execution.reconciled", {
            capabilityId,
            resumedFromVerifiedState: capabilityEvent.detail.resumedFromVerifiedState === true,
            parentGoalId: plan.parentGoalId,
            workItemId: item.workItemId,
          });
        } else if (capabilityEvent.type === "capability.quarantined") {
          add(childRunId, "capability.quarantined", {
            capabilityId,
            reason: String(capabilityEvent.detail.reason ?? "outcome-not-clean"),
            parentGoalId: plan.parentGoalId,
            workItemId: item.workItemId,
          }, "security-sensitive");
        } else if (capabilityEvent.type === "goal.resumed") {
          add(childRunId, "resumption.completed", {
            completed: capabilityEvent.detail.completed === true,
            summary: "The coordinator resumed the work item after Capability Factory verified its external outcome.",
            parentGoalId: plan.parentGoalId,
            workItemId: item.workItemId,
          });
        }
      }
    } else if (itemState.execution.status !== "already-satisfied") {
      add(childRunId, "execution.completed", {
        capabilityId: "customer-existing-ability",
        receipt: stableConsoleId("live-execution-receipt-v1", item.workItemId, item.operationKey),
        actionsCompleted: itemState.execution.writesAttempted,
        executionPath: path,
        parentGoalId: plan.parentGoalId,
        workItemId: item.workItemId,
      });
    }
    if (childCapabilityEvents.length === 0) {
      add(childRunId, "outcome.verification.completed", {
        passed: itemState.outcome.passed,
        verifier: `${BROAD_GOAL_REFERENCE_WORLD_VERSION}:item-verifier`,
        intendedWrites: itemState.outcome.intendedWrites,
        incorrectSideEffects: itemState.outcome.incorrectSideEffects,
        checks: itemState.outcome.checks.map((check) => check.id),
        parentGoalId: plan.parentGoalId,
        workItemId: item.workItemId,
      });
      add(childRunId, "resumption.completed", {
        completed: true,
        summary: "The coordinator accepted the independently verified item outcome and continued the broad plan.",
        parentGoalId: plan.parentGoalId,
        workItemId: item.workItemId,
      });
    }
    add(childRunId, "run.completed", { outcome: "completed", parentGoalId: plan.parentGoalId, workItemId: item.workItemId });
    add(input.runId, "work-item.completed", {
      parentGoalId: plan.parentGoalId,
      workItemId: item.workItemId,
      operationId: item.operationKey,
      outcomeReceipt: stableConsoleId("live-item-outcome-v1", item.workItemId, itemState.outcome.stateDigest),
      passed: itemState.outcome.passed,
      intendedWrites: itemState.outcome.intendedWrites,
      incorrectSideEffects: itemState.outcome.incorrectSideEffects,
      completedAt: itemState.updatedAt,
    });
  }

  const aggregate = state.aggregate!;
  const alreadySatisfiedItems = Object.values(state.items).filter((item) => item.execution?.status === "already-satisfied").length;
  const summary = aggregate.result === "complete"
    ? "All required work items and the aggregate external-state contract passed independent verification."
    : aggregate.result === "partially-complete"
      ? `${aggregate.completedItems} required work items passed; ${aggregate.blockedItems} remains stopped at a trusted authority boundary.`
      : "The independently inspected external result is not complete.";
  add(input.runId, "goal.outcome.verified", {
    parentGoalId: plan.parentGoalId,
    planVersion: plan.planVersion,
    aggregateReceipt: aggregate.receiptId,
    result: aggregate.result,
    passed: aggregate.passed,
    requiredItems: aggregate.requiredItems,
    completedItems: aggregate.completedItems,
    alreadySatisfiedItems,
    blockedItems: aggregate.blockedItems,
    failedItems: aggregate.failedItems,
    unknownItems: aggregate.unknownItems,
    incorrectSideEffects: aggregate.incorrectSideEffects,
    verifiedAt: aggregate.verifiedAt,
    summary,
  });
  if (state.resume?.completed) {
    add(input.runId, "outcome.verification.completed", {
      passed: true,
      verifier: aggregate.verifierVersion,
      intendedWrites: Object.values(state.items).reduce((total, item) => total + (item.outcome?.intendedWrites ?? 0), 0),
      incorrectSideEffects: aggregate.incorrectSideEffects,
      checks: aggregate.checks.map((check) => check.id),
    });
    add(input.runId, "resumption.completed", { completed: true, summary: state.resume.summary });
    add(input.runId, "run.completed", { outcome: "completed" });
  } else {
    const blocked = Object.values(state.items).find((item) => item.lifecycle === "blocked");
    add(input.runId, "handoff.created", {
      handoffId: stableConsoleId("live-parent-handoff-v1", plan.parentGoalId),
      reason: blocked?.handoff?.reason ?? aggregate.result,
      missing: blocked?.handoff?.summary ?? "A required external outcome is not complete.",
      summary: "Verified independent work was preserved, but the parent goal did not claim completion.",
      parentGoalId: plan.parentGoalId,
    }, "security-sensitive");
  }
  return events;
}
