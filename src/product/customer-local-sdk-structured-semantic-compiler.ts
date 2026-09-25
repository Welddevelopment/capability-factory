import { createHash } from "node:crypto";
import type { SdkImplementationWorkPack } from "./customer-local-sdk-work-pack.js";
import { sdkWorkPackDigest } from "./customer-local-sdk-work-pack.js";
import { REQUIRED_PILOT_ADAPTER_CASES } from "./pilot-adapter.js";
import type { ConfirmedFact, SemanticPredicate, ValueExpression } from "./customer-local-sdk-semantic-compiler.js";

export const CUSTOMER_LOCAL_SDK_STRUCTURED_SEMANTIC_COMPILER_VERSION = "1.0" as const;

type Role = "action" | "no-write-probe" | "reconciliation-readback" | "independent-observer";
type Scalar = string | number | boolean | null;

const roles: readonly Role[] = ["action", "no-write-probe", "reconciliation-readback", "independent-observer"];
const digestPattern = /^[a-f0-9]{64}$/;
const identifier = /^[a-zA-Z][a-zA-Z0-9_.-]{1,119}$/;
const credentialAlias = /^cred\.[a-z][a-z0-9_.-]{1,63}$/;
const authWords = new Set(["auth", "authorization", "credential", "credentials", "password", "passwd", "secret", "token", "apikey", "api_key", "access_token", "bearer_token", "client_secret"]);
const maximumSchemaDepth = 4;
const maximumSchemaNodes = 64;
const maximumObjectProperties = 24;
const maximumArrayItems = 100;

function canonical(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error("Structured SDK contract contains recursive or cyclic material.");
    ancestors.add(value);
    const result = `[${value.map((item) => canonical(item, ancestors)).join(",")}]`;
    ancestors.delete(value);
    return result;
  }
  if (value !== null && typeof value === "object") {
    if (ancestors.has(value as object)) throw new Error("Structured SDK contract contains recursive or cyclic material.");
    ancestors.add(value as object);
    const result = `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item, ancestors)}`).join(",")}}`;
    ancestors.delete(value as object);
    return result;
  }
  return JSON.stringify(value);
}

export const structuredSdkDigest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");

export type BoundedSdkValueSchema =
  | { kind: "string"; fact: ConfirmedFact }
  | { kind: "number"; fact: ConfirmedFact }
  | { kind: "boolean"; fact: ConfirmedFact }
  | { kind: "object"; additionalProperties: false; properties: Array<{ name: string; required: true; schema: BoundedSdkValueSchema; fact: ConfirmedFact }>; fact: ConfirmedFact }
  | { kind: "array"; maximumItems: number; items: BoundedSdkValueSchema; fact: ConfirmedFact };

export type StructuredValueExpression =
  | { kind: "scalar"; source: "workflow-input" | "trusted-context"; key: string; convert: "identity" | "string" | "number" | "boolean"; fact: ConfirmedFact }
  | { kind: "object"; fields: Array<{ name: string; expression: StructuredValueExpression; fact: ConfirmedFact }>; fact: ConfirmedFact }
  | { kind: "bounded-array"; source: "workflow-input" | "trusted-context"; key: string; maximumItems: number; fact: ConfirmedFact };

export interface PinnedStructuredSdkParameter {
  role: Role;
  parameter: string;
  declaredType: "string" | "number" | "boolean" | "Record<string, unknown>" | "Array<string>";
  methodDigest: string;
  sdkSourceDigest: string;
  sourcePointer: string;
  schema: BoundedSdkValueSchema;
  schemaDigest: string;
  fact: ConfirmedFact;
}

export interface ApprovedStructuredSdkSchemaIndex {
  schemaVersion: "1.0";
  providerId: string;
  sdkSourceDigest: string;
  localReference: string;
  approved: true;
  parameters: PinnedStructuredSdkParameter[];
  indexDigest: string;
}

export interface StructuredSdkSemanticContract {
  schemaVersion: "1.0";
  contractId: string;
  providerId: string;
  sdkSourceDigest: string;
  workPackDigest: string;
  schemaIndexDigest: string;
  roles: Array<{ role: Role; methodDigest: string; fact: ConfirmedFact }>;
  parameters: Array<{ role: Role; parameter: string; pinnedSchemaDigest: string; expression: StructuredValueExpression; fact: ConfirmedFact }>;
  credentials: { action: { alias: string; exactScope: string; fact: ConfirmedFact }; observer: { alias: string; exactScope: string; fact: ConfirmedFact } };
  stableIdentity: { expression: ValueExpression; collisionPolicy: "reject-conflict"; fact: ConfirmedFact };
  idempotency: { expression: ValueExpression; conflictIdentity: ValueExpression[]; reconcileBeforeRetry: true; blindRetryAllowed: false; fact: ConfirmedFact };
  reconciliation: { role: "reconciliation-readback"; notFoundClassification: "not-started"; multipleClassification: "duplicate"; fact: ConfirmedFact };
  observer: { role: "independent-observer"; sourceId: string; authIndependent: true; differentMethodFromAction: true; fact: ConfirmedFact };
  outcome: { predicates: SemanticPredicate[]; duplicate: { collectionPath: string[]; expectedCount: 1; fact: ConfirmedFact }; collateral: SemanticPredicate[]; freshness: { path: string[]; maximumAgeSeconds: number; notBefore: "operation-start"; fact: ConfirmedFact }; fact: ConfirmedFact };
  pagination: { roles: Array<{ role: "reconciliation-readback" | "independent-observer"; mode: "not-paginated"; maximumPages: 1; fact: ConfirmedFact }>; complete: true; fact: ConfirmedFact };
  policy: { timeoutMilliseconds: number; maximumRequestsPerMinute: number; maximumAttempts: 1 | 2 | 3; retryableErrors: string[]; terminalErrors: string[]; fact: ConfirmedFact };
  pinnedParameters: PinnedStructuredSdkParameter[];
  sourceDigest: string;
  expiresAt: string;
  executionAuthorityEffect: "none";
  activationEffect: "none";
  contractDigest: string;
}

export interface StructuredSdkInvocation {
  role: Role;
  methodDigest: string;
  parameters: Record<string, unknown>;
  credentialAlias: string;
  scope: string;
  stableId: string;
  idempotencyKey: string;
  timeoutMilliseconds: number;
}

export interface StructuredSdkInvoker {
  implementationDigest: string;
  actionBindingDigest: string;
  observerBindingDigest: string;
  invoke(input: StructuredSdkInvocation): Promise<{ status: "ok" | "not-found" | "error"; value: unknown; observedAt: string; paginationComplete: boolean }>;
}

export interface StructuredSdkAcceptanceEvidence {
  schemaVersion: "1.0";
  state: "fictional-local-acceptance-passed";
  caseIds: string[];
  passed: true;
  incorrectSideEffects: 0;
  contractDigest: string;
  workPackDigest: string;
  implementationDigest: string;
  actionBindingDigest: string;
  observerBindingDigest: string;
  separateBindingsProven: true;
  customerEnvironmentAccepted: false;
  activationAuthorized: false;
  evidenceDigest: string;
}

export interface AcceptanceOnlyStructuredSdkAdapters {
  schemaVersion: "1.0";
  state: "acceptance-only-structured-non-executable";
  providerId: string;
  contractDigest: string;
  workPackDigest: string;
  structuredSurfaceDigest: string;
  implementationDigest: string;
  action(): Promise<never>;
  probe(): Promise<never>;
  reconcile(): Promise<never>;
  observe(): Promise<never>;
  executionAuthorityEffect: "none";
  activationEffect: "none";
}

export interface LocalAcceptanceStructuredSdkAdapters {
  state: "fictional-local-acceptance-attached-not-activated";
  action(input: Record<string, unknown>, context: Record<string, unknown>): Promise<unknown>;
  probe(input: Record<string, unknown>, context: Record<string, unknown>): Promise<unknown>;
  reconcile(input: Record<string, unknown>, context: Record<string, unknown>): Promise<{ classification: string; value: unknown }>;
  observe(input: Record<string, unknown>, context: Record<string, unknown>, operationStartedAt: number): Promise<{ passed: boolean; classification: string; checks: Array<{ key: string; passed: boolean }>; value: unknown }>;
  executionAuthorityEffect: "none";
  activationEffect: "none";
}

function normalizedIdentifier(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function isAuthShaped(value: string): boolean {
  const normalized = normalizedIdentifier(value);
  return normalized.split("_").some((part) => authWords.has(part)) || authWords.has(normalized.replace(/_/g, ""));
}

function assertFact(fact: ConfirmedFact): void {
  if (!fact || !identifier.test(fact.confirmedBy) || !fact.sourcePointer || !Number.isFinite(Date.parse(fact.confirmedAt))) throw new Error("Structured SDK fact lacks exact owner/engineer confirmation and provenance.");
}

function schemaStats(schema: BoundedSdkValueSchema, depth = 1): { nodes: number; depth: number } {
  assertFact(schema.fact);
  if (depth > maximumSchemaDepth) throw new Error("Structured SDK schema exceeds the bounded nesting depth.");
  if (schema.kind === "object") {
    if (schema.additionalProperties !== false || schema.properties.length === 0 || schema.properties.length > maximumObjectProperties) throw new Error("Structured SDK objects require a fixed non-empty bounded property set and no additional properties.");
    const names = schema.properties.map((property) => property.name);
    if (new Set(names).size !== names.length) throw new Error("Structured SDK object properties must be unique.");
    let nodes = 1;
    let deepest = depth;
    for (const property of schema.properties) {
      assertFact(property.fact);
      if (!identifier.test(property.name) || isAuthShaped(property.name) || property.required !== true) throw new Error("Structured SDK object fields must be fixed, required, non-auth-shaped identifiers.");
      const child = schemaStats(property.schema, depth + 1);
      nodes += child.nodes;
      deepest = Math.max(deepest, child.depth);
    }
    return { nodes, depth: deepest };
  }
  if (schema.kind === "array") {
    if (!Number.isInteger(schema.maximumItems) || schema.maximumItems < 1 || schema.maximumItems > maximumArrayItems) throw new Error("Structured SDK arrays require an explicit safe maximumItems bound.");
    const child = schemaStats(schema.items, depth + 1);
    return { nodes: 1 + child.nodes, depth: child.depth };
  }
  return { nodes: 1, depth };
}

function allExpressionFacts(expression: StructuredValueExpression): ConfirmedFact[] {
  if (expression.kind === "object") return [expression.fact, ...expression.fields.flatMap((field) => [field.fact, ...allExpressionFacts(field.expression)])];
  return [expression.fact];
}

function assertExpressionMatchesSchema(expression: StructuredValueExpression, schema: BoundedSdkValueSchema): void {
  allExpressionFacts(expression).forEach(assertFact);
  if (schema.kind === "object") {
    if (expression.kind !== "object") throw new Error("A fixed object SDK parameter requires an explicitly constructed object expression.");
    const expected = schema.properties.map((property) => property.name).sort();
    const actual = expression.fields.map((field) => field.name).sort();
    if (new Set(actual).size !== actual.length || canonical(expected) !== canonical(actual)) throw new Error("Structured object expression must cover the exact pinned property set once.");
    for (const property of schema.properties) {
      const field = expression.fields.find((candidate) => candidate.name === property.name)!;
      if (isAuthShaped(field.name)) throw new Error("Authentication-shaped data cannot be constructed in a capability payload.");
      assertExpressionMatchesSchema(field.expression, property.schema);
    }
    return;
  }
  if (schema.kind === "array") {
    if (expression.kind !== "bounded-array" || expression.maximumItems !== schema.maximumItems) throw new Error("A homogeneous array requires an exact source and the same explicit maximumItems bound as pinned metadata.");
    if (!identifier.test(expression.key) || isAuthShaped(expression.key)) throw new Error("Authentication-shaped or invalid array sources are not allowed.");
    return;
  }
  if (expression.kind !== "scalar" || !identifier.test(expression.key) || isAuthShaped(expression.key)) throw new Error("A primitive SDK field requires one reviewed non-auth-shaped scalar source.");
  if (expression.convert !== "identity" && expression.convert !== schema.kind) throw new Error("Primitive conversion must match the exact pinned destination type; custom transforms are unsupported.");
}

function assertTopLevelDeclaredType(pinned: PinnedStructuredSdkParameter): void {
  const expected = pinned.schema.kind === "object" ? "Record<string, unknown>" : pinned.schema.kind === "array" ? "Array<string>" : pinned.schema.kind;
  if (pinned.declaredType !== expected) throw new Error("Pinned structured schema does not match the exact reviewed SDK parameter declaration.");
  if (pinned.schema.kind === "array" && pinned.schema.items.kind !== "string") throw new Error("The current reviewed SDK metadata only permits a top-level Array<string>; richer homogeneous arrays must sit inside a fixed object schema.");
}

function assertScope(scope: string): void {
  if (!scope || /(?:^|[.:/_-])(?:\*|all|admin|root|owner)(?:$|[.:/_-])/i.test(scope)) throw new Error("Structured SDK scope is missing or widens authority beyond an exact reviewed operation.");
}

function contractPayload(contract: StructuredSdkSemanticContract): Omit<StructuredSdkSemanticContract, "contractDigest"> {
  const { contractDigest: _digest, ...payload } = contract;
  return payload;
}

export function assertApprovedStructuredSdkSchemaIndex(index: ApprovedStructuredSdkSchemaIndex, workPack: SdkImplementationWorkPack): void {
  canonical(index);
  const { indexDigest, ...payload } = index;
  if (index.schemaVersion !== "1.0" || index.providerId !== workPack.providerId || index.sdkSourceDigest !== workPack.sdkSourceDigest || index.indexDigest !== structuredSdkDigest(payload) || !index.approved || !/^(?:fixture:\/\/[a-zA-Z0-9_.\/-]+|file:\/\/[a-zA-Z0-9_.\/-]+|[a-zA-Z0-9_.\/-]+)$/.test(index.localReference) || index.localReference.includes("..")) throw new Error("Approved structured SDK schema index failed source identity, integrity or path validation.");
  if (workPack.roles.some((role) => role.provenance.localReference !== index.localReference || role.provenance.sdkSourceDigest !== index.sdkSourceDigest)) throw new Error("Approved structured SDK schema index is not bound to the exact reviewed SDK source location.");
  if (index.parameters.length === 0 || new Set(index.parameters.map((parameter) => `${parameter.role}:${parameter.parameter}`)).size !== index.parameters.length) throw new Error("Approved structured SDK schema index is empty or ambiguous.");
  for (const parameter of index.parameters) {
    if (parameter.sdkSourceDigest !== index.sdkSourceDigest || parameter.schemaDigest !== structuredSdkDigest(parameter.schema)) throw new Error("Approved structured SDK schema index contains stale parameter material.");
  }
}

function assertContract(contract: StructuredSdkSemanticContract, workPack: SdkImplementationWorkPack, schemaIndex: ApprovedStructuredSdkSchemaIndex, now: string): void {
  canonical(contract);
  const { workPackDigest, ...workPackPayload } = workPack;
  if (workPackDigest !== sdkWorkPackDigest(workPackPayload)) throw new Error("Structured SDK work pack is stale or forged.");
  assertApprovedStructuredSdkSchemaIndex(schemaIndex, workPack);
  if (contract.schemaVersion !== "1.0" || contract.providerId !== workPack.providerId || contract.sdkSourceDigest !== workPack.sdkSourceDigest || contract.workPackDigest !== workPack.workPackDigest || contract.schemaIndexDigest !== schemaIndex.indexDigest || canonical(contract.pinnedParameters) !== canonical(schemaIndex.parameters) || contract.contractDigest !== structuredSdkDigest(contractPayload(contract)) || contract.executionAuthorityEffect !== "none" || contract.activationEffect !== "none" || !Number.isFinite(Date.parse(contract.expiresAt)) || Date.parse(contract.expiresAt) <= Date.parse(now)) throw new Error("Structured SDK contract failed identity, integrity, pinned-schema, expiry or authority validation.");
  if (contract.roles.length !== 4 || new Set(contract.roles.map((role) => role.role)).size !== 4 || roles.some((role) => !contract.roles.some((candidate) => candidate.role === role))) throw new Error("Structured SDK contract must bind exactly four separate roles.");
  for (const role of contract.roles) {
    assertFact(role.fact);
    const selected = workPack.roles.find((candidate) => candidate.review.role === role.role);
    if (!selected || selected.methodDigest !== role.methodDigest) throw new Error("Structured SDK role is stale or cross-provider substituted.");
    if (selected.method.parameters.some((parameter) => !parameter.required)) throw new Error("Optional SDK parameters remain unsupported because omission semantics are not proven.");
    if (selected.method.pagination !== "none") throw new Error("Pagination and streaming remain outside the bounded structured SDK compiler.");
  }
  if (!credentialAlias.test(contract.credentials.action.alias) || !credentialAlias.test(contract.credentials.observer.alias) || contract.credentials.action.alias === contract.credentials.observer.alias) throw new Error("Action and observer require separate exact credential aliases.");
  assertFact(contract.credentials.action.fact);
  assertFact(contract.credentials.observer.fact);
  assertScope(contract.credentials.action.exactScope);
  assertScope(contract.credentials.observer.exactScope);
  if (!contract.idempotency.reconcileBeforeRetry || contract.idempotency.blindRetryAllowed || contract.idempotency.conflictIdentity.length === 0 || contract.stableIdentity.collisionPolicy !== "reject-conflict") throw new Error("Structured SDK idempotency, collision or retry policy is unsafe.");
  if (!contract.observer.authIndependent || !contract.observer.differentMethodFromAction || contract.roles.find((role) => role.role === "action")!.methodDigest === contract.roles.find((role) => role.role === "independent-observer")!.methodDigest) throw new Error("Structured SDK action and independent observer are conflated.");
  if (!contract.pagination.complete || contract.pagination.roles.length !== 2 || contract.pagination.roles.some((item) => item.mode !== "not-paginated" || item.maximumPages !== 1)) throw new Error("Structured SDK pagination boundary is incomplete.");
  if (contract.policy.maximumAttempts > 3 || contract.policy.timeoutMilliseconds < 100 || contract.policy.timeoutMilliseconds > 120_000 || contract.policy.maximumRequestsPerMinute < 1) throw new Error("Structured SDK execution policy is unbounded or unsafe.");
  if (contract.outcome.predicates.length === 0 || contract.outcome.collateral.length === 0 || contract.outcome.duplicate.collectionPath.length === 0 || contract.outcome.freshness.path.length === 0 || contract.outcome.freshness.maximumAgeSeconds < 1) throw new Error("Structured SDK independent outcome proof is incomplete.");
  const scalarFacts = [contract.stableIdentity.fact, contract.stableIdentity.expression.fact, contract.idempotency.fact, contract.idempotency.expression.fact, ...contract.idempotency.conflictIdentity.map((expression) => expression.fact), contract.reconciliation.fact, contract.observer.fact, contract.outcome.fact, ...contract.outcome.predicates.map((predicate) => predicate.fact), contract.outcome.duplicate.fact, ...contract.outcome.collateral.map((predicate) => predicate.fact), contract.outcome.freshness.fact, contract.pagination.fact, ...contract.pagination.roles.map((item) => item.fact), contract.policy.fact];
  scalarFacts.forEach(assertFact);
  for (const expression of [contract.stableIdentity.expression, contract.idempotency.expression, ...contract.idempotency.conflictIdentity]) if (!identifier.test(expression.key) || isAuthShaped(expression.key) || !["identity", "string", "number", "boolean"].includes(expression.convert)) throw new Error("Identity/idempotency expressions may only use reviewed bounded scalar sources.");
  const expected = workPack.roles.flatMap((role) => role.method.parameters.map((parameter) => `${role.review.role}:${parameter.name}`)).sort();
  const mapped = contract.parameters.map((mapping) => `${mapping.role}:${mapping.parameter}`).sort();
  const pinned = contract.pinnedParameters.map((parameter) => `${parameter.role}:${parameter.parameter}`).sort();
  if (new Set(mapped).size !== mapped.length || new Set(pinned).size !== pinned.length || canonical(expected) !== canonical(mapped) || canonical(expected) !== canonical(pinned)) throw new Error("Structured SDK mappings and pinned schemas must cover every exact required parameter once.");
  for (const pinnedParameter of contract.pinnedParameters) {
    assertFact(pinnedParameter.fact);
    const selected = workPack.roles.find((candidate) => candidate.review.role === pinnedParameter.role)!;
    const parameter = selected.method.parameters.find((candidate) => candidate.name === pinnedParameter.parameter);
    if (!parameter || pinnedParameter.methodDigest !== selected.methodDigest || pinnedParameter.sdkSourceDigest !== workPack.sdkSourceDigest || pinnedParameter.sourcePointer !== parameter.sourcePointer || pinnedParameter.declaredType !== parameter.type || pinnedParameter.schemaDigest !== structuredSdkDigest(pinnedParameter.schema)) throw new Error("Pinned structured parameter metadata is stale, forged or cross-method substituted.");
    assertTopLevelDeclaredType(pinnedParameter);
    const stats = schemaStats(pinnedParameter.schema);
    if (stats.nodes > maximumSchemaNodes) throw new Error("Structured SDK schema exceeds the bounded node count.");
    const mapping = contract.parameters.find((candidate) => candidate.role === pinnedParameter.role && candidate.parameter === pinnedParameter.parameter)!;
    assertFact(mapping.fact);
    if (mapping.pinnedSchemaDigest !== pinnedParameter.schemaDigest) throw new Error("Structured SDK mapping is bound to a different pinned schema.");
    assertExpressionMatchesSchema(mapping.expression, pinnedParameter.schema);
  }
}

function scalar(expr: ValueExpression | Extract<StructuredValueExpression, { kind: "scalar" }>, input: Record<string, unknown>, context: Record<string, unknown>): Scalar {
  const raw = (expr.source === "workflow-input" ? input : context)[expr.key];
  if (raw === undefined) throw new Error(`Required structured semantic input ${expr.key} is missing.`);
  if (expr.convert === "identity") {
    if (raw === null || ["string", "number", "boolean"].includes(typeof raw)) return raw as Scalar;
    throw new Error("Structured scalar identity conversion accepts primitive values only.");
  }
  if (expr.convert === "string") return String(raw);
  if (expr.convert === "number") {
    const converted = Number(raw);
    if (!Number.isFinite(converted)) throw new Error("Structured number conversion failed.");
    return converted;
  }
  if (typeof raw === "boolean") return raw;
  if (raw === "true" || raw === 1) return true;
  if (raw === "false" || raw === 0) return false;
  throw new Error("Structured boolean conversion failed.");
}

function validateRuntimeValue(value: unknown, schema: BoundedSdkValueSchema, path: string): unknown {
  if (schema.kind === "string" || schema.kind === "number" || schema.kind === "boolean") {
    if (typeof value !== schema.kind) throw new Error(`${path} does not match the pinned ${schema.kind} schema.`);
    return value;
  }
  if (schema.kind === "array") {
    if (!Array.isArray(value) || value.length > schema.maximumItems) throw new Error(`${path} exceeds or violates the pinned homogeneous-array bound.`);
    return value.map((item, index) => validateRuntimeValue(item, schema.items, `${path}[${index}]`));
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be the exact pinned object shape.`);
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = schema.properties.map((property) => property.name).sort();
  if (canonical(actual) !== canonical(expected)) throw new Error(`${path} contains a missing or additional property.`);
  return Object.fromEntries(schema.properties.map((property) => [property.name, validateRuntimeValue((value as Record<string, unknown>)[property.name], property.schema, `${path}.${property.name}`)]));
}

function evaluateStructured(expression: StructuredValueExpression, schema: BoundedSdkValueSchema, input: Record<string, unknown>, context: Record<string, unknown>, path: string): unknown {
  if (expression.kind === "scalar") return validateRuntimeValue(scalar(expression, input, context), schema, path);
  if (expression.kind === "bounded-array") {
    const raw = (expression.source === "workflow-input" ? input : context)[expression.key];
    if (raw === undefined) throw new Error(`Required structured array input ${expression.key} is missing.`);
    return validateRuntimeValue(raw, schema, path);
  }
  const value = Object.fromEntries(expression.fields.map((field) => {
    const childSchema = (schema as Extract<BoundedSdkValueSchema, { kind: "object" }>).properties.find((property) => property.name === field.name)!.schema;
    return [field.name, evaluateStructured(field.expression, childSchema, input, context, `${path}.${field.name}`)];
  }));
  return validateRuntimeValue(value, schema, path);
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current) || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function predicateCheck(predicate: SemanticPredicate, value: unknown, data: Record<string, unknown>): { key: string; passed: boolean } {
  const actual = readPath(value, predicate.path);
  const passed = predicate.operator === "exists" ? actual !== undefined : predicate.operator === "equals-input" ? actual === data[predicate.inputKey!] : predicate.operator === "equals-confirmed" ? actual === predicate.expected : Array.isArray(actual) && actual.length === predicate.expected;
  return { key: predicate.key, passed };
}

export function structuredSdkAcceptanceEvidenceDigest(input: Omit<StructuredSdkAcceptanceEvidence, "evidenceDigest">): string {
  return structuredSdkDigest(input);
}

export function compileStructuredSdkSemanticContract(input: { contract: StructuredSdkSemanticContract; workPack: SdkImplementationWorkPack; schemaIndex: ApprovedStructuredSdkSchemaIndex; now: string }): AcceptanceOnlyStructuredSdkAdapters {
  assertContract(input.contract, input.workPack, input.schemaIndex, input.now);
  const structuredSurfaceDigest = structuredSdkDigest({ pinnedParameters: input.contract.pinnedParameters, mappings: input.contract.parameters });
  const implementationDigest = structuredSdkDigest({ compiler: CUSTOMER_LOCAL_SDK_STRUCTURED_SEMANTIC_COMPILER_VERSION, contractDigest: input.contract.contractDigest, workPackDigest: input.workPack.workPackDigest, structuredSurfaceDigest });
  const fail = async (): Promise<never> => { throw new Error("Structured SDK adapters remain non-executable until separate bindings and mandatory local acceptance evidence are attached."); };
  return { schemaVersion: "1.0", state: "acceptance-only-structured-non-executable", providerId: input.contract.providerId, contractDigest: input.contract.contractDigest, workPackDigest: input.workPack.workPackDigest, structuredSurfaceDigest, implementationDigest, action: fail, probe: fail, reconcile: fail, observe: fail, executionAuthorityEffect: "none", activationEffect: "none" };
}

export function attachStructuredSdkLocalAcceptance(input: { compiled: AcceptanceOnlyStructuredSdkAdapters; contract: StructuredSdkSemanticContract; workPack: SdkImplementationWorkPack; schemaIndex: ApprovedStructuredSdkSchemaIndex; invoker: StructuredSdkInvoker; acceptance: StructuredSdkAcceptanceEvidence; now: string }): LocalAcceptanceStructuredSdkAdapters {
  assertContract(input.contract, input.workPack, input.schemaIndex, input.now);
  if (input.compiled.contractDigest !== input.contract.contractDigest || input.compiled.workPackDigest !== input.workPack.workPackDigest || input.invoker.implementationDigest !== input.compiled.implementationDigest) throw new Error("Structured SDK compiled/runtime identity is stale or substituted.");
  if (!digestPattern.test(input.invoker.actionBindingDigest) || !digestPattern.test(input.invoker.observerBindingDigest) || input.invoker.actionBindingDigest === input.invoker.observerBindingDigest) throw new Error("Structured SDK action and observer require distinct content-addressed bindings.");
  const { evidenceDigest, ...payload } = input.acceptance;
  if (evidenceDigest !== structuredSdkAcceptanceEvidenceDigest(payload) || input.acceptance.state !== "fictional-local-acceptance-passed" || input.acceptance.caseIds.length !== REQUIRED_PILOT_ADAPTER_CASES.length || new Set(input.acceptance.caseIds).size !== REQUIRED_PILOT_ADAPTER_CASES.length || REQUIRED_PILOT_ADAPTER_CASES.some((caseId) => !input.acceptance.caseIds.includes(caseId)) || input.acceptance.incorrectSideEffects !== 0 || input.acceptance.contractDigest !== input.contract.contractDigest || input.acceptance.workPackDigest !== input.workPack.workPackDigest || input.acceptance.implementationDigest !== input.compiled.implementationDigest || input.acceptance.actionBindingDigest !== input.invoker.actionBindingDigest || input.acceptance.observerBindingDigest !== input.invoker.observerBindingDigest || !input.acceptance.separateBindingsProven || input.acceptance.customerEnvironmentAccepted || input.acceptance.activationAuthorized) throw new Error("Structured SDK mandatory local acceptance evidence is incomplete, stale, conflated or overclaims readiness.");
  const invoke = async (role: Role, data: Record<string, unknown>, context: Record<string, unknown>) => {
    const method = input.workPack.roles.find((candidate) => candidate.review.role === role)!;
    const mappings = input.contract.parameters.filter((mapping) => mapping.role === role);
    const parameters = Object.fromEntries(mappings.map((mapping) => {
      const pinned = input.contract.pinnedParameters.find((candidate) => candidate.role === role && candidate.parameter === mapping.parameter)!;
      return [mapping.parameter, evaluateStructured(mapping.expression, pinned.schema, data, context, `${role}.${mapping.parameter}`)];
    }));
    const stableId = String(scalar(input.contract.stableIdentity.expression, data, context));
    const idempotencyKey = String(scalar(input.contract.idempotency.expression, data, context));
    const credentials = role === "action" || role === "no-write-probe" ? input.contract.credentials.action : input.contract.credentials.observer;
    return input.invoker.invoke({ role, methodDigest: method.methodDigest, parameters, credentialAlias: credentials.alias, scope: credentials.exactScope, stableId, idempotencyKey, timeoutMilliseconds: input.contract.policy.timeoutMilliseconds });
  };
  return {
    state: "fictional-local-acceptance-attached-not-activated",
    action: async (data, context) => { const result = await invoke("action", data, context); if (result.status !== "ok") throw new Error("Structured SDK action did not return bounded success."); return result.value; },
    probe: async (data, context) => { const result = await invoke("no-write-probe", data, context); if (result.status !== "ok") throw new Error("Structured SDK no-write probe failed."); return result.value; },
    reconcile: async (data, context) => { const result = await invoke("reconciliation-readback", data, context); if (!result.paginationComplete || result.status === "error") return { classification: "unknown", value: result.value }; const matches = readPath(result.value, input.contract.outcome.duplicate.collectionPath); if (Array.isArray(matches) && matches.length > 1) return { classification: "duplicate", value: result.value }; return { classification: result.status === "not-found" ? "not-started" : "completed", value: result.value }; },
    observe: async (data, context, operationStartedAt) => { const result = await invoke("independent-observer", data, context); const matches = readPath(result.value, input.contract.outcome.duplicate.collectionPath); const checks = [...input.contract.outcome.predicates.map((predicate) => predicateCheck(predicate, result.value, data)), { key: "duplicate-count", passed: Array.isArray(matches) && matches.length === 1 }, ...input.contract.outcome.collateral.map((predicate) => predicateCheck(predicate, result.value, data))]; const observedAt = readPath(result.value, input.contract.outcome.freshness.path); const observed = typeof observedAt === "string" ? Date.parse(observedAt) : Number.NaN; const fresh = Number.isFinite(observed) && observed >= operationStartedAt && observed - operationStartedAt <= input.contract.outcome.freshness.maximumAgeSeconds * 1000; checks.push({ key: "freshness", passed: fresh }, { key: "pagination-complete", passed: result.paginationComplete }, { key: "observer-status", passed: result.status === "ok" }); const passed = checks.every((check) => check.passed); return { passed, classification: passed ? "completed" : result.status === "error" || !result.paginationComplete || !Number.isFinite(observed) ? "unknown" : "incorrect", checks, value: result.value }; },
    executionAuthorityEffect: "none",
    activationEffect: "none",
  };
}
