import { createHash } from "node:crypto";
import { z } from "zod";
import { executionRiskSchema, type ExecutionRisk } from "./universal-capability-contract.js";

const identifier = z.string().min(1).max(180).regex(/^[a-zA-Z0-9_.-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const boundedText = z.string().trim().min(1).max(2_000);

export const artifactClassificationSchema = z.enum(["public", "internal", "confidential", "restricted"]);
export type ArtifactClassification = z.infer<typeof artifactClassificationSchema>;

export const primitiveInputSchema = z.object({
  key: identifier,
  schemaKey: identifier,
  allowedSources: z.array(z.enum(["trusted-config", "trusted-evidence", "verified-artifact", "trusted-literal"]))
    .min(1).max(4),
  maximumClassification: artifactClassificationSchema,
}).strict();
export type PrimitiveInput = z.infer<typeof primitiveInputSchema>;

export const primitiveOutputSchema = z.object({
  key: identifier,
  schemaKey: identifier,
  classification: artifactClassificationSchema,
}).strict();
export type PrimitiveOutput = z.infer<typeof primitiveOutputSchema>;

export const trustedActionPrimitiveSchema = z.object({
  key: identifier,
  version: identifier,
  effect: boundedText,
  targetAlias: identifier,
  actionKey: identifier,
  maximumRisk: executionRiskSchema,
  requiredApprovalKeys: z.array(identifier).max(32),
  inputs: z.array(primitiveInputSchema).max(32),
  outputs: z.array(primitiveOutputSchema).max(32),
  routeBuilderKeys: z.array(identifier).min(1).max(16),
  requiredObservationKeys: z.array(identifier).min(1).max(32),
  verifierTemplateKey: identifier,
  idempotency: z.enum(["required", "not-applicable", "unavailable"]),
  provenanceDigest: digest,
  enabled: z.boolean(),
}).strict().superRefine((value, context) => {
  for (const [label, keys] of [
    ["input", value.inputs.map((item) => item.key)],
    ["output", value.outputs.map((item) => item.key)],
  ] as const) {
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: "custom", message: `Primitive ${label} keys must be unique.` });
    }
  }
});
export type TrustedActionPrimitive = z.infer<typeof trustedActionPrimitiveSchema>;

export const trustedPlanningEvidenceSchema = z.object({
  evidenceId: identifier,
  digest,
  summary: boundedText,
  permittedPrimitiveKeys: z.array(identifier).min(1).max(128),
}).strict();
export type TrustedPlanningEvidence = z.infer<typeof trustedPlanningEvidenceSchema>;

export const trustedValueDescriptorSchema = z.object({
  key: identifier,
  schemaKey: identifier,
  classification: artifactClassificationSchema,
  digest,
}).strict();
export type TrustedValueDescriptor = z.infer<typeof trustedValueDescriptorSchema>;

/** Strict trusted value provenance bound to one planning-evidence item. */
export const trustedEvidenceValueDescriptorSchema = trustedValueDescriptorSchema.extend({
  evidenceId: identifier,
}).strict();
export type TrustedEvidenceValueDescriptor = z.infer<typeof trustedEvidenceValueDescriptorSchema>;

const bindingBase = z.object({ inputKey: identifier }).strict();
export const graphInputBindingSchema = z.discriminatedUnion("kind", [
  bindingBase.extend({ kind: z.literal("trusted-config"), valueKey: identifier }).strict(),
  bindingBase.extend({ kind: z.literal("trusted-evidence"), evidenceId: identifier, valueKey: identifier }).strict(),
  bindingBase.extend({ kind: z.literal("verified-artifact"), producerWorkItemId: identifier, outputKey: identifier }).strict(),
  bindingBase.extend({ kind: z.literal("trusted-literal"), literalKey: identifier }).strict(),
]);
export type GraphInputBinding = z.infer<typeof graphInputBindingSchema>;

export const graphWorkItemProposalSchema = z.object({
  workItemId: identifier,
  primitiveKey: identifier,
  primitiveVersion: identifier,
  citedEvidenceIds: z.array(identifier).min(1).max(32),
  dependsOn: z.array(identifier).max(32),
  bindings: z.array(graphInputBindingSchema).max(32),
}).strict();
export type GraphWorkItemProposal = z.infer<typeof graphWorkItemProposalSchema>;

export const capabilityResolutionGraphProposalSchema = z.object({
  schemaVersion: z.literal("1.0"),
  decision: z.literal("compile"),
  tenantId: identifier,
  requestId: identifier,
  parentGoalId: identifier,
  ordinaryGoalDigest: digest,
  summary: boundedText,
  workItems: z.array(graphWorkItemProposalSchema).min(1).max(32),
  terminalOutputs: z.array(z.object({ workItemId: identifier, outputKey: identifier }).strict()).min(1).max(32),
}).strict();
export type CapabilityResolutionGraphProposal = z.infer<typeof capabilityResolutionGraphProposalSchema>;

export interface CapabilityResolutionAuthority {
  targetAliases: string[];
  actionKeys: string[];
  approvalKeys: string[];
  maximumRisk: ExecutionRisk;
}

export interface CapabilityResolutionCompilerContext {
  identity: {
    tenantId: string;
    requestId: string;
    parentGoalId: string;
    ordinaryGoalDigest: string;
  };
  primitives: TrustedActionPrimitive[];
  evidence: TrustedPlanningEvidence[];
  trustedConfigValues: TrustedValueDescriptor[];
  trustedLiteralValues: TrustedValueDescriptor[];
  evidenceValues: TrustedEvidenceValueDescriptor[];
  enabledRouteBuilderKeys: string[];
  enabledObservationKeys: string[];
  enabledVerifierTemplateKeys: string[];
  authority: CapabilityResolutionAuthority;
  aggregateVerifier: {
    key: string;
    requiredTerminalOutputs: Array<{ workItemId: string; outputKey: string }>;
  };
}

export interface CompiledCapabilityResolutionPlan {
  schemaVersion: "1.0";
  planId: string;
  tenantId: string;
  requestId: string;
  parentGoalId: string;
  ordinaryGoalDigest: string;
  primitiveRegistryDigest: string;
  verifierRegistryDigest: string;
  aggregateVerifierKey: string;
  orderedWorkItems: Array<{
    workItemId: string;
    primitiveKey: string;
    primitiveVersion: string;
    targetAlias: string;
    actionKey: string;
    maximumRisk: ExecutionRisk;
    requiredApprovalKeys: string[];
    dependsOn: string[];
    bindings: GraphInputBinding[];
    outputSchemas: PrimitiveOutput[];
    routeBuilderKeys: string[];
    observationKeys: string[];
    verifierTemplateKey: string;
    idempotency: TrustedActionPrimitive["idempotency"];
  }>;
  terminalOutputs: Array<{ workItemId: string; outputKey: string }>;
  planDigest: string;
}

export interface CapabilityResolutionCompilationResult {
  status: "compiled" | "rejected";
  plan?: CompiledCapabilityResolutionPlan;
  errors: Array<{ code: string; detail: string; workItemId?: string }>;
}

const riskRank: Readonly<Record<ExecutionRisk, number>> = {
  "read-only": 0,
  "reversible-write": 1,
  "consequential-write": 2,
  "privileged-control": 3,
  "physical-action": 4,
};
const classificationRank: Readonly<Record<ArtifactClassification, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sameOutputSet(
  left: Array<{ workItemId: string; outputKey: string }>,
  right: Array<{ workItemId: string; outputKey: string }>,
): boolean {
  const normalize = (items: typeof left) => items.map((item) => `${item.workItemId}:${item.outputKey}`).sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function topologicalOrder(workItems: GraphWorkItemProposal[]): string[] | undefined {
  const ids = new Set(workItems.map((item) => item.workItemId));
  if (ids.size !== workItems.length) return undefined;
  const remaining = new Map(workItems.map((item) => [item.workItemId, new Set(item.dependsOn)]));
  if ([...remaining.values()].some((dependencies) => [...dependencies].some((dependency) => !ids.has(dependency)))) return undefined;
  const ordered: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([id]) => id)
      .sort();
    if (ready.length === 0) return undefined;
    for (const id of ready) {
      ordered.push(id);
      remaining.delete(id);
      for (const dependencies of remaining.values()) dependencies.delete(id);
    }
  }
  return ordered;
}

/**
 * Compiles model-compatible semantic proposals into execution plans. The
 * proposal can choose only existing keys. Authority, schemas, executable
 * routes, observers and completion truth remain customer-local trusted data.
 */
export function compileCapabilityResolutionGraph(
  rawProposal: unknown,
  context: CapabilityResolutionCompilerContext,
): CapabilityResolutionCompilationResult {
  const parsed = capabilityResolutionGraphProposalSchema.safeParse(rawProposal);
  if (!parsed.success) {
    return { status: "rejected", errors: [{ code: "invalid-proposal", detail: parsed.error.message }] };
  }
  const proposal = parsed.data;
  const errors: CapabilityResolutionCompilationResult["errors"] = [];
  const add = (code: string, detail: string, workItemId?: string) => errors.push({ code, detail, ...(workItemId ? { workItemId } : {}) });

  for (const key of ["tenantId", "requestId", "parentGoalId", "ordinaryGoalDigest"] as const) {
    if (proposal[key] !== context.identity[key]) add("identity-mismatch", `${key} does not match the trusted request identity.`);
  }

  const primitives = new Map(context.primitives.map((item) => [`${item.key}@${item.version}`, trustedActionPrimitiveSchema.parse(item)]));
  const evidence = new Map(context.evidence.map((item) => [item.evidenceId, trustedPlanningEvidenceSchema.parse(item)]));
  const configValues = new Map(context.trustedConfigValues.map((item) => [item.key, trustedValueDescriptorSchema.parse(item)]));
  const literalValues = new Map(context.trustedLiteralValues.map((item) => [item.key, trustedValueDescriptorSchema.parse(item)]));
  const evidenceValues = new Map(context.evidenceValues.map((item) => {
    const parsedValue = trustedEvidenceValueDescriptorSchema.parse(item);
    return [`${parsedValue.evidenceId}:${parsedValue.key}`, parsedValue] as const;
  }));
  const itemsById = new Map(proposal.workItems.map((item) => [item.workItemId, item]));
  const primitiveByItem = new Map<string, TrustedActionPrimitive>();

  const orderedIds = topologicalOrder(proposal.workItems);
  if (!orderedIds) add("invalid-graph", "Work-item IDs must be unique, dependencies must exist, and the graph must be acyclic.");

  for (const item of proposal.workItems) {
    const primitive = primitives.get(`${item.primitiveKey}@${item.primitiveVersion}`);
    if (!primitive || !primitive.enabled) {
      add("unknown-primitive", `Primitive ${item.primitiveKey}@${item.primitiveVersion} is not enabled.`, item.workItemId);
      continue;
    }
    primitiveByItem.set(item.workItemId, primitive);

    for (const evidenceId of item.citedEvidenceIds) {
      const source = evidence.get(evidenceId);
      if (!source || !source.permittedPrimitiveKeys.includes(primitive.key)) {
        add("invalid-evidence", `Evidence ${evidenceId} does not permit primitive ${primitive.key}.`, item.workItemId);
      }
    }
    if (!context.authority.targetAliases.includes(primitive.targetAlias)) add("authority-target", `Target ${primitive.targetAlias} is outside authority.`, item.workItemId);
    if (!context.authority.actionKeys.includes(primitive.actionKey)) add("authority-action", `Action ${primitive.actionKey} is outside authority.`, item.workItemId);
    if (riskRank[primitive.maximumRisk] > riskRank[context.authority.maximumRisk]) add("authority-risk", `Risk ${primitive.maximumRisk} exceeds the trusted ceiling.`, item.workItemId);
    for (const approval of primitive.requiredApprovalKeys) {
      if (!context.authority.approvalKeys.includes(approval)) add("missing-approval", `Approval ${approval} is unavailable.`, item.workItemId);
    }
    if (primitive.maximumRisk !== "read-only" && primitive.idempotency === "unavailable") {
      add("unsafe-retry", "A write primitive must define idempotency or an explicit not-applicable boundary.", item.workItemId);
    }
    if (!primitive.routeBuilderKeys.some((key) => context.enabledRouteBuilderKeys.includes(key))) add("missing-route", "No enabled route builder can implement the primitive.", item.workItemId);
    if (!primitive.requiredObservationKeys.every((key) => context.enabledObservationKeys.includes(key))) add("missing-observer", "One or more required independent observations are unavailable.", item.workItemId);
    if (!context.enabledVerifierTemplateKeys.includes(primitive.verifierTemplateKey)) add("missing-verifier", `Verifier ${primitive.verifierTemplateKey} is not enabled.`, item.workItemId);

    const bindingKeys = item.bindings.map((binding) => binding.inputKey);
    if (new Set(bindingKeys).size !== bindingKeys.length) add("duplicate-binding", "Each primitive input must have exactly one binding.", item.workItemId);
    for (const input of primitive.inputs) {
      const binding = item.bindings.find((candidate) => candidate.inputKey === input.key);
      if (!binding) {
        add("missing-binding", `Input ${input.key} has no trusted binding.`, item.workItemId);
        continue;
      }
      if (!input.allowedSources.includes(binding.kind)) {
        add("binding-source", `Input ${input.key} does not permit ${binding.kind}.`, item.workItemId);
        continue;
      }
      let source: TrustedValueDescriptor | PrimitiveOutput | undefined;
      if (binding.kind === "trusted-config") source = configValues.get(binding.valueKey);
      if (binding.kind === "trusted-literal") source = literalValues.get(binding.literalKey);
      if (binding.kind === "trusted-evidence") {
        if (!item.citedEvidenceIds.includes(binding.evidenceId)) add("uncited-value", `Evidence value ${binding.evidenceId}:${binding.valueKey} was not cited.`, item.workItemId);
        source = evidenceValues.get(`${binding.evidenceId}:${binding.valueKey}`);
      }
      if (binding.kind === "verified-artifact") {
        const producer = primitiveByItem.get(binding.producerWorkItemId)
          ?? primitives.get(`${itemsById.get(binding.producerWorkItemId)?.primitiveKey}@${itemsById.get(binding.producerWorkItemId)?.primitiveVersion}`);
        source = producer?.outputs.find((output) => output.key === binding.outputKey);
        if (!item.dependsOn.includes(binding.producerWorkItemId)) add("artifact-dependency", "Artifact producer must be an explicit dependency.", item.workItemId);
      }
      if (!source) {
        add("unknown-binding", `Input ${input.key} references an unknown trusted value or artifact.`, item.workItemId);
      } else {
        if (source.schemaKey !== input.schemaKey) add("schema-mismatch", `Input ${input.key} expects ${input.schemaKey}, not ${source.schemaKey}.`, item.workItemId);
        if (classificationRank[source.classification] > classificationRank[input.maximumClassification]) {
          add("classification-flow", `Input ${input.key} cannot receive ${source.classification} data.`, item.workItemId);
        }
      }
    }
    for (const binding of item.bindings) {
      if (!primitive.inputs.some((input) => input.key === binding.inputKey)) add("extra-binding", `Binding ${binding.inputKey} is not declared by the primitive.`, item.workItemId);
    }
  }

  for (const terminal of proposal.terminalOutputs) {
    const primitive = primitiveByItem.get(terminal.workItemId);
    if (!primitive?.outputs.some((output) => output.key === terminal.outputKey)) add("unknown-terminal", `Terminal output ${terminal.workItemId}:${terminal.outputKey} does not exist.`);
  }
  if (!sameOutputSet(proposal.terminalOutputs, context.aggregateVerifier.requiredTerminalOutputs)) {
    add("incomplete-aggregate", "The proposal terminal outputs do not exactly match the trusted aggregate verifier contract.");
  }
  if (errors.length > 0 || !orderedIds) return { status: "rejected", errors };

  const orderedWorkItems = orderedIds.map((id) => {
    const item = itemsById.get(id)!;
    const primitive = primitiveByItem.get(id)!;
    return {
      workItemId: id,
      primitiveKey: primitive.key,
      primitiveVersion: primitive.version,
      targetAlias: primitive.targetAlias,
      actionKey: primitive.actionKey,
      maximumRisk: primitive.maximumRisk,
      requiredApprovalKeys: [...primitive.requiredApprovalKeys].sort(),
      dependsOn: [...item.dependsOn].sort(),
      bindings: [...item.bindings].sort((left, right) => left.inputKey.localeCompare(right.inputKey)),
      outputSchemas: [...primitive.outputs].sort((left, right) => left.key.localeCompare(right.key)),
      routeBuilderKeys: primitive.routeBuilderKeys.filter((key) => context.enabledRouteBuilderKeys.includes(key)).sort(),
      observationKeys: [...primitive.requiredObservationKeys].sort(),
      verifierTemplateKey: primitive.verifierTemplateKey,
      idempotency: primitive.idempotency,
    };
  });
  const unsigned = {
    schemaVersion: "1.0" as const,
    tenantId: proposal.tenantId,
    requestId: proposal.requestId,
    parentGoalId: proposal.parentGoalId,
    ordinaryGoalDigest: proposal.ordinaryGoalDigest,
    primitiveRegistryDigest: sha256([...primitives.values()].sort((left, right) => `${left.key}@${left.version}`.localeCompare(`${right.key}@${right.version}`))),
    verifierRegistryDigest: sha256({ observations: [...context.enabledObservationKeys].sort(), verifiers: [...context.enabledVerifierTemplateKeys].sort() }),
    aggregateVerifierKey: context.aggregateVerifier.key,
    orderedWorkItems,
    terminalOutputs: [...proposal.terminalOutputs].sort((left, right) => `${left.workItemId}:${left.outputKey}`.localeCompare(`${right.workItemId}:${right.outputKey}`)),
  };
  const planDigest = sha256(unsigned);
  return {
    status: "compiled",
    errors: [],
    plan: { ...unsigned, planId: `capability-plan-${planDigest.slice(0, 24)}`, planDigest },
  };
}
