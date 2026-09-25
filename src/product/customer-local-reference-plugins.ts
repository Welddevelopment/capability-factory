import { randomUUID } from "node:crypto";
import {
  ProcessLocalSecretLease,
  customerLocalPluginDigest,
  type CustomerLocalConformanceHarness,
  type CustomerLocalPluginBundle,
  type CustomerLocalSecretProviderPlugin,
  type CustomerLocalTransportPlugin,
  type SecretLeaseMetadata,
} from "./customer-local-plugin-conformance.js";
import type { CompiledHttpRequest, CompiledHttpResponse, CustomerLocalCredentialHandle } from "./http-binding-compiler.js";
import { bindingQualificationDigest, type OpaqueCredentialBinding, type ReviewedTransportProfile } from "./customer-local-binding-qualification.js";

export type ReferencePluginShape = "map-direct" | "callback-queued";

// Reference-fixture validity window anchored to the real clock: lease expiry is
// enforced against real time, so fixed historical dates lapse as wall time
// passes and time-bomb every consumer test.
export const REFERENCE_PLUGIN_QUALIFIED_AT = new Date(Date.now() - 3_600_000).toISOString();
export const REFERENCE_PLUGIN_EXPIRES_AT = new Date(Date.now() + 2_592_000_000).toISOString();

interface CredentialState { alias: string; canary: string; scope: string; revision: number; revoked: boolean }
interface LeaseState { alias: string; scope: string; revision: number; epoch: number; expiresAt: string }

class ReferenceSecretProvider implements CustomerLocalSecretProviderPlugin {
  readonly schemaVersion = "1.0" as const;
  readonly pluginId: string;
  readonly providerDigest: string;
  readonly resolverId: string;
  readonly resolverImplementationDigest: string;
  readonly sourcePackageDigest: string;
  readonly pluginRevision = 1;
  readonly allowedAliases: string[];
  private readonly credentials = new Map<string, CredentialState>();
  private readonly leases = new Map<string, LeaseState>();
  private epoch = 1;
  readonly events: unknown[] = [];

  constructor(readonly shape: ReferencePluginShape, sourcePackageDigest: string, inputs: Array<{ alias: string; scope: string; canary: string }>) {
    this.pluginId = `reference-${shape}-secret-provider`;
    this.sourcePackageDigest = sourcePackageDigest;
    this.providerDigest = customerLocalPluginDigest({ pluginId: this.pluginId, shape, revision: 1 });
    this.resolverId = `reference-${shape}-resolver`;
    this.resolverImplementationDigest = customerLocalPluginDigest({ resolverId: this.resolverId, shape, revision: 1 });
    this.allowedAliases = inputs.map((item) => item.alias);
    for (const item of inputs) this.credentials.set(item.alias, { ...item, revision: 1, revoked: false });
  }
  inspect(alias: string): OpaqueCredentialBinding | null {
    const item = this.credentials.get(alias);
    if (!item) return null;
    return { alias, handleDigest: customerLocalPluginDigest({ provider: this.providerDigest, alias, revision: item.revision }), providerDigest: this.providerDigest, resolverImplementationDigest: this.resolverImplementationDigest, revision: item.revision, scopes: [item.scope], revoked: item.revoked, qualifiedAt: REFERENCE_PLUGIN_QUALIFIED_AT, expiresAt: REFERENCE_PLUGIN_EXPIRES_AT };
  }
  async lease(input: { alias: string; scope: string; purpose: "action" | "observer"; issuedAt: string; expiresAt: string }): Promise<ProcessLocalSecretLease> {
    const item = this.credentials.get(input.alias);
    if (!item || item.revoked) throw new Error("Credential alias is missing or revoked.");
    if (item.scope !== input.scope) throw new Error("Credential alias is not approved for the requested scope.");
    if (Date.parse(input.expiresAt) <= Date.parse(input.issuedAt)) throw new Error("Secret lease expiry must follow issuance.");
    const leaseId = randomUUID();
    const secret = `${item.canary}:${item.alias}:${item.revision}:${this.epoch}:${leaseId}`;
    this.leases.set(secret, { alias: item.alias, scope: item.scope, revision: item.revision, epoch: this.epoch, expiresAt: input.expiresAt });
    const metadata: SecretLeaseMetadata = { leaseId, alias: item.alias, scope: item.scope, providerDigest: this.providerDigest, resolverImplementationDigest: this.resolverImplementationDigest, credentialRevision: item.revision, issuedAt: input.issuedAt, expiresAt: input.expiresAt };
    this.events.push({ event: "lease-issued", alias: item.alias, scope: item.scope, leaseId, credentialRevision: item.revision });
    return new ProcessLocalSecretLease(metadata, secret);
  }
  authenticate(alias: string, scope: string, value: string): void {
    const lease = this.leases.get(value), item = this.credentials.get(alias);
    if (!lease || !item || item.revoked || lease.alias !== alias || lease.scope !== scope || lease.revision !== item.revision || lease.epoch !== this.epoch || Date.parse(lease.expiresAt) <= Date.now()) throw new Error("Customer-local lease is invalid, expired, rotated, revoked, or cross-scoped.");
    this.leases.delete(value);
  }
  rotate(alias: string): void { const item = this.credentials.get(alias); if (!item) throw new Error("Unknown alias."); item.revision += 1; }
  revoke(alias: string): void { const item = this.credentials.get(alias); if (!item) throw new Error("Unknown alias."); item.revoked = true; }
  restart(): void { this.epoch += 1; this.leases.clear(); }
  reset(): void { this.epoch += 1; this.leases.clear(); for (const item of this.credentials.values()) { item.revision = 1; item.revoked = false; } }
  canaries(): string[] { return [...this.credentials.values()].map((item) => item.canary); }
}

interface TransportState { mode: "available" | "unavailable" | "misrouted" | "drifted"; loseNext: boolean }

export function createReferenceCustomerLocalPluginFixture(shape: ReferencePluginShape, options?: {
  qualifiedAt?: string; expiresAt?: string; sourcePackageDigest?: string; actionAlias?: string; observerAlias?: string;
  action?: Partial<Pick<ReviewedTransportProfile, "driverId" | "sourceId" | "serverUrl" | "path" | "method" | "requestSchemaDigest" | "responseSchemaDigest" | "sourceDigest">>;
  observer?: Partial<Pick<ReviewedTransportProfile, "driverId" | "sourceId" | "serverUrl" | "path" | "method" | "requestSchemaDigest" | "responseSchemaDigest" | "sourceDigest">>;
}): {
  bundle: CustomerLocalPluginBundle; harness: CustomerLocalConformanceHarness; actionAlias: string; observerAlias: string; actionScope: string; observerScope: string;
} {
  const qualifiedAt = options?.qualifiedAt ?? REFERENCE_PLUGIN_QUALIFIED_AT;
  const expiresAt = options?.expiresAt ?? REFERENCE_PLUGIN_EXPIRES_AT;
  const actionAlias = options?.actionAlias ?? `${shape.replace("-", "")}Writer`, observerAlias = options?.observerAlias ?? `${shape.replace("-", "")}Observer`;
  const actionMethod = options?.action?.method ?? "POST", actionPath = options?.action?.path ?? "/orders";
  const observerMethod = options?.observer?.method ?? "GET", observerPath = options?.observer?.path ?? "/orders";
  const actionScope = `${actionMethod} ${actionPath}`, observerScope = `${observerMethod} ${observerPath}`;
  const sourcePackageDigest = options?.sourcePackageDigest ?? customerLocalPluginDigest({ fixture: shape, source: "local-reference-package-v1" });
  const provider = new ReferenceSecretProvider(shape, sourcePackageDigest, [{ alias: actionAlias, scope: actionScope, canary: `CF_CANARY_ACTION_${shape}_8f7c19` }, { alias: observerAlias, scope: observerScope, canary: `CF_CANARY_OBSERVER_${shape}_2b6e43` }]);
  const records = new Map<string, number>();
  const states: Record<"action" | "observer", TransportState> = { action: { mode: "available", loseNext: false }, observer: { mode: "available", loseNext: false } };
  const emissions: unknown[] = [];
  const profile = (role: "action" | "observer"): ReviewedTransportProfile => { const override = role === "action" ? options?.action : options?.observer; const actionDriverId = options?.action?.driverId ?? `${shape}-action-driver`; return ({ role, driverId: override?.driverId ?? `${shape}-${role}-driver`, sourceId: override?.sourceId ?? `${shape}-${role}-source`, serverUrl: override?.serverUrl ?? `https://${shape}.${role}.loopback.invalid/v1`, path: override?.path ?? "/orders", method: override?.method ?? (role === "action" ? "POST" : "GET"), requestSchemaDigest: override?.requestSchemaDigest ?? customerLocalPluginDigest({ shape, role, schema: "request" }), responseSchemaDigest: override?.responseSchemaDigest ?? customerLocalPluginDigest({ shape, role, schema: "response" }), sourceDigest: override?.sourceDigest ?? sourcePackageDigest, implementationDigest: customerLocalPluginDigest({ shape, role, implementation: shape === "map-direct" ? "direct" : "queued" }), tlsPolicy: "https-required", timeoutMilliseconds: 5_000, maximumRequestsPerMinute: 120, reconcileBeforeRetry: true, blindRetryAllowed: false, independentlyAuthenticated: true, independentFromDriverIds: role === "observer" ? [actionDriverId] : [], reviewedAt: qualifiedAt, expiresAt }); };
  const actionProfile = profile("action"), observerProfile = profile("observer");
  const perform = async (role: "action" | "observer", req: CompiledHttpRequest, credential: CustomerLocalCredentialHandle): Promise<CompiledHttpResponse> => {
    const expectedProfile = role === "action" ? actionProfile : observerProfile;
    const state = states[role];
    if (state.mode !== "available") throw new Error(`${role} transport is unavailable or misrouted.`);
    if (req.driverId !== expectedProfile.driverId || req.serverUrl !== expectedProfile.serverUrl || req.path !== expectedProfile.path || req.method !== expectedProfile.method) throw new Error("Transport request escaped the frozen endpoint boundary.");
    provider.authenticate(credential.alias, role === "action" ? actionScope : observerScope, credential.value);
    if (shape === "callback-queued") await Promise.resolve();
    if (role === "action") {
      records.set(req.reconciliationKey, 1);
      emissions.push({ event: "action-complete", requestId: req.requestId, credentialAlias: credential.alias, stateDigest: customerLocalPluginDigest([...records]) });
      if (state.loseNext) { state.loseNext = false; throw new Error("Simulated response loss after commit; credential value redacted."); }
      return { status: 201, headers: {}, body: { accepted: true } };
    }
    const count = records.has(req.reconciliationKey) ? 1 : 0;
    emissions.push({ event: "observation-complete", requestId: req.requestId, credentialAlias: credential.alias, count });
    return { status: 200, headers: {}, body: { count, observedAt: qualifiedAt } };
  };
  const plugin = (role: "action" | "observer", selected: ReviewedTransportProfile): CustomerLocalTransportPlugin => {
    const transport = { driverId: selected.driverId, sourceId: selected.sourceId, serverUrl: selected.serverUrl, implementationDigest: selected.implementationDigest, supportedMethods: [selected.method] as CustomerLocalTransportPlugin["transport"]["supportedMethods"], independentlyAuthenticated: true, independentFromDriverIds: [...selected.independentFromDriverIds], perform: (req: CompiledHttpRequest, credential: CustomerLocalCredentialHandle) => perform(role, req, credential) };
    return { schemaVersion: "1.0", pluginId: `${shape}-${role}-transport-plugin`, role, sourcePackageDigest, transport, profile: selected, probe: () => ({ reachable: states[role].mode === "available", endpointDigest: states[role].mode === "misrouted" || states[role].mode === "drifted" ? bindingQualificationDigest({ role, wrong: states[role].mode }) : bindingQualificationDigest({ role, driverId: selected.driverId, sourceId: selected.sourceId, serverUrl: selected.serverUrl, path: selected.path, method: selected.method, implementationDigest: selected.implementationDigest }), checkedAt: qualifiedAt }) };
  };
  const bundle: CustomerLocalPluginBundle = { schemaVersion: "1.0", bundleId: `reference-${shape}-bundle`, sourcePackageDigest, credentials: provider, action: plugin("action", actionProfile), observer: plugin("observer", observerProfile) };
  const harness: CustomerLocalConformanceHarness = {
    canaryValues: () => provider.canaries(),
    reset: () => { provider.reset(); records.clear(); states.action = { mode: "available", loseNext: false }; states.observer = { mode: "available", loseNext: false }; },
    restart: () => provider.restart(), rotate: (alias) => provider.rotate(alias), revoke: (alias) => provider.revoke(alias),
    setTransportState: (role, mode) => { states[role].mode = mode; }, loseNextActionResponse: () => { states.action.loseNext = true; },
    emissions: () => structuredClone([...provider.events, ...emissions]),
    serializedArtifacts: () => [{ table: "conformance_events", rows: structuredClone(emissions) }, { snapshot: { recordCount: records.size, recordDigest: customerLocalPluginDigest([...records]) } }],
  };
  return { bundle, harness, actionAlias, observerAlias, actionScope, observerScope };
}
