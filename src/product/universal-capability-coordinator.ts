import { createHash } from "node:crypto";
import type { CapabilityMode, CapabilityModeEnvelope, CapabilityModeResult } from "./capability-mode-contract.js";
import { capabilityModeIdentity } from "./capability-mode-contract.js";
import { CapabilityModeRouter } from "./capability-mode-router.js";
import {
  DEFAULT_RUNTIME_FAMILY_REGISTRY,
  capabilityBundleSchema,
  universalGoalSchema,
  type CapabilityBundle,
  type CapabilityBundleSource,
  type ExecutionRisk,
  type RuntimeFamily,
  type RuntimeFamilyDescriptor,
  type UniversalGoal,
  type UniversalResolutionMetrics,
  type UniversalResolutionStatus,
} from "./universal-capability-contract.js";

const RISK_ORDER: Record<ExecutionRisk, number> = {
  "read-only": 0,
  "reversible-write": 1,
  "consequential-write": 2,
  "privileged-control": 3,
  "physical-action": 4,
};

const SOURCE_ORDER: Record<CapabilityBundleSource, number> = {
  retained: 0,
  "trusted-existing": 1,
  composed: 2,
  "built-manifest": 3,
  "sandboxed-residual": 4,
  delegated: 5,
};

const MODE_FAMILY: Record<CapabilityMode, RuntimeFamily> = {
  "constrained-http-api": "service-api",
  "experimental-browser-actions": "browser-web",
  "experimental-file-transfer-actions": "file-object-edi",
  "experimental-inbox-message-actions": "message-event",
  "experimental-document-actions": "document-media",
  "experimental-database-actions": "database-query",
  "experimental-trusted-tool-actions": "trusted-tool-code",
  "experimental-agent-delegation-actions": "agent-service-delegation",
};

function includesAll(values: string[], required: string[]): boolean {
  return required.every((value) => values.includes(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requestOrdinaryGoal(envelope: CapabilityModeEnvelope): string {
  return envelope.request.ordinaryGoal;
}

export interface PreparedCapabilityRoute {
  routeId: string;
  family: RuntimeFamily;
  envelope: CapabilityModeEnvelope;
  bundle: CapabilityBundle;
  supportedActions: string[];
  targetAliases: string[];
  observationKeys: string[];
  requiredSecretAliases: string[];
  requiredApprovalKeys: string[];
  priority: number;
}

export interface RouteRejection {
  routeId: string;
  reasons: string[];
}

export interface UniversalRouteSelection {
  selected?: PreparedCapabilityRoute;
  rejected: RouteRejection[];
}

export interface UniversalResolutionReceipt {
  schemaVersion: "1.0";
  tenantId: string;
  requestId: string;
  parentGoalId: string;
  status: UniversalResolutionStatus;
  summary: string;
  selectedRouteId?: string;
  selectedFamily?: RuntimeFamily;
  capabilityBundle?: CapabilityBundle;
  modeResult?: CapabilityModeResult;
  rejectedRoutes: RouteRejection[];
  metrics: UniversalResolutionMetrics;
  resolvedAt: string;
  receiptDigest: string;
}

export function isUniversalResolutionReceipt(value: unknown): value is UniversalResolutionReceipt {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const metrics = record.metrics;
  return record.schemaVersion === "1.0"
    && typeof record.tenantId === "string"
    && typeof record.requestId === "string"
    && typeof record.parentGoalId === "string"
    && ["autonomous-completion", "precise-handoff", "unresolved-safe"].includes(String(record.status))
    && typeof record.summary === "string"
    && Array.isArray(record.rejectedRoutes)
    && Boolean(metrics)
    && typeof metrics === "object"
    && typeof (metrics as Record<string, unknown>).correctlyResolved === "boolean"
    && typeof (metrics as Record<string, unknown>).autonomouslyCompleted === "boolean"
    && typeof (metrics as Record<string, unknown>).preciseHandoff === "boolean"
    && (metrics as Record<string, unknown>).silentFalseCompletion === false
    && typeof record.resolvedAt === "string"
    && typeof record.receiptDigest === "string"
    && /^[a-f0-9]{64}$/.test(record.receiptDigest);
}

export interface UniversalCapabilityCoordinatorOptions {
  familyRegistry?: RuntimeFamilyDescriptor[];
  now?: () => string;
}

/**
 * Trusted cross-mode coordinator. The caller supplies an ordinary goal and a
 * diagnosed gap; customer-local adapters prepare bounded route candidates.
 * The caller does not select a runtime family or capability mode.
 */
export class UniversalCapabilityCoordinator {
  private readonly families: Map<RuntimeFamily, RuntimeFamilyDescriptor>;
  private readonly now: () => string;

  constructor(
    private readonly router: CapabilityModeRouter,
    options: UniversalCapabilityCoordinatorOptions = {},
  ) {
    const descriptors = options.familyRegistry ?? [...DEFAULT_RUNTIME_FAMILY_REGISTRY];
    this.families = new Map(descriptors.map((descriptor) => [descriptor.family, descriptor]));
    this.now = options.now ?? (() => new Date().toISOString());
  }

  descriptors(): RuntimeFamilyDescriptor[] {
    return [...this.families.values()].map((descriptor) => structuredClone(descriptor));
  }

  select(rawGoal: unknown, routes: PreparedCapabilityRoute[]): UniversalRouteSelection {
    const goal = universalGoalSchema.parse(rawGoal);
    const rejected: RouteRejection[] = [];
    const eligible: PreparedCapabilityRoute[] = [];

    for (const rawRoute of routes) {
      const reasons: string[] = [];
      let bundle: CapabilityBundle;
      try {
        bundle = capabilityBundleSchema.parse(rawRoute.bundle);
      } catch {
        rejected.push({ routeId: rawRoute.routeId, reasons: ["The capability bundle failed strict validation."] });
        continue;
      }

      const identity = capabilityModeIdentity(rawRoute.envelope);
      const descriptor = this.families.get(rawRoute.family);
      if (!descriptor) reasons.push("The runtime family is not registered.");
      else if (!descriptor.enabled) reasons.push("The runtime family is registered but not enabled.");
      if (MODE_FAMILY[rawRoute.envelope.capabilityMode] !== rawRoute.family) {
        reasons.push("The explicit capability mode does not belong to the declared runtime family.");
      }
      if (bundle.runtime.family !== rawRoute.family) reasons.push("The bundle runtime family does not match the route.");
      if (bundle.tenantId !== goal.tenantId) reasons.push("The bundle tenant does not match the goal tenant.");
      if (bundle.needKey !== goal.gap.key) reasons.push("The bundle need identity does not match the diagnosed gap.");
      if (identity.tenantId !== goal.tenantId || identity.requestId !== goal.requestId || identity.parentGoalId !== goal.parentGoalId) {
        reasons.push("The mode envelope identity does not match the universal goal identity.");
      }
      if (requestOrdinaryGoal(rawRoute.envelope) !== goal.ordinaryGoal) {
        reasons.push("The prepared route changed the ordinary goal.");
      }
      if (!includesAll(rawRoute.supportedActions, goal.gap.requiredActions)) reasons.push("The route does not cover every required action.");
      if (!includesAll(rawRoute.targetAliases, goal.gap.targetAliases)) reasons.push("The route does not cover every required target.");
      if (!includesAll(rawRoute.observationKeys, goal.gap.requiredObservationKeys)) reasons.push("The route lacks an independent observation required by the outcome contract.");
      if (!includesAll(goal.authority.allowedActions, goal.gap.requiredActions)) reasons.push("Customer authority does not allow every required action.");
      if (!includesAll(goal.authority.allowedTargetAliases, goal.gap.targetAliases)) reasons.push("Customer authority does not allow every required target.");
      if (!includesAll(goal.authority.allowedSecretAliases, rawRoute.requiredSecretAliases)) reasons.push("One or more route credentials are outside customer authority.");
      if (!includesAll(goal.authority.grantedApprovals, rawRoute.requiredApprovalKeys)) reasons.push("One or more exact route approvals are missing.");
      if (RISK_ORDER[bundle.authority.risk] > RISK_ORDER[goal.gap.maximumRisk]) reasons.push("The route exceeds the diagnosed gap's risk ceiling.");
      if (RISK_ORDER[bundle.authority.risk] > RISK_ORDER[goal.authority.maximumRisk]) reasons.push("The route exceeds the customer's authority risk ceiling.");
      if (!bundle.verification.independentFromExecution) reasons.push("The outcome verifier is not independent from execution.");
      if (!bundle.recovery.reconcileBeforeRetry || bundle.recovery.blindRetryAllowed) reasons.push("The route does not enforce safe reconciliation before retry.");

      if (reasons.length > 0) rejected.push({ routeId: rawRoute.routeId, reasons });
      else eligible.push({ ...rawRoute, bundle });
    }

    eligible.sort((left, right) => {
      const source = SOURCE_ORDER[left.bundle.source] - SOURCE_ORDER[right.bundle.source];
      if (source !== 0) return source;
      const priority = left.priority - right.priority;
      if (priority !== 0) return priority;
      return left.routeId.localeCompare(right.routeId);
    });

    const selected = eligible[0];
    return selected ? { selected, rejected } : { rejected };
  }

  async resolve(rawGoal: unknown, routes: PreparedCapabilityRoute[]): Promise<UniversalResolutionReceipt> {
    const goal = universalGoalSchema.parse(rawGoal);
    const selection = this.select(goal, routes);
    if (!selection.selected) {
      return this.receipt(goal, {
        status: "precise-handoff",
        summary: "No enabled capability route satisfied the diagnosed gap, authority and independent-verification contract.",
        rejectedRoutes: selection.rejected,
        metrics: {
          correctlyResolved: true,
          autonomouslyCompleted: false,
          preciseHandoff: true,
          silentFalseCompletion: false,
        },
      });
    }

    const selected = selection.selected;
    const modeResult = await this.router.execute(selected.envelope);
    if (modeResult.status === "completed" && modeResult.parentCompleted && modeResult.parentResumed) {
      return this.receipt(goal, {
        status: "autonomous-completion",
        summary: modeResult.summary,
        selectedRouteId: selected.routeId,
        selectedFamily: selected.family,
        capabilityBundle: selected.bundle,
        modeResult,
        rejectedRoutes: selection.rejected,
        metrics: {
          correctlyResolved: true,
          autonomouslyCompleted: true,
          preciseHandoff: false,
          silentFalseCompletion: false,
        },
      });
    }

    if (modeResult.status === "handoff" || modeResult.status === "blocked" || modeResult.status === "plan-rejected") {
      return this.receipt(goal, {
        status: "precise-handoff",
        summary: modeResult.summary,
        selectedRouteId: selected.routeId,
        selectedFamily: selected.family,
        capabilityBundle: selected.bundle,
        modeResult,
        rejectedRoutes: selection.rejected,
        metrics: {
          correctlyResolved: true,
          autonomouslyCompleted: false,
          preciseHandoff: true,
          silentFalseCompletion: false,
        },
      });
    }

    return this.receipt(goal, {
      status: "unresolved-safe",
      summary: "The selected route did not establish independently verified parent-goal completion and was not reported as complete.",
      selectedRouteId: selected.routeId,
      selectedFamily: selected.family,
      capabilityBundle: selected.bundle,
      modeResult,
      rejectedRoutes: selection.rejected,
      metrics: {
        correctlyResolved: false,
        autonomouslyCompleted: false,
        preciseHandoff: false,
        silentFalseCompletion: false,
      },
    });
  }

  private receipt(
    goal: UniversalGoal,
    value: Omit<UniversalResolutionReceipt, "schemaVersion" | "tenantId" | "requestId" | "parentGoalId" | "resolvedAt" | "receiptDigest">,
  ): UniversalResolutionReceipt {
    const resolvedAt = this.now();
    const body = {
      schemaVersion: "1.0" as const,
      tenantId: goal.tenantId,
      requestId: goal.requestId,
      parentGoalId: goal.parentGoalId,
      ...value,
      resolvedAt,
    };
    return { ...body, receiptDigest: digest(body) };
  }
}
