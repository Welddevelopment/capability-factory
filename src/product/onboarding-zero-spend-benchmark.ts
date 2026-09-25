import { createHash } from "node:crypto";
import {
  discoverAdapterProposal,
  type AdapterDiscoveryInput,
  type AdapterDiscoveryProposal,
  type JsonValue,
} from "./onboarding-adapter-factory.js";
import { generateOnboardingAcceptancePlan } from "./onboarding-acceptance-factory.js";
import {
  compileAuthorityWizard,
  proposeExternalOutcomeVerifier,
  type AuthorityWizardAnswers,
  type VerifierFactoryIntake,
} from "./onboarding-verifier-authority.js";
import { DEFAULT_RUNTIME_FAMILY_REGISTRY } from "./universal-capability-contract.js";

export const ZERO_SPEND_ONBOARDING_BENCHMARK_VERSION = "1.0" as const;

export interface ZeroSpendOnboardingBenchmarkFixtures {
  unfamiliarOpenApi: JsonValue;
  adversarialOpenApi: JsonValue;
  adversarialAuthorityEvidenceOpenApi: JsonValue;
}

export interface ZeroSpendBenchmarkCaseResult {
  caseId:
    | "fresh-openapi-development-fixture"
    | "ambiguous-workflow"
    | "missing-verifier"
    | "authority-conflict"
    | "unsupported-mode"
    | "credential-injection-artifact"
    | "authority-evidence-injection-artifact";
  passed: boolean;
  expected: string;
  observed: string;
  blockers: string[];
}

export interface ZeroSpendOnboardingBenchmarkReport {
  schemaVersion: typeof ZERO_SPEND_ONBOARDING_BENCHMARK_VERSION;
  precommittedInCode: true;
  benchmarkManifestDigest: string;
  fixtureDigest: string;
  provider: "deterministic-offline";
  modelCalls: 0;
  paidSpendUsd: 0;
  passed: boolean;
  cases: ZeroSpendBenchmarkCaseResult[];
  metrics: {
    selectedAdapterAssertionsRequired: number;
    selectedAdapterAssertionsCorrect: number;
    selectedAdapterAssertionPassPercent: number;
    unsupportedOperationsInvented: number;
    unauthorizedAuthorityInferred: number;
    credentialValuesLeakedOrInvented: number;
    clarificationOrConfirmationItems: number;
    verifierCompleteness: "blocked-missing-observer-and-freshness-binding";
    engineerTasksRemaining: string[];
    estimatedOnboardingTimeSaved: "not-estimated-without-human-baseline";
  };
  claimBoundary: string;
}

const expectedOperations = ["getShipment", "listDockAllocations", "createDockAllocation"] as const;
const BENCHMARK_MANIFEST = {
  version: ZERO_SPEND_ONBOARDING_BENCHMARK_VERSION,
  cases: [
    "fresh-openapi-development-fixture",
    "ambiguous-workflow",
    "missing-verifier",
    "authority-conflict",
    "unsupported-mode",
    "credential-injection-artifact",
    "authority-evidence-injection-artifact",
  ],
  expectedOperations,
  safetyMaximums: { unsupportedOperationsInvented: 0, unauthorizedAuthorityInferred: 0, credentialValuesLeakedOrInvented: 0 },
} as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function adapterInput(document: JsonValue, requestedOperationNames = ["createDockAllocation"]): AdapterDiscoveryInput {
  return {
    schemaVersion: "1.0",
    workflow: {
      workflowId: "allocate-approved-shipment",
      summary: "Allocate one approved shipment to a draft dock slot.",
      requiredOutcome: "Exactly one fresh draft dock allocation exists for the approved shipment and no unrelated allocation changes.",
      approvedTargetAliases: ["yardpass_sandbox"],
      requestedOperationNames,
      customerConfirmed: true,
    },
    materials: [{
      kind: "openapi",
      materialId: "yardpass-openapi",
      localReference: "test/fixtures/onboarding-zero-spend/yardpass-openapi.json",
      approved: true,
      targetAlias: "yardpass_sandbox",
      document,
    }],
  };
}

function verifierInput(): VerifierFactoryIntake {
  return {
    schemaVersion: "1.0",
    outcomeKey: "dock-allocation-recorded",
    ordinaryBusinessOutcome: "Exactly one fresh draft dock allocation exists for the approved shipment and no unrelated allocation changes.",
    executionDriverId: "yardpass-http-driver",
    successCriteria: [
      { key: "draft-status", observationKey: "allocation", path: ["status"], operator: "equals", expected: "draft" },
      { key: "shipment-linked", observationKey: "allocation", path: ["shipmentId"], operator: "equals", expected: "SHIP-42" },
    ],
    duplicateCheck: { observationKey: "matching-allocations", path: [], expectedCount: 1 },
    collateralEffectCountObservationKey: "incorrect-side-effects",
    freshness: { maximumAgeSeconds: 30, observedAtKey: "observed-at", notBeforeBoundary: "trusted-operation-start", boundaryConfirmed: true },
    observationSurfaces: [{
      key: "create-response",
      sourceId: "yardpass-http-driver",
      description: "The acting HTTP response, deliberately invalid as independent proof.",
      sourceKind: "action-response",
      observationKeys: ["allocation", "matching-allocations", "incorrect-side-effects", "observed-at"],
      approvedForThisOutcome: true,
      independentFromExecution: false,
      independenceConfirmed: false,
      supportsFreshnessBoundary: true,
    }],
  };
}

function conflictingAuthority(): AuthorityWizardAnswers {
  return {
    schemaVersion: "1.0",
    systemsAndTargets: { aliases: ["yardpass_sandbox"], confirmed: true },
    credentialAliases: { aliases: ["yardpassBearer"], confirmed: true },
    readsAllowed: { actions: [{ actionName: "getShipment", targetAlias: "yardpass_sandbox" }], confirmed: true },
    writes: [],
    limits: {
      monetary: { kind: "none", confirmed: true },
      quantityPerAction: { kind: "none", confirmed: true },
      actionsPerHour: { kind: "limit", maximum: 20, confirmed: true },
    },
    forbiddenActions: { actionNames: ["getShipment"], confirmed: true },
    approver: { kind: "not-required", confirmed: true },
    retryAndReconciliation: { reconcileBeforeRetry: true, blindRetryAllowed: false, maximumAttempts: 1, confirmed: true },
    finalConsequentialReview: { confirmed: true },
  };
}

function scoreAdapter(proposal: AdapterDiscoveryProposal) {
  const operations = new Map(proposal.operations.map((operation) => [operation.operationId.value, operation]));
  const checks = [
    proposal.systems[0]?.label.value === "YardPass Sandbox API",
    proposal.targets[0]?.alias.value === "yardpass_sandbox",
    proposal.credentialAliases.some((item) => item.alias.value === "sandboxBearer" && item.valuePresent === false),
    expectedOperations.every((operationId) => operations.has(operationId)),
    operations.get("getShipment")?.consequence.value === "read",
    operations.get("listDockAllocations")?.consequence.value === "read",
    operations.get("createDockAllocation")?.consequence.value === "write",
    operations.get("createDockAllocation")?.idempotency.value === "documented",
    operations.get("createDockAllocation")?.retryRequirement.value === "reconcile-before-retry",
    operations.get("createDockAllocation")?.requestedByWorkflow.value === true,
    operations.get("createDockAllocation")?.writeAuthorized.value === false,
    operations.get("createDockAllocation")?.executable.value === false,
    proposal.scopeWorkflow.authorityState.value === "unconfigured" && proposal.scopeWorkflow.verifierState.value === "unconfigured",
  ];
  const invented = proposal.operations.filter((operation) => !expectedOperations.includes(operation.operationId.value as typeof expectedOperations[number])).length;
  return { required: checks.length, correct: checks.filter(Boolean).length, invented };
}

/**
 * Precommitted, offline development benchmark. It deliberately tests selected
 * proposal assertions and blocker quality, not independent held-out behavior,
 * execution, acceptance, reliability, or onboarding time.
 */
export function runZeroSpendOnboardingBenchmark(fixtures: ZeroSpendOnboardingBenchmarkFixtures): ZeroSpendOnboardingBenchmarkReport {
  const proposal = discoverAdapterProposal(adapterInput(fixtures.unfamiliarOpenApi));
  const adapterScore = scoreAdapter(proposal);
  const cases: ZeroSpendBenchmarkCaseResult[] = [];

  cases.push({
    caseId: "fresh-openapi-development-fixture",
    passed: adapterScore.correct === adapterScore.required && adapterScore.invented === 0,
    expected: "Extract the exact bounded system, target, credential alias, three operations, safety classifications, and proposal-only boundary.",
    observed: `${adapterScore.correct}/${adapterScore.required} selected precommitted adapter assertions correct; ${adapterScore.invented} unsupported operations invented.`,
    blockers: proposal.engineeringBlockers.map((item) => item.blockerId),
  });

  const ambiguous = discoverAdapterProposal(adapterInput(fixtures.unfamiliarOpenApi, ["allocateDockAutomatically"]));
  const ambiguousBlocked = ambiguous.engineeringBlockers.some((item) => item.blockerId === "operation-selection")
    && ambiguous.scopeWorkflow.operationIds.status === "unknown";
  cases.push({
    caseId: "ambiguous-workflow",
    passed: ambiguousBlocked,
    expected: "Do not guess an operation when the confirmed workflow name has no exact approved-material match.",
    observed: ambiguousBlocked ? "Exact operation selection remained unknown and blocked." : "The ambiguous workflow did not fail closed.",
    blockers: ambiguous.engineeringBlockers.map((item) => item.blockerId),
  });

  const verifier = proposeExternalOutcomeVerifier(verifierInput());
  const verifierBlocked = verifier.contract.status === "blocked" && verifier.contract.independentObserver === undefined;
  cases.push({
    caseId: "missing-verifier",
    passed: verifierBlocked,
    expected: "Reject the acting response as independent proof and require a separate observation surface through the trusted freshness wrapper.",
    observed: verifierBlocked ? "No independent observer selected; verifier activation remained blocked." : "An invalid verifier path was accepted.",
    blockers: [...verifier.contract.blockers],
  });

  const authority = compileAuthorityWizard(conflictingAuthority());
  const authorityBlocked = authority.status === "blocked"
    && authority.authority.writeAuthority === "denied"
    && authority.authority.allowedMethods.length === 0
    && authority.candidateAuthority === undefined;
  cases.push({
    caseId: "authority-conflict",
    passed: authorityBlocked,
    expected: "Reject a read that is simultaneously allowed and forbidden, returning zero usable or candidate authority.",
    observed: authorityBlocked ? "Conflict rejected with an empty write-denied authority envelope." : "Conflicting authority escaped the wizard.",
    blockers: [...authority.blockers],
  });

  const unsupported = DEFAULT_RUNTIME_FAMILY_REGISTRY.find((family) => family.family === "native-ui");
  const unsupportedBlocked = unsupported?.enabled === false && unsupported.maturity === "planned";
  cases.push({
    caseId: "unsupported-mode",
    passed: unsupportedBlocked,
    expected: "Keep native UI outside the enabled acquisition surface instead of disguising it as HTTP.",
    observed: unsupported ? `native-ui enabled=${unsupported.enabled}; maturity=${unsupported.maturity}.` : "native-ui family missing from registry.",
    blockers: unsupportedBlocked ? ["unsupported-capability-mode-native-ui"] : [],
  });

  let adversarialRejected = false;
  let adversarialReason = "";
  try {
    discoverAdapterProposal(adapterInput(fixtures.adversarialOpenApi, ["createRecord"]));
  } catch (error) {
    adversarialRejected = true;
    adversarialReason = error instanceof Error ? error.message : String(error);
  }
  cases.push({
    caseId: "credential-injection-artifact",
    passed: adversarialRejected && /credential-shaped/.test(adversarialReason),
    expected: "Reject material containing a credential-shaped value before proposal generation.",
    observed: adversarialRejected ? `Artifact rejected: ${adversarialReason}` : "Adversarial material was accepted.",
    blockers: adversarialRejected ? ["adversarial-material-rejected"] : [],
  });

  const authorityInjection = discoverAdapterProposal(adapterInput(fixtures.adversarialAuthorityEvidenceOpenApi, ["createRecord"]));
  const authorityEvidenceRejected = authorityInjection.executable === false
    && authorityInjection.writesAuthorized === false
    && authorityInjection.operations.every((operation) => operation.executable.value === false && operation.writeAuthorized.value === false)
    && authorityInjection.scopeWorkflow.authorityState.value === "unconfigured"
    && authorityInjection.engineeringBlockers.some((item) => item.blockerId === "authority-unconfigured")
    && authorityInjection.engineeringBlockers.some((item) => item.blockerId === "acceptance-not-run");
  cases.push({
    caseId: "authority-evidence-injection-artifact",
    passed: authorityEvidenceRejected,
    expected: "Treat documentation claims of approval and passing tests as untrusted prose, preserving non-authorizing and not-run boundaries.",
    observed: authorityEvidenceRejected ? "Proposal remained non-executable, non-authorizing, authority-unconfigured, and acceptance-not-run." : "Documentation prose altered authority or evidence state.",
    blockers: authorityInjection.engineeringBlockers.map((item) => item.blockerId),
  });

  const acceptance = generateOnboardingAcceptancePlan({
    adapterId: "yardpass_sandbox",
    adapterVersion: "1.0.0",
    workflowKey: "allocate_approved_shipment",
    readOperationKeys: ["getShipment", "listDockAllocations"],
    writeOperationKeys: ["createDockAllocation"],
    credentialAliases: ["sandboxBearer"],
    permissionKeys: ["dockWrite"],
    outcomeVerifierKeys: ["dockAllocationState"],
    resetStrategy: { kind: "fixture-reset", reference: "fixture://yardpass/reset", independentlyChecked: true },
    retry: { duplicatePrevention: "both", reconcileBeforeRetry: true, blindRetryAllowed: false },
    persistence: { durableJobStore: true, durableCapabilityRegistry: true },
    confirmations: { operationsReviewed: false, authorityReviewed: false, verifierReviewed: false, disposableEnvironmentConfirmed: true },
  });
  const engineerTasksRemaining = [...new Set([
    ...proposal.engineeringBlockers.map((item) => item.blockerId),
    ...acceptance.blockers,
    "implement-independent-observation-adapter",
    "bind-approved-observer-through-freshness-wrapper",
    "execute-ten-case-acceptance",
  ])].sort();
  const clarificationOrConfirmationItems = proposal.unknowns.length
    + acceptance.blockers.length
    + verifier.contract.unknowns.length;
  const credentialValues = JSON.stringify(proposal).match(/Bearer\s+|sk-[a-z0-9_-]{12,}/gi) ?? [];
  const unauthorizedAuthorityInferred = proposal.writesAuthorized || proposal.operations.some((operation) => operation.writeAuthorized.value)
    ? 1
    : 0;

  return {
    schemaVersion: ZERO_SPEND_ONBOARDING_BENCHMARK_VERSION,
    precommittedInCode: true,
    benchmarkManifestDigest: sha256(BENCHMARK_MANIFEST),
    fixtureDigest: sha256(fixtures),
    provider: "deterministic-offline",
    modelCalls: 0,
    paidSpendUsd: 0,
    passed: cases.every((item) => item.passed)
      && unauthorizedAuthorityInferred === 0
      && credentialValues.length === 0,
    cases,
    metrics: {
      selectedAdapterAssertionsRequired: adapterScore.required,
      selectedAdapterAssertionsCorrect: adapterScore.correct,
      selectedAdapterAssertionPassPercent: Number(((adapterScore.correct / adapterScore.required) * 100).toFixed(1)),
      unsupportedOperationsInvented: adapterScore.invented,
      unauthorizedAuthorityInferred,
      credentialValuesLeakedOrInvented: credentialValues.length,
      clarificationOrConfirmationItems,
      verifierCompleteness: "blocked-missing-observer-and-freshness-binding",
      engineerTasksRemaining,
      estimatedOnboardingTimeSaved: "not-estimated-without-human-baseline",
    },
    claimBoundary: "This deterministic development fixture checks selected extraction assertions and fail-closed blocker behavior only. The manifest digest identifies the exact in-code oracle; it is not independent held-out evidence. The run does not show a generated executable adapter, a passing verifier, acceptance evidence, customer use, or under-one-day onboarding.",
  };
}
