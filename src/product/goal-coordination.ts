import { createHash } from "node:crypto";
import { z } from "zod";
import type { AuthorityEnvelope, GoalCorrelation } from "./contracts.js";

export const GOAL_COORDINATION_SCHEMA_VERSION = "1.0" as const;

export type GoalHttpMethod = AuthorityEnvelope["allowedMethods"][number];

export interface TrustedGoalOperation {
  name: string;
  method: GoalHttpMethod;
  requiredCompanionActions?: string[];
}

export interface TrustedGoalSystem {
  targetAlias: string;
  credentialAliases: string[];
  operations: TrustedGoalOperation[];
}

export interface TrustedGoalEntity {
  alias: string;
  kind: string;
  systemAliases: string[];
}

export interface TrustedCompletionCriterion {
  key: string;
  summary: string;
  verifierKey: string;
}

export interface TrustedCoverageRequirement {
  key: string;
  entityAliases: string[];
  workflowKey: string;
  requiredActions: string[];
  targetAliases: string[];
  completionCriterionKeys: string[];
  dependsOnCoverageKeys?: string[];
}

/**
 * Trusted state supplied by the customer integration. Planner output cannot
 * add entities, systems, credentials, permissions, deadlines or completion
 * criteria to this envelope.
 */
export interface TrustedGoalScope {
  tenantId: string;
  parentGoalId: string;
  requestId: string;
  ordinaryGoal: string;
  deadline: { key: string; description: string };
  entities: TrustedGoalEntity[];
  systems: TrustedGoalSystem[];
  completionCriteria: TrustedCompletionCriterion[];
  requiredCoverage: TrustedCoverageRequirement[];
  authority: AuthorityEnvelope;
}

export interface ProposedGoalWorkItem {
  key: string;
  groupKey: string;
  groupLabel: string;
  summary: string;
  coverageKeys: string[];
  entityAliases: string[];
  workflowKey: string;
  requiredActions: string[];
  targetAliases: string[];
  completionCriterionKeys: string[];
  dependsOnKeys: string[];
}

export interface GoalPlanProposal {
  schemaVersion: typeof GOAL_COORDINATION_SCHEMA_VERSION;
  deadlineKey: string;
  summary: string;
  workItems: ProposedGoalWorkItem[];
}

const boundedKey = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);

export const proposedGoalWorkItemSchema: z.ZodType<ProposedGoalWorkItem> = z
  .object({
    key: boundedKey,
    groupKey: boundedKey,
    groupLabel: z.string().min(1).max(120),
    summary: z.string().min(1).max(500),
    coverageKeys: z.array(boundedKey).min(1).max(100),
    entityAliases: z.array(boundedKey).min(1).max(100),
    workflowKey: boundedKey,
    requiredActions: z.array(boundedKey).min(1).max(24),
    targetAliases: z.array(boundedKey).min(1).max(12),
    completionCriterionKeys: z.array(boundedKey).min(1).max(24),
    dependsOnKeys: z.array(boundedKey).max(100),
  })
  .strict();

export const goalPlanProposalSchema: z.ZodType<GoalPlanProposal> = z
  .object({
    schemaVersion: z.literal(GOAL_COORDINATION_SCHEMA_VERSION),
    deadlineKey: boundedKey,
    summary: z.string().min(1).max(800),
    workItems: z.array(proposedGoalWorkItemSchema).min(1).max(100),
  })
  .strict();

export interface GoalPlanValidationCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface GoalWorkItemAuthorityRequirement {
  targetAliases: string[];
  credentialAliases: string[];
  methods: GoalHttpMethod[];
  writeRequired: boolean;
  currentlyAuthorized: boolean;
  missing: string[];
}

export interface ValidatedGoalWorkItem {
  workItemId: string;
  key: string;
  groupId: string;
  groupKey: string;
  groupLabel: string;
  summary: string;
  coverageKeys: string[];
  entityAliases: string[];
  workflowKey: string;
  requiredActions: string[];
  targetAliases: string[];
  completionCriteria: TrustedCompletionCriterion[];
  dependencyWorkItemIds: string[];
  executionOrder: number;
  operationKey: string;
  authority: GoalWorkItemAuthorityRequirement;
  correlation: GoalCorrelation;
}

export interface ValidatedGoalPlan {
  schemaVersion: typeof GOAL_COORDINATION_SCHEMA_VERSION;
  tenantId: string;
  parentGoalId: string;
  requestId: string;
  ordinaryGoal: string;
  deadline: TrustedGoalScope["deadline"];
  summary: string;
  planVersion: 1;
  validationReceiptId: string;
  checks: GoalPlanValidationCheck[];
  executionMode: "conservative-sequential";
  workItems: ValidatedGoalWorkItem[];
}

export type GoalPlanValidationResult =
  | { status: "validated"; plan: ValidatedGoalPlan }
  | { status: "rejected"; checks: GoalPlanValidationCheck[] };

export interface GoalPlanner {
  propose(
    scope: TrustedGoalScope,
    repair?: { previousProposal: GoalPlanProposal; failedChecks: GoalPlanValidationCheck[] },
  ): Promise<GoalPlanProposal>;
}

export type GoalPlanCompilationResult =
  | { status: "validated"; plan: ValidatedGoalPlan; attempts: number }
  | { status: "rejected"; checks: GoalPlanValidationCheck[]; attempts: number };

/** Bounded model proposal/repair loop; trusted validation remains the only activation gate. */
export class GoalPlanCompiler {
  constructor(
    private readonly planner: GoalPlanner,
    private readonly maxAttempts = 2,
  ) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
      throw new Error("Goal plan compilation allows between one and three bounded attempts.");
    }
  }

  async compile(scope: TrustedGoalScope): Promise<GoalPlanCompilationResult> {
    let repair: Parameters<GoalPlanner["propose"]>[1];
    let lastChecks: GoalPlanValidationCheck[] = [];
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const proposal = goalPlanProposalSchema.parse(await this.planner.propose(scope, repair));
      const validation = validateGoalPlan(proposal, scope);
      if (validation.status === "validated") {
        return { status: "validated", plan: validation.plan, attempts: attempt };
      }
      lastChecks = validation.checks;
      repair = {
        previousProposal: proposal,
        failedChecks: validation.checks.filter((check) => !check.passed),
      };
    }
    return { status: "rejected", checks: lastChecks, attempts: this.maxAttempts };
  }
}

function stableId(namespace: string, ...parts: string[]): string {
  return createHash("sha256")
    .update([namespace, ...parts].join("\u001f"))
    .digest("hex")
    .slice(0, 32);
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function nonEmptyBounded(value: string, max: number): boolean {
  return value.trim().length > 0 && value.length <= max;
}

function topologicalOrder(items: ProposedGoalWorkItem[]): string[] | null {
  const byKey = new Map(items.map((item) => [item.key, item]));
  const proposalPosition = new Map(items.map((item, index) => [item.key, index]));
  const incoming = new Map(items.map((item) => [item.key, item.dependsOnKeys.length]));
  const dependents = new Map(items.map((item) => [item.key, [] as string[]]));
  for (const item of items) {
    for (const dependency of item.dependsOnKeys) dependents.get(dependency)?.push(item.key);
  }
  const ready = [...incoming.entries()]
    .filter(([, count]) => count === 0)
    .map(([key]) => key)
    .sort((left, right) => proposalPosition.get(left)! - proposalPosition.get(right)!);
  const ordered: string[] = [];
  while (ready.length > 0) {
    const key = ready.shift()!;
    if (!byKey.has(key)) return null;
    ordered.push(key);
    for (const dependent of dependents.get(key) ?? []) {
      const remaining = (incoming.get(dependent) ?? 0) - 1;
      incoming.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort((left, right) => proposalPosition.get(left)! - proposalPosition.get(right)!);
      }
    }
  }
  return ordered.length === items.length ? ordered : null;
}

function authorityFor(
  item: ProposedGoalWorkItem,
  scope: TrustedGoalScope,
): GoalWorkItemAuthorityRequirement {
  const systems = item.targetAliases.flatMap((alias) =>
    scope.systems.filter((system) => system.targetAlias === alias),
  );
  const operations = item.requiredActions.flatMap((action) =>
    systems.flatMap((system) => system.operations.filter((operation) => operation.name === action)),
  );
  const methods = [...new Set(operations.map((operation) => operation.method))];
  const credentialAliases = [...new Set(systems.flatMap((system) => system.credentialAliases))];
  const writeRequired = methods.some((method) => method !== "GET");
  const missing: string[] = [];
  for (const target of item.targetAliases) {
    if (!scope.authority.allowedTargetAliases.includes(target)) missing.push(`target:${target}`);
  }
  for (const credential of credentialAliases) {
    if (!scope.authority.allowedSecretAliases.includes(credential)) missing.push(`credential:${credential}`);
  }
  for (const method of methods) {
    if (!scope.authority.allowedMethods.includes(method)) missing.push(`method:${method}`);
  }
  if (writeRequired && scope.authority.writeAuthority === "denied") missing.push("write-authority");
  if (
    writeRequired &&
    scope.authority.writeAuthority === "per-action-approval" &&
    item.requiredActions.some((action) =>
      operations.some((operation) => operation.name === action && operation.method !== "GET") &&
      !scope.authority.approvedWriteActions.includes(action),
    )
  ) {
    missing.push("per-action-approval");
  }
  return {
    targetAliases: [...item.targetAliases],
    credentialAliases,
    methods,
    writeRequired,
    currentlyAuthorized: missing.length === 0,
    missing,
  };
}

export function validateGoalPlan(
  proposal: GoalPlanProposal,
  scope: TrustedGoalScope,
): GoalPlanValidationResult {
  const checks: GoalPlanValidationCheck[] = [];
  const record = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });

  record(
    "schema-version",
    proposal.schemaVersion === GOAL_COORDINATION_SCHEMA_VERSION,
    "The proposal must use the supported coordination schema.",
  );
  record(
    "deadline-boundary",
    proposal.deadlineKey === scope.deadline.key,
    "The proposal must preserve the trusted deadline boundary exactly.",
  );
  record(
    "bounded-summary",
    nonEmptyBounded(proposal.summary, 800),
    "The proposal summary must be non-empty and bounded.",
  );
  record(
    "bounded-plan",
    proposal.workItems.length > 0 && proposal.workItems.length <= 100,
    "A plan must contain between one and one hundred work items.",
  );

  const keys = proposal.workItems.map((item) => item.key);
  record("unique-work-keys", unique(keys), "Planner-local work-item keys must be unique.");

  const knownEntities = new Set(scope.entities.map((entity) => entity.alias));
  const knownTargets = new Set(scope.systems.map((system) => system.targetAlias));
  const criteria = new Map(scope.completionCriteria.map((criterion) => [criterion.key, criterion]));
  const coverage = new Map(scope.requiredCoverage.map((requirement) => [requirement.key, requirement]));
  const allCoverage = proposal.workItems.flatMap((item) => item.coverageKeys);
  record(
    "complete-coverage",
    unique(allCoverage) && sameSet(allCoverage, [...coverage.keys()]),
    "Every trusted coverage requirement must appear exactly once, with no invented coverage.",
  );

  for (const item of proposal.workItems) {
    record(
      `item:${item.key}:bounded-fields`,
      nonEmptyBounded(item.key, 100) &&
        nonEmptyBounded(item.groupKey, 100) &&
        nonEmptyBounded(item.groupLabel, 120) &&
        nonEmptyBounded(item.summary, 500) &&
        nonEmptyBounded(item.workflowKey, 120),
      "Work-item identifiers, labels, workflow and summary must be non-empty and bounded.",
    );
    record(
      `item:${item.key}:known-entities`,
      item.entityAliases.length > 0 && unique(item.entityAliases) && item.entityAliases.every((alias) => knownEntities.has(alias)),
      "Every work-item entity must come from trusted scope.",
    );
    record(
      `item:${item.key}:known-targets`,
      item.targetAliases.length > 0 && unique(item.targetAliases) && item.targetAliases.every((alias) => knownTargets.has(alias)),
      "Every work-item target must come from trusted scope.",
    );
    record(
      `item:${item.key}:known-criteria`,
      item.completionCriterionKeys.length > 0 &&
        unique(item.completionCriterionKeys) &&
        item.completionCriterionKeys.every((key) => criteria.has(key)),
      "Completion criteria must be selected from trusted verifier contracts.",
    );
    record(
      `item:${item.key}:known-dependencies`,
      unique(item.dependsOnKeys) &&
        !item.dependsOnKeys.includes(item.key) &&
        item.dependsOnKeys.every((key) => keys.includes(key)),
      "Dependencies must refer to other proposed work-item keys.",
    );

    const selectedSystems = item.targetAliases.flatMap((alias) =>
      scope.systems.filter((system) => system.targetAlias === alias),
    );
    const documented = new Set(selectedSystems.flatMap((system) => system.operations.map((operation) => operation.name)));
    const requiredCompanions = item.requiredActions.flatMap((action) =>
      selectedSystems.flatMap((system) =>
        system.operations
          .filter((operation) => operation.name === action)
          .flatMap((operation) => operation.requiredCompanionActions ?? []),
      ),
    );
    record(
      `item:${item.key}:documented-actions`,
      item.requiredActions.length > 0 && unique(item.requiredActions) && item.requiredActions.every((action) => documented.has(action)),
      "Every requested action must be documented on a trusted selected system.",
    );
    record(
      `item:${item.key}:companion-actions`,
      requiredCompanions.every((action) => item.requiredActions.includes(action)),
      "All trusted safety companion actions must be present.",
    );

    for (const coverageKey of item.coverageKeys) {
      const requirement = coverage.get(coverageKey);
      if (!requirement) continue;
      record(
        `item:${item.key}:coverage:${coverageKey}`,
        sameSet(item.entityAliases, requirement.entityAliases) &&
          item.workflowKey === requirement.workflowKey &&
          sameSet(item.requiredActions, requirement.requiredActions) &&
          sameSet(item.targetAliases, requirement.targetAliases) &&
          sameSet(item.completionCriterionKeys, requirement.completionCriterionKeys),
        "The proposed work item must match the trusted requirement it claims to cover.",
      );
    }
  }

  const orderedKeys = topologicalOrder(proposal.workItems);
  record("acyclic-dependencies", orderedKeys !== null, "The dependency graph must be complete and acyclic.");

  for (const requirement of scope.requiredCoverage) {
    const item = proposal.workItems.find((candidate) => candidate.coverageKeys.includes(requirement.key));
    if (!item) continue;
    const actualDependencies = item.dependsOnKeys.flatMap((key) =>
      proposal.workItems.find((candidate) => candidate.key === key)?.coverageKeys ?? [],
    );
    record(
      `coverage:${requirement.key}:trusted-dependencies`,
      sameSet(actualDependencies, requirement.dependsOnCoverageKeys ?? []),
      "Trusted dependency requirements must be preserved exactly.",
    );
  }

  if (checks.some((check) => !check.passed) || !orderedKeys) return { status: "rejected", checks };

  const itemIds = new Map(
    proposal.workItems.map((item) => [
      item.key,
      stableId("goal-work-item-v1", scope.tenantId, scope.parentGoalId, item.key),
    ]),
  );
  const workItems = orderedKeys.map((key, index) => {
    const item = proposal.workItems.find((candidate) => candidate.key === key)!;
    const workItemId = itemIds.get(key)!;
    const groupId = stableId("goal-group-v1", scope.tenantId, scope.parentGoalId, item.groupKey);
    return {
      workItemId,
      key: item.key,
      groupId,
      groupKey: item.groupKey,
      groupLabel: item.groupLabel,
      summary: item.summary,
      coverageKeys: [...item.coverageKeys],
      entityAliases: [...item.entityAliases],
      workflowKey: item.workflowKey,
      requiredActions: [...item.requiredActions],
      targetAliases: [...item.targetAliases],
      completionCriteria: item.completionCriterionKeys.map((criterionKey) => criteria.get(criterionKey)!),
      dependencyWorkItemIds: item.dependsOnKeys.map((dependency) => itemIds.get(dependency)!),
      executionOrder: index + 1,
      operationKey: stableId("goal-operation-v1", scope.tenantId, scope.parentGoalId, workItemId),
      authority: authorityFor(item, scope),
      correlation: { parentGoalId: scope.parentGoalId, workItemId, groupId },
    } satisfies ValidatedGoalWorkItem;
  });

  return {
    status: "validated",
    plan: {
      schemaVersion: GOAL_COORDINATION_SCHEMA_VERSION,
      tenantId: scope.tenantId,
      parentGoalId: scope.parentGoalId,
      requestId: scope.requestId,
      ordinaryGoal: scope.ordinaryGoal,
      deadline: structuredClone(scope.deadline),
      summary: proposal.summary,
      planVersion: 1,
      validationReceiptId: stableId(
        "goal-plan-validation-v1",
        scope.tenantId,
        scope.parentGoalId,
        JSON.stringify(proposal),
      ),
      checks,
      executionMode: "conservative-sequential",
      workItems,
    },
  };
}
