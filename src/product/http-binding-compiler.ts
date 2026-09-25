import { createHash } from "node:crypto";
import { z } from "zod";
import {
  assertHttpBindingFactoryResultIntegrity,
  type HttpActionBindingDeclaration,
  type HttpBindingFactoryResult,
  type HttpBindingValueSource,
  type HttpObserverBindingDeclaration,
} from "./http-binding-factory.js";
import {
  qualificationReference,
  qualifyVerifierTemplate,
  verifierQualificationDigest,
  type ExpectedVerifierTemplateVerdict,
  type VerifierTemplateControlId,
  type VerifierTemplateQualificationCase,
  type VerifierTemplateQualificationCorpus,
  type VerifierTemplateQualificationReceipt,
  type VerifierTemplateQualificationReference,
} from "./verifier-template-qualification.js";
import { assertBindingQualificationReceipt, assertCustomerLocalQualificationCurrent, type BindingQualificationReceipt, type BindingQualificationRuntime } from "./customer-local-binding-qualification.js";
import {
  assertTrustedCustomerLocalHttpWriteAuthorityIssuer,
  assertTrustedCustomerLocalHttpNotStartedObserverSigner,
  type CustomerLocalHttpNotStartedObserverSigner,
  type CustomerLocalHttpWriteAuthorityIssuer,
  type HttpActionApprovalReceipt,
  type HttpActionAuthorityLease,
  type HttpNotStartedRecoveryEvidence,
  type HttpNotStartedRecoveryReceipt,
  type HttpUnconsumedLeaseReplacementEvidence,
} from "./customer-local-http-write-authority.js";
import { assertAuthorityEnforcedCustomerLocalPinnedHttpsTransport, CustomerLocalPinnedHttpsDispatchUncertainError } from "./customer-local-pinned-https-transport.js";

export const HTTP_BINDING_COMPILER_VERSION = "1.0" as const;

const identifier = z.string().min(1).max(180).regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/).refine((value) => !/^0+$/.test(value));
const timestampSchema = z.string().datetime({ offset: true });
const secretShaped = /(?:bearer\s+[a-z0-9._~+\/-]{8,}|sk-[a-z0-9_-]{12,}|password\s*[:=]|(?:api[_ -]?key|client[_ -]?secret|access[_ -]?token)\s*[:=]\s*["']?[^\s"']{6,})/i;

export interface CustomerLocalCredentialHandle {
  alias: string;
  /** Opaque value exists only at the customer-local transport boundary. */
  value: string;
}

export interface CustomerLocalCredentialResolver {
  resolverId: string;
  implementationDigest: string;
  allowedAliases: string[];
  resolve(alias: string): Promise<CustomerLocalCredentialHandle | null>;
}

export interface CompiledHttpRequest {
  requestId: string;
  parentGoalId: string;
  workItemId: string;
  driverId: string;
  targetAlias: string;
  serverUrl: string;
  operationId: string;
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  credentialAlias: string;
  reconciliationKey: string;
  declarationDigest: string;
}

export interface CompiledHttpResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface CustomerLocalHttpTransport {
  driverId: string;
  sourceId: string;
  serverUrl: string;
  implementationDigest: string;
  supportedMethods: Array<CompiledHttpRequest["method"]>;
  independentlyAuthenticated: boolean;
  independentFromDriverIds: string[];
  /** Present only when the transport consumes a signed lease immediately before a write. */
  writeAuthorityBoundaryDigest?: string;
  /** Exact verifier identity pinned into the transport implementation. */
  writeAuthorityVerifierDigest?: string;
  /**
   * Hardened write path: validates every transport-local guard and reserves
   * bounded local dispatch capacity before authority is issued. The returned
   * object remains inside the trusted compiler and can be dispatched once.
   */
  prepareWrite?(request: CompiledHttpRequest, credential: CustomerLocalCredentialHandle): CustomerLocalPreparedHttpWrite;
  perform(request: CompiledHttpRequest, credential: CustomerLocalCredentialHandle, authorityLease?: HttpActionAuthorityLease): Promise<CompiledHttpResponse>;
}

export interface CustomerLocalPreparedHttpWrite {
  reservationDigest: string;
  requestDigest: string;
  credentialAlias: string;
  dispatch(authorityLease: HttpActionAuthorityLease): Promise<CompiledHttpResponse>;
  cancelBeforeAuthority(): void;
}

export interface HttpActionExecutionGrant {
  schemaVersion: "1.0";
  decision: "authorized";
  authorityCompilationDigest: string;
  actionDeclarationDigest: string;
  targetAlias: string;
  operationId: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  parentGoalId: string;
  workItemId: string;
  authorizedAt: string;
  expiresAt: string;
  approvalReference?: string;
  grantDigest: string;
}

export interface CompiledHttpActionInput {
  requestId: string;
  parentGoalId: string;
  workItemId: string;
  workflowInput: Record<string, unknown>;
  trustedContext: Record<string, unknown>;
  /** Legacy acceptance-only grant. New customer-local paths use a signed authority issuer instead. */
  grant?: HttpActionExecutionGrant;
  /** Required only for an exact reviewed action whose policy requires approval. */
  approvalReceipt?: HttpActionApprovalReceipt;
  /** Optional exact signed observer proof permitting one bounded same-request reissue. */
  notStartedRecovery?: HttpNotStartedRecoveryEvidence;
  /** Optional exact expired/unconsumed generation to retire atomically before replacement. */
  unconsumedReplacement?: HttpUnconsumedLeaseReplacementEvidence;
}

export interface CompiledHttpActionResult {
  status: number;
  actionResponseAvailable: true;
  actionResponseEligibleAsExternalProof: false;
  reconciliationKey: string;
  responseBody: unknown;
}

export class CompiledHttpActionDispatchUncertainError extends Error {
  readonly request: CompiledHttpRequest;
  readonly consumedAuthorityLease: HttpActionAuthorityLease;
  constructor(request: CompiledHttpRequest, consumedAuthorityLease: HttpActionAuthorityLease, cause: unknown) {
    super(`HTTP action dispatch ended without an accepted response after its authority lease was consumed; independent reconciliation is required before any reissue. Cause: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "CompiledHttpActionDispatchUncertainError";
    this.request = deepFreezeJson(structuredClone(request));
    this.consumedAuthorityLease = deepFreezeJson(structuredClone(consumedAuthorityLease));
  }
}

export interface CompiledHttpObservationInput {
  requestId: string;
  parentGoalId: string;
  workItemId: string;
  workflowInput: Record<string, unknown>;
  trustedContext: Record<string, unknown>;
  operationStartedAtEpochMs: number;
  recoveryContext?: { priorLease: HttpActionAuthorityLease; actionRequest: CompiledHttpRequest };
}

export type CompiledHttpObservationClassification =
  | "completed"
  | "not-started"
  | "partial"
  | "incorrect"
  | "duplicate"
  | "stale"
  | "collateral"
  | "unknown"
  | "unavailable";

export interface CompiledHttpObservationResult {
  classification: CompiledHttpObservationClassification;
  passed: boolean;
  nextAction: ExpectedVerifierTemplateVerdict["nextAction"];
  incorrectSideEffects: number;
  stateDigest: string;
  checks: Array<{ key: string; role: "success" | "not-started" | "duplicate" | "collateral" | "freshness"; passed: boolean }>;
  observedAt: string;
  actionResponseUsedAsProof: false;
  notStartedRecoveryReceipt?: HttpNotStartedRecoveryReceipt;
}

export interface CompiledHttpActionAdapter {
  adapterId: string;
  adapterVersion: "1.0.0";
  declarationDigest: string;
  implementationDigest: string;
  activated: false;
  execute(input: CompiledHttpActionInput): Promise<CompiledHttpActionResult>;
}

export interface CompiledHttpObservationAdapter {
  adapterId: string;
  adapterVersion: "1.0.0";
  declarationDigest: string;
  implementationDigest: string;
  qualification: VerifierTemplateQualificationReference;
  activated: false;
  observe(input: CompiledHttpObservationInput): Promise<CompiledHttpObservationResult>;
}

export interface CompiledHttpBindingPair {
  schemaVersion: typeof HTTP_BINDING_COMPILER_VERSION;
  state: "compiled-acceptance-only";
  activated: false;
  customerValidated: false;
  action: CompiledHttpActionAdapter;
  observer: CompiledHttpObservationAdapter;
  observerQualificationReceipt: VerifierTemplateQualificationReceipt;
  dependencies: {
    actionTransportDigest: string;
    observerTransportDigest: string;
    credentialResolverDigest: string;
    primitiveRegistryDigest: string;
    verifierRegistryDigest: string;
    writeAuthorityIssuerDigest?: string;
    writeAuthorityVerifierDigest?: string;
  };
  blockers: [];
  evidenceBoundary: string;
  pairDigest: string;
}

export interface CompileHttpBindingsInput {
  factoryResult: HttpBindingFactoryResult;
  actionTransport: CustomerLocalHttpTransport;
  observerTransport: CustomerLocalHttpTransport;
  credentialResolver: CustomerLocalCredentialResolver;
  primitiveRegistryDigest: string;
  verifierRegistryDigest: string;
  qualifiedAt: string;
  expiresAt: string;
  customerLocalQualification?: { receipt: BindingQualificationReceipt; runtime: BindingQualificationRuntime };
  /**
   * Optional hardened write path. When supplied, the compiler issues a signed,
   * exact-request lease after credential resolution and the transport consumes
   * it immediately before the write. The legacy unsigned content-digest grant is then ignored.
   */
  writeAuthorityIssuer?: CustomerLocalHttpWriteAuthorityIssuer;
  recoveryObserverSigner?: CustomerLocalHttpNotStartedObserverSigner;
  now?: () => number;
}

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

function deepFreezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function snapshotTransport(transport: CustomerLocalHttpTransport): CustomerLocalHttpTransport {
  const perform = transport.perform.bind(transport);
  const prepareWrite = transport.prepareWrite?.bind(transport);
  return Object.freeze({
    driverId: transport.driverId,
    sourceId: transport.sourceId,
    serverUrl: transport.serverUrl,
    implementationDigest: transport.implementationDigest,
    supportedMethods: Object.freeze([...transport.supportedMethods]) as unknown as CustomerLocalHttpTransport["supportedMethods"],
    independentlyAuthenticated: transport.independentlyAuthenticated,
    independentFromDriverIds: Object.freeze([...transport.independentFromDriverIds]) as unknown as string[],
    ...(transport.writeAuthorityBoundaryDigest ? { writeAuthorityBoundaryDigest: transport.writeAuthorityBoundaryDigest } : {}),
    ...(transport.writeAuthorityVerifierDigest ? { writeAuthorityVerifierDigest: transport.writeAuthorityVerifierDigest } : {}),
    ...(prepareWrite ? { prepareWrite } : {}),
    perform,
  });
}

function snapshotCredentialResolver(resolver: CustomerLocalCredentialResolver): CustomerLocalCredentialResolver {
  const resolve = resolver.resolve.bind(resolver);
  return Object.freeze({
    resolverId: resolver.resolverId,
    implementationDigest: resolver.implementationDigest,
    allowedAliases: Object.freeze([...resolver.allowedAliases]) as unknown as string[],
    resolve,
  });
}

function snapshotQualification(qualification: { receipt: BindingQualificationReceipt; runtime: BindingQualificationRuntime }): { receipt: BindingQualificationReceipt; runtime: BindingQualificationRuntime } {
  const inspect = qualification.runtime.credentialInspector.inspect.bind(qualification.runtime.credentialInspector);
  const probeTransport = qualification.runtime.probeTransport.bind(qualification.runtime);
  const assertCurrent = qualification.runtime.assertCurrent.bind(qualification.runtime);
  return Object.freeze({
    receipt: deepFreezeJson(structuredClone(qualification.receipt)),
    runtime: Object.freeze({
      credentialInspector: Object.freeze({ inspect }),
      actionProfile: deepFreezeJson(structuredClone(qualification.runtime.actionProfile)),
      observerProfile: deepFreezeJson(structuredClone(qualification.runtime.observerProfile)),
      probeTransport,
      assertCurrent,
    }),
  });
}

export function httpBindingCompilerDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function assertIdentifier(value: string, label: string): void {
  if (!identifier.safeParse(value).success) throw new Error(`${label} must be a stable identifier.`);
}

function assertDigest(value: string, label: string): void {
  if (!digestSchema.safeParse(value).success) throw new Error(`${label} must be a non-placeholder SHA-256 digest.`);
}

function resolveValue(source: HttpBindingValueSource, input: Pick<CompiledHttpActionInput, "workflowInput" | "trustedContext">): unknown {
  const key = source.kind === "workflow-input" ? source.inputKey : source.contextKey;
  const owner = source.kind === "workflow-input" ? input.workflowInput : input.trustedContext;
  if (!Object.hasOwn(owner, key)) throw new Error(`Confirmed ${source.kind} value ${key} is unavailable at runtime.`);
  const value = owner[key];
  if (value === undefined || value === null || typeof value === "object" || typeof value === "function") {
    throw new Error(`Confirmed ${source.kind} value ${key} must resolve to a scalar.`);
  }
  if (typeof value === "string" && secretShaped.test(value)) throw new Error(`Confirmed ${source.kind} value ${key} is credential-shaped and cannot enter an ordinary binding.`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (!["string", "number", "boolean"].includes(typeof value)) throw new Error(`${label} must be a scalar.`);
  return String(value);
}

function setPath(root: Record<string, unknown>, path: Array<string | number>, value: unknown): void {
  if (path.length !== 1 || typeof path[0] !== "string") throw new Error("Compiler v1 supports only reviewed top-level JSON request fields.");
  if (Object.hasOwn(root, path[0])) throw new Error(`Request body path ${path[0]} was bound more than once.`);
  root[path[0]] = value;
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

function substitutePath(pathTemplate: string, values: Record<string, string>): string {
  let rendered = pathTemplate;
  for (const [name, value] of Object.entries(values)) rendered = rendered.replaceAll(`{${name}}`, encodeURIComponent(value));
  if (/\{[^{}]+\}/.test(rendered)) throw new Error("A required path parameter remains unbound.");
  if (!rendered.startsWith("/") || rendered.includes("..") || rendered.includes("\\")) throw new Error("Compiled HTTP path escaped the reviewed path boundary.");
  return rendered;
}

function grantPayload(grant: HttpActionExecutionGrant): Omit<HttpActionExecutionGrant, "grantDigest"> {
  const { grantDigest: _grantDigest, ...payload } = grant;
  return payload;
}

export function httpActionGrantDigest(grant: Omit<HttpActionExecutionGrant, "grantDigest"> | HttpActionExecutionGrant): string {
  return httpBindingCompilerDigest("grantDigest" in grant ? grantPayload(grant as HttpActionExecutionGrant) : grant);
}

function assertGrant(
  grant: HttpActionExecutionGrant | undefined,
  declaration: HttpActionBindingDeclaration,
  input: CompiledHttpActionInput,
  now: number,
): void {
  if (!grant) throw new Error("Exact runtime write authorization is missing; zero writes are allowed.");
  if (grant.schemaVersion !== "1.0" || grant.decision !== "authorized" || httpActionGrantDigest(grant) !== grant.grantDigest) {
    throw new Error("Runtime write authorization failed its integrity check.");
  }
  if (grant.authorityCompilationDigest !== declaration.provenance.authorityCompilationDigest
    || grant.actionDeclarationDigest !== declaration.declarationDigest
    || grant.targetAlias !== declaration.targetAlias
    || grant.operationId !== declaration.operation.operationId
    || grant.method !== declaration.operation.method
    || grant.parentGoalId !== input.parentGoalId
    || grant.workItemId !== input.workItemId) {
    throw new Error("Runtime write authorization is bound to different reviewed work.");
  }
  const authorizedAt = Date.parse(grant.authorizedAt);
  const expiresAt = Date.parse(grant.expiresAt);
  if (!Number.isFinite(authorizedAt) || !Number.isFinite(expiresAt) || authorizedAt > now || expiresAt <= now) {
    throw new Error("Runtime write authorization is not currently valid.");
  }
  if (declaration.authorityPolicy === "requires-approval" && !grant.approvalReference) {
    throw new Error("The reviewed write policy requires an exact approval reference.");
  }
}

async function credentialFor(resolver: CustomerLocalCredentialResolver, alias: string): Promise<CustomerLocalCredentialHandle> {
  if (!resolver.allowedAliases.includes(alias)) throw new Error(`Credential alias ${alias} is outside the customer-local resolver allowlist.`);
  const credential = await resolver.resolve(alias);
  if (!credential || credential.alias !== alias || credential.value.length === 0) throw new Error(`Customer-local credential alias ${alias} is unavailable.`);
  return credential;
}

function predicatePassed(
  predicate: HttpObserverBindingDeclaration["predicates"][number],
  body: unknown,
  workflowInput: Record<string, unknown>,
): boolean {
  const observed = readPath(body, predicate.path);
  if (predicate.operator === "exists") return observed.exists;
  if (!observed.exists) return false;
  if (predicate.operator === "count-equals") return Array.isArray(observed.value) && observed.value.length === predicate.expectedCount;
  if (predicate.operator === "equals-confirmed") return canonical(observed.value) === canonical(predicate.expected);
  if (!Object.hasOwn(workflowInput, predicate.inputKey)) return false;
  return canonical(observed.value) === canonical(workflowInput[predicate.inputKey]);
}

function nextActionFor(classification: CompiledHttpObservationClassification): ExpectedVerifierTemplateVerdict["nextAction"] {
  if (classification === "completed") return "resume";
  if (classification === "not-started") return "retry-after-authority-recheck";
  if (["partial", "incorrect", "duplicate", "stale", "collateral"].includes(classification)) return "quarantine";
  return "handoff";
}

function expectedVerdicts(): Record<VerifierTemplateControlId, ExpectedVerifierTemplateVerdict> {
  return {
    completed: { classification: "completed", passed: true, nextAction: "resume", incorrectSideEffects: 0 },
    "not-started": { classification: "not-started", passed: false, nextAction: "retry-after-authority-recheck", incorrectSideEffects: 0 },
    partial: { classification: "partial", passed: false, nextAction: "quarantine", incorrectSideEffects: 0 },
    incorrect: { classification: "incorrect", passed: false, nextAction: "quarantine", incorrectSideEffects: 1 },
    duplicate: { classification: "duplicate", passed: false, nextAction: "quarantine", incorrectSideEffects: 1 },
    stale: { classification: "stale", passed: false, nextAction: "quarantine", incorrectSideEffects: 0 },
    collateral: { classification: "collateral", passed: false, nextAction: "quarantine", incorrectSideEffects: 1 },
    unknown: { classification: "unknown", passed: false, nextAction: "handoff", incorrectSideEffects: 0 },
    unavailable: { classification: "unavailable", passed: false, nextAction: "handoff", incorrectSideEffects: 0 },
    "lost-response-reconciliation": { classification: "completed", passed: true, nextAction: "resume", incorrectSideEffects: 0 },
    "adversarial-action-response": { classification: "unavailable", passed: false, nextAction: "handoff", incorrectSideEffects: 0 },
  };
}

function qualificationCorpus(): VerifierTemplateQualificationCorpus {
  const expected = expectedVerdicts();
  const cases: VerifierTemplateQualificationCase[] = (Object.keys(expected) as VerifierTemplateControlId[]).map((controlId) => ({
    controlId,
    independentObservation: { source: "compiled-independent-http-observer", ...expected[controlId] },
    responseDisposition: controlId === "lost-response-reconciliation" ? "lost" : controlId === "adversarial-action-response" ? "available" : "not-applicable",
    ...(controlId === "adversarial-action-response" ? { actionResponse: { status: 201, body: { success: true, externalProof: true } } } : {}),
    expected: expected[controlId],
  }));
  return { schemaVersion: "1.0", corpusVersion: "compiled-http-negative-controls-v1", cases };
}

function pairPayload(pair: Omit<CompiledHttpBindingPair, "pairDigest"> | CompiledHttpBindingPair): unknown {
  const source = pair as CompiledHttpBindingPair;
  return {
    schemaVersion: source.schemaVersion,
    state: source.state,
    activated: source.activated,
    customerValidated: source.customerValidated,
    action: {
      adapterId: source.action.adapterId,
      adapterVersion: source.action.adapterVersion,
      declarationDigest: source.action.declarationDigest,
      implementationDigest: source.action.implementationDigest,
      activated: source.action.activated,
    },
    observer: {
      adapterId: source.observer.adapterId,
      adapterVersion: source.observer.adapterVersion,
      declarationDigest: source.observer.declarationDigest,
      implementationDigest: source.observer.implementationDigest,
      qualification: source.observer.qualification,
      activated: source.observer.activated,
    },
    observerQualificationReceipt: source.observerQualificationReceipt,
    dependencies: source.dependencies,
    blockers: source.blockers,
    evidenceBoundary: source.evidenceBoundary,
  };
}

export function assertCompiledHttpBindingPairIntegrity(pair: CompiledHttpBindingPair): void {
  if (pair.pairDigest !== httpBindingCompilerDigest(pairPayload(pair))) throw new Error("Compiled HTTP binding pair failed its integrity check.");
  if (pair.state !== "compiled-acceptance-only" || pair.activated !== false || pair.action.activated !== false || pair.observer.activated !== false) {
    throw new Error("Compiled HTTP bindings cannot be activated by compilation or acceptance.");
  }
  if (pair.observer.qualification.qualificationDigest !== pair.observerQualificationReceipt.qualificationDigest) {
    throw new Error("Compiled observer qualification reference does not match its receipt.");
  }
}

export type CompileAuthorityEnforcedHttpBindingsInput = CompileHttpBindingsInput & {
  writeAuthorityIssuer: CustomerLocalHttpWriteAuthorityIssuer;
};

/**
 * Hardened compiler entry point for customer-local writes. The older compiler
 * remains an explicitly acceptance-compatible path for historical evidence.
 */
export function compileAuthorityEnforcedReviewedHttpBindings(input: CompileAuthorityEnforcedHttpBindingsInput): CompiledHttpBindingPair {
  if (!input.writeAuthorityIssuer || !input.actionTransport.writeAuthorityBoundaryDigest || !input.actionTransport.writeAuthorityVerifierDigest || !input.actionTransport.prepareWrite) {
    throw new Error("Authority-enforced HTTP compilation requires one exact trusted issuer and preflight-reserving lease-consuming action transport.");
  }
  assertAuthorityEnforcedCustomerLocalPinnedHttpsTransport(input.actionTransport);
  if (input.writeAuthorityIssuer.recoveryObserverImplementationDigest || input.writeAuthorityIssuer.recoveryObserverBindingDigest || input.writeAuthorityIssuer.recoveryObserverQualificationDigest) {
    if (!input.recoveryObserverSigner) throw new Error("Authority-enforced HTTP recovery requires the exact trusted customer-local observer signer.");
    assertTrustedCustomerLocalHttpNotStartedObserverSigner(input.recoveryObserverSigner);
    if (input.recoveryObserverSigner.observerImplementationDigest !== input.writeAuthorityIssuer.recoveryObserverImplementationDigest
      || input.recoveryObserverSigner.observerBindingDigest !== input.writeAuthorityIssuer.recoveryObserverBindingDigest
      || input.recoveryObserverSigner.observerQualificationDigest !== input.writeAuthorityIssuer.recoveryObserverQualificationDigest) throw new Error("Recovery observer signer and authority issuer are not one exact observer boundary.");
  } else if (input.recoveryObserverSigner) {
    throw new Error("A recovery observer signer cannot widen an authority contract that does not permit recovery.");
  }
  return compileReviewedHttpBindings(input);
}

/**
 * Compiles only the fixed v1 declaration primitives. Runtime functions are
 * customer-local and acceptance-only; compilation and qualification never
 * activate them or grant a write.
 */
export function compileReviewedHttpBindings(input: CompileHttpBindingsInput): CompiledHttpBindingPair {
  input = {
    ...input,
    factoryResult: deepFreezeJson(structuredClone(input.factoryResult)),
    actionTransport: snapshotTransport(input.actionTransport),
    observerTransport: snapshotTransport(input.observerTransport),
    credentialResolver: snapshotCredentialResolver(input.credentialResolver),
    ...(input.customerLocalQualification ? { customerLocalQualification: snapshotQualification(input.customerLocalQualification) } : {}),
  };
  assertHttpBindingFactoryResultIntegrity(input.factoryResult);
  if (input.factoryResult.status !== "review-required" || !input.factoryResult.actionBinding || !input.factoryResult.observerBinding) {
    throw new Error(`Binding compilation requires two clean reviewed declarations; unresolved blockers: ${input.factoryResult.blockers.map((item) => item.blockerId).join(", ")}`);
  }
  const actionDeclaration = deepFreezeJson(structuredClone(input.factoryResult.actionBinding));
  const observerDeclaration = deepFreezeJson(structuredClone(input.factoryResult.observerBinding));
  for (const [label, value] of [
    ["action transport", input.actionTransport.implementationDigest],
    ["observer transport", input.observerTransport.implementationDigest],
    ["credential resolver", input.credentialResolver.implementationDigest],
    ["primitive registry", input.primitiveRegistryDigest],
    ["verifier registry", input.verifierRegistryDigest],
  ] as const) assertDigest(value, label);
  for (const [label, value] of [
    ["action transport driver", input.actionTransport.driverId],
    ["observer transport driver", input.observerTransport.driverId],
    ["observer transport source", input.observerTransport.sourceId],
    ["credential resolver", input.credentialResolver.resolverId],
  ] as const) assertIdentifier(value, label);
  if (input.actionTransport.driverId !== actionDeclaration.driverId
    || input.actionTransport.serverUrl !== actionDeclaration.serverUrl
    || !input.actionTransport.supportedMethods.includes(actionDeclaration.operation.method)) {
    throw new Error("Action transport does not match the exact reviewed driver, server, and method boundary.");
  }
  if (input.observerTransport.driverId !== observerDeclaration.driverId
    || input.observerTransport.sourceId !== observerDeclaration.sourceId
    || input.observerTransport.serverUrl !== observerDeclaration.serverUrl
    || !input.observerTransport.supportedMethods.includes(observerDeclaration.operation.method)) {
    throw new Error("Observer transport does not match the exact reviewed driver, source, server, and method boundary.");
  }
  if (!input.observerTransport.independentlyAuthenticated
    || !input.observerTransport.independentFromDriverIds.includes(actionDeclaration.driverId)
    || input.actionTransport.implementationDigest === input.observerTransport.implementationDigest) {
    throw new Error("Observer transport is not separately authenticated and implementation-independent from the action transport.");
  }
  if (!input.credentialResolver.allowedAliases.includes(actionDeclaration.credentialAlias)
    || !input.credentialResolver.allowedAliases.includes(observerDeclaration.credentialAlias)) {
    throw new Error("Credential resolver does not explicitly allow both reviewed aliases.");
  }
  if (!input.customerLocalQualification) throw new Error("Customer-local credential and split-transport qualification is missing before acceptance compilation.");
  if (input.writeAuthorityIssuer) {
    const authority = input.writeAuthorityIssuer;
    assertTrustedCustomerLocalHttpWriteAuthorityIssuer(authority);
    if (authority.authorityCompilationDigest !== actionDeclaration.provenance.authorityCompilationDigest
      || authority.actionDeclarationDigest !== actionDeclaration.declarationDigest
      || authority.credentialResolverDigest !== input.credentialResolver.implementationDigest
      || authority.transportAuthorityBoundaryDigest !== input.actionTransport.writeAuthorityBoundaryDigest
      || authority.verifierImplementationDigest !== input.actionTransport.writeAuthorityVerifierDigest) {
      throw new Error("Signed write-authority issuer, reviewed declaration, resolver, and transport verifier are not one exact boundary.");
    }
  } else if (input.actionTransport.writeAuthorityBoundaryDigest || input.actionTransport.writeAuthorityVerifierDigest) {
    throw new Error("A lease-enforcing action transport requires its exact signed write-authority issuer.");
  }
  const customerLocalQualification = input.customerLocalQualification;
  assertBindingQualificationReceipt(customerLocalQualification.receipt);
  const customerQualification = customerLocalQualification.receipt;
  if (customerQualification.factoryResultDigest !== input.factoryResult.resultDigest || customerQualification.actionDeclarationDigest !== actionDeclaration.declarationDigest || customerQualification.observerDeclarationDigest !== observerDeclaration.declarationDigest) throw new Error("Customer-local qualification is missing or belongs to different reviewed declarations.");
  if (customerQualification.transports.action.implementationDigest !== input.actionTransport.implementationDigest || customerQualification.transports.observer.implementationDigest !== input.observerTransport.implementationDigest || customerQualification.credentials.action.resolverImplementationDigest !== input.credentialResolver.implementationDigest || customerQualification.credentials.observer.resolverImplementationDigest !== input.credentialResolver.implementationDigest) throw new Error("Customer-local qualification does not bind the current transports and credential resolver.");
  if (secretShaped.test(canonical({
    actionDeclaration,
    observerDeclaration,
    actionTransport: { ...input.actionTransport, perform: undefined },
    observerTransport: { ...input.observerTransport, perform: undefined },
    credentialResolver: { ...input.credentialResolver, resolve: undefined },
  }))) throw new Error("Compiler material contains a credential-shaped value; aliases only are permitted outside resolution.");

  const actionImplementationDigest = httpBindingCompilerDigest({
    compilerVersion: HTTP_BINDING_COMPILER_VERSION,
    declarationDigest: actionDeclaration.declarationDigest,
    transportDigest: input.actionTransport.implementationDigest,
    resolverDigest: input.credentialResolver.implementationDigest,
    primitiveRegistryDigest: input.primitiveRegistryDigest,
    writeAuthorityIssuerDigest: input.writeAuthorityIssuer?.implementationDigest ?? null,
    writeAuthorityVerifierDigest: input.writeAuthorityIssuer?.verifierImplementationDigest ?? null,
  });
  const observerImplementationDigest = httpBindingCompilerDigest({
    compilerVersion: HTTP_BINDING_COMPILER_VERSION,
    declarationDigest: observerDeclaration.declarationDigest,
    transportDigest: input.observerTransport.implementationDigest,
    resolverDigest: input.credentialResolver.implementationDigest,
    primitiveRegistryDigest: input.primitiveRegistryDigest,
  });
  const outcomeSchemaDigest = httpBindingCompilerDigest({
    predicates: observerDeclaration.predicates,
    notStartedDefinition: observerDeclaration.notStartedDefinition,
    duplicateCheck: observerDeclaration.duplicateCheck,
    collateralChecks: observerDeclaration.collateralChecks,
    freshness: observerDeclaration.freshness,
  });

  const qualification = qualifyVerifierTemplate({
    candidate: {
      templateKey: `${observerDeclaration.driverId}.compiled-observer`,
      templateVersion: "v1",
      runtimeFamily: "constrained-http-api",
      implementationDigest: observerImplementationDigest,
      outcomeSchemaDigest,
      evaluate(evaluationInput) {
        const observation = evaluationInput.independentObservation as Record<string, unknown>;
        const classification = observation.classification as ExpectedVerifierTemplateVerdict["classification"];
        const passed = observation.passed as boolean;
        const nextAction = observation.nextAction as ExpectedVerifierTemplateVerdict["nextAction"];
        const incorrectSideEffects = observation.incorrectSideEffects as number;
        return {
          classification,
          passed,
          nextAction,
          incorrectSideEffects,
          observedStateDigest: verifierQualificationDigest(evaluationInput.independentObservation),
        };
      },
    },
    corpus: qualificationCorpus(),
    primitiveRegistryDigest: input.primitiveRegistryDigest,
    verifierRegistryDigest: input.verifierRegistryDigest,
    qualifiedAt: timestampSchema.parse(input.qualifiedAt),
    expiresAt: timestampSchema.parse(input.expiresAt),
  });
  if (qualification.status !== "qualified") {
    throw new Error(`Compiled observer failed mandatory qualification: ${qualification.errors.join("; ") || qualification.controls.filter((item) => !item.passed).map((item) => item.controlId).join(", ")}`);
  }
  if (input.writeAuthorityIssuer?.recoveryObserverImplementationDigest || input.writeAuthorityIssuer?.recoveryObserverBindingDigest || input.writeAuthorityIssuer?.recoveryObserverQualificationDigest) {
    if (input.writeAuthorityIssuer.recoveryObserverImplementationDigest !== observerImplementationDigest
      || input.writeAuthorityIssuer.recoveryObserverBindingDigest !== observerDeclaration.declarationDigest
      || input.writeAuthorityIssuer.recoveryObserverQualificationDigest !== qualification.receipt.qualificationDigest) {
      throw new Error("Signed not-started recovery authority is bound to a different compiled observer, declaration, or qualification receipt.");
    }
  }

  const now = input.now ?? (() => Date.now());
  const action: CompiledHttpActionAdapter = {
    adapterId: `${actionDeclaration.driverId}.compiled-action`,
    adapterVersion: "1.0.0",
    declarationDigest: actionDeclaration.declarationDigest,
    implementationDigest: actionImplementationDigest,
    activated: false,
    async execute(actionInput) {
      await assertCustomerLocalQualificationCurrent(customerQualification, customerLocalQualification.runtime, { tenantId: customerQualification.tenantId, sessionId: customerQualification.sessionId, packageDigest: customerQualification.packageDigest, factoryResultDigest: input.factoryResult.resultDigest, sourceDigest: customerQualification.sourceDigest, now: new Date(now()).toISOString() });
      assertIdentifier(actionInput.requestId, "Request ID");
      assertIdentifier(actionInput.parentGoalId, "Parent goal ID");
      assertIdentifier(actionInput.workItemId, "Work item ID");
      if (!input.writeAuthorityIssuer) assertGrant(actionInput.grant, actionDeclaration, actionInput, now());
      const pathValues: Record<string, string> = {};
      const query: Record<string, string> = {};
      const headers: Record<string, string> = {};
      const body: Record<string, unknown> = {};
      for (const mapping of actionDeclaration.requestMappings) {
        const value = resolveValue(mapping.source, actionInput);
        if (mapping.destination.location === "path") pathValues[mapping.destination.name] = stringValue(value, mapping.destination.name);
        else if (mapping.destination.location === "query") query[mapping.destination.name] = stringValue(value, mapping.destination.name);
        else if (mapping.destination.location === "header") headers[mapping.destination.name] = stringValue(value, mapping.destination.name);
        else setPath(body, mapping.destination.path, value);
      }
      const reconciliationKey = stringValue(resolveValue(actionDeclaration.reconciliationKeySource, actionInput), "Reconciliation key");
      const credential = await credentialFor(input.credentialResolver, actionDeclaration.credentialAlias);
      const request: CompiledHttpRequest = {
        requestId: actionInput.requestId,
        parentGoalId: actionInput.parentGoalId,
        workItemId: actionInput.workItemId,
        driverId: actionDeclaration.driverId,
        targetAlias: actionDeclaration.targetAlias,
        serverUrl: actionDeclaration.serverUrl,
        operationId: actionDeclaration.operation.operationId,
        method: actionDeclaration.operation.method,
        path: substitutePath(actionDeclaration.operation.pathTemplate, pathValues),
        query,
        headers,
        body: Object.keys(body).length > 0 ? body : null,
        credentialAlias: actionDeclaration.credentialAlias,
        reconciliationKey,
        declarationDigest: actionDeclaration.declarationDigest,
      };
      const preparedWrite = input.writeAuthorityIssuer
        ? input.actionTransport.prepareWrite!(request, credential)
        : undefined;
      let authorityLease: HttpActionAuthorityLease | undefined;
      try {
        authorityLease = input.writeAuthorityIssuer
          ? await input.writeAuthorityIssuer.issueLease({ request, credentialAlias: credential.alias, transportReservationDigest: preparedWrite!.reservationDigest, ...(actionInput.approvalReceipt ? { approvalReceipt: actionInput.approvalReceipt } : {}), ...(actionInput.notStartedRecovery ? { notStartedRecovery: actionInput.notStartedRecovery } : {}), ...(actionInput.unconsumedReplacement ? { unconsumedReplacement: actionInput.unconsumedReplacement } : {}) })
          : undefined;
      } catch (error) {
        preparedWrite?.cancelBeforeAuthority();
        throw error;
      }
      let response: CompiledHttpResponse;
      try {
        response = preparedWrite && authorityLease
          ? await preparedWrite.dispatch(authorityLease)
          : await input.actionTransport.perform(request, credential, authorityLease);
      } catch (error) {
        if (authorityLease && error instanceof CustomerLocalPinnedHttpsDispatchUncertainError) throw new CompiledHttpActionDispatchUncertainError(request, authorityLease, error);
        throw error;
      }
      if (!actionDeclaration.acceptedStatuses.includes(response.status)) {
        const error = new Error(`Action returned unreviewed status ${response.status}; independent reconciliation is required before any reissue.`);
        if (authorityLease) throw new CompiledHttpActionDispatchUncertainError(request, authorityLease, error);
        throw error;
      }
      return {
        status: response.status,
        actionResponseAvailable: true,
        actionResponseEligibleAsExternalProof: false,
        reconciliationKey,
        responseBody: response.body,
      };
    },
  };

  const observer: CompiledHttpObservationAdapter = {
    adapterId: `${observerDeclaration.driverId}.compiled-observer`,
    adapterVersion: "1.0.0",
    declarationDigest: observerDeclaration.declarationDigest,
    implementationDigest: observerImplementationDigest,
    qualification: qualificationReference(qualification.receipt),
    activated: false,
    async observe(observationInput) {
      await assertCustomerLocalQualificationCurrent(customerQualification, customerLocalQualification.runtime, { tenantId: customerQualification.tenantId, sessionId: customerQualification.sessionId, packageDigest: customerQualification.packageDigest, factoryResultDigest: input.factoryResult.resultDigest, sourceDigest: customerQualification.sourceDigest, now: new Date(now()).toISOString() });
      if (observationInput.recoveryContext && !input.recoveryObserverSigner) throw new Error("A recovery observation requires the exact configured trusted observer-local signer.");
      try {
        assertIdentifier(observationInput.requestId, "Observation request ID");
        assertIdentifier(observationInput.parentGoalId, "Parent goal ID");
        assertIdentifier(observationInput.workItemId, "Work item ID");
        if (!Number.isFinite(observationInput.operationStartedAtEpochMs) || observationInput.operationStartedAtEpochMs < 0) throw new Error("Trusted operation-start boundary is invalid.");
        const pathValues: Record<string, string> = {};
        const query: Record<string, string> = {};
        for (const binding of observerDeclaration.parameterBindings) {
          const value = resolveValue(binding.source, observationInput);
          if (binding.location === "path") pathValues[binding.name] = stringValue(value, binding.name);
          else query[binding.name] = stringValue(value, binding.name);
        }
        const stable = observerDeclaration.parameterBindings.find((binding) => binding.purpose === "stable-identifier")!;
        const reconciliationKey = stringValue(resolveValue(stable.source, observationInput), "Observer reconciliation key");
        const credential = await credentialFor(input.credentialResolver, observerDeclaration.credentialAlias);
        const observationRequest: CompiledHttpRequest = {
          requestId: observationInput.requestId,
          parentGoalId: observationInput.parentGoalId,
          workItemId: observationInput.workItemId,
          driverId: observerDeclaration.driverId,
          targetAlias: observerDeclaration.targetAlias,
          serverUrl: observerDeclaration.serverUrl,
          operationId: observerDeclaration.operation.operationId,
          method: observerDeclaration.operation.method,
          path: substitutePath(observerDeclaration.operation.pathTemplate, pathValues),
          query,
          headers: {},
          body: null,
          credentialAlias: observerDeclaration.credentialAlias,
          reconciliationKey,
          declarationDigest: observerDeclaration.declarationDigest,
        };
        const recoverySession = observationInput.recoveryContext ? input.recoveryObserverSigner!.begin({ ...observationInput.recoveryContext, observationRequest }) : undefined;
        const response = await input.observerTransport.perform(observationRequest, credential);
        if (!observerDeclaration.acceptedStatuses.includes(response.status)) throw new Error(`Observer returned unreviewed status ${response.status}.`);
        const checks: CompiledHttpObservationResult["checks"] = [];
        let fresh = false;
        let observedAt = "";
        if (observerDeclaration.freshness.kind === "server-timestamp-body") {
          const raw = readPath(response.body, observerDeclaration.freshness.path);
          observedAt = raw.exists && typeof raw.value === "string" ? raw.value : "";
        } else {
          const freshnessHeaderName = observerDeclaration.freshness.headerName;
          const entry = Object.entries(response.headers).find(([name]) => name.toLowerCase() === freshnessHeaderName.toLowerCase());
          observedAt = typeof entry?.[1] === "string" ? entry[1] : "";
        }
        const observedAtEpoch = Date.parse(observedAt);
        const age = now() - observedAtEpoch;
        fresh = Number.isFinite(observedAtEpoch)
          && observedAtEpoch >= observationInput.operationStartedAtEpochMs
          && age >= -5_000
          && age <= observerDeclaration.freshness.maximumAgeSeconds * 1_000;
        checks.push({ key: "freshness", role: "freshness", passed: fresh });

        const success = observerDeclaration.predicates.map((predicate) => ({
          key: predicate.key,
          role: "success" as const,
          passed: predicatePassed(predicate, response.body, observationInput.workflowInput),
        }));
        checks.push(...success);
        const notStarted = observerDeclaration.notStartedDefinition.map((predicate) => ({
          key: predicate.key,
          role: "not-started" as const,
          passed: predicatePassed(predicate, response.body, observationInput.workflowInput),
        }));
        checks.push(...notStarted);
        const collection = readPath(response.body, observerDeclaration.duplicateCheck.collectionPath);
        const duplicatePassed = Array.isArray(collection.value) && collection.value.length === observerDeclaration.duplicateCheck.expectedCount;
        checks.push({ key: "duplicate-check", role: "duplicate", passed: duplicatePassed });
        const collateral = observerDeclaration.collateralChecks.map((predicate) => ({
          key: predicate.key,
          role: "collateral" as const,
          passed: predicatePassed(predicate, response.body, observationInput.workflowInput),
        }));
        checks.push(...collateral);

        const successCount = success.filter((check) => check.passed).length;
        const collateralPassed = collateral.every((check) => check.passed);
        const notStartedPassed = notStarted.every((check) => check.passed);
        let classification: CompiledHttpObservationClassification;
        if (!fresh) classification = "stale";
        else if (!duplicatePassed && Array.isArray(collection.value) && collection.value.length > observerDeclaration.duplicateCheck.expectedCount) classification = "duplicate";
        else if (!collateralPassed) classification = "collateral";
        else if (success.every((check) => check.passed) && duplicatePassed) classification = "completed";
        else if (notStartedPassed) classification = "not-started";
        else if (successCount > 0) classification = "partial";
        else classification = "incorrect";
        const incorrectSideEffects = ["incorrect", "duplicate", "collateral"].includes(classification) ? 1 : 0;
        const result: CompiledHttpObservationResult = {
          classification,
          passed: classification === "completed",
          nextAction: nextActionFor(classification),
          incorrectSideEffects,
          stateDigest: httpBindingCompilerDigest({ body: response.body, headers: response.headers }),
          checks,
          observedAt,
          actionResponseUsedAsProof: false,
        };
        if (classification === "not-started" && recoverySession) return { ...result, notStartedRecoveryReceipt: input.recoveryObserverSigner!.complete({ session: recoverySession, observation: result }) };
        return result;
      } catch (error) {
        return {
          classification: "unavailable",
          passed: false,
          nextAction: "handoff",
          incorrectSideEffects: 0,
          stateDigest: httpBindingCompilerDigest({ unavailable: true, reason: error instanceof Error ? error.message : String(error) }),
          checks: [{ key: "observer-available", role: "freshness", passed: false }],
          observedAt: new Date(now()).toISOString(),
          actionResponseUsedAsProof: false,
        };
      }
    },
  };

  const base: Omit<CompiledHttpBindingPair, "pairDigest"> = {
    schemaVersion: HTTP_BINDING_COMPILER_VERSION,
    state: "compiled-acceptance-only",
    activated: false,
    customerValidated: false,
    action,
    observer,
    observerQualificationReceipt: qualification.receipt,
    dependencies: {
      actionTransportDigest: input.actionTransport.implementationDigest,
      observerTransportDigest: input.observerTransport.implementationDigest,
      credentialResolverDigest: input.credentialResolver.implementationDigest,
      primitiveRegistryDigest: input.primitiveRegistryDigest,
      verifierRegistryDigest: input.verifierRegistryDigest,
      ...(input.writeAuthorityIssuer ? {
        writeAuthorityIssuerDigest: input.writeAuthorityIssuer.implementationDigest,
        writeAuthorityVerifierDigest: input.writeAuthorityIssuer.verifierImplementationDigest,
      } : {}),
    },
    blockers: [],
    evidenceBoundary: "This compiled pair is customer-local acceptance substrate. It is not activated, customer evidence, production readiness, human onboarding evidence, or authority to act.",
  };
  const pair = { ...base, pairDigest: httpBindingCompilerDigest(pairPayload(base as CompiledHttpBindingPair)) };
  assertCompiledHttpBindingPairIntegrity(pair);
  return pair;
}
