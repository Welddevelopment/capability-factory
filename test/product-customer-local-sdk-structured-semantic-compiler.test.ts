import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachStructuredSdkLocalAcceptance,
  compileStructuredSdkSemanticContract,
  structuredSdkAcceptanceEvidenceDigest,
  structuredSdkDigest,
  type ApprovedStructuredSdkSchemaIndex,
  type BoundedSdkValueSchema,
  type StructuredSdkAcceptanceEvidence,
  type StructuredSdkInvocation,
  type StructuredSdkInvoker,
  type StructuredSdkSemanticContract,
  type StructuredValueExpression,
} from "../src/product/customer-local-sdk-structured-semantic-compiler.js";
import { sdkWorkPackDigest, type ApprovedSdkMethod, type SdkImplementationWorkPack } from "../src/product/customer-local-sdk-work-pack.js";
import { REQUIRED_PILOT_ADAPTER_CASES } from "../src/product/pilot-adapter.js";
import { sdkSemanticDigest, type ConfirmedFact, type SdkSemanticContract, type ValueExpression } from "../src/product/customer-local-sdk-semantic-compiler.js";
import { DurableStructuredSdkSemanticDraftWorkflow, type StructuredSdkDraftSource } from "../src/product/customer-local-sdk-structured-semantic-drafting.js";
import { extractApprovedStructuredSdkSchemaIndex, structuredSdkSourceBytesDigest, type StructuredSdkSchemaReview } from "../src/product/customer-local-sdk-structured-schema-extractor.js";
import { DurableStructuredSdkOnboardingJourney, type StructuredSdkOnboardingInput, type StructuredSdkOnboardingReceipt } from "../src/product/customer-local-sdk-structured-onboarding.js";
import { normalizePinnedTypeScriptSdkDeclarations, type TypeScriptSdkMethodReview } from "../src/product/customer-local-sdk-typescript-declaration-normalizer.js";

const now = "2026-08-14T10:00:00.000Z";
const expiresAt = "2026-08-15T10:00:00.000Z";
const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));
async function temporaryDatabase(name: string): Promise<string> { const directory = await mkdtemp(path.join(os.tmpdir(), `cf079-${name}-`)); temporaryDirectories.push(directory); return path.join(directory, "draft.sqlite"); }
const fact = (sourcePointer: string): ConfirmedFact => ({ provenance: "engineer-confirmed", confirmedBy: "fixtureEngineer", confirmedAt: now, sourcePointer });
const expression = (key: string): ValueExpression => ({ source: "workflow-input", key, convert: "identity", fact: fact(`workflow://${key}`) });
const scalarExpression = (key: string, convert: "identity" | "string" | "number" | "boolean" = "identity"): StructuredValueExpression => ({ kind: "scalar", source: "workflow-input", key, convert, fact: fact(`workflow://${key}`) });
const stringSchema = (pointer: string): BoundedSdkValueSchema => ({ kind: "string", fact: fact(pointer) });
const numberSchema = (pointer: string): BoundedSdkValueSchema => ({ kind: "number", fact: fact(pointer) });

function method(input: { module: string; className: string; methodName: string; role: string; parameters: Array<{ name: string; type: ApprovedSdkMethod["parameters"][number]["type"] }> }): ApprovedSdkMethod {
  return {
    module: input.module,
    className: input.className,
    methodName: input.methodName,
    overloadId: "v1",
    parameters: input.parameters.map((parameter, index) => ({ ...parameter, required: true, sourcePointer: `#/methods/${input.methodName}/parameters/${index}` })),
    returnType: "Promise<Record<string, unknown>>",
    errorTypes: ["SdkError", "Unauthorized", "Conflict", "TimeoutBeforeCommit"],
    authAliasRequirements: [input.role === "action" || input.role === "probe" ? "cred.supplier.writer" : "cred.supplier.audit"],
    pagination: "none",
    retryCandidate: input.role === "action" ? "idempotency-key" : "read-only",
    idempotencyCandidate: input.role === "action" ? "orderRef" : null,
    sourcePointer: `#/methods/${input.methodName}/v1`,
  };
}

function createWorkPack(): SdkImplementationWorkPack {
  const providerId = "structured-supplier-sdk";
  const sdkSourceDigest = sdkWorkPackDigest({ providerId, version: 1, source: "pinned-local-sdk-metadata" });
  const definitions: Array<{ role: SdkImplementationWorkPack["roles"][number]["review"]["role"]; method: ApprovedSdkMethod }> = [
    { role: "action", method: method({ module: "supplier-write-sdk", className: "OrderClient", methodName: "createDraft", role: "action", parameters: [{ name: "request", type: "Record<string, unknown>" }] }) },
    { role: "no-write-probe", method: method({ module: "supplier-write-sdk", className: "OrderClient", methodName: "probe", role: "probe", parameters: [{ name: "orderRef", type: "string" }] }) },
    { role: "reconciliation-readback", method: method({ module: "supplier-read-sdk", className: "OrderReadClient", methodName: "findDraft", role: "reconcile", parameters: [{ name: "query", type: "Record<string, unknown>" }] }) },
    { role: "independent-observer", method: method({ module: "supplier-audit-sdk", className: "AuditClient", methodName: "observeDraft", role: "observer", parameters: [{ name: "query", type: "Record<string, unknown>" }] }) },
  ];
  const roles = definitions.map(({ role, method: sdkMethod }) => ({
    review: { role, module: sdkMethod.module, className: sdkMethod.className!, methodName: sdkMethod.methodName, overloadId: sdkMethod.overloadId, expectedSourcePointer: sdkMethod.sourcePointer, reviewerAlias: "fixtureEngineer", reviewedAt: now, exactOneToOne: true as const },
    method: sdkMethod,
    methodDigest: sdkWorkPackDigest(sdkMethod),
    provenance: { sourceKind: "typescript-declarations" as const, localReference: "fixture://structured-supplier/sdk", sourcePointer: sdkMethod.sourcePointer, sdkSourceDigest },
  }));
  const payload = {
    schemaVersion: "1.0" as const,
    state: "engineer-implementation-required" as const,
    providerId,
    pluginId: "structured-supplier-plugin",
    sdkSourceDigest,
    factoryResultDigest: sdkWorkPackDigest({ factory: providerId }),
    roles,
    normalized: { modules: ["supplier-audit-sdk", "supplier-read-sdk", "supplier-write-sdk"], classes: ["AuditClient", "OrderClient", "OrderReadClient"], methodCount: 4, parameterCount: 4, returnShapeCount: 1, errorShapeCount: 4, authAliasRequirements: ["cred.supplier.audit", "cred.supplier.writer"], paginationCandidates: ["none"], retryCandidates: ["idempotency-key", "read-only"], idempotencyCandidates: ["orderRef"] },
    blockedUnknowns: [],
    conformanceControls: [],
    generatedFiles: [],
    generatedLines: 0,
    mappedMethods: 4,
    mappedFields: 4,
    explicitReviews: 4,
    executionAuthorityEffect: "none" as const,
    activationEffect: "none" as const,
  };
  return { ...payload, workPackDigest: sdkWorkPackDigest(payload) };
}

function objectSchema(pointer: string, properties: Array<{ name: string; schema: BoundedSdkValueSchema }>): BoundedSdkValueSchema {
  return { kind: "object", additionalProperties: false, properties: properties.map((property) => ({ ...property, required: true as const, fact: fact(`${pointer}/${property.name}`) })), fact: fact(pointer) };
}

function objectExpression(pointer: string, fields: Array<{ name: string; expression: StructuredValueExpression }>): StructuredValueExpression {
  return { kind: "object", fields: fields.map((field) => ({ ...field, fact: fact(`${pointer}/${field.name}`) })), fact: fact(pointer) };
}

function createFixture(): { workPack: SdkImplementationWorkPack; schemaIndex: ApprovedStructuredSdkSchemaIndex; contract: StructuredSdkSemanticContract } {
  const workPack = createWorkPack();
  const lineSchema = objectSchema("#/schemas/line", [{ name: "sku", schema: stringSchema("#/schemas/line/sku") }, { name: "quantity", schema: numberSchema("#/schemas/line/quantity") }]);
  const requestSchema = objectSchema("#/schemas/request", [
    { name: "orderRef", schema: stringSchema("#/schemas/request/orderRef") },
    { name: "supplier", schema: objectSchema("#/schemas/request/supplier", [{ name: "supplierId", schema: stringSchema("#/schemas/request/supplier/supplierId") }]) },
    { name: "lines", schema: { kind: "array", maximumItems: 20, items: lineSchema, fact: fact("#/schemas/request/lines") } },
  ]);
  const querySchema = objectSchema("#/schemas/query", [
    { name: "reference", schema: stringSchema("#/schemas/query/reference") },
    { name: "fields", schema: { kind: "array", maximumItems: 8, items: stringSchema("#/schemas/query/fields/items"), fact: fact("#/schemas/query/fields") } },
  ]);
  const actionExpression = objectExpression("review://action/request", [
    { name: "orderRef", expression: scalarExpression("orderRef") },
    { name: "supplier", expression: objectExpression("review://action/request/supplier", [{ name: "supplierId", expression: scalarExpression("supplierId") }]) },
    { name: "lines", expression: { kind: "bounded-array", source: "workflow-input", key: "lines", maximumItems: 20, fact: fact("review://action/request/lines") } },
  ]);
  const queryExpression = objectExpression("review://query", [
    { name: "reference", expression: scalarExpression("orderRef") },
    { name: "fields", expression: { kind: "bounded-array", source: "trusted-context", key: "observationFields", maximumItems: 8, fact: fact("review://query/fields") } },
  ]);
  const roleSchemas = workPack.roles.map((role) => {
    const schema = role.review.role === "action" ? requestSchema : role.review.role === "no-write-probe" ? stringSchema("#/schemas/orderRef") : querySchema;
    const parameter = role.method.parameters[0]!;
    return { role: role.review.role, parameter: parameter.name, declaredType: parameter.type as "string" | "Record<string, unknown>", methodDigest: role.methodDigest, sdkSourceDigest: workPack.sdkSourceDigest, sourcePointer: parameter.sourcePointer, schema, schemaDigest: structuredSdkDigest(schema), fact: fact(`${parameter.sourcePointer}/review`) };
  });
  const schemaIndexPayload = { schemaVersion: "1.0" as const, providerId: workPack.providerId, sdkSourceDigest: workPack.sdkSourceDigest, localReference: "fixture://structured-supplier/sdk", approved: true as const, parameters: roleSchemas };
  const schemaIndex: ApprovedStructuredSdkSchemaIndex = { ...schemaIndexPayload, indexDigest: structuredSdkDigest(schemaIndexPayload) };
  const parameters = workPack.roles.map((role) => {
    const pinned = roleSchemas.find((candidate) => candidate.role === role.review.role)!;
    const structured = role.review.role === "action" ? actionExpression : role.review.role === "no-write-probe" ? scalarExpression("orderRef") : queryExpression;
    return { role: role.review.role, parameter: role.method.parameters[0]!.name, pinnedSchemaDigest: pinned.schemaDigest, expression: structured, fact: fact(`${role.method.sourcePointer}/mapping`) };
  });
  const payload = {
    schemaVersion: "1.0" as const,
    contractId: "structured-supplier-contract-v1",
    providerId: workPack.providerId,
    sdkSourceDigest: workPack.sdkSourceDigest,
    workPackDigest: workPack.workPackDigest,
    schemaIndexDigest: schemaIndex.indexDigest,
    roles: workPack.roles.map((role) => ({ role: role.review.role, methodDigest: role.methodDigest, fact: fact(`${role.method.sourcePointer}/role`) })),
    parameters,
    credentials: { action: { alias: "cred.supplier.writer", exactScope: "procurement.orders.write", fact: fact("policy://writer") }, observer: { alias: "cred.supplier.audit", exactScope: "procurement.orders.read", fact: fact("policy://observer") } },
    stableIdentity: { expression: expression("orderRef"), collisionPolicy: "reject-conflict" as const, fact: fact("policy://identity") },
    idempotency: { expression: expression("orderRef"), conflictIdentity: [expression("orderRef"), expression("supplierId")], reconcileBeforeRetry: true as const, blindRetryAllowed: false as const, fact: fact("policy://idempotency") },
    reconciliation: { role: "reconciliation-readback" as const, notFoundClassification: "not-started" as const, multipleClassification: "duplicate" as const, fact: fact("policy://reconciliation") },
    observer: { role: "independent-observer" as const, sourceId: "supplier-independent-audit", authIndependent: true as const, differentMethodFromAction: true as const, fact: fact("policy://observer") },
    outcome: { predicates: [{ key: "order-ref", path: ["orderRef"], operator: "equals-input" as const, inputKey: "orderRef", fact: fact("outcome://orderRef") }, { key: "status", path: ["status"], operator: "equals-confirmed" as const, expected: "draft", fact: fact("outcome://status") }], duplicate: { collectionPath: ["matches"], expectedCount: 1 as const, fact: fact("outcome://duplicates") }, collateral: [{ key: "collateral-clean", path: ["collateralClean"], operator: "equals-confirmed" as const, expected: true, fact: fact("outcome://collateral") }], freshness: { path: ["observedAt"], maximumAgeSeconds: 60, notBefore: "operation-start" as const, fact: fact("outcome://freshness") }, fact: fact("outcome://root") },
    pagination: { roles: [{ role: "reconciliation-readback" as const, mode: "not-paginated" as const, maximumPages: 1 as const, fact: fact("policy://pagination/reconcile") }, { role: "independent-observer" as const, mode: "not-paginated" as const, maximumPages: 1 as const, fact: fact("policy://pagination/observer") }], complete: true as const, fact: fact("policy://pagination") },
    policy: { timeoutMilliseconds: 5_000, maximumRequestsPerMinute: 60, maximumAttempts: 2 as const, retryableErrors: ["TimeoutBeforeCommit"], terminalErrors: ["Unauthorized", "Conflict"], fact: fact("policy://runtime") },
    pinnedParameters: roleSchemas,
    sourceDigest: structuredSdkDigest({ provider: workPack.providerId, review: 1 }),
    expiresAt,
    executionAuthorityEffect: "none" as const,
    activationEffect: "none" as const,
  };
  return { workPack, schemaIndex, contract: { ...payload, contractDigest: structuredSdkDigest(payload) } };
}

class FictionalStructuredInvoker implements StructuredSdkInvoker {
  readonly actionBindingDigest = structuredSdkDigest({ process: "supplier-action", version: 1 });
  readonly observerBindingDigest = structuredSdkDigest({ process: "supplier-independent-observer", version: 1 });
  readonly records = new Map<string, { orderRef: string; status: "draft"; request: unknown; observedAt: string }>();
  readonly calls: StructuredSdkInvocation[] = [];
  constructor(readonly implementationDigest: string) {}
  async invoke(invocation: StructuredSdkInvocation) {
    this.calls.push(structuredClone(invocation));
    if (invocation.role === "no-write-probe") return { status: "ok" as const, value: { reachable: true }, observedAt: now, paginationComplete: true };
    if (invocation.role === "action") {
      const request = invocation.parameters.request as { orderRef: string };
      this.records.set(request.orderRef, { orderRef: request.orderRef, status: "draft", request: structuredClone(request), observedAt: now });
      return { status: "ok" as const, value: { accepted: true }, observedAt: now, paginationComplete: true };
    }
    const query = invocation.parameters.query as { reference: string; fields: string[] };
    const record = this.records.get(query.reference);
    if (!record) return { status: "not-found" as const, value: { orderRef: query.reference, matches: [], collateralClean: true, observedAt: now }, observedAt: now, paginationComplete: true };
    return { status: "ok" as const, value: { orderRef: record.orderRef, status: record.status, matches: [record], collateralClean: true, observedAt: record.observedAt, requestedFields: query.fields }, observedAt: now, paginationComplete: true };
  }
}

function acceptance(compiled: ReturnType<typeof compileStructuredSdkSemanticContract>, contract: StructuredSdkSemanticContract, workPack: SdkImplementationWorkPack, invoker: FictionalStructuredInvoker): StructuredSdkAcceptanceEvidence {
  const payload = { schemaVersion: "1.0" as const, state: "fictional-local-acceptance-passed" as const, caseIds: [...REQUIRED_PILOT_ADAPTER_CASES], passed: true as const, incorrectSideEffects: 0 as const, contractDigest: contract.contractDigest, workPackDigest: workPack.workPackDigest, implementationDigest: compiled.implementationDigest, actionBindingDigest: invoker.actionBindingDigest, observerBindingDigest: invoker.observerBindingDigest, separateBindingsProven: true as const, customerEnvironmentAccepted: false as const, activationAuthorized: false as const };
  return { ...payload, evidenceDigest: structuredSdkAcceptanceEvidenceDigest(payload) };
}

function refreshContract(contract: StructuredSdkSemanticContract): void {
  contract.contractDigest = structuredSdkDigest(Object.fromEntries(Object.entries(contract).filter(([key]) => key !== "contractDigest")));
}

function refreshWorkPack(workPack: SdkImplementationWorkPack): void {
  workPack.workPackDigest = sdkWorkPackDigest(Object.fromEntries(Object.entries(workPack).filter(([key]) => key !== "workPackDigest")));
}

function refreshSchemaIndex(fixture: ReturnType<typeof createFixture>): void {
  fixture.schemaIndex.indexDigest = structuredSdkDigest(Object.fromEntries(Object.entries(fixture.schemaIndex).filter(([key]) => key !== "indexDigest")));
  fixture.contract.schemaIndexDigest = fixture.schemaIndex.indexDigest;
}

function jsonSchema(schema: BoundedSdkValueSchema): Record<string, unknown> {
  if (schema.kind === "string" || schema.kind === "number" || schema.kind === "boolean") return { type: schema.kind };
  if (schema.kind === "array") return { type: "array", maximumItems: schema.maximumItems, items: jsonSchema(schema.items) };
  return { type: "object", additionalProperties: false, required: schema.properties.map((property) => property.name), properties: Object.fromEntries(schema.properties.map((property) => [property.name, jsonSchema(property.schema)])) };
}

function sourceMetadata(fixture: ReturnType<typeof createFixture>): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    providerId: fixture.workPack.providerId,
    methods: fixture.workPack.roles.map((role) => ({
      module: role.method.module,
      className: role.method.className,
      methodName: role.method.methodName,
      overloadId: role.method.overloadId,
      sourcePointer: role.method.sourcePointer,
      parameters: role.method.parameters.map((parameter) => ({ name: parameter.name, required: parameter.required, declaredType: parameter.type, sourcePointer: parameter.sourcePointer, schema: jsonSchema(fixture.schemaIndex.parameters.find((candidate) => candidate.role === role.review.role && candidate.parameter === parameter.name)!.schema) })),
    })),
  };
}

function bindWorkPackToSource(fixture: ReturnType<typeof createFixture>, bytes: string): void {
  const digest = structuredSdkSourceBytesDigest(bytes);
  fixture.workPack.sdkSourceDigest = digest;
  for (const role of fixture.workPack.roles) role.provenance.sdkSourceDigest = digest;
  refreshWorkPack(fixture.workPack);
}

function schemaReviews(fixture: ReturnType<typeof createFixture>): StructuredSdkSchemaReview[] {
  return fixture.workPack.roles.flatMap((role) => role.method.parameters.map((parameter) => ({ role: role.review.role, parameter: parameter.name, methodDigest: role.methodDigest, expectedSchemaPointer: `${parameter.sourcePointer}/schema`, reviewerAlias: "fixtureEngineer", reviewedAt: now, exactOneToOne: true as const })));
}

function onboardingInput(fixture: ReturnType<typeof createFixture>, journeyId = "cf081StructuredJourney"): StructuredSdkOnboardingInput {
  const sourceBytes = `${JSON.stringify(sourceMetadata(fixture), null, 2)}\n`;
  bindWorkPackToSource(fixture, sourceBytes);
  return { schemaVersion: "1.0", journeyId, tenantId: "cf081Tenant", sourceBytes, expectedSourceDigest: structuredSdkSourceBytesDigest(sourceBytes), localReference: "fixture://structured-supplier/sdk", workPack: fixture.workPack, schemaReviews: schemaReviews(fixture), baseContract: baseContract(fixture), workflowSourceDigest: structuredSdkDigest({ workflow: "cf081-supplier-restock", version: 1 }), availableInputs: draftSource(fixture).availableInputs, createdAt: now };
}

function answerOnboarding(journey: DurableStructuredSdkOnboardingJourney, input: StructuredSdkOnboardingInput, initial: StructuredSdkOnboardingReceipt, maximum = Number.POSITIVE_INFINITY): StructuredSdkOnboardingReceipt {
  let receipt = initial;
  let answered = 0;
  while (receipt.state === "structured-review-in-progress" && answered < maximum) {
    const question = receipt.questions.find((candidate) => candidate.state === "ready")!;
    let value;
    let sourcePointer;
    let sourceDigest;
    if (question.kind === "confirm-object-shape") {
      value = { kind: "shape-confirmation" as const, confirmed: true as const, schemaDigest: question.schemaDigest };
      sourcePointer = `schema://${question.role}/${question.parameter}/${question.path.join("/") || "$"}`;
      sourceDigest = receipt.schemaIndexDigest;
    } else if (question.kind === "map-bounded-array") {
      const key = question.path.at(-1) === "fields" ? "observationFields" : "lines";
      const available = input.availableInputs.find((candidate) => candidate.key === key)!;
      value = { kind: "array-source" as const, source: available.source, key, maximumItems: question.maximumItems! };
      sourcePointer = available.sourcePointer;
      sourceDigest = input.workflowSourceDigest;
    } else {
      const key = question.path.at(-1) === "supplierId" ? "supplierId" : "orderRef";
      const available = input.availableInputs.find((candidate) => candidate.key === key)!;
      value = { kind: "scalar-source" as const, source: available.source, key, convert: "identity" as const };
      sourcePointer = available.sourcePointer;
      sourceDigest = input.workflowSourceDigest;
    }
    receipt = journey.answer({ journeyId: input.journeyId, expectedReceiptDigest: receipt.receiptDigest, questionId: question.questionId, value, reviewerAlias: "fixtureEngineer", reviewedAt: now, sourcePointer, sourceDigest });
    answered += 1;
  }
  return receipt;
}

const declarationSource = `
declare class OrderClient {
  createDraft(request: {
    orderRef: string;
    supplier: { supplierId: string };
    /** @maximumItems 20 */
    lines: Array<{ sku: string; quantity: number }>;
  }): Promise<Record<string, unknown>>;
  probe(orderRef: string): Promise<Record<string, unknown>>;
}
declare class OrderReadClient {
  findDraft(query: {
    reference: string;
    /** @maximumItems 8 */
    fields: Array<string>;
  }): Promise<Record<string, unknown>>;
}
declare class AuditClient {
  observeDraft(query: {
    reference: string;
    /** @maximumItems 8 */
    fields: Array<string>;
  }): Promise<Record<string, unknown>>;
}
`;

function declarationReviews(): TypeScriptSdkMethodReview[] {
  return [
    { className: "OrderClient", methodName: "createDraft", overloadId: "v1", reviewerAlias: "fixtureEngineer", reviewedAt: now, exactOneToOne: true },
    { className: "OrderClient", methodName: "probe", overloadId: "v1", reviewerAlias: "fixtureEngineer", reviewedAt: now, exactOneToOne: true },
    { className: "OrderReadClient", methodName: "findDraft", overloadId: "v1", reviewerAlias: "fixtureEngineer", reviewedAt: now, exactOneToOne: true },
    { className: "AuditClient", methodName: "observeDraft", overloadId: "v1", reviewerAlias: "fixtureEngineer", reviewedAt: now, exactOneToOne: true },
  ];
}

function bindWorkPackToNormalizedDeclarations(fixture: ReturnType<typeof createFixture>, normalizedBytes: string): void {
  const normalized = JSON.parse(normalizedBytes) as { methods: Array<{ className: string; methodName: string; sourcePointer: string; parameters: Array<{ name: string; sourcePointer: string; declaredType: string }> }> };
  const digest = structuredSdkSourceBytesDigest(normalizedBytes);
  for (const role of fixture.workPack.roles) {
    const method = normalized.methods.find((candidate) => candidate.className === role.method.className && candidate.methodName === role.method.methodName)!;
    role.method.module = "supplier-sdk";
    role.review.module = "supplier-sdk";
    role.method.sourcePointer = method.sourcePointer;
    role.review.expectedSourcePointer = method.sourcePointer;
    for (const parameter of role.method.parameters) {
      const normalizedParameter = method.parameters.find((candidate) => candidate.name === parameter.name)!;
      parameter.sourcePointer = normalizedParameter.sourcePointer;
      parameter.type = normalizedParameter.declaredType;
    }
    role.methodDigest = sdkWorkPackDigest(role.method);
    role.provenance.sourcePointer = method.sourcePointer;
    role.provenance.localReference = "fixture://structured-supplier/sdk-normalized";
    role.provenance.sdkSourceDigest = digest;
  }
  fixture.workPack.sdkSourceDigest = digest;
  refreshWorkPack(fixture.workPack);
}

function baseContract(fixture: ReturnType<typeof createFixture>): SdkSemanticContract {
  const structured = fixture.contract;
  const payload = {
    schemaVersion: "1.0" as const,
    contractId: "structured-supplier-base-contract",
    providerId: fixture.workPack.providerId,
    sdkSourceDigest: fixture.workPack.sdkSourceDigest,
    workPackDigest: fixture.workPack.workPackDigest,
    roles: structured.roles,
    parameterMappings: fixture.workPack.roles.map((role) => ({ role: role.review.role, parameter: role.method.parameters[0]!.name, expression: expression("orderRef"), fact: fact(`${role.method.sourcePointer}/base-placeholder`) })),
    credentials: structured.credentials,
    stableIdentity: structured.stableIdentity,
    idempotency: structured.idempotency,
    reconciliation: structured.reconciliation,
    observer: structured.observer,
    outcome: structured.outcome,
    pagination: structured.pagination,
    policy: structured.policy,
    sourceDigest: sdkSemanticDigest({ base: structured.providerId }),
    expiresAt: structured.expiresAt,
    executionAuthorityEffect: "none" as const,
    activationEffect: "none" as const,
  };
  return { ...payload, contractDigest: sdkSemanticDigest(payload) };
}

function draftSource(fixture: ReturnType<typeof createFixture>, sessionId = "cf079StructuredDraft"): StructuredSdkDraftSource {
  return {
    schemaVersion: "1.0",
    sessionId,
    tenantId: "cf079Tenant",
    workPack: fixture.workPack,
    schemaIndex: fixture.schemaIndex,
    baseContract: baseContract(fixture),
    workflowSourceDigest: structuredSdkDigest({ workflow: "supplier-restock", version: 1 }),
    availableInputs: [
      { source: "workflow-input", key: "orderRef", type: "string", sourcePointer: "workflow://inputs/orderRef" },
      { source: "workflow-input", key: "supplierId", type: "string", sourcePointer: "workflow://inputs/supplierId" },
      { source: "workflow-input", key: "lines", type: "array", sourcePointer: "workflow://inputs/lines" },
      { source: "trusted-context", key: "observationFields", type: "array", sourcePointer: "workflow://context/observationFields" },
    ],
    createdAt: now,
  };
}

function answerAll(flow: DurableStructuredSdkSemanticDraftWorkflow, source: StructuredSdkDraftSource, initial: ReturnType<DurableStructuredSdkSemanticDraftWorkflow["start"]>) {
  let snapshot = initial;
  while (snapshot.state === "review-in-progress") {
    const question = snapshot.questions.find((candidate) => candidate.state === "ready")!;
    let value;
    let sourcePointer;
    let sourceDigest;
    if (question.kind === "confirm-object-shape") {
      value = { kind: "shape-confirmation" as const, confirmed: true as const, schemaDigest: question.schemaDigest };
      sourcePointer = `schema://${question.role}/${question.parameter}/${question.path.join("/") || "$"}`;
      sourceDigest = source.schemaIndex.indexDigest;
    } else if (question.kind === "map-bounded-array") {
      const key = question.path.at(-1) === "fields" ? "observationFields" : "lines";
      const available = source.availableInputs.find((candidate) => candidate.key === key)!;
      value = { kind: "array-source" as const, source: available.source, key, maximumItems: question.maximumItems! };
      sourcePointer = available.sourcePointer;
      sourceDigest = source.workflowSourceDigest;
    } else {
      const key = question.path.at(-1) === "supplierId" ? "supplierId" : "orderRef";
      const available = source.availableInputs.find((candidate) => candidate.key === key)!;
      value = { kind: "scalar-source" as const, source: available.source, key, convert: "identity" as const };
      sourcePointer = available.sourcePointer;
      sourceDigest = source.workflowSourceDigest;
    }
    snapshot = flow.answer({ sessionId: source.sessionId, expectedSnapshotDigest: snapshot.snapshotDigest, expectedRevision: snapshot.revision, questionId: question.questionId, value, reviewerAlias: "fixtureEngineer", reviewedAt: now, sourcePointer, sourceDigest });
  }
  return snapshot;
}

describe("bounded structured SDK semantic compiler", () => {
  it("constructs a fixed nested action payload and bounded homogeneous arrays while keeping action and observation separate", async () => {
    const { workPack, schemaIndex, contract } = createFixture();
    const compiled = compileStructuredSdkSemanticContract({ contract, workPack, schemaIndex, now });
    await expect(compiled.action()).rejects.toThrow(/non-executable/i);
    const invoker = new FictionalStructuredInvoker(compiled.implementationDigest);
    const runtime = attachStructuredSdkLocalAcceptance({ compiled, contract, workPack, schemaIndex, invoker, acceptance: acceptance(compiled, contract, workPack, invoker), now });
    const input = { orderRef: "ORDER-078", supplierId: "SUPPLIER-EAST", lines: [{ sku: "SKU-1", quantity: 2 }, { sku: "SKU-2", quantity: 3 }] };
    const context = { observationFields: ["orderRef", "status", "observedAt"] };
    await runtime.probe(input, context);
    await runtime.action(input, context);
    expect(await runtime.reconcile(input, context)).toMatchObject({ classification: "completed" });
    expect(await runtime.observe(input, context, Date.parse(now))).toMatchObject({ passed: true, classification: "completed" });
    expect(invoker.calls[1]).toMatchObject({ role: "action", parameters: { request: { orderRef: "ORDER-078", supplier: { supplierId: "SUPPLIER-EAST" }, lines: [{ sku: "SKU-1", quantity: 2 }, { sku: "SKU-2", quantity: 3 }] } }, credentialAlias: "cred.supplier.writer", scope: "procurement.orders.write" });
    expect(invoker.calls[3]).toMatchObject({ role: "independent-observer", parameters: { query: { reference: "ORDER-078", fields: ["orderRef", "status", "observedAt"] } }, credentialAlias: "cred.supplier.audit", scope: "procurement.orders.read" });
    expect(runtime).toMatchObject({ state: "fictional-local-acceptance-attached-not-activated", executionAuthorityEffect: "none", activationEffect: "none" });
  });

  it("fails before transport when a bounded array is too large or a nested object has an extra field", async () => {
    const { workPack, schemaIndex, contract } = createFixture();
    const compiled = compileStructuredSdkSemanticContract({ contract, workPack, schemaIndex, now });
    const invoker = new FictionalStructuredInvoker(compiled.implementationDigest);
    const runtime = attachStructuredSdkLocalAcceptance({ compiled, contract, workPack, schemaIndex, invoker, acceptance: acceptance(compiled, contract, workPack, invoker), now });
    await expect(runtime.action({ orderRef: "TOO-LARGE", supplierId: "S", lines: Array.from({ length: 21 }, (_, index) => ({ sku: `SKU-${index}`, quantity: 1 })) }, { observationFields: ["status"] })).rejects.toThrow(/bound/i);
    await expect(runtime.action({ orderRef: "EXTRA", supplierId: "S", lines: [{ sku: "SKU", quantity: 1, unsafe: true }] }, { observationFields: ["status"] })).rejects.toThrow(/additional property/i);
    expect(invoker.calls).toHaveLength(0);
  });

  it.each([
    ["unbounded collection", (fixture: ReturnType<typeof createFixture>) => { const schema = fixture.contract.pinnedParameters[0]!.schema as Extract<BoundedSdkValueSchema, { kind: "object" }>; (schema.properties.find((property) => property.name === "lines")!.schema as Extract<BoundedSdkValueSchema, { kind: "array" }>).maximumItems = 0; fixture.contract.pinnedParameters[0]!.schemaDigest = structuredSdkDigest(schema); fixture.contract.parameters[0]!.pinnedSchemaDigest = fixture.contract.pinnedParameters[0]!.schemaDigest; refreshSchemaIndex(fixture); refreshContract(fixture.contract); }, /maximumItems/i],
    ["auth-shaped payload field", (fixture: ReturnType<typeof createFixture>) => { const schema = fixture.contract.pinnedParameters[0]!.schema as Extract<BoundedSdkValueSchema, { kind: "object" }>; schema.properties[0]!.name = "accessToken"; fixture.contract.pinnedParameters[0]!.schemaDigest = structuredSdkDigest(schema); fixture.contract.parameters[0]!.pinnedSchemaDigest = fixture.contract.pinnedParameters[0]!.schemaDigest; (fixture.contract.parameters[0]!.expression as Extract<StructuredValueExpression, { kind: "object" }>).fields[0]!.name = "accessToken"; refreshSchemaIndex(fixture); refreshContract(fixture.contract); }, /auth-shaped/i],
    ["authority widening", (fixture: ReturnType<typeof createFixture>) => { fixture.contract.credentials.action.exactScope = "admin.*"; refreshContract(fixture.contract); }, /widens authority/i],
    ["custom transform", (fixture: ReturnType<typeof createFixture>) => { ((fixture.contract.parameters[1]!.expression as unknown) as { kind: string }).kind = "custom-code"; refreshContract(fixture.contract); }, /primitive SDK field|scalar source/i],
    ["union declaration", (fixture: ReturnType<typeof createFixture>) => { fixture.workPack.roles[1]!.method.parameters[0]!.type = "string | number"; fixture.workPack.roles[1]!.methodDigest = sdkWorkPackDigest(fixture.workPack.roles[1]!.method); fixture.contract.roles[1]!.methodDigest = fixture.workPack.roles[1]!.methodDigest; fixture.contract.pinnedParameters[1]!.methodDigest = fixture.workPack.roles[1]!.methodDigest; fixture.contract.pinnedParameters[1]!.declaredType = "string | number" as never; refreshWorkPack(fixture.workPack); fixture.contract.workPackDigest = fixture.workPack.workPackDigest; refreshSchemaIndex(fixture); refreshContract(fixture.contract); }, /declaration/i],
  ])("rejects %s without producing an executable adapter", (_label, mutate, expected) => {
    const fixture = createFixture();
    mutate(fixture);
    expect(() => compileStructuredSdkSemanticContract({ ...fixture, now })).toThrow(expected);
  });

  it("rejects recursive schema material before digest or compilation", () => {
    const fixture = createFixture();
    const schema = fixture.contract.pinnedParameters[0]!.schema as Extract<BoundedSdkValueSchema, { kind: "object" }>;
    (schema.properties[0] as unknown as { schema: BoundedSdkValueSchema }).schema = schema;
    expect(() => structuredSdkDigest(fixture.contract)).toThrow(/recursive|cyclic/i);
    expect(() => compileStructuredSdkSemanticContract({ ...fixture, now })).toThrow(/recursive|cyclic/i);
  });

  it("rejects a mutated or source-substituted structured schema index", () => {
    const mutated = createFixture();
    mutated.schemaIndex.parameters[0]!.sourcePointer = "#/forged/parameter";
    expect(() => compileStructuredSdkSemanticContract({ ...mutated, now })).toThrow(/index.*stale|integrity/i);
    const substituted = createFixture();
    substituted.schemaIndex.localReference = "fixture://different-provider/sdk";
    refreshSchemaIndex(substituted);
    substituted.contract.schemaIndexDigest = substituted.schemaIndex.indexDigest;
    refreshContract(substituted.contract);
    expect(() => compileStructuredSdkSemanticContract({ ...substituted, now })).toThrow(/exact reviewed SDK source location/i);
  });

  it("rejects conflated action/observer bindings and tampered acceptance evidence", () => {
    const { workPack, schemaIndex, contract } = createFixture();
    const compiled = compileStructuredSdkSemanticContract({ contract, workPack, schemaIndex, now });
    const invoker = new FictionalStructuredInvoker(compiled.implementationDigest);
    (invoker as { observerBindingDigest: string }).observerBindingDigest = invoker.actionBindingDigest;
    expect(() => attachStructuredSdkLocalAcceptance({ compiled, contract, workPack, schemaIndex, invoker, acceptance: acceptance(compiled, contract, workPack, invoker), now })).toThrow(/distinct content-addressed bindings/i);
    const independent = new FictionalStructuredInvoker(compiled.implementationDigest);
    const evidence = acceptance(compiled, contract, workPack, independent);
    evidence.caseIds.pop();
    expect(() => attachStructuredSdkLocalAcceptance({ compiled, contract, workPack, schemaIndex, invoker: independent, acceptance: evidence, now })).toThrow(/acceptance evidence/i);
  });
});

describe("durable assisted review for bounded structured SDK contracts", () => {
  it("turns dependency-ordered nested-field decisions into the exact CF-078 contract and survives restart", async () => {
    const fixture = createFixture();
    const source = draftSource(fixture);
    const databasePath = await temporaryDatabase("joined");
    let flow = new DurableStructuredSdkSemanticDraftWorkflow(databasePath, { now: () => now });
    const initial = flow.start(source);
    expect(initial.metrics).toMatchObject({ questions: 12, answered: 0, shapeConfirmations: 4, scalarMappings: 5, arrayMappings: 3, manualContractObjects: 0 });
    expect(initial.questions.filter((question) => question.state === "ready")).toHaveLength(4);
    const answered = answerAll(flow, source, initial);
    expect(answered).toMatchObject({ state: "review-ready", blockers: [], metrics: { questions: 12, answered: 12, ready: 0, blocked: 0 } });
    flow.close();
    flow = new DurableStructuredSdkSemanticDraftWorkflow(databasePath, { now: () => now });
    expect(flow.read(source.sessionId).snapshotDigest).toBe(answered.snapshotDigest);
    const reviewed = flow.review({ sessionId: source.sessionId, expectedSnapshotDigest: answered.snapshotDigest, expectedRevision: answered.revision, reviewerAlias: "fixtureEngineer", reviewedAt: now, expiresAt, dryRun: true });
    expect(reviewed.state).toBe("reviewed-structured-contract-ready");
    expect(flow.read(source.sessionId).state).toBe("review-ready");
    const final = flow.review({ sessionId: source.sessionId, expectedSnapshotDigest: answered.snapshotDigest, expectedRevision: answered.revision, reviewerAlias: "fixtureEngineer", reviewedAt: now, expiresAt });
    expect(final.reviewedContract).not.toBeNull();
    expect(compileStructuredSdkSemanticContract({ contract: final.reviewedContract!, workPack: source.workPack, schemaIndex: source.schemaIndex, now })).toMatchObject({ state: "acceptance-only-structured-non-executable", executionAuthorityEffect: "none", activationEffect: "none" });
    const action = final.reviewedContract!.parameters.find((parameter) => parameter.role === "action")!.expression;
    expect(action.kind).toBe("object");
    if (action.kind !== "object") throw new Error("Expected the reviewed action mapping to remain a fixed object.");
    expect(action.fields.find((field) => field.name === "supplier")!.expression).toMatchObject({ kind: "object" });
    expect(action.fields.find((field) => field.name === "lines")!.expression).toMatchObject({ kind: "bounded-array", key: "lines", maximumItems: 20 });
    flow.close();
  });

  it("blocks incomplete review, dependency bypass, stale answers and authority-shaped inventory", () => {
    const fixture = createFixture();
    const source = draftSource(fixture, "cf079Controls");
    const flow = new DurableStructuredSdkSemanticDraftWorkflow(":memory:", { now: () => now });
    const initial = flow.start(source);
    expect(() => flow.review({ sessionId: source.sessionId, expectedSnapshotDigest: initial.snapshotDigest, expectedRevision: initial.revision, reviewerAlias: "fixtureEngineer", reviewedAt: now, expiresAt })).toThrow(/decisions remain/i);
    const blocked = initial.questions.find((question) => question.state === "blocked")!;
    expect(() => flow.answer({ sessionId: source.sessionId, expectedSnapshotDigest: initial.snapshotDigest, expectedRevision: initial.revision, questionId: blocked.questionId, value: { kind: "scalar-source", source: "workflow-input", key: "orderRef", convert: "identity" }, reviewerAlias: "fixtureEngineer", reviewedAt: now, sourcePointer: "workflow://inputs/orderRef", sourceDigest: source.workflowSourceDigest })).toThrow(/dependencies/i);
    const first = initial.questions.find((question) => question.state === "ready")!;
    const next = flow.answer({ sessionId: source.sessionId, expectedSnapshotDigest: initial.snapshotDigest, expectedRevision: initial.revision, questionId: first.questionId, value: { kind: "shape-confirmation", confirmed: true, schemaDigest: first.schemaDigest }, reviewerAlias: "fixtureEngineer", reviewedAt: now, sourcePointer: "schema://root", sourceDigest: source.schemaIndex.indexDigest });
    expect(() => flow.answer({ sessionId: source.sessionId, expectedSnapshotDigest: initial.snapshotDigest, expectedRevision: initial.revision, questionId: next.questions.find((question) => question.state === "ready")!.questionId, value: { kind: "scalar-source", source: "workflow-input", key: "orderRef", convert: "identity" }, reviewerAlias: "fixtureEngineer", reviewedAt: now, sourcePointer: "workflow://inputs/orderRef", sourceDigest: source.workflowSourceDigest })).toThrow(/stale/i);
    flow.close();
    const hostile = draftSource(createFixture(), "cf079Hostile");
    hostile.availableInputs.push({ source: "trusted-context", key: "accessToken", type: "string", sourcePointer: "workflow://context/accessToken" });
    const hostileFlow = new DurableStructuredSdkSemanticDraftWorkflow(":memory:", { now: () => now });
    expect(() => hostileFlow.start(hostile)).toThrow(/authentication-shaped/i);
    hostileFlow.close();
  });

  it("detects persisted source mutation and a changed schema index after session creation", async () => {
    const fixture = createFixture();
    const source = draftSource(fixture, "cf079Tamper");
    const databasePath = await temporaryDatabase("tamper");
    const flow = new DurableStructuredSdkSemanticDraftWorkflow(databasePath, { now: () => now });
    flow.start(source);
    flow.close();
    const database = new DatabaseSync(databasePath);
    const row = database.prepare("SELECT source_json FROM structured_sdk_draft_sessions WHERE session_id = ?").get(source.sessionId) as { source_json: string };
    const stored = JSON.parse(row.source_json) as StructuredSdkDraftSource;
    stored.schemaIndex.parameters[0]!.schemaDigest = "0".repeat(64);
    database.prepare("UPDATE structured_sdk_draft_sessions SET source_json = ? WHERE session_id = ?").run(JSON.stringify(stored), source.sessionId);
    database.close();
    const reopened = new DurableStructuredSdkSemanticDraftWorkflow(databasePath, { now: () => now });
    expect(() => reopened.read(source.sessionId)).toThrow(/integrity/i);
    reopened.close();
  });
});

describe("strict source-grounded structured SDK schema extraction", () => {
  it("extracts the exact CF-078 index from pinned local source bytes and feeds the compiler", () => {
    const fixture = createFixture();
    const bytes = `${JSON.stringify(sourceMetadata(fixture), null, 2)}\n`;
    bindWorkPackToSource(fixture, bytes);
    const index = extractApprovedStructuredSdkSchemaIndex({ sourceBytes: bytes, expectedSourceDigest: structuredSdkSourceBytesDigest(bytes), localReference: "fixture://structured-supplier/sdk", workPack: fixture.workPack, reviews: schemaReviews(fixture) });
    expect(index).toMatchObject({ providerId: fixture.workPack.providerId, sdkSourceDigest: structuredSdkSourceBytesDigest(bytes), approved: true });
    expect(index.parameters).toHaveLength(4);
    const actionSchema = index.parameters.find((parameter) => parameter.role === "action")!.schema;
    expect(actionSchema).toMatchObject({ kind: "object", additionalProperties: false });
    fixture.contract.sdkSourceDigest = index.sdkSourceDigest;
    fixture.contract.workPackDigest = fixture.workPack.workPackDigest;
    fixture.contract.schemaIndexDigest = index.indexDigest;
    fixture.contract.pinnedParameters = index.parameters;
    for (const mapping of fixture.contract.parameters) mapping.pinnedSchemaDigest = index.parameters.find((parameter) => parameter.role === mapping.role && parameter.parameter === mapping.parameter)!.schemaDigest;
    refreshContract(fixture.contract);
    expect(compileStructuredSdkSemanticContract({ contract: fixture.contract, workPack: fixture.workPack, schemaIndex: index, now })).toMatchObject({ state: "acceptance-only-structured-non-executable" });
  });

  it.each([
    ["reference", (source: any) => { source.methods[0].parameters[0].schema = { $ref: "#/definitions/Request" }; }, /reference|unsupported/i],
    ["union", (source: any) => { source.methods[0].parameters[0].schema.type = ["object", "null"]; }, /unions/i],
    ["optional field", (source: any) => { source.methods[0].parameters[0].schema.required.pop(); }, /required|optional/i],
    ["additional properties", (source: any) => { source.methods[0].parameters[0].schema.additionalProperties = true; }, /additionalProperties/i],
    ["missing collection bound", (source: any) => { delete source.methods[0].parameters[0].schema.properties.lines.maximumItems; }, /maximumItems/i],
    ["auth-shaped field", (source: any) => { const schema = source.methods[0].parameters[0].schema; schema.properties.accessToken = { type: "string" }; schema.required.push("accessToken"); }, /authentication-shaped/i],
    ["custom transform", (source: any) => { source.methods[0].parameters[0].schema["x-transform"] = "run arbitrary mapper"; }, /unsupported transform|unsupported/i],
    ["method substitution", (source: any) => { source.methods[0].methodName = "differentMethod"; }, /missing, ambiguous|source method/i],
  ])("stops on %s even when the mutated bytes are re-pinned into the work pack", (_label, mutate, expected) => {
    const fixture = createFixture();
    const source = sourceMetadata(fixture) as any;
    mutate(source);
    const bytes = `${JSON.stringify(source)}\n`;
    bindWorkPackToSource(fixture, bytes);
    expect(() => extractApprovedStructuredSdkSchemaIndex({ sourceBytes: bytes, expectedSourceDigest: structuredSdkSourceBytesDigest(bytes), localReference: "fixture://structured-supplier/sdk", workPack: fixture.workPack, reviews: schemaReviews(fixture) })).toThrow(expected);
  });

  it("rejects byte, path, review and work-pack substitutions before producing an approved index", () => {
    const fixture = createFixture();
    const bytes = `${JSON.stringify(sourceMetadata(fixture))}\n`;
    bindWorkPackToSource(fixture, bytes);
    expect(() => extractApprovedStructuredSdkSchemaIndex({ sourceBytes: `${bytes} `, expectedSourceDigest: structuredSdkSourceBytesDigest(bytes), localReference: "fixture://structured-supplier/sdk", workPack: fixture.workPack, reviews: schemaReviews(fixture) })).toThrow(/do not match/i);
    expect(() => extractApprovedStructuredSdkSchemaIndex({ sourceBytes: bytes, expectedSourceDigest: structuredSdkSourceBytesDigest(bytes), localReference: "fixture://other/sdk", workPack: fixture.workPack, reviews: schemaReviews(fixture) })).toThrow(/do not match/i);
    const staleReviews = schemaReviews(fixture);
    staleReviews[0]!.expectedSchemaPointer = "#/wrong/schema";
    expect(() => extractApprovedStructuredSdkSchemaIndex({ sourceBytes: bytes, expectedSourceDigest: structuredSdkSourceBytesDigest(bytes), localReference: "fixture://structured-supplier/sdk", workPack: fixture.workPack, reviews: staleReviews })).toThrow(/source-pointer mismatched/i);
  });
});

describe("unified structured SDK onboarding readiness journey", () => {
  it("carries pinned source extraction, restart-safe review and acceptance-only compilation in one receipt", async () => {
    const fixture = createFixture();
    const input = onboardingInput(fixture);
    const databasePath = await temporaryDatabase("journey");
    let journey = new DurableStructuredSdkOnboardingJourney(databasePath, { now: () => now });
    const started = journey.start(input);
    expect(started).toMatchObject({ state: "structured-review-in-progress", stages: { sourceBytesPinned: true, exactSchemaReviewsAccepted: true, structuredSchemaIndexReady: true, structuredMappingsComplete: false, bindingQualified: false, executionAuthorized: false, activated: false }, decisions: { total: 12, answered: 0 } });
    const partial = answerOnboarding(journey, input, started, 5);
    expect(partial.decisions.answered).toBe(5);
    journey.close();
    journey = new DurableStructuredSdkOnboardingJourney(databasePath, { now: () => now });
    expect(journey.read(input.journeyId).receiptDigest).toBe(partial.receiptDigest);
    const ready = answerOnboarding(journey, input, partial);
    expect(ready).toMatchObject({ state: "structured-review-ready", stages: { structuredMappingsComplete: true, structuredContractReviewed: false, acceptanceOnlyCompiled: false }, decisions: { total: 12, answered: 12, ready: 0, blocked: 0 } });
    const dry = journey.review({ journeyId: input.journeyId, expectedReceiptDigest: ready.receiptDigest, reviewerAlias: "fixtureEngineer", reviewedAt: now, expiresAt, dryRun: true });
    expect(dry.state).toBe("compiled-acceptance-only");
    expect(journey.read(input.journeyId).state).toBe("structured-review-ready");
    const compiled = journey.review({ journeyId: input.journeyId, expectedReceiptDigest: ready.receiptDigest, reviewerAlias: "fixtureEngineer", reviewedAt: now, expiresAt });
    expect(compiled).toMatchObject({ state: "compiled-acceptance-only", stages: { structuredContractReviewed: true, acceptanceOnlyCompiled: true, bindingQualified: false, customerEnvironmentAccepted: false, executionAuthorized: false, activated: false }, customerExecutable: false, executionAuthorityEffect: "none", activationEffect: "none" });
    expect(compiled.compiledContractDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(compiled.compiledImplementationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(compiled.blockers).toEqual(expect.arrayContaining([expect.stringMatching(/bindings remain unqualified/i), expect.stringMatching(/acceptance remains unrun/i)]));
    journey.close();
  });

  it("rejects stale receipt use and immutable outer-source mutation", async () => {
    const fixture = createFixture();
    const input = onboardingInput(fixture, "cf081Controls");
    const databasePath = await temporaryDatabase("journey-controls");
    const journey = new DurableStructuredSdkOnboardingJourney(databasePath, { now: () => now });
    const started = journey.start(input);
    const first = answerOnboarding(journey, input, started, 1);
    const nextQuestion = first.questions.find((question) => question.state === "ready")!;
    expect(() => journey.answer({ journeyId: input.journeyId, expectedReceiptDigest: started.receiptDigest, questionId: nextQuestion.questionId, value: { kind: "shape-confirmation", confirmed: true, schemaDigest: nextQuestion.schemaDigest }, reviewerAlias: "fixtureEngineer", reviewedAt: now, sourcePointer: "schema://stale", sourceDigest: first.schemaIndexDigest })).toThrow(/stale/i);
    journey.close();
    const database = new DatabaseSync(databasePath);
    const row = database.prepare("SELECT input_json FROM structured_sdk_onboarding_journeys WHERE journey_id = ?").get(input.journeyId) as { input_json: string };
    const changed = JSON.parse(row.input_json) as StructuredSdkOnboardingInput;
    changed.availableInputs[0]!.key = "differentOrderRef";
    database.prepare("UPDATE structured_sdk_onboarding_journeys SET input_json = ? WHERE journey_id = ?").run(JSON.stringify(changed), input.journeyId);
    database.close();
    const reopened = new DurableStructuredSdkOnboardingJourney(databasePath, { now: () => now });
    expect(() => reopened.read(input.journeyId)).toThrow(/immutable input.*integrity/i);
    reopened.close();
  });
});

describe("strict pinned TypeScript declaration normalization", () => {
  it("normalizes inline declared-class shapes into CF-080 metadata with an origin-to-output receipt", () => {
    const normalized = normalizePinnedTypeScriptSdkDeclarations({ providerId: "structured-supplier-sdk", moduleName: "supplier-sdk", localReference: "fixture://structured-supplier/provider.d.ts", sourceBytes: declarationSource, reviews: declarationReviews() });
    expect(normalized.receipt).toMatchObject({ normalizedMethods: 4, normalizedParameters: 4, customerExecutable: false, executionAuthorityEffect: "none", activationEffect: "none" });
    expect(normalized.receipt.originSourceDigest).toBe(structuredSdkSourceBytesDigest(declarationSource));
    expect(normalized.receipt.normalizedSourceDigest).toBe(structuredSdkSourceBytesDigest(normalized.normalizedSourceBytes));
    const metadata = JSON.parse(normalized.normalizedSourceBytes) as any;
    expect(metadata.methods.find((method: any) => method.methodName === "createDraft").parameters[0].schema.properties.lines).toMatchObject({ type: "array", maximumItems: 20, items: { type: "object", additionalProperties: false } });
    const fixture = createFixture();
    bindWorkPackToNormalizedDeclarations(fixture, normalized.normalizedSourceBytes);
    const index = extractApprovedStructuredSdkSchemaIndex({ sourceBytes: normalized.normalizedSourceBytes, expectedSourceDigest: normalized.normalizedSourceDigest, localReference: "fixture://structured-supplier/sdk-normalized", workPack: fixture.workPack, reviews: schemaReviews(fixture) });
    expect(index.parameters).toHaveLength(4);
    expect(index.parameters.find((parameter) => parameter.role === "action")!.schema).toMatchObject({ kind: "object" });
  });

  it.each([
    ["import", `import type { Request } from "sdk";\n${declarationSource}`, /only declared classes|imports/i],
    ["named reference", declarationSource.replace(/request: \{[\s\S]*?\n  \}\): Promise<Record<string, unknown>>;/, "request: NamedRequest): Promise<Record<string, unknown>>;"), /references|named types/i],
    ["optional field", declarationSource.replace("orderRef: string", "orderRef?: string"), /optional/i],
    ["union", declarationSource.replace("orderRef: string", "orderRef: string | number"), /union/i],
    ["unbounded array", declarationSource.replace("/** @maximumItems 20 */", ""), /maximumItems/i],
    ["overload", declarationSource.replace("  probe(orderRef", "  probe(otherRef: string): Promise<Record<string, unknown>>;\n  probe(orderRef"), /overloaded|ambiguous/i],
    ["auth field", declarationSource.replace("orderRef: string", "accessToken: string"), /authentication-shaped|secret-shaped/i],
    ["generic class", declarationSource.replace("declare class OrderClient", "declare class OrderClient<T>"), /non-generic/i],
    ["method implementation", declarationSource.replace("  probe(orderRef: string): Promise<Record<string, unknown>>;", "  probe(orderRef: string): Promise<Record<string, unknown>> { throw new Error('x'); }"), /no implementation body/i],
  ])("rejects %s declarations before normalized source promotion", (_label, source, expected) => {
    expect(() => normalizePinnedTypeScriptSdkDeclarations({ providerId: "structured-supplier-sdk", moduleName: "supplier-sdk", localReference: "fixture://structured-supplier/provider.d.ts", sourceBytes: source, reviews: declarationReviews() })).toThrow(expected);
  });
});
