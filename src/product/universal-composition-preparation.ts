import { createHash } from "node:crypto";
import { z } from "zod";
import {
  universalGoalSchema,
  type CapabilityGap,
  type UniversalAuthority,
  type UniversalGoalSubmission,
} from "./universal-capability-contract.js";
import type { PreparedCapabilityRoute } from "./universal-capability-coordinator.js";
import type {
  UniversalCompositionPlan,
  UniversalCompositionVerifier,
} from "./universal-composition.js";
import type { UniversalGoalObservation } from "./universal-goal-preparation.js";

const identifier = z.string().min(1).max(180).regex(/^[a-zA-Z0-9_.-]+$/);

export const universalCompositionProposalSchema = z.object({
  decision: z.enum(["select-composition", "request-information", "policy-denied", "insufficient-evidence"]),
  compositionKey: z.union([identifier, z.null()]),
  evidenceIds: z.array(identifier).max(64),
  summary: z.string().trim().min(1).max(1_000),
  confidence: z.enum(["low", "medium", "high"]),
}).strict();
export type UniversalCompositionProposal = z.infer<typeof universalCompositionProposalSchema>;

export interface TrustedUniversalCompositionWorkItem {
  workItemId: string;
  dependencies: string[];
  gap: CapabilityGap;
  authority: UniversalAuthority;
  prepareRoutes(input: {
    submission: UniversalGoalSubmission;
    workItemId: string;
    leafRequestId: string;
  }): Promise<PreparedCapabilityRoute[]> | PreparedCapabilityRoute[];
}

export interface TrustedUniversalComposition {
  key: string;
  summary: string;
  requiredEvidenceIds: string[];
  failurePolicy: "continue-independent" | "stop-all";
  workItems: TrustedUniversalCompositionWorkItem[];
  verifier: UniversalCompositionVerifier;
}

export interface TrustedUniversalCompositionScope {
  tenantId: string;
  scopeKey: string;
  observations: UniversalGoalObservation[];
  compositions: TrustedUniversalComposition[];
}

export interface UniversalCompositionScopeResolver {
  resolve(tenantId: string, scopeKey: string): Promise<TrustedUniversalCompositionScope | undefined> | TrustedUniversalCompositionScope | undefined;
}

export interface UniversalCompositionPlanner {
  propose(input: {
    ordinaryGoal: string;
    observations: UniversalGoalObservation[];
    compositions: Array<{
      key: string;
      summary: string;
      requiredEvidenceIds: string[];
      workItems: Array<{ workItemId: string; dependencies: string[] }>;
    }>;
  }): Promise<unknown>;
}

export interface PreparedUniversalComposition {
  plan: UniversalCompositionPlan;
  verifier: UniversalCompositionVerifier;
  selectedCompositionKey: string;
  proposed: UniversalCompositionProposal;
  checks: Array<{ id: string; passed: boolean; detail: string }>;
}

export class UniversalCompositionPreparationError extends Error {
  constructor(
    message: string,
    readonly reason: "unknown-scope" | "scope-mismatch" | "request-information" | "policy-denied" | "insufficient-evidence" | "invalid-proposal",
    readonly checks: Array<{ id: string; passed: boolean; detail: string }> = [],
  ) {
    super(message);
    this.name = "UniversalCompositionPreparationError";
  }
}

function unique(values: string[]): boolean {
  return new Set(values).size === values.length;
}

function leafRequestId(parentRequestId: string, workItemId: string): string {
  const readable = `${parentRequestId}-${workItemId}`;
  if (readable.length <= 180) return readable;
  return `leaf-${createHash("sha256").update(readable).digest("hex").slice(0, 32)}`;
}

/**
 * The model may choose one predeclared composition. Trusted customer-local
 * configuration owns the DAG, gaps, authority, route factories and aggregate
 * verifier; the caller and planner cannot invent a runtime or permission.
 */
export class TrustedUniversalCompositionPreparer {
  constructor(
    private readonly scopes: UniversalCompositionScopeResolver,
    private readonly planner: UniversalCompositionPlanner,
  ) {}

  async prepare(submission: UniversalGoalSubmission): Promise<PreparedUniversalComposition> {
    const scope = await this.scopes.resolve(submission.tenantId, submission.scopeKey);
    if (!scope) throw new UniversalCompositionPreparationError("The trusted composition scope was not found.", "unknown-scope");
    if (scope.tenantId !== submission.tenantId || scope.scopeKey !== submission.scopeKey) {
      throw new UniversalCompositionPreparationError("The trusted composition scope identity does not match the submission.", "scope-mismatch");
    }
    if (!unique(scope.observations.map((item) => item.id)) || !unique(scope.compositions.map((item) => item.key))) {
      throw new UniversalCompositionPreparationError("Trusted composition scope identifiers must be unique.", "scope-mismatch");
    }
    for (const composition of scope.compositions) {
      identifier.parse(composition.key);
      if (!unique(composition.workItems.map((item) => item.workItemId))) {
        throw new UniversalCompositionPreparationError(`Composition ${composition.key} has duplicate work-item identifiers.`, "scope-mismatch");
      }
    }

    const raw = await this.planner.propose({
      ordinaryGoal: submission.ordinaryGoal,
      observations: structuredClone(scope.observations),
      compositions: scope.compositions.map((composition) => ({
        key: composition.key,
        summary: composition.summary,
        requiredEvidenceIds: [...composition.requiredEvidenceIds],
        workItems: composition.workItems.map((item) => ({ workItemId: item.workItemId, dependencies: [...item.dependencies] })),
      })),
    });
    let proposed: UniversalCompositionProposal;
    try {
      proposed = universalCompositionProposalSchema.parse(raw);
    } catch {
      throw new UniversalCompositionPreparationError("The composition proposal failed strict validation.", "invalid-proposal");
    }

    const evidence = new Set(scope.observations.map((item) => item.id));
    const checks = [{
      id: "evidence-references",
      passed: proposed.evidenceIds.every((id) => evidence.has(id)),
      detail: "Every cited observation must exist in trusted customer-local state.",
    }];
    if (!checks[0]!.passed) {
      throw new UniversalCompositionPreparationError("The proposal cited evidence that does not exist.", "invalid-proposal", checks);
    }
    if (proposed.decision !== "select-composition") {
      throw new UniversalCompositionPreparationError(proposed.summary, proposed.decision, checks);
    }
    if (!proposed.compositionKey) {
      throw new UniversalCompositionPreparationError("A selected composition key is required.", "invalid-proposal", checks);
    }
    const composition = scope.compositions.find((item) => item.key === proposed.compositionKey);
    checks.push({
      id: "composition-exists",
      passed: Boolean(composition),
      detail: "The selected composition must be present in trusted customer-local configuration.",
    });
    if (!composition) {
      throw new UniversalCompositionPreparationError("The proposed composition is not trusted.", "invalid-proposal", checks);
    }
    const citedEvidence = new Set(proposed.evidenceIds);
    const evidencePassed = composition.requiredEvidenceIds.every((id) => evidence.has(id) && citedEvidence.has(id));
    checks.push({
      id: "composition-evidence",
      passed: evidencePassed,
      detail: "Every composition-specific trusted observation must exist and be cited.",
    });
    if (!evidencePassed) {
      throw new UniversalCompositionPreparationError("There is insufficient trusted evidence to activate the composition.", "insufficient-evidence", checks);
    }
    if (composition.workItems.length < 1 || composition.workItems.length > 32) {
      throw new UniversalCompositionPreparationError("A trusted composition must contain between one and 32 work items.", "scope-mismatch", checks);
    }

    const workItems = [];
    for (const trustedItem of composition.workItems) {
      const workItemId = identifier.parse(trustedItem.workItemId);
      const requestId = leafRequestId(submission.requestId, workItemId);
      const goal = universalGoalSchema.parse({
        schemaVersion: "1.0",
        tenantId: submission.tenantId,
        requestId,
        parentGoalId: submission.parentGoalId,
        ordinaryGoal: submission.ordinaryGoal,
        gap: structuredClone(trustedItem.gap),
        authority: structuredClone(trustedItem.authority),
      });
      const routes = await trustedItem.prepareRoutes({ submission, workItemId, leafRequestId: requestId });
      if (routes.length < 1 || routes.length > 32) {
        throw new UniversalCompositionPreparationError(`Trusted work item ${workItemId} returned no bounded routes.`, "invalid-proposal", checks);
      }
      workItems.push({ workItemId, dependencies: [...trustedItem.dependencies], goal, routes });
    }
    checks.push({
      id: "bounded-work-items",
      passed: workItems.length > 0 && workItems.every((item) => item.routes.length > 0),
      detail: "Every trusted composition work item has at least one bounded route candidate.",
    });
    return {
      plan: {
        schemaVersion: "1.0",
        tenantId: submission.tenantId,
        requestId: submission.requestId,
        parentGoalId: submission.parentGoalId,
        ordinaryGoal: submission.ordinaryGoal,
        failurePolicy: composition.failurePolicy,
        workItems,
      },
      verifier: composition.verifier,
      selectedCompositionKey: composition.key,
      proposed,
      checks,
    };
  }
}

