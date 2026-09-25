import { createHash } from "node:crypto";
import { z } from "zod";
import {
  REQUIRED_PILOT_ADAPTER_CASES,
  type PilotAdapterAcceptanceCase,
} from "./pilot-adapter.js";
import {
  assertAdapterDiscoveryProposalSafe,
  type AdapterDiscoveryProposal,
} from "./onboarding-adapter-factory.js";
import type {
  AuthorityWizardCompilation,
  ProvisionalVerifierContract,
} from "./onboarding-verifier-authority.js";
import {
  assertAuthorityWizardCompilationIntegrity,
  assertProvisionalVerifierContractIntegrity,
} from "./onboarding-verifier-authority.js";

export const ONBOARDING_ACCEPTANCE_PLAN_SCHEMA_VERSION = "1.0" as const;

const identifier = z.string().min(3).max(160).regex(/^[a-z][a-z0-9_-]+$/);
const alias = z.string().min(3).max(160).regex(/^[a-zA-Z][a-zA-Z0-9_.-]+$/);
const bounded = z.string().trim().min(1).max(1_000);

export const onboardingAcceptanceInputSchema = z.object({
  adapterId: identifier,
  adapterVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  workflowKey: identifier,
  readOperationKeys: z.array(alias).min(1).max(64),
  writeOperationKeys: z.array(alias).max(64),
  credentialAliases: z.array(alias).max(32),
  permissionKeys: z.array(alias).max(32),
  outcomeVerifierKeys: z.array(alias).min(1).max(64),
  resetStrategy: z.object({
    kind: z.enum(["fixture-reset", "snapshot-restore", "compensating-cleanup", "unavailable"]),
    reference: bounded,
    independentlyChecked: z.boolean(),
  }).strict(),
  retry: z.object({
    duplicatePrevention: z.enum(["idempotency-key", "independent-reconciliation", "both", "unproved"]),
    reconcileBeforeRetry: z.literal(true),
    blindRetryAllowed: z.literal(false),
  }).strict(),
  persistence: z.object({
    durableJobStore: z.boolean(),
    durableCapabilityRegistry: z.boolean(),
  }).strict(),
  confirmations: z.object({
    operationsReviewed: z.boolean(),
    authorityReviewed: z.boolean(),
    verifierReviewed: z.boolean(),
    disposableEnvironmentConfirmed: z.boolean(),
  }).strict(),
}).strict();

export type OnboardingAcceptanceInput = z.infer<typeof onboardingAcceptanceInputSchema>;

export interface GeneratedAcceptanceCase {
  caseId: PilotAdapterAcceptanceCase;
  title: string;
  purpose: string;
  status: "declared-not-run";
  preconditions: string[];
  actions: string[];
  requiredAssertions: string[];
  requiredArtifacts: string[];
  blockers: string[];
}

export interface OnboardingAcceptancePlan {
  schemaVersion: typeof ONBOARDING_ACCEPTANCE_PLAN_SCHEMA_VERSION;
  planId: string;
  adapterId: string;
  adapterVersion: string;
  workflowKey: string;
  executable: false;
  passed: false;
  status: "scaffold-only";
  cases: GeneratedAcceptanceCase[];
  blockers: string[];
  inputDigest: string;
  derivationReceipt?: {
    adapterProposalDigest: string;
    verifierContractDigest: string;
    authorityCompilationDigest: string;
    authorityRuntimeBindingDigest: string;
    observationAdapterBindingDigest: string;
    confirmedByAlias: string;
    confirmedAt: string;
    receiptDigest: string;
  };
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

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function onboardingAcceptanceSourceDigest(value: unknown): string {
  return digest(value);
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function commonArtifacts(caseId: PilotAdapterAcceptanceCase): string[] {
  return [
    `acceptance://${caseId}/pre-state-digest`,
    `acceptance://${caseId}/event-ledger`,
    `acceptance://${caseId}/independent-outcome-receipt`,
    `acceptance://${caseId}/post-state-digest`,
  ];
}

function caseTemplate(
  caseId: PilotAdapterAcceptanceCase,
  title: string,
  purpose: string,
  preconditions: string[],
  actions: string[],
  requiredAssertions: string[],
  blockers: string[] = [],
): GeneratedAcceptanceCase {
  return {
    caseId,
    title,
    purpose,
    status: "declared-not-run",
    preconditions,
    actions,
    requiredAssertions,
    requiredArtifacts: commonArtifacts(caseId),
    blockers,
  };
}

function sharedBlockers(input: OnboardingAcceptanceInput): string[] {
  const blockers: string[] = [];
  if (!unique(input.readOperationKeys)) blockers.push("duplicate-read-operation-keys");
  if (!unique(input.writeOperationKeys)) blockers.push("duplicate-write-operation-keys");
  if (!unique(input.credentialAliases)) blockers.push("duplicate-credential-aliases");
  if (!unique(input.permissionKeys)) blockers.push("duplicate-permission-keys");
  if (!unique(input.outcomeVerifierKeys)) blockers.push("duplicate-verifier-keys");
  if (input.resetStrategy.kind === "unavailable") blockers.push("disposable-reset-strategy-unavailable");
  if (!input.resetStrategy.independentlyChecked) blockers.push("reset-strategy-not-independently-checked");
  if (!input.confirmations.operationsReviewed) blockers.push("operation-inventory-not-reviewed");
  if (!input.confirmations.authorityReviewed) blockers.push("authority-contract-not-reviewed");
  if (!input.confirmations.verifierReviewed) blockers.push("verifier-contract-not-reviewed");
  if (!input.confirmations.disposableEnvironmentConfirmed) blockers.push("disposable-environment-not-confirmed");
  return blockers;
}

/**
 * Generates a precommitted acceptance specification, never an executable or
 * passing harness. Customer-specific setup must implement every action and
 * preserve the required independent evidence before the existing runner can
 * execute the cases.
 */
export function generateOnboardingAcceptancePlan(raw: OnboardingAcceptanceInput): OnboardingAcceptancePlan {
  const input = onboardingAcceptanceInputSchema.parse(raw);
  const blockers = sharedBlockers(input);
  const hasWrite = input.writeOperationKeys.length > 0;
  const needsCredential = input.credentialAliases.length > 0;
  const needsPermission = input.permissionKeys.length > 0;
  const writeBlocker = hasWrite ? [] : ["no-bounded-write-operation-declared"];
  const credentialBlocker = needsCredential ? [] : ["no-credential-alias-declared"];
  const permissionBlocker = needsPermission ? [] : ["no-write-permission-key-declared"];

  const cases: GeneratedAcceptanceCase[] = [
    caseTemplate(
      "read-only-happy-path",
      "Read-only success",
      "Prove a bounded read can complete without creating any external write.",
      ["Disposable state is reset.", "At least one approved read operation is available."],
      ["Submit a read-only work item.", "Observe the result through the independent outcome source."],
      ["The intended read result is correct.", "Write attempts equal zero.", "Incorrect side effects equal zero."],
    ),
    caseTemplate(
      "approved-write",
      "Approved write",
      "Prove an explicitly authorized write changes only the intended external state.",
      ["Disposable state is reset.", "Credential alias resolves locally.", "Exact write permission is active."],
      ["Submit one bounded write.", "Read external state through the independent observer."],
      ["Exactly one intended write exists.", "Completion criteria pass.", "Collateral state is unchanged."],
      [...writeBlocker, ...credentialBlocker, ...permissionBlocker],
    ),
    caseTemplate(
      "fresh-process-reuse",
      "Fresh-process reuse",
      "Prove a verified retained capability can be loaded after process restart instead of rebuilt.",
      ["An earlier successful case retained a verified capability.", "The process is stopped without deleting durable registry state."],
      ["Start a fresh process.", "Submit an equivalent work item."],
      ["The retained version is selected.", "No new capability is built.", "The external outcome independently passes."],
      input.persistence.durableCapabilityRegistry ? [] : ["durable-capability-registry-not-configured"],
    ),
    caseTemplate(
      "missing-credential",
      "Missing credential fails closed",
      "Prove an absent customer-local credential creates a precise handoff before external execution.",
      ["The required credential alias is declared but deliberately unresolved."],
      ["Submit a work item that requires the missing alias."],
      ["The result is blocked for the exact alias.", "Write attempts equal zero.", "No credential value enters evidence."],
      [...writeBlocker, ...credentialBlocker],
    ),
    caseTemplate(
      "missing-permission",
      "Missing permission fails closed",
      "Prove a valid capability and credential cannot create authority.",
      ["Credential alias resolves locally.", "The exact required permission is absent."],
      ["Submit a work item that requires the absent permission."],
      ["The result is blocked for the exact permission.", "Write attempts equal zero.", "No broader permission is inferred."],
      [...writeBlocker, ...permissionBlocker],
    ),
    caseTemplate(
      "lost-response-reconciliation",
      "Lost-response reconciliation",
      "Prove a successful external write is reconciled before retry when its transport response is lost.",
      ["The transport can deterministically lose one response after committing the write.", "A separate read path can observe the write."],
      ["Execute one approved write and discard its response.", "Reconcile external state before considering retry."],
      ["The committed outcome is recognized.", "The write is not repeated.", "Exactly one intended external record exists."],
      [...writeBlocker, ...(input.retry.duplicatePrevention === "unproved" ? ["duplicate-prevention-not-proved"] : [])],
    ),
    caseTemplate(
      "wrong-or-partial-outcome",
      "Partial or wrong outcome is rejected",
      "Prove execution success cannot substitute for independently observed business completion.",
      ["A fixture can create a partial or incorrect external result."],
      ["Execute the bounded action against the partial-result fixture.", "Observe completion and collateral state independently."],
      ["The outcome does not pass.", "The capability is not retained as healthy.", "The incident or handoff names the failed condition."],
      writeBlocker,
    ),
    caseTemplate(
      "sidecar-restart",
      "Restart recovery",
      "Prove durable work identity and external reconciliation survive a customer-local runtime restart.",
      ["A work item is durably queued or executing.", "The process can be terminated at a fixed checkpoint."],
      ["Terminate the process.", "Restart from the same state directory.", "Reconcile before continuing."],
      ["The same parent and work-item identities are recovered.", "No duplicate write occurs.", "The final state is independently classified."],
      input.persistence.durableJobStore ? [] : ["durable-job-store-not-configured"],
    ),
    caseTemplate(
      "duplicate-submission",
      "Duplicate parent submission",
      "Prove the same parent request cannot start a second business operation.",
      ["A stable parent identity and request digest are available."],
      ["Submit the identical parent request twice."],
      ["Both submissions resolve to one durable job.", "No duplicate child work or external write exists."],
    ),
    caseTemplate(
      "conflicting-parent-reuse",
      "Conflicting parent reuse",
      "Prove a reused parent identity with different intent is rejected rather than merged.",
      ["One parent identity is already bound to an accepted request digest."],
      ["Submit different goal content using the same parent identity."],
      ["The second request is rejected as a conflict.", "Existing work is unchanged.", "Write attempts from the conflicting request equal zero."],
    ),
  ];

  if (cases.map((item) => item.caseId).join("|") !== REQUIRED_PILOT_ADAPTER_CASES.join("|")) {
    throw new Error("Generated acceptance cases do not match the mandatory precommitted order.");
  }

  const inputDigest = digest(input);
  return {
    schemaVersion: ONBOARDING_ACCEPTANCE_PLAN_SCHEMA_VERSION,
    planId: `acceptance-${inputDigest.slice(0, 24)}`,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    workflowKey: input.workflowKey,
    executable: false,
    passed: false,
    status: "scaffold-only",
    cases,
    blockers: [...new Set([...blockers, ...cases.flatMap((item) => item.blockers)])].sort(),
    inputDigest,
  };
}

export interface ReviewedOnboardingContractsInput {
  adapterId: string;
  adapterVersion: string;
  adapterProposal: AdapterDiscoveryProposal;
  verifierContract: ProvisionalVerifierContract;
  authorityCompilation: AuthorityWizardCompilation;
  executionDriverId: string;
  duplicatePrevention: Exclude<OnboardingAcceptanceInput["retry"]["duplicatePrevention"], "unproved">;
  resetStrategy: OnboardingAcceptanceInput["resetStrategy"];
  persistence: OnboardingAcceptanceInput["persistence"];
  review: {
    adapterProposalDigest: string;
    verifierContractDigest: string;
    authorityCompilationDigest: string;
    authorityRuntimeBindingDigest: string;
    observationAdapterBindingDigest: string;
    confirmedByAlias: string;
    confirmedAt: string;
  };
}

/**
 * Derives the fixed acceptance plan from the exact reviewed artifacts instead
 * of allowing operation, credential, authority, and verifier keys to be
 * manually restated. Digest mismatch or an incomplete contract fails closed.
 */
export function generateAcceptancePlanFromReviewedContracts(
  input: ReviewedOnboardingContractsInput,
): OnboardingAcceptancePlan {
  assertAdapterDiscoveryProposalSafe(input.adapterProposal);
  assertProvisionalVerifierContractIntegrity(input.verifierContract);
  assertAuthorityWizardCompilationIntegrity(input.authorityCompilation);
  if (input.review.adapterProposalDigest !== digest(input.adapterProposal)) throw new Error("Reviewed adapter proposal digest does not match the supplied artifact.");
  if (input.review.verifierContractDigest !== digest(input.verifierContract)) throw new Error("Reviewed verifier contract digest does not match the supplied artifact.");
  if (input.review.authorityCompilationDigest !== digest(input.authorityCompilation)) throw new Error("Reviewed authority compilation digest does not match the supplied artifact.");
  if (!alias.safeParse(input.review.confirmedByAlias).success || !Number.isFinite(Date.parse(input.review.confirmedAt))) {
    throw new Error("Reviewed contracts require a stable confirmer alias and timestamp.");
  }
  for (const [label, value] of [
    ["authority runtime binding", input.review.authorityRuntimeBindingDigest],
    ["observation adapter binding", input.review.observationAdapterBindingDigest],
  ] as const) {
    if (!/^[a-f0-9]{64}$/.test(value) || /^0+$/.test(value)) throw new Error(`Reviewed ${label} digest is missing or invalid.`);
  }
  if (input.verifierContract.status !== "provisional-review-required"
    || !input.verifierContract.independentObserver
    || !input.verifierContract.criterionContractDraft) {
    throw new Error("Verifier contract is still blocked or lacks an independent observation and criterion draft.");
  }
  if (input.authorityCompilation.status !== "review-required" || !input.authorityCompilation.candidateAuthority) {
    throw new Error("Authority compilation is still blocked or lacks a reviewable candidate contract.");
  }
  if (input.verifierContract.executionDriverId !== input.executionDriverId) throw new Error("Verifier contract is bound to a different execution driver.");
  if (input.verifierContract.ordinaryBusinessOutcome !== input.adapterProposal.scopeWorkflow.requiredOutcome.value) {
    throw new Error("Verifier business outcome does not match the reviewed adapter workflow outcome.");
  }
  const requested = input.adapterProposal.operations.filter((operation) => operation.requestedByWorkflow.value);
  if (requested.length === 0) throw new Error("Reviewed adapter proposal contains no exact requested operation mapping.");
  const readOperationKeys = requested.filter((operation) => operation.consequence.value === "read").map((operation) => operation.operationKey.value);
  const writeOperationKeys = requested.filter((operation) => operation.consequence.value === "write").map((operation) => operation.operationKey.value);
  if (requested.some((operation) => operation.consequence.value === "unknown")) {
    throw new Error("Reviewed adapter proposal still contains an operation with unknown side effects.");
  }
  if (requested.some((operation) => operation.sourceKind.value !== "http")) {
    throw new Error("Current reviewed-contract acceptance derivation supports only the constrained HTTP operation family.");
  }
  const requestedTargets = distinct(requested.map((operation) => operation.targetAlias.value)).sort();
  const authorityTargets = [...input.authorityCompilation.candidateAuthority.allowedTargetAliases].sort();
  if (JSON.stringify(requestedTargets) !== JSON.stringify(authorityTargets)) {
    throw new Error("Authority target aliases do not exactly match the reviewed requested operations.");
  }
  const requestedCredentials = distinct(requested.flatMap((operation) => operation.credentialAliases.value)).sort();
  const authorityCredentials = [...input.authorityCompilation.candidateAuthority.allowedSecretAliases].sort();
  if (JSON.stringify(requestedCredentials) !== JSON.stringify(authorityCredentials)) {
    throw new Error("Authority credential aliases do not exactly match the reviewed requested operations.");
  }
  const requestedReadRules = new Set(requested.filter((item) => item.consequence.value === "read")
    .map((operation) => `${operation.targetAlias.value}.${operation.operationId.value}`));
  const readRules = new Set(input.authorityCompilation.guardrails.allowedReadActions.map((rule) => `${rule.targetAlias}.${rule.actionName}`));
  for (const operation of requested.filter((item) => item.consequence.value === "read")) {
    if (!readRules.has(`${operation.targetAlias.value}.${operation.operationId.value}`)) {
      throw new Error(`Authority read rules do not cover ${operation.operationKey.value}.`);
    }
  }
  if (JSON.stringify([...readRules].sort()) !== JSON.stringify([...requestedReadRules].sort())) {
    throw new Error("Authority read rules are broader than or different from the reviewed requested operations.");
  }
  const requestedWriteRules = new Set(requested.filter((item) => item.consequence.value === "write")
    .map((operation) => `${operation.targetAlias.value}.${operation.operationId.value}:${operation.transportAction.value.split(" ", 1)[0]}`));
  const writeRules = new Set(input.authorityCompilation.guardrails.exactWriteRules.map((rule) => `${rule.targetAlias}.${rule.actionName}:${rule.method}`));
  for (const operation of requested.filter((item) => item.consequence.value === "write")) {
    const method = operation.transportAction.value.split(" ", 1)[0];
    if (!writeRules.has(`${operation.targetAlias.value}.${operation.operationId.value}:${method}`)) {
      throw new Error(`Authority write rules do not cover ${operation.operationKey.value} with its exact HTTP method.`);
    }
  }
  if (JSON.stringify([...writeRules].sort()) !== JSON.stringify([...requestedWriteRules].sort())) {
    throw new Error("Authority write rules are broader than or different from the reviewed requested operations.");
  }
  if (readOperationKeys.length === 0) throw new Error("Acceptance derivation requires an approved read path for inspection and reconciliation.");
  const credentialAliases = requestedCredentials;
  const permissionKeys = distinct(input.authorityCompilation.guardrails.exactWriteRules.map((rule) => rule.actionName));

  const plan = generateOnboardingAcceptancePlan({
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    workflowKey: input.adapterProposal.scopeWorkflow.workflowId.value,
    readOperationKeys,
    writeOperationKeys,
    credentialAliases,
    permissionKeys,
    outcomeVerifierKeys: [input.verifierContract.criterionContractDraft.key],
    resetStrategy: structuredClone(input.resetStrategy),
    retry: { duplicatePrevention: input.duplicatePrevention, reconcileBeforeRetry: true, blindRetryAllowed: false },
    persistence: structuredClone(input.persistence),
    confirmations: {
      operationsReviewed: true,
      authorityReviewed: true,
      verifierReviewed: true,
      disposableEnvironmentConfirmed: input.resetStrategy.kind !== "unavailable" && input.resetStrategy.independentlyChecked,
    },
  });
  const receiptSource = {
    adapterProposalDigest: input.review.adapterProposalDigest,
    verifierContractDigest: input.review.verifierContractDigest,
    authorityCompilationDigest: input.review.authorityCompilationDigest,
    authorityRuntimeBindingDigest: input.review.authorityRuntimeBindingDigest,
    observationAdapterBindingDigest: input.review.observationAdapterBindingDigest,
    confirmedByAlias: input.review.confirmedByAlias,
    confirmedAt: input.review.confirmedAt,
  };
  return {
    ...plan,
    derivationReceipt: {
      ...receiptSource,
      receiptDigest: digest({
        ...receiptSource,
        generatedPlanInputDigest: plan.inputDigest,
      }),
    },
  };
}
