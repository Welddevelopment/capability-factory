import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { GoalContinuationGrant } from "./continuation.js";
import {
  GoalPlanCompiler,
  type GoalPlanValidationCheck,
  type GoalPlanner,
  type TrustedGoalScope,
  type ValidatedGoalPlan,
} from "./goal-coordination.js";
import type { GoalCoordinationState } from "./goal-scheduler.js";
import { goalPlanDigest } from "./goal-scheduler.js";

export const BROAD_GOAL_REQUEST_SCHEMA_VERSION = "1.0" as const;

export interface BroadGoalRequest {
  schemaVersion: typeof BROAD_GOAL_REQUEST_SCHEMA_VERSION;
  tenantId: string;
  parentGoalId: string;
  requestId: string;
  scopeKey: string;
  ordinaryGoal: string;
  visibility: "exceptions-only" | "summary" | "full";
}

const boundedIdentifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/);

export const broadGoalRequestSchema: z.ZodType<BroadGoalRequest> = z
  .object({
    schemaVersion: z.literal(BROAD_GOAL_REQUEST_SCHEMA_VERSION),
    tenantId: boundedIdentifier,
    parentGoalId: boundedIdentifier,
    requestId: boundedIdentifier,
    scopeKey: boundedIdentifier,
    ordinaryGoal: z.string().trim().min(1).max(4_000),
    visibility: z.enum(["exceptions-only", "summary", "full"]),
  })
  .strict();

export interface BroadGoalPlanningReceipt {
  source: "newly-validated" | "retained-validated-plan";
  attempts: number;
  validationReceiptId: string;
  planDigest: string;
  workItems: number;
}

export type BroadGoalRunResult =
  | {
      status: GoalCoordinationState["lifecycle"];
      tenantId: string;
      parentGoalId: string;
      requestId: string;
      planning: BroadGoalPlanningReceipt;
      /** The trusted, validated plan that was actually executed. */
      plan?: ValidatedGoalPlan;
      state: GoalCoordinationState;
    }
  | {
      status: "plan-rejected";
      tenantId: string;
      parentGoalId: string;
      requestId: string;
      planning: {
        source: "rejected";
        attempts: number;
        failedChecks: GoalPlanValidationCheck[];
      };
    }
  | {
      status: "handoff";
      tenantId: string;
      parentGoalId: string;
      requestId: string;
      handoff: {
        reason: "scope-unavailable" | "scope-mismatch" | "trusted-scope-changed" | "runtime-unavailable";
        summary: string;
        writesAttempted: 0;
      };
    };

export interface BroadGoalScopeResolver {
  /** Resolves customer-trusted scope and authority. The model never supplies this object. */
  resolve(request: BroadGoalRequest): Promise<TrustedGoalScope | undefined>;
}

export interface BroadGoalPlanRunner {
  run(plan: ValidatedGoalPlan): Promise<GoalCoordinationState>;
  continue?(plan: ValidatedGoalPlan, grant: GoalContinuationGrant): Promise<GoalCoordinationState>;
}

export interface BroadGoalRuntimeLease {
  runner: BroadGoalPlanRunner;
  close?(): Promise<void>;
}

export interface BroadGoalRuntimeResolver {
  open(scope: TrustedGoalScope, plan: ValidatedGoalPlan): Promise<BroadGoalRuntimeLease | undefined>;
}

export interface StoredValidatedGoalPlan {
  scopeDigest: string;
  plan: ValidatedGoalPlan;
}

export interface ValidatedGoalPlanStore {
  load(tenantId: string, parentGoalId: string): StoredValidatedGoalPlan | null;
  save(record: StoredValidatedGoalPlan): StoredValidatedGoalPlan;
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

export function trustedGoalScopeDigest(scope: TrustedGoalScope): string {
  return createHash("sha256").update(canonical(scope)).digest("hex");
}

export class FileValidatedGoalPlanStore implements ValidatedGoalPlanStore {
  constructor(private readonly rootDirectory: string) {
    fs.mkdirSync(rootDirectory, { recursive: true, mode: 0o700 });
  }

  load(tenantId: string, parentGoalId: string): StoredValidatedGoalPlan | null {
    const filename = this.filename(tenantId, parentGoalId);
    if (!fs.existsSync(filename)) return null;
    return JSON.parse(fs.readFileSync(filename, "utf8")) as StoredValidatedGoalPlan;
  }

  save(record: StoredValidatedGoalPlan): StoredValidatedGoalPlan {
    const current = this.load(record.plan.tenantId, record.plan.parentGoalId);
    if (current) {
      if (
        current.scopeDigest !== record.scopeDigest ||
        goalPlanDigest(current.plan) !== goalPlanDigest(record.plan)
      ) {
        throw new Error("A different validated plan cannot replace the saved parent plan.");
      }
      return structuredClone(current);
    }
    // Credential aliases are identifiers such as `supplier_east_key`, not secret values.
    // Generic trace redaction would corrupt those identifiers and make the saved plan unusable.
    const safe = structuredClone(record);
    const filename = this.filename(record.plan.tenantId, record.plan.parentGoalId);
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(safe, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      // Hard-linking is an atomic create-if-absent operation. Two concurrent
      // requests cannot silently overwrite one another's validated plan.
      fs.linkSync(temporary, filename);
      return structuredClone(safe);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const winner = this.load(record.plan.tenantId, record.plan.parentGoalId);
      if (
        !winner ||
        winner.scopeDigest !== record.scopeDigest ||
        goalPlanDigest(winner.plan) !== goalPlanDigest(record.plan)
      ) {
        throw new Error("Concurrent planning produced a different validated plan for the same parent goal.");
      }
      return structuredClone(winner);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  private filename(tenantId: string, parentGoalId: string): string {
    const digest = createHash("sha256").update(`${tenantId}\u001f${parentGoalId}`).digest("hex");
    return path.join(this.rootDirectory, `${digest}.json`);
  }
}

export interface BroadGoalCoordinatorSdkDependencies {
  planner: GoalPlanner;
  scopes: BroadGoalScopeResolver;
  runtimes: BroadGoalRuntimeResolver;
  plans: ValidatedGoalPlanStore;
  maxPlanningAttempts?: number;
}

function handoff(
  request: BroadGoalRequest,
  reason: Extract<BroadGoalRunResult, { status: "handoff" }>["handoff"]["reason"],
  summary: string,
): BroadGoalRunResult {
  return {
    status: "handoff",
    tenantId: request.tenantId,
    parentGoalId: request.parentGoalId,
    requestId: request.requestId,
    handoff: { reason, summary, writesAttempted: 0 },
  };
}

/** One broad-goal interface shared by direct SDK and sidecar installation shapes. */
export class BroadGoalCoordinatorSdk {
  private readonly compiler: GoalPlanCompiler;

  constructor(private readonly dependencies: BroadGoalCoordinatorSdkDependencies) {
    this.compiler = new GoalPlanCompiler(
      dependencies.planner,
      dependencies.maxPlanningAttempts ?? 2,
    );
  }

  async completeGoal(rawRequest: BroadGoalRequest): Promise<BroadGoalRunResult> {
    const request = broadGoalRequestSchema.parse(rawRequest);
    const scope = await this.dependencies.scopes.resolve(request);
    if (!scope) {
      return handoff(request, "scope-unavailable", "The trusted customer scope could not be resolved. No work was started.");
    }
    if (
      scope.tenantId !== request.tenantId ||
      scope.parentGoalId !== request.parentGoalId ||
      scope.requestId !== request.requestId ||
      scope.ordinaryGoal !== request.ordinaryGoal
    ) {
      return handoff(request, "scope-mismatch", "The trusted scope did not match the requested goal identity. No work was started.");
    }

    const scopeDigest = trustedGoalScopeDigest(scope);
    const retained = this.dependencies.plans.load(request.tenantId, request.parentGoalId);
    let plan: ValidatedGoalPlan;
    let planning: BroadGoalPlanningReceipt;
    if (retained) {
      if (retained.scopeDigest !== scopeDigest) {
        return handoff(request, "trusted-scope-changed", "Trusted scope or authority changed after the plan was saved. The old plan was not resumed.");
      }
      if (
        retained.plan.requestId !== request.requestId ||
        retained.plan.ordinaryGoal !== request.ordinaryGoal
      ) {
        return handoff(request, "scope-mismatch", "The saved plan belongs to a different request. No work was started.");
      }
      plan = retained.plan;
      planning = {
        source: "retained-validated-plan",
        attempts: 0,
        validationReceiptId: plan.validationReceiptId,
        planDigest: goalPlanDigest(plan),
        workItems: plan.workItems.length,
      };
    } else {
      const compiled = await this.compiler.compile(scope);
      if (compiled.status === "rejected") {
        return {
          status: "plan-rejected",
          tenantId: request.tenantId,
          parentGoalId: request.parentGoalId,
          requestId: request.requestId,
          planning: {
            source: "rejected",
            attempts: compiled.attempts,
            failedChecks: compiled.checks.filter((check) => !check.passed),
          },
        };
      }
      plan = this.dependencies.plans.save({ scopeDigest, plan: compiled.plan }).plan;
      planning = {
        source: "newly-validated",
        attempts: compiled.attempts,
        validationReceiptId: plan.validationReceiptId,
        planDigest: goalPlanDigest(plan),
        workItems: plan.workItems.length,
      };
    }

    const lease = await this.dependencies.runtimes.open(scope, plan);
    if (!lease) {
      return handoff(request, "runtime-unavailable", "The trusted customer runtime was unavailable. No new work was started.");
    }
    try {
      const state = await lease.runner.run(plan);
      return {
        status: state.lifecycle,
        tenantId: request.tenantId,
        parentGoalId: request.parentGoalId,
        requestId: request.requestId,
        planning,
        plan,
        state,
      };
    } finally {
      await lease.close?.();
    }
  }

  /**
   * Continues one exact blocked item under a customer-issued grant. The saved
   * plan is reused unchanged; this path never calls the model or replans.
   */
  async continueGoal(
    rawRequest: BroadGoalRequest,
    grant: GoalContinuationGrant,
  ): Promise<BroadGoalRunResult> {
    const request = broadGoalRequestSchema.parse(rawRequest);
    const scope = await this.dependencies.scopes.resolve(request);
    if (!scope) {
      return handoff(request, "scope-unavailable", "The trusted customer scope could not be resolved. No continuation was started.");
    }
    if (
      scope.tenantId !== request.tenantId ||
      scope.parentGoalId !== request.parentGoalId ||
      scope.requestId !== request.requestId ||
      scope.ordinaryGoal !== request.ordinaryGoal
    ) {
      return handoff(request, "scope-mismatch", "The trusted scope did not match the saved goal identity. No continuation was started.");
    }
    const retained = this.dependencies.plans.load(request.tenantId, request.parentGoalId);
    if (!retained) {
      return handoff(request, "scope-mismatch", "No retained validated plan exists for this continuation. No work was started.");
    }
    if (retained.scopeDigest !== trustedGoalScopeDigest(scope)) {
      return handoff(request, "trusted-scope-changed", "Trusted scope changed after the plan was saved. The continuation was rejected.");
    }
    const plan = retained.plan;
    if (plan.requestId !== request.requestId || plan.ordinaryGoal !== request.ordinaryGoal) {
      return handoff(request, "scope-mismatch", "The retained plan belongs to another request. No work was started.");
    }
    const lease = await this.dependencies.runtimes.open(scope, plan);
    if (!lease?.runner.continue) {
      await lease?.close?.();
      return handoff(request, "runtime-unavailable", "This customer runtime cannot safely continue a blocked goal. No new work was started.");
    }
    try {
      const state = await lease.runner.continue(plan, grant);
      return {
        status: state.lifecycle,
        tenantId: request.tenantId,
        parentGoalId: request.parentGoalId,
        requestId: request.requestId,
        planning: {
          source: "retained-validated-plan",
          attempts: 0,
          validationReceiptId: plan.validationReceiptId,
          planDigest: goalPlanDigest(plan),
          workItems: plan.workItems.length,
        },
        plan,
        state,
      };
    } finally {
      await lease.close?.();
    }
  }
}

export function isBroadGoalRunResult(value: unknown): value is BroadGoalRunResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  if (
    typeof result.status !== "string" ||
    typeof result.tenantId !== "string" ||
    typeof result.parentGoalId !== "string" ||
    typeof result.requestId !== "string"
  ) return false;
  if (result.status === "handoff") {
    const handoff = result.handoff as Record<string, unknown> | undefined;
    return Boolean(handoff)
      && ["scope-unavailable", "scope-mismatch", "trusted-scope-changed", "runtime-unavailable"].includes(String(handoff!.reason))
      && handoff!.writesAttempted === 0;
  }
  if (result.status === "plan-rejected") {
    const planning = result.planning as Record<string, unknown> | undefined;
    return Boolean(planning)
      && planning!.source === "rejected"
      && typeof planning!.attempts === "number"
      && Array.isArray(planning!.failedChecks);
  }
  const planning = result.planning as Record<string, unknown> | undefined;
  const plan = result.plan as Record<string, unknown> | undefined;
  const state = result.state as Record<string, unknown> | undefined;
  return ["active", "completed", "partially-complete", "blocked", "failed", "unknown"].includes(result.status)
    && Boolean(planning)
    && ["newly-validated", "retained-validated-plan"].includes(String(planning!.source))
    && (!plan || (
      plan.tenantId === result.tenantId
      && plan.parentGoalId === result.parentGoalId
      && plan.requestId === result.requestId
    ))
    && Boolean(state)
    && state!.tenantId === result.tenantId
    && state!.parentGoalId === result.parentGoalId
    && state!.requestId === result.requestId
    && state!.lifecycle === result.status;
}
