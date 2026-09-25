import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  AuthorityEnvelope,
  BlockedGoalContext,
  CapabilityNeed,
  CapabilityRequest,
  VisibilityMode,
} from "./contracts.js";

export const diagnosisDecisionSchema = z.enum([
  "goal-complete",
  "continue-current",
  "retry-current",
  "request-information",
  "request-credential",
  "request-permission",
  "request-approval",
  "policy-denied",
  "acquire-capability",
  "insufficient-evidence",
]);

export type DiagnosisDecision = z.infer<typeof diagnosisDecisionSchema>;

const missingCapabilitySchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
    summary: z.string().min(1).max(500),
    requiredActions: z.array(z.string().regex(/^[a-z][a-z0-9_]{2,63}$/)).min(1).max(12),
    targetAliases: z.array(z.string().min(1)).min(1).max(4),
    secretAliases: z.array(z.string().min(1)).max(4),
  })
  .strict();

const contemplatedActionSchema = z
  .object({
    actionNames: z.array(z.string().regex(/^[a-z][a-z0-9_]{2,63}$/)).min(1).max(12),
    targetAliases: z.array(z.string().min(1)).min(1).max(4),
    secretAliases: z.array(z.string().min(1)).max(4),
  })
  .strict();

/**
 * The model may propose a diagnosis, but it cannot grant authority, select an
 * undocumented operation, or decide that a new capability may be built.
 */
export const diagnosisProposalSchema = z
  .object({
    decision: diagnosisDecisionSchema,
    summary: z.string().min(1).max(800),
    evidenceIds: z.array(z.string().min(1)).max(20),
    selectedCapabilityKey: z.union([z.string().min(1), z.null()]),
    contemplatedAction: z.union([contemplatedActionSchema, z.null()]),
    missingCapability: z.union([missingCapabilitySchema, z.null()]),
    requestedInputs: z.array(z.string().min(1)).max(12),
    confidence: z.enum(["low", "medium", "high"]),
  })
  .strict();

export type DiagnosisProposal = z.infer<typeof diagnosisProposalSchema>;

export interface GoalObservation {
  id: string;
  source: "external-state" | "trusted-runtime" | "customer-config" | "user";
  summary: string;
}

export interface AvailableCapability {
  key: string;
  summary: string;
  actions: string[];
  status: "available" | "transient-failure" | "unavailable";
}

export interface CandidateSystemOperation {
  name: string;
  summary: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Trusted documented dependencies, such as a reconciliation read required before a retryable write. */
  requiredCompanionActions?: string[];
}

export interface CandidateSystem {
  targetAlias: string;
  summary: string;
  documentationHash: string;
  secretAliases: string[];
  operations: CandidateSystemOperation[];
}

/** Trusted state assembled by the host application, never invented by the model. */
export interface DiagnosisState {
  goalSatisfied: boolean | null;
  missingInformation: string[];
  configuredSecretAliases: string[];
  requiredApprovals: string[];
  grantedApprovals: string[];
  policyAllowsAction: boolean;
  availableCapabilities: AvailableCapability[];
  candidateSystems: CandidateSystem[];
}

export interface DiagnosisGoalContext {
  tenantId: string;
  requestId: string;
  workflowKey: string;
  ordinaryGoal: string;
  currentStep: string;
  visibility: VisibilityMode;
}

export interface DiagnosisInput {
  context: DiagnosisGoalContext;
  observations: GoalObservation[];
  state: DiagnosisState;
  authority: AuthorityEnvelope;
  runtimeProfile: string;
}

export interface DiagnosisGateway {
  diagnose(input: DiagnosisInput): Promise<unknown>;
}

export interface DiagnosisCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export type DiagnosisResult =
  | {
      decision: Exclude<DiagnosisDecision, "acquire-capability">;
      summary: string;
      proposed: DiagnosisProposal;
      overridden: boolean;
      checks: DiagnosisCheck[];
    }
  | {
      decision: "acquire-capability";
      summary: string;
      proposed: DiagnosisProposal;
      overridden: boolean;
      checks: DiagnosisCheck[];
      request: CapabilityRequest;
    };

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function includesAll(haystack: string[], needles: string[]): boolean {
  return needles.every((needle) => haystack.includes(needle));
}

export interface StableCapabilityIdentityInput {
  documentationHash: string;
  /** Trusted host workflow identity; prevents cross-workflow action-set conflation. */
  workflowKey: string;
  /** Targets and credentials are genuine sets, so their order is not semantic. */
  targetAliases: string[];
  secretAliases: string[];
  /** Preserved exactly: a different action sequence receives a different key. */
  orderedActions: string[];
  /** Trusted documented semantics for each action in the same preserved sequence. */
  operations: Array<{
    name: string;
    method: CandidateSystemOperation["method"];
    requiredCompanionActions: string[];
  }>;
}

/**
 * Model wording cannot determine registry identity. Only fields that are
 * semantically sets are sorted. Action order and trusted workflow semantics are
 * preserved conservatively so uncertain equivalence causes an extra build,
 * never an unsafe reuse.
 */
export function stableCapabilityNeedKey(input: StableCapabilityIdentityInput): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        identityVersion: 2,
        documentationHash: input.documentationHash,
        workflowKey: input.workflowKey,
        targetAliases: [...new Set(input.targetAliases)].sort(),
        secretAliases: [...new Set(input.secretAliases)].sort(),
        orderedActions: unique(input.orderedActions),
        operations: input.operations.map((operation) => ({
          name: operation.name,
          method: operation.method,
          requiredCompanionActions: [...new Set(operation.requiredCompanionActions)].sort(),
        })),
      }),
    )
    .digest("hex")
    .slice(0, 20);
  return `http-capability-${digest}`;
}

function nonAcquisition(
  decision: Exclude<DiagnosisDecision, "acquire-capability">,
  summary: string,
  proposed: DiagnosisProposal,
  checks: DiagnosisCheck[],
): DiagnosisResult {
  return {
    decision,
    summary,
    proposed,
    overridden: proposed.decision !== decision,
    checks,
  };
}

/**
 * Independent adjudicator for a model proposal. It gives trusted facts priority
 * and opens acquisition only for a documented, minimum, authorized residual.
 */
export function adjudicateDiagnosis(
  input: DiagnosisInput,
  rawProposal: unknown,
  now: () => string = () => new Date().toISOString(),
): DiagnosisResult {
  const proposed = diagnosisProposalSchema.parse(rawProposal);
  const evidenceIds = new Set(input.observations.map((observation) => observation.id));
  const checks: DiagnosisCheck[] = [
    {
      id: "evidence-references",
      passed: proposed.evidenceIds.every((id) => evidenceIds.has(id)),
      detail: "Every cited observation must exist in the trusted diagnosis input.",
    },
  ];

  if (input.state.goalSatisfied === true) {
    checks.push({ id: "goal-state", passed: true, detail: "Trusted external state says the goal is already satisfied." });
    return nonAcquisition("goal-complete", "The requested outcome is already present.", proposed, checks);
  }
  if (!input.state.policyAllowsAction) {
    checks.push({ id: "policy", passed: false, detail: "Customer policy prohibits the contemplated action." });
    return nonAcquisition("policy-denied", "Policy prohibits further action on this goal.", proposed, checks);
  }
  if (input.state.missingInformation.length > 0) {
    checks.push({
      id: "required-information",
      passed: false,
      detail: `Required information is unavailable: ${input.state.missingInformation.join(", ")}.`,
    });
    return nonAcquisition(
      "request-information",
      "Information needed to determine or perform the correct action is missing.",
      proposed,
      checks,
    );
  }

  const need = proposed.missingCapability;
  const plan = need ?? proposed.contemplatedAction;
  if (!plan) {
    if (proposed.decision === "continue-current" || proposed.decision === "retry-current") {
      const selected = input.state.availableCapabilities.find(
        (capability) => capability.key === proposed.selectedCapabilityKey,
      );
      const expectedStatus = proposed.decision === "continue-current" ? "available" : "transient-failure";
      const valid = selected?.status === expectedStatus;
      checks.push({
        id: "selected-existing-capability",
        passed: valid,
        detail: valid
          ? "The selected existing capability has the state required by the proposed decision."
          : "The proposal does not identify an existing capability in the required state.",
      });
      if (valid) return nonAcquisition(proposed.decision, proposed.summary, proposed, checks);
    }
    return nonAcquisition(
      "insufficient-evidence",
      "The diagnosis does not identify a sufficiently specific missing capability.",
      proposed,
      checks,
    );
  }

  const requiredActions = unique("requiredActions" in plan ? plan.requiredActions : plan.actionNames);
  const targetAliases = unique(plan.targetAliases);
  const secretAliases = unique(plan.secretAliases);
  const selectedSystems = targetAliases.map((alias) =>
    input.state.candidateSystems.find((system) => system.targetAlias === alias),
  );
  const systemsExist = selectedSystems.every((system) => system !== undefined);
  checks.push({
    id: "documented-targets",
    passed: systemsExist,
    detail: "Every proposed target must resolve to a trusted system description.",
  });
  if (!systemsExist || selectedSystems.length !== 1) {
    return nonAcquisition(
      "insufficient-evidence",
      "The proposed missing capability is not tied to exactly one documented target system.",
      proposed,
      checks,
    );
  }
  const system = selectedSystems[0]!;
  const operationByName = new Map(system.operations.map((operation) => [operation.name, operation]));
  const operations = requiredActions.map((action) => operationByName.get(action));
  const actionsDocumented = requiredActions.length > 0 && operations.every((operation) => operation !== undefined);
  checks.push({
    id: "documented-minimum-actions",
    passed: actionsDocumented,
    detail: "Every requested action must be an operation exposed by the trusted system description.",
  });
  if (!actionsDocumented) {
    return nonAcquisition(
      "insufficient-evidence",
      "The proposed action set is not supported by trusted system documentation.",
      proposed,
      checks,
    );
  }

  const requiredCompanions = unique(
    operations.flatMap((operation) => operation?.requiredCompanionActions ?? []),
  );
  const companionCoverage = unique([
    ...requiredActions,
    ...input.state.availableCapabilities
      .filter((capability) => capability.status === "available")
      .flatMap((capability) => capability.actions),
  ]);
  const companionsPresent = includesAll(companionCoverage, requiredCompanions);
  checks.push({
    id: "required-companion-actions",
    passed: companionsPresent,
    detail: companionsPresent
      ? "All trusted safety and data dependencies are present in the plan or a healthy existing capability."
      : `Required companion actions are missing: ${requiredCompanions.filter((action) => !companionCoverage.includes(action)).join(", ")}.`,
  });
  if (!companionsPresent) {
    return nonAcquisition(
      "insufficient-evidence",
      "The proposed action plan omits a documented safety or data dependency.",
      proposed,
      checks,
    );
  }

  const existing = input.state.availableCapabilities.find(
    (capability) => includesAll(capability.actions, requiredActions),
  );
  if (existing?.status === "available") {
    checks.push({ id: "existing-capability-search", passed: false, detail: "An available capability already covers the required actions." });
    return nonAcquisition(
      "continue-current",
      "An existing configured capability can perform the required actions.",
      proposed,
      checks,
    );
  }
  if (existing?.status === "transient-failure") {
    checks.push({ id: "existing-capability-search", passed: false, detail: "A matching capability exists and its last failure is retryable." });
    return nonAcquisition(
      "retry-current",
      "Retry the matching existing capability before acquiring a replacement.",
      proposed,
      checks,
    );
  }
  checks.push({ id: "existing-capability-search", passed: true, detail: "No usable configured capability covers the required actions." });

  const secretsBelongToSystem = secretAliases.every((alias) => system.secretAliases.includes(alias));
  checks.push({
    id: "documented-secret-aliases",
    passed: secretsBelongToSystem,
    detail: "Credential aliases must belong to the selected documented system.",
  });
  if (!secretsBelongToSystem) {
    return nonAcquisition(
      "insufficient-evidence",
      "The proposed credentials are not associated with the selected target.",
      proposed,
      checks,
    );
  }
  const missingCredentials = secretAliases.filter(
    (alias) => !input.state.configuredSecretAliases.includes(alias),
  );
  if (missingCredentials.length > 0) {
    checks.push({ id: "credentials-configured", passed: false, detail: `Missing credential aliases: ${missingCredentials.join(", ")}.` });
    return nonAcquisition(
      "request-credential",
      "A required credential has not been configured.",
      proposed,
      checks,
    );
  }
  checks.push({ id: "credentials-configured", passed: true, detail: "All required credential aliases are configured." });

  const targetAuthorized = targetAliases.every((alias) => input.authority.allowedTargetAliases.includes(alias));
  const secretsAuthorized = secretAliases.every((alias) => input.authority.allowedSecretAliases.includes(alias));
  const methods = operations.map((operation) => operation!.method);
  const methodsAuthorized = methods.every((method) => input.authority.allowedMethods.includes(method));
  checks.push(
    { id: "target-authority", passed: targetAuthorized, detail: "Every target must be customer-authorized." },
    { id: "secret-authority", passed: secretsAuthorized, detail: "Every credential alias must be customer-authorized." },
    { id: "method-authority", passed: methodsAuthorized, detail: "Every required HTTP method must be customer-authorized." },
  );
  if (!targetAuthorized || !secretsAuthorized || !methodsAuthorized) {
    return nonAcquisition(
      "request-permission",
      "The required target, credential, or HTTP method is outside the granted authority.",
      proposed,
      checks,
    );
  }

  const writeActions = operations.filter((operation) => operation!.method !== "GET").map((operation) => operation!.name);
  if (writeActions.length > 0 && input.authority.writeAuthority === "denied") {
    checks.push({ id: "write-authority", passed: false, detail: "The goal requires a write, but write authority is denied." });
    return nonAcquisition(
      "request-permission",
      "The required write is not authorized.",
      proposed,
      checks,
    );
  }
  if (writeActions.length > 0 && input.authority.writeAuthority === "per-action-approval") {
    const missingApprovals = unique([...input.state.requiredApprovals, ...writeActions]).filter(
      (action) =>
        !input.state.grantedApprovals.includes(action) || !input.authority.approvedWriteActions.includes(action),
    );
    if (missingApprovals.length > 0) {
      checks.push({ id: "write-approval", passed: false, detail: `Approval is missing for: ${missingApprovals.join(", ")}.` });
      return nonAcquisition(
        "request-approval",
        "A consequential action requires explicit approval.",
        proposed,
        checks,
      );
    }
  }
  checks.push({ id: "write-authority", passed: true, detail: "The required write authority and approvals are present." });

  if (!need) {
    return nonAcquisition(
      "insufficient-evidence",
      "The contemplated action is permitted, but no missing capability has been established.",
      proposed,
      checks,
    );
  }

  const evidenceReferencesValid = checks.find((check) => check.id === "evidence-references")!.passed;
  if (!evidenceReferencesValid || proposed.decision !== "acquire-capability") {
    return nonAcquisition(
      "insufficient-evidence",
      "The evidence or decision does not justify opening capability acquisition.",
      proposed,
      checks,
    );
  }

  const capabilityNeed: CapabilityNeed = {
    key: stableCapabilityNeedKey({
      documentationHash: system.documentationHash,
      workflowKey: input.context.workflowKey,
      targetAliases,
      secretAliases,
      orderedActions: requiredActions,
      operations: operations.map((operation) => ({
        name: operation!.name,
        method: operation!.method,
        requiredCompanionActions: operation!.requiredCompanionActions ?? [],
      })),
    }),
    summary: need.summary,
    requiredActions,
    targetAliases,
    secretAliases,
    documentationHash: system.documentationHash,
  };
  const blockedContext: BlockedGoalContext = {
    tenantId: input.context.tenantId,
    requestId: input.context.requestId,
    workflowKey: input.context.workflowKey,
    ordinaryGoal: input.context.ordinaryGoal,
    blockedAt: now(),
    blockedReason: proposed.summary,
    visibility: input.context.visibility,
  };
  return {
    decision: "acquire-capability",
    summary: proposed.summary,
    proposed,
    overridden: false,
    checks,
    request: {
      context: blockedContext,
      need: capabilityNeed,
      authority: structuredClone(input.authority),
      runtimeProfile: input.runtimeProfile,
    },
  };
}

export class GoalDiagnostician {
  constructor(private readonly gateway: DiagnosisGateway, private readonly now?: () => string) {}

  async diagnose(input: DiagnosisInput): Promise<DiagnosisResult> {
    const rawProposal = await this.gateway.diagnose(structuredClone(input));
    return adjudicateDiagnosis(input, rawProposal, this.now);
  }
}
