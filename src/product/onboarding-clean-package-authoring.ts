import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { normalizeApprovedOpenApiMaterial, type ApprovedOpenApiNormalizationResult } from "./approved-openapi-normalizer.js";
import type { AdapterFactStatus, ApprovedOpenApiMaterial, JsonValue } from "./onboarding-adapter-factory.js";
import {
  derivedOpenApiDigestForCleanPackage,
  onboardingCleanPackageSchema,
  type OnboardingCleanPackage,
} from "./onboarding-clean-package.js";

export const ONBOARDING_CLEAN_PACKAGE_AUTHORING_VERSION = "1.0" as const;

const identifier = z.string().min(2).max(180).regex(/^[a-zA-Z][a-zA-Z0-9_.-]+$/);
const kebab = z.string().min(3).max(160).regex(/^[a-z][a-z0-9-]+$/);
const timestamp = z.string().datetime({ offset: true });
const bounded = z.string().trim().min(1).max(2_000);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const scalar = z.union([z.string().max(1_000), z.number().finite(), z.boolean()]);
const secretShaped = /(?:bearer\s+[a-z0-9._~+\/-]{8,}|sk-[a-z0-9_-]{12,}|password\s*[:=]|(?:api[_ -]?key|client[_ -]?secret|access[_ -]?token)\s*[:=]\s*["']?[^\s"']{6,}|https?:\/\/[^\s/:]+:[^\s/@]+@|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i;

export const cleanPackageAuthoringInputSchema = z.object({
  schemaVersion: z.literal(ONBOARDING_CLEAN_PACKAGE_AUTHORING_VERSION),
  authoringSessionId: identifier,
  tenantId: identifier,
  packageIdentity: z.object({
    packageId: kebab,
    packageSessionId: identifier,
    adapterId: kebab,
    adapterVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  }).strict(),
  approvedMaterial: z.object({
    kind: z.literal("openapi"),
    materialId: identifier,
    localReference: z.string().min(3).max(1_000),
    approved: z.literal(true),
    targetAlias: identifier,
    approvedByAlias: identifier,
    approvedAt: timestamp,
    document: z.unknown(),
  }).strict(),
  selection: z.object({
    serverUrl: z.string().url().max(1_000),
    actionOperationId: identifier,
    observerOperationId: identifier,
    actionCredentialAlias: identifier,
    observerCredentialAlias: identifier,
  }).strict(),
  workflow: z.object({
    workflowId: kebab,
    summary: bounded,
    requiredOutcome: bounded,
    customerConfirmed: z.literal(true),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.selection.actionOperationId === value.selection.observerOperationId) {
    context.addIssue({ code: "custom", path: ["selection", "observerOperationId"], message: "Action and observer operations must be distinct." });
  }
  if (value.selection.actionCredentialAlias === value.selection.observerCredentialAlias) {
    context.addIssue({ code: "custom", path: ["selection", "observerCredentialAlias"], message: "Action and observer credential aliases must be separately scoped." });
  }
  if (value.authoringSessionId === value.packageIdentity.packageSessionId) {
    context.addIssue({ code: "custom", path: ["packageIdentity", "packageSessionId"], message: "Authoring and package sessions must have distinct identities." });
  }
});

export type CleanPackageAuthoringInput = z.infer<typeof cleanPackageAuthoringInputSchema>;

export const cleanPackageAuthoringAnswerSubmissionSchema = z.object({
  schemaVersion: z.literal(ONBOARDING_CLEAN_PACKAGE_AUTHORING_VERSION),
  submissionId: identifier,
  authoringSessionId: identifier,
  expectedRevision: z.number().int().positive(),
  expectedSnapshotDigest: digestSchema,
  answeredByAlias: identifier,
  answeredAt: timestamp,
  answers: z.array(z.object({
    questionId: identifier,
    explicitlyConfirmed: z.literal(true),
    value: z.unknown(),
  }).strict()).min(1).max(64),
}).strict();

export type CleanPackageAuthoringAnswerSubmission = z.infer<typeof cleanPackageAuthoringAnswerSubmissionSchema>;

export interface CleanPackageAuthoringProvenance {
  source: "approved-openapi" | "selected-input" | "authoring-policy" | "explicit-answer";
  pointer: string;
  sha256: string;
}

export interface CleanPackageAuthoringFact {
  key: string;
  value?: unknown;
  status: AdapterFactStatus;
  provenance: CleanPackageAuthoringProvenance[];
  explanation: string;
  questionId?: string;
}

export interface CleanPackageAuthoringQuestion {
  questionId: string;
  factKey: string;
  prompt: string;
  consequence: string;
  answerKind: "identifier" | "scalar" | "boolean" | "integer" | "enum" | "empty-list";
  options?: unknown[];
  expectedLiteral?: unknown;
  valueType?: "string" | "integer" | "number" | "boolean";
  answerStatus: "unanswered" | "customer-confirmed";
  confirmedValue?: unknown;
  confirmedByAlias?: string;
  confirmedAt?: string;
}

export interface CleanPackageAuthoringSnapshot {
  schemaVersion: typeof ONBOARDING_CLEAN_PACKAGE_AUTHORING_VERSION;
  authoringSessionId: string;
  tenantId: string;
  packageSessionId: string;
  revision: number;
  status: "unsupported" | "questions-required" | "package-draft-ready";
  executionAuthorityEffect: "none";
  activationEffect: "none";
  sourceInputDigest: string;
  sourceDocumentDigest: string;
  normalizationReceiptDigest?: string;
  facts: CleanPackageAuthoringFact[];
  questions: CleanPackageAuthoringQuestion[];
  blockers: string[];
  engineeringWorkRemaining: string[];
  packageDraft?: OnboardingCleanPackage;
  metrics: {
    extractedFieldCount: number;
    confirmationQuestionCount: number;
    explicitDecisionCount: number;
    unresolvedQuestionCount: number;
    packageSpecificExecutableCodeLines: 0;
  };
  evidenceBoundary: string;
  createdAt: string;
  updatedAt: string;
  snapshotDigest: string;
}

interface AnswerRecord {
  value: unknown;
  answeredByAlias: string;
  answeredAt: string;
}

interface SupportedShape {
  normalization: ApprovedOpenApiNormalizationResult;
  sourceDocumentDigest: string;
  action: { operationId: string; method: "POST"; path: string; credentialAlias: string };
  observer: { operationId: string; method: "GET"; path: string; credentialAlias: string; queryNames: string[] };
  bodyFields: Array<{ key: string; type: "string" | "integer" | "number" | "boolean" }>;
  resultPath: "items";
  freshnessPath: "server_time";
  collateralPath: "collateral_clean";
}

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function cleanPackageAuthoringDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function evidence(source: CleanPackageAuthoringProvenance["source"], pointer: string, value: unknown): CleanPackageAuthoringProvenance {
  return { source, pointer, sha256: cleanPackageAuthoringDigest(value) };
}

function operationRecord(document: Record<string, unknown>, operationId: string): { method: string; path: string; operation: Record<string, unknown>; pathItem: Record<string, unknown> } | undefined {
  const paths = optionalRecord(document.paths);
  for (const [path, rawPathItem] of Object.entries(paths)) {
    const pathItem = optionalRecord(rawPathItem);
    for (const method of ["get", "post", "put", "patch", "delete", "head", "options", "trace"]) {
      const operation = optionalRecord(pathItem[method]);
      if (operation.operationId === operationId) return { method: method.toUpperCase(), path, operation, pathItem };
    }
  }
  return undefined;
}

function securityAliases(operation: Record<string, unknown>, document: Record<string, unknown>): string[] {
  const raw = Array.isArray(operation.security) ? operation.security : Array.isArray(document.security) ? document.security : [];
  return [...new Set(raw.flatMap((item) => item && typeof item === "object" && !Array.isArray(item) ? Object.keys(item as Record<string, unknown>) : []))].sort();
}

function jsonSchema(operation: Record<string, unknown>): Record<string, unknown> {
  const requestBody = optionalRecord(operation.requestBody);
  const content = optionalRecord(requestBody.content);
  const media = optionalRecord(content["application/json"]);
  return optionalRecord(media.schema);
}

function responseSchema(operation: Record<string, unknown>): Record<string, unknown> {
  const responses = optionalRecord(operation.responses);
  const response = optionalRecord(responses["200"] ?? responses["201"]);
  const content = optionalRecord(response.content);
  return optionalRecord(optionalRecord(content["application/json"]).schema);
}

function queryNames(pathItem: Record<string, unknown>, operation: Record<string, unknown>): string[] {
  const parameters = [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : []),
  ];
  return [...new Set(parameters.flatMap((item) => {
    const parameter = optionalRecord(item);
    return parameter.in === "query" && typeof parameter.name === "string" ? [parameter.name] : [];
  }))].sort();
}

function inspectSupportedShape(input: CleanPackageAuthoringInput): { shape?: SupportedShape; blockers: string[] } {
  if (secretShaped.test(canonical(input))) throw new Error("Clean-package authoring source contains credential-shaped material; aliases only are allowed.");
  const material: ApprovedOpenApiMaterial = {
    kind: "openapi",
    materialId: input.approvedMaterial.materialId,
    localReference: input.approvedMaterial.localReference,
    approved: true,
    targetAlias: input.approvedMaterial.targetAlias,
    document: input.approvedMaterial.document as JsonValue,
  };
  const initial = normalizeApprovedOpenApiMaterial(material);
  const normalization = normalizeApprovedOpenApiMaterial(material, {
    materialDigest: initial.originalMaterialDigest,
    selectedUrl: input.selection.serverUrl,
    confirmedByAlias: input.approvedMaterial.approvedByAlias,
    confirmedAt: input.approvedMaterial.approvedAt,
  });
  const document = record(normalization.normalizedMaterial.document, "Normalized OpenAPI document");
  const action = operationRecord(document, input.selection.actionOperationId);
  const observer = operationRecord(document, input.selection.observerOperationId);
  const blockers: string[] = [];
  if (!action) blockers.push(`selected-action-unavailable:${input.selection.actionOperationId}`);
  if (!observer) blockers.push(`selected-observer-unavailable:${input.selection.observerOperationId}`);
  if (action && action.method !== "POST") blockers.push(`unsupported-action-method:${action.method}`);
  if (observer && observer.method !== "GET") blockers.push(`unsupported-observer-method:${observer.method}`);
  if (action && observer && action.path !== observer.path) blockers.push("action-observer-collection-path-mismatch");
  if (action && !securityAliases(action.operation, document).includes(input.selection.actionCredentialAlias)) blockers.push("selected-action-credential-not-documented");
  if (observer && !securityAliases(observer.operation, document).includes(input.selection.observerCredentialAlias)) blockers.push("selected-observer-credential-not-documented");

  const body = action ? jsonSchema(action.operation) : {};
  const properties = optionalRecord(body.properties);
  const required = Array.isArray(body.required) ? body.required.filter((item): item is string => typeof item === "string") : [];
  const bodyFields: SupportedShape["bodyFields"] = Object.entries(properties).flatMap(([key, value]) => {
    const type = optionalRecord(value).type;
    return type === "string" || type === "integer" || type === "number" || type === "boolean"
      ? [{ key, type: type as SupportedShape["bodyFields"][number]["type"] }]
      : [];
  });
  if (body.type !== "object" || bodyFields.length !== 3 || Object.keys(properties).length !== 3 || required.length !== 3 || !bodyFields.every((field) => required.includes(field.key))) {
    blockers.push("compact-v1-requires-three-required-primitive-body-fields");
  }

  const observed = observer ? responseSchema(observer.operation) : {};
  const observedProperties = optionalRecord(observed.properties);
  const items = optionalRecord(observedProperties.items);
  const itemSchema = optionalRecord(items.items);
  const itemProperties = optionalRecord(itemSchema.properties);
  if (observed.type !== "object" || items.type !== "array" || itemSchema.type !== "object" || bodyFields.some((field) => !Object.hasOwn(itemProperties, field.key))) {
    blockers.push("observer-does-not-expose-matching-items-collection");
  }
  if (optionalRecord(observedProperties.server_time).type !== "string") blockers.push("observer-freshness-signal-unavailable");
  if (optionalRecord(observedProperties.collateral_clean).type !== "boolean") blockers.push("observer-collateral-signal-unavailable");
  const observerQueryNames = observer ? queryNames(observer.pathItem, observer.operation) : [];
  if (observerQueryNames.length === 0) blockers.push("observer-query-binding-unavailable");
  if (normalization.blockers.length > 0) blockers.push(...normalization.blockers.map((item) => `normalization:${item}`));
  if (blockers.length > 0 || !action || !observer) return { blockers: [...new Set(blockers)].sort() };
  return {
    blockers: [],
    shape: {
      normalization,
      sourceDocumentDigest: cleanPackageAuthoringDigest(input.approvedMaterial.document),
      action: { operationId: action.operation.operationId as string, method: "POST", path: action.path, credentialAlias: input.selection.actionCredentialAlias },
      observer: { operationId: observer.operation.operationId as string, method: "GET", path: observer.path, credentialAlias: input.selection.observerCredentialAlias, queryNames: observerQueryNames },
      bodyFields,
      resultPath: "items",
      freshnessPath: "server_time",
      collateralPath: "collateral_clean",
    },
  };
}

function question(
  questionId: string,
  factKey: string,
  prompt: string,
  consequence: string,
  answerKind: CleanPackageAuthoringQuestion["answerKind"],
  extra: Pick<CleanPackageAuthoringQuestion, "options" | "expectedLiteral" | "valueType"> = {},
): CleanPackageAuthoringQuestion {
  return { questionId, factKey, prompt, consequence, answerKind, ...extra, answerStatus: "unanswered" };
}

function questions(shape: SupportedShape): CleanPackageAuthoringQuestion[] {
  const fieldNames = shape.bodyFields.map((field) => field.key);
  const result: CleanPackageAuthoringQuestion[] = [
    question("action-driver-id", "action.driverId", "What reviewed customer-local driver will execute the selected POST?", "Names an implementation boundary; it does not make that driver trusted.", "identifier"),
    question("action-source-id", "action.sourceId", "What approved source identity should be bound to the action transport?", "Binds later action evidence to one reviewed source.", "identifier"),
    question("observer-driver-id", "observer.driverId", "What separately reviewed read-only driver will observe the external result?", "Prevents the action response from serving as independent proof.", "identifier"),
    question("observer-source-id", "observer.sourceId", "What separately authenticated observation source should be used?", "Binds outcome evidence to a distinct read-side source.", "identifier"),
    question("stable-input-key", "workflow.stableInputKey", "Which approved workflow field is the stable identifier for this action?", "Controls lookup, duplicate detection and replay identity.", "enum", { options: fieldNames }),
    question("conflict-input-key", "workflow.conflictInputKey", "Which different field must conflict on duplicate parent reuse?", "Proves that the same parent identity cannot silently change consequential content.", "enum", { options: fieldNames }),
    question("alternative-conflict-value", "workflow.alternativeConflictValue", "What different test value should prove conflicting-parent rejection?", "Creates the frozen negative case without changing the approved value.", "scalar"),
    question("observer-query-name", "observer.queryName", "Which documented query parameter receives the stable identifier?", "Binds independent lookup to one reviewed query field.", "enum", { options: shape.observer.queryNames }),
    question("observer-query-input-key", "observer.queryInputKey", "Which workflow field supplies that observer query?", "Requires an explicit stable-identifier mapping.", "enum", { options: fieldNames }),
    question("independent-observation", "observer.independent", "Is this observer genuinely independent from the action driver and action response?", "A false answer blocks the package instead of manufacturing proof.", "boolean", { expectedLiteral: true }),
    question("observer-result-path", "observer.resultPath", "Confirm the reviewed result collection path.", "Defines where outcome predicates read external records.", "enum", { options: [shape.resultPath] }),
    question("freshness-path", "observer.freshnessPath", "Confirm the trusted server-side freshness field.", "Prevents stale records from passing as new outcomes.", "enum", { options: [shape.freshnessPath] }),
    question("freshness-seconds", "observer.maximumAgeSeconds", "Confirm the maximum accepted observation age in seconds.", "Sets the fixed freshness window used by the current compact runtime.", "integer", { expectedLiteral: 30 }),
    question("duplicate-key", "outcome.duplicateKey", "Which observed field is the unique duplicate key?", "Defines exactly-one duplicate detection independently of the write response.", "enum", { options: fieldNames }),
    question("duplicate-count", "outcome.expectedCount", "Confirm the exact accepted record count.", "Any zero or multiple result becomes not-started or duplicate instead of success.", "integer", { expectedLiteral: 1 }),
    question("collateral-path", "outcome.collateralPath", "Confirm the independently observed collateral-state field.", "Allows unrelated changes to reject the outcome.", "enum", { options: [shape.collateralPath] }),
    question("collateral-expected", "outcome.collateralExpected", "Must the collateral-state field remain true?", "Sets the tested no-unrelated-change invariant.", "boolean", { expectedLiteral: true }),
    question("reconcile-before-retry", "retry.reconcileBeforeRetry", "Must external state be reconciled before every retry?", "Prevents blind duplicate writes after response loss.", "boolean", { expectedLiteral: true }),
    question("blind-retry", "retry.blindRetryAllowed", "May the system ever retry this write without reconciliation?", "The current safe contract requires an explicit no.", "boolean", { expectedLiteral: false }),
    question("maximum-attempts", "retry.maximumAttempts", "Confirm the maximum action attempts in this compact contract.", "Bounds side effects during uncertain outcomes.", "integer", { expectedLiteral: 1 }),
    question("write-policy", "authority.writePolicy", "Is this exact selected write preauthorized only after separate runtime grant checks?", "Confirms the package policy but does not create a runtime grant.", "enum", { options: ["preauthorized"] }),
    question("quantity-limit", "authority.quantityPerAction", "Confirm the maximum consequential quantity per action.", "The compact v1 runtime supports the conservative value one.", "integer", { expectedLiteral: 1 }),
    question("rate-limit", "authority.actionsPerHour", "Confirm the maximum actions per hour.", "Bounds local action rate.", "integer", { expectedLiteral: 20 }),
    question("forbidden-actions", "authority.forbiddenActions", "Confirm that no additional action names are being silently declared safe.", "Any forbidden-action policy outside this compact contract requires engineering work.", "empty-list", { expectedLiteral: [] }),
    question("approver-policy", "authority.approver", "Confirm that this exact bounded write needs no further human approval once separately granted at runtime.", "A different approval policy is unsupported by clean-package v1.", "enum", { options: ["not-required"] }),
    question("final-review", "authority.finalConsequentialReview", "Do you explicitly confirm these consequential authority boundaries?", "Without this confirmation the draft cannot reach CF-026 preview.", "boolean", { expectedLiteral: true }),
  ];
  for (const field of shape.bodyFields) {
    result.push(question(`input-${field.key}`, `workflow.input.${field.key}`, `What approved workflow value should be supplied for ${field.key}?`, "Creates fixture input only; it never reads a credential or grants authority.", "scalar", { valueType: field.type }));
    result.push(question(`mapping-${field.key}`, `mapping.${field.key}`, `Confirm identity mapping from workflow input ${field.key} to JSON body ${field.key}.`, "Any transform or different destination requires explicit engineering work.", "boolean", { expectedLiteral: true }));
  }
  return result;
}

export function validateCleanPackageAuthoringAnswer(question: CleanPackageAuthoringQuestion, value: unknown): void {
  if (question.answerKind === "identifier" && (typeof value !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]{1,179}$/.test(value))) throw new Error(`Answer ${question.questionId} requires a stable identifier.`);
  if (question.answerKind === "enum" && !question.options?.some((option) => canonical(option) === canonical(value))) throw new Error(`Answer ${question.questionId} is outside the reviewed options.`);
  if (question.answerKind === "boolean" && typeof value !== "boolean") throw new Error(`Answer ${question.questionId} must be boolean.`);
  if (question.answerKind === "integer" && (!Number.isInteger(value) || typeof value !== "number")) throw new Error(`Answer ${question.questionId} must be an integer.`);
  if (question.answerKind === "empty-list" && (!Array.isArray(value) || value.length !== 0)) throw new Error(`Answer ${question.questionId} must be the explicitly confirmed empty list.`);
  if (question.answerKind === "scalar" && !(typeof value === "string" || typeof value === "number" || typeof value === "boolean")) throw new Error(`Answer ${question.questionId} must be a bounded scalar.`);
  if (question.valueType === "string" && typeof value !== "string") throw new Error(`Answer ${question.questionId} must match the documented string type.`);
  if (question.valueType === "integer" && (!Number.isInteger(value) || typeof value !== "number")) throw new Error(`Answer ${question.questionId} must match the documented integer type.`);
  if (question.valueType === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`Answer ${question.questionId} must match the documented number type.`);
  if (question.valueType === "boolean" && typeof value !== "boolean") throw new Error(`Answer ${question.questionId} must match the documented boolean type.`);
  if (question.expectedLiteral !== undefined && canonical(question.expectedLiteral) !== canonical(value)) throw new Error(`Answer ${question.questionId} does not match the supported explicitly reviewed contract.`);
}

function materializePackage(input: CleanPackageAuthoringInput, shape: SupportedShape, answers: Map<string, AnswerRecord>): OnboardingCleanPackage {
  const value = (questionId: string): unknown => {
    const answer = answers.get(questionId);
    if (!answer) throw new Error(`Missing explicitly confirmed answer: ${questionId}.`);
    return answer.value;
  };
  const stableInputKey = value("stable-input-key") as string;
  const conflictInputKey = value("conflict-input-key") as string;
  if (stableInputKey === conflictInputKey) throw new Error("Stable and conflict input keys must be different.");
  if (value("observer-query-input-key") !== stableInputKey || value("duplicate-key") !== stableInputKey) {
    throw new Error("Observer lookup and duplicate detection must be explicitly bound to the same confirmed stable input key in compact v1.");
  }
  const workflowInput = Object.fromEntries(shape.bodyFields.map((field) => [field.key, value(`input-${field.key}`)]));
  const alternativeConflictValue = value("alternative-conflict-value") as string | number | boolean;
  if (canonical(alternativeConflictValue) === canonical(workflowInput[conflictInputKey])) throw new Error("Alternative conflict value must differ from the approved workflow value.");
  const partial = {
    schemaVersion: "1.0" as const,
    packageId: input.packageIdentity.packageId,
    sessionId: input.packageIdentity.packageSessionId,
    tenantId: input.tenantId,
    adapterId: input.packageIdentity.adapterId,
    adapterVersion: input.packageIdentity.adapterVersion,
    targetAlias: input.approvedMaterial.targetAlias,
    serverUrl: input.selection.serverUrl,
    workflowId: input.workflow.workflowId,
    summary: input.workflow.summary,
    requiredOutcome: input.workflow.requiredOutcome,
    action: { driverId: value("action-driver-id") as string, sourceId: value("action-source-id") as string, operationId: shape.action.operationId, credentialAlias: shape.action.credentialAlias, path: shape.action.path },
    observer: { driverId: value("observer-driver-id") as string, sourceId: value("observer-source-id") as string, operationId: shape.observer.operationId, credentialAlias: shape.observer.credentialAlias, path: shape.observer.path, queryName: value("observer-query-name") as string },
    stableInputKey,
    conflictInputKey,
    workflowInput,
    alternativeConflictValue,
    approvedDocument: {
      localReference: input.approvedMaterial.localReference,
      approvedByAlias: input.approvedMaterial.approvedByAlias,
      approvedAt: input.approvedMaterial.approvedAt,
      sourceOpenApiSha256: shape.sourceDocumentDigest,
      derivedOpenApiSha256: "f".repeat(64),
    },
  };
  partial.approvedDocument.derivedOpenApiSha256 = derivedOpenApiDigestForCleanPackage(partial as OnboardingCleanPackage);
  return onboardingCleanPackageSchema.parse(partial);
}

function facts(input: CleanPackageAuthoringInput, shape: SupportedShape | undefined, questionList: CleanPackageAuthoringQuestion[]): CleanPackageAuthoringFact[] {
  const source = input.approvedMaterial.document;
  const sourceDigest = cleanPackageAuthoringDigest(source);
  const list: CleanPackageAuthoringFact[] = [
    { key: "source.kind", value: "openapi", status: "observed", provenance: [evidence("approved-openapi", "/openapi", optionalRecord(source).openapi)], explanation: "The approved source is directly observed as OpenAPI material." },
    { key: "source.document", value: sourceDigest, status: "independently-verified", provenance: [evidence("approved-openapi", "/", source)], explanation: "Trusted code hashed the exact approved local OpenAPI document; this does not prove its semantics." },
    { key: "source.server", value: input.selection.serverUrl, status: "customer-confirmed", provenance: [evidence("selected-input", "/selection/serverUrl", input.selection.serverUrl)], explanation: "Exact advertised server selected by the package author." },
    { key: "workflow.summary", value: input.workflow.summary, status: "customer-confirmed", provenance: [evidence("selected-input", "/workflow/summary", input.workflow.summary)], explanation: "Ordinary blocked workflow supplied and explicitly confirmed; source text is never interpreted as policy." },
    { key: "workflow.outcome", value: input.workflow.requiredOutcome, status: "customer-confirmed", provenance: [evidence("selected-input", "/workflow/requiredOutcome", input.workflow.requiredOutcome)], explanation: "Observable outcome supplied and explicitly confirmed." },
  ];
  if (shape) {
    list.push(
      { key: "action.operation", value: shape.action, status: "extracted", provenance: [evidence("approved-openapi", `/operation/${shape.action.operationId}`, shape.action)], explanation: "Exact POST identity and path extracted from approved material." },
      { key: "observer.operation", value: shape.observer, status: "extracted", provenance: [evidence("approved-openapi", `/operation/${shape.observer.operationId}`, shape.observer)], explanation: "Exact GET identity, path and query candidates extracted from approved material." },
      { key: "workflow.bodyFields", value: shape.bodyFields, status: "extracted", provenance: [evidence("approved-openapi", `/operation/${shape.action.operationId}/requestBody`, shape.bodyFields)], explanation: "Exactly three required primitive fields extracted; no mapping or values are inferred." },
      { key: "observer.resultCandidate", value: { resultPath: shape.resultPath, freshnessPath: shape.freshnessPath, collateralPath: shape.collateralPath }, status: "inferred-proposal", provenance: [evidence("approved-openapi", `/operation/${shape.observer.operationId}/responses/200`, shape.observer)], explanation: "Machine-readable fields are candidates only until explicitly confirmed as business evidence." },
    );
  }
  for (const item of questionList) {
    list.push({ key: item.factKey, status: item.options || item.expectedLiteral !== undefined ? "inferred-proposal" : "unknown", provenance: [evidence("authoring-policy", `/questions/${item.questionId}`, { options: item.options, expectedLiteral: item.expectedLiteral })], explanation: "This consequential fact remains non-authorizing until explicitly answered.", questionId: item.questionId });
  }
  return list;
}

function finalizeSnapshot(snapshot: Omit<CleanPackageAuthoringSnapshot, "snapshotDigest">): CleanPackageAuthoringSnapshot {
  return { ...snapshot, snapshotDigest: cleanPackageAuthoringDigest(snapshot) };
}

function assertSnapshot(snapshot: CleanPackageAuthoringSnapshot): void {
  const { snapshotDigest, ...payload } = snapshot;
  if (cleanPackageAuthoringDigest(payload) !== snapshotDigest) throw new Error("Clean-package authoring snapshot failed its integrity check.");
}

function buildSnapshot(input: CleanPackageAuthoringInput, answers: Map<string, AnswerRecord>, revision: number, createdAt: string, updatedAt: string): CleanPackageAuthoringSnapshot {
  const inspected = inspectSupportedShape(input);
  const questionList = inspected.shape ? questions(inspected.shape) : [];
  for (const item of questionList) {
    const answer = answers.get(item.questionId);
    if (!answer) continue;
    validateCleanPackageAuthoringAnswer(item, answer.value);
    item.answerStatus = "customer-confirmed";
    item.confirmedValue = structuredClone(answer.value);
    item.confirmedByAlias = answer.answeredByAlias;
    item.confirmedAt = answer.answeredAt;
  }
  const factList = facts(input, inspected.shape, questionList);
  for (const fact of factList) {
    if (!fact.questionId) continue;
    const answer = answers.get(fact.questionId);
    if (!answer) continue;
    fact.value = structuredClone(answer.value);
    fact.status = "customer-confirmed";
    fact.provenance = [evidence("explicit-answer", `/answers/${fact.questionId}`, { value: answer.value, answeredByAlias: answer.answeredByAlias, answeredAt: answer.answeredAt })];
    fact.explanation = "Explicitly confirmed answer bound to this authoring revision; it still grants no runtime authority.";
  }
  const unanswered = questionList.filter((item) => item.answerStatus === "unanswered");
  let packageDraft: OnboardingCleanPackage | undefined;
  const finalBlockers = [...inspected.blockers];
  if (inspected.shape && unanswered.length === 0) {
    try {
      packageDraft = materializePackage(input, inspected.shape, answers);
    } catch (error) {
      finalBlockers.push(`confirmed-draft-invalid:${error instanceof Error ? error.message : "unknown"}`);
    }
  }
  const status = inspected.blockers.length > 0 || (unanswered.length === 0 && !packageDraft)
    ? "unsupported" as const
    : packageDraft ? "package-draft-ready" as const : "questions-required" as const;
  return finalizeSnapshot({
    schemaVersion: ONBOARDING_CLEAN_PACKAGE_AUTHORING_VERSION,
    authoringSessionId: input.authoringSessionId,
    tenantId: input.tenantId,
    packageSessionId: input.packageIdentity.packageSessionId,
    revision,
    status,
    executionAuthorityEffect: "none",
    activationEffect: "none",
    sourceInputDigest: cleanPackageAuthoringDigest(input),
    sourceDocumentDigest: cleanPackageAuthoringDigest(input.approvedMaterial.document),
    ...(inspected.shape ? { normalizationReceiptDigest: inspected.shape.normalization.normalizationReceiptDigest } : {}),
    facts: factList,
    questions: questionList,
    blockers: [...new Set([...finalBlockers, ...unanswered.map((item) => `unresolved:${item.questionId}`)])].sort(),
    engineeringWorkRemaining: inspected.blockers.length > 0
      ? inspected.blockers.map((item) => `Resolve unsupported clean-package shape: ${item}.`)
      : unanswered.map((item) => `Obtain explicit confirmation for ${item.factKey}.`),
    ...(packageDraft ? { packageDraft } : {}),
    metrics: {
      extractedFieldCount: factList.filter((item) => item.status === "observed" || item.status === "extracted" || item.status === "independently-verified").length,
      confirmationQuestionCount: questionList.length,
      explicitDecisionCount: questionList.filter((item) => item.answerStatus === "customer-confirmed").length,
      unresolvedQuestionCount: unanswered.length,
      packageSpecificExecutableCodeLines: 0,
    },
    evidenceBoundary: packageDraft
      ? "This is a complete explicitly confirmed deterministic package draft. It may be submitted to CF-026 preview, but it grants no execution or activation and contains no acceptance evidence."
      : "This is a deterministic authoring diagnostic. Unknowns, proposals and extracted fields are not authority, executable bindings, passing evidence or activation.",
    createdAt,
    updatedAt,
  });
}

export class DurableCleanPackageAuthoringWorkflow {
  private readonly database: DatabaseSync;
  private readonly now: () => string;

  constructor(databasePath = ":memory:", options: { now?: () => string } = {}) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    this.now = options.now ?? (() => new Date().toISOString());
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS onboarding_clean_package_authoring (
        authoring_session_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        input_digest TEXT NOT NULL,
        input_json TEXT NOT NULL,
        answers_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        snapshot_digest TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS onboarding_clean_package_authoring_submissions (
        submission_id TEXT PRIMARY KEY,
        authoring_session_id TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        resulting_snapshot_digest TEXT NOT NULL,
        resulting_snapshot_json TEXT NOT NULL
      );
    `);
  }

  start(raw: unknown): CleanPackageAuthoringSnapshot {
    const input = cleanPackageAuthoringInputSchema.parse(raw);
    const inputDigest = cleanPackageAuthoringDigest(input);
    const existing = this.database.prepare("SELECT input_digest FROM onboarding_clean_package_authoring WHERE authoring_session_id = ?").get(input.authoringSessionId) as { input_digest: string } | undefined;
    if (existing) {
      if (existing.input_digest !== inputDigest) throw new Error("Authoring session identity is already bound to different approved source or workflow input.");
      return this.read(input.authoringSessionId);
    }
    const timestampValue = this.now();
    const snapshot = buildSnapshot(input, new Map(), 1, timestampValue, timestampValue);
    this.database.prepare(`INSERT INTO onboarding_clean_package_authoring (authoring_session_id, tenant_id, input_digest, input_json, answers_json, snapshot_json, snapshot_digest) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(input.authoringSessionId, input.tenantId, inputDigest, JSON.stringify(input), "{}", JSON.stringify(snapshot), snapshot.snapshotDigest);
    return structuredClone(snapshot);
  }

  answer(raw: unknown): CleanPackageAuthoringSnapshot {
    const submission = cleanPackageAuthoringAnswerSubmissionSchema.parse(raw);
    const requestDigest = cleanPackageAuthoringDigest(submission);
    const replay = this.database.prepare("SELECT authoring_session_id, request_digest, resulting_snapshot_digest, resulting_snapshot_json FROM onboarding_clean_package_authoring_submissions WHERE submission_id = ?").get(submission.submissionId) as { authoring_session_id: string; request_digest: string; resulting_snapshot_digest: string; resulting_snapshot_json: string } | undefined;
    if (replay) {
      if (replay.authoring_session_id !== submission.authoringSessionId || replay.request_digest !== requestDigest) throw new Error("Authoring submission identity conflicts with a different session or answer payload.");
      const originalResult = JSON.parse(replay.resulting_snapshot_json) as CleanPackageAuthoringSnapshot;
      assertSnapshot(originalResult);
      if (originalResult.snapshotDigest !== replay.resulting_snapshot_digest || originalResult.authoringSessionId !== submission.authoringSessionId) throw new Error("Stored authoring replay failed its integrity or session check.");
      return structuredClone(originalResult);
    }
    const row = this.database.prepare("SELECT input_json, answers_json, snapshot_json, snapshot_digest FROM onboarding_clean_package_authoring WHERE authoring_session_id = ?").get(submission.authoringSessionId) as { input_json: string; answers_json: string; snapshot_json: string; snapshot_digest: string } | undefined;
    if (!row) throw new Error("Clean-package authoring session does not exist.");
    const current = JSON.parse(row.snapshot_json) as CleanPackageAuthoringSnapshot;
    assertSnapshot(current);
    if (current.revision !== submission.expectedRevision || current.snapshotDigest !== submission.expectedSnapshotDigest) throw new Error("Authoring answer submission is stale; reload the latest integrity-bound revision.");
    if (current.status === "unsupported") throw new Error("Unsupported authoring sessions cannot accept answers; resolve the named engineering blockers in a new source revision.");
    const input = cleanPackageAuthoringInputSchema.parse(JSON.parse(row.input_json));
    const answersObject = JSON.parse(row.answers_json) as Record<string, AnswerRecord>;
    const answers = new Map(Object.entries(answersObject));
    const available = new Map(current.questions.map((item) => [item.questionId, item]));
    const seen = new Set<string>();
    for (const answer of submission.answers) {
      if (seen.has(answer.questionId)) throw new Error(`Duplicate answer in one submission: ${answer.questionId}.`);
      seen.add(answer.questionId);
      const target = available.get(answer.questionId);
      if (!target) throw new Error(`Unknown or unsupported authoring question: ${answer.questionId}.`);
      validateCleanPackageAuthoringAnswer(target, answer.value);
      const existing = answers.get(answer.questionId);
      if (existing && canonical(existing.value) !== canonical(answer.value)) throw new Error(`Answer ${answer.questionId} conflicts with its previously confirmed value.`);
      if (!existing) answers.set(answer.questionId, { value: structuredClone(answer.value), answeredByAlias: submission.answeredByAlias, answeredAt: submission.answeredAt });
    }
    const updated = buildSnapshot(input, answers, current.revision + 1, current.createdAt, this.now());
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.database.prepare("UPDATE onboarding_clean_package_authoring SET answers_json = ?, snapshot_json = ?, snapshot_digest = ? WHERE authoring_session_id = ? AND snapshot_digest = ?")
        .run(JSON.stringify(Object.fromEntries(answers)), JSON.stringify(updated), updated.snapshotDigest, submission.authoringSessionId, current.snapshotDigest);
      if (Number(changed.changes) !== 1) throw new Error("Authoring revision changed concurrently; answers were not recorded.");
      this.database.prepare("INSERT INTO onboarding_clean_package_authoring_submissions (submission_id, authoring_session_id, request_digest, resulting_snapshot_digest, resulting_snapshot_json) VALUES (?, ?, ?, ?, ?)")
        .run(submission.submissionId, submission.authoringSessionId, requestDigest, updated.snapshotDigest, JSON.stringify(updated));
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return structuredClone(updated);
  }

  read(authoringSessionId: string): CleanPackageAuthoringSnapshot {
    identifier.parse(authoringSessionId);
    const row = this.database.prepare("SELECT tenant_id, input_digest, snapshot_json, snapshot_digest FROM onboarding_clean_package_authoring WHERE authoring_session_id = ?").get(authoringSessionId) as { tenant_id: string; input_digest: string; snapshot_json: string; snapshot_digest: string } | undefined;
    if (!row) throw new Error("Clean-package authoring session does not exist.");
    const snapshot = JSON.parse(row.snapshot_json) as CleanPackageAuthoringSnapshot;
    assertSnapshot(snapshot);
    if (snapshot.tenantId !== row.tenant_id || snapshot.sourceInputDigest !== row.input_digest || snapshot.snapshotDigest !== row.snapshot_digest) throw new Error("Stored authoring metadata does not match its integrity-bound snapshot.");
    return structuredClone(snapshot);
  }

  close(): void {
    this.database.close();
  }
}

export function projectCleanPackageAuthoringSnapshot(snapshot: CleanPackageAuthoringSnapshot): CleanPackageAuthoringSnapshot {
  assertSnapshot(snapshot);
  return structuredClone(snapshot);
}
