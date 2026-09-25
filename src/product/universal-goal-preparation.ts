import { z } from "zod";
import {
  universalGoalSchema,
  type CapabilityGap,
  type UniversalAuthority,
  type UniversalGoal,
  type UniversalGoalSubmission,
} from "./universal-capability-contract.js";
import type { PreparedCapabilityRoute } from "./universal-capability-coordinator.js";

const identifier = z.string().min(1).max(180).regex(/^[a-zA-Z0-9_.-]+$/);

export const universalWorkflowProposalSchema = z.object({
  decision: z.enum(["select-workflow", "request-information", "policy-denied", "insufficient-evidence"]),
  workflowKey: z.union([identifier, z.null()]),
  evidenceIds: z.array(identifier).max(32),
  summary: z.string().trim().min(1).max(800),
  confidence: z.enum(["low", "medium", "high"]),
}).strict();
export type UniversalWorkflowProposal = z.infer<typeof universalWorkflowProposalSchema>;

export interface UniversalGoalObservation {
  id: string;
  source: "external-state" | "customer-config" | "trusted-runtime" | "user";
  summary: string;
}

export interface TrustedUniversalWorkflow {
  key: string;
  summary: string;
  requiredEvidenceIds: string[];
  gap: CapabilityGap;
  authority: UniversalAuthority;
  prepareRoutes(submission: UniversalGoalSubmission): Promise<PreparedCapabilityRoute[]> | PreparedCapabilityRoute[];
}

export interface TrustedUniversalScope {
  tenantId: string;
  scopeKey: string;
  observations: UniversalGoalObservation[];
  workflows: TrustedUniversalWorkflow[];
}

export interface UniversalScopeResolver {
  resolve(tenantId: string, scopeKey: string): Promise<TrustedUniversalScope | undefined> | TrustedUniversalScope | undefined;
}

export interface UniversalWorkflowPlanningInput {
  ordinaryGoal: string;
  observations: UniversalGoalObservation[];
  workflows: Array<{ key: string; summary: string; requiredEvidenceIds: string[] }>;
}

export interface UniversalWorkflowPlanner {
  propose(input: UniversalWorkflowPlanningInput): Promise<unknown>;
}

export interface UniversalPreparationCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface PreparedUniversalGoal {
  goal: UniversalGoal;
  routes: PreparedCapabilityRoute[];
  selectedWorkflowKey: string;
  proposed: UniversalWorkflowProposal;
  checks: UniversalPreparationCheck[];
}

export class UniversalGoalPreparationError extends Error {
  constructor(
    message: string,
    readonly reason: "unknown-scope" | "scope-mismatch" | "request-information" | "policy-denied" | "insufficient-evidence" | "invalid-proposal",
    readonly checks: UniversalPreparationCheck[] = [],
  ) {
    super(message);
    this.name = "UniversalGoalPreparationError";
  }
}

function unique(values: string[]): boolean {
  return new Set(values).size === values.length;
}

/**
 * Converts an ordinary goal into a trusted gap and route set. The planner may
 * select only a predeclared workflow key; every action, target, observation,
 * authority field and route remains customer-local trusted configuration.
 */
export class TrustedUniversalGoalPreparer {
  constructor(
    private readonly scopes: UniversalScopeResolver,
    private readonly planner: UniversalWorkflowPlanner,
  ) {}

  async prepare(submission: UniversalGoalSubmission): Promise<PreparedUniversalGoal> {
    const scope = await this.scopes.resolve(submission.tenantId, submission.scopeKey);
    if (!scope) throw new UniversalGoalPreparationError("The trusted customer-local scope was not found.", "unknown-scope");
    if (scope.tenantId !== submission.tenantId || scope.scopeKey !== submission.scopeKey) {
      throw new UniversalGoalPreparationError("The resolved scope identity does not match the submission.", "scope-mismatch");
    }
    if (!unique(scope.observations.map((item) => item.id)) || !unique(scope.workflows.map((item) => item.key))) {
      throw new UniversalGoalPreparationError("Trusted scope identifiers must be unique.", "scope-mismatch");
    }

    const raw = await this.planner.propose({
      ordinaryGoal: submission.ordinaryGoal,
      observations: structuredClone(scope.observations),
      workflows: scope.workflows.map((workflow) => ({
        key: workflow.key,
        summary: workflow.summary,
        requiredEvidenceIds: [...workflow.requiredEvidenceIds],
      })),
    });
    let proposed: UniversalWorkflowProposal;
    try {
      proposed = universalWorkflowProposalSchema.parse(raw);
    } catch {
      throw new UniversalGoalPreparationError("The workflow proposal failed strict validation.", "invalid-proposal");
    }

    const evidence = new Set(scope.observations.map((item) => item.id));
    const checks: UniversalPreparationCheck[] = [{
      id: "evidence-references",
      passed: proposed.evidenceIds.every((id) => evidence.has(id)),
      detail: "Every cited observation must exist in trusted customer-local state.",
    }];
    if (!checks[0]!.passed) {
      throw new UniversalGoalPreparationError("The proposal cited evidence that does not exist.", "invalid-proposal", checks);
    }
    if (proposed.decision !== "select-workflow") {
      const reason = proposed.decision;
      throw new UniversalGoalPreparationError(proposed.summary, reason, checks);
    }
    if (!proposed.workflowKey) {
      throw new UniversalGoalPreparationError("A selected workflow key is required.", "invalid-proposal", checks);
    }
    const workflow = scope.workflows.find((item) => item.key === proposed.workflowKey);
    checks.push({
      id: "workflow-exists",
      passed: Boolean(workflow),
      detail: "The selected workflow must be present in the trusted scope.",
    });
    if (!workflow) throw new UniversalGoalPreparationError("The proposed workflow is not trusted.", "invalid-proposal", checks);

    const citedEvidence = new Set(proposed.evidenceIds);
    const requiredEvidencePresent = workflow.requiredEvidenceIds.every((id) => evidence.has(id) && citedEvidence.has(id));
    checks.push({
      id: "workflow-evidence",
      passed: requiredEvidencePresent,
      detail: "Every workflow-specific trusted observation must exist and be cited.",
    });
    if (!requiredEvidencePresent) {
      throw new UniversalGoalPreparationError("There is insufficient trusted evidence to activate the selected workflow.", "insufficient-evidence", checks);
    }

    const goal = universalGoalSchema.parse({
      schemaVersion: "1.0",
      tenantId: submission.tenantId,
      requestId: submission.requestId,
      parentGoalId: submission.parentGoalId,
      ordinaryGoal: submission.ordinaryGoal,
      gap: structuredClone(workflow.gap),
      authority: structuredClone(workflow.authority),
    });
    const routes = await workflow.prepareRoutes(submission);
    checks.push({
      id: "bounded-routes",
      passed: routes.length > 0 && routes.length <= 64,
      detail: "Trusted preparation must return between one and sixty-four bounded route candidates.",
    });
    if (!checks.at(-1)!.passed) {
      throw new UniversalGoalPreparationError("Trusted workflow preparation returned no bounded routes.", "invalid-proposal", checks);
    }
    return { goal, routes, selectedWorkflowKey: workflow.key, proposed, checks };
  }
}

