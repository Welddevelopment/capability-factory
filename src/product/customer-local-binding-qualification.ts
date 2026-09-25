import { createHash } from "node:crypto";
import type { CustomerLocalCredentialResolver, CustomerLocalHttpTransport } from "./http-binding-compiler.js";
import type { HttpBindingFactoryResult } from "./http-binding-factory.js";

export const CUSTOMER_LOCAL_BINDING_QUALIFICATION_VERSION = "1.0" as const;

export interface OpaqueCredentialBinding {
  alias: string; handleDigest: string; providerDigest: string; resolverImplementationDigest: string; revision: number;
  scopes: string[]; revoked: boolean; qualifiedAt: string; expiresAt: string;
}
export interface CustomerLocalCredentialInspector {
  inspect(alias: string): OpaqueCredentialBinding | null;
}
export interface ReviewedTransportProfile {
  role: "action" | "observer"; driverId: string; sourceId: string; serverUrl: string; path: string; method: string;
  requestSchemaDigest: string; responseSchemaDigest: string; sourceDigest: string; implementationDigest: string;
  tlsPolicy: "https-required"; timeoutMilliseconds: number; maximumRequestsPerMinute: number;
  reconcileBeforeRetry: boolean; blindRetryAllowed: false; independentlyAuthenticated: boolean; independentFromDriverIds: string[];
  reviewedAt: string; expiresAt: string;
}
export interface BindingQualificationReceipt {
  schemaVersion: "1.0"; state: "qualified-for-acceptance-compilation"; tenantId: string; sessionId: string; packageDigest: string;
  factoryResultDigest: string; sourceDigest: string; actionDeclarationDigest: string; observerDeclarationDigest: string;
  credentials: { action: Omit<OpaqueCredentialBinding, "revoked">; observer: Omit<OpaqueCredentialBinding, "revoked"> };
  transports: { action: ReviewedTransportProfile; observer: ReviewedTransportProfile };
  qualifiedAt: string; expiresAt: string; executionAuthorityEffect: "none"; activationEffect: "none"; receiptDigest: string;
}
export interface BindingQualificationRuntime {
  credentialInspector: CustomerLocalCredentialInspector;
  actionProfile: ReviewedTransportProfile;
  observerProfile: ReviewedTransportProfile;
  probeTransport(role: "action" | "observer"): { reachable: boolean; endpointDigest: string; checkedAt: string };
  assertCurrent(receipt: BindingQualificationReceipt): void;
}

function receiptPayload(receipt: Omit<BindingQualificationReceipt, "receiptDigest"> | BindingQualificationReceipt) {
  const { receiptDigest: _ignored, ...payload } = receipt as BindingQualificationReceipt; return payload;
}
export function bindingQualificationDigest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function bindingQualificationSchemaDigests(factoryResult: HttpBindingFactoryResult): {
  actionRequest: string; actionResponse: string; observerRequest: string; observerResponse: string;
} {
  const action = factoryResult.actionBinding;
  const observer = factoryResult.observerBinding;
  if (!action || !observer) throw new Error("Schema qualification requires both reviewed binding declarations.");
  return {
    actionRequest: bindingQualificationDigest({ operation: action.operation, requestMappings: action.requestMappings, reconciliationKeySource: action.reconciliationKeySource }),
    actionResponse: bindingQualificationDigest({ acceptedStatuses: action.acceptedStatuses, actionResponseEligibleAsExternalProof: false }),
    observerRequest: bindingQualificationDigest({ operation: observer.operation, parameterBindings: observer.parameterBindings }),
    observerResponse: bindingQualificationDigest({ acceptedStatuses: observer.acceptedStatuses, resultPath: observer.resultPath, freshness: observer.freshness, predicates: observer.predicates, notStartedDefinition: observer.notStartedDefinition, duplicateCheck: observer.duplicateCheck, collateralChecks: observer.collateralChecks }),
  };
}
export function assertBindingQualificationReceipt(receipt: BindingQualificationReceipt): void {
  if (receipt.receiptDigest !== bindingQualificationDigest(receiptPayload(receipt))) throw new Error("Customer-local binding qualification receipt failed integrity.");
  if (receipt.executionAuthorityEffect !== "none" || receipt.activationEffect !== "none") throw new Error("Binding qualification cannot grant authority or activation.");
}

export function qualifyCustomerLocalBindings(input: {
  tenantId: string; sessionId: string; packageDigest: string; sourceDigest: string; factoryResult: HttpBindingFactoryResult;
  actionTransport: CustomerLocalHttpTransport; observerTransport: CustomerLocalHttpTransport; credentialResolver: CustomerLocalCredentialResolver;
  runtime: BindingQualificationRuntime; qualifiedAt: string; expiresAt: string;
}): BindingQualificationReceipt {
  const action = input.factoryResult.actionBinding, observer = input.factoryResult.observerBinding;
  if (!action || !observer || input.factoryResult.status !== "review-required") throw new Error("Qualification requires two clean binding declarations.");
  const actionCredential = input.runtime.credentialInspector.inspect(action.credentialAlias);
  const observerCredential = input.runtime.credentialInspector.inspect(observer.credentialAlias);
  if (!actionCredential || !observerCredential) throw new Error("Both opaque customer-local credential aliases must be available for qualification.");
  if (actionCredential.alias === observerCredential.alias || actionCredential.handleDigest === observerCredential.handleDigest) throw new Error("Action and observer credentials must use separate aliases and opaque handles.");
  for (const [role, item, expectedScope] of [["action", actionCredential, `${action.operation.method} ${action.operation.pathTemplate}`], ["observer", observerCredential, `${observer.operation.method} ${observer.operation.pathTemplate}`]] as const) {
    if (item.revoked) throw new Error(`${role} credential binding is revoked.`);
    if (item.resolverImplementationDigest !== input.credentialResolver.implementationDigest) throw new Error(`${role} credential binding belongs to a different resolver implementation.`);
    if (!item.scopes.includes(expectedScope)) throw new Error(`${role} credential binding lacks exact declared operation scope.`);
    if (Date.parse(item.expiresAt) <= Date.parse(input.qualifiedAt)) throw new Error(`${role} credential binding is stale.`);
  }
  const schemaDigests = bindingQualificationSchemaDigests(input.factoryResult);
  const checkProfile = (profile: ReviewedTransportProfile, transport: CustomerLocalHttpTransport, declaration: typeof action | typeof observer, role: "action" | "observer") => {
    if (profile.role !== role || profile.driverId !== declaration.driverId || profile.serverUrl !== declaration.serverUrl || profile.path !== declaration.operation.pathTemplate || profile.method !== declaration.operation.method || profile.implementationDigest !== transport.implementationDigest) throw new Error(`${role} transport profile does not match exact endpoint/server/path/method/implementation.`);
    const expectedRequest = role === "action" ? schemaDigests.actionRequest : schemaDigests.observerRequest;
    const expectedResponse = role === "action" ? schemaDigests.actionResponse : schemaDigests.observerResponse;
    if (profile.requestSchemaDigest !== expectedRequest || profile.responseSchemaDigest !== expectedResponse) throw new Error(`${role} transport request/response schema is incompatible with the reviewed declaration.`);
    if (profile.tlsPolicy !== "https-required" || !profile.serverUrl.startsWith("https://")) throw new Error(`${role} transport does not represent an HTTPS-required policy.`);
    if (profile.timeoutMilliseconds < 100 || profile.timeoutMilliseconds > 120_000 || profile.maximumRequestsPerMinute < 1 || profile.maximumRequestsPerMinute > 10_000) throw new Error(`${role} timeout or rate limit is outside bounded policy.`);
    if (!profile.reconcileBeforeRetry || profile.blindRetryAllowed) throw new Error(`${role} retry/reconciliation policy is unsafe.`);
    if (Date.parse(profile.expiresAt) <= Date.parse(input.qualifiedAt) || profile.sourceDigest !== input.sourceDigest) throw new Error(`${role} transport profile is stale or source-drifted.`);
    const probe = input.runtime.probeTransport(role);
    const expectedEndpointDigest = bindingQualificationDigest({ role, driverId: profile.driverId, sourceId: profile.sourceId, serverUrl: profile.serverUrl, path: profile.path, method: profile.method, implementationDigest: profile.implementationDigest });
    if (!probe.reachable || probe.endpointDigest !== expectedEndpointDigest) throw new Error(`${role} transport is unavailable or the probed endpoint is misrouted.`);
    if (Date.parse(probe.checkedAt) > Date.parse(input.qualifiedAt) + 5_000 || Date.parse(probe.checkedAt) < Date.parse(input.qualifiedAt) - 300_000) throw new Error(`${role} transport reachability probe is outside the qualification time boundary.`);
  };
  checkProfile(input.runtime.actionProfile, input.actionTransport, action, "action"); checkProfile(input.runtime.observerProfile, input.observerTransport, observer, "observer");
  if (!input.runtime.observerProfile.independentlyAuthenticated || !input.runtime.observerProfile.independentFromDriverIds.includes(action.driverId) || input.runtime.actionProfile.implementationDigest === input.runtime.observerProfile.implementationDigest || input.runtime.actionProfile.sourceId === input.runtime.observerProfile.sourceId) throw new Error("Observer transport is not separately reviewed, authenticated and independent from action.");
  const qualifiedAt = input.qualifiedAt, expiresAt = [input.expiresAt, actionCredential.expiresAt, observerCredential.expiresAt, input.runtime.actionProfile.expiresAt, input.runtime.observerProfile.expiresAt].sort()[0]!;
  const payload = { schemaVersion: "1.0" as const, state: "qualified-for-acceptance-compilation" as const, tenantId: input.tenantId, sessionId: input.sessionId, packageDigest: input.packageDigest, factoryResultDigest: input.factoryResult.resultDigest, sourceDigest: input.sourceDigest, actionDeclarationDigest: action.declarationDigest, observerDeclarationDigest: observer.declarationDigest, credentials: { action: (({ revoked: _r, ...x }) => x)(actionCredential), observer: (({ revoked: _r, ...x }) => x)(observerCredential) }, transports: { action: structuredClone(input.runtime.actionProfile), observer: structuredClone(input.runtime.observerProfile) }, qualifiedAt, expiresAt, executionAuthorityEffect: "none" as const, activationEffect: "none" as const };
  return { ...payload, receiptDigest: bindingQualificationDigest(payload) };
}

export function assertCustomerLocalQualificationCurrent(receipt: BindingQualificationReceipt, runtime: BindingQualificationRuntime, expected: { tenantId: string; sessionId: string; packageDigest: string; factoryResultDigest: string; sourceDigest: string; now: string }): void {
  assertBindingQualificationReceipt(receipt);
  runtime.assertCurrent(receipt);
  if (receipt.tenantId !== expected.tenantId || receipt.sessionId !== expected.sessionId || receipt.packageDigest !== expected.packageDigest || receipt.factoryResultDigest !== expected.factoryResultDigest || receipt.sourceDigest !== expected.sourceDigest) throw new Error("Binding qualification belongs to different tenant/session/package/source/declarations.");
  if (Date.parse(receipt.expiresAt) <= Date.parse(expected.now)) throw new Error("Binding qualification has expired.");
  for (const saved of [receipt.credentials.action, receipt.credentials.observer]) {
    const current = runtime.credentialInspector.inspect(saved.alias);
    if (!current || current.revoked || current.handleDigest !== saved.handleDigest || current.revision !== saved.revision || current.providerDigest !== saved.providerDigest || current.resolverImplementationDigest !== saved.resolverImplementationDigest || Date.parse(current.expiresAt) <= Date.parse(expected.now)) throw new Error(`Credential alias ${saved.alias} is missing, revoked, rotated, stale, or unrequalified.`);
  }
  for (const role of ["action", "observer"] as const) {
    const current = role === "action" ? runtime.actionProfile : runtime.observerProfile;
    const saved = receipt.transports[role];
    if (bindingQualificationDigest(current) !== bindingQualificationDigest(saved) || current.sourceDigest !== receipt.sourceDigest || Date.parse(current.expiresAt) <= Date.parse(expected.now)) throw new Error("Qualified transport is unavailable, stale, misrouted, changed, or source-drifted.");
    const probe = runtime.probeTransport(role);
    const endpointDigest = bindingQualificationDigest({ role, driverId: current.driverId, sourceId: current.sourceId, serverUrl: current.serverUrl, path: current.path, method: current.method, implementationDigest: current.implementationDigest });
    if (!probe.reachable || probe.endpointDigest !== endpointDigest) throw new Error("Qualified transport is unavailable, stale, misrouted, changed, or source-drifted.");
  }
}

/**
 * Deterministic fixture constructor for local development and tests. It still
 * exercises the real qualification path and never contains a credential value.
 */
export function createLocalFixtureBindingQualification(input: {
  tenantId: string; sessionId: string; packageDigest: string; sourceDigest: string;
  factoryResult: HttpBindingFactoryResult; actionTransport: CustomerLocalHttpTransport;
  observerTransport: CustomerLocalHttpTransport; credentialResolver: CustomerLocalCredentialResolver;
  qualifiedAt: string; expiresAt: string;
}): { receipt: BindingQualificationReceipt; runtime: BindingQualificationRuntime; bindings: Map<string, OpaqueCredentialBinding> } {
  const action = input.factoryResult.actionBinding;
  const observer = input.factoryResult.observerBinding;
  if (!action || !observer) throw new Error("Local qualification fixture requires clean action and observer declarations.");
  const schemas = bindingQualificationSchemaDigests(input.factoryResult);
  const bindings = new Map<string, OpaqueCredentialBinding>();
  for (const [alias, scope, role] of [[action.credentialAlias, `${action.operation.method} ${action.operation.pathTemplate}`, "action"], [observer.credentialAlias, `${observer.operation.method} ${observer.operation.pathTemplate}`, "observer"]] as const) {
    bindings.set(alias, { alias, handleDigest: bindingQualificationDigest({ alias, role, revision: 1 }), providerDigest: bindingQualificationDigest("fixture-opaque-provider"), resolverImplementationDigest: input.credentialResolver.implementationDigest, revision: 1, scopes: [scope], revoked: false, qualifiedAt: input.qualifiedAt, expiresAt: input.expiresAt });
  }
  const profile = (role: "action" | "observer"): ReviewedTransportProfile => {
    const declaration = role === "action" ? action : observer;
    const transport = role === "action" ? input.actionTransport : input.observerTransport;
    return { role, driverId: declaration.driverId, sourceId: transport.sourceId, serverUrl: declaration.serverUrl, path: declaration.operation.pathTemplate, method: declaration.operation.method, requestSchemaDigest: role === "action" ? schemas.actionRequest : schemas.observerRequest, responseSchemaDigest: role === "action" ? schemas.actionResponse : schemas.observerResponse, sourceDigest: input.sourceDigest, implementationDigest: transport.implementationDigest, tlsPolicy: "https-required", timeoutMilliseconds: 10_000, maximumRequestsPerMinute: 120, reconcileBeforeRetry: true, blindRetryAllowed: false, independentlyAuthenticated: transport.independentlyAuthenticated, independentFromDriverIds: [...transport.independentFromDriverIds], reviewedAt: input.qualifiedAt, expiresAt: input.expiresAt };
  };
  const actionProfile = profile("action");
  const observerProfile = profile("observer");
  const runtime: BindingQualificationRuntime = {
    credentialInspector: { inspect: (alias) => structuredClone(bindings.get(alias) ?? null) },
    actionProfile,
    observerProfile,
    probeTransport: (role) => {
      const selected = role === "action" ? actionProfile : observerProfile;
      return { reachable: true, endpointDigest: bindingQualificationDigest({ role, driverId: selected.driverId, sourceId: selected.sourceId, serverUrl: selected.serverUrl, path: selected.path, method: selected.method, implementationDigest: selected.implementationDigest }), checkedAt: input.qualifiedAt };
    },
    assertCurrent: () => {},
  };
  const receipt = qualifyCustomerLocalBindings({ ...input, runtime });
  return { receipt, runtime, bindings };
}
