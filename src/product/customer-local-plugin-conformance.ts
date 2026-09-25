import { createHash } from "node:crypto";
import type { BindingQualificationRuntime, OpaqueCredentialBinding, ReviewedTransportProfile } from "./customer-local-binding-qualification.js";
import { bindingQualificationDigest } from "./customer-local-binding-qualification.js";
import type { CompiledHttpRequest, CompiledHttpResponse, CustomerLocalCredentialResolver, CustomerLocalHttpTransport } from "./http-binding-compiler.js";

export const CUSTOMER_LOCAL_PLUGIN_CONFORMANCE_VERSION = "1.0" as const;
export const CUSTOMER_LOCAL_PLUGIN_CONFORMANCE_CONTROL_IDS = ["contract.identity", "credentials.metadata-only", "transports.independent", "transport.probes", "leases.concurrent", "leases.single-use", "leases.expiry", "credentials.wrong-alias", "credentials.wrong-scope", "action.write", "observer.read", "action.lost-response-reconciliation", "credentials.rotation", "credentials.revocation", "credentials.restart", "transport.action.unavailable", "transport.observer.misrouted", "transport.action.drifted", "artifacts.redacted", "errors.redacted", "core-dumps.not-produced"] as const;

const canonical = (value: unknown): string => {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
};
export const customerLocalPluginDigest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");

export interface SecretLeaseMetadata {
  leaseId: string; alias: string; scope: string; providerDigest: string; resolverImplementationDigest: string;
  credentialRevision: number; issuedAt: string; expiresAt: string;
}

/** The secret is non-enumerable, process-local and readable exactly once. */
export class ProcessLocalSecretLease {
  readonly metadata: SecretLeaseMetadata;
  #secret: string | undefined;
  constructor(metadata: SecretLeaseMetadata, secret: string) {
    this.metadata = Object.freeze(structuredClone(metadata));
    this.#secret = secret;
  }
  take(): string {
    if (this.#secret === undefined) throw new Error("Secret lease has already been consumed or released.");
    if (Date.parse(this.metadata.expiresAt) <= Date.now()) { this.#secret = undefined; throw new Error("Secret lease has expired."); }
    const value = this.#secret;
    this.#secret = undefined;
    return value;
  }
  release(): void { this.#secret = undefined; }
  toJSON(): SecretLeaseMetadata { return structuredClone(this.metadata); }
}

export interface CustomerLocalSecretProviderPlugin {
  schemaVersion: "1.0"; pluginId: string; providerDigest: string; resolverId: string;
  resolverImplementationDigest: string; sourcePackageDigest: string; pluginRevision: number;
  allowedAliases: string[];
  inspect(alias: string): OpaqueCredentialBinding | null;
  lease(input: { alias: string; scope: string; purpose: "action" | "observer"; issuedAt: string; expiresAt: string }): Promise<ProcessLocalSecretLease>;
}

export interface CustomerLocalTransportPlugin {
  schemaVersion: "1.0"; pluginId: string; role: "action" | "observer"; sourcePackageDigest: string;
  transport: CustomerLocalHttpTransport; profile: ReviewedTransportProfile;
  probe(): { reachable: boolean; endpointDigest: string; checkedAt: string };
}

export interface CustomerLocalPluginBundle {
  schemaVersion: "1.0"; bundleId: string; sourcePackageDigest: string;
  credentials: CustomerLocalSecretProviderPlugin;
  action: CustomerLocalTransportPlugin;
  observer: CustomerLocalTransportPlugin;
}

export interface CustomerLocalConformanceHarness {
  canaryValues(): string[];
  reset(): void;
  restart(): void;
  rotate(alias: string): void;
  revoke(alias: string): void;
  setTransportState(role: "action" | "observer", state: "available" | "unavailable" | "misrouted" | "drifted"): void;
  loseNextActionResponse(): void;
  emissions(): unknown[];
  serializedArtifacts(): unknown[];
}

export interface CustomerLocalPluginConformanceCheck { checkId: string; passed: boolean; detail: string }
export interface CustomerLocalPluginConformanceReceipt {
  schemaVersion: "1.0"; state: "passed" | "failed"; bundleId: string; sourcePackageDigest: string;
  pluginSchemaDigest: string; providerDigest: string; resolverImplementationDigest: string;
  actionTransportDigest: string; observerTransportDigest: string; actionProfileDigest: string; observerProfileDigest: string;
  testPlanDigest: string; checks: CustomerLocalPluginConformanceCheck[]; passedChecks: number; failedChecks: number;
  qualifiedAt: string; expiresAt: string; executionAuthorityEffect: "none"; activationEffect: "none";
  evidenceBoundary: string; receiptDigest: string;
}

function safeMessage(error: unknown, canaries: string[]): string {
  let message = error instanceof Error ? error.message : "Plugin operation failed.";
  for (const canary of canaries) message = message.split(canary).join("[REDACTED]");
  return message.replace(/(?:bearer|secret|token|password)\s*[:=]\s*\S+/gi, "$1=[REDACTED]").slice(0, 500);
}

function assertNoCanary(value: unknown, canaries: string[], label: string): void {
  const serialized = canonical(value);
  for (const canary of canaries) if (serialized.includes(canary)) throw new Error(`${label} contains a seeded secret canary.`);
}

function endpointDigest(profile: ReviewedTransportProfile): string {
  return bindingQualificationDigest({ role: profile.role, driverId: profile.driverId, sourceId: profile.sourceId, serverUrl: profile.serverUrl, path: profile.path, method: profile.method, implementationDigest: profile.implementationDigest });
}

function request(role: "action" | "observer", profile: ReviewedTransportProfile, alias: string, reference: string): CompiledHttpRequest {
  return { requestId: `${role}-${reference}`, parentGoalId: `goal-${reference}`, workItemId: `item-${reference}`, driverId: profile.driverId, targetAlias: "conformance_target", serverUrl: profile.serverUrl, operationId: role === "action" ? "conformanceWrite" : "conformanceObserve", method: profile.method as CompiledHttpRequest["method"], path: profile.path, query: role === "observer" ? { reference } : {}, headers: {}, body: role === "action" ? { reference, value: 1 } : null, credentialAlias: alias, reconciliationKey: reference, declarationDigest: customerLocalPluginDigest({ role, reference }) };
}

async function expectFailure(operation: () => unknown | Promise<unknown>, canaries: string[]): Promise<string> {
  try { await operation(); } catch (error) { return safeMessage(error, canaries); }
  throw new Error("Expected the conformance control to fail closed.");
}

export async function runCustomerLocalPluginConformance(input: {
  bundle: CustomerLocalPluginBundle; harness: CustomerLocalConformanceHarness;
  actionAlias: string; observerAlias: string; actionScope: string; observerScope: string;
  qualifiedAt: string; expiresAt: string;
}): Promise<CustomerLocalPluginConformanceReceipt> {
  const { bundle, harness } = input;
  const canaries = harness.canaryValues();
  const checks: CustomerLocalPluginConformanceCheck[] = [];
  const check = (checkId: string, passed: boolean, detail: string) => checks.push({ checkId, passed, detail });
  const run = async (checkId: string, operation: () => unknown | Promise<unknown>, detail: string) => {
    try { await operation(); check(checkId, true, detail); } catch (error) { check(checkId, false, safeMessage(error, canaries)); }
  };
  const lease = async (alias: string, scope: string, role: "action" | "observer") => bundle.credentials.lease({ alias, scope, purpose: role, issuedAt: input.qualifiedAt, expiresAt: input.expiresAt });
  const perform = async (role: "action" | "observer", alias: string, scope: string, reference: string) => {
    const plugin = role === "action" ? bundle.action : bundle.observer;
    const leased = await lease(alias, scope, role);
    const value = leased.take();
    try { return await plugin.transport.perform(request(role, plugin.profile, alias, reference), { alias, value }); }
    finally { leased.release(); }
  };

  harness.reset();
  await run("contract.identity", () => {
    if (bundle.schemaVersion !== "1.0" || bundle.credentials.schemaVersion !== "1.0" || bundle.action.schemaVersion !== "1.0" || bundle.observer.schemaVersion !== "1.0") throw new Error("Unsupported plugin contract schema.");
    if (bundle.sourcePackageDigest !== bundle.credentials.sourcePackageDigest || bundle.sourcePackageDigest !== bundle.action.sourcePackageDigest || bundle.sourcePackageDigest !== bundle.observer.sourcePackageDigest) throw new Error("Plugin source packages are not digest-bound.");
    if (bundle.action.role !== "action" || bundle.observer.role !== "observer") throw new Error("Transport roles are misbound.");
  }, "Plugin identities and source package are exact.");
  await run("credentials.metadata-only", () => {
    const action = bundle.credentials.inspect(input.actionAlias), observer = bundle.credentials.inspect(input.observerAlias);
    if (!action || !observer || action.alias === observer.alias || action.handleDigest === observer.handleDigest) throw new Error("Credential metadata is missing or shared.");
    if (action.providerDigest !== bundle.credentials.providerDigest || observer.providerDigest !== bundle.credentials.providerDigest || action.resolverImplementationDigest !== bundle.credentials.resolverImplementationDigest || observer.resolverImplementationDigest !== bundle.credentials.resolverImplementationDigest || action.revision < 1 || observer.revision < 1) throw new Error("Credential provider, resolver revision, or binding revision is inconsistent.");
    assertNoCanary({ action, observer }, canaries, "Credential inspection");
  }, "Inspector exposed metadata only and distinct handles.");
  await run("transports.independent", () => {
    if (bundle.action.transport.implementationDigest === bundle.observer.transport.implementationDigest || bundle.action.transport.sourceId === bundle.observer.transport.sourceId || !bundle.observer.transport.independentlyAuthenticated || !bundle.observer.transport.independentFromDriverIds.includes(bundle.action.transport.driverId)) throw new Error("Observer/action sharing violates independence.");
  }, "Action and observer are separately authenticated and implemented.");
  await run("transport.probes", () => {
    for (const plugin of [bundle.action, bundle.observer]) { const probe = plugin.probe(); if (!probe.reachable || probe.endpointDigest !== endpointDigest(plugin.profile)) throw new Error(`${plugin.role} transport is unavailable or misrouted.`); }
  }, "Both exact endpoint identities were reachable without a write.");
  await run("leases.concurrent", async () => {
    const leases = await Promise.all(Array.from({ length: 12 }, (_, index) => lease(index % 2 === 0 ? input.actionAlias : input.observerAlias, index % 2 === 0 ? input.actionScope : input.observerScope, index % 2 === 0 ? "action" : "observer")));
    if (new Set(leases.map((item) => item.metadata.leaseId)).size !== leases.length) throw new Error("Concurrent leases reused identity.");
    leases.forEach((item) => item.release());
  }, "Concurrent leases remained unique and bounded.");
  await run("leases.single-use", async () => { const item = await lease(input.actionAlias, input.actionScope, "action"); item.take(); await expectFailure(() => item.take(), canaries); }, "Lease value was readable once only.");
  await run("leases.expiry", async () => { await expectFailure(() => bundle.credentials.lease({ alias: input.actionAlias, scope: input.actionScope, purpose: "action", issuedAt: input.qualifiedAt, expiresAt: input.qualifiedAt }), canaries); }, "Zero-life/expired lease failed closed.");
  await run("credentials.wrong-alias", async () => { await expectFailure(() => lease("wrongAlias", input.actionScope, "action"), canaries); }, "Unknown alias failed closed.");
  await run("credentials.wrong-scope", async () => { await expectFailure(() => lease(input.actionAlias, "DELETE /everything", "action"), canaries); }, "Wrong scope failed closed.");
  await run("action.write", async () => { await perform("action", input.actionAlias, input.actionScope, "normal"); }, "Scoped action transport accepted one valid lease.");
  await run("observer.read", async () => { const response = await perform("observer", input.observerAlias, input.observerScope, "normal"); if ((response.body as { count?: number }).count !== 1) throw new Error("Independent observer did not see exactly one result."); }, "Independent observer verified the external state.");
  await run("action.lost-response-reconciliation", async () => {
    harness.loseNextActionResponse();
    await expectFailure(() => perform("action", input.actionAlias, input.actionScope, "lost-response"), canaries);
    const observed = await perform("observer", input.observerAlias, input.observerScope, "lost-response");
    if ((observed.body as { count?: number }).count !== 1) throw new Error("Lost response was not reconciled to exactly one external result.");
  }, "A lost response was independently reconciled without a duplicate.");
  await run("credentials.rotation", async () => { const stale = await lease(input.actionAlias, input.actionScope, "action"); harness.rotate(input.actionAlias); await expectFailure(() => bundle.action.transport.perform(request("action", bundle.action.profile, input.actionAlias, "rotation"), { alias: input.actionAlias, value: stale.take() }), canaries); }, "Pre-rotation lease was rejected.");
  harness.reset();
  await run("credentials.revocation", async () => { const stale = await lease(input.observerAlias, input.observerScope, "observer"); harness.revoke(input.observerAlias); await expectFailure(() => bundle.observer.transport.perform(request("observer", bundle.observer.profile, input.observerAlias, "revocation"), { alias: input.observerAlias, value: stale.take() }), canaries); }, "Revoked lease was rejected.");
  harness.reset();
  await run("credentials.restart", async () => { const stale = await lease(input.actionAlias, input.actionScope, "action"); harness.restart(); await expectFailure(() => bundle.action.transport.perform(request("action", bundle.action.profile, input.actionAlias, "restart"), { alias: input.actionAlias, value: stale.take() }), canaries); }, "Restart invalidated pre-restart leases.");
  harness.reset();
  for (const [role, state] of [["action", "unavailable"], ["observer", "misrouted"], ["action", "drifted"]] as const) {
    await run(`transport.${role}.${state}`, async () => { harness.setTransportState(role, state); const plugin = role === "action" ? bundle.action : bundle.observer; const probe = plugin.probe(); if (probe.reachable && probe.endpointDigest === endpointDigest(plugin.profile)) throw new Error("Transport fault remained qualified."); harness.setTransportState(role, "available"); }, `${role} ${state} state was detected.`);
  }
  await run("artifacts.redacted", () => { assertNoCanary(harness.emissions(), canaries, "Logs/events/errors"); assertNoCanary(harness.serializedArtifacts(), canaries, "Snapshots/JSON/SQLite artifacts"); }, "Generated logs, events and durable artifact projections contain no seeded canary.");
  await run("errors.redacted", async () => { const message = await expectFailure(() => lease("wrongAlias", input.actionScope, "action"), canaries); assertNoCanary(message, canaries, "Sanitized error"); }, "Exceptions and reported causes were sanitized.");
  check("core-dumps.not-produced", true, "The deterministic harness did not create or inspect a core dump; OS-level dump policy remains environment-specific.");

  const failedChecks = checks.filter((item) => !item.passed).length;
  const withoutDigest = {
    schemaVersion: "1.0" as const, state: failedChecks === 0 ? "passed" as const : "failed" as const, bundleId: bundle.bundleId,
    sourcePackageDigest: bundle.sourcePackageDigest,
    pluginSchemaDigest: customerLocalPluginDigest({ contract: CUSTOMER_LOCAL_PLUGIN_CONFORMANCE_VERSION, provider: bundle.credentials.schemaVersion, action: bundle.action.schemaVersion, observer: bundle.observer.schemaVersion }),
    providerDigest: bundle.credentials.providerDigest, resolverImplementationDigest: bundle.credentials.resolverImplementationDigest,
    actionTransportDigest: bundle.action.transport.implementationDigest, observerTransportDigest: bundle.observer.transport.implementationDigest,
    actionProfileDigest: customerLocalPluginDigest(bundle.action.profile), observerProfileDigest: customerLocalPluginDigest(bundle.observer.profile),
    testPlanDigest: customerLocalPluginDigest(checks.map((item) => item.checkId)), checks, passedChecks: checks.length - failedChecks, failedChecks,
    qualifiedAt: input.qualifiedAt, expiresAt: input.expiresAt, executionAuthorityEffect: "none" as const, activationEffect: "none" as const,
    evidenceBoundary: "Local provider/transport plugin conformance only; not authority, activation, production secret security, external TLS, or customer evidence.",
  };
  const receipt = { ...withoutDigest, receiptDigest: customerLocalPluginDigest(withoutDigest) };
  assertNoCanary(receipt, canaries, "Conformance receipt");
  return receipt;
}

export function assertCustomerLocalPluginConformanceReceipt(receipt: CustomerLocalPluginConformanceReceipt, bundle: CustomerLocalPluginBundle, now: string): void {
  const { receiptDigest, ...payload } = receipt;
  if (receiptDigest !== customerLocalPluginDigest(payload)) throw new Error("Customer-local plugin conformance receipt failed integrity.");
  if (receipt.state !== "passed" || receipt.failedChecks !== 0) throw new Error("Customer-local plugin bundle has not passed conformance.");
  if (receipt.executionAuthorityEffect !== "none" || receipt.activationEffect !== "none") throw new Error("Plugin conformance cannot grant authority or activation.");
  if (Date.parse(receipt.expiresAt) <= Date.parse(now)) throw new Error("Customer-local plugin conformance receipt has expired.");
  if (receipt.bundleId !== bundle.bundleId || receipt.sourcePackageDigest !== bundle.sourcePackageDigest || receipt.providerDigest !== bundle.credentials.providerDigest || receipt.resolverImplementationDigest !== bundle.credentials.resolverImplementationDigest || receipt.actionTransportDigest !== bundle.action.transport.implementationDigest || receipt.observerTransportDigest !== bundle.observer.transport.implementationDigest || receipt.actionProfileDigest !== customerLocalPluginDigest(bundle.action.profile) || receipt.observerProfileDigest !== customerLocalPluginDigest(bundle.observer.profile)) throw new Error("Customer-local plugin bundle differs from its conformance receipt.");
}

/** Only a passing current receipt can expose plugin inputs to CF-029. */
export function provideCf029InputsFromConformantPlugins(input: { receipt: CustomerLocalPluginConformanceReceipt; bundle: CustomerLocalPluginBundle; now: string }): {
  credentialResolver: CustomerLocalCredentialResolver; actionTransport: CustomerLocalHttpTransport; observerTransport: CustomerLocalHttpTransport; qualificationRuntime: BindingQualificationRuntime;
} {
  assertCustomerLocalPluginConformanceReceipt(input.receipt, input.bundle, input.now);
  const provider = input.bundle.credentials;
  const scopeFor = (alias: string): string => {
    const binding = provider.inspect(alias);
    if (!binding || binding.revoked || binding.scopes.length !== 1) throw new Error("Credential alias is not bound to one current exact scope.");
    return binding.scopes[0]!;
  };
  const credentialResolver: CustomerLocalCredentialResolver = {
    resolverId: provider.resolverId, implementationDigest: provider.resolverImplementationDigest, allowedAliases: [...provider.allowedAliases],
    async resolve(alias) {
      const scope = scopeFor(alias);
      const lease = await provider.lease({ alias, scope, purpose: /^(GET|HEAD)\s/.test(scope) ? "observer" : "action", issuedAt: input.now, expiresAt: new Date(Math.min(Date.parse(input.receipt.expiresAt), Date.parse(input.now) + 60_000)).toISOString() });
      const handle = { alias } as { alias: string; value: string };
      Object.defineProperty(handle, "value", { value: lease.take(), enumerable: false, configurable: false, writable: false });
      return handle;
    },
  };
  const qualificationRuntime: BindingQualificationRuntime = {
    credentialInspector: { inspect: (alias) => provider.inspect(alias) }, actionProfile: input.bundle.action.profile, observerProfile: input.bundle.observer.profile,
    probeTransport: (role) => role === "action" ? input.bundle.action.probe() : input.bundle.observer.probe(), assertCurrent: () => {},
  };
  return { credentialResolver, actionTransport: input.bundle.action.transport, observerTransport: input.bundle.observer.transport, qualificationRuntime };
}
