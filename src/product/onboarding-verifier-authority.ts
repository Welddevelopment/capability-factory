import { createHash } from "node:crypto";
import { z } from "zod";
import type { AuthorityEnvelope } from "./contracts.js";
import {
  outcomeCriterionSchema,
  trustedOutcomeContractSchema,
  type OutcomeCriterion,
  type TrustedOutcomeContract,
  type UniversalObservationAdapter,
  type UniversalObservationContext,
} from "./universal-verifier.js";

const identifier = z.string().min(1).max(180).regex(/^[a-zA-Z0-9_.-]+$/);
const boundedText = z.string().trim().min(1).max(2_000);
const secretShaped = /(?:bearer\s+[a-z0-9._~-]{8,}|sk-[a-z0-9_-]{12,}|password\s*[:=]|token\s*[:=])/i;

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

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

// ---------------------------------------------------------------------------
// Verifier Factory: deterministic, provisional onboarding foundation
// ---------------------------------------------------------------------------

const observationSurfaceSchema = z.object({
  key: identifier,
  sourceId: identifier,
  description: boundedText,
  sourceKind: z.enum([
    "independent-api",
    "direct-database",
    "audit-log",
    "read-model",
    "customer-approved-other",
    "action-response",
  ]),
  observationKeys: z.array(identifier).min(1).max(64),
  approvedForThisOutcome: z.boolean(),
  independentFromExecution: z.boolean(),
  independenceConfirmed: z.boolean(),
  supportsFreshnessBoundary: z.boolean(),
}).strict();

export const verifierFactoryIntakeSchema = z.object({
  schemaVersion: z.literal("1.0"),
  outcomeKey: identifier,
  ordinaryBusinessOutcome: boundedText,
  executionDriverId: identifier,
  // The trusted contract allows 64 criteria; one slot is reserved for the
  // mandatory duplicate-count criterion added by this factory.
  successCriteria: z.array(outcomeCriterionSchema).min(1).max(63),
  duplicateCheck: z.object({
    observationKey: identifier,
    path: z.array(z.union([identifier, z.number().int().nonnegative()])).max(20),
    expectedCount: z.number().int().nonnegative(),
  }).strict(),
  collateralEffectCountObservationKey: identifier,
  freshness: z.object({
    maximumAgeSeconds: z.number().int().positive().max(31_536_000),
    observedAtKey: identifier,
    notBeforeBoundary: z.literal("trusted-operation-start"),
    boundaryConfirmed: z.boolean(),
  }).strict(),
  observationSurfaces: z.array(observationSurfaceSchema).min(1).max(32),
}).strict().superRefine((input, context) => {
  if (secretShaped.test(JSON.stringify(input))) {
    context.addIssue({ code: "custom", message: "Verifier intake contains a credential-shaped value; use customer-local aliases only." });
  }
  const keys = input.successCriteria.map((criterion) => criterion.key);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", path: ["successCriteria"], message: "Verifier criterion keys must be unique." });
  }
  if (keys.includes("cf-duplicate-count") || keys.includes("duplicate-count")) {
    context.addIssue({ code: "custom", path: ["successCriteria"], message: "Duplicate-count criterion keys are reserved for the factory duplicate check." });
  }
  const surfaceKeys = input.observationSurfaces.map((surface) => surface.key);
  if (new Set(surfaceKeys).size !== surfaceKeys.length) {
    context.addIssue({ code: "custom", path: ["observationSurfaces"], message: "Observation-surface keys must be unique." });
  }
  input.observationSurfaces.forEach((surface, index) => {
    if (new Set(surface.observationKeys).size !== surface.observationKeys.length) {
      context.addIssue({ code: "custom", path: ["observationSurfaces", index, "observationKeys"], message: "Observation keys must be unique within a surface." });
    }
  });
});

export type VerifierFactoryIntake = z.infer<typeof verifierFactoryIntakeSchema>;

export interface ProvisionalOutcomeClassification {
  classification: "completed" | "not-started" | "partial" | "incorrect" | "unknown";
  rule: string;
}

export interface ProvisionalVerifierAcceptanceCase {
  id:
    | "completed-outcome"
    | "not-started-outcome"
    | "partial-outcome"
    | "incorrect-outcome"
    | "unknown-observer-state"
    | "duplicate-detection"
    | "collateral-effect-detection"
    | "stale-observation"
    | "lost-response-reconciliation"
    | "adversarial-action-response";
  status: "declared-not-run";
  expected: string;
}

export interface ProvisionalVerifierContract {
  schemaVersion: "1.0";
  contractId: string;
  status: "provisional-review-required" | "blocked";
  activation: "blocked";
  ordinaryBusinessOutcome: string;
  executionDriverId: string;
  successState: OutcomeCriterion[];
  independentObserver?: {
    surfaceKey: string;
    sourceId: string;
    sourceKind: Exclude<z.infer<typeof observationSurfaceSchema>["sourceKind"], "action-response">;
  };
  classifications: ProvisionalOutcomeClassification[];
  duplicateCheck: VerifierFactoryIntake["duplicateCheck"];
  collateralEffectCountObservationKey: string;
  freshness: VerifierFactoryIntake["freshness"];
  /** Criterion candidate only; freshness still requires a separate trusted runtime gate. */
  criterionContractDraft?: TrustedOutcomeContract;
  scaffold: {
    implementationStatus: "not-implemented";
    executionStatus: "not-run";
    compileTarget: "UniversalVerifierFactory-with-FreshnessEnforcingObservationAdapter";
    generatedScaffoldIsPassingEvidence: false;
    requiredMethods: string[];
  };
  acceptanceCases: ProvisionalVerifierAcceptanceCase[];
  unknowns: string[];
  blockers: string[];
  /** Intrinsic content digest; review digests cannot legitimize later mutation. */
  contractDigest: string;
}

export type VerifierFactoryResult =
  | { status: "proposed"; contract: ProvisionalVerifierContract }
  | { status: "rejected"; contract: ProvisionalVerifierContract; validationErrors: string[] };

function emptyVerifierContract(): ProvisionalVerifierContract {
  return finalizeVerifierContract({
    schemaVersion: "1.0",
    contractId: "verifier-draft-invalid-input",
    status: "blocked",
    activation: "blocked",
    ordinaryBusinessOutcome: "Invalid or incomplete verifier intake.",
    executionDriverId: "unknown-driver",
    successState: [],
    classifications: classificationRules(),
    duplicateCheck: { observationKey: "unknown-duplicates", path: [], expectedCount: 0 },
    collateralEffectCountObservationKey: "unknown-collateral-effects",
    freshness: { maximumAgeSeconds: 1, observedAtKey: "unknown-observed-at", notBeforeBoundary: "trusted-operation-start", boundaryConfirmed: false },
    scaffold: verifierScaffold(),
    acceptanceCases: verifierAcceptanceCases(),
    unknowns: ["Provide a strictly valid verifier-factory intake."],
    blockers: ["The verifier-factory intake failed strict validation."],
  });
}

function verifierContractPayload(contract: Omit<ProvisionalVerifierContract, "contractDigest"> | ProvisionalVerifierContract): unknown {
  const { contractDigest: _contractDigest, ...payload } = contract as ProvisionalVerifierContract;
  return payload;
}

function finalizeVerifierContract(contract: Omit<ProvisionalVerifierContract, "contractDigest">): ProvisionalVerifierContract {
  return { ...contract, contractDigest: digest(contract) };
}

export function assertProvisionalVerifierContractIntegrity(contract: ProvisionalVerifierContract): void {
  if (digest(verifierContractPayload(contract)) !== contract.contractDigest) {
    throw new Error("Provisional verifier contract content does not match its intrinsic digest.");
  }
}

function classificationRules(): ProvisionalOutcomeClassification[] {
  return [
    { classification: "completed", rule: "Every success criterion passes, freshness is established, and duplicate and collateral-effect checks are clean." },
    { classification: "not-started", rule: "Independent evidence establishes that none of the intended effect occurred." },
    { classification: "partial", rule: "Independent evidence establishes that some, but not all, required success criteria occurred." },
    { classification: "incorrect", rule: "Independent evidence finds a wrong value, duplicate, forbidden change, or other collateral effect." },
    { classification: "unknown", rule: "The independent observer is unavailable, incomplete, stale, ambiguous, or cannot establish a safe classification." },
  ];
}

function verifierScaffold(): ProvisionalVerifierContract["scaffold"] {
  return {
    implementationStatus: "not-implemented",
    executionStatus: "not-run",
    compileTarget: "UniversalVerifierFactory-with-FreshnessEnforcingObservationAdapter",
    generatedScaffoldIsPassingEvidence: false,
    requiredMethods: [
      "observe external state through the approved independent surface",
      "enforce the freshness boundary",
      "evaluate exact success criteria",
      "classify not-started, partial, incorrect, and unknown states",
      "count duplicates and collateral effects",
      "reconcile external state before any retry",
    ],
  };
}

export interface ObservationFreshnessPolicy {
  observedAtKey: string;
  maximumAgeSeconds: number;
  maximumFutureSkewSeconds: number;
  /** Trusted action/run boundary; a recent observation from before execution is invalid. */
  notBeforeEpochMs: number;
}

/**
 * Trusted generic wrapper used before UniversalVerifierFactory sees an
 * observation. It rejects absent, malformed, stale, or implausibly future
 * evidence instead of allowing a fresh-looking state digest to hide age.
 */
export function createFreshnessEnforcingObservationAdapter(
  adapter: UniversalObservationAdapter,
  policy: ObservationFreshnessPolicy,
  now: () => number = () => Date.now(),
): UniversalObservationAdapter {
  if (!identifier.safeParse(policy.observedAtKey).success) throw new Error("Freshness observation key must be a stable identifier.");
  if (!Number.isInteger(policy.maximumAgeSeconds) || policy.maximumAgeSeconds <= 0) throw new Error("Maximum observation age must be a positive integer.");
  if (!Number.isInteger(policy.maximumFutureSkewSeconds) || policy.maximumFutureSkewSeconds < 0) throw new Error("Maximum future skew must be a nonnegative integer.");
  if (!Number.isFinite(policy.notBeforeEpochMs) || policy.notBeforeEpochMs < 0) throw new Error("Trusted not-before boundary must be a nonnegative epoch timestamp.");
  if (!adapter.observationKeys.includes(policy.observedAtKey)) throw new Error("Observation adapter does not declare the required freshness key.");
  return {
    ...adapter,
    key: `${adapter.key}.freshness`,
    async observe(context: UniversalObservationContext) {
      const observations = await adapter.observe(context);
      const raw = observations[policy.observedAtKey];
      if (typeof raw !== "string") throw new Error("Independent observation did not supply an ISO timestamp for freshness.");
      const observedAt = Date.parse(raw);
      if (!Number.isFinite(observedAt)) throw new Error("Independent observation supplied an invalid freshness timestamp.");
      const ageMilliseconds = now() - observedAt;
      if (observedAt < policy.notBeforeEpochMs) throw new Error("Independent observation predates the trusted operation-start boundary.");
      if (ageMilliseconds > policy.maximumAgeSeconds * 1_000) throw new Error("Independent observation is outside the approved freshness window.");
      if (ageMilliseconds < -policy.maximumFutureSkewSeconds * 1_000) throw new Error("Independent observation timestamp is implausibly in the future.");
      return observations;
    },
  };
}

function verifierAcceptanceCases(): ProvisionalVerifierAcceptanceCase[] {
  return [
    { id: "completed-outcome", status: "declared-not-run", expected: "Fresh independent evidence satisfies every criterion with no duplicate or collateral effect." },
    { id: "not-started-outcome", status: "declared-not-run", expected: "Independent evidence establishes that the intended effect did not begin." },
    { id: "partial-outcome", status: "declared-not-run", expected: "A partial effect is rejected and cannot be reported as completion." },
    { id: "incorrect-outcome", status: "declared-not-run", expected: "A wrong result is rejected and the capability is not treated as successful." },
    { id: "unknown-observer-state", status: "declared-not-run", expected: "Unavailable or ambiguous observation fails closed as unknown." },
    { id: "duplicate-detection", status: "declared-not-run", expected: "An extra matching result is detected as incorrect rather than accepted." },
    { id: "collateral-effect-detection", status: "declared-not-run", expected: "Any forbidden or unintended external change prevents success." },
    { id: "stale-observation", status: "declared-not-run", expected: "Evidence outside the approved freshness window is rejected." },
    { id: "lost-response-reconciliation", status: "declared-not-run", expected: "After a lost action response, the observer determines external state before any retry and prevents a duplicate." },
    { id: "adversarial-action-response", status: "declared-not-run", expected: "An action response that claims success cannot substitute for independent external observation." },
  ];
}

/**
 * Produces a typed, deliberately unusable adapter skeleton. An engineer must
 * replace `observe` and explicitly establish independence before the existing
 * UniversalVerifierFactory can select it.
 */
export function createFailClosedObservationAdapterScaffold(
  contract: ProvisionalVerifierContract,
): UniversalObservationAdapter {
  const observationKeys = unique([
    ...contract.successState.map((criterion) => criterion.observationKey),
    contract.duplicateCheck.observationKey,
    contract.collateralEffectCountObservationKey,
    contract.freshness.observedAtKey,
  ]);
  return {
    key: `${contract.contractId}.observer-scaffold`,
    sourceId: contract.independentObserver?.sourceId ?? "unbound-observation-source",
    priority: Number.MAX_SAFE_INTEGER,
    observationKeys,
    independentFromDriverIds: [],
    observe: async () => {
      throw new Error("Generated observation adapter scaffold is not implemented or independently bound.");
    },
  };
}

/**
 * Produces a reviewable verifier draft. It never implements, runs, passes, or
 * activates the verifier. Action responses are categorically ineligible as
 * independent evidence even if an intake incorrectly labels one independent.
 */
export function proposeExternalOutcomeVerifier(raw: unknown): VerifierFactoryResult {
  const parsed = verifierFactoryIntakeSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "rejected",
      contract: emptyVerifierContract(),
      validationErrors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "intake"}: ${issue.message}`),
    };
  }

  const input = parsed.data;
  const requiredKeys = unique([
    ...input.successCriteria.map((criterion) => criterion.observationKey),
    input.duplicateCheck.observationKey,
    input.collateralEffectCountObservationKey,
    input.freshness.observedAtKey,
  ]);
  const candidates = input.observationSurfaces
    .filter((surface) => surface.sourceKind !== "action-response")
    .filter((surface) => surface.sourceId !== input.executionDriverId)
    .filter((surface) => surface.approvedForThisOutcome)
    .filter((surface) => surface.independentFromExecution && surface.independenceConfirmed)
    .filter((surface) => requiredKeys.every((key) => surface.observationKeys.includes(key)))
    .filter((surface) => surface.supportsFreshnessBoundary)
    .sort((left, right) => left.key.localeCompare(right.key));
  const observer = candidates[0];
  const blockers: string[] = [];
  const unknowns: string[] = [];

  if (!input.freshness.boundaryConfirmed) {
    blockers.push("The freshness/time boundary requires explicit customer or engineer confirmation.");
    unknowns.push("Confirm that the selected observation timestamp and maximum age match the business outcome.");
  }
  if (!observer) {
    blockers.push("No approved, explicitly independent, freshness-capable observation surface covers every required observation.");
    unknowns.push("Supply or approve an independent observation surface covering success, duplicate, collateral-effect, and freshness evidence.");
  }
  if (observer) {
    unknowns.push("Bind the approved observation implementation through createFreshnessEnforcingObservationAdapter before compiling the criterion contract.");
  }
  if (input.observationSurfaces.some((surface) => surface.sourceKind === "action-response")) {
    unknowns.push("Action-response surfaces were excluded because an action cannot independently prove its own external result.");
  }

  const duplicateCriterion: OutcomeCriterion = {
    key: "cf-duplicate-count",
    observationKey: input.duplicateCheck.observationKey,
    path: input.duplicateCheck.path,
    operator: "count-equals",
    expected: input.duplicateCheck.expectedCount,
  };
  const criteria = [...input.successCriteria, duplicateCriterion];
  const rawTrustedContract: TrustedOutcomeContract = {
    schemaVersion: "1.0",
    key: input.outcomeKey,
    summary: input.ordinaryBusinessOutcome,
    executionDriverId: input.executionDriverId,
    criteria,
    incorrectSideEffectObservationKey: input.collateralEffectCountObservationKey,
    maximumIncorrectSideEffects: 0,
  };
  const trustedContract = trustedOutcomeContractSchema.safeParse(rawTrustedContract);
  if (!trustedContract.success) blockers.push("The proposed trusted verifier contract failed strict product-contract validation.");

  const independentObserver = observer === undefined
    ? undefined
    : {
        surfaceKey: observer.key,
        sourceId: observer.sourceId,
        sourceKind: observer.sourceKind as Exclude<typeof observer.sourceKind, "action-response">,
      };
  const contractSeed = {
    outcomeKey: input.outcomeKey,
    executionDriverId: input.executionDriverId,
    requiredKeys,
    observer: observer?.key ?? "missing",
  };
  const contract = finalizeVerifierContract({
    schemaVersion: "1.0",
    contractId: `verifier-draft-${digest(contractSeed).slice(0, 24)}`,
    status: blockers.length === 0 ? "provisional-review-required" : "blocked",
    activation: "blocked",
    ordinaryBusinessOutcome: input.ordinaryBusinessOutcome,
    executionDriverId: input.executionDriverId,
    successState: structuredClone(input.successCriteria),
    ...(independentObserver === undefined ? {} : { independentObserver }),
    classifications: classificationRules(),
    duplicateCheck: structuredClone(input.duplicateCheck),
    collateralEffectCountObservationKey: input.collateralEffectCountObservationKey,
    freshness: structuredClone(input.freshness),
    ...(trustedContract.success ? { criterionContractDraft: trustedContract.data } : {}),
    scaffold: verifierScaffold(),
    acceptanceCases: verifierAcceptanceCases(),
    unknowns,
    blockers,
  });
  return { status: "proposed", contract };
}

// ---------------------------------------------------------------------------
// Authority Wizard: ordinary-language intake -> conservative HTTP authority
// ---------------------------------------------------------------------------

const confirmationSchema = z.object({ confirmed: z.literal(true) }).strict();
const explicitNoneOrNumber = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none"), confirmed: z.literal(true) }).strict(),
  z.object({ kind: z.literal("limit"), maximum: z.number().nonnegative(), confirmed: z.literal(true) }).strict(),
]);

export const authorityWizardAnswersSchema = z.object({
  schemaVersion: z.literal("1.0"),
  systemsAndTargets: z.object({ aliases: z.array(identifier).min(1).max(64), confirmed: z.literal(true) }).strict(),
  credentialAliases: z.object({ aliases: z.array(identifier).max(64), confirmed: z.literal(true) }).strict(),
  readsAllowed: z.object({ actions: z.array(z.object({ actionName: identifier, targetAlias: identifier }).strict()).max(64), confirmed: z.literal(true) }).strict(),
  writes: z.array(z.object({
    actionName: identifier,
    targetAlias: identifier,
    method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
    policy: z.enum(["preauthorized", "requires-approval", "forbidden"]),
    confirmed: z.literal(true),
  }).strict()).max(64),
  limits: z.object({
    monetary: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("none"), confirmed: z.literal(true) }).strict(),
      z.object({ kind: z.literal("limit"), currency: z.string().min(3).max(3).regex(/^[A-Z]{3}$/), maximum: z.number().nonnegative(), confirmed: z.literal(true) }).strict(),
    ]),
    quantityPerAction: explicitNoneOrNumber,
    actionsPerHour: explicitNoneOrNumber,
  }).strict(),
  forbiddenActions: z.object({ actionNames: z.array(identifier).max(64), confirmed: z.literal(true) }).strict(),
  approver: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("not-required"), confirmed: z.literal(true) }).strict(),
    z.object({ kind: z.literal("owner"), ownerAlias: identifier, confirmed: z.literal(true) }).strict(),
  ]),
  retryAndReconciliation: z.object({
    reconcileBeforeRetry: z.literal(true),
    blindRetryAllowed: z.literal(false),
    maximumAttempts: z.number().int().min(0).max(10),
    confirmed: z.literal(true),
  }).strict(),
  finalConsequentialReview: confirmationSchema,
}).strict().superRefine((answers, context) => {
  if (secretShaped.test(JSON.stringify(answers))) {
    context.addIssue({ code: "custom", message: "Authority answers must contain aliases and policy facts, never credential-shaped values." });
  }
  if (answers.writes.some((write) => !answers.systemsAndTargets.aliases.includes(write.targetAlias))) {
    context.addIssue({ code: "custom", path: ["writes"], message: "Every write target must be one of the explicitly confirmed target aliases." });
  }
  const duplicateGroups = [
    { path: ["systemsAndTargets", "aliases"], values: answers.systemsAndTargets.aliases, label: "target aliases" },
    { path: ["credentialAliases", "aliases"], values: answers.credentialAliases.aliases, label: "credential aliases" },
    { path: ["readsAllowed", "actions"], values: answers.readsAllowed.actions.map((item) => `${item.targetAlias}:${item.actionName}`), label: "read rules" },
    { path: ["writes"], values: answers.writes.map((item) => `${item.targetAlias}:${item.method}:${item.actionName}`), label: "write rules" },
    { path: ["forbiddenActions", "actionNames"], values: answers.forbiddenActions.actionNames, label: "forbidden actions" },
  ] as const;
  for (const group of duplicateGroups) {
    if (new Set(group.values).size !== group.values.length) {
      context.addIssue({ code: "custom", path: [...group.path], message: `Authority answers contain duplicate ${group.label}.` });
    }
  }
});

export type AuthorityWizardAnswers = z.infer<typeof authorityWizardAnswersSchema>;

export interface AuthorityWizardGuardrails {
  allowedReadActions: Array<{ actionName: string; targetAlias: string }>;
  exactWriteRules: Array<{
    actionName: string;
    targetAlias: string;
    method: "POST" | "PUT" | "PATCH" | "DELETE";
    policy: "preauthorized" | "requires-approval";
  }>;
  forbiddenActions: string[];
  limits: AuthorityWizardAnswers["limits"];
  approverOwnerAlias?: string;
  reconcileBeforeRetry: true;
  blindRetryAllowed: false;
  maximumAttempts: number;
}

export interface AuthorityWizardCompilation {
  schemaVersion: "1.0";
  status: "review-required" | "blocked" | "rejected";
  activation: "not-activated";
  authority: AuthorityEnvelope;
  /** Reviewable draft only. It is never returned as the usable authority field. */
  candidateAuthority?: AuthorityEnvelope;
  guardrails: AuthorityWizardGuardrails;
  blockers: string[];
  reviewItems: string[];
  validationErrors: string[];
  /** Intrinsic content digest; a caller cannot mutate policy then re-review only the outer artifact. */
  compilationDigest: string;
}

function authorityCompilationPayload(
  compilation: Omit<AuthorityWizardCompilation, "compilationDigest"> | AuthorityWizardCompilation,
): unknown {
  const { compilationDigest: _compilationDigest, ...payload } = compilation as AuthorityWizardCompilation;
  return payload;
}

function finalizeAuthorityCompilation(
  compilation: Omit<AuthorityWizardCompilation, "compilationDigest">,
): AuthorityWizardCompilation {
  return { ...compilation, compilationDigest: digest(compilation) };
}

export function assertAuthorityWizardCompilationIntegrity(compilation: AuthorityWizardCompilation): void {
  if (digest(authorityCompilationPayload(compilation)) !== compilation.compilationDigest) {
    throw new Error("Authority wizard compilation content does not match its intrinsic digest.");
  }
}

function failClosedAuthority(): AuthorityEnvelope {
  return {
    allowedTargetAliases: [],
    allowedSecretAliases: [],
    allowedMethods: [],
    writeAuthority: "denied",
    approvedWriteActions: [],
  };
}

function emptyGuardrails(): AuthorityWizardGuardrails {
  return {
    allowedReadActions: [],
    exactWriteRules: [],
    forbiddenActions: [],
    limits: {
      monetary: { kind: "none", confirmed: true },
      quantityPerAction: { kind: "none", confirmed: true },
      actionsPerHour: { kind: "none", confirmed: true },
    },
    reconcileBeforeRetry: true,
    blindRetryAllowed: false,
    maximumAttempts: 0,
  };
}

/**
 * Compiles explicitly confirmed answers into the current deterministic HTTP
 * authority envelope plus guardrails the narrower envelope cannot represent.
 * The wizard never activates the result. Invalid or ambiguous answers produce
 * an empty, write-denied envelope.
 */
export function compileAuthorityWizard(raw: unknown): AuthorityWizardCompilation {
  const parsed = authorityWizardAnswersSchema.safeParse(raw);
  if (!parsed.success) {
    return finalizeAuthorityCompilation({
      schemaVersion: "1.0",
      status: "rejected",
      activation: "not-activated",
      authority: failClosedAuthority(),
      guardrails: emptyGuardrails(),
      blockers: ["Authority answers failed strict validation; no authority was granted."],
      reviewItems: [],
      validationErrors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "answers"}: ${issue.message}`),
    });
  }

  const answers = parsed.data;
  const blockers: string[] = [];
  const reviewItems: string[] = [
    "Review every target, credential alias, read, write, forbidden action, limit, retry rule, and approval owner before installation.",
    "Bind guardrail limits into trusted runtime enforcement; this compilation does not itself activate them.",
  ];
  const allowedWrites = answers.writes.filter((write) => write.policy !== "forbidden");
  const preauthorizedWrites = allowedWrites.filter((write) => write.policy === "preauthorized");
  const approvalWrites = allowedWrites.filter((write) => write.policy === "requires-approval");
  const forbidden = new Set([
    ...answers.forbiddenActions.actionNames,
    ...answers.writes.filter((write) => write.policy === "forbidden").map((write) => write.actionName),
  ]);

  if (allowedWrites.some((write) => forbidden.has(write.actionName))) {
    blockers.push("An action is simultaneously allowed and forbidden.");
  }
  if (answers.readsAllowed.actions.some((action) => forbidden.has(action.actionName))) {
    blockers.push("A read action is simultaneously allowed and forbidden.");
  }
  if (answers.readsAllowed.actions.some((read) => !answers.systemsAndTargets.aliases.includes(read.targetAlias))) {
    blockers.push("A read target is outside the explicitly confirmed target aliases.");
  }
  if (answers.systemsAndTargets.aliases.length > 1
    && (answers.readsAllowed.actions.length > 0 || allowedWrites.length > 0)) {
    blockers.push("The current AuthorityEnvelope cannot bind actions and methods to exact targets across multiple systems.");
  }
  if (preauthorizedWrites.length > 0 && approvalWrites.length > 0) {
    blockers.push("The current HTTP AuthorityEnvelope cannot safely represent mixed preauthorized and per-action write policies.");
  }
  if (approvalWrites.length > 0 && answers.approver.kind !== "owner") {
    blockers.push("Approval-gated writes require an explicitly confirmed approver owner.");
  }
  const writeTargets = unique(allowedWrites.map((write) => write.targetAlias));
  const writeMethods = unique(allowedWrites.map((write) => write.method));
  const explicitWritePairs = new Set(allowedWrites.map((write) => `${write.targetAlias}:${write.method}`));
  const widenedPairs = writeTargets.flatMap((target) => writeMethods.map((method) => `${target}:${method}`))
    .filter((pair) => !explicitWritePairs.has(pair));
  if (widenedPairs.length > 0) {
    blockers.push("The current AuthorityEnvelope would widen exact target-method bindings through a Cartesian product.");
  }
  const writeAuthority: AuthorityEnvelope["writeAuthority"] = allowedWrites.length === 0
    ? "denied"
    : approvalWrites.length === allowedWrites.length
      ? "per-action-approval"
      : "preauthorized";
  const allowedMethods: AuthorityEnvelope["allowedMethods"] = [
    ...(answers.readsAllowed.actions.length > 0 ? ["GET" as const] : []),
    ...unique(allowedWrites.map((write) => write.method)),
  ];
  const candidateAuthority: AuthorityEnvelope = {
    allowedTargetAliases: unique(answers.systemsAndTargets.aliases),
    allowedSecretAliases: unique(answers.credentialAliases.aliases),
    allowedMethods,
    writeAuthority,
    approvedWriteActions: [],
  };
  const guardrails: AuthorityWizardGuardrails = {
    allowedReadActions: structuredClone(answers.readsAllowed.actions),
    exactWriteRules: allowedWrites.map((write) => ({
      actionName: write.actionName,
      targetAlias: write.targetAlias,
      method: write.method,
      policy: write.policy as "preauthorized" | "requires-approval",
    })),
    forbiddenActions: [...forbidden].sort(),
    limits: structuredClone(answers.limits),
    ...(answers.approver.kind === "owner" ? { approverOwnerAlias: answers.approver.ownerAlias } : {}),
    reconcileBeforeRetry: true,
    blindRetryAllowed: false,
    maximumAttempts: answers.retryAndReconciliation.maximumAttempts,
  };
  return finalizeAuthorityCompilation({
    schemaVersion: "1.0",
    status: blockers.length === 0 ? "review-required" : "blocked",
    activation: "not-activated",
    authority: failClosedAuthority(),
    ...(blockers.length === 0 ? { candidateAuthority } : {}),
    guardrails,
    blockers,
    reviewItems,
    validationErrors: [],
  });
}
