import { describe, expect, it } from "vitest";
import { REQUIRED_PILOT_ADAPTER_CASES } from "../src/product/pilot-adapter.js";
import {
  generateAcceptancePlanFromReviewedContracts,
  generateOnboardingAcceptancePlan,
  onboardingAcceptanceSourceDigest,
} from "../src/product/onboarding-acceptance-factory.js";
import { discoverAdapterProposal } from "../src/product/onboarding-adapter-factory.js";
import { compileAuthorityWizard, proposeExternalOutcomeVerifier } from "../src/product/onboarding-verifier-authority.js";

function input() {
  return {
    adapterId: "local_procurement",
    adapterVersion: "1.0.0",
    workflowKey: "restock_materials",
    readOperationKeys: ["listRequests", "readPurchaseOrder"],
    writeOperationKeys: ["createDraftPurchaseOrder"],
    credentialAliases: ["erpSandboxCredential"],
    permissionKeys: ["createDraftPurchaseOrder"],
    outcomeVerifierKeys: ["purchaseOrderState"],
    resetStrategy: { kind: "fixture-reset" as const, reference: "fixture://erp/reset", independentlyChecked: true },
    retry: { duplicatePrevention: "both" as const, reconcileBeforeRetry: true as const, blindRetryAllowed: false as const },
    persistence: { durableJobStore: true, durableCapabilityRegistry: true },
    confirmations: { operationsReviewed: true, authorityReviewed: true, verifierReviewed: true, disposableEnvironmentConfirmed: true },
  };
}

describe("onboarding acceptance factory", () => {
  it("generates every mandatory case in order without calling it executable or passed", () => {
    const plan = generateOnboardingAcceptancePlan(input());
    expect(plan.cases.map((item) => item.caseId)).toEqual(REQUIRED_PILOT_ADAPTER_CASES);
    expect(plan.cases.every((item) => item.status === "declared-not-run")).toBe(true);
    expect(plan.cases.every((item) => item.requiredArtifacts.some((artifact) => artifact.includes("independent-outcome")))).toBe(true);
    expect(plan).toMatchObject({ executable: false, passed: false, status: "scaffold-only", blockers: [] });
  });

  it("makes missing setup visible instead of silently weakening the plan", () => {
    const plan = generateOnboardingAcceptancePlan({
      ...input(),
      writeOperationKeys: [],
      credentialAliases: [],
      permissionKeys: [],
      resetStrategy: { kind: "unavailable" as const, reference: "No reset exists yet", independentlyChecked: false },
      persistence: { durableJobStore: false, durableCapabilityRegistry: false },
      confirmations: { operationsReviewed: false, authorityReviewed: false, verifierReviewed: false, disposableEnvironmentConfirmed: false },
    });
    expect(plan.blockers).toContain("no-bounded-write-operation-declared");
    expect(plan.blockers).toContain("disposable-reset-strategy-unavailable");
    expect(plan.blockers).toContain("durable-job-store-not-configured");
    expect(plan.blockers).toContain("verifier-contract-not-reviewed");
    expect(plan.passed).toBe(false);
  });

  it("derives fields from digest-pinned reviewed adapter, verifier, and authority contracts", () => {
    const adapterProposal = discoverAdapterProposal({
      schemaVersion: "1.0",
      workflow: {
        workflowId: "restock_materials",
        summary: "Create one approved draft restock order.",
        requiredOutcome: "Exactly one draft order exists and no unrelated record changes.",
        approvedTargetAliases: ["customer_erp"],
        requestedOperationNames: ["readOrder", "createDraftOrder"],
        customerConfirmed: true,
      },
      materials: [{
        kind: "openapi",
        materialId: "erp-openapi",
        localReference: "fixtures/erp-openapi.json",
        approved: true,
        targetAlias: "customer_erp",
        document: {
          openapi: "3.1.0", info: { title: "ERP" }, security: [{ erpCredential: [] }],
          paths: {
            "/orders/{id}": { get: { operationId: "readOrder", responses: { "200": { description: "Order" } } } },
            "/orders": { post: { operationId: "createDraftOrder", parameters: [{ name: "Idempotency-Key", in: "header" }], responses: { "201": { description: "Created" } } } },
          },
          components: { securitySchemes: { erpCredential: { type: "http", scheme: "bearer" } } },
        },
      }],
    });
    const verifier = proposeExternalOutcomeVerifier({
      schemaVersion: "1.0",
      outcomeKey: "draft-order-recorded",
      ordinaryBusinessOutcome: "Exactly one draft order exists and no unrelated record changes.",
      executionDriverId: "erp-http-driver",
      successCriteria: [{ key: "status", observationKey: "order", path: ["status"], operator: "equals", expected: "draft" }],
      duplicateCheck: { observationKey: "matching-orders", path: [], expectedCount: 1 },
      collateralEffectCountObservationKey: "incorrect-side-effects",
      freshness: { maximumAgeSeconds: 30, observedAtKey: "observed-at", notBeforeBoundary: "trusted-operation-start", boundaryConfirmed: true },
      observationSurfaces: [{
        key: "erp-read-model", sourceId: "erp-read-model", description: "Independent customer-approved read model.",
        sourceKind: "read-model", observationKeys: ["order", "matching-orders", "incorrect-side-effects", "observed-at"],
        approvedForThisOutcome: true, independentFromExecution: true, independenceConfirmed: true, supportsFreshnessBoundary: true,
      }],
    });
    const authority = compileAuthorityWizard({
      schemaVersion: "1.0",
      systemsAndTargets: { aliases: ["customer_erp"], confirmed: true },
      credentialAliases: { aliases: ["erpCredential"], confirmed: true },
      readsAllowed: { actions: [{ actionName: "readOrder", targetAlias: "customer_erp" }], confirmed: true },
      writes: [{ actionName: "createDraftOrder", targetAlias: "customer_erp", method: "POST", policy: "preauthorized", confirmed: true }],
      limits: {
        monetary: { kind: "none", confirmed: true }, quantityPerAction: { kind: "limit", maximum: 5, confirmed: true }, actionsPerHour: { kind: "limit", maximum: 20, confirmed: true },
      },
      forbiddenActions: { actionNames: [], confirmed: true },
      approver: { kind: "not-required", confirmed: true },
      retryAndReconciliation: { reconcileBeforeRetry: true, blindRetryAllowed: false, maximumAttempts: 1, confirmed: true },
      finalConsequentialReview: { confirmed: true },
    });
    const plan = generateAcceptancePlanFromReviewedContracts({
      adapterId: "local_procurement",
      adapterVersion: "1.0.0",
      adapterProposal,
      verifierContract: verifier.contract,
      authorityCompilation: authority,
      executionDriverId: "erp-http-driver",
      duplicatePrevention: "both",
      resetStrategy: { kind: "fixture-reset", reference: "fixture://erp/reset", independentlyChecked: true },
      persistence: { durableJobStore: true, durableCapabilityRegistry: true },
      review: {
        adapterProposalDigest: onboardingAcceptanceSourceDigest(adapterProposal),
        verifierContractDigest: onboardingAcceptanceSourceDigest(verifier.contract),
        authorityCompilationDigest: onboardingAcceptanceSourceDigest(authority),
        authorityRuntimeBindingDigest: "a".repeat(64),
        observationAdapterBindingDigest: "b".repeat(64),
        confirmedByAlias: "platformEngineer",
        confirmedAt: "2026-08-12T00:00:00.000Z",
      },
    });
    expect(plan).toMatchObject({ status: "scaffold-only", executable: false, passed: false, blockers: [] });
    expect(plan.cases).toHaveLength(10);
    expect(plan.cases.find((item) => item.caseId === "approved-write")?.blockers).toEqual([]);
    expect(plan.derivationReceipt).toMatchObject({
      adapterProposalDigest: onboardingAcceptanceSourceDigest(adapterProposal),
      authorityRuntimeBindingDigest: "a".repeat(64),
      observationAdapterBindingDigest: "b".repeat(64),
      confirmedByAlias: "platformEngineer",
      confirmedAt: "2026-08-12T00:00:00.000Z",
    });
    expect(plan.derivationReceipt?.receiptDigest).toMatch(/^[a-f0-9]{64}$/);

    const broaderAuthority = structuredClone(authority);
    broaderAuthority.guardrails.allowedReadActions.push({ actionName: "listAllOrders", targetAlias: "customer_erp" });
    expect(() => generateAcceptancePlanFromReviewedContracts({
      adapterId: "local_procurement",
      adapterVersion: "1.0.0",
      adapterProposal,
      verifierContract: verifier.contract,
      authorityCompilation: broaderAuthority,
      executionDriverId: "erp-http-driver",
      duplicatePrevention: "both",
      resetStrategy: { kind: "fixture-reset", reference: "fixture://erp/reset", independentlyChecked: true },
      persistence: { durableJobStore: true, durableCapabilityRegistry: true },
      review: {
        adapterProposalDigest: onboardingAcceptanceSourceDigest(adapterProposal),
        verifierContractDigest: onboardingAcceptanceSourceDigest(verifier.contract),
        authorityCompilationDigest: onboardingAcceptanceSourceDigest(broaderAuthority),
        authorityRuntimeBindingDigest: "a".repeat(64),
        observationAdapterBindingDigest: "b".repeat(64),
        confirmedByAlias: "platformEngineer",
        confirmedAt: "2026-08-12T00:00:00.000Z",
      },
    })).toThrow(/intrinsic digest/);

    expect(() => generateAcceptancePlanFromReviewedContracts({
      adapterId: "local_procurement", adapterVersion: "1.0.0", adapterProposal, verifierContract: verifier.contract,
      authorityCompilation: authority, duplicatePrevention: "both",
      executionDriverId: "erp-http-driver",
      resetStrategy: { kind: "fixture-reset", reference: "fixture://erp/reset", independentlyChecked: true },
      persistence: { durableJobStore: true, durableCapabilityRegistry: true },
      review: {
        adapterProposalDigest: "0".repeat(64), verifierContractDigest: onboardingAcceptanceSourceDigest(verifier.contract),
        authorityCompilationDigest: onboardingAcceptanceSourceDigest(authority), confirmedByAlias: "platformEngineer", confirmedAt: "2026-08-12T00:00:00.000Z",
        authorityRuntimeBindingDigest: "a".repeat(64), observationAdapterBindingDigest: "b".repeat(64),
      },
    })).toThrow(/digest does not match/);

    const mutatedVerifier = structuredClone(verifier.contract);
    mutatedVerifier.successState[0] = { ...mutatedVerifier.successState[0]!, expected: "submitted" } as typeof mutatedVerifier.successState[number];
    expect(() => generateAcceptancePlanFromReviewedContracts({
      adapterId: "local_procurement", adapterVersion: "1.0.0", adapterProposal, verifierContract: mutatedVerifier,
      authorityCompilation: authority, duplicatePrevention: "both", executionDriverId: "erp-http-driver",
      resetStrategy: { kind: "fixture-reset", reference: "fixture://erp/reset", independentlyChecked: true },
      persistence: { durableJobStore: true, durableCapabilityRegistry: true },
      review: {
        adapterProposalDigest: onboardingAcceptanceSourceDigest(adapterProposal),
        verifierContractDigest: onboardingAcceptanceSourceDigest(mutatedVerifier),
        authorityCompilationDigest: onboardingAcceptanceSourceDigest(authority),
        authorityRuntimeBindingDigest: "a".repeat(64), observationAdapterBindingDigest: "b".repeat(64),
        confirmedByAlias: "platformEngineer", confirmedAt: "2026-08-12T00:00:00.000Z",
      },
    })).toThrow(/intrinsic digest/);

    const mutatedAuthority = structuredClone(authority);
    mutatedAuthority.guardrails.maximumAttempts = 10;
    expect(() => generateAcceptancePlanFromReviewedContracts({
      adapterId: "local_procurement", adapterVersion: "1.0.0", adapterProposal, verifierContract: verifier.contract,
      authorityCompilation: mutatedAuthority, duplicatePrevention: "both", executionDriverId: "erp-http-driver",
      resetStrategy: { kind: "fixture-reset", reference: "fixture://erp/reset", independentlyChecked: true },
      persistence: { durableJobStore: true, durableCapabilityRegistry: true },
      review: {
        adapterProposalDigest: onboardingAcceptanceSourceDigest(adapterProposal),
        verifierContractDigest: onboardingAcceptanceSourceDigest(verifier.contract),
        authorityCompilationDigest: onboardingAcceptanceSourceDigest(mutatedAuthority),
        authorityRuntimeBindingDigest: "a".repeat(64), observationAdapterBindingDigest: "b".repeat(64),
        confirmedByAlias: "platformEngineer", confirmedAt: "2026-08-12T00:00:00.000Z",
      },
    })).toThrow(/intrinsic digest/);
  });
});
