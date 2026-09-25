import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type ApprovedOpenApiNormalizationResult,
  type OpenApiOperationalMetadata,
} from "./approved-openapi-normalizer.js";
import {
  assertAuthorityWizardCompilationIntegrity,
  type AuthorityWizardCompilation,
} from "./onboarding-verifier-authority.js";

export const HTTP_BINDING_FACTORY_VERSION = "1.0" as const;

const identifier = z.string().min(1).max(180).regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/);
const boundedText = z.string().trim().min(1).max(2_000);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/).refine((value) => !/^0+$/.test(value));
const pathSegment = z.union([identifier, z.number().int().nonnegative()]);
const secretShaped = /(?:bearer\s+[a-z0-9._~+\/-]{8,}|sk-[a-z0-9_-]{12,}|password\s*[:=]|(?:api[_ -]?key|client[_ -]?secret|access[_ -]?token)\s*[:=]\s*["']?[^\s"']{6,}|https?:\/\/[^\s/:]+:[^\s/@]+@)/i;

const valueSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workflow-input"), inputKey: identifier, confirmed: z.literal(true) }).strict(),
  z.object({ kind: z.literal("trusted-context"), contextKey: identifier, confirmed: z.literal(true) }).strict(),
]);
export type HttpBindingValueSource = z.infer<typeof valueSourceSchema>;

const requestMappingSchema = z.object({
  source: valueSourceSchema,
  destination: z.discriminatedUnion("location", [
    z.object({ location: z.literal("path"), name: identifier }).strict(),
    z.object({ location: z.literal("query"), name: identifier }).strict(),
    z.object({ location: z.literal("header"), name: identifier }).strict(),
    z.object({ location: z.literal("json-body"), path: z.array(pathSegment).min(1).max(16) }).strict(),
  ]),
  transform: z.literal("identity"),
  confirmed: z.literal(true),
}).strict();

const observerParameterBindingSchema = z.object({
  name: identifier,
  location: z.enum(["path", "query"]),
  source: valueSourceSchema,
  purpose: z.enum(["stable-identifier", "confirmed-filter"]),
  confirmed: z.literal(true),
}).strict();

const outcomePredicateSchema = z.discriminatedUnion("operator", [
  z.object({ key: identifier, path: z.array(pathSegment).max(24), operator: z.literal("exists"), confirmed: z.literal(true) }).strict(),
  z.object({ key: identifier, path: z.array(pathSegment).max(24), operator: z.literal("equals-input"), inputKey: identifier, confirmed: z.literal(true) }).strict(),
  z.object({ key: identifier, path: z.array(pathSegment).max(24), operator: z.literal("equals-confirmed"), expected: z.union([z.string().max(1_000), z.number().finite(), z.boolean(), z.null()]), confirmed: z.literal(true) }).strict(),
  z.object({ key: identifier, path: z.array(pathSegment).max(24), operator: z.literal("count-equals"), expectedCount: z.number().int().nonnegative(), confirmed: z.literal(true) }).strict(),
]);

const bindingFactsSchema = z.object({
  targetAlias: identifier,
  ordinaryBusinessOutcome: boundedText,
  outcomeConfirmed: z.literal(true),
  action: z.object({
    driverId: identifier,
    operationId: identifier,
    operationConfirmed: z.literal(true),
    credentialAlias: identifier,
    requestMappings: z.array(requestMappingSchema).min(1).max(64),
    requestMappingsConfirmed: z.literal(true),
    reconcileBeforeRetry: z.literal(true),
    blindRetryAllowed: z.literal(false),
  }).strict(),
  observer: z.object({
    driverId: identifier,
    sourceId: identifier,
    operationId: identifier,
    operationConfirmed: z.literal(true),
    credentialAlias: identifier,
    independentlyAuthenticated: z.literal(true),
    independentFromActionDriver: z.literal(true),
    parameterBindings: z.array(observerParameterBindingSchema).max(32),
    resultPath: z.array(pathSegment).max(24),
    resultPathConfirmed: z.literal(true),
    pagination: z.object({ kind: z.literal("not-paginated"), confirmed: z.literal(true) }).strict(),
    freshness: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("server-timestamp-body"), path: z.array(pathSegment).min(1).max(24), maximumAgeSeconds: z.number().int().positive().max(86_400), confirmed: z.literal(true) }).strict(),
      z.object({ kind: z.literal("server-timestamp-header"), headerName: identifier, maximumAgeSeconds: z.number().int().positive().max(86_400), confirmed: z.literal(true) }).strict(),
    ]),
  }).strict(),
  outcome: z.object({
    predicates: z.array(outcomePredicateSchema).min(1).max(48),
    duplicateCheck: z.object({ collectionPath: z.array(pathSegment).max(24), uniqueKeyPath: z.array(pathSegment).min(1).max(12), expectedCount: z.number().int().nonnegative(), confirmed: z.literal(true) }).strict(),
    collateralChecks: z.array(outcomePredicateSchema).min(1).max(24),
    notStartedDefinition: z.array(outcomePredicateSchema).min(1).max(24),
    confirmed: z.literal(true),
  }).strict(),
}).strict().superRefine((facts, context) => {
  if (facts.action.driverId === facts.observer.driverId) {
    context.addIssue({ code: "custom", path: ["observer", "driverId"], message: "The observation driver must be distinct from the action driver." });
  }
  if (facts.action.credentialAlias === facts.observer.credentialAlias) {
    context.addIssue({ code: "custom", path: ["observer", "credentialAlias"], message: "The observer must use a separately scoped read-side credential alias." });
  }
  const requestDestinations = facts.action.requestMappings.map((mapping) => canonical(mapping.destination));
  if (new Set(requestDestinations).size !== requestDestinations.length) {
    context.addIssue({ code: "custom", path: ["action", "requestMappings"], message: "A request destination cannot be bound more than once." });
  }
  const observerParameters = facts.observer.parameterBindings.map((mapping) => `${mapping.location}:${mapping.name}`);
  if (new Set(observerParameters).size !== observerParameters.length) {
    context.addIssue({ code: "custom", path: ["observer", "parameterBindings"], message: "An observer parameter cannot be bound more than once." });
  }
  if (!facts.observer.parameterBindings.some((binding) => binding.purpose === "stable-identifier")) {
    context.addIssue({ code: "custom", path: ["observer", "parameterBindings"], message: "At least one observer parameter must be bound to a confirmed stable identifier available before action execution." });
  }
});
export type HttpBindingFactoryFacts = z.infer<typeof bindingFactsSchema>;

export interface HttpBindingFactoryInput {
  schemaVersion: typeof HTTP_BINDING_FACTORY_VERSION;
  normalization: ApprovedOpenApiNormalizationResult;
  /**
   * Optional separately approved read-side material. This preserves the common
   * single-document path while allowing a genuinely independent observer API
   * to use a different exact origin and certificate boundary.
   */
  observerNormalization?: ApprovedOpenApiNormalizationResult;
  authorityCompilation: AuthorityWizardCompilation;
  facts: HttpBindingFactoryFacts;
}

export interface HttpBindingBlocker {
  blockerId: string;
  detail: string;
  requiredEngineeringWork: string;
}

export interface HttpActionBindingDeclaration {
  schemaVersion: "1.0";
  kind: "constrained-http-action-binding-declaration";
  state: "proposal-only";
  executable: false;
  qualified: false;
  activated: false;
  driverId: string;
  targetAlias: string;
  serverUrl: string;
  operation: { operationId: string; method: "POST" | "PUT" | "PATCH" | "DELETE"; pathTemplate: string };
  credentialAlias: string;
  requestMappings: z.infer<typeof requestMappingSchema>[];
  reconciliationKeySource: HttpBindingValueSource;
  acceptedStatuses: number[];
  authorityPolicy: "preauthorized" | "requires-approval";
  retry: { reconcileBeforeRetry: true; blindRetryAllowed: false };
  provenance: HttpBindingProvenance;
  declarationDigest: string;
}

export interface HttpObserverBindingDeclaration {
  schemaVersion: "1.0";
  kind: "independent-http-observer-binding-declaration";
  state: "proposal-only";
  executable: false;
  qualified: false;
  activated: false;
  driverId: string;
  sourceId: string;
  targetAlias: string;
  serverUrl: string;
  operation: { operationId: string; method: "GET" | "HEAD"; pathTemplate: string };
  credentialAlias: string;
  parameterBindings: z.infer<typeof observerParameterBindingSchema>[];
  resultPath: Array<string | number>;
  acceptedStatuses: number[];
  freshness: HttpBindingFactoryFacts["observer"]["freshness"] & { notBeforeBoundary: "trusted-operation-start" };
  predicates: z.infer<typeof outcomePredicateSchema>[];
  notStartedDefinition: z.infer<typeof outcomePredicateSchema>[];
  duplicateCheck: HttpBindingFactoryFacts["outcome"]["duplicateCheck"];
  collateralChecks: z.infer<typeof outcomePredicateSchema>[];
  actionResponseEligibleAsProof: false;
  provenance: HttpBindingProvenance;
  declarationDigest: string;
}

export interface HttpBindingProvenance {
  normalizedMaterialDigest: string;
  normalizationReceiptDigest: string;
  authorityCompilationDigest: string;
  confirmedFactsDigest: string;
  operationPointer: string;
}

export interface HttpBindingFactoryResult {
  schemaVersion: typeof HTTP_BINDING_FACTORY_VERSION;
  status: "review-required" | "blocked";
  executable: false;
  qualified: false;
  activated: false;
  actionBinding?: HttpActionBindingDeclaration;
  observerBinding?: HttpObserverBindingDeclaration;
  blockers: HttpBindingBlocker[];
  engineeringWorkRemaining: string[];
  automationMetrics: {
    humanStudy: false;
    humanActiveMinutes: null;
    confirmedFactCount: number;
    generatedActionDeclarationFields: number;
    generatedObserverDeclarationFields: number;
    executableCodeLinesGenerated: 0;
    qualificationControlsRun: 0;
  };
  onboardingProjection: {
    state: "binding-declarations-ready" | "blocked";
    acceptanceReviewDigestsEligible: false;
    authorityRuntimeBindingDigest: null;
    observationAdapterBindingDigest: null;
    exactNextGates: string[];
    evidenceBoundary: string;
  };
  resultDigest: string;
}

type JsonRecord = Record<string, unknown>;

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

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as JsonRecord;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function blocker(blockerId: string, detail: string, requiredEngineeringWork: string): HttpBindingBlocker {
  return { blockerId, detail, requiredEngineeringWork };
}

function assertNormalizationIntegrity(result: ApprovedOpenApiNormalizationResult): void {
  if (digest(result.normalizedMaterial) !== result.normalizedMaterialDigest) {
    throw new Error("Normalized OpenAPI material failed its content-digest integrity check.");
  }
  const receiptCore = {
    schemaVersion: result.schemaVersion,
    materialId: result.materialId,
    targetAlias: result.targetAlias,
    originalMaterialDigest: result.originalMaterialDigest,
    normalizedMaterialDigest: result.normalizedMaterialDigest,
    serverCandidates: result.serverCandidates,
    confirmedServerUrl: result.confirmedServerUrl,
    operations: result.operations,
    blockers: result.blockers,
    unknowns: result.unknowns,
  };
  if (digest(receiptCore) !== result.normalizationReceiptDigest) {
    throw new Error("Normalized OpenAPI receipt failed its integrity check.");
  }
  if (result.executable !== false || result.status !== "review-required" || result.blockers.length > 0 || !result.confirmedServerUrl) {
    throw new Error("Binding generation requires exact server-reviewed, non-executable OpenAPI normalization with no unresolved normalization blocker.");
  }
}

interface LocatedOperation {
  metadata: OpenApiOperationalMetadata;
  operation: JsonRecord;
  pathItem: JsonRecord;
  pointer: string;
}

function locateOperation(normalization: ApprovedOpenApiNormalizationResult, operationId: string): LocatedOperation | undefined {
  const metadata = normalization.operations.filter((candidate) => candidate.operationId === operationId);
  if (metadata.length !== 1) return undefined;
  const selected = metadata[0]!;
  const document = record(normalization.normalizedMaterial.document, "Normalized OpenAPI document");
  const paths = record(document.paths ?? {}, "Normalized OpenAPI paths");
  const pathItem = paths[selected.path];
  if (!pathItem) return undefined;
  const pathRecord = record(pathItem, `OpenAPI path ${selected.path}`);
  const operation = pathRecord[selected.method.toLowerCase()];
  if (!operation) return undefined;
  const operationRecord = record(operation, `${selected.method} ${selected.path}`);
  const observedId = typeof operationRecord.operationId === "string" && operationRecord.operationId.length > 0
    ? operationRecord.operationId
    : `${selected.method.toLowerCase()}:${selected.path}`;
  if (observedId !== operationId) return undefined;
  return { metadata: selected, operation: operationRecord, pathItem: pathRecord, pointer: `/paths/${selected.path}/${selected.method.toLowerCase()}` };
}

interface Parameter {
  name: string;
  location: string;
  required: boolean;
}

function operationParameters(located: LocatedOperation): Parameter[] {
  const raw = [
    ...(Array.isArray(located.pathItem.parameters) ? located.pathItem.parameters : []),
    ...(Array.isArray(located.operation.parameters) ? located.operation.parameters : []),
  ];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as JsonRecord;
    if (typeof candidate.name !== "string" || typeof candidate.in !== "string") return [];
    return [{ name: candidate.name, location: candidate.in, required: candidate.required === true || candidate.in === "path" }];
  });
}

function responseEntries(operation: JsonRecord): Array<{ status: number; response: JsonRecord }> {
  const responses = operation.responses && typeof operation.responses === "object" && !Array.isArray(operation.responses)
    ? operation.responses as JsonRecord
    : {};
  return Object.entries(responses).flatMap(([status, raw]) => {
    const parsed = Number(status);
    if (!Number.isInteger(parsed) || parsed < 200 || parsed > 299 || !raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    return [{ status: parsed, response: raw as JsonRecord }];
  });
}

function jsonSchemaFromResponse(response: JsonRecord): JsonRecord | undefined {
  const content = response.content && typeof response.content === "object" && !Array.isArray(response.content)
    ? response.content as JsonRecord
    : {};
  const json = content["application/json"];
  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
  const schema = (json as JsonRecord).schema;
  return schema && typeof schema === "object" && !Array.isArray(schema) ? schema as JsonRecord : undefined;
}

function schemaAtPath(schema: JsonRecord | undefined, path: Array<string | number>): JsonRecord | undefined {
  let current = schema;
  for (const segment of path) {
    if (!current) return undefined;
    if (typeof segment === "number") {
      const items = current.items;
      current = items && typeof items === "object" && !Array.isArray(items) ? items as JsonRecord : undefined;
      continue;
    }
    const properties = current.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return undefined;
    const next = (properties as JsonRecord)[segment];
    current = next && typeof next === "object" && !Array.isArray(next) ? next as JsonRecord : undefined;
  }
  return current;
}

function schemaAtRelativeItemPath(schema: JsonRecord | undefined, collectionPath: Array<string | number>, itemPath: Array<string | number>): JsonRecord | undefined {
  const collection = schemaAtPath(schema, collectionPath);
  if (!collection || collection.type !== "array") return undefined;
  const item = collection.items;
  const itemSchema = item && typeof item === "object" && !Array.isArray(item) ? item as JsonRecord : undefined;
  return schemaAtPath(itemSchema, itemPath);
}

function requestBodySchema(operation: JsonRecord): JsonRecord | undefined {
  const requestBody = operation.requestBody && typeof operation.requestBody === "object" && !Array.isArray(operation.requestBody)
    ? operation.requestBody as JsonRecord
    : undefined;
  if (!requestBody) return undefined;
  const content = requestBody.content && typeof requestBody.content === "object" && !Array.isArray(requestBody.content)
    ? requestBody.content as JsonRecord
    : {};
  const json = content["application/json"];
  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
  const schema = (json as JsonRecord).schema;
  return schema && typeof schema === "object" && !Array.isArray(schema) ? schema as JsonRecord : undefined;
}

function topLevelBodyFields(schema: JsonRecord | undefined): { documented: string[]; required: string[]; reusable: boolean } {
  if (!schema) return { documented: [], required: [], reusable: true };
  if (schema.oneOf || schema.anyOf || schema.allOf || schema.not) return { documented: [], required: [], reusable: false };
  if (schema.type !== "object") return { documented: [], required: [], reusable: false };
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? Object.keys(schema.properties as JsonRecord)
    : [];
  const nested = Object.values((schema.properties ?? {}) as JsonRecord).some((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return true;
    const field = raw as JsonRecord;
    return field.oneOf !== undefined || field.anyOf !== undefined || field.allOf !== undefined || field.type === "object";
  });
  return {
    documented: properties,
    required: Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [],
    reusable: !nested,
  };
}

function securityAliases(located: LocatedOperation): string[] {
  return [...located.metadata.securitySchemeAliases];
}

function containsCredentialValue(value: unknown): boolean {
  return secretShaped.test(canonical(value));
}

function countLeaves(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + countLeaves(item), 0);
  if (value && typeof value === "object") return Object.values(value as JsonRecord).reduce<number>((sum, item) => sum + countLeaves(item), 0);
  return 1;
}

function finalizeDeclaration<T extends object>(value: T): T & { declarationDigest: string } {
  return { ...value, declarationDigest: digest(value) };
}

function resultDigestPayload(result: Omit<HttpBindingFactoryResult, "resultDigest"> | HttpBindingFactoryResult): unknown {
  const { resultDigest: _resultDigest, ...payload } = result as HttpBindingFactoryResult;
  return payload;
}

export function assertHttpBindingFactoryResultIntegrity(result: HttpBindingFactoryResult): void {
  if (digest(resultDigestPayload(result)) !== result.resultDigest) throw new Error("HTTP binding-factory result failed its integrity check.");
  if (result.executable !== false || result.qualified !== false || result.activated !== false) throw new Error("Binding-factory output cannot be executable, qualified, or activated.");
  for (const declaration of [result.actionBinding, result.observerBinding]) {
    if (!declaration) continue;
    const { declarationDigest, ...payload } = declaration;
    if (digest(payload) !== declarationDigest) throw new Error("HTTP binding declaration failed its intrinsic digest check.");
    if (declaration.executable !== false || declaration.qualified !== false || declaration.activated !== false) throw new Error("Generated declarations cannot be executable, qualified, or activated.");
  }
}

/**
 * Generates reviewable constrained-HTTP declarations only when every reusable
 * primitive can be derived from approved, digest-bound material plus explicit
 * confirmation. It never creates executable customer code, grants authority,
 * qualifies a verifier, resolves a credential value, or activates a binding.
 */
export function proposeHttpBindings(raw: unknown): HttpBindingFactoryResult {
  const outer = z.object({
    schemaVersion: z.literal(HTTP_BINDING_FACTORY_VERSION),
    normalization: z.custom<ApprovedOpenApiNormalizationResult>((value) => Boolean(value && typeof value === "object")),
    observerNormalization: z.custom<ApprovedOpenApiNormalizationResult>((value) => Boolean(value && typeof value === "object")).optional(),
    authorityCompilation: z.custom<AuthorityWizardCompilation>((value) => Boolean(value && typeof value === "object")),
    facts: bindingFactsSchema,
  }).strict().parse(raw) as HttpBindingFactoryInput;
  if (containsCredentialValue(outer)) throw new Error("Binding-factory input contains credential-shaped content; aliases only are allowed.");
  assertNormalizationIntegrity(outer.normalization);
  if (outer.observerNormalization) assertNormalizationIntegrity(outer.observerNormalization);
  assertAuthorityWizardCompilationIntegrity(outer.authorityCompilation);
  if (outer.authorityCompilation.status !== "review-required" || !outer.authorityCompilation.candidateAuthority) {
    throw new Error("Binding generation requires an intact, review-required authority candidate; blocked or active authority is ineligible.");
  }
  const candidateAuthority = outer.authorityCompilation.candidateAuthority;
  const facts = bindingFactsSchema.parse(outer.facts);
  if (outer.normalization.targetAlias !== facts.targetAlias) throw new Error("Confirmed binding target does not match the normalized OpenAPI target alias.");
  if (outer.observerNormalization && outer.observerNormalization.targetAlias !== facts.targetAlias) throw new Error("Confirmed observer target does not match the bounded action target alias.");
  const observerNormalization = outer.observerNormalization ?? outer.normalization;

  const blockers: HttpBindingBlocker[] = [];
  const action = locateOperation(outer.normalization, facts.action.operationId);
  const observer = locateOperation(observerNormalization, facts.observer.operationId);
  if (!action) blockers.push(blocker("action-operation-unresolved", "The confirmed action does not resolve to exactly one normalized OpenAPI operation.", "Select one exact operation ID from the normalized operation inventory."));
  if (!observer) blockers.push(blocker("observer-operation-unresolved", "The confirmed observer does not resolve to exactly one normalized OpenAPI operation.", "Select one exact read operation ID from the normalized operation inventory."));
  if (action && !["POST", "PUT", "PATCH", "DELETE"].includes(action.metadata.method)) {
    blockers.push(blocker("action-operation-not-write", `${action.metadata.operationId} is not a supported constrained HTTP write.`, "Select a documented POST, PUT, PATCH, or DELETE operation or implement a separately reviewed runtime primitive."));
  }
  if (observer && !["GET", "HEAD"].includes(observer.metadata.method)) {
    blockers.push(blocker("observer-operation-not-read", `${observer.metadata.operationId} is not an independent GET/HEAD observation path.`, "Provide an approved read-side operation or implement a separate observer driver."));
  }
  if (action && responseEntries(action.operation).length === 0) {
    blockers.push(blocker("action-success-status-undocumented", "The action has no explicit 2xx response status in the approved material.", "Document and confirm the exact accepted success statuses before compiling an action binding."));
  }
  if (observer && responseEntries(observer.operation).length === 0) {
    blockers.push(blocker("observer-success-status-undocumented", "The observer has no explicit 2xx response status in the approved material.", "Document and confirm the observer's accepted success statuses before compiling a read-side binding."));
  }
  if (observer?.metadata.paginationParameterCandidates.length) {
    blockers.push(blocker(
      "observer-pagination-semantics-unbound",
      `The observer exposes pagination candidates (${observer.metadata.paginationParameterCandidates.join(", ")}) but static material does not prove continuation or completeness semantics.`,
      "Implement and qualify exact pagination continuation, stop, maximum-page, and incomplete-page behavior before using this observer for absence, count, duplicate, or collateral claims.",
    ));
  }

  const authority = outer.authorityCompilation;
  const allowedSecrets = candidateAuthority.allowedSecretAliases;
  if (!allowedSecrets.includes(facts.action.credentialAlias)) blockers.push(blocker("action-credential-alias-outside-authority", "The action credential alias is outside the explicitly reviewed authority candidate.", "Add the alias through the authority wizard and re-review the authority compilation."));
  if (!allowedSecrets.includes(facts.observer.credentialAlias)) blockers.push(blocker("observer-credential-alias-outside-authority", "The observer credential alias is outside the explicitly reviewed authority candidate.", "Add a separately scoped read credential alias through the authority wizard and re-review."));
  if (action && !securityAliases(action).includes(facts.action.credentialAlias)) blockers.push(blocker("action-auth-alias-undocumented", "The action credential alias is not declared by the selected OpenAPI operation.", "Bind the customer-local credential alias to an exact documented security scheme through explicit review."));
  if (observer && !securityAliases(observer).includes(facts.observer.credentialAlias)) blockers.push(blocker("observer-auth-alias-undocumented", "The read-side credential alias is not declared by the selected observer operation.", "Bind a separately scoped observer alias to the exact documented read-side security scheme."));
  if (action && !authority.guardrails.exactWriteRules.some((rule) => rule.actionName === action.metadata.operationId
    && rule.targetAlias === facts.targetAlias && rule.method === action.metadata.method)) {
    blockers.push(blocker("action-operation-outside-authority", "No exact reviewed write rule covers the selected target, method, and operation.", "Confirm the exact write through the authority wizard; do not widen target or method scope."));
  }
  if (observer && !authority.guardrails.allowedReadActions.some((rule) => rule.actionName === observer.metadata.operationId && rule.targetAlias === facts.targetAlias)) {
    blockers.push(blocker("observer-operation-outside-authority", "No exact reviewed read rule covers the observer operation.", "Confirm the observer GET/HEAD operation through the authority wizard."));
  }

  if (action) {
    const parameters = operationParameters(action);
    for (const parameter of parameters.filter((candidate) => candidate.required)) {
      if (!facts.action.requestMappings.some((mapping) => mapping.destination.location === parameter.location && "name" in mapping.destination && mapping.destination.name === parameter.name)) {
        blockers.push(blocker("required-action-parameter-unbound", `Required ${parameter.location} parameter ${parameter.name} has no confirmed mapping.`, `Map ${parameter.name} from one exact workflow input or trusted-context field.`));
      }
    }
    for (const mapping of facts.action.requestMappings.filter((candidate) => candidate.destination.location !== "json-body")) {
      const destination = mapping.destination as { location: string; name: string };
      if (!parameters.some((parameter) => parameter.location === destination.location && parameter.name === destination.name)) {
        blockers.push(blocker("undocumented-action-parameter", `Action mapping targets undocumented ${destination.location} parameter ${destination.name}.`, "Remove the mapping or provide approved OpenAPI material documenting the exact parameter."));
      }
      if (destination.location === "header" && /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i.test(destination.name)) {
        blockers.push(blocker("credential-header-mapped-as-workflow-data", `Credential-bearing header ${destination.name} cannot be populated from workflow input or ordinary context.`, "Remove the mapping and resolve the reviewed credential alias only inside the customer-local runtime boundary."));
      }
    }
    const body = topLevelBodyFields(requestBodySchema(action.operation));
    if (!body.reusable) blockers.push(blocker("action-request-schema-outside-v1-primitives", "The action request body uses nested or compositional schema features outside Binding Factory v1.", "Implement and test a customer-specific structured request translator or extend the trusted binding primitive registry."));
    for (const required of body.required) {
      if (!facts.action.requestMappings.some((mapping) => mapping.destination.location === "json-body" && mapping.destination.path.length === 1 && mapping.destination.path[0] === required)) {
        blockers.push(blocker("required-action-body-field-unbound", `Required request body field ${required} has no confirmed mapping.`, `Map ${required} from one exact workflow input or trusted-context field.`));
      }
    }
    for (const mapping of facts.action.requestMappings) {
      if (mapping.destination.location !== "json-body") continue;
      const bodyPath = mapping.destination.path;
      if (bodyPath.length !== 1 || typeof bodyPath[0] !== "string" || !body.documented.includes(bodyPath[0])) {
        blockers.push(blocker("undocumented-action-body-field", `Action mapping targets an unsupported or undocumented JSON body path ${bodyPath.join(".")}.`, "Use a documented top-level request field or implement a separately reviewed structured request translator."));
      }
    }
  }

  if (observer) {
    const parameters = operationParameters(observer);
    for (const parameter of parameters.filter((candidate) => candidate.required)) {
      if (!facts.observer.parameterBindings.some((mapping) => mapping.location === parameter.location && mapping.name === parameter.name)) {
        blockers.push(blocker("required-observer-parameter-unbound", `Required observer ${parameter.location} parameter ${parameter.name} has no confirmed mapping.`, `Bind ${parameter.name} from a stable identifier or confirmed filter available before execution.`));
      }
    }
    for (const binding of facts.observer.parameterBindings) {
      if (!parameters.some((parameter) => parameter.location === binding.location && parameter.name === binding.name)) {
        blockers.push(blocker("undocumented-observer-parameter", `Observer binding targets undocumented ${binding.location} parameter ${binding.name}.`, "Remove the binding or supply approved material documenting the exact parameter."));
      }
      const sourceKey = binding.source.kind === "workflow-input" ? binding.source.inputKey : binding.source.contextKey;
      if (binding.purpose === "stable-identifier" && !facts.action.requestMappings.some((mapping) => {
        const actionKey = mapping.source.kind === "workflow-input" ? mapping.source.inputKey : mapping.source.contextKey;
        return actionKey === sourceKey;
      })) {
        blockers.push(blocker("stable-identifier-not-action-independent", `Stable identifier ${sourceKey} is not present in the confirmed pre-action request/context mappings.`, "Use a business key known before execution; never depend on an action response for lost-response reconciliation."));
      }
    }
    const successResponses = responseEntries(observer.operation);
    const responseSchemas = successResponses.map((entry) => jsonSchemaFromResponse(entry.response)).filter((schema): schema is JsonRecord => schema !== undefined);
    if (responseSchemas.length === 0 || !responseSchemas.some((schema) => schemaAtPath(schema, facts.observer.resultPath))) {
      blockers.push(blocker("observer-result-path-undocumented", `The confirmed observer result path ${facts.observer.resultPath.join(".")} is not present in a documented JSON success response.`, "Confirm a documented result path or implement a customer-specific response translator with its own qualification."));
    }
    for (const predicate of [
      ...facts.outcome.predicates,
      ...facts.outcome.notStartedDefinition,
      ...facts.outcome.collateralChecks,
    ]) {
      if (!responseSchemas.some((schema) => schemaAtPath(schema, predicate.path))) {
        blockers.push(blocker("outcome-predicate-path-undocumented", `Outcome predicate ${predicate.key} uses undocumented response path ${predicate.path.join(".")}.`, "Bind the predicate to a documented observer response field or implement and qualify a customer-specific response translator."));
      }
    }
    if (!responseSchemas.some((schema) => schemaAtRelativeItemPath(
      schema,
      facts.outcome.duplicateCheck.collectionPath,
      facts.outcome.duplicateCheck.uniqueKeyPath,
    ))) {
      blockers.push(blocker("duplicate-check-path-undocumented", "The duplicate check does not resolve to a documented array plus item-level unique-key path.", "Confirm a documented collection and stable item key, or implement and qualify customer-specific duplicate detection."));
    }
    if (facts.observer.freshness.kind === "server-timestamp-body") {
      const freshnessPath = facts.observer.freshness.path;
      if (!responseSchemas.some((schema) => schemaAtPath(schema, freshnessPath))) {
        blockers.push(blocker("observer-freshness-signal-undocumented", "The selected body timestamp is not present in a documented observer response schema.", "Provide a documented trusted server timestamp/version/sequence signal or implement and qualify an approved equivalent."));
      }
    } else {
      const header = facts.observer.freshness.headerName.toLowerCase();
      const documented = successResponses.some(({ response }) => {
        const headers = response.headers && typeof response.headers === "object" && !Array.isArray(response.headers) ? response.headers as JsonRecord : {};
        return Object.keys(headers).some((name) => name.toLowerCase() === header);
      });
      if (!documented) blockers.push(blocker("observer-freshness-signal-undocumented", `Freshness header ${facts.observer.freshness.headerName} is not documented on a successful observer response.`, "Document and confirm a trusted server timestamp/version/ETag signal or implement and qualify an approved equivalent."));
    }
  }

  if (containsCredentialValue(facts.outcome)) throw new Error("Outcome facts contain credential-shaped content.");
  const factsDigest = digest(facts);
  const engineeringWorkRemaining = unique(blockers.map((item) => item.requiredEngineeringWork));
  let actionBinding: HttpActionBindingDeclaration | undefined;
  let observerBinding: HttpObserverBindingDeclaration | undefined;
  if (blockers.length === 0 && action && observer) {
    const actionProvenance = {
      normalizedMaterialDigest: outer.normalization.normalizedMaterialDigest,
      normalizationReceiptDigest: outer.normalization.normalizationReceiptDigest,
      authorityCompilationDigest: authority.compilationDigest,
      confirmedFactsDigest: factsDigest,
    };
    const observerProvenance = {
      normalizedMaterialDigest: observerNormalization.normalizedMaterialDigest,
      normalizationReceiptDigest: observerNormalization.normalizationReceiptDigest,
      authorityCompilationDigest: authority.compilationDigest,
      confirmedFactsDigest: factsDigest,
    };
    const actionStatuses = responseEntries(action.operation).map((entry) => entry.status);
    const observerStatuses = responseEntries(observer.operation).map((entry) => entry.status);
    const writeRule = authority.guardrails.exactWriteRules.find((rule) => rule.actionName === action.metadata.operationId
      && rule.targetAlias === facts.targetAlias && rule.method === action.metadata.method)!;
    const stableIdentifier = facts.observer.parameterBindings.find((binding) => binding.purpose === "stable-identifier")!;
    actionBinding = finalizeDeclaration({
      schemaVersion: "1.0" as const,
      kind: "constrained-http-action-binding-declaration" as const,
      state: "proposal-only" as const,
      executable: false as const,
      qualified: false as const,
      activated: false as const,
      driverId: facts.action.driverId,
      targetAlias: facts.targetAlias,
      serverUrl: outer.normalization.confirmedServerUrl!,
      operation: {
        operationId: action.metadata.operationId,
        method: action.metadata.method as "POST" | "PUT" | "PATCH" | "DELETE",
        pathTemplate: action.metadata.path,
      },
      credentialAlias: facts.action.credentialAlias,
      requestMappings: structuredClone(facts.action.requestMappings),
      reconciliationKeySource: structuredClone(stableIdentifier.source),
      acceptedStatuses: actionStatuses,
      authorityPolicy: writeRule.policy,
      retry: { reconcileBeforeRetry: true as const, blindRetryAllowed: false as const },
      provenance: { ...actionProvenance, operationPointer: action.pointer },
    });
    observerBinding = finalizeDeclaration({
      schemaVersion: "1.0" as const,
      kind: "independent-http-observer-binding-declaration" as const,
      state: "proposal-only" as const,
      executable: false as const,
      qualified: false as const,
      activated: false as const,
      driverId: facts.observer.driverId,
      sourceId: facts.observer.sourceId,
      targetAlias: facts.targetAlias,
      serverUrl: observerNormalization.confirmedServerUrl!,
      operation: {
        operationId: observer.metadata.operationId,
        method: observer.metadata.method as "GET" | "HEAD",
        pathTemplate: observer.metadata.path,
      },
      credentialAlias: facts.observer.credentialAlias,
      parameterBindings: structuredClone(facts.observer.parameterBindings),
      resultPath: [...facts.observer.resultPath],
      acceptedStatuses: observerStatuses,
      freshness: { ...structuredClone(facts.observer.freshness), notBeforeBoundary: "trusted-operation-start" as const },
      predicates: structuredClone(facts.outcome.predicates),
      notStartedDefinition: structuredClone(facts.outcome.notStartedDefinition),
      duplicateCheck: structuredClone(facts.outcome.duplicateCheck),
      collateralChecks: structuredClone(facts.outcome.collateralChecks),
      actionResponseEligibleAsProof: false as const,
      provenance: { ...observerProvenance, operationPointer: observer.pointer },
    });
  }
  const unsigned: Omit<HttpBindingFactoryResult, "resultDigest"> = {
    schemaVersion: HTTP_BINDING_FACTORY_VERSION,
    status: blockers.length === 0 ? "review-required" : "blocked",
    executable: false,
    qualified: false,
    activated: false,
    ...(actionBinding ? { actionBinding } : {}),
    ...(observerBinding ? { observerBinding } : {}),
    blockers,
    engineeringWorkRemaining,
    automationMetrics: {
      humanStudy: false,
      humanActiveMinutes: null,
      confirmedFactCount: countLeaves(facts),
      generatedActionDeclarationFields: actionBinding ? countLeaves(actionBinding) : 0,
      generatedObserverDeclarationFields: observerBinding ? countLeaves(observerBinding) : 0,
      executableCodeLinesGenerated: 0,
      qualificationControlsRun: 0,
    },
    onboardingProjection: {
      state: blockers.length === 0 ? "binding-declarations-ready" : "blocked",
      acceptanceReviewDigestsEligible: false,
      authorityRuntimeBindingDigest: null,
      observationAdapterBindingDigest: null,
      exactNextGates: blockers.length > 0
        ? engineeringWorkRemaining
        : [
            "Compile the action declaration into a customer-local runtime binding and qualify it without widening its reviewed target, method, request, credential, or authority facts.",
            "Compile the observer declaration into a separately authenticated read-side adapter and pass the mandatory verifier-template negative controls.",
            "Only then bind the qualified implementation digests into the onboarding review and execute the fixed acceptance campaign.",
          ],
      evidenceBoundary: "Generated declarations reduce repeated specification work but are not executable bindings, eligible onboarding-review digests, passing verifier evidence, activation, or a human-time result.",
    },
  };
  const result = { ...unsigned, resultDigest: digest(unsigned) };
  assertHttpBindingFactoryResultIntegrity(result);
  return result;
}
