import { createHash } from "node:crypto";
import { z } from "zod";
import { normalizeApprovedOpenApiMaterial, type ApprovedOpenApiNormalizationResult } from "./approved-openapi-normalizer.js";
import { proposeHttpBindings, type HttpBindingFactoryFacts, type HttpBindingFactoryResult } from "./http-binding-factory.js";
import type { ApprovedOpenApiMaterial } from "./onboarding-adapter-factory.js";
import type { StartOnboardingPreparationInput } from "./onboarding-preparation-workflow.js";
import { compileAuthorityWizard } from "./onboarding-verifier-authority.js";

export const ONBOARDING_CLEAN_PACKAGE_VERSION = "1.0" as const;

const identifier = z.string().min(2).max(180).regex(/^[a-zA-Z][a-zA-Z0-9_.-]+$/);
const kebab = z.string().min(3).max(160).regex(/^[a-z][a-z0-9-]+$/);
const bounded = z.string().trim().min(1).max(2_000);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/).refine((value) => !/^0+$/.test(value));
const timestamp = z.string().datetime({ offset: true });
const scalar = z.union([z.string().max(1_000), z.number().finite(), z.boolean()]);

const operation = z.object({
  driverId: identifier,
  sourceId: identifier,
  operationId: identifier,
  credentialAlias: identifier,
  path: z.string().min(2).max(500).regex(/^\/(?:[a-zA-Z0-9._~-]+\/?)+$/),
}).strict();

export const onboardingCleanPackageSchema = z.object({
  schemaVersion: z.literal(ONBOARDING_CLEAN_PACKAGE_VERSION),
  packageId: kebab,
  sessionId: identifier,
  tenantId: identifier,
  adapterId: kebab,
  adapterVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  targetAlias: identifier,
  serverUrl: z.string().url().max(1_000).refine((value) => /^https:\/\//.test(value), "Server URL must use HTTPS."),
  workflowId: kebab,
  summary: bounded,
  requiredOutcome: bounded,
  action: operation,
  observer: operation.extend({ queryName: identifier }).strict(),
  stableInputKey: identifier,
  conflictInputKey: identifier,
  workflowInput: z.record(identifier, scalar).refine(
    (value) => Object.keys(value).length === 3,
    "Compact package v1 requires exactly three bounded workflow fields for its fixed 21-decision review.",
  ),
  alternativeConflictValue: scalar,
  approvedDocument: z.object({
    localReference: z.string().min(3).max(1_000),
    approvedByAlias: identifier,
    approvedAt: timestamp,
    sourceOpenApiSha256: digestSchema,
    derivedOpenApiSha256: digestSchema,
  }).strict(),
}).strict().superRefine((value, context) => {
  const server = new URL(value.serverUrl);
  if (server.username || server.password || server.search || server.hash) {
    context.addIssue({ code: "custom", path: ["serverUrl"], message: "Server URL cannot embed credentials, query parameters, or fragments." });
  }
  if (!Object.hasOwn(value.workflowInput, value.stableInputKey)) context.addIssue({ code: "custom", path: ["stableInputKey"], message: "Stable input key must exist in workflow input." });
  if (!Object.hasOwn(value.workflowInput, value.conflictInputKey)) context.addIssue({ code: "custom", path: ["conflictInputKey"], message: "Conflict input key must exist in workflow input." });
  if (value.stableInputKey === value.conflictInputKey) context.addIssue({ code: "custom", path: ["conflictInputKey"], message: "Stable and conflict keys must be different." });
  if (value.action.driverId === value.observer.driverId || value.action.sourceId === value.observer.sourceId) context.addIssue({ code: "custom", path: ["observer"], message: "Action and observer drivers/sources must be distinct." });
  if (value.action.credentialAlias === value.observer.credentialAlias) context.addIssue({ code: "custom", path: ["observer", "credentialAlias"], message: "Observer credential alias must be separately scoped." });
  if (value.action.path !== value.observer.path) context.addIssue({ code: "custom", path: ["observer", "path"], message: "Compact v1 requires action and observer to share one reviewed collection path." });
  if (value.workflowInput[value.conflictInputKey] === value.alternativeConflictValue) context.addIssue({ code: "custom", path: ["alternativeConflictValue"], message: "Alternative conflict value must differ from the approved value." });
});

export type OnboardingCleanPackage = z.infer<typeof onboardingCleanPackageSchema>;

export interface OnboardingPackageDecision {
  index: number;
  key: string;
  question: string;
  answer: unknown;
  consequence: string;
  confirmationRequired: true;
}

export interface OnboardingCleanPackageDerivation {
  schemaVersion: typeof ONBOARDING_CLEAN_PACKAGE_VERSION;
  state: "preview-only";
  executionAuthorityEffect: "none";
  activationEffect: "none";
  package: OnboardingCleanPackage;
  packageDigest: string;
  decisionDigest: string;
  decisions: OnboardingPackageDecision[];
  intake: StartOnboardingPreparationInput;
  normalization: ApprovedOpenApiNormalizationResult;
  bindingFacts: HttpBindingFactoryFacts;
  bindingPreview: HttpBindingFactoryResult;
  artifactDigests: {
    approvedOpenApi: string;
    intake: string;
    normalization: string;
    bindingFacts: string;
    bindingPreview: string;
  };
  blockers: string[];
  metrics: {
    consequentialDecisions: 21;
    customerSpecificExecutableCodeLines: 0;
    confirmedFactCount: number;
    generatedActionDeclarationFields: number;
    generatedObserverDeclarationFields: number;
  };
  evidenceBoundary: string;
}

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function onboardingCleanPackageDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function openApiDocument(pkg: Omit<OnboardingCleanPackage, "approvedDocument"> | OnboardingCleanPackage): Record<string, unknown> {
  const properties = Object.fromEntries(Object.entries(pkg.workflowInput).map(([key, value]) => [key, { type: typeof value === "number" ? "integer" : typeof value === "boolean" ? "boolean" : "string" }]));
  const recordSchema = { type: "object", properties };
  return {
    openapi: "3.1.0",
    info: { title: `${pkg.packageId} approved compact API`, version: pkg.adapterVersion },
    servers: [{ url: pkg.serverUrl }],
    paths: {
      [pkg.action.path]: {
        post: {
          operationId: pkg.action.operationId,
          security: [{ [pkg.action.credentialAlias]: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: Object.keys(pkg.workflowInput), properties } } } },
          responses: { "201": { description: "Created" }, "400": { description: "Invalid input" }, "409": { description: "Conflict" } },
        },
        get: {
          operationId: pkg.observer.operationId,
          security: [{ [pkg.observer.credentialAlias]: [] }],
          parameters: [{ name: pkg.observer.queryName, in: "query", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "Matches",
              content: { "application/json": { schema: { type: "object", properties: { items: { type: "array", items: recordSchema }, server_time: { type: "string", format: "date-time" }, collateral_clean: { type: "boolean" } } } } },
            },
            "400": { description: "Invalid filter" },
          },
        },
      },
    },
    components: { securitySchemes: { [pkg.action.credentialAlias]: { type: "http", scheme: "bearer" }, [pkg.observer.credentialAlias]: { type: "http", scheme: "bearer" } } },
  };
}

export function derivedOpenApiDigestForCleanPackage(pkg: Omit<OnboardingCleanPackage, "approvedDocument"> | OnboardingCleanPackage): string {
  return onboardingCleanPackageDigest(openApiDocument(pkg));
}

function authority(pkg: OnboardingCleanPackage) {
  return {
    schemaVersion: "1.0" as const,
    systemsAndTargets: { aliases: [pkg.targetAlias], confirmed: true as const },
    credentialAliases: { aliases: [pkg.action.credentialAlias, pkg.observer.credentialAlias], confirmed: true as const },
    readsAllowed: { actions: [{ actionName: pkg.observer.operationId, targetAlias: pkg.targetAlias }], confirmed: true as const },
    writes: [{ actionName: pkg.action.operationId, targetAlias: pkg.targetAlias, method: "POST" as const, policy: "preauthorized" as const, confirmed: true as const }],
    limits: { monetary: { kind: "none" as const, confirmed: true as const }, quantityPerAction: { kind: "limit" as const, maximum: 1, confirmed: true as const }, actionsPerHour: { kind: "limit" as const, maximum: 20, confirmed: true as const } },
    forbiddenActions: { actionNames: [], confirmed: true as const }, approver: { kind: "not-required" as const, confirmed: true as const },
    retryAndReconciliation: { reconcileBeforeRetry: true as const, blindRetryAllowed: false as const, maximumAttempts: 1, confirmed: true as const }, finalConsequentialReview: { confirmed: true as const },
  };
}

function decisions(pkg: OnboardingCleanPackage): OnboardingPackageDecision[] {
  const base: Array<[string, string, unknown, string]> = [
    ["target", "Which bounded system may this package address?", pkg.targetAlias, "Restricts every generated operation to one target alias."],
    ["server", "Which approved HTTPS server may the local runtime address?", pkg.serverUrl, "Pins action and observation transports to one reviewed server."],
    ["workflow", "Which ordinary workflow is being enabled?", pkg.workflowId, "Prevents the package from silently widening into other workflows."],
    ["outcome", "What externally observable result counts as complete?", pkg.requiredOutcome, "Defines completion independently of an action response."],
    ["action-operation", "Which exact write operation may be compiled?", pkg.action.operationId, "Selects one documented POST operation."],
    ["observer-operation", "Which exact read operation independently observes state?", pkg.observer.operationId, "Separates external proof from execution."],
    ["action-credential", "Which customer-local alias resolves write access?", pkg.action.credentialAlias, "Names but never contains the write credential."],
    ["observer-credential", "Which separate alias resolves observer access?", pkg.observer.credentialAlias, "Requires separately scoped read-side authentication."],
    ["write-authority", "Is this exact bounded write preauthorized after runtime grant checks?", "preauthorized", "Does not itself grant a runtime execution token."],
    ["quantity-limit", "What is the maximum quantity per action?", 1, "Caps one consequential action unit."],
    ["rate-limit", "How many actions per hour may the authority contract allow?", 20, "Caps local action rate."],
    ["retry", "May the runtime retry before independent reconciliation?", "reconcile-before-retry; blind retry forbidden", "Prevents duplicate writes after uncertain transport outcomes."],
    ["freshness", "How fresh must independent observation be?", "server timestamp within 30 seconds after trusted operation start", "Rejects stale state as proof."],
    ["duplicate-check", "Which key proves there is exactly one result?", pkg.stableInputKey, "Detects duplicates using a pre-action stable identifier."],
    ["collateral-check", "What collateral invariant must remain true?", "collateral_clean = true", "Rejects unintended external changes."],
  ];
  for (const key of Object.keys(pkg.workflowInput)) base.push([`map-${key}`, `Where does approved input ${key} map?`, `workflowInput.${key} → JSON body ${key}`, "Creates one identity-only request mapping."]);
  for (const key of Object.keys(pkg.workflowInput)) base.push([`verify-${key}`, `How is ${key} checked after action?`, `observer.items[0].${key} equals workflowInput.${key}`, "Requires the independent observer to match the intended value."]);
  if (base.length !== 21) throw new Error(`Compact package v1 requires exactly three workflow fields so the fixed review has 21 decisions; received ${base.length}.`);
  return base.map(([key, question, answer, consequence], index) => ({ index: index + 1, key, question, answer, consequence, confirmationRequired: true }));
}

export function deriveOnboardingCleanPackage(raw: unknown): OnboardingCleanPackageDerivation {
  const pkg = onboardingCleanPackageSchema.parse(raw);
  const derivedDocument = openApiDocument(pkg);
  const approvedOpenApiDigest = onboardingCleanPackageDigest(derivedDocument);
  if (approvedOpenApiDigest !== pkg.approvedDocument.derivedOpenApiSha256) throw new Error("Approved compact document provenance digest does not match the deterministically derived OpenAPI document.");
  const material: ApprovedOpenApiMaterial = { kind: "openapi", materialId: `${pkg.packageId}-openapi`, localReference: pkg.approvedDocument.localReference, approved: true, targetAlias: pkg.targetAlias, document: derivedDocument as any };
  const first = normalizeApprovedOpenApiMaterial(material);
  const normalization = normalizeApprovedOpenApiMaterial(material, { materialDigest: first.originalMaterialDigest, selectedUrl: pkg.serverUrl, confirmedByAlias: pkg.approvedDocument.approvedByAlias, confirmedAt: pkg.approvedDocument.approvedAt });
  const bindingFacts: HttpBindingFactoryFacts = {
    targetAlias: pkg.targetAlias, ordinaryBusinessOutcome: pkg.requiredOutcome, outcomeConfirmed: true,
    action: { driverId: pkg.action.driverId, operationId: pkg.action.operationId, operationConfirmed: true, credentialAlias: pkg.action.credentialAlias, requestMappings: Object.keys(pkg.workflowInput).map((key) => ({ source: { kind: "workflow-input", inputKey: key, confirmed: true }, destination: { location: "json-body", path: [key] }, transform: "identity", confirmed: true })), requestMappingsConfirmed: true, reconcileBeforeRetry: true, blindRetryAllowed: false },
    observer: { driverId: pkg.observer.driverId, sourceId: pkg.observer.sourceId, operationId: pkg.observer.operationId, operationConfirmed: true, credentialAlias: pkg.observer.credentialAlias, independentlyAuthenticated: true, independentFromActionDriver: true, parameterBindings: [{ name: pkg.observer.queryName, location: "query", source: { kind: "workflow-input", inputKey: pkg.stableInputKey, confirmed: true }, purpose: "stable-identifier", confirmed: true }], resultPath: ["items"], resultPathConfirmed: true, pagination: { kind: "not-paginated", confirmed: true }, freshness: { kind: "server-timestamp-body", path: ["server_time"], maximumAgeSeconds: 30, confirmed: true } },
    outcome: { predicates: [{ key: "exactly-one", path: ["items"], operator: "count-equals", expectedCount: 1, confirmed: true }, ...Object.keys(pkg.workflowInput).map((key) => ({ key: `matches-${key}`, path: ["items", 0, key], operator: "equals-input" as const, inputKey: key, confirmed: true as const }))], duplicateCheck: { collectionPath: ["items"], uniqueKeyPath: [pkg.stableInputKey], expectedCount: 1, confirmed: true }, collateralChecks: [{ key: "collateral-clean", path: ["collateral_clean"], operator: "equals-confirmed", expected: true, confirmed: true }], notStartedDefinition: [{ key: "no-match", path: ["items"], operator: "count-equals", expectedCount: 0, confirmed: true }], confirmed: true },
  };
  const intake: StartOnboardingPreparationInput = {
    schemaVersion: "1.0", sessionId: pkg.sessionId, tenantId: pkg.tenantId, adapterId: pkg.adapterId, adapterVersion: pkg.adapterVersion, executionDriverId: pkg.action.driverId, duplicatePrevention: "both", resetStrategy: { kind: "fixture-reset", reference: `package://${pkg.packageId}/reset`, independentlyChecked: true }, persistence: { durableJobStore: true, durableCapabilityRegistry: true },
    adapter: { schemaVersion: "1.0", workflow: { workflowId: pkg.workflowId, summary: pkg.summary, requiredOutcome: pkg.requiredOutcome, approvedTargetAliases: [pkg.targetAlias], requestedOperationNames: [pkg.observer.operationId, pkg.action.operationId], customerConfirmed: true }, materials: [material] },
    verifier: { schemaVersion: "1.0", outcomeKey: `${pkg.packageId}-outcome`, ordinaryBusinessOutcome: pkg.requiredOutcome, executionDriverId: pkg.action.driverId, successCriteria: [{ key: "exactly-one", observationKey: "items", path: [], operator: "count-equals", expected: 1 }], duplicateCheck: { observationKey: "items", path: [], expectedCount: 1 }, collateralEffectCountObservationKey: "incorrect-effects", freshness: { maximumAgeSeconds: 30, observedAtKey: "observed-at", notBeforeBoundary: "trusted-operation-start", boundaryConfirmed: true }, observationSurfaces: [{ key: `${pkg.packageId}-read-model`, sourceId: pkg.observer.sourceId, description: "Separately authenticated approved compact-package read model.", sourceKind: "read-model", observationKeys: ["items", "incorrect-effects", "observed-at"], approvedForThisOutcome: true, independentFromExecution: true, independenceConfirmed: true, supportsFreshnessBoundary: true }] },
    authority: authority(pkg),
  };
  const authorityCompilation = compileAuthorityWizard(intake.authority);
  const bindingPreview = proposeHttpBindings({ schemaVersion: "1.0", normalization, authorityCompilation, facts: bindingFacts });
  const decisionList = decisions(pkg);
  const blockers = [...new Set([...normalization.blockers, ...bindingPreview.blockers.map((item) => item.blockerId), ...bindingPreview.engineeringWorkRemaining])].sort();
  return {
    schemaVersion: ONBOARDING_CLEAN_PACKAGE_VERSION, state: "preview-only", executionAuthorityEffect: "none", activationEffect: "none", package: structuredClone(pkg), packageDigest: onboardingCleanPackageDigest(pkg), decisionDigest: onboardingCleanPackageDigest(decisionList), decisions: decisionList, intake, normalization, bindingFacts, bindingPreview,
    artifactDigests: { approvedOpenApi: approvedOpenApiDigest, intake: onboardingCleanPackageDigest(intake), normalization: onboardingCleanPackageDigest(normalization), bindingFacts: onboardingCleanPackageDigest(bindingFacts), bindingPreview: bindingPreview.resultDigest },
    blockers,
    metrics: { consequentialDecisions: 21, customerSpecificExecutableCodeLines: 0, confirmedFactCount: bindingPreview.automationMetrics.confirmedFactCount, generatedActionDeclarationFields: bindingPreview.automationMetrics.generatedActionDeclarationFields, generatedObserverDeclarationFields: bindingPreview.automationMetrics.generatedObserverDeclarationFields },
    evidenceBoundary: "This is a non-authorizing deterministic preview. Import, review, compilation, acceptance and activation remain separate gates; no customer or production evidence is created.",
  };
}

export function projectOnboardingCleanPackagePreview(derivation: OnboardingCleanPackageDerivation): unknown {
  return {
    schemaVersion: derivation.schemaVersion, state: derivation.state, executionAuthorityEffect: derivation.executionAuthorityEffect, activationEffect: derivation.activationEffect,
    identity: { packageId: derivation.package.packageId, tenantId: derivation.package.tenantId, sessionId: derivation.package.sessionId, adapterId: derivation.package.adapterId, adapterVersion: derivation.package.adapterVersion },
    provenance: { localReference: derivation.package.approvedDocument.localReference, approvedByAlias: derivation.package.approvedDocument.approvedByAlias, approvedAt: derivation.package.approvedDocument.approvedAt, sourceOpenApiSha256: derivation.package.approvedDocument.sourceOpenApiSha256, derivedOpenApiSha256: derivation.artifactDigests.approvedOpenApi },
    packageDigest: derivation.packageDigest, decisionDigest: derivation.decisionDigest, decisions: derivation.decisions, artifactDigests: derivation.artifactDigests, blockers: derivation.blockers, metrics: derivation.metrics, evidenceBoundary: derivation.evidenceBoundary,
  };
}
