import { createHash } from "node:crypto";
import { z } from "zod";
import {
  universalGoalSchema,
  type CapabilityBundle,
  type UniversalGoal,
  type UniversalResolutionStatus,
} from "./universal-capability-contract.js";
import {
  UniversalCapabilityCoordinator,
  type PreparedCapabilityRoute,
  type UniversalResolutionReceipt,
} from "./universal-capability-coordinator.js";

const identifier = z.string().min(1).max(180).regex(/^[a-zA-Z0-9_.-]+$/);

export const universalCompositionMetadataSchema = z.object({
  schemaVersion: z.literal("1.0"),
  tenantId: identifier,
  requestId: identifier,
  parentGoalId: identifier,
  ordinaryGoal: z.string().trim().min(1).max(4_000),
  failurePolicy: z.enum(["continue-independent", "stop-all"]),
}).strict();
export type UniversalCompositionMetadata = z.infer<typeof universalCompositionMetadataSchema>;

export interface UniversalCompositionWorkItem {
  workItemId: string;
  dependencies: string[];
  goal: UniversalGoal;
  routes: PreparedCapabilityRoute[];
}

export interface UniversalCompositionPlan extends UniversalCompositionMetadata {
  workItems: UniversalCompositionWorkItem[];
}

export interface UniversalCompositionOutcome {
  passed: boolean;
  incorrectSideEffects: number;
  stateDigest: string;
  detail: string;
}

export interface UniversalCompositionVerifier {
  readonly key: string;
  readonly sourceId: string;
  readonly kind: "independent-external-state";
  verify(input: {
    plan: UniversalCompositionPlan;
    leafReceipts: UniversalResolutionReceipt[];
  }): Promise<UniversalCompositionOutcome>;
  quarantine?(input: {
    bundles: CapabilityBundle[];
    outcome: UniversalCompositionOutcome;
  }): Promise<void>;
}

export type CompositionLeafStatus = UniversalResolutionStatus | "skipped-dependency" | "skipped-policy";

export interface UniversalCompositionLeafReceipt {
  workItemId: string;
  dependencies: string[];
  status: CompositionLeafStatus;
  summary: string;
  resolution?: UniversalResolutionReceipt;
}

export interface UniversalCompositionReceipt {
  schemaVersion: "1.0";
  tenantId: string;
  requestId: string;
  parentGoalId: string;
  status: UniversalResolutionStatus;
  parentResumed: boolean;
  parentCompleted: boolean;
  summary: string;
  leafReceipts: UniversalCompositionLeafReceipt[];
  aggregateOutcome?: UniversalCompositionOutcome;
  completedAt: string;
  receiptDigest: string;
}

export function isUniversalCompositionReceipt(value: unknown): value is UniversalCompositionReceipt {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === "1.0"
    && typeof record.tenantId === "string"
    && typeof record.requestId === "string"
    && typeof record.parentGoalId === "string"
    && ["autonomous-completion", "precise-handoff", "unresolved-safe"].includes(String(record.status))
    && typeof record.parentResumed === "boolean"
    && typeof record.parentCompleted === "boolean"
    && typeof record.summary === "string"
    && Array.isArray(record.leafReceipts)
    && record.leafReceipts.every((leaf) => {
      if (!leaf || typeof leaf !== "object") return false;
      const item = leaf as Record<string, unknown>;
      return typeof item.workItemId === "string"
        && Array.isArray(item.dependencies)
        && ["autonomous-completion", "precise-handoff", "unresolved-safe", "skipped-dependency", "skipped-policy"].includes(String(item.status))
        && typeof item.summary === "string";
    })
    && typeof record.completedAt === "string"
    && typeof record.receiptDigest === "string"
    && /^[a-f0-9]{64}$/.test(record.receiptDigest);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validatePlan(rawPlan: UniversalCompositionPlan): UniversalCompositionPlan {
  const { workItems: rawWorkItems, ...rawMetadata } = rawPlan;
  const metadata = universalCompositionMetadataSchema.parse(rawMetadata);
  if (!Array.isArray(rawWorkItems) || rawWorkItems.length < 1 || rawWorkItems.length > 32) {
    throw new Error("A universal composition must contain between one and 32 bounded work items.");
  }
  const ids = new Set<string>();
  const requestIds = new Set<string>();
  const parsedItems = rawWorkItems.map((rawItem) => {
    const workItemId = identifier.parse(rawItem.workItemId);
    if (ids.has(workItemId)) throw new Error(`Duplicate composition work item: ${workItemId}`);
    ids.add(workItemId);
    const dependencies = z.array(identifier).max(31).parse(rawItem.dependencies);
    if (new Set(dependencies).size !== dependencies.length) throw new Error(`Duplicate dependency on work item: ${workItemId}`);
    if (!Array.isArray(rawItem.routes) || rawItem.routes.length > 32) throw new Error(`Invalid route set for work item: ${workItemId}`);
    const goal = universalGoalSchema.parse(rawItem.goal);
    if (requestIds.has(goal.requestId)) throw new Error(`Duplicate leaf request identity: ${goal.requestId}`);
    requestIds.add(goal.requestId);
    if (goal.tenantId !== metadata.tenantId || goal.parentGoalId !== metadata.parentGoalId || goal.ordinaryGoal !== metadata.ordinaryGoal) {
      throw new Error(`Composition work item ${workItemId} changed immutable parent-goal identity.`);
    }
    return { workItemId, dependencies, goal, routes: [...rawItem.routes] };
  });
  for (const item of parsedItems) {
    for (const dependency of item.dependencies) {
      if (dependency === item.workItemId) throw new Error(`Composition work item ${item.workItemId} depends on itself.`);
      if (!ids.has(dependency)) throw new Error(`Composition work item ${item.workItemId} has an unknown dependency: ${dependency}`);
    }
  }
  topologicalOrder(parsedItems);
  return { ...metadata, workItems: parsedItems };
}

function topologicalOrder(workItems: UniversalCompositionWorkItem[]): UniversalCompositionWorkItem[] {
  const byId = new Map(workItems.map((item) => [item.workItemId, item]));
  const temporary = new Set<string>();
  const permanent = new Set<string>();
  const ordered: UniversalCompositionWorkItem[] = [];
  const visit = (id: string) => {
    if (permanent.has(id)) return;
    if (temporary.has(id)) throw new Error("Universal composition contains a dependency cycle.");
    temporary.add(id);
    const item = byId.get(id);
    if (!item) throw new Error(`Unknown composition work item: ${id}`);
    for (const dependency of [...item.dependencies].sort()) visit(dependency);
    temporary.delete(id);
    permanent.add(id);
    ordered.push(item);
  };
  for (const id of [...byId.keys()].sort()) visit(id);
  return ordered;
}

/**
 * Executes a trusted bounded DAG. Each leaf keeps its own runtime family,
 * authority, verifier and recovery contract. The parent completes only after
 * every leaf and one independent aggregate external-state verifier pass.
 */
export class UniversalCompositionCoordinator {
  constructor(
    private readonly leafCoordinator: UniversalCapabilityCoordinator,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async resolve(rawPlan: UniversalCompositionPlan, verifier: UniversalCompositionVerifier): Promise<UniversalCompositionReceipt> {
    const plan = validatePlan(rawPlan);
    if (verifier.kind !== "independent-external-state") throw new Error("Composition requires an independent external-state verifier.");
    identifier.parse(verifier.key);
    identifier.parse(verifier.sourceId);

    const leaves: UniversalCompositionLeafReceipt[] = [];
    const byId = new Map<string, UniversalCompositionLeafReceipt>();
    let stoppedByPolicy = false;

    for (const item of topologicalOrder(plan.workItems)) {
      const unresolvedDependency = item.dependencies.find((dependency) => byId.get(dependency)?.status !== "autonomous-completion");
      if (unresolvedDependency) {
        const leaf = {
          workItemId: item.workItemId,
          dependencies: [...item.dependencies],
          status: "skipped-dependency" as const,
          summary: `Not executed because dependency ${unresolvedDependency} did not complete with independent verification.`,
        };
        leaves.push(leaf);
        byId.set(item.workItemId, leaf);
        continue;
      }
      if (stoppedByPolicy) {
        const leaf = {
          workItemId: item.workItemId,
          dependencies: [...item.dependencies],
          status: "skipped-policy" as const,
          summary: "Not executed because the trusted composition uses stop-all failure policy.",
        };
        leaves.push(leaf);
        byId.set(item.workItemId, leaf);
        continue;
      }

      let resolution: UniversalResolutionReceipt;
      try {
        resolution = await this.leafCoordinator.resolve(item.goal, item.routes);
      } catch (error) {
        const leaf = {
          workItemId: item.workItemId,
          dependencies: [...item.dependencies],
          status: "unresolved-safe" as const,
          summary: `The leaf resolver failed closed: ${error instanceof Error ? error.message : String(error)}`,
        };
        leaves.push(leaf);
        byId.set(item.workItemId, leaf);
        if (plan.failurePolicy === "stop-all") stoppedByPolicy = true;
        continue;
      }
      const leaf = {
        workItemId: item.workItemId,
        dependencies: [...item.dependencies],
        status: resolution.status,
        summary: resolution.summary,
        resolution,
      };
      leaves.push(leaf);
      byId.set(item.workItemId, leaf);
      if (resolution.status !== "autonomous-completion" && plan.failurePolicy === "stop-all") stoppedByPolicy = true;
    }

    const completedLeaves = leaves
      .map((leaf) => leaf.resolution)
      .filter((receipt): receipt is UniversalResolutionReceipt => receipt?.status === "autonomous-completion");
    if (completedLeaves.length !== plan.workItems.length) {
      const hasUnresolved = leaves.some((leaf) => leaf.status === "unresolved-safe");
      return this.receipt(plan, {
        status: hasUnresolved ? "unresolved-safe" : "precise-handoff",
        parentResumed: false,
        parentCompleted: false,
        summary: "The broad goal did not complete because one or more required capability leaves were unresolved, blocked or safely skipped.",
        leafReceipts: leaves,
      });
    }

    let aggregateOutcome: UniversalCompositionOutcome;
    try {
      aggregateOutcome = await verifier.verify({ plan, leafReceipts: completedLeaves });
    } catch (error) {
      return this.receipt(plan, {
        status: "unresolved-safe",
        parentResumed: false,
        parentCompleted: false,
        summary: `The aggregate external-state verifier failed closed: ${error instanceof Error ? error.message : String(error)}`,
        leafReceipts: leaves,
      });
    }
    if (!aggregateOutcome.passed || aggregateOutcome.incorrectSideEffects !== 0 || !/^[a-f0-9]{64}$/.test(aggregateOutcome.stateDigest)) {
      const bundles = completedLeaves
        .map((receipt) => receipt.capabilityBundle)
        .filter((bundle): bundle is CapabilityBundle => bundle !== undefined);
      await verifier.quarantine?.({ bundles, outcome: aggregateOutcome });
      return this.receipt(plan, {
        status: "unresolved-safe",
        parentResumed: false,
        parentCompleted: false,
        summary: "Leaf actions completed, but the independent aggregate outcome contract did not pass. The parent was not reported complete.",
        leafReceipts: leaves,
        aggregateOutcome,
      });
    }

    return this.receipt(plan, {
      status: "autonomous-completion",
      parentResumed: true,
      parentCompleted: true,
      summary: "Every required capability leaf and the independent aggregate external-state contract passed; the original broad goal resumed and completed.",
      leafReceipts: leaves,
      aggregateOutcome,
    });
  }

  private receipt(
    plan: UniversalCompositionPlan,
    value: Omit<UniversalCompositionReceipt, "schemaVersion" | "tenantId" | "requestId" | "parentGoalId" | "completedAt" | "receiptDigest">,
  ): UniversalCompositionReceipt {
    const completedAt = this.now();
    const body = {
      schemaVersion: "1.0" as const,
      tenantId: plan.tenantId,
      requestId: plan.requestId,
      parentGoalId: plan.parentGoalId,
      ...value,
      completedAt,
    };
    return { ...body, receiptDigest: digest(body) };
  }
}
