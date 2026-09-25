import { describe, expect, it } from "vitest";
import {
  compileAuthorityWizard,
  createFreshnessEnforcingObservationAdapter,
  createFailClosedObservationAdapterScaffold,
  proposeExternalOutcomeVerifier,
  type AuthorityWizardAnswers,
  type VerifierFactoryIntake,
} from "../src/product/onboarding-verifier-authority.js";

function verifierIntake(): VerifierFactoryIntake {
  return {
    schemaVersion: "1.0",
    outcomeKey: "draft-order-recorded",
    ordinaryBusinessOutcome: "Exactly one draft purchase order exists for the approved request and no unrelated record changed.",
    executionDriverId: "constrained-http-driver",
    successCriteria: [
      {
        key: "order-status",
        observationKey: "order",
        path: ["status"],
        operator: "equals",
        expected: "draft",
      },
      {
        key: "source-linked",
        observationKey: "source-request",
        path: ["purchase-order-reference"],
        operator: "exists",
      },
    ],
    duplicateCheck: { observationKey: "matching-orders", path: [], expectedCount: 1 },
    collateralEffectCountObservationKey: "incorrect-side-effects",
    freshness: { maximumAgeSeconds: 30, observedAtKey: "observed-at", notBeforeBoundary: "trusted-operation-start", boundaryConfirmed: true },
    observationSurfaces: [
      {
        key: "customer-read-model",
        sourceId: "customer-order-read-model",
        description: "Customer-approved read model queried separately from the acting HTTP driver.",
        sourceKind: "read-model",
        observationKeys: [
          "order",
          "source-request",
          "matching-orders",
          "incorrect-side-effects",
          "observed-at",
        ],
        approvedForThisOutcome: true,
        independentFromExecution: true,
        independenceConfirmed: true,
        supportsFreshnessBoundary: true,
      },
    ],
  };
}

function authorityAnswers(): AuthorityWizardAnswers {
  return {
    schemaVersion: "1.0",
    systemsAndTargets: { aliases: ["customer-erp"], confirmed: true },
    credentialAliases: { aliases: ["erp-api-key"], confirmed: true },
    readsAllowed: { actions: [
      { actionName: "read-order", targetAlias: "customer-erp" },
      { actionName: "search-orders", targetAlias: "customer-erp" },
    ], confirmed: true },
    writes: [],
    limits: {
      monetary: { kind: "none", confirmed: true },
      quantityPerAction: { kind: "none", confirmed: true },
      actionsPerHour: { kind: "limit", maximum: 60, confirmed: true },
    },
    forbiddenActions: { actionNames: ["delete-order"], confirmed: true },
    approver: { kind: "not-required", confirmed: true },
    retryAndReconciliation: {
      reconcileBeforeRetry: true,
      blindRetryAllowed: false,
      maximumAttempts: 1,
      confirmed: true,
    },
    finalConsequentialReview: { confirmed: true },
  };
}

describe("zero-spend verifier factory foundation", () => {
  it("proposes a strict independent-outcome contract but never activates or passes its generated scaffold", () => {
    const result = proposeExternalOutcomeVerifier(verifierIntake());
    expect(result.status).toBe("proposed");
    expect(result.contract).toMatchObject({
      status: "provisional-review-required",
      activation: "blocked",
      independentObserver: {
        surfaceKey: "customer-read-model",
        sourceId: "customer-order-read-model",
        sourceKind: "read-model",
      },
      scaffold: {
        implementationStatus: "not-implemented",
        executionStatus: "not-run",
        compileTarget: "UniversalVerifierFactory-with-FreshnessEnforcingObservationAdapter",
        generatedScaffoldIsPassingEvidence: false,
      },
      blockers: [],
    });
    expect(result.contract.contractDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.contract.criterionContractDraft?.criteria).toContainEqual({
      key: "cf-duplicate-count",
      observationKey: "matching-orders",
      path: [],
      operator: "count-equals",
      expected: 1,
    });
    expect(result.contract.classifications.map((item) => item.classification)).toEqual([
      "completed",
      "not-started",
      "partial",
      "incorrect",
      "unknown",
    ]);
    expect(result.contract.acceptanceCases.every((item) => item.status === "declared-not-run")).toBe(true);
    expect(result.contract.acceptanceCases.map((item) => item.id)).toContain("lost-response-reconciliation");
    expect(result.contract.acceptanceCases.map((item) => item.id)).toContain("adversarial-action-response");
  });

  it("categorically refuses to use an action response as independent proof", () => {
    const input = verifierIntake();
    input.observationSurfaces = [{
      ...input.observationSurfaces[0]!,
      key: "execution-response",
      sourceId: "acting-driver-response",
      sourceKind: "action-response",
    }];
    const result = proposeExternalOutcomeVerifier(input);
    expect(result.status).toBe("proposed");
    expect(result.contract.status).toBe("blocked");
    expect(result.contract.independentObserver).toBeUndefined();
    expect(result.contract.blockers).toContainEqual(expect.stringMatching(/No approved, explicitly independent/));
    expect(result.contract.unknowns).toContainEqual(expect.stringMatching(/Action-response surfaces were excluded/));
  });

  it("refuses an observer that only claims independence while sharing the execution source ID", () => {
    const input = verifierIntake();
    input.observationSurfaces[0]!.sourceId = input.executionDriverId;
    const result = proposeExternalOutcomeVerifier(input);
    expect(result.contract.independentObserver).toBeUndefined();
    expect(result.contract.blockers).toContainEqual(expect.stringMatching(/No approved, explicitly independent/));
  });

  it("fails closed when freshness or observer coverage remains unconfirmed", () => {
    const input = verifierIntake();
    input.freshness.boundaryConfirmed = false;
    input.observationSurfaces[0]!.observationKeys = ["order", "source-request"];
    const result = proposeExternalOutcomeVerifier(input);
    expect(result.status).toBe("proposed");
    expect(result.contract.status).toBe("blocked");
    expect(result.contract.activation).toBe("blocked");
    expect(result.contract.blockers).toHaveLength(2);
  });

  it("returns a non-executable blocked object for malformed intake", () => {
    const result = proposeExternalOutcomeVerifier({ schemaVersion: "1.0", ordinaryBusinessOutcome: "Missing everything else." });
    expect(result.status).toBe("rejected");
    expect(result.contract).toMatchObject({ status: "blocked", activation: "blocked" });
    if (result.status === "rejected") expect(result.validationErrors.length).toBeGreaterThan(0);
  });

  it("emits a typed but unusable observer scaffold and rejects secrets or reserved criterion collisions", async () => {
    const result = proposeExternalOutcomeVerifier(verifierIntake());
    const scaffold = createFailClosedObservationAdapterScaffold(result.contract);
    expect(scaffold.independentFromDriverIds).toEqual([]);
    await expect(scaffold.observe({ tenantId: "tenant", requestId: "request", parentGoalId: "goal", operationKey: "create-order" }))
      .rejects.toThrow(/not implemented or independently bound/);

    const secret = verifierIntake();
    secret.ordinaryBusinessOutcome = "Accept Bearer abcdefghijklmnopqrstuvwxyz as proof.";
    expect(proposeExternalOutcomeVerifier(secret).status).toBe("rejected");

    const collision = verifierIntake();
    collision.successCriteria[0]!.key = "cf-duplicate-count";
    expect(proposeExternalOutcomeVerifier(collision).status).toBe("rejected");
  });

  it("enforces freshness in trusted code before observations reach the verifier", async () => {
    const base = {
      key: "customer-read-model",
      sourceId: "customer-order-read-model",
      priority: 1,
      observationKeys: ["observed-at", "order"],
      independentFromDriverIds: ["constrained-http-driver"],
      observe: async () => ({ "observed-at": "2026-08-12T00:00:00.000Z", order: { status: "draft" } }),
    };
    const fresh = createFreshnessEnforcingObservationAdapter(base, {
      observedAtKey: "observed-at",
      maximumAgeSeconds: 30,
      maximumFutureSkewSeconds: 5,
      notBeforeEpochMs: Date.parse("2026-08-11T23:59:59.000Z"),
    }, () => Date.parse("2026-08-12T00:00:20.000Z"));
    await expect(fresh.observe({ tenantId: "tenant", requestId: "request", parentGoalId: "goal", operationKey: "create-order" }))
      .resolves.toMatchObject({ order: { status: "draft" } });
    const stale = createFreshnessEnforcingObservationAdapter(base, {
      observedAtKey: "observed-at",
      maximumAgeSeconds: 10,
      maximumFutureSkewSeconds: 5,
      notBeforeEpochMs: Date.parse("2026-08-11T23:59:59.000Z"),
    }, () => Date.parse("2026-08-12T00:00:20.000Z"));
    await expect(stale.observe({ tenantId: "tenant", requestId: "request", parentGoalId: "goal", operationKey: "create-order" }))
      .rejects.toThrow(/outside the approved freshness window/);
    const beforeAction = createFreshnessEnforcingObservationAdapter(base, {
      observedAtKey: "observed-at",
      maximumAgeSeconds: 30,
      maximumFutureSkewSeconds: 5,
      notBeforeEpochMs: Date.parse("2026-08-12T00:00:05.000Z"),
    }, () => Date.parse("2026-08-12T00:00:20.000Z"));
    await expect(beforeAction.observe({ tenantId: "tenant", requestId: "request", parentGoalId: "goal", operationKey: "create-order" }))
      .rejects.toThrow(/predates the trusted operation-start boundary/);
  });
});

describe("ordinary-language authority wizard", () => {
  it("compiles a confirmed read-only policy into the existing write-denied authority shape", () => {
    const result = compileAuthorityWizard(authorityAnswers());
    expect(result).toMatchObject({
      status: "review-required",
      activation: "not-activated",
      authority: {
        allowedTargetAliases: [],
        allowedSecretAliases: [],
        allowedMethods: [],
        writeAuthority: "denied",
        approvedWriteActions: [],
      },
      candidateAuthority: {
        allowedTargetAliases: ["customer-erp"],
        allowedSecretAliases: ["erp-api-key"],
        allowedMethods: ["GET"],
        writeAuthority: "denied",
        approvedWriteActions: [],
      },
      guardrails: {
        allowedReadActions: [
          { actionName: "read-order", targetAlias: "customer-erp" },
          { actionName: "search-orders", targetAlias: "customer-erp" },
        ],
        forbiddenActions: ["delete-order"],
        reconcileBeforeRetry: true,
        blindRetryAllowed: false,
        maximumAttempts: 1,
      },
      blockers: [],
    });
  });

  it("compiles one fully confirmed preauthorized write without inventing an approval", () => {
    const input = authorityAnswers();
    input.writes = [{
      actionName: "create-draft-order",
      targetAlias: "customer-erp",
      method: "POST",
      policy: "preauthorized",
      confirmed: true,
    }];
    input.limits.monetary = { kind: "limit", currency: "USD", maximum: 500, confirmed: true };
    input.limits.quantityPerAction = { kind: "limit", maximum: 20, confirmed: true };
    const result = compileAuthorityWizard(input);
    expect(result.status).toBe("review-required");
    expect(result.authority.writeAuthority).toBe("denied");
    expect(result.candidateAuthority).toMatchObject({
      allowedMethods: ["GET", "POST"],
      writeAuthority: "preauthorized",
      approvedWriteActions: [],
    });
    expect(result.guardrails.limits.monetary).toEqual({ kind: "limit", currency: "USD", maximum: 500, confirmed: true });
  });

  it("includes only an explicitly confirmed current approval for an approval-gated write", () => {
    const input = authorityAnswers();
    input.writes = [{
      actionName: "submit-order",
      targetAlias: "customer-erp",
      method: "POST",
      policy: "requires-approval",
      confirmed: true,
    }];
    input.approver = { kind: "owner", ownerAlias: "procurement-owner", confirmed: true };
    const result = compileAuthorityWizard(input);
    expect(result).toMatchObject({
      status: "review-required",
      authority: { writeAuthority: "denied", approvedWriteActions: [] },
      candidateAuthority: { writeAuthority: "per-action-approval", approvedWriteActions: [] },
      guardrails: { approverOwnerAlias: "procurement-owner" },
    });
  });

  it("fails closed when the existing envelope cannot represent mixed write policies", () => {
    const input = authorityAnswers();
    input.writes = [
      { actionName: "save-draft", targetAlias: "customer-erp", method: "POST", policy: "preauthorized", confirmed: true },
      { actionName: "submit-order", targetAlias: "customer-erp", method: "POST", policy: "requires-approval", confirmed: true },
    ];
    input.approver = { kind: "owner", ownerAlias: "procurement-owner", confirmed: true };
    const result = compileAuthorityWizard(input);
    expect(result.status).toBe("blocked");
    expect(result.authority).toEqual({
      allowedTargetAliases: [],
      allowedSecretAliases: [],
      allowedMethods: [],
      writeAuthority: "denied",
      approvedWriteActions: [],
    });
    expect(result.blockers).toContainEqual(expect.stringMatching(/mixed preauthorized/));
  });

  it("fails closed when a read is also explicitly forbidden", () => {
    const input = authorityAnswers();
    input.forbiddenActions.actionNames.push("read-order");
    const result = compileAuthorityWizard(input);
    expect(result.status).toBe("blocked");
    expect(result.candidateAuthority).toBeUndefined();
    expect(result.authority.writeAuthority).toBe("denied");
    expect(result.blockers).toContain("A read action is simultaneously allowed and forbidden.");
  });

  it("blocks a multi-target method Cartesian-product widening", () => {
    const input = authorityAnswers();
    input.systemsAndTargets.aliases = ["customer-erp", "customer-crm"];
    input.writes = [
      { actionName: "create-order", targetAlias: "customer-erp", method: "POST", policy: "preauthorized", confirmed: true },
      { actionName: "remove-draft", targetAlias: "customer-crm", method: "DELETE", policy: "preauthorized", confirmed: true },
    ];
    const result = compileAuthorityWizard(input);
    expect(result.status).toBe("blocked");
    expect(result.candidateAuthority).toBeUndefined();
    expect(result.authority.allowedMethods).toEqual([]);
    expect(result.blockers).toContainEqual(expect.stringMatching(/Cartesian product/));
    expect(result.blockers).toContainEqual(expect.stringMatching(/across multiple systems/));
    expect(result.guardrails.exactWriteRules).toHaveLength(2);
  });

  it("blocks read/write widening across multiple targets even with one write method", () => {
    const input = authorityAnswers();
    input.systemsAndTargets.aliases = ["customer-erp", "customer-crm"];
    input.readsAllowed.actions = [{ actionName: "read-contact", targetAlias: "customer-crm" }];
    input.writes = [{ actionName: "create-order", targetAlias: "customer-erp", method: "POST", policy: "preauthorized", confirmed: true }];
    const result = compileAuthorityWizard(input);
    expect(result.status).toBe("blocked");
    expect(result.candidateAuthority).toBeUndefined();
    expect(result.blockers).toContainEqual(expect.stringMatching(/exact targets across multiple systems/));
  });

  it("rejects omissions and credential-shaped values with zero authority", () => {
    const incomplete = structuredClone(authorityAnswers()) as unknown as Record<string, unknown>;
    delete incomplete.finalConsequentialReview;
    const missingResult = compileAuthorityWizard(incomplete);
    expect(missingResult.status).toBe("rejected");
    expect(missingResult.authority.writeAuthority).toBe("denied");
    expect(missingResult.authority.allowedTargetAliases).toEqual([]);

    const credential = authorityAnswers();
    credential.credentialAliases.aliases = ["sk-abcdefghijklmnop"];
    const credentialResult = compileAuthorityWizard(credential);
    expect(credentialResult.status).toBe("rejected");
    expect(credentialResult.validationErrors).toContainEqual(expect.stringMatching(/never credential-shaped values/));
  });

  it("rejects duplicate policy facts instead of silently deduplicating authority", () => {
    const duplicateTarget = authorityAnswers();
    duplicateTarget.systemsAndTargets.aliases.push("customer-erp");
    expect(compileAuthorityWizard(duplicateTarget)).toMatchObject({ status: "rejected", authority: { writeAuthority: "denied" } });

    const duplicateRead = authorityAnswers();
    duplicateRead.readsAllowed.actions.push({ actionName: "read-order", targetAlias: "customer-erp" });
    expect(compileAuthorityWizard(duplicateRead)).toMatchObject({ status: "rejected", authority: { writeAuthority: "denied" } });
  });
});
