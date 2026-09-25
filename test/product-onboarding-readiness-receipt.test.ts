import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeApprovedOpenApiMaterial } from "../src/product/approved-openapi-normalizer.js";
import { compileReviewedHttpBindings, type CustomerLocalCredentialResolver, type CustomerLocalHttpTransport } from "../src/product/http-binding-compiler.js";
import { createLocalFixtureBindingQualification } from "../src/product/customer-local-binding-qualification.js";
import { proposeHttpBindings, type HttpBindingFactoryFacts } from "../src/product/http-binding-factory.js";
import type { GenericAcceptanceCampaignState, GenericAcceptanceEvidenceReceipt } from "../src/product/generic-acceptance-executor.js";
import type { ApprovedOpenApiMaterial } from "../src/product/onboarding-adapter-factory.js";
import { onboardingAcceptanceSourceDigest } from "../src/product/onboarding-acceptance-factory.js";
import { DurableOnboardingPreparationWorkflow, type StartOnboardingPreparationInput } from "../src/product/onboarding-preparation-workflow.js";
import {
  assertOnboardingReadinessReceiptIntegrity,
  buildOnboardingReadinessReceipt,
  onboardingReadinessDigest,
  type BuildOnboardingReadinessReceiptInput,
} from "../src/product/onboarding-readiness-receipt.js";
import { compileAuthorityWizard, type AuthorityWizardAnswers } from "../src/product/onboarding-verifier-authority.js";
import { REQUIRED_PILOT_ADAPTER_CASES, type PilotAdapterAcceptanceCase, type PilotAdapterAcceptanceResult } from "../src/product/pilot-adapter.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const evaluatedAt = "2026-08-14T12:00:00.000Z";

export function readinessTestMaterial(): ApprovedOpenApiMaterial {
  return {
    kind: "openapi", materialId: "northstar-orders-v1", localReference: "fixture://northstar/openapi", approved: true, targetAlias: "northstar_sandbox",
    document: {
      openapi: "3.1.0", info: { title: "Northstar Orders", version: "1.0.0" }, servers: [{ url: "https://northstar.local.invalid/v1" }],
      paths: {
        "/orders": {
          post: {
            operationId: "createOrder", security: [{ northstarWriter: [] }],
            requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["order_ref", "sku", "quantity"], properties: { order_ref: { type: "string" }, sku: { type: "string" }, quantity: { type: "integer" } } } } } },
            responses: { "201": { description: "Created" } },
          },
          get: {
            operationId: "listOrders", security: [{ northstarObserver: [] }], parameters: [{ name: "order_ref", in: "query", required: true, schema: { type: "string" } }],
            responses: { "200": { description: "Matches", content: { "application/json": { schema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { order_ref: { type: "string" }, sku: { type: "string" }, quantity: { type: "integer" } } } }, server_time: { type: "string", format: "date-time" }, collateral_clean: { type: "boolean" } } } } } } },
          },
        },
      },
      components: { securitySchemes: { northstarWriter: { type: "http", scheme: "bearer" }, northstarObserver: { type: "http", scheme: "bearer" } } },
    },
  };
}

export function readinessTestAuthority(): AuthorityWizardAnswers {
  return {
    schemaVersion: "1.0",
    systemsAndTargets: { aliases: ["northstar_sandbox"], confirmed: true },
    credentialAliases: { aliases: ["northstarWriter", "northstarObserver"], confirmed: true },
    readsAllowed: { actions: [{ actionName: "listOrders", targetAlias: "northstar_sandbox" }], confirmed: true },
    writes: [{ actionName: "createOrder", targetAlias: "northstar_sandbox", method: "POST", policy: "preauthorized", confirmed: true }],
    limits: { monetary: { kind: "none", confirmed: true }, quantityPerAction: { kind: "limit", maximum: 100, confirmed: true }, actionsPerHour: { kind: "limit", maximum: 100, confirmed: true } },
    forbiddenActions: { actionNames: [], confirmed: true }, approver: { kind: "not-required", confirmed: true },
    retryAndReconciliation: { reconcileBeforeRetry: true, blindRetryAllowed: false, maximumAttempts: 1, confirmed: true }, finalConsequentialReview: { confirmed: true },
  };
}

export function readinessTestFacts(): HttpBindingFactoryFacts {
  return {
    targetAlias: "northstar_sandbox", ordinaryBusinessOutcome: "Exactly one draft order exists and collateral state is unchanged.", outcomeConfirmed: true,
    action: {
      driverId: "northstar-action-driver", operationId: "createOrder", operationConfirmed: true, credentialAlias: "northstarWriter",
      requestMappings: [
        { source: { kind: "workflow-input", inputKey: "orderRef", confirmed: true }, destination: { location: "json-body", path: ["order_ref"] }, transform: "identity", confirmed: true },
        { source: { kind: "workflow-input", inputKey: "sku", confirmed: true }, destination: { location: "json-body", path: ["sku"] }, transform: "identity", confirmed: true },
        { source: { kind: "workflow-input", inputKey: "quantity", confirmed: true }, destination: { location: "json-body", path: ["quantity"] }, transform: "identity", confirmed: true },
      ],
      requestMappingsConfirmed: true, reconcileBeforeRetry: true, blindRetryAllowed: false,
    },
    observer: {
      driverId: "northstar-observer-driver", sourceId: "northstar-read-model", operationId: "listOrders", operationConfirmed: true, credentialAlias: "northstarObserver",
      independentlyAuthenticated: true, independentFromActionDriver: true,
      parameterBindings: [{ name: "order_ref", location: "query", source: { kind: "workflow-input", inputKey: "orderRef", confirmed: true }, purpose: "stable-identifier", confirmed: true }],
      resultPath: ["items"], resultPathConfirmed: true, pagination: { kind: "not-paginated", confirmed: true },
      freshness: { kind: "server-timestamp-body", path: ["server_time"], maximumAgeSeconds: 30, confirmed: true },
    },
    outcome: {
      predicates: [{ key: "one-order", path: ["items"], operator: "count-equals", expectedCount: 1, confirmed: true }],
      duplicateCheck: { collectionPath: ["items"], uniqueKeyPath: ["order_ref"], expectedCount: 1, confirmed: true },
      collateralChecks: [{ key: "collateral-clean", path: ["collateral_clean"], operator: "equals-confirmed", expected: true, confirmed: true }],
      notStartedDefinition: [{ key: "no-order", path: ["items"], operator: "count-equals", expectedCount: 0, confirmed: true }], confirmed: true,
    },
  };
}

export function readinessTestStartInput(): StartOnboardingPreparationInput {
  return {
    schemaVersion: "1.0", sessionId: "northstar-readiness-session", tenantId: "northstar-tenant", adapterId: "northstar-adapter", adapterVersion: "1.0.0",
    executionDriverId: "northstar-action-driver", duplicatePrevention: "both", resetStrategy: { kind: "fixture-reset", reference: "fixture://northstar/reset", independentlyChecked: true },
    persistence: { durableJobStore: true, durableCapabilityRegistry: true },
    adapter: {
      schemaVersion: "1.0",
      workflow: { workflowId: "create-order", summary: "Create one bounded order.", requiredOutcome: readinessTestFacts().ordinaryBusinessOutcome, approvedTargetAliases: ["northstar_sandbox"], requestedOperationNames: ["listOrders", "createOrder"], customerConfirmed: true },
      materials: [readinessTestMaterial()],
    },
    verifier: {
      schemaVersion: "1.0", outcomeKey: "northstar-order-complete", ordinaryBusinessOutcome: readinessTestFacts().ordinaryBusinessOutcome, executionDriverId: "northstar-action-driver",
      successCriteria: [{ key: "one-order", observationKey: "orders", path: [], operator: "count-equals", expected: 1 }],
      duplicateCheck: { observationKey: "orders", path: [], expectedCount: 1 }, collateralEffectCountObservationKey: "incorrect-effects",
      freshness: { maximumAgeSeconds: 30, observedAtKey: "observed-at", notBeforeBoundary: "trusted-operation-start", boundaryConfirmed: true },
      observationSurfaces: [{ key: "northstar-read-model", sourceId: "northstar-read-model", description: "Independent Northstar read model.", sourceKind: "read-model", observationKeys: ["orders", "incorrect-effects", "observed-at"], approvedForThisOutcome: true, independentFromExecution: true, independenceConfirmed: true, supportsFreshnessBoundary: true }],
    },
    authority: readinessTestAuthority(),
  };
}

export function readinessTestPreparation(intake: StartOnboardingPreparationInput) {
  const workflow = new DurableOnboardingPreparationWorkflow(":memory:", { now: () => "2026-08-14T11:00:00.000Z" });
  const proposed = workflow.start(intake);
  const reviewed = workflow.confirmReview({
    sessionId: intake.sessionId, expectedInputDigest: proposed.inputDigest, expectedSnapshotDigest: proposed.snapshotDigest,
    review: {
      adapterProposalDigest: onboardingAcceptanceSourceDigest(proposed.adapterProposal), verifierContractDigest: onboardingAcceptanceSourceDigest(proposed.verifierContract), authorityCompilationDigest: onboardingAcceptanceSourceDigest(proposed.authorityCompilation),
      authorityRuntimeBindingDigest: hash("northstar authority binding"), observationAdapterBindingDigest: hash("northstar observer binding"), confirmedByAlias: "fixtureEngineer", confirmedAt: "2026-08-14T11:00:00.000Z",
    },
  });
  workflow.close();
  return reviewed;
}

export function readinessTestBindingArtifacts(prepared: ReturnType<typeof readinessTestPreparation>) {
  const first = normalizeApprovedOpenApiMaterial(readinessTestMaterial());
  const normalization = normalizeApprovedOpenApiMaterial(readinessTestMaterial(), { materialDigest: first.originalMaterialDigest, selectedUrl: "https://northstar.local.invalid/v1", confirmedByAlias: "fixtureEngineer", confirmedAt: "2026-08-14T11:00:00.000Z" });
  const factoryResult = proposeHttpBindings({ schemaVersion: "1.0", normalization, authorityCompilation: prepared.authorityCompilation, facts: readinessTestFacts() });
  const actionTransport: CustomerLocalHttpTransport = { driverId: "northstar-action-driver", sourceId: "northstar-write-api", serverUrl: "https://northstar.local.invalid/v1", implementationDigest: hash("action transport"), supportedMethods: ["POST"], independentlyAuthenticated: true, independentFromDriverIds: [], perform: async () => ({ status: 201, headers: {}, body: {} }) };
  const observerTransport: CustomerLocalHttpTransport = { driverId: "northstar-observer-driver", sourceId: "northstar-read-model", serverUrl: "https://northstar.local.invalid/v1", implementationDigest: hash("observer transport"), supportedMethods: ["GET"], independentlyAuthenticated: true, independentFromDriverIds: ["northstar-action-driver"], perform: async () => ({ status: 200, headers: {}, body: {} }) };
  const credentialResolver: CustomerLocalCredentialResolver = { resolverId: "northstar-resolver", implementationDigest: hash("credential resolver"), allowedAliases: ["northstarWriter", "northstarObserver"], resolve: async (alias) => ({ alias, value: "opaque-customer-local-handle" }) };
  const qualification = createLocalFixtureBindingQualification({ tenantId: prepared.tenantId, sessionId: prepared.sessionId, packageDigest: prepared.inputDigest, sourceDigest: normalization.normalizedMaterialDigest, factoryResult, actionTransport, observerTransport, credentialResolver, qualifiedAt: "2026-08-14T11:00:00.000Z", expiresAt: "2026-09-13T11:00:00.000Z" });
  const pair = compileReviewedHttpBindings({ factoryResult, actionTransport, observerTransport, credentialResolver, primitiveRegistryDigest: hash("primitives"), verifierRegistryDigest: hash("verifiers"), qualifiedAt: "2026-08-14T11:00:00.000Z", expiresAt: "2026-09-13T11:00:00.000Z", customerLocalQualification: qualification, now: () => Date.parse(evaluatedAt) });
  return { factoryResult, pair, normalization, runtime: { actionTransport, observerTransport, credentialResolver, primitiveRegistryDigest: hash("primitives"), verifierRegistryDigest: hash("verifiers"), qualificationRuntime: qualification.runtime } };
}

function result(caseId: PilotAdapterAcceptanceCase): PilotAdapterAcceptanceResult {
  return { caseId, passed: true, intendedWrites: caseId === "approved-write" ? 1 : 0, incorrectSideEffects: 0, checks: [{ id: `${caseId}-check`, passed: true, detail: "Synthetic fixture met the precommitted assertion." }], artifactReferences: [`fixture://${caseId}`], completedAt: "2026-08-14T11:30:00.000Z" };
}

export function readinessTestCampaign(pairDigest: string, bindingId = "northstar-binding"): GenericAcceptanceCampaignState {
  const campaignId = "northstar-readiness-campaign";
  let previous: string | undefined;
  const receipts: GenericAcceptanceEvidenceReceipt[] = REQUIRED_PILOT_ADAPTER_CASES.map((caseId, index) => {
    const withoutHash = { schemaVersion: "1.0" as const, campaignId, caseId, attemptId: `attempt-${index + 1}`, attemptNumber: 1, source: "execution" as const, bindingId, bindingVersion: "1.0.0", bindingDigest: pairDigest, declarationDigest: pairDigest, result: result(caseId), ...(previous ? { previousReceiptHash: previous } : {}) };
    const receipt = { ...withoutHash, receiptHash: onboardingReadinessDigest(withoutHash) };
    previous = receipt.receiptHash;
    return receipt;
  });
  return {
    schemaVersion: "1.0", campaignId, declarationDigest: pairDigest, bindingId, bindingVersion: "1.0.0", bindingDigest: pairDigest,
    requiredCaseOrder: [...REQUIRED_PILOT_ADAPTER_CASES], status: "completed", revision: 22,
    cases: REQUIRED_PILOT_ADAPTER_CASES.map((caseId, index) => ({ caseId, status: "passed", attemptCount: 1, latestReceiptHash: receipts[index]!.receiptHash })),
    receipts, createdAt: "2026-08-14T11:15:00.000Z", updatedAt: "2026-08-14T11:30:00.000Z",
  };
}

export function readinessTestValidInput(): BuildOnboardingReadinessReceiptInput {
  const intake = readinessTestStartInput();
  const prepared = readinessTestPreparation(intake);
  const { factoryResult, pair } = readinessTestBindingArtifacts(prepared);
  const acceptanceCampaign = readinessTestCampaign(pair.pairDigest);
  return {
    schemaVersion: "1.0", intake, preparation: prepared, factoryResult, compiledPair: pair, acceptanceCampaign, evaluatedAt, maximumEvidenceAgeSeconds: 7_200,
    expectation: { sessionId: prepared.sessionId, inputDigest: prepared.inputDigest, snapshotDigest: prepared.snapshotDigest, snapshotRevision: prepared.revision, factoryResultDigest: factoryResult.resultDigest, compiledPairDigest: pair.pairDigest, campaignId: acceptanceCampaign.campaignId, campaignRevision: acceptanceCampaign.revision, latestAcceptanceReceiptHash: acceptanceCampaign.receipts.at(-1)!.receiptHash },
  };
}

describe("integrity-bound onboarding readiness receipt", () => {
  it("joins the exact synthetic artifact chain while keeping activation categorically false", () => {
    const receipt = buildOnboardingReadinessReceipt(readinessTestValidInput());
    expect(receipt.artifactStates.genericAcceptance).toBe("ten-of-ten-synthetic-passed");
    expect(receipt.artifactStates.activationAuthority).toBe("not-established");
    expect(receipt.activated).toBe(false);
    expect(receipt.customerEvidence).toBe(false);
    assertOnboardingReadinessReceiptIntegrity(receipt);
  });

  it("rejects cross-session, stale-revision, mutated evidence and stale campaign attacks", () => {
    const crossSession = readinessTestValidInput();
    crossSession.expectation.sessionId = "different-session";
    expect(() => buildOnboardingReadinessReceipt(crossSession)).toThrow(/session.*stale|session.*another/i);

    const staleRevision = readinessTestValidInput();
    staleRevision.expectation.snapshotRevision -= 1;
    expect(() => buildOnboardingReadinessReceipt(staleRevision)).toThrow(/revision.*stale/i);

    const mutated = readinessTestValidInput();
    mutated.acceptanceCampaign.receipts[3]!.result.artifactReferences.push("fixture://injected");
    expect(() => buildOnboardingReadinessReceipt(mutated)).toThrow(/integrity check/i);

    const stale = readinessTestValidInput();
    stale.evaluatedAt = "2026-08-15T12:00:00.000Z";
    expect(() => buildOnboardingReadinessReceipt(stale)).toThrow(/stale|expired/i);
  });

  it("preserves fabricated verified, ready and activated flags only as customer declarations", () => {
    const input = readinessTestValidInput();
    input.customerDeclarations = [
      { key: "adaptersVerified", value: true, declaredByAlias: "customerForm", declaredAt: "2026-08-14T11:45:00.000Z" },
      { key: "productionReady", value: true, declaredByAlias: "customerForm", declaredAt: "2026-08-14T11:45:00.000Z" },
      { key: "activated", value: true, declaredByAlias: "customerForm", declaredAt: "2026-08-14T11:45:00.000Z" },
    ];
    const receipt = buildOnboardingReadinessReceipt(input);
    expect(receipt.customerDeclarations.map((item) => item.evidenceClass)).toEqual(["customer-declaration-only", "customer-declaration-only", "customer-declaration-only"]);
    expect(receipt.customerDeclarations.map((item) => item.value)).toEqual([true, true, true]);
    expect(receipt.activated).toBe(false);
    expect(receipt.productionReady).toBe(false);
    expect(receipt.artifactStates.activationAuthority).toBe("not-established");
  });

  it("detects receipt mutation after issuance", () => {
    const receipt = buildOnboardingReadinessReceipt(readinessTestValidInput());
    receipt.remainingBespokeWork.length = 0;
    expect(() => assertOnboardingReadinessReceiptIntegrity(receipt)).toThrow(/integrity check/i);
  });
});
