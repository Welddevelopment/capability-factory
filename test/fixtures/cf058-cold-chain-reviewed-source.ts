import { readFileSync } from "node:fs";
import {
  normalizeApprovedOpenApiMaterial,
  type ApprovedOpenApiNormalizationResult,
} from "../../src/product/approved-openapi-normalizer.js";
import {
  proposeHttpBindings,
  type HttpBindingFactoryFacts,
  type HttpBindingFactoryResult,
} from "../../src/product/http-binding-factory.js";
import type { ApprovedOpenApiMaterial } from "../../src/product/onboarding-adapter-factory.js";
import {
  compileAuthorityWizard,
  type AuthorityWizardAnswers,
  type AuthorityWizardCompilation,
} from "../../src/product/onboarding-verifier-authority.js";

export const CF058_COLD_CHAIN_REVIEWED_AT = "2026-08-14T11:00:00.000Z";
export const CF058_COLD_CHAIN_ACTION_SERVER_URL = "https://localhost:9443";
export const CF058_COLD_CHAIN_OBSERVER_SERVER_URL = "https://localhost:9444";
/** Compatibility name for the primary/action normalization. */
export const CF058_COLD_CHAIN_SERVER_URL = CF058_COLD_CHAIN_ACTION_SERVER_URL;
export const CF058_COLD_CHAIN_TARGET_ALIAS = "cf058_cold_chain_sandbox";
export const CF058_COLD_CHAIN_ACTION_DRIVER = "cf058_quarantine_action_driver";
export const CF058_COLD_CHAIN_OBSERVER_DRIVER = "cf058_compliance_audit_driver";
export const CF058_COLD_CHAIN_OBSERVER_SOURCE = "cf058_compliance_audit_source";
export const CF058_COLD_CHAIN_ACTION_CREDENTIAL_ALIAS = "cf058ActionBearer";
export const CF058_COLD_CHAIN_OBSERVER_CREDENTIAL_ALIAS = "cf058ObserverBearer";

export const CF058_COLD_CHAIN_ACTION_OPERATION = "putQuarantineDirective";
export const CF058_COLD_CHAIN_PROBE_OPERATION = "probeQuarantineDirective";
export const CF058_COLD_CHAIN_RECONCILIATION_OPERATION = "readQuarantineDirective";
export const CF058_COLD_CHAIN_OBSERVER_OPERATION = "auditQuarantineDirective";
export const CF058_COLD_CHAIN_ACTION_PATH = "/v2/lots/{lot_code}/quarantine-directives/{directive_ref}";
export const CF058_COLD_CHAIN_OBSERVER_PATH = "/v2/compliance-audit/quarantine-directives";

function approvedDocument(): ApprovedOpenApiMaterial["document"] {
  return JSON.parse(readFileSync(new URL("./cf058-cold-chain/openapi.json", import.meta.url), "utf8")) as ApprovedOpenApiMaterial["document"];
}

function approvedObserverDocument(): ApprovedOpenApiMaterial["document"] {
  return JSON.parse(readFileSync(new URL("./cf058-cold-chain/observer-openapi.json", import.meta.url), "utf8")) as ApprovedOpenApiMaterial["document"];
}

/**
 * Static, explicitly approved local material only. The localhost URL is a
 * reviewed fixture identity, not evidence that a provider is running.
 */
export function cf058ColdChainApprovedOpenApi(): ApprovedOpenApiMaterial {
  return {
    kind: "openapi",
    materialId: "cf058_cold_chain_quarantine_v1",
    localReference: "test/fixtures/cf058-cold-chain/openapi.json",
    approved: true,
    targetAlias: CF058_COLD_CHAIN_TARGET_ALIAS,
    document: approvedDocument(),
  };
}

export function cf058ColdChainApprovedObserverOpenApi(): ApprovedOpenApiMaterial {
  return {
    kind: "openapi",
    materialId: "cf058_cold_chain_compliance_audit_v1",
    localReference: "test/fixtures/cf058-cold-chain/observer-openapi.json",
    approved: true,
    targetAlias: CF058_COLD_CHAIN_TARGET_ALIAS,
    document: approvedObserverDocument(),
  };
}

export function cf058ColdChainAuthorityAnswers(): AuthorityWizardAnswers {
  return {
    schemaVersion: "1.0",
    systemsAndTargets: { aliases: [CF058_COLD_CHAIN_TARGET_ALIAS], confirmed: true },
    credentialAliases: {
      aliases: [
        CF058_COLD_CHAIN_ACTION_CREDENTIAL_ALIAS,
        CF058_COLD_CHAIN_OBSERVER_CREDENTIAL_ALIAS,
      ],
      confirmed: true,
    },
    readsAllowed: {
      actions: [
        { actionName: CF058_COLD_CHAIN_PROBE_OPERATION, targetAlias: CF058_COLD_CHAIN_TARGET_ALIAS },
        { actionName: CF058_COLD_CHAIN_RECONCILIATION_OPERATION, targetAlias: CF058_COLD_CHAIN_TARGET_ALIAS },
        { actionName: CF058_COLD_CHAIN_OBSERVER_OPERATION, targetAlias: CF058_COLD_CHAIN_TARGET_ALIAS },
      ],
      confirmed: true,
    },
    writes: [{
      actionName: CF058_COLD_CHAIN_ACTION_OPERATION,
      targetAlias: CF058_COLD_CHAIN_TARGET_ALIAS,
      method: "PUT",
      policy: "preauthorized",
      confirmed: true,
    }],
    limits: {
      monetary: { kind: "none", confirmed: true },
      quantityPerAction: { kind: "limit", maximum: 500, confirmed: true },
      actionsPerHour: { kind: "limit", maximum: 60, confirmed: true },
    },
    forbiddenActions: {
      actionNames: ["deleteQuarantineDirective", "releaseQuarantineDirective"],
      confirmed: true,
    },
    approver: { kind: "not-required", confirmed: true },
    retryAndReconciliation: {
      reconcileBeforeRetry: true,
      blindRetryAllowed: false,
      maximumAttempts: 2,
      confirmed: true,
    },
    finalConsequentialReview: { confirmed: true },
  };
}

export function cf058ColdChainBindingFacts(): HttpBindingFactoryFacts {
  return {
    targetAlias: CF058_COLD_CHAIN_TARGET_ALIAS,
    ordinaryBusinessOutcome: "Exactly one quarantine directive exists for the confirmed lot and directive reference, with no collateral directive changes.",
    outcomeConfirmed: true,
    action: {
      driverId: CF058_COLD_CHAIN_ACTION_DRIVER,
      operationId: CF058_COLD_CHAIN_ACTION_OPERATION,
      operationConfirmed: true,
      credentialAlias: CF058_COLD_CHAIN_ACTION_CREDENTIAL_ALIAS,
      requestMappings: [
        {
          source: { kind: "workflow-input", inputKey: "lot_code", confirmed: true },
          destination: { location: "path", name: "lot_code" },
          transform: "identity",
          confirmed: true,
        },
        {
          source: { kind: "workflow-input", inputKey: "directive_ref", confirmed: true },
          destination: { location: "path", name: "directive_ref" },
          transform: "identity",
          confirmed: true,
        },
        {
          source: { kind: "workflow-input", inputKey: "hold_quantity", confirmed: true },
          destination: { location: "json-body", path: ["hold_quantity"] },
          transform: "identity",
          confirmed: true,
        },
        {
          source: { kind: "workflow-input", inputKey: "reason_confirmed", confirmed: true },
          destination: { location: "json-body", path: ["reason_confirmed"] },
          transform: "identity",
          confirmed: true,
        },
      ],
      requestMappingsConfirmed: true,
      reconcileBeforeRetry: true,
      blindRetryAllowed: false,
    },
    observer: {
      driverId: CF058_COLD_CHAIN_OBSERVER_DRIVER,
      sourceId: CF058_COLD_CHAIN_OBSERVER_SOURCE,
      operationId: CF058_COLD_CHAIN_OBSERVER_OPERATION,
      operationConfirmed: true,
      credentialAlias: CF058_COLD_CHAIN_OBSERVER_CREDENTIAL_ALIAS,
      independentlyAuthenticated: true,
      independentFromActionDriver: true,
      parameterBindings: [{
        name: "directive_ref",
        location: "query",
        source: { kind: "workflow-input", inputKey: "directive_ref", confirmed: true },
        purpose: "stable-identifier",
        confirmed: true,
      }],
      resultPath: ["items"],
      resultPathConfirmed: true,
      pagination: { kind: "not-paginated", confirmed: true },
      freshness: {
        kind: "server-timestamp-body",
        path: ["server_time"],
        maximumAgeSeconds: 30,
        confirmed: true,
      },
    },
    outcome: {
      predicates: [
        { key: "one-directive", path: ["items"], operator: "count-equals", expectedCount: 1, confirmed: true },
        { key: "same-directive-reference", path: ["items", 0, "directive_ref"], operator: "equals-input", inputKey: "directive_ref", confirmed: true },
        { key: "same-lot", path: ["items", 0, "lot_code"], operator: "equals-input", inputKey: "lot_code", confirmed: true },
        { key: "same-hold-quantity", path: ["items", 0, "hold_quantity"], operator: "equals-input", inputKey: "hold_quantity", confirmed: true },
        { key: "same-confirmed-reason", path: ["items", 0, "reason_confirmed"], operator: "equals-input", inputKey: "reason_confirmed", confirmed: true },
        { key: "quarantined-status", path: ["items", 0, "status"], operator: "equals-confirmed", expected: "quarantined", confirmed: true },
      ],
      duplicateCheck: {
        collectionPath: ["items"],
        uniqueKeyPath: ["directive_ref"],
        expectedCount: 1,
        confirmed: true,
      },
      collateralChecks: [{
        key: "collateral-clean",
        path: ["collateral_clean"],
        operator: "equals-confirmed",
        expected: true,
        confirmed: true,
      }],
      notStartedDefinition: [{
        key: "no-directive",
        path: ["items"],
        operator: "count-equals",
        expectedCount: 0,
        confirmed: true,
      }],
      confirmed: true,
    },
  };
}

export interface Cf058ColdChainReviewedSource {
  material: ApprovedOpenApiMaterial;
  observerMaterial: ApprovedOpenApiMaterial;
  normalization: ApprovedOpenApiNormalizationResult;
  observerNormalization: ApprovedOpenApiNormalizationResult;
  authorityAnswers: AuthorityWizardAnswers;
  authorityCompilation: AuthorityWizardCompilation;
  bindingFacts: HttpBindingFactoryFacts;
  factoryResult: HttpBindingFactoryResult;
}

export function cf058ColdChainReviewedSource(): Cf058ColdChainReviewedSource {
  const material = cf058ColdChainApprovedOpenApi();
  const observerMaterial = cf058ColdChainApprovedObserverOpenApi();
  const unconfirmed = normalizeApprovedOpenApiMaterial(material);
  const unconfirmedObserver = normalizeApprovedOpenApiMaterial(observerMaterial);
  const normalization = normalizeApprovedOpenApiMaterial(material, {
    materialDigest: unconfirmed.originalMaterialDigest,
    selectedUrl: CF058_COLD_CHAIN_SERVER_URL,
    confirmedByAlias: "cf058FixtureEngineer",
    confirmedAt: CF058_COLD_CHAIN_REVIEWED_AT,
  });
  const observerNormalization = normalizeApprovedOpenApiMaterial(observerMaterial, {
    materialDigest: unconfirmedObserver.originalMaterialDigest,
    selectedUrl: CF058_COLD_CHAIN_OBSERVER_SERVER_URL,
    confirmedByAlias: "cf058FixtureEngineer",
    confirmedAt: CF058_COLD_CHAIN_REVIEWED_AT,
  });
  const authorityAnswers = cf058ColdChainAuthorityAnswers();
  const authorityCompilation = compileAuthorityWizard(authorityAnswers);
  const bindingFacts = cf058ColdChainBindingFacts();
  const factoryResult = proposeHttpBindings({
    schemaVersion: "1.0",
    normalization,
    observerNormalization,
    authorityCompilation,
    facts: bindingFacts,
  });
  if (normalization.status !== "review-required" || observerNormalization.status !== "review-required" || factoryResult.status !== "review-required" || !factoryResult.actionBinding || !factoryResult.observerBinding) {
    throw new Error("CF-058 cold-chain source did not produce two clean reviewed HTTP declarations.");
  }
  return { material, observerMaterial, normalization, observerNormalization, authorityAnswers, authorityCompilation, bindingFacts, factoryResult };
}
