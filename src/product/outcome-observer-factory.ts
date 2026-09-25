import { createHash } from "node:crypto";
import { z } from "zod";
import {
  discoverAdapterProposal,
  type ApprovedOpenApiMaterial,
  type JsonValue,
} from "./onboarding-adapter-factory.js";
import {
  proposeExternalOutcomeVerifier,
  type ProvisionalVerifierContract,
} from "./onboarding-verifier-authority.js";
import type {
  OutcomeCriterion,
  UniversalObservationAdapter,
  UniversalObservationContext,
} from "./universal-verifier.js";

export const OUTCOME_OBSERVER_FACTORY_SCHEMA_VERSION = "1.0" as const;

const identifier = z.string().min(1).max(180).regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/);
const boundedText = z.string().trim().min(1).max(2_000);
const pathSegment = z.union([identifier, z.number().int().nonnegative()]);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/).refine((value) => !/^0+$/.test(value), "Digest cannot be all zeroes.");
const secretShaped = /(?:bearer\s+[a-z0-9._~+\/-]{8,}|sk-[a-z0-9_-]{12,}|password\s*[:=]|(?:api[_ -]?key|client[_ -]?secret|access[_ -]?token)\s*[:=]\s*["']?[^\s"']{6,})/i;

const confirmedValueSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.union([z.string().max(1_000), z.number().finite(), z.boolean()]), confirmed: z.literal(true) }).strict(),
  z.object({ kind: z.literal("context-field"), field: z.enum(["tenantId", "requestId", "parentGoalId", "operationKey"]), confirmed: z.literal(true) }).strict(),
  z.object({ kind: z.literal("context-reference"), referenceKey: identifier, confirmed: z.literal(true) }).strict(),
]);
export type ConfirmedObserverValueSource = z.infer<typeof confirmedValueSourceSchema>;

const parameterBindingSchema = z.object({
  name: identifier,
  location: z.enum(["path", "query"]),
  role: z.enum(["stable-id", "confirmed-filter", "other-confirmed"]),
  valueSource: confirmedValueSourceSchema,
  confirmed: z.literal(true),
}).strict();

const readPrimitiveSchema = z.object({
  key: identifier,
  primitive: z.enum(["fetch-resource", "query-collection"]),
  operationName: identifier,
  parameterBindings: z.array(parameterBindingSchema).max(32),
  resultPath: z.array(pathSegment).max(24),
  expectedStatuses: z.array(z.number().int().min(200).max(299)).min(1).max(16),
  confirmed: z.literal(true),
}).strict();

const predicateBase = {
  key: identifier,
  observationKey: identifier,
  path: z.array(pathSegment).max(24),
  confirmed: z.literal(true),
};

export const observerPredicateSchema = z.discriminatedUnion("operator", [
  z.object({ ...predicateBase, operator: z.literal("equals"), expected: z.unknown() }).strict(),
  z.object({ ...predicateBase, operator: z.literal("not-equals"), expected: z.unknown() }).strict(),
  z.object({ ...predicateBase, operator: z.literal("exists") }).strict(),
  z.object({ ...predicateBase, operator: z.literal("absent") }).strict(),
  z.object({ ...predicateBase, operator: z.literal("count-equals"), expected: z.number().int().nonnegative() }).strict(),
  z.object({ ...predicateBase, operator: z.literal("bounded-number"), minimum: z.number().finite().optional(), maximum: z.number().finite().optional() }).strict()
    .refine((value) => value.minimum !== undefined || value.maximum !== undefined, "A bounded comparison needs a minimum or maximum."),
  z.object({ ...predicateBase, operator: z.literal("contains"), expected: z.unknown() }).strict(),
  z.object({ ...predicateBase, operator: z.literal("set-includes"), expected: z.array(z.unknown()).max(256) }).strict(),
  z.object({ ...predicateBase, operator: z.literal("set-excludes"), forbidden: z.array(z.unknown()).max(256) }).strict(),
  z.object({ ...predicateBase, operator: z.literal("unique-by-key"), itemPath: z.array(pathSegment).min(1).max(12) }).strict(),
  z.object({
    ...predicateBase,
    operator: z.literal("relational-equals"),
    otherObservationKey: identifier,
    otherPath: z.array(pathSegment).max(24),
  }).strict(),
  z.object({ ...predicateBase, operator: z.literal("changed-from-baseline"), baseline: z.unknown() }).strict(),
  z.object({ ...predicateBase, operator: z.literal("sum-equals"), expected: z.number().finite() }).strict(),
  z.object({ ...predicateBase, operator: z.literal("all-equal"), expected: z.unknown() }).strict(),
]);
export type ObserverPredicate = z.infer<typeof observerPredicateSchema>;

const freshnessSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("server-timestamp-header"), readKey: identifier, headerName: identifier, confirmed: z.literal(true) }).strict(),
  z.object({ kind: z.literal("server-timestamp-body"), readKey: identifier, path: z.array(pathSegment).max(24), confirmed: z.literal(true) }).strict(),
  z.object({ kind: z.literal("etag-header"), readKey: identifier, headerName: identifier, baseline: confirmedValueSourceSchema, confirmed: z.literal(true) }).strict(),
  z.object({ kind: z.literal("version-body"), readKey: identifier, path: z.array(pathSegment).max(24), baseline: confirmedValueSourceSchema, confirmed: z.literal(true) }).strict(),
  z.object({ kind: z.literal("sequence-body"), readKey: identifier, path: z.array(pathSegment).max(24), baseline: confirmedValueSourceSchema, confirmed: z.literal(true) }).strict(),
  z.object({ kind: z.literal("approved-equivalent"), readKey: identifier, path: z.array(pathSegment).max(24), baseline: confirmedValueSourceSchema, comparator: z.literal("changed-from-baseline"), rationale: boundedText, confirmed: z.literal(true) }).strict(),
]);

export const outcomeObserverFactoryInputSchema = z.object({
  schemaVersion: z.literal(OUTCOME_OBSERVER_FACTORY_SCHEMA_VERSION),
  observerKey: identifier,
  targetAlias: identifier,
  ordinaryBusinessOutcome: boundedText,
  outcomeConfirmed: z.literal(true),
  executionDriverId: identifier,
  observationDriverId: identifier,
  approvedOpenApiMaterial: z.custom<ApprovedOpenApiMaterial>((value) => Boolean(value && typeof value === "object" && (value as { kind?: unknown }).kind === "openapi")),
  reads: z.array(readPrimitiveSchema).min(1).max(32),
  successPredicates: z.array(observerPredicateSchema).min(1).max(48),
  notStartedPredicates: z.array(observerPredicateSchema).min(1).max(24),
  duplicateCheck: z.object({ observationKey: identifier, path: z.array(pathSegment).max(24), expectedCount: z.number().int().nonnegative(), confirmed: z.literal(true) }).strict(),
  collateralChecks: z.array(observerPredicateSchema).min(1).max(32),
  freshness: z.object({
    observationKey: identifier,
    source: freshnessSourceSchema,
    maximumAgeSeconds: z.number().int().positive().max(86_400),
    maximumFutureSkewSeconds: z.number().int().nonnegative().max(3_600),
    confirmed: z.literal(true),
  }).strict(),
}).strict().superRefine((input, context) => {
  if (input.executionDriverId === input.observationDriverId) {
    context.addIssue({ code: "custom", path: ["observationDriverId"], message: "Observation and execution must use separate driver identities." });
  }
  if (secretShaped.test(canonical(input))) {
    context.addIssue({ code: "custom", message: "Observer input contains a credential-shaped value; use aliases and customer-local resolution only." });
  }
  const keys = input.reads.map((read) => read.key);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", path: ["reads"], message: "Read primitive keys must be unique." });
  const predicateKeys = [...input.successPredicates, ...input.notStartedPredicates, ...input.collateralChecks].map((predicate) => predicate.key);
  if (new Set(predicateKeys).size !== predicateKeys.length) context.addIssue({ code: "custom", message: "Observer predicate keys must be unique across every classification role." });
});
export type OutcomeObserverFactoryInput = z.infer<typeof outcomeObserverFactoryInputSchema>;

export interface OutcomeObserverBlocker {
  blockerId: string;
  detail: string;
  requiredEngineeringWork: string;
}

export interface ProposedObserverRead {
  key: string;
  primitive: "fetch-resource" | "query-collection";
  operationKey: string;
  method: "GET" | "HEAD";
  pathTemplate: string;
  credentialAliases: string[];
  parameterBindings: z.infer<typeof parameterBindingSchema>[];
  resultPath: Array<string | number>;
  expectedStatuses: number[];
}

export interface OutcomeObserverProposal {
  schemaVersion: typeof OUTCOME_OBSERVER_FACTORY_SCHEMA_VERSION;
  proposalId: string;
  status: "review-required" | "blocked";
  executable: false;
  activation: "blocked";
  targetAlias: string;
  ordinaryBusinessOutcome: string;
  executionDriverId: string;
  observationDriverId: string;
  approvedMaterialDigest: string;
  reads: ProposedObserverRead[];
  successPredicates: ObserverPredicate[];
  notStartedPredicates: ObserverPredicate[];
  duplicateCheck: OutcomeObserverFactoryInput["duplicateCheck"];
  collateralChecks: ObserverPredicate[];
  freshness: OutcomeObserverFactoryInput["freshness"];
  credentialAliases: string[];
  observationKeys: string[];
  verifierIntakeDraft: {
    successCriteria: OutcomeCriterion[];
    duplicateObservationKey: string;
    collateralEffectObservationKey: string;
    freshnessObservationKey: string;
  };
  unknowns: string[];
  blockers: OutcomeObserverBlocker[];
  proposalDigest: string;
}

export interface OutcomeObserverHttpRequest {
  requestKey: string;
  operationKey: string;
  targetAlias: string;
  method: "GET" | "HEAD";
  path: string;
  query: Record<string, string>;
  credentialAliases: string[];
  expectedStatuses: number[];
  context: UniversalObservationContext;
}

export interface OutcomeObserverHttpResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface OutcomeObserverHttpTransport {
  driverId: string;
  sourceId: string;
  implementationDigest: string;
  approvedMaterialDigest: string;
  readOnlyCredentialAliases: string[];
  independentFromExecutionDriverIds: string[];
  independenceReview: {
    reviewId: string;
    reviewDigest: string;
    status: "independently-reviewed";
  };
  read(request: OutcomeObserverHttpRequest): Promise<OutcomeObserverHttpResponse>;
}

export interface OutcomeObserverValueResolver {
  resolverId: string;
  implementationDigest: string;
  resolve(referenceKey: string, context: UniversalObservationContext): Promise<string | number | boolean | undefined>;
}

export const outcomeObserverBindingSchema = z.object({
  proposalDigest: digestSchema,
  approvedMaterialDigest: digestSchema,
  observationDriverDigest: digestSchema,
  observationSourceId: identifier,
  observationSourceDigest: digestSchema,
  readOnlyCredentialAliasesDigest: digestSchema,
  independenceReviewDigest: digestSchema,
  valueResolverDigest: z.union([digestSchema, z.literal("not-required")]),
  confirmedByAlias: identifier,
  confirmedAt: z.string().datetime(),
  operationStartedAtEpochMs: z.number().int().nonnegative(),
  freshnessBaselineCapturedAtEpochMs: z.number().int().nonnegative(),
  factsConfirmed: z.literal(true),
}).strict();
export type OutcomeObserverBinding = z.infer<typeof outcomeObserverBindingSchema>;

export type ObserverOutcomeClassification = "completed" | "not-started" | "partial" | "incorrect" | "stale" | "duplicate" | "collateral" | "unknown";

export interface ObserverInspectionReceipt {
  schemaVersion: "1.0";
  observerId: string;
  observerVersion: "1.0";
  proposalDigest: string;
  bindingDigest: string;
  classification: ObserverOutcomeClassification;
  passed: boolean;
  duplicateDetected: boolean;
  collateralDetected: boolean;
  stateDigest: string;
  checks: Array<{ key: string; role: "success" | "not-started" | "duplicate" | "collateral" | "freshness"; passed: boolean; detail: string }>;
  observedAt: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function outcomeObserverSourceDigest(value: unknown): string {
  return digest(value);
}

function proposalIntegrityPayload(proposal: Omit<OutcomeObserverProposal, "proposalId" | "proposalDigest"> | OutcomeObserverProposal): unknown {
  const { proposalId: _proposalId, proposalDigest: _proposalDigest, ...payload } = proposal as OutcomeObserverProposal;
  return payload;
}

export function assertOutcomeObserverProposalIntegrity(proposal: OutcomeObserverProposal): void {
  const recalculated = digest(proposalIntegrityPayload(proposal));
  if (recalculated !== proposal.proposalDigest || proposal.proposalId !== `observer-proposal-${recalculated.slice(0, 24)}`) {
    throw new Error("Outcome observer proposal content does not match its integrity digest.");
  }
  if (proposal.executable !== false || proposal.activation !== "blocked") throw new Error("Outcome observer proposals must remain non-executable and activation-blocked.");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function readPath(root: unknown, path: Array<string | number>): { exists: boolean; value: unknown } {
  let current = root;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) return { exists: false, value: undefined };
      current = current[segment];
    } else {
      if (!current || typeof current !== "object" || !(segment in current)) return { exists: false, value: undefined };
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return { exists: true, value: current };
}

function parameterInventory(material: ApprovedOpenApiMaterial, operationName: string): Array<{ name: string; location: string; required: boolean }> {
  const document = material.document as Record<string, unknown>;
  const paths = document.paths && typeof document.paths === "object" && !Array.isArray(document.paths) ? document.paths as Record<string, unknown> : {};
  for (const pathItemValue of Object.values(paths)) {
    if (!pathItemValue || typeof pathItemValue !== "object" || Array.isArray(pathItemValue)) continue;
    const pathItem = pathItemValue as Record<string, unknown>;
    for (const method of ["get", "head"]) {
      const operationValue = pathItem[method];
      if (!operationValue || typeof operationValue !== "object" || Array.isArray(operationValue)) continue;
      const operation = operationValue as Record<string, unknown>;
      if (operation.operationId !== operationName) continue;
      const parameters = [...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])];
      return parameters.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const parameter = value as Record<string, unknown>;
        return typeof parameter.name === "string" && typeof parameter.in === "string"
          ? [{ name: parameter.name, location: parameter.in, required: parameter.required === true || parameter.in === "path" }]
          : [];
      });
    }
  }
  return [];
}

function evaluatePredicate(predicate: ObserverPredicate, observations: Record<string, unknown>): boolean {
  const root = Object.hasOwn(observations, predicate.observationKey) ? observations[predicate.observationKey] : undefined;
  const observed = readPath(root, predicate.path);
  if (predicate.operator === "exists") return observed.exists;
  if (predicate.operator === "absent") return !observed.exists;
  if (!observed.exists) return false;
  if (predicate.operator === "equals") return canonical(observed.value) === canonical(predicate.expected);
  if (predicate.operator === "not-equals") return canonical(observed.value) !== canonical(predicate.expected);
  if (predicate.operator === "count-equals") return Array.isArray(observed.value) && observed.value.length === predicate.expected;
  if (predicate.operator === "bounded-number") {
    return typeof observed.value === "number"
      && (predicate.minimum === undefined || observed.value >= predicate.minimum)
      && (predicate.maximum === undefined || observed.value <= predicate.maximum);
  }
  if (predicate.operator === "contains") {
    return Array.isArray(observed.value)
      ? observed.value.some((value) => canonical(value) === canonical(predicate.expected))
      : typeof observed.value === "string" && typeof predicate.expected === "string" && observed.value.includes(predicate.expected);
  }
  if (predicate.operator === "set-includes") {
    const values = Array.isArray(observed.value) ? observed.value : undefined;
    return Boolean(values
      && predicate.expected.every((expected) => values.some((value: unknown) => canonical(value) === canonical(expected))));
  }
  if (predicate.operator === "set-excludes") {
    const values = Array.isArray(observed.value) ? observed.value : undefined;
    return Boolean(values
      && predicate.forbidden.every((forbidden) => values.every((value: unknown) => canonical(value) !== canonical(forbidden))));
  }
  if (predicate.operator === "unique-by-key") {
    if (!Array.isArray(observed.value)) return false;
    const values = observed.value.map((item) => readPath(item, predicate.itemPath));
    return values.every((item) => item.exists)
      && new Set(values.map((item) => canonical(item.value))).size === values.length;
  }
  if (predicate.operator === "relational-equals") {
    const otherRoot = Object.hasOwn(observations, predicate.otherObservationKey)
      ? observations[predicate.otherObservationKey]
      : undefined;
    const other = readPath(otherRoot, predicate.otherPath);
    return other.exists && canonical(observed.value) === canonical(other.value);
  }
  if (predicate.operator === "changed-from-baseline") return canonical(observed.value) !== canonical(predicate.baseline);
  if (predicate.operator === "sum-equals") {
    return Array.isArray(observed.value) && observed.value.every((value) => typeof value === "number")
      && observed.value.reduce((sum, value) => sum + Number(value), 0) === predicate.expected;
  }
  return Array.isArray(observed.value) && observed.value.every((value) => canonical(value) === canonical(predicate.expected));
}

function blocker(blockerId: string, detail: string, requiredEngineeringWork: string): OutcomeObserverBlocker {
  return { blockerId, detail, requiredEngineeringWork };
}

export function proposeOutcomeObserver(raw: unknown): OutcomeObserverProposal {
  const parsed = outcomeObserverFactoryInputSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Outcome observer input failed strict validation: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  const input = parsed.data;
  if (!input.approvedOpenApiMaterial.approved || input.approvedOpenApiMaterial.targetAlias !== input.targetAlias) {
    throw new Error("Outcome observer material must be explicitly approved and bound to the exact target alias.");
  }
  const adapterProposal = discoverAdapterProposal({
    schemaVersion: "1.0",
    workflow: {
      workflowId: `${input.observerKey}-observation`,
      summary: `Observe ${input.ordinaryBusinessOutcome}`,
      requiredOutcome: input.ordinaryBusinessOutcome,
      approvedTargetAliases: [input.targetAlias],
      requestedOperationNames: input.reads.map((read) => read.operationName),
      customerConfirmed: true,
    },
    materials: [input.approvedOpenApiMaterial],
  });
  const blockers: OutcomeObserverBlocker[] = [];
  const unknowns: string[] = [];
  const reads: ProposedObserverRead[] = [];
  const readKeys = new Set(input.reads.map((read) => read.key));

  for (const requested of input.reads) {
    const operations = adapterProposal.operations.filter((operation) => operation.operationId.value === requested.operationName && operation.targetAlias.value === input.targetAlias);
    if (operations.length !== 1) {
      blockers.push(blocker("observation-operation-unresolved", `Read ${requested.key} does not map to exactly one approved operation.`, `Select one exact target-qualified read operation for ${requested.key}.`));
      continue;
    }
    const operation = operations[0]!;
    const [method, pathTemplate] = operation.transportAction.value.split(" ", 2);
    if (operation.sourceKind.value !== "http" || operation.consequence.value !== "read" || !["GET", "HEAD"].includes(method ?? "")) {
      blockers.push(blocker("observation-operation-not-read-only", `${operation.operationKey.value} is not a supported HTTP GET/HEAD observation path.`, "Provide an approved independent read-side HTTP operation or implement a separate observer driver."));
      continue;
    }
    const inventory = parameterInventory(input.approvedOpenApiMaterial, requested.operationName);
    const duplicates = requested.parameterBindings.filter((binding, index, all) => all.findIndex((other) => other.name === binding.name && other.location === binding.location) !== index);
    if (duplicates.length > 0) blockers.push(blocker("duplicate-parameter-binding", `Read ${requested.key} binds the same parameter more than once.`, "Remove duplicate path/query bindings."));
    for (const parameter of inventory.filter((item) => item.required)) {
      if (!requested.parameterBindings.some((binding) => binding.name === parameter.name && binding.location === parameter.location)) {
        blockers.push(blocker("required-observation-parameter-unbound", `${requested.key} leaves required ${parameter.location} parameter ${parameter.name} unbound.`, `Bind ${parameter.name} from a confirmed literal, context field, or customer-local context reference.`));
      }
    }
    for (const binding of requested.parameterBindings) {
      if (!inventory.some((parameter) => parameter.name === binding.name && parameter.location === binding.location)) {
        blockers.push(blocker("unknown-observation-parameter", `${requested.key} binds undocumented ${binding.location} parameter ${binding.name}.`, "Remove it or supply approved API material documenting that parameter."));
      }
    }
    if (requested.primitive === "fetch-resource" && !requested.parameterBindings.some((binding) => binding.location === "path" && binding.role === "stable-id")) {
      blockers.push(blocker("stable-id-unbound", `${requested.key} has no confirmed stable-ID path binding.`, "Bind the resource identifier through a customer-confirmed value source."));
    }
    if (requested.primitive === "query-collection" && !requested.parameterBindings.some((binding) => binding.location === "query" && binding.role === "confirmed-filter")) {
      blockers.push(blocker("collection-filter-unbound", `${requested.key} has no confirmed query filter.`, "Bind at least one documented filter that limits the independent collection observation."));
    }
    reads.push({
      key: requested.key,
      primitive: requested.primitive,
      operationKey: operation.operationKey.value,
      method: method as "GET" | "HEAD",
      pathTemplate: pathTemplate ?? "",
      credentialAliases: [...operation.credentialAliases.value],
      parameterBindings: structuredClone(requested.parameterBindings),
      resultPath: structuredClone(requested.resultPath),
      expectedStatuses: [...requested.expectedStatuses],
    });
  }

  for (const predicate of [...input.successPredicates, ...input.notStartedPredicates, ...input.collateralChecks]) {
    if (!readKeys.has(predicate.observationKey)) blockers.push(blocker("predicate-observation-unresolved", `Predicate ${predicate.key} references unknown observation ${predicate.observationKey}.`, "Map the predicate to one generated read observation."));
  }
  if (!readKeys.has(input.duplicateCheck.observationKey)) blockers.push(blocker("duplicate-observation-unresolved", "Duplicate detection references an unknown observation.", "Map duplicate detection to a confirmed collection read."));
  if (!readKeys.has(input.freshness.source.readKey)) blockers.push(blocker("freshness-observation-unresolved", "Freshness references an unknown observation read.", "Bind freshness to one approved generated read."));
  if (input.freshness.source.kind !== "server-timestamp-header" && input.freshness.source.kind !== "server-timestamp-body") {
    const baseline = input.freshness.source.baseline;
    if (baseline.kind === "context-reference") unknowns.push(`The customer-local value resolver must supply freshness baseline ${baseline.referenceKey}.`);
  }
  if (reads.some((read) => read.parameterBindings.some((binding) => binding.valueSource.kind === "context-reference"))) {
    unknowns.push("Bind a customer-local context-value resolver for dynamic stable IDs or confirmed filters.");
  }
  unknowns.push("Review the proposed read plans, predicates, collateral boundary, duplicate rule, and freshness proof before executable binding.");

  const selectedPredicateKeys = input.successPredicates.map((predicate) => `cf-success-${predicate.key}`);
  const collateralEffectObservationKey = "cf-collateral-effect-count";
  const observationKeys = unique([
    ...input.reads.map((read) => read.key),
    ...selectedPredicateKeys,
    input.duplicateCheck.observationKey,
    collateralEffectObservationKey,
    input.freshness.observationKey,
  ]);
  const criteria: OutcomeCriterion[] = input.successPredicates.map((predicate) => ({
    key: `observer-${predicate.key}`,
    observationKey: `cf-success-${predicate.key}`,
    path: [],
    operator: "equals",
    expected: true,
  }));
  const materialDigest = digest(input.approvedOpenApiMaterial);
  const proposalBody: Omit<OutcomeObserverProposal, "proposalId" | "proposalDigest"> = {
    schemaVersion: OUTCOME_OBSERVER_FACTORY_SCHEMA_VERSION,
    status: blockers.length === 0 ? "review-required" : "blocked",
    executable: false,
    activation: "blocked",
    targetAlias: input.targetAlias,
    ordinaryBusinessOutcome: input.ordinaryBusinessOutcome,
    executionDriverId: input.executionDriverId,
    observationDriverId: input.observationDriverId,
    approvedMaterialDigest: materialDigest,
    reads,
    successPredicates: structuredClone(input.successPredicates),
    notStartedPredicates: structuredClone(input.notStartedPredicates),
    duplicateCheck: structuredClone(input.duplicateCheck),
    collateralChecks: structuredClone(input.collateralChecks),
    freshness: structuredClone(input.freshness),
    credentialAliases: unique(reads.flatMap((read) => read.credentialAliases)).sort(),
    observationKeys,
    verifierIntakeDraft: {
      successCriteria: criteria,
      duplicateObservationKey: input.duplicateCheck.observationKey,
      collateralEffectObservationKey,
      freshnessObservationKey: input.freshness.observationKey,
    },
    unknowns,
    blockers,
  };
  const proposalDigest = digest(proposalIntegrityPayload(proposalBody));
  return { ...proposalBody, proposalId: `observer-proposal-${proposalDigest.slice(0, 24)}`, proposalDigest };
}

async function resolveValue(
  source: ConfirmedObserverValueSource,
  context: UniversalObservationContext,
  resolver: OutcomeObserverValueResolver | undefined,
): Promise<string | number | boolean> {
  if (source.kind === "literal") return source.value;
  if (source.kind === "context-field") return context[source.field];
  if (!resolver) throw new Error(`Customer-local context resolver is missing for ${source.referenceKey}.`);
  const value = await resolver.resolve(source.referenceKey, context);
  if (value === undefined) throw new Error(`Customer-local context reference ${source.referenceKey} did not resolve.`);
  if (secretShaped.test(String(value))) throw new Error(`Context reference ${source.referenceKey} resolved to a credential-shaped value.`);
  return value;
}

function header(response: OutcomeObserverHttpResponse, name: string): string | undefined {
  const match = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1];
}

function freshnessError(message: string): Error & { observerClassification: "stale" | "unknown" } {
  return Object.assign(new Error(message), { observerClassification: message.includes("stale") || message.includes("predates") ? "stale" as const : "unknown" as const });
}

export class ExecutableOutcomeObserver implements UniversalObservationAdapter {
  readonly key: string;
  readonly sourceId: string;
  readonly priority = 10;
  readonly observationKeys: string[];
  readonly independentFromDriverIds: string[];
  readonly observerId: string;

  constructor(
    readonly proposal: OutcomeObserverProposal,
    readonly binding: OutcomeObserverBinding,
    private readonly transport: OutcomeObserverHttpTransport,
    private readonly resolver: OutcomeObserverValueResolver | undefined,
    private readonly now: () => number,
  ) {
    this.key = `${proposal.proposalId}.bound`;
    this.sourceId = transport.sourceId;
    this.observationKeys = [...proposal.observationKeys];
    this.independentFromDriverIds = [proposal.executionDriverId];
    this.observerId = `outcome-observer-${digest({ proposal: proposal.proposalDigest, binding: digest(binding) }).slice(0, 24)}`;
  }

  async observe(context: UniversalObservationContext): Promise<Record<string, unknown>> {
    return (await this.inspect(context)).observations;
  }

  async inspect(context: UniversalObservationContext): Promise<{ observations: Record<string, unknown>; receipt: ObserverInspectionReceipt }> {
    const observations: Record<string, unknown> = {};
    const responses = new Map<string, OutcomeObserverHttpResponse>();
    try {
      for (const read of this.proposal.reads) {
        let path = read.pathTemplate;
        const query: Record<string, string> = {};
        for (const parameter of read.parameterBindings) {
          const value = await resolveValue(parameter.valueSource, context, this.resolver);
          if (parameter.location === "path") path = path.replaceAll(`{${parameter.name}}`, encodeURIComponent(String(value)));
          else query[parameter.name] = String(value);
        }
        if (/\{[^}]+\}/.test(path)) throw new Error(`Observation path ${read.key} retains an unresolved path parameter.`);
        const response = await this.transport.read({
          requestKey: read.key,
          operationKey: read.operationKey,
          targetAlias: this.proposal.targetAlias,
          method: read.method,
          path,
          query,
          credentialAliases: [...read.credentialAliases],
          expectedStatuses: [...read.expectedStatuses],
          context,
        });
        if (!read.expectedStatuses.includes(response.status)) throw new Error(`Observation read ${read.key} returned unapproved HTTP status ${response.status}.`);
        responses.set(read.key, response);
        const selected = readPath(response.body, read.resultPath);
        if (!selected.exists) throw new Error(`Observation read ${read.key} did not expose the confirmed result path.`);
        observations[read.key] = selected.value;
      }

      const freshnessAdvanced = await this.checkFreshness(context, responses);
      const observedAt = new Date(this.now()).toISOString();
      observations[this.proposal.freshness.observationKey] = observedAt;
      for (const predicate of this.proposal.successPredicates) observations[`cf-success-${predicate.key}`] = evaluatePredicate(predicate, observations);
      const collateralResults = this.proposal.collateralChecks.map((predicate) => evaluatePredicate(predicate, observations));
      observations[this.proposal.verifierIntakeDraft.collateralEffectObservationKey] = collateralResults.filter((passed) => !passed).length;
      const receipt = this.classify(observations, observedAt, freshnessAdvanced);
      return { observations, receipt };
    } catch (error) {
      const classification = error && typeof error === "object" && "observerClassification" in error
        ? (error as { observerClassification: ObserverOutcomeClassification }).observerClassification
        : "unknown";
      const observedAt = new Date(this.now()).toISOString();
      return {
        observations: {},
        receipt: {
          schemaVersion: "1.0",
          observerId: this.observerId,
          observerVersion: "1.0",
          proposalDigest: this.proposal.proposalDigest,
          bindingDigest: digest(this.binding),
          classification,
          passed: false,
          duplicateDetected: false,
          collateralDetected: false,
          stateDigest: digest({}),
          checks: [{ key: "observation-available", role: "freshness", passed: false, detail: error instanceof Error ? error.message : "Independent observation failed closed." }],
          observedAt,
        },
      };
    }
  }

  private async checkFreshness(context: UniversalObservationContext, responses: Map<string, OutcomeObserverHttpResponse>): Promise<boolean> {
    const source = this.proposal.freshness.source;
    const response = responses.get(source.readKey);
    if (!response) throw freshnessError("Freshness observation response is unavailable.");
    const now = this.now();
    if (this.binding.operationStartedAtEpochMs - now > this.proposal.freshness.maximumFutureSkewSeconds * 1_000) {
      throw freshnessError("Trusted operation-start boundary is implausibly in the future.");
    }
    if (now - this.binding.operationStartedAtEpochMs > this.proposal.freshness.maximumAgeSeconds * 1_000) {
      throw freshnessError("Trusted operation-start boundary is stale; bind a fresh observer for this operation.");
    }
    if (this.binding.freshnessBaselineCapturedAtEpochMs > this.binding.operationStartedAtEpochMs) {
      throw freshnessError("Freshness baseline was captured after the trusted operation-start boundary.");
    }
    if (this.binding.operationStartedAtEpochMs - this.binding.freshnessBaselineCapturedAtEpochMs > this.proposal.freshness.maximumAgeSeconds * 1_000) {
      throw freshnessError("Freshness baseline is stale relative to the trusted operation-start boundary.");
    }
    if (source.kind === "server-timestamp-header" || source.kind === "server-timestamp-body") {
      const raw = source.kind === "server-timestamp-header" ? header(response, source.headerName) : readPath(response.body, source.path).value;
      if (typeof raw !== "string" && typeof raw !== "number") throw freshnessError("Trusted server timestamp is unavailable or malformed.");
      const observed = typeof raw === "number" ? raw : Date.parse(raw);
      if (!Number.isFinite(observed)) throw freshnessError("Trusted server timestamp is malformed.");
      if (observed < this.binding.operationStartedAtEpochMs) throw freshnessError("Trusted server timestamp predates the operation-start boundary.");
      if (now - observed > this.proposal.freshness.maximumAgeSeconds * 1_000) throw freshnessError("Trusted server timestamp is stale.");
      if (observed - now > this.proposal.freshness.maximumFutureSkewSeconds * 1_000) throw freshnessError("Trusted server timestamp is implausibly in the future.");
      return true;
    }
    const baseline = await resolveValue(source.baseline, context, this.resolver);
    if (source.kind === "etag-header") {
      const current = header(response, source.headerName);
      if (!current) throw freshnessError("Confirmed ETag freshness header is unavailable.");
      return canonical(current) !== canonical(baseline);
    }
    const current = readPath(response.body, source.path);
    if (!current.exists) throw freshnessError("Confirmed version/sequence freshness path is unavailable.");
    if (source.kind === "version-body" || source.kind === "sequence-body") {
      if (typeof current.value !== "number" || typeof baseline !== "number" || current.value < baseline) throw freshnessError("Version/sequence freshness proof is invalid relative to the confirmed pre-action baseline.");
      return current.value > baseline;
    }
    return canonical(current.value) !== canonical(baseline);
  }

  private classify(observations: Record<string, unknown>, observedAt: string, freshnessAdvanced: boolean): ObserverInspectionReceipt {
    const success = this.proposal.successPredicates.map((predicate) => ({ predicate, passed: evaluatePredicate(predicate, observations) }));
    const notStarted = this.proposal.notStartedPredicates.map((predicate) => ({ predicate, passed: evaluatePredicate(predicate, observations) }));
    const duplicateObserved = readPath(observations[this.proposal.duplicateCheck.observationKey], this.proposal.duplicateCheck.path);
    const duplicateUnknown = !duplicateObserved.exists || !Array.isArray(duplicateObserved.value);
    const duplicateCount = duplicateUnknown ? undefined : (duplicateObserved.value as unknown[]).length;
    const duplicateDetected = duplicateCount !== undefined && duplicateCount > this.proposal.duplicateCheck.expectedCount;
    const cardinalityExact = duplicateCount === this.proposal.duplicateCheck.expectedCount;
    const collateral = this.proposal.collateralChecks.map((predicate) => ({ predicate, passed: evaluatePredicate(predicate, observations) }));
    const collateralDetected = collateral.some((check) => !check.passed);
    const passedSuccess = success.filter((check) => check.passed).length;
    const classification: ObserverOutcomeClassification = duplicateUnknown
      ? "unknown"
      : duplicateDetected
        ? "duplicate"
        : collateralDetected
        ? "collateral"
        : !freshnessAdvanced
          ? notStarted.every((check) => check.passed) ? "not-started" : "stale"
        : passedSuccess === success.length && cardinalityExact
          ? "completed"
          : notStarted.every((check) => check.passed)
            ? "not-started"
            : passedSuccess > 0
              ? "partial"
              : "incorrect";
    const checks: ObserverInspectionReceipt["checks"] = [
      ...success.map((check) => ({ key: check.predicate.key, role: "success" as const, passed: check.passed, detail: check.passed ? "Confirmed success predicate passed." : "Confirmed success predicate failed; raw values omitted." })),
      ...notStarted.map((check) => ({ key: check.predicate.key, role: "not-started" as const, passed: check.passed, detail: check.passed ? "Confirmed not-started predicate passed." : "Confirmed not-started predicate did not pass." })),
      { key: "duplicate-cardinality", role: "duplicate" as const, passed: cardinalityExact, detail: duplicateUnknown ? "Duplicate/cardinality evidence was unavailable or malformed." : duplicateDetected ? "Duplicate/cardinality condition exceeded its confirmed count." : cardinalityExact ? "Exact confirmed cardinality was observed." : "Observed cardinality was below the confirmed completion count." },
      ...collateral.map((check) => ({ key: check.predicate.key, role: "collateral" as const, passed: check.passed, detail: check.passed ? "Collateral-state invariant passed." : "Collateral-state invariant failed." })),
      { key: "freshness", role: "freshness" as const, passed: freshnessAdvanced || classification === "not-started", detail: freshnessAdvanced ? "Confirmed external state advanced beyond the trusted pre-action baseline." : classification === "not-started" ? "The live read remained at the trusted pre-action baseline and exact not-started predicates passed." : "External state did not advance beyond the trusted pre-action baseline." },
    ];
    return {
      schemaVersion: "1.0",
      observerId: this.observerId,
      observerVersion: "1.0",
      proposalDigest: this.proposal.proposalDigest,
      bindingDigest: digest(this.binding),
      classification,
      passed: classification === "completed",
      duplicateDetected,
      collateralDetected,
      stateDigest: digest(observations),
      checks,
      observedAt,
    };
  }
}

export interface BoundOutcomeObserverResult {
  status: "bound-executable";
  adapter: ExecutableOutcomeObserver;
  verifierContract: ProvisionalVerifierContract;
  bindingReceipt: {
    proposalDigest: string;
    approvedMaterialDigest: string;
    observationDriverDigest: string;
    observationSourceId: string;
    observationSourceDigest: string;
    readOnlyCredentialAliasesDigest: string;
    independenceReviewDigest: string;
    valueResolverDigest: string;
    confirmedByAlias: string;
    confirmedAt: string;
    bindingDigest: string;
  };
}

export function bindOutcomeObserver(
  proposal: OutcomeObserverProposal,
  rawBinding: unknown,
  dependencies: { transport: OutcomeObserverHttpTransport; valueResolver?: OutcomeObserverValueResolver; now?: () => number },
): BoundOutcomeObserverResult {
  const binding = outcomeObserverBindingSchema.parse(rawBinding);
  assertOutcomeObserverProposalIntegrity(proposal);
  if (proposal.status !== "review-required" || proposal.blockers.length > 0) throw new Error("Blocked observer proposal cannot be bound executable.");
  if (binding.proposalDigest !== proposal.proposalDigest) throw new Error("Observer proposal digest does not match the reviewed artifact.");
  if (binding.approvedMaterialDigest !== proposal.approvedMaterialDigest) throw new Error("Approved material digest does not match the reviewed observer proposal.");
  if (dependencies.transport.driverId !== proposal.observationDriverId) throw new Error("Observation transport driver does not match the reviewed observation driver.");
  if (dependencies.transport.driverId === proposal.executionDriverId || !dependencies.transport.independentFromExecutionDriverIds.includes(proposal.executionDriverId)) {
    throw new Error("Observation transport is not independently bound from the action execution driver.");
  }
  if (binding.observationDriverDigest !== dependencies.transport.implementationDigest) throw new Error("Observation transport implementation digest does not match the reviewed binding.");
  if (dependencies.transport.approvedMaterialDigest !== proposal.approvedMaterialDigest) throw new Error("Observation transport is not bound to the approved API material digest.");
  if (binding.observationSourceId !== dependencies.transport.sourceId) throw new Error("Observation source identity does not match the reviewed binding.");
  const sourceDigest = digest({
    sourceId: dependencies.transport.sourceId,
    driverId: dependencies.transport.driverId,
    implementationDigest: dependencies.transport.implementationDigest,
    approvedMaterialDigest: dependencies.transport.approvedMaterialDigest,
  });
  if (binding.observationSourceDigest !== sourceDigest) throw new Error("Observation source provenance digest does not match the reviewed binding.");
  const credentialAliasesDigest = digest([...dependencies.transport.readOnlyCredentialAliases].sort());
  if (binding.readOnlyCredentialAliasesDigest !== credentialAliasesDigest
    || JSON.stringify([...dependencies.transport.readOnlyCredentialAliases].sort()) !== JSON.stringify([...proposal.credentialAliases].sort())) {
    throw new Error("Observation transport read-only credential aliases do not match the reviewed observer proposal.");
  }
  if (dependencies.transport.independenceReview.status !== "independently-reviewed"
    || binding.independenceReviewDigest !== dependencies.transport.independenceReview.reviewDigest) {
    throw new Error("Observation transport lacks the exact independently reviewed provenance binding.");
  }
  const needsResolver = proposal.reads.some((read) => read.parameterBindings.some((bindingItem) => bindingItem.valueSource.kind === "context-reference"))
    || ("baseline" in proposal.freshness.source && proposal.freshness.source.baseline.kind === "context-reference");
  if (needsResolver && !dependencies.valueResolver) throw new Error("Observer requires a customer-local context-value resolver.");
  if (dependencies.valueResolver) {
    if (binding.valueResolverDigest !== dependencies.valueResolver.implementationDigest) throw new Error("Value resolver implementation digest does not match the reviewed binding.");
  } else if (binding.valueResolverDigest !== "not-required") {
    throw new Error("Binding declares a value resolver digest but no resolver implementation was supplied.");
  }
  const adapter = new ExecutableOutcomeObserver(proposal, binding, dependencies.transport, dependencies.valueResolver, dependencies.now ?? (() => Date.now()));
  const verifier = proposeExternalOutcomeVerifier({
    schemaVersion: "1.0",
    outcomeKey: proposal.proposalId,
    ordinaryBusinessOutcome: proposal.ordinaryBusinessOutcome,
    executionDriverId: proposal.executionDriverId,
    successCriteria: proposal.verifierIntakeDraft.successCriteria,
    duplicateCheck: { observationKey: proposal.duplicateCheck.observationKey, path: proposal.duplicateCheck.path, expectedCount: proposal.duplicateCheck.expectedCount },
    collateralEffectCountObservationKey: proposal.verifierIntakeDraft.collateralEffectObservationKey,
    freshness: {
      maximumAgeSeconds: proposal.freshness.maximumAgeSeconds,
      observedAtKey: proposal.freshness.observationKey,
      notBeforeBoundary: "trusted-operation-start",
      boundaryConfirmed: true,
    },
    observationSurfaces: [{
      key: adapter.key,
      sourceId: adapter.sourceId,
      description: "Digest-bound generated read-side HTTP observer.",
      sourceKind: "independent-api",
      observationKeys: adapter.observationKeys,
      approvedForThisOutcome: true,
      independentFromExecution: true,
      independenceConfirmed: true,
      supportsFreshnessBoundary: true,
    }],
  });
  if (verifier.status !== "proposed" || verifier.contract.status !== "provisional-review-required") {
    throw new Error("Bound observer could not produce a complete provisional verifier contract.");
  }
  const bindingReceipt = {
    proposalDigest: proposal.proposalDigest,
    approvedMaterialDigest: proposal.approvedMaterialDigest,
    observationDriverDigest: binding.observationDriverDigest,
    observationSourceId: binding.observationSourceId,
    observationSourceDigest: binding.observationSourceDigest,
    readOnlyCredentialAliasesDigest: binding.readOnlyCredentialAliasesDigest,
    independenceReviewDigest: binding.independenceReviewDigest,
    valueResolverDigest: binding.valueResolverDigest,
    confirmedByAlias: binding.confirmedByAlias,
    confirmedAt: binding.confirmedAt,
    bindingDigest: digest(binding),
  };
  return { status: "bound-executable", adapter, verifierContract: verifier.contract, bindingReceipt };
}
