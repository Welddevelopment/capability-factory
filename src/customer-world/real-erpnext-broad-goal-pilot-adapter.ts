import path from "node:path";
import type { CapabilityManifest } from "../manifest.js";
import { CapabilityRuntime, type RuntimeOperationGuard } from "../runtime.js";
import type { GoalContinuationGrantVerifier } from "../product/continuation.js";
import type { ActionReceipt, CapabilityRequest, OutcomeReceipt } from "../product/contracts.js";
import {
  CapabilityCoordinator,
  manifestDigest,
  type CapabilityBuilder,
  type CapabilityVerifier,
  type RepairableCapabilityBuilder,
  type RuntimeResolver,
} from "../product/coordinator.js";
import {
  GOAL_COORDINATION_SCHEMA_VERSION,
  type GoalPlanProposal,
  type GoalPlanner,
  type TrustedGoalScope,
  type ValidatedGoalPlan,
  type ValidatedGoalWorkItem,
} from "../product/goal-coordination.js";
import {
  FileGoalCoordinationStore,
  GoalScheduler,
  type GoalAggregateOutcomeReceipt,
  type GoalCoordinationState,
  type GoalWorkItemExecutionInput,
  type GoalWorkItemExecutionResult,
  type GoalWorkItemExecutor,
  type GoalWorkItemOutcomeVerifier,
} from "../product/goal-scheduler.js";
import {
  FileValidatedGoalPlanStore,
} from "../product/broad-goal-sdk.js";
import {
  PILOT_ADAPTER_SCHEMA_VERSION,
  REQUIRED_PILOT_ADAPTER_CASES,
  createControlledPilotSdk,
  type ControlledPilotAdapter,
  type PilotAdapterCheck,
} from "../product/pilot-adapter.js";
import { createRealErpNextPilotAcceptanceHarness } from "./real-erpnext-pilot-acceptance.js";
import { CURRENT_CAPABILITY_MODE } from "../product/pilot-readiness.js";
import { CapabilityFactorySdk, type CapabilityWorkflow } from "../product/sdk.js";
import { FileTenantCapabilityStore } from "../product/store.js";
import {
  LOST_CREATE_RESPONSE_RECONCILIATION_ACTION,
  executeReconciledProcurementPlan,
} from "./real-erpnext-procurement-execution.js";
import {
  REAL_ERPNEXT_BROAD_GOAL_PROBE_ID,
  REAL_ERPNEXT_BROAD_GOAL_REQUEST_IDS,
  createProcurementReferenceCapability,
  type RealErpNextProcurementWorld,
} from "./real-erpnext-procurement-world.js";

export const REAL_ERPNEXT_PILOT_SCOPE_KEY = "erpnext-approved-procurement-batch-v1";
export const REAL_ERPNEXT_PILOT_GOAL =
  "Convert every approved material request in the current test batch into exactly one draft Purchase Order, record each order reference on its source request, and leave every other record unchanged.";

const TARGET_ALIAS = "customer_system";
const WORKFLOW_KEY = "procure-approved-material-request";
const REQUIRED_ACTIONS = [
  "read_material_request",
  "find_purchase_order",
  "create_purchase_order",
  "update_material_request",
] as const;

function coverageKey(requestId: string): string {
  return `coverage-${requestId.toLowerCase()}`;
}

function criterionKey(requestId: string): string {
  return `purchase-order-${requestId.toLowerCase()}`;
}

export function createRealErpNextPilotScope(
  parentGoalId: string,
  requestId: string,
  ordinaryGoal = REAL_ERPNEXT_PILOT_GOAL,
): TrustedGoalScope {
  const secretAlias = "ERPNEXT_PROCUREMENT_FULL_TOKEN";
  return {
    tenantId: "local-erpnext-pilot",
    parentGoalId,
    requestId,
    ordinaryGoal,
    deadline: { key: "test-batch-now", description: "The current fictional ERPNext test batch." },
    entities: REAL_ERPNEXT_BROAD_GOAL_REQUEST_IDS.map((id) => ({
      alias: id,
      kind: "approved-material-request",
      systemAliases: [TARGET_ALIAS],
    })),
    systems: [{
      targetAlias: TARGET_ALIAS,
      credentialAliases: [secretAlias],
      operations: [
        { name: "read_material_request", method: "GET" },
        { name: "find_purchase_order", method: "GET" },
        { name: "create_purchase_order", method: "POST", requiredCompanionActions: ["read_material_request", "find_purchase_order"] },
        { name: "update_material_request", method: "PUT", requiredCompanionActions: ["read_material_request", "find_purchase_order"] },
      ],
    }],
    completionCriteria: REAL_ERPNEXT_BROAD_GOAL_REQUEST_IDS.map((id) => ({
      key: criterionKey(id),
      summary: `Directly verify one exact Purchase Order and the recorded reference for ${id}.`,
      verifierKey: `erpnext-direct-${id.toLowerCase()}-v1`,
    })),
    requiredCoverage: REAL_ERPNEXT_BROAD_GOAL_REQUEST_IDS.map((id) => ({
      key: coverageKey(id),
      entityAliases: [id],
      workflowKey: WORKFLOW_KEY,
      requiredActions: [...REQUIRED_ACTIONS],
      targetAliases: [TARGET_ALIAS],
      completionCriterionKeys: [criterionKey(id)],
    })),
    authority: {
      allowedTargetAliases: [TARGET_ALIAS],
      allowedSecretAliases: [secretAlias],
      allowedMethods: ["GET", "POST", "PUT"],
      writeAuthority: "preauthorized",
      approvedWriteActions: [],
    },
  };
}

export function createRealErpNextPilotPlanProposal(): GoalPlanProposal {
  return {
    schemaVersion: GOAL_COORDINATION_SCHEMA_VERSION,
    deadlineKey: "test-batch-now",
    summary: "Create and record exactly one reconciled draft Purchase Order for each approved Material Request in the trusted batch.",
    workItems: REAL_ERPNEXT_BROAD_GOAL_REQUEST_IDS.map((id, index) => ({
      key: `procure-${id.toLowerCase()}`,
      groupKey: "approved-procurement-batch",
      groupLabel: "Approved procurement batch",
      summary: `Create and record the exact approved Purchase Order for ${id}.`,
      coverageKeys: [coverageKey(id)],
      entityAliases: [id],
      workflowKey: WORKFLOW_KEY,
      requiredActions: [...REQUIRED_ACTIONS],
      targetAliases: [TARGET_ALIAS],
      completionCriterionKeys: [criterionKey(id)],
      dependsOnKeys: index === 0 ? [] : [],
    })),
  };
}

class StaticProcurementBuilder implements CapabilityBuilder {
  calls = 0;
  constructor(private readonly world: RealErpNextProcurementWorld) {}
  async build(): Promise<CapabilityManifest> {
    this.calls += 1;
    return createProcurementReferenceCapability(
      this.world.documentation,
      this.world.secretAliasForProfile("full"),
    );
  }
}

class ProcurementRuntimeResolver implements RuntimeResolver {
  constructor(
    private readonly world: RealErpNextProcurementWorld,
    private readonly operationGuard?: RuntimeOperationGuard,
  ) {}
  resolve(): CapabilityRuntime {
    return new CapabilityRuntime({
      ...this.world.runtimeConfigurationForProfile("full"),
      ...(this.operationGuard ? { operationGuard: this.operationGuard } : {}),
    });
  }
}

class BroadGoalProcurementVerifier implements CapabilityVerifier {
  constructor(private readonly world: RealErpNextProcurementWorld) {}

  async verify(request: CapabilityRequest, manifest: CapabilityManifest, runtime: CapabilityRuntime) {
    const before = this.world.broadGoalStateHash();
    const checks = [{
      id: "required-actions",
      passed: REQUIRED_ACTIONS.every((name) => manifest.actions.some((action) => action.name === name)),
      detail: "The capability contains the exact read, reconciliation, create and source-update action set.",
    }];
    try {
      runtime.validateManifest(manifest);
      await executeReconciledProcurementPlan(
        manifest,
        runtime,
        REAL_ERPNEXT_BROAD_GOAL_PROBE_ID,
        `probe-${request.context.requestId}`,
      );
      const probe = this.world.verifyBroadGoalRequest(REAL_ERPNEXT_BROAD_GOAL_PROBE_ID);
      checks.push({
        id: "disposable-real-system-probe",
        passed: probe.passed && probe.incorrectSideEffects === 0,
        detail: probe.passed
          ? "The candidate completed a real disposable ERPNext write and direct database verification."
          : probe.issues.map((issue) => `${issue.code}: ${issue.message}`).join(" | "),
      });
    } catch (error) {
      checks.push({
        id: "disposable-real-system-probe",
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.world.resetBroadGoalProbe();
    }
    const after = this.world.broadGoalStateHash();
    checks.push({
      id: "probe-state-restored",
      passed: before === after,
      detail: "The disposable probe was removed without resetting or changing parent-job records.",
    });
    return {
      verifierVersion: "erpnext-broad-goal-disposable-probe-v1",
      manifestDigest: manifestDigest(manifest),
      documentationHash: request.need.documentationHash,
      passed: checks.every((item) => item.passed),
      checks,
      verifiedAt: new Date().toISOString(),
    };
  }
}

class BroadGoalProcurementWorkflow implements CapabilityWorkflow {
  constructor(
    private readonly world: RealErpNextProcurementWorld,
    private readonly item: ValidatedGoalWorkItem,
    private readonly loseCreateResponseAfterCommit = false,
  ) {}

  execute(_request: CapabilityRequest, manifest: CapabilityManifest, runtime: CapabilityRuntime): Promise<ActionReceipt[]> {
    return executeReconciledProcurementPlan(
      manifest,
      runtime,
      this.item.entityAliases[0]!,
      this.item.operationKey,
      { loseCreateResponseAfterCommit: this.loseCreateResponseAfterCommit },
    );
  }

  async verifyOutcome(): Promise<OutcomeReceipt> {
    return directItemOutcome(this.world, this.item);
  }

  async resume() {
    const direct = this.world.verifyBroadGoalRequest(this.item.entityAliases[0]!);
    return {
      completed: direct.passed && direct.incorrectSideEffects === 0,
      summary: direct.passed
        ? `The parent procurement goal continued after ${this.item.entityAliases[0]} was directly verified.`
        : `The parent procurement goal could not continue because ${this.item.entityAliases[0]} was not verified.`,
    };
  }
}

function directItemOutcome(world: RealErpNextProcurementWorld, item: ValidatedGoalWorkItem): OutcomeReceipt {
  const direct = world.verifyBroadGoalRequest(item.entityAliases[0]!);
  return {
    verifierVersion: "erpnext-broad-goal-direct-database-v1",
    passed: direct.passed,
    intendedWrites: direct.intendedWrites,
    incorrectSideEffects: direct.incorrectSideEffects,
    stateDigest: direct.stateHash,
    checks: direct.issues.length > 0
      ? direct.issues.map((issue) => ({ id: issue.code, passed: false, detail: issue.message }))
      : [{ id: `criterion:${item.completionCriteria[0]!.key}`, passed: true, detail: "Direct ERPNext database state matched the trusted work-item contract." }],
    verifiedAt: new Date().toISOString(),
  };
}

class RealErpNextBroadGoalExecution
  implements GoalWorkItemExecutor, GoalWorkItemOutcomeVerifier {
  readonly builder: CapabilityBuilder;
  private readonly sdk: CapabilityFactorySdk;

  constructor(
    private readonly world: RealErpNextProcurementWorld,
    registryDirectory: string,
    operationGuard?: RuntimeOperationGuard,
    private readonly loseCreateResponseAfterCommitFor?: string,
    construction?: PilotCapabilityConstruction,
  ) {
    // Absent construction means the deterministic reference builder — unchanged.
    // There is deliberately no fallback in the other direction: if an injected
    // builder fails, the run fails visibly (PROP-0007 forbids silent reversion).
    this.builder = construction ? construction.createBuilder() : new StaticProcurementBuilder(world);
    const runtimeResolver = new ProcurementRuntimeResolver(world, operationGuard);
    this.sdk = new CapabilityFactorySdk({
      coordinator: new CapabilityCoordinator({
        store: new FileTenantCapabilityStore(registryDirectory),
        builder: this.builder,
        verifier: new BroadGoalProcurementVerifier(world),
        runtimeResolver,
        maxVerificationRepairs: construction?.maxVerificationRepairs ?? 0,
      }),
      runtimeResolver,
    });
  }

  async execute(input: GoalWorkItemExecutionInput): Promise<GoalWorkItemExecutionResult> {
    const requestId = input.item.entityAliases[0]!;
    const directBefore = this.world.verifyBroadGoalRequest(requestId);
    if (directBefore.passed && directBefore.incorrectSideEffects === 0) {
      return {
        status: "already-satisfied",
        path: "already-satisfied",
        childRunId: `child-${input.item.workItemId}`,
        operationKey: input.item.operationKey,
        writesAttempted: 0,
        summary: "Direct ERPNext state already satisfied this work item; no write was repeated.",
      };
    }
    const secretAlias = this.world.secretAliasForProfile("full");
    const request: CapabilityRequest = {
      context: {
        tenantId: input.plan.tenantId,
        requestId: `child-${input.item.workItemId}`,
        workflowKey: input.item.workflowKey,
        ordinaryGoal: input.item.summary,
        blockedAt: new Date().toISOString(),
        blockedReason: "No configured ability can perform the trusted ERPNext procurement action set.",
        visibility: "full",
        correlation: input.item.correlation,
      },
      need: {
        key: "erpnext-approved-procurement-v1",
        summary: "Create and record one exact approved ERPNext Purchase Order with reconciliation before retry.",
        requiredActions: [...REQUIRED_ACTIONS],
        targetAliases: [TARGET_ALIAS],
        secretAliases: [secretAlias],
        documentationHash: this.world.documentation.sha256,
      },
      authority: {
        allowedTargetAliases: [TARGET_ALIAS],
        allowedSecretAliases: [secretAlias],
        allowedMethods: ["GET", "POST", "PUT"],
        writeAuthority: "preauthorized",
        approvedWriteActions: [],
      },
      runtimeProfile: "broad-goal-full",
    };
    const result = await this.sdk.completeBlockedGoal(
      request,
      new BroadGoalProcurementWorkflow(
        this.world,
        input.item,
        requestId === this.loseCreateResponseAfterCommitFor,
      ),
    );
    if (result.status === "handoff") {
      return {
        status: "blocked",
        childRunId: `child-${input.item.workItemId}`,
        operationKey: input.item.operationKey,
        writesAttempted: 0,
        handoff: result.handoff,
      };
    }
    const reconciliationAction = result.actions.find(
      (action) => action.action === LOST_CREATE_RESPONSE_RECONCILIATION_ACTION,
    );
    const normalWrites = result.actions.filter((action) =>
      ["create_purchase_order", "update_material_request"].includes(action.action)
    ).length;
    return {
      status: "executed",
      path: result.capabilitySource === "built"
        ? "built-capability"
        : result.capabilitySource === "reused"
          ? "retained-capability"
          : "trusted-tool",
      childRunId: `child-${input.item.workItemId}`,
      operationKey: input.item.operationKey,
      // When the create response is deliberately discarded, it is absent from
      // the caller's action receipts but still counts as one committed write.
      writesAttempted: normalWrites + (reconciliationAction ? 1 : 0),
      summary: `${requestId} completed through the shared capability loop and direct ERPNext verification.`,
      ...(reconciliationAction ? {
        reconciliation: {
          reason: "post-write-response-lost" as const,
          action: "create_purchase_order",
          recoveryAction: "find_purchase_order",
          externalMatches: 1 as const,
          responseReceived: false as const,
          writeRetried: false as const,
          duplicatePrevented: true as const,
        },
      } : {}),
    };
  }

  async verify(_plan: ValidatedGoalPlan, item: ValidatedGoalWorkItem): Promise<OutcomeReceipt> {
    return directItemOutcome(this.world, item);
  }
}

class RealErpNextBroadGoalAggregate {
  constructor(private readonly world: RealErpNextProcurementWorld) {}

  async verify(_plan: ValidatedGoalPlan, state: GoalCoordinationState): Promise<GoalAggregateOutcomeReceipt> {
    const direct = this.world.verifyBroadGoal();
    const items = Object.values(state.items);
    const completedItems = items.filter((item) => item.lifecycle === "completed").length;
    const blockedItems = items.filter((item) => item.lifecycle === "blocked").length;
    const failedItems = items.filter((item) => item.lifecycle === "failed").length;
    const unknownItems = items.length - completedItems - blockedItems - failedItems;
    const result: GoalAggregateOutcomeReceipt["result"] = failedItems > 0
      ? "failed"
      : unknownItems > 0
        ? "unknown"
        : blockedItems > 0
          ? completedItems > 0 ? "partially-complete" : "blocked"
          : direct.passed ? "complete" : "unknown";
    return {
      verifierVersion: "erpnext-broad-goal-aggregate-database-v1",
      receiptId: direct.stateHash.slice(0, 32),
      result,
      passed: result === "complete" && direct.passed && direct.incorrectSideEffects === 0,
      requiredItems: items.length,
      completedItems,
      blockedItems,
      failedItems,
      unknownItems,
      incorrectSideEffects: direct.incorrectSideEffects,
      stateDigest: direct.stateHash,
      checks: direct.issues.length > 0
        ? direct.issues.map((issue) => ({ id: issue.code, passed: false, detail: issue.message }))
        : [
            { id: "all-approved-requests-complete", passed: direct.completedRequests === direct.requiredRequests, detail: "Every trusted Material Request has exactly one directly verified Purchase Order." },
            { id: "no-incorrect-side-effects", passed: direct.incorrectSideEffects === 0, detail: "Direct ERPNext inspection found no duplicate, wrong-record or collateral state change." },
          ],
      verifiedAt: new Date().toISOString(),
    };
  }

  async resume(_plan: ValidatedGoalPlan, receipt: GoalAggregateOutcomeReceipt) {
    const completed = receipt.passed && receipt.result === "complete" && receipt.incorrectSideEffects === 0;
    return {
      completed,
      summary: completed
        ? "The ordinary batch goal resumed after independent aggregate ERPNext verification."
        : "The ordinary batch goal did not resume because aggregate ERPNext verification was not cleanly complete.",
    };
  }
}

/**
 * Capability construction override for the genuine demo mode (PROP-0007).
 * Absent means the static reference builder and zero verification repairs —
 * today's behaviour, unchanged. The verifier and outcome checks are identical
 * in both modes; only who drafts the manifest differs.
 */
export interface PilotCapabilityConstruction {
  createBuilder: () => RepairableCapabilityBuilder;
  maxVerificationRepairs: number;
  label: string;
}

export interface RealErpNextPilotAdapterOptions {
  world: RealErpNextProcurementWorld;
  dataDirectory: string;
  includeAcceptance?: boolean;
  /** Genuine-mode builder injection. The acceptance harness never receives this. */
  capabilityConstruction?: PilotCapabilityConstruction;
  operationGuard?: RuntimeOperationGuard;
  continuationAuthority?: GoalContinuationGrantVerifier;
  /** Local deterministic fault injection. Disabled unless explicitly set. */
  faultInjection?: {
    loseCreateResponseAfterCommitFor: string;
  };
}

export function createRealErpNextBroadGoalPilotAdapter(
  options: RealErpNextPilotAdapterOptions,
): ControlledPilotAdapter {
  const { world, dataDirectory } = options;
  const lostResponseTarget = options.faultInjection?.loseCreateResponseAfterCommitFor;
  if (lostResponseTarget && !REAL_ERPNEXT_BROAD_GOAL_REQUEST_IDS.includes(lostResponseTarget as never)) {
    throw new Error(`Lost-response fault target is outside the trusted ERPNext batch: ${lostResponseTarget}`);
  }
  const adapter: ControlledPilotAdapter = {
    descriptor: {
      schemaVersion: PILOT_ADAPTER_SCHEMA_VERSION,
      adapterId: "erpnext-procurement-batch",
      adapterVersion: "1.0.0",
      capabilityMode: CURRENT_CAPABILITY_MODE,
      environmentId: "genuine-local-erpnext",
      scopeKeys: [REAL_ERPNEXT_PILOT_SCOPE_KEY],
      workflowKeys: [WORKFLOW_KEY],
      targetAliases: [TARGET_ALIAS],
      credentialAliases: [world.secretAliasForProfile("full")],
      documentation: [{ targetAlias: TARGET_ALIAS, sha256: world.documentation.sha256 }],
      operations: [
        { name: "read_material_request", targetAlias: TARGET_ALIAS, method: "GET", consequence: "read", retrySafety: "not-applicable", outcomeVerifierKey: "erpnext_direct_database" },
        { name: "find_purchase_order", targetAlias: TARGET_ALIAS, method: "GET", consequence: "read", retrySafety: "not-applicable", outcomeVerifierKey: "erpnext_direct_database" },
        { name: "create_purchase_order", targetAlias: TARGET_ALIAS, method: "POST", consequence: "write", retrySafety: "reconcile-before-retry", outcomeVerifierKey: "erpnext_direct_database" },
        { name: "update_material_request", targetAlias: TARGET_ALIAS, method: "PUT", consequence: "write", retrySafety: "reconcile-before-retry", outcomeVerifierKey: "erpnext_direct_database" },
      ],
      acceptanceCases: [...REQUIRED_PILOT_ADAPTER_CASES],
      dataBoundary: {
        execution: "customer-local",
        credentials: "customer-local-alias-only",
        externalVerification: "customer-local-independent",
      },
    },
    scopes: {
      resolve: async (request) => request.scopeKey === REAL_ERPNEXT_PILOT_SCOPE_KEY && request.tenantId === "local-erpnext-pilot"
        ? createRealErpNextPilotScope(request.parentGoalId, request.requestId, request.ordinaryGoal)
        : undefined,
    },
    runtimes: {
      open: async (scope) => {
        const execution = new RealErpNextBroadGoalExecution(
          world,
          path.join(dataDirectory, "capability-registry"),
          options.operationGuard,
          lostResponseTarget,
          options.capabilityConstruction,
        );
        const aggregate = new RealErpNextBroadGoalAggregate(world);
        return {
          runner: new GoalScheduler(
            new FileGoalCoordinationStore(path.join(dataDirectory, "coordination", scope.parentGoalId)),
            execution,
            execution,
            aggregate,
            aggregate,
            undefined,
            options.continuationAuthority,
          ),
        };
      },
    },
    preflight: async (): Promise<PilotAdapterCheck[]> => {
      const runtime = world.runtimeConfigurationForProfile("full");
      return [
        { id: "erpnext-local-health", passed: world.baseUrl.startsWith("http://127.0.0.1:"), detail: "The disposable ERPNext target is bound to localhost." },
        { id: "documentation-hash", passed: /^[a-f0-9]{64}$/.test(world.documentation.sha256), detail: "The adapter is pinned to hashed ERPNext documentation." },
        { id: "credential-alias-resolution", passed: Object.hasOwn(runtime.secrets, world.secretAliasForProfile("full")), detail: "The customer-local runtime resolves the declared credential alias." },
        { id: "direct-verifier-access", passed: world.broadGoalStateHash().length === 64, detail: "The privileged direct-state verifier is reachable without exposing its access through the sidecar request." },
      ];
    },
  };
  if (options.includeAcceptance !== false) {
    adapter.acceptance = createRealErpNextPilotAcceptanceHarness({
      world,
      dataDirectory,
      scopeKey: REAL_ERPNEXT_PILOT_SCOPE_KEY,
      ordinaryGoal: REAL_ERPNEXT_PILOT_GOAL,
      createBroadGoalCoordinator: async (rootDirectory) => {
        const isolatedAdapter = createRealErpNextBroadGoalPilotAdapter({
          world,
          dataDirectory: rootDirectory,
          includeAcceptance: false,
        });
        return createControlledPilotSdk(isolatedAdapter, {
          planner: realErpNextBroadGoalPlanner,
          plans: new FileValidatedGoalPlanStore(path.join(rootDirectory, "plans")),
          maxPlanningAttempts: 1,
        });
      },
    });
  }
  return adapter;
}

export const realErpNextBroadGoalPlanner: GoalPlanner = {
  propose: async () => createRealErpNextPilotPlanProposal(),
};
