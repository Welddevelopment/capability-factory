import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  sdkSemanticDigest,
  type ConfirmedFact,
  type SdkSemanticContract,
  type ValueExpression,
} from "../../src/product/customer-local-sdk-semantic-compiler.js";
import {
  sdkSemanticDraftDigest,
  type SdkSemanticDraftSnapshot,
} from "../../src/product/customer-local-sdk-semantic-drafting.js";
import {
  sdkWorkPackDigest,
  type ApprovedSdkMethod,
  type SdkImplementationWorkPack,
  type SdkRoleReview,
} from "../../src/product/customer-local-sdk-work-pack.js";
import {
  ONBOARDING_JOURNEY_STAGES,
  onboardingJourneyDigest,
  onboardingJourneySourceDigest,
  type JourneyArtifact,
  type JourneyEvent,
  type JourneyLineage,
  type JourneySnapshot,
} from "../../src/product/customer-local-onboarding-journey.js";
import {
  closeProviderWorkEvidenceCoordinator,
  createCoordinatedProviderWorkBoard,
  createProviderWorkEvidenceCoordinator,
  providerWorkBoardDigest,
  type DurableCustomerLocalProviderWorkBoard,
  type ProviderWorkBoardInput,
  type ProviderWorkEvidenceCoordinator,
  type ProviderWorkJourneyReader,
} from "../../src/product/customer-local-provider-work-board.js";
import {
  applyProviderEvidenceReuse,
  prepareProviderEvidenceReuse,
} from "../../src/product/customer-local-provider-evidence-reuse.js";
import {
  assertHttpBindingFactoryResultIntegrity,
  type HttpBindingFactoryResult,
} from "../../src/product/http-binding-factory.js";
import {
  CF058_COLD_CHAIN_ACTION_CREDENTIAL_ALIAS,
  CF058_COLD_CHAIN_ACTION_OPERATION,
  CF058_COLD_CHAIN_ACTION_PATH,
  CF058_COLD_CHAIN_OBSERVER_CREDENTIAL_ALIAS,
  CF058_COLD_CHAIN_OBSERVER_OPERATION,
  CF058_COLD_CHAIN_OBSERVER_PATH,
  CF058_COLD_CHAIN_OBSERVER_SOURCE,
  CF058_COLD_CHAIN_PROBE_OPERATION,
  CF058_COLD_CHAIN_RECONCILIATION_OPERATION,
  CF058_COLD_CHAIN_REVIEWED_AT,
  cf058ColdChainReviewedSource,
  type Cf058ColdChainReviewedSource,
} from "./cf058-cold-chain-reviewed-source.js";

export const CF058_COLD_CHAIN_PROVIDER_ID = "cf058_cold_chain_provider";
export const CF058_COLD_CHAIN_PLUGIN_ID = "cf058_cold_chain_plugin";
export const CF058_COLD_CHAIN_TENANT_ID = "cf058ColdChainTenant";
export const CF058_COLD_CHAIN_JOURNEY_ID = "cf058ColdChainJourney";
export const CF058_COLD_CHAIN_BOARD_ID = "cf058ColdChainBoard";

const CONTRACT_EXPIRES_AT = "2030-01-01T00:00:00.000Z";
const reviewer = "cf058FixtureEngineer";
const localReference = "fixture://cf058-cold-chain-reviewed-sdk";

function fact(sourcePointer: string): ConfirmedFact {
  return {
    provenance: "engineer-confirmed",
    confirmedBy: reviewer,
    confirmedAt: CF058_COLD_CHAIN_REVIEWED_AT,
    sourcePointer,
  };
}

function method(input: {
  module: string;
  className: string;
  methodName: string;
  parameters: Array<{ name: string; type: "string" | "number" | "boolean" }>;
  authAlias: string;
  retryCandidate: ApprovedSdkMethod["retryCandidate"];
  idempotencyCandidate: string | null;
  sourcePointer: string;
}): ApprovedSdkMethod {
  return {
    module: input.module,
    className: input.className,
    methodName: input.methodName,
    overloadId: "v1",
    parameters: input.parameters.map((parameter) => ({
      ...parameter,
      required: true,
      sourcePointer: `${input.sourcePointer}/parameters/${parameter.name}`,
    })),
    returnType: "Promise<Record<string, unknown>>",
    errorTypes: ["ColdChainApiError", "TimeoutBeforeCommit"],
    authAliasRequirements: [input.authAlias],
    pagination: "none",
    retryCandidate: input.retryCandidate,
    idempotencyCandidate: input.idempotencyCandidate,
    sourcePointer: input.sourcePointer,
  };
}

function reviewedRole(
  role: SdkRoleReview["role"],
  approvedMethod: ApprovedSdkMethod,
  sdkSourceDigest: string,
): SdkImplementationWorkPack["roles"][number] {
  const review: SdkRoleReview = {
    role,
    module: approvedMethod.module,
    className: approvedMethod.className!,
    methodName: approvedMethod.methodName,
    overloadId: approvedMethod.overloadId,
    expectedSourcePointer: approvedMethod.sourcePointer,
    reviewerAlias: reviewer,
    reviewedAt: CF058_COLD_CHAIN_REVIEWED_AT,
    exactOneToOne: true,
  };
  return {
    review,
    method: approvedMethod,
    methodDigest: sdkWorkPackDigest(approvedMethod),
    provenance: {
      sourceKind: "reference-json",
      localReference,
      sourcePointer: approvedMethod.sourcePointer,
      sdkSourceDigest,
    },
  };
}

export interface Cf058ColdChainUpstream {
  reviewed: Cf058ColdChainReviewedSource;
  workPack: SdkImplementationWorkPack;
  contract: SdkSemanticContract;
}

/**
 * Constructs the exact reviewed CF-036 work pack and CF-041 semantic contract
 * from the same HTTP factory result. This is source preparation only; neither
 * artifact grants execution or activation authority.
 */
export function cf058ColdChainUpstream(
  reviewed: Cf058ColdChainReviewedSource = cf058ColdChainReviewedSource(),
): Cf058ColdChainUpstream {
  const factoryResult: HttpBindingFactoryResult = reviewed.factoryResult;
  assertHttpBindingFactoryResultIntegrity(factoryResult);
  if (!factoryResult.actionBinding || !factoryResult.observerBinding || factoryResult.status !== "review-required") {
    throw new Error("CF-058 upstream requires the exact clean reviewed HTTP factory result.");
  }
  const sdkSourceDigest = sdkSemanticDigest({
    providerId: CF058_COLD_CHAIN_PROVIDER_ID,
    localReference,
    operations: [
      CF058_COLD_CHAIN_ACTION_OPERATION,
      CF058_COLD_CHAIN_PROBE_OPERATION,
      CF058_COLD_CHAIN_RECONCILIATION_OPERATION,
      CF058_COLD_CHAIN_OBSERVER_OPERATION,
    ],
  });
  const action = method({
    module: "cf058_cold_chain_action_sdk",
    className: "QuarantineDirectiveWriter",
    methodName: CF058_COLD_CHAIN_ACTION_OPERATION,
    parameters: [
      { name: "directive_ref", type: "string" },
      { name: "lot_code", type: "string" },
      { name: "hold_quantity", type: "number" },
      { name: "reason_confirmed", type: "boolean" },
    ],
    authAlias: CF058_COLD_CHAIN_ACTION_CREDENTIAL_ALIAS,
    retryCandidate: "idempotency-key",
    idempotencyCandidate: "directive_ref",
    sourcePointer: `openapi://${CF058_COLD_CHAIN_ACTION_OPERATION}`,
  });
  const probe = method({
    module: "cf058_cold_chain_action_read_sdk",
    className: "QuarantineDirectiveReader",
    methodName: CF058_COLD_CHAIN_PROBE_OPERATION,
    parameters: [
      { name: "directive_ref", type: "string" },
      { name: "lot_code", type: "string" },
      { name: "hold_quantity", type: "number" },
      { name: "reason_confirmed", type: "boolean" },
    ],
    authAlias: CF058_COLD_CHAIN_ACTION_CREDENTIAL_ALIAS,
    retryCandidate: "read-only",
    idempotencyCandidate: null,
    sourcePointer: `openapi://${CF058_COLD_CHAIN_PROBE_OPERATION}`,
  });
  const reconciliation = method({
    module: "cf058_cold_chain_reconciliation_sdk",
    className: "QuarantineDirectiveReconciler",
    methodName: CF058_COLD_CHAIN_RECONCILIATION_OPERATION,
    parameters: [
      { name: "directive_ref", type: "string" },
      { name: "lot_code", type: "string" },
      { name: "hold_quantity", type: "number" },
      { name: "reason_confirmed", type: "boolean" },
    ],
    authAlias: CF058_COLD_CHAIN_OBSERVER_CREDENTIAL_ALIAS,
    retryCandidate: "read-only",
    idempotencyCandidate: null,
    sourcePointer: `openapi://${CF058_COLD_CHAIN_RECONCILIATION_OPERATION}`,
  });
  const observer = method({
    module: "cf058_compliance_audit_sdk",
    className: "QuarantineDirectiveAuditReader",
    methodName: CF058_COLD_CHAIN_OBSERVER_OPERATION,
    parameters: [
      { name: "directive_ref", type: "string" },
      { name: "lot_code", type: "string" },
      { name: "hold_quantity", type: "number" },
      { name: "reason_confirmed", type: "boolean" },
    ],
    authAlias: CF058_COLD_CHAIN_OBSERVER_CREDENTIAL_ALIAS,
    retryCandidate: "read-only",
    idempotencyCandidate: null,
    sourcePointer: `openapi://${CF058_COLD_CHAIN_OBSERVER_OPERATION}`,
  });
  const roles = [
    reviewedRole("action", action, sdkSourceDigest),
    reviewedRole("no-write-probe", probe, sdkSourceDigest),
    reviewedRole("reconciliation-readback", reconciliation, sdkSourceDigest),
    reviewedRole("independent-observer", observer, sdkSourceDigest),
  ];
  const allMethods = roles.map((item) => item.method);
  const packBody: Omit<SdkImplementationWorkPack, "workPackDigest"> = {
    schemaVersion: "1.0",
    state: "engineer-implementation-required",
    providerId: CF058_COLD_CHAIN_PROVIDER_ID,
    pluginId: CF058_COLD_CHAIN_PLUGIN_ID,
    sdkSourceDigest,
    factoryResultDigest: factoryResult.resultDigest,
    roles,
    normalized: {
      modules: [...new Set(allMethods.map((item) => item.module))].sort(),
      classes: [...new Set(allMethods.map((item) => item.className).filter(Boolean) as string[])].sort(),
      methodCount: allMethods.length,
      parameterCount: allMethods.reduce((sum, item) => sum + item.parameters.length, 0),
      returnShapeCount: new Set(allMethods.map((item) => item.returnType)).size,
      errorShapeCount: new Set(allMethods.flatMap((item) => item.errorTypes)).size,
      authAliasRequirements: [...new Set(allMethods.flatMap((item) => item.authAliasRequirements))].sort(),
      paginationCandidates: [...new Set(allMethods.map((item) => item.pagination))].sort(),
      retryCandidates: [...new Set(allMethods.map((item) => item.retryCandidate))].sort(),
      idempotencyCandidates: [...new Set(allMethods.map((item) => item.idempotencyCandidate).filter(Boolean) as string[])].sort(),
    },
    blockedUnknowns: [],
    conformanceControls: [{ controlId: "cf058-reviewed-source", state: "not-run" }],
    generatedFiles: [],
    generatedLines: 0,
    mappedMethods: roles.length,
    mappedFields: roles.reduce((sum, item) => sum + item.method.parameters.length + 1, 0),
    explicitReviews: roles.length,
    executionAuthorityEffect: "none",
    activationEffect: "none",
  };
  const workPack: SdkImplementationWorkPack = {
    ...packBody,
    workPackDigest: sdkWorkPackDigest(packBody),
  };

  const expression = (key: string, convert: ValueExpression["convert"]): ValueExpression => ({
    source: "workflow-input",
    key,
    convert,
    fact: fact(`workflow://cf058-cold-chain/inputs/${key}`),
  });
  const inputExpressions = {
    directive_ref: expression("directive_ref", "string"),
    lot_code: expression("lot_code", "string"),
    hold_quantity: expression("hold_quantity", "number"),
    reason_confirmed: expression("reason_confirmed", "boolean"),
  };
  const parameterMappings: SdkSemanticContract["parameterMappings"] = roles.flatMap((role) => role.method.parameters.map((parameter) => ({
    role: role.review.role,
    parameter: parameter.name,
    expression: inputExpressions[parameter.name as keyof typeof inputExpressions],
    fact: fact(`${role.method.sourcePointer}/parameters/${parameter.name}/mapping`),
  })));
  const contractBody: Omit<SdkSemanticContract, "contractDigest"> = {
    schemaVersion: "1.0",
    contractId: "cf058_cold_chain_semantic_v1",
    providerId: CF058_COLD_CHAIN_PROVIDER_ID,
    sdkSourceDigest: workPack.sdkSourceDigest,
    workPackDigest: workPack.workPackDigest,
    roles: roles.map((role) => ({
      role: role.review.role,
      methodDigest: role.methodDigest,
      fact: fact(role.method.sourcePointer),
    })),
    parameterMappings,
    credentials: {
      action: {
        alias: CF058_COLD_CHAIN_ACTION_CREDENTIAL_ALIAS,
        exactScope: `PUT ${CF058_COLD_CHAIN_ACTION_PATH}`,
        fact: fact("openapi://security/cf058ActionBearer"),
      },
      observer: {
        alias: CF058_COLD_CHAIN_OBSERVER_CREDENTIAL_ALIAS,
        exactScope: `GET ${CF058_COLD_CHAIN_OBSERVER_PATH}`,
        fact: fact("openapi://security/cf058ObserverBearer"),
      },
    },
    stableIdentity: {
      expression: inputExpressions.directive_ref,
      collisionPolicy: "reject-conflict",
      fact: fact("workflow://cf058-cold-chain/stable-identity"),
    },
    idempotency: {
      expression: inputExpressions.directive_ref,
      conflictIdentity: [
        inputExpressions.directive_ref,
        inputExpressions.lot_code,
        inputExpressions.hold_quantity,
        inputExpressions.reason_confirmed,
      ],
      reconcileBeforeRetry: true,
      blindRetryAllowed: false,
      fact: fact("workflow://cf058-cold-chain/idempotency"),
    },
    reconciliation: {
      role: "reconciliation-readback",
      notFoundClassification: "not-started",
      multipleClassification: "duplicate",
      fact: fact(`openapi://${CF058_COLD_CHAIN_RECONCILIATION_OPERATION}`),
    },
    observer: {
      role: "independent-observer",
      sourceId: CF058_COLD_CHAIN_OBSERVER_SOURCE,
      authIndependent: true,
      differentMethodFromAction: true,
      fact: fact(`openapi://${CF058_COLD_CHAIN_OBSERVER_OPERATION}`),
    },
    outcome: {
      predicates: [
        { key: "directive-reference", path: ["directive_ref"], operator: "equals-input", inputKey: "directive_ref", fact: fact("workflow://cf058-cold-chain/outcome/directive-ref") },
        { key: "lot-code", path: ["lot_code"], operator: "equals-input", inputKey: "lot_code", fact: fact("workflow://cf058-cold-chain/outcome/lot-code") },
        { key: "hold-quantity", path: ["hold_quantity"], operator: "equals-input", inputKey: "hold_quantity", fact: fact("workflow://cf058-cold-chain/outcome/hold-quantity") },
        { key: "reason-confirmed", path: ["reason_confirmed"], operator: "equals-input", inputKey: "reason_confirmed", fact: fact("workflow://cf058-cold-chain/outcome/reason-confirmed") },
      ],
      duplicate: {
        collectionPath: ["matches"],
        expectedCount: 1,
        fact: fact("workflow://cf058-cold-chain/outcome/duplicate"),
      },
      collateral: [{
        key: "collateral-clean",
        path: ["collateralClean"],
        operator: "equals-confirmed",
        expected: true,
        fact: fact("workflow://cf058-cold-chain/outcome/collateral"),
      }],
      freshness: {
        path: ["observedAt"],
        maximumAgeSeconds: 30,
        notBefore: "operation-start",
        fact: fact("workflow://cf058-cold-chain/outcome/freshness"),
      },
      fact: fact("workflow://cf058-cold-chain/outcome"),
    },
    pagination: {
      roles: [
        { role: "reconciliation-readback", mode: "not-paginated", maximumPages: 1, fact: fact(`openapi://${CF058_COLD_CHAIN_RECONCILIATION_OPERATION}/pagination`) },
        { role: "independent-observer", mode: "not-paginated", maximumPages: 1, fact: fact(`openapi://${CF058_COLD_CHAIN_OBSERVER_OPERATION}/pagination`) },
      ],
      complete: true,
      fact: fact("workflow://cf058-cold-chain/pagination"),
    },
    policy: {
      timeoutMilliseconds: 5_000,
      maximumRequestsPerMinute: 60,
      maximumAttempts: 2,
      retryableErrors: ["TimeoutBeforeCommit"],
      terminalErrors: ["Unauthorized", "Conflict"],
      fact: fact("workflow://cf058-cold-chain/policy"),
    },
    sourceDigest: sdkSemanticDigest({
      providerId: CF058_COLD_CHAIN_PROVIDER_ID,
      factoryResultDigest: factoryResult.resultDigest,
      workflow: "cold-chain-quarantine-directive-v1",
    }),
    expiresAt: CONTRACT_EXPIRES_AT,
    executionAuthorityEffect: "none",
    activationEffect: "none",
  };
  const contract: SdkSemanticContract = {
    ...contractBody,
    contractDigest: sdkSemanticDigest(contractBody),
  };
  return { reviewed, workPack, contract };
}

export function cf058ColdChainProgressiveSource(
  workPack: SdkImplementationWorkPack,
  contract: SdkSemanticContract,
  tenantId = CF058_COLD_CHAIN_TENANT_ID,
  journeyId = CF058_COLD_CHAIN_JOURNEY_ID,
): { snapshot: JourneySnapshot; events: JourneyEvent[] } {
  const sourceIdentity = "cf058ColdChainSource";
  const sourceIdentityDigest = onboardingJourneySourceDigest({ journeyId, tenantId, sourceIdentity });
  const artifacts = {} as JourneySnapshot["artifacts"];
  const semanticBody: Omit<SdkSemanticDraftSnapshot, "snapshotDigest"> = {
    schemaVersion: "1.0",
    sessionId: "cf058ColdChainSemantic",
    providerId: workPack.providerId,
    inputDigest: sdkSemanticDraftDigest({ providerId: workPack.providerId, input: "cold-chain" }),
    workPackDigest: workPack.workPackDigest,
    factoryResultDigest: workPack.factoryResultDigest,
    workflowSourceDigest: sdkSemanticDraftDigest({ providerId: workPack.providerId, workflow: "cold-chain-quarantine" }),
    state: "reviewed-contract-ready",
    revision: 11,
    extractedFacts: [],
    questions: [],
    answers: [],
    partialContract: contract,
    blockers: [],
    dependencyDepth: 5,
    metrics: {
      extractedFacts: 0,
      questions: 0,
      explicitDecisions: 9,
      blockers: 0,
      generatedConfigObjects: 1,
      generatedExecutableCodeLines: 0,
      manualExecutableCodeFiles: 0,
      interventionPoints: 0,
    },
    reviewedContract: contract,
    executionAuthorityEffect: "none",
    activationEffect: "none",
    createdAt: CF058_COLD_CHAIN_REVIEWED_AT,
    updatedAt: CF058_COLD_CHAIN_REVIEWED_AT,
  };
  const semanticSnapshot: SdkSemanticDraftSnapshot = {
    ...semanticBody,
    snapshotDigest: sdkSemanticDraftDigest(semanticBody),
  };
  let previous: string | null = null;
  for (const stage of ONBOARDING_JOURNEY_STAGES.slice(0, 4)) {
    const lineageBody: Omit<JourneyLineage, "lineageDigest"> = {
      schemaVersion: "1.0",
      tenantId,
      journeyId,
      sourceIdentityDigest,
      previousLineageDigest: previous,
      ...(stage === "cf036-sdk-work-pack" ? {
        providerId: workPack.providerId,
        pluginId: workPack.pluginId,
        workPackDigest: workPack.workPackDigest,
        factoryResultDigest: workPack.factoryResultDigest,
      } : {}),
      ...(stage === "cf041-semantic-review" ? { contractDigest: contract.contractDigest } : {}),
    };
    const lineage: JourneyLineage = {
      ...lineageBody,
      lineageDigest: onboardingJourneyDigest(lineageBody),
    };
    previous = lineage.lineageDigest;
    const payload = stage === "cf036-sdk-work-pack"
      ? workPack
      : stage === "cf041-semantic-review"
        ? semanticSnapshot
        : { schemaVersion: "1.0", fixture: `cf058-${stage}` };
    const index = ONBOARDING_JOURNEY_STAGES.indexOf(stage);
    const artifactBody = {
      schemaVersion: "1.1" as const,
      journeyId,
      tenantId,
      stage,
      owner: "engineer" as const,
      payload: payload as never,
      payloadDigest: onboardingJourneyDigest(payload),
      upstreamArtifactDigest: index === 0 ? null : artifacts[ONBOARDING_JOURNEY_STAGES[index - 1]!]!.artifactDigest,
      sourceDigest: sourceIdentityDigest,
      lineage,
      evidenceLinks: [`artifact://${journeyId}/${stage}`],
      failures: [],
      recordedBy: reviewer,
      recordedAt: CF058_COLD_CHAIN_REVIEWED_AT,
      executionAuthorityEffect: "none" as const,
      activationEffect: "none" as const,
    };
    artifacts[stage] = {
      ...artifactBody,
      artifactDigest: onboardingJourneyDigest(artifactBody),
    } as JourneyArtifact;
  }
  const state = {
    schemaVersion: "1.2" as const,
    journeyId,
    tenantId,
    sourceIdentity,
    sourceIdentityDigest,
    trustedReleaseSigner: null,
    revision: 5,
    state: "preparing" as const,
    currentStage: "cf041-semantic-review" as const,
    artifacts,
    failureLedger: [],
    failureResolutions: [],
    invalidatedArtifacts: [],
    dependencyGraph: ONBOARDING_JOURNEY_STAGES.map((stage, index) => ({
      stage,
      dependsOn: index ? ONBOARDING_JOURNEY_STAGES[index - 1]! : null,
      owner: "engineer" as const,
    })),
    availableNextActions: ["attach:cf037-acceptance-only-compile"],
    blockers: [],
    metrics: {
      commands: 5,
      uniqueConfirmations: 1,
      reusedConfirmations: 0,
      explicitDecisions: 1,
      manualCodeFiles: 0,
      manualConfigObjects: 1,
      restarts: 0,
      stageTransitions: 4,
      duplicateReviews: 0 as const,
    },
    executionAuthorityEffect: "none" as const,
    activationEffect: "none" as const,
    createdAt: CF058_COLD_CHAIN_REVIEWED_AT,
    updatedAt: CF058_COLD_CHAIN_REVIEWED_AT,
  };
  const eventBody = {
    sequence: 1,
    journeyId,
    eventType: "artifact-attached" as const,
    revision: state.revision,
    statePayloadDigest: onboardingJourneyDigest(state),
    previousEventDigest: null,
    detail: "cf041-semantic-review attached from the exact reviewed CF-058 cold-chain source.",
    occurredAt: CF058_COLD_CHAIN_REVIEWED_AT,
  };
  const event: JourneyEvent = {
    ...eventBody,
    eventDigest: onboardingJourneyDigest(eventBody),
  };
  const body = { ...state, eventCount: 1, eventHeadDigest: event.eventDigest };
  const snapshot: JourneySnapshot = { ...body, journeyDigest: onboardingJourneyDigest(body) };
  return { snapshot, events: [event] };
}

export interface Cf058ColdChainProductionDerivationFixture {
  upstream: Cf058ColdChainUpstream;
  source: ReturnType<typeof cf058ColdChainProgressiveSource>;
  reader: ProviderWorkJourneyReader;
  coordinator: ProviderWorkEvidenceCoordinator;
  board: DurableCustomerLocalProviderWorkBoard;
  boardId: string;
  tenantId: string;
  journeyId: string;
  close(): void;
}

/**
 * Materializes the exact CF-051 coordinated work-board state that the
 * production CF-053 derivation entrypoint requires. It does not launch or
 * execute a candidate runtime.
 */
export function createCf058ColdChainProductionDerivationFixture(
  rootDirectory: string,
  reviewed: Cf058ColdChainReviewedSource = cf058ColdChainReviewedSource(),
): Cf058ColdChainProductionDerivationFixture {
  mkdirSync(rootDirectory, { recursive: true, mode: 0o700 });
  const upstream = cf058ColdChainUpstream(reviewed);
  const source = cf058ColdChainProgressiveSource(upstream.workPack, upstream.contract);
  const reader: ProviderWorkJourneyReader = {
    read: () => structuredClone(source.snapshot),
    events: () => structuredClone(source.events),
  };
  const statePath = join(rootDirectory, "cf058-provider-work.sqlite");
  const coordinator = createProviderWorkEvidenceCoordinator(statePath);
  const board = createCoordinatedProviderWorkBoard({
    statePath,
    sources: reader,
    coordinator,
    now: () => CF058_COLD_CHAIN_REVIEWED_AT,
  });
  const startInput: ProviderWorkBoardInput = {
    schemaVersion: "1.2",
    boardId: CF058_COLD_CHAIN_BOARD_ID,
    tenantId: CF058_COLD_CHAIN_TENANT_ID,
    providerId: upstream.workPack.providerId,
    journeyId: CF058_COLD_CHAIN_JOURNEY_ID,
    originMode: "cf041-progressive",
    importedStage: "cf041-semantic-review",
    importedSourceEventHeadDigest: source.snapshot.eventHeadDigest!,
    expectedJourneyDigest: source.snapshot.journeyDigest,
    expectedSourceIdentityDigest: source.snapshot.sourceIdentityDigest,
    expectedSourceEventStateDigest: providerWorkBoardDigest({
      eventCount: source.snapshot.eventCount,
      eventHeadDigest: source.snapshot.eventHeadDigest,
    }),
    createdAt: CF058_COLD_CHAIN_REVIEWED_AT,
  };
  const started = board.start(startInput);
  const reuse = prepareProviderEvidenceReuse({
    reader,
    board: started,
    now: CF058_COLD_CHAIN_REVIEWED_AT,
  });
  applyProviderEvidenceReuse({
    board,
    reader,
    coordinator,
    plan: reuse,
    now: CF058_COLD_CHAIN_REVIEWED_AT,
  });
  let closed = false;
  return {
    upstream,
    source,
    reader,
    coordinator,
    board,
    boardId: CF058_COLD_CHAIN_BOARD_ID,
    tenantId: CF058_COLD_CHAIN_TENANT_ID,
    journeyId: CF058_COLD_CHAIN_JOURNEY_ID,
    close: () => {
      if (closed) return;
      closed = true;
      board.close();
      closeProviderWorkEvidenceCoordinator(coordinator);
    },
  };
}
