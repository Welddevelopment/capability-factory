import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DurableOnboardingPreparationWorkflow,
  onboardingPreparationDigest,
  type StartOnboardingPreparationInput,
} from "../src/product/onboarding-preparation-workflow.js";

function input(sessionId = "onboarding-session-1"): StartOnboardingPreparationInput {
  const outcome = "Exactly one draft order exists and no unrelated record changes.";
  return {
    schemaVersion: "1.0",
    sessionId,
    tenantId: "tenant-local",
    adapterId: "local-procurement",
    adapterVersion: "1.0.0",
    executionDriverId: "erp-http-driver",
    duplicatePrevention: "both",
    resetStrategy: { kind: "fixture-reset", reference: "fixture://erp/reset", independentlyChecked: true },
    persistence: { durableJobStore: true, durableCapabilityRegistry: true },
    adapter: {
      schemaVersion: "1.0",
      workflow: {
        workflowId: "restock-materials",
        summary: "Create one approved draft restock order.",
        requiredOutcome: outcome,
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
          openapi: "3.1.0",
          info: { title: "ERP" },
          security: [{ erpCredential: [] }],
          paths: {
            "/orders/{id}": { get: { operationId: "readOrder", responses: { "200": { description: "Order" } } } },
            "/orders": {
              post: {
                operationId: "createDraftOrder",
                parameters: [{ name: "Idempotency-Key", in: "header" }],
                responses: { "201": { description: "Created" } },
              },
            },
          },
          components: { securitySchemes: { erpCredential: { type: "http", scheme: "bearer" } } },
        },
      }],
    },
    verifier: {
      schemaVersion: "1.0",
      outcomeKey: "draft-order-recorded",
      ordinaryBusinessOutcome: outcome,
      executionDriverId: "erp-http-driver",
      successCriteria: [{ key: "status", observationKey: "order", path: ["status"], operator: "equals", expected: "draft" }],
      duplicateCheck: { observationKey: "matching-orders", path: [], expectedCount: 1 },
      collateralEffectCountObservationKey: "incorrect-side-effects",
      freshness: { maximumAgeSeconds: 30, observedAtKey: "observed-at", notBeforeBoundary: "trusted-operation-start", boundaryConfirmed: true },
      observationSurfaces: [{
        key: "erp-read-model",
        sourceId: "erp-read-model",
        description: "Independent customer-approved read model.",
        sourceKind: "read-model",
        observationKeys: ["order", "matching-orders", "incorrect-side-effects", "observed-at"],
        approvedForThisOutcome: true,
        independentFromExecution: true,
        independenceConfirmed: true,
        supportsFreshnessBoundary: true,
      }],
    },
    authority: {
      schemaVersion: "1.0",
      systemsAndTargets: { aliases: ["customer_erp"], confirmed: true },
      credentialAliases: { aliases: ["erpCredential"], confirmed: true },
      readsAllowed: { actions: [{ actionName: "readOrder", targetAlias: "customer_erp" }], confirmed: true },
      writes: [{ actionName: "createDraftOrder", targetAlias: "customer_erp", method: "POST", policy: "preauthorized", confirmed: true }],
      limits: {
        monetary: { kind: "none", confirmed: true },
        quantityPerAction: { kind: "limit", maximum: 5, confirmed: true },
        actionsPerHour: { kind: "limit", maximum: 20, confirmed: true },
      },
      forbiddenActions: { actionNames: [], confirmed: true },
      approver: { kind: "not-required", confirmed: true },
      retryAndReconciliation: { reconcileBeforeRetry: true, blindRetryAllowed: false, maximumAttempts: 1, confirmed: true },
      finalConsequentialReview: { confirmed: true },
    },
  };
}

describe("durable onboarding preparation workflow", () => {
  it("persists a proposal-only session across a fresh process and resumes from exact digests", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cf-onboarding-preparation-"));
    const database = path.join(directory, "preparation.sqlite");
    const first = new DurableOnboardingPreparationWorkflow(database, { now: () => "2026-08-14T00:00:00.000Z" });
    const proposed = first.start(input());
    expect(proposed).toMatchObject({
      status: "review-required",
      activation: "not-activated",
      revision: 1,
      receipt: { readiness: "review-required", acceptanceState: "not-generated" },
    });
    expect(proposed.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.events(proposed.sessionId).map((event) => event.eventType)).toEqual(["preparation-proposed"]);
    first.close();

    const resumed = new DurableOnboardingPreparationWorkflow(database, { now: () => "2026-08-14T00:01:00.000Z" });
    expect(resumed.read(proposed.sessionId)).toEqual(proposed);
    const ready = resumed.confirmReview({
      sessionId: proposed.sessionId,
      expectedInputDigest: proposed.inputDigest,
      expectedSnapshotDigest: proposed.snapshotDigest,
      review: {
        adapterProposalDigest: onboardingPreparationDigest(proposed.adapterProposal),
        verifierContractDigest: onboardingPreparationDigest(proposed.verifierContract),
        authorityCompilationDigest: onboardingPreparationDigest(proposed.authorityCompilation),
        authorityRuntimeBindingDigest: "a".repeat(64),
        observationAdapterBindingDigest: "b".repeat(64),
        confirmedByAlias: "platformEngineer",
        confirmedAt: "2026-08-14T00:00:30.000Z",
      },
    });
    expect(ready).toMatchObject({
      status: "acceptance-scaffold-ready",
      activation: "not-activated",
      revision: 2,
      receipt: {
        readiness: "comparison-preparation-ready",
        acceptanceState: "declared-not-run",
        evidenceBoundary: expect.stringMatching(/not executed/i),
      },
      acceptancePlan: { status: "scaffold-only", executable: false, passed: false },
    });
    expect(ready.acceptancePlan?.cases).toHaveLength(10);
    expect(resumed.events(proposed.sessionId).map((event) => event.eventType)).toEqual([
      "preparation-proposed",
      "preparation-reviewed",
    ]);
    resumed.close();

    const afterReviewRestart = new DurableOnboardingPreparationWorkflow(database);
    expect(afterReviewRestart.read(proposed.sessionId)).toEqual(ready);
    afterReviewRestart.close();
  });

  it("is idempotent for identical intake and rejects conflicting reuse or stale review", () => {
    const workflow = new DurableOnboardingPreparationWorkflow();
    const proposed = workflow.start(input("onboarding-session-2"));
    expect(workflow.start(input("onboarding-session-2"))).toEqual(proposed);
    const changed = input("onboarding-session-2");
    changed.adapter.workflow.summary = "A different workflow under the same identity.";
    expect(() => workflow.start(changed)).toThrow(/different input/);
    expect(() => workflow.confirmReview({
      sessionId: proposed.sessionId,
      expectedInputDigest: proposed.inputDigest,
      expectedSnapshotDigest: "c".repeat(64),
      review: {
        adapterProposalDigest: onboardingPreparationDigest(proposed.adapterProposal),
        verifierContractDigest: onboardingPreparationDigest(proposed.verifierContract),
        authorityCompilationDigest: onboardingPreparationDigest(proposed.authorityCompilation),
        authorityRuntimeBindingDigest: "a".repeat(64),
        observationAdapterBindingDigest: "b".repeat(64),
        confirmedByAlias: "platformEngineer",
        confirmedAt: "2026-08-14T00:00:30.000Z",
      },
    })).toThrow(/stale/);
    workflow.close();
  });

  it("persists precise blockers and refuses review when authority or verification is incomplete", () => {
    const blockedInput = input("onboarding-session-3");
    blockedInput.authority.systemsAndTargets.aliases.push("customer_erp");
    blockedInput.verifier.observationSurfaces[0]!.independenceConfirmed = false;
    const workflow = new DurableOnboardingPreparationWorkflow();
    const blocked = workflow.start(blockedInput);
    expect(blocked).toMatchObject({
      status: "blocked",
      activation: "not-activated",
      receipt: { readiness: "blocked" },
    });
    expect(blocked.blockers).toEqual(expect.arrayContaining([
      expect.stringMatching(/independent/i),
      expect.stringMatching(/duplicate target aliases/i),
    ]));
    expect(() => workflow.confirmReview({
      sessionId: blocked.sessionId,
      expectedInputDigest: blocked.inputDigest,
      expectedSnapshotDigest: blocked.snapshotDigest,
      review: {
        adapterProposalDigest: onboardingPreparationDigest(blocked.adapterProposal),
        verifierContractDigest: onboardingPreparationDigest(blocked.verifierContract),
        authorityCompilationDigest: onboardingPreparationDigest(blocked.authorityCompilation),
        authorityRuntimeBindingDigest: "a".repeat(64),
        observationAdapterBindingDigest: "b".repeat(64),
        confirmedByAlias: "platformEngineer",
        confirmedAt: "2026-08-14T00:00:30.000Z",
      },
    })).toThrow(/not eligible/);
    workflow.close();
  });
});
