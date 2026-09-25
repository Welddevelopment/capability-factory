import { createHash } from "node:crypto";
import {
  assertCompiledHttpBindingPairIntegrity,
  type CompiledHttpBindingPair,
} from "./http-binding-compiler.js";
import {
  assertHttpBindingFactoryResultIntegrity,
  type HttpBindingFactoryResult,
} from "./http-binding-factory.js";
import type { GenericAcceptanceCampaignState, GenericAcceptanceEvidenceReceipt } from "./generic-acceptance-executor.js";
import {
  onboardingPreparationDigest,
  type OnboardingPreparationSnapshot,
  type StartOnboardingPreparationInput,
} from "./onboarding-preparation-workflow.js";
import { REQUIRED_PILOT_ADAPTER_CASES } from "./pilot-adapter.js";
import { VerifierTemplateQualificationRegistry } from "./verifier-template-qualification.js";

export const ONBOARDING_READINESS_RECEIPT_VERSION = "1.0" as const;

export interface CustomerReadinessDeclaration {
  key: string;
  value: boolean | string | number;
  declaredByAlias: string;
  declaredAt: string;
}

export interface OnboardingReadinessExpectation {
  sessionId: string;
  inputDigest: string;
  snapshotDigest: string;
  snapshotRevision: number;
  factoryResultDigest: string;
  compiledPairDigest: string;
  campaignId: string;
  campaignRevision: number;
  latestAcceptanceReceiptHash: string;
}

export interface BuildOnboardingReadinessReceiptInput {
  schemaVersion: typeof ONBOARDING_READINESS_RECEIPT_VERSION;
  intake: StartOnboardingPreparationInput;
  preparation: OnboardingPreparationSnapshot;
  factoryResult: HttpBindingFactoryResult;
  compiledPair: CompiledHttpBindingPair;
  acceptanceCampaign: GenericAcceptanceCampaignState;
  expectation: OnboardingReadinessExpectation;
  customerDeclarations?: CustomerReadinessDeclaration[];
  evaluatedAt: string;
  maximumEvidenceAgeSeconds: number;
}

export interface OnboardingReadinessReceipt {
  schemaVersion: typeof ONBOARDING_READINESS_RECEIPT_VERSION;
  state: "synthetic-acceptance-complete-activation-blocked";
  activated: false;
  humanIndependentOnboardingProved: false;
  customerEvidence: false;
  productionReady: false;
  identity: {
    sessionId: string;
    tenantId: string;
    adapterId: string;
    adapterVersion: string;
    inputDigest: string;
    snapshotDigest: string;
    snapshotRevision: number;
    factoryResultDigest: string;
    compiledPairDigest: string;
    campaignId: string;
    campaignRevision: number;
    latestAcceptanceReceiptHash: string;
  };
  artifactStates: {
    preparation: "acceptance-scaffold-ready";
    declarations: "review-required";
    compiledBindings: "compiled-acceptance-only";
    verifierQualification: "qualified-and-current";
    genericAcceptance: "ten-of-ten-synthetic-passed";
    activationAuthority: "not-established";
  };
  responsibility: {
    suppliedByCustomerOrEngineer: string[];
    proposedOrScaffoldedByCapabilityFactory: string[];
    independentlyQualifiedOrExecutedLocally: string[];
  };
  customerDeclarations: Array<CustomerReadinessDeclaration & { evidenceClass: "customer-declaration-only" }>;
  remainingBespokeWork: string[];
  unsupportedSemantics: string[];
  evidenceBoundary: string;
  evaluatedAt: string;
  receiptDigest: string;
}

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function onboardingReadinessDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function withoutSnapshotDigest(snapshot: OnboardingPreparationSnapshot): Omit<OnboardingPreparationSnapshot, "snapshotDigest"> {
  const { snapshotDigest: _snapshotDigest, ...payload } = snapshot;
  return payload;
}

function receiptPayload(receipt: OnboardingReadinessReceipt): Omit<OnboardingReadinessReceipt, "receiptDigest"> {
  const { receiptDigest: _receiptDigest, ...payload } = receipt;
  return payload;
}

function assertTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an explicit ISO-8601 timestamp.`);
  return parsed;
}

function assertFresh(evidenceAt: string, evaluatedAt: string, maximumAgeSeconds: number, label: string): void {
  const evidence = assertTimestamp(evidenceAt, `${label} timestamp`);
  const evaluation = assertTimestamp(evaluatedAt, "Readiness evaluation timestamp");
  if (!Number.isInteger(maximumAgeSeconds) || maximumAgeSeconds <= 0 || maximumAgeSeconds > 90 * 24 * 60 * 60) {
    throw new Error("Maximum evidence age must be between one second and 90 days.");
  }
  if (evidence > evaluation) throw new Error(`${label} evidence is from the future.`);
  if (evaluation - evidence > maximumAgeSeconds * 1_000) throw new Error(`${label} evidence is stale.`);
}

function acceptanceReceiptPayload(receipt: GenericAcceptanceEvidenceReceipt): Omit<GenericAcceptanceEvidenceReceipt, "receiptHash"> {
  const { receiptHash: _receiptHash, ...payload } = receipt;
  return payload;
}

function assertAcceptanceCampaign(state: GenericAcceptanceCampaignState, pairDigest: string): string {
  if (state.schemaVersion !== "1.0" || state.status !== "completed") throw new Error("Generic acceptance campaign is not complete.");
  if (state.declarationDigest !== pairDigest || state.bindingDigest !== pairDigest) {
    throw new Error("Generic acceptance campaign is bound to a different compiled pair.");
  }
  if (state.requiredCaseOrder.length !== REQUIRED_PILOT_ADAPTER_CASES.length
    || state.requiredCaseOrder.some((caseId, index) => caseId !== REQUIRED_PILOT_ADAPTER_CASES[index])) {
    throw new Error("Generic acceptance campaign did not preserve the mandatory ten-case order.");
  }
  if (state.cases.length !== REQUIRED_PILOT_ADAPTER_CASES.length
    || state.cases.some((record, index) => record.caseId !== REQUIRED_PILOT_ADAPTER_CASES[index] || record.status !== "passed")) {
    throw new Error("Every mandatory generic acceptance case must pass exactly once in the recorded campaign state.");
  }
  if (state.receipts.length !== REQUIRED_PILOT_ADAPTER_CASES.length) {
    throw new Error("Generic acceptance campaign must contain exactly one evidence receipt per mandatory case.");
  }
  let previous: string | undefined;
  for (let index = 0; index < state.receipts.length; index += 1) {
    const receipt = state.receipts[index]!;
    if (receipt.caseId !== REQUIRED_PILOT_ADAPTER_CASES[index]
      || receipt.campaignId !== state.campaignId
      || receipt.bindingId !== state.bindingId
      || receipt.bindingVersion !== state.bindingVersion
      || receipt.bindingDigest !== state.bindingDigest
      || receipt.declarationDigest !== state.declarationDigest) {
      throw new Error("Generic acceptance evidence receipt identity does not match its campaign.");
    }
    if (receipt.previousReceiptHash !== previous) throw new Error("Generic acceptance evidence chain is broken.");
    if (onboardingReadinessDigest(acceptanceReceiptPayload(receipt)) !== receipt.receiptHash) {
      throw new Error("Generic acceptance evidence receipt failed its integrity check.");
    }
    if (!receipt.result.passed
      || receipt.result.incorrectSideEffects !== 0
      || receipt.result.checks.length === 0
      || receipt.result.checks.some((check) => !check.passed)) {
      throw new Error("Generic acceptance evidence contains a failure or surviving incorrect side effect.");
    }
    previous = receipt.receiptHash;
  }
  return previous!;
}

function assertExpectation(input: BuildOnboardingReadinessReceiptInput, latestReceiptHash: string): void {
  const { expectation, preparation, factoryResult, compiledPair, acceptanceCampaign } = input;
  const exact = [
    [expectation.sessionId, preparation.sessionId, "session"],
    [expectation.inputDigest, preparation.inputDigest, "input digest"],
    [expectation.snapshotDigest, preparation.snapshotDigest, "snapshot digest"],
    [expectation.factoryResultDigest, factoryResult.resultDigest, "factory result digest"],
    [expectation.compiledPairDigest, compiledPair.pairDigest, "compiled pair digest"],
    [expectation.campaignId, acceptanceCampaign.campaignId, "campaign ID"],
    [expectation.latestAcceptanceReceiptHash, latestReceiptHash, "latest acceptance receipt hash"],
  ] as const;
  for (const [expected, actual, label] of exact) if (expected !== actual) throw new Error(`Expected onboarding ${label} is stale or belongs to another artifact chain.`);
  if (expectation.snapshotRevision !== preparation.revision || expectation.campaignRevision !== acceptanceCampaign.revision) {
    throw new Error("Expected onboarding revision is stale or belongs to another artifact chain.");
  }
}

/**
 * Produces one integrity-bound answer about local onboarding preparation. This
 * receipt intentionally has no input capable of granting activation: customer
 * claims of readiness are retained as declarations, never promoted to proof.
 */
export function buildOnboardingReadinessReceipt(input: BuildOnboardingReadinessReceiptInput): OnboardingReadinessReceipt {
  if (input.schemaVersion !== ONBOARDING_READINESS_RECEIPT_VERSION) throw new Error("Unsupported onboarding readiness receipt version.");
  if (onboardingPreparationDigest(input.intake) !== input.preparation.inputDigest) throw new Error("Onboarding intake does not match the durable preparation input digest.");
  if (onboardingReadinessDigest(withoutSnapshotDigest(input.preparation)) !== input.preparation.snapshotDigest) {
    throw new Error("Onboarding preparation snapshot failed its integrity check.");
  }
  if (input.intake.sessionId !== input.preparation.sessionId
    || input.intake.tenantId !== input.preparation.tenantId
    || input.intake.adapterId !== input.preparation.adapterId
    || input.intake.adapterVersion !== input.preparation.adapterVersion) {
    throw new Error("Onboarding intake and preparation identity do not match.");
  }
  if (input.preparation.status !== "acceptance-scaffold-ready"
    || input.preparation.activation !== "not-activated"
    || !input.preparation.acceptancePlan
    || input.preparation.acceptancePlan.blockers.length > 0) {
    throw new Error("Onboarding preparation has not reached an unblocked acceptance scaffold.");
  }
  assertHttpBindingFactoryResultIntegrity(input.factoryResult);
  if (input.factoryResult.status !== "review-required" || !input.factoryResult.actionBinding || !input.factoryResult.observerBinding) {
    throw new Error("HTTP binding declarations are not ready for exact review.");
  }
  assertCompiledHttpBindingPairIntegrity(input.compiledPair);
  if (input.compiledPair.action.declarationDigest !== input.factoryResult.actionBinding.declarationDigest
    || input.compiledPair.observer.declarationDigest !== input.factoryResult.observerBinding.declarationDigest) {
    throw new Error("Compiled bindings belong to different reviewed declarations.");
  }
  if (input.factoryResult.actionBinding.provenance.authorityCompilationDigest !== input.preparation.authorityCompilation.compilationDigest
    || input.factoryResult.observerBinding.provenance.authorityCompilationDigest !== input.preparation.authorityCompilation.compilationDigest) {
    throw new Error("Binding declarations belong to a different reviewed authority compilation.");
  }
  const verifierRegistry = new VerifierTemplateQualificationRegistry([input.compiledPair.observerQualificationReceipt]);
  verifierRegistry.assertQualified({
    reference: input.compiledPair.observer.qualification,
    runtimeFamily: "constrained-http-api",
    primitiveRegistryDigest: input.compiledPair.dependencies.primitiveRegistryDigest,
    verifierRegistryDigest: input.compiledPair.dependencies.verifierRegistryDigest,
    now: input.evaluatedAt,
  });
  const latestReceiptHash = assertAcceptanceCampaign(input.acceptanceCampaign, input.compiledPair.pairDigest);
  assertExpectation(input, latestReceiptHash);
  assertFresh(input.preparation.updatedAt, input.evaluatedAt, input.maximumEvidenceAgeSeconds, "Preparation snapshot");
  assertFresh(input.acceptanceCampaign.updatedAt, input.evaluatedAt, input.maximumEvidenceAgeSeconds, "Acceptance campaign");

  const declarations = (input.customerDeclarations ?? []).map((declaration) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{1,179}$/.test(declaration.key)
      || !/^[a-zA-Z][a-zA-Z0-9_.-]{1,179}$/.test(declaration.declaredByAlias)) {
      throw new Error("Customer readiness declarations require stable non-secret aliases.");
    }
    assertTimestamp(declaration.declaredAt, "Customer declaration timestamp");
    return { ...structuredClone(declaration), evidenceClass: "customer-declaration-only" as const };
  });
  const supersededByCompiledQualifiedObserver = [
    "Bind the approved observation implementation through createFreshnessEnforcingObservationAdapter before compiling the criterion contract.",
    "External outcome observation and verifier implementation remain unset.",
  ];
  const payload: Omit<OnboardingReadinessReceipt, "receiptDigest"> = {
    schemaVersion: ONBOARDING_READINESS_RECEIPT_VERSION,
    state: "synthetic-acceptance-complete-activation-blocked",
    activated: false,
    humanIndependentOnboardingProved: false,
    customerEvidence: false,
    productionReady: false,
    identity: {
      sessionId: input.preparation.sessionId,
      tenantId: input.preparation.tenantId,
      adapterId: input.preparation.adapterId,
      adapterVersion: input.preparation.adapterVersion,
      inputDigest: input.preparation.inputDigest,
      snapshotDigest: input.preparation.snapshotDigest,
      snapshotRevision: input.preparation.revision,
      factoryResultDigest: input.factoryResult.resultDigest,
      compiledPairDigest: input.compiledPair.pairDigest,
      campaignId: input.acceptanceCampaign.campaignId,
      campaignRevision: input.acceptanceCampaign.revision,
      latestAcceptanceReceiptHash: latestReceiptHash,
    },
    artifactStates: {
      preparation: "acceptance-scaffold-ready",
      declarations: "review-required",
      compiledBindings: "compiled-acceptance-only",
      verifierQualification: "qualified-and-current",
      genericAcceptance: "ten-of-ten-synthetic-passed",
      activationAuthority: "not-established",
    },
    responsibility: {
      suppliedByCustomerOrEngineer: [...input.preparation.receipt.suppliedByCustomerOrEngineer],
      proposedOrScaffoldedByCapabilityFactory: [...input.preparation.receipt.generatedByCapabilityFactory],
      independentlyQualifiedOrExecutedLocally: [
        "compiled observer passed the mandatory verifier-template negative-control corpus",
        "all ten fixed generic acceptance cases produced integrity-chained local synthetic evidence",
      ],
    },
    customerDeclarations: declarations,
    remainingBespokeWork: [
      ...new Set([
        ...input.preparation.receipt.implementationWorkRemaining.filter((item) => !item.startsWith("Execute every declared acceptance case") && !supersededByCompiledQualifiedObserver.includes(item)),
        "Bind and independently review the real customer-local transports, credential resolver, reset path and observation surfaces.",
        "Obtain exact activation authority for one real environment; this receipt cannot grant it.",
        "Run the frozen comparison with a fresh platform engineer and then a controlled customer workflow.",
      ]),
    ],
    unsupportedSemantics: [
      "unreviewed or undocumented HTTP operations",
      "pagination and multi-page reconciliation",
      "post-action-only identifiers that are unavailable before execution",
      "arbitrary code, browser, file, inbox, database, device or human-delegation capability modes",
      "automatic compensation or reversal after an incorrect external outcome",
    ],
    evidenceBoundary: "This integrity-bound receipt joins one exact local synthetic onboarding artifact chain. It proves neither independent human onboarding, customer activation, customer evidence, production readiness, nor authority to act. Customer readiness claims are preserved only as declarations.",
    evaluatedAt: input.evaluatedAt,
  };
  return { ...payload, receiptDigest: onboardingReadinessDigest(payload) };
}

export function assertOnboardingReadinessReceiptIntegrity(receipt: OnboardingReadinessReceipt): void {
  if (receipt.schemaVersion !== ONBOARDING_READINESS_RECEIPT_VERSION
    || receipt.state !== "synthetic-acceptance-complete-activation-blocked"
    || receipt.activated !== false
    || receipt.humanIndependentOnboardingProved !== false
    || receipt.customerEvidence !== false
    || receipt.productionReady !== false
    || receipt.artifactStates.activationAuthority !== "not-established") {
    throw new Error("Onboarding readiness receipt contains an unsupported readiness or activation state.");
  }
  if (onboardingReadinessDigest(receiptPayload(receipt)) !== receipt.receiptDigest) {
    throw new Error("Onboarding readiness receipt failed its integrity check.");
  }
}
