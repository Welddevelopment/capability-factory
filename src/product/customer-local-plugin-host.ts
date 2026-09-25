import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  assertCustomerLocalPluginConformanceReceipt,
  provideCf029InputsFromConformantPlugins,
  runCustomerLocalPluginConformance,
  type CustomerLocalConformanceHarness,
  type CustomerLocalPluginBundle,
  type CustomerLocalPluginConformanceReceipt,
} from "./customer-local-plugin-conformance.js";
import { createReferenceCustomerLocalPluginFixture, type ReferencePluginShape } from "./customer-local-reference-plugins.js";
import type { OnboardingCompilationRuntimeResolver } from "./onboarding-productization-sidecar.js";

export const CUSTOMER_LOCAL_PLUGIN_HOST_VERSION = "1.0" as const;

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const customerLocalPluginHostDigest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
function profilePinDigest(profile: CustomerLocalPluginBundle["action"]["profile"]): string { const { reviewedAt: _reviewedAt, expiresAt: _expiresAt, ...pinned } = profile; return customerLocalPluginHostDigest(pinned); }
const canaryShaped = /CF_CANARY_[A-Z0-9_-]+|(?:bearer|password|secret|token|api[_ -]?key)\s*[:=]\s*[^\s,;}]+/i;

export interface CustomerLocalPluginHostManifestEntry {
  schemaVersion: "1.0"; bundleId: string; loaderKey: string; sourcePackageDigest: string;
  providerDigest: string; resolverImplementationDigest: string; actionTransportDigest: string; observerTransportDigest: string;
  actionProfileDigest: string; observerProfileDigest: string; actionAlias: string; observerAlias: string; actionScope: string; observerScope: string;
}
export interface CustomerLocalPluginHostManifest {
  schemaVersion: "1.0"; tenantId: string; entries: CustomerLocalPluginHostManifestEntry[]; manifestDigest: string;
}
export interface LoadedCustomerLocalPlugin {
  bundle: CustomerLocalPluginBundle; harness: CustomerLocalConformanceHarness;
  actionAlias: string; observerAlias: string; actionScope: string; observerScope: string;
}
export interface CustomerLocalPluginHostLoader {
  loaderKey: string;
  load(input: { qualifiedAt: string; expiresAt: string }): LoadedCustomerLocalPlugin | Promise<LoadedCustomerLocalPlugin>;
}
export type PluginHostState = "reload-required" | "loading" | "conformant" | "quarantined";
export interface PluginHostBlocker { blockerId: string; remediationClass: "manifest" | "plugin-package" | "credentials" | "transport" | "conformance" | "restart" | "operator-review"; detail: string }
export interface PluginHostDoctorCheck { checkId: string; passed: boolean; detail: string }
export interface PluginHostDoctorReport {
  schemaVersion: "1.0"; tenantId: string; bundleId: string; state: PluginHostState; usableForCf029: boolean;
  packageIdentity: { loaderKey: string; sourcePackageDigest: string; providerDigest: string; resolverImplementationDigest: string; actionTransportDigest: string; observerTransportDigest: string };
  conformance: { receiptDigest: string | null; passedControls: number; failedControls: number; expiresAt: string | null };
  controls: PluginHostDoctorCheck[]; blockers: PluginHostBlocker[]; checkedAt: string;
  executionAuthorityEffect: "none"; activationEffect: "none"; reportDigest: string;
}
export interface PluginHostEvidenceExport {
  schemaVersion: "1.0"; tenantId: string; manifestDigest: string; bundles: Array<{ bundleId: string; state: PluginHostState; receipt: CustomerLocalPluginConformanceReceipt | null; quarantineReason: string | null }>;
  events: Array<{ sequence: number; bundleId: string; eventType: string; detail: string; recordedAt: string }>;
  exportedAt: string; executionAuthorityEffect: "none"; activationEffect: "none"; evidenceDigest: string;
}

interface PersistedBundleRow { bundle_id: string; state: PluginHostState; receipt_json: string | null; quarantine_reason: string | null; updated_at: string }
interface ActiveBundle { loaded: LoadedCustomerLocalPlugin; receipt: CustomerLocalPluginConformanceReceipt; credentialPostureDigest: string }

function manifestPayload(manifest: Omit<CustomerLocalPluginHostManifest, "manifestDigest"> | CustomerLocalPluginHostManifest) { const { manifestDigest: _ignored, ...payload } = manifest as CustomerLocalPluginHostManifest; return payload; }
function assertManifest(manifest: CustomerLocalPluginHostManifest): void {
  if (manifest.schemaVersion !== "1.0" || manifest.manifestDigest !== customerLocalPluginHostDigest(manifestPayload(manifest))) throw new Error("Plugin host manifest failed schema or integrity validation.");
  if (new Set(manifest.entries.map((entry) => entry.bundleId)).size !== manifest.entries.length || new Set(manifest.entries.map((entry) => entry.loaderKey)).size !== manifest.entries.length) throw new Error("Plugin host manifest contains duplicate bundle or loader identities.");
  if (canaryShaped.test(canonical(manifest))) throw new Error("Plugin host manifest contains secret-shaped material.");
}
function safeDetail(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return raw.replace(/CF_CANARY_[A-Z0-9_-]+/gi, "[REDACTED]").replace(/((?:bearer|password|secret|token|api[_ -]?key)\s*[:=]\s*)[^\s,;}]+/gi, "$1[REDACTED]").slice(0, 500);
}

export class CustomerLocalPluginHost {
  private readonly database: DatabaseSync;
  private readonly loaders: Map<string, CustomerLocalPluginHostLoader>;
  private readonly active = new Map<string, ActiveBundle>();
  private readonly loading = new Map<string, Promise<PluginHostDoctorReport>>();
  private readonly now: () => string;

  constructor(readonly manifest: CustomerLocalPluginHostManifest, input: { statePath: string; loaders: CustomerLocalPluginHostLoader[]; now?: () => string }) {
    assertManifest(manifest);
    this.now = input.now ?? (() => new Date().toISOString());
    this.loaders = new Map(input.loaders.map((loader) => [loader.loaderKey, loader]));
    mkdirSync(dirname(input.statePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(input.statePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS customer_local_plugin_bundles (tenant_id TEXT NOT NULL, bundle_id TEXT NOT NULL, state TEXT NOT NULL, receipt_json TEXT, quarantine_reason TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, bundle_id));
      CREATE TABLE IF NOT EXISTS customer_local_plugin_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, bundle_id TEXT NOT NULL, event_type TEXT NOT NULL, detail TEXT NOT NULL, recorded_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS customer_local_plugin_imports (evidence_digest TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, evidence_json TEXT NOT NULL, imported_at TEXT NOT NULL);
    `);
    for (const entry of manifest.entries) {
      const existing = this.row(entry.bundleId);
      if (existing?.state === "loading") this.persist(entry.bundleId, "quarantined", null, "Previous process stopped during plugin load or doctor execution.");
      else if (!existing) this.persist(entry.bundleId, "reload-required", null, null);
      else if (existing.state === "conformant") this.persist(entry.bundleId, "reload-required", null, "Fresh conformance is required after process restart.");
    }
  }

  private entry(bundleId: string): CustomerLocalPluginHostManifestEntry {
    const entry = this.manifest.entries.find((item) => item.bundleId === bundleId);
    if (!entry) throw new Error("Plugin bundle is not present in the explicit local allowlist.");
    return entry;
  }
  private row(bundleId: string): PersistedBundleRow | undefined {
    return this.database.prepare("SELECT bundle_id, state, receipt_json, quarantine_reason, updated_at FROM customer_local_plugin_bundles WHERE tenant_id = ? AND bundle_id = ?").get(this.manifest.tenantId, bundleId) as PersistedBundleRow | undefined;
  }
  private event(bundleId: string, eventType: string, detail: string): void {
    const safe = safeDetail(detail);
    if (canaryShaped.test(safe)) throw new Error("Plugin host event failed redaction.");
    this.database.prepare("INSERT INTO customer_local_plugin_events (tenant_id, bundle_id, event_type, detail, recorded_at) VALUES (?, ?, ?, ?, ?)").run(this.manifest.tenantId, bundleId, eventType, safe, this.now());
  }
  private persist(bundleId: string, state: PluginHostState, receipt: CustomerLocalPluginConformanceReceipt | null, quarantineReason: string | null): void {
    const receiptJson = receipt ? JSON.stringify(receipt) : null;
    if (canaryShaped.test(receiptJson ?? "") || canaryShaped.test(quarantineReason ?? "")) throw new Error("Plugin host persistence rejected secret-shaped material.");
    this.database.prepare("INSERT INTO customer_local_plugin_bundles (tenant_id, bundle_id, state, receipt_json, quarantine_reason, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, bundle_id) DO UPDATE SET state = excluded.state, receipt_json = excluded.receipt_json, quarantine_reason = excluded.quarantine_reason, updated_at = excluded.updated_at")
      .run(this.manifest.tenantId, bundleId, state, receiptJson, quarantineReason, this.now());
  }
  private quarantine(bundleId: string, reason: unknown): void {
    const detail = safeDetail(reason);
    this.active.delete(bundleId);
    this.persist(bundleId, "quarantined", null, detail);
    this.event(bundleId, "bundle-quarantined", detail);
  }

  async load(bundleId: string, lifetimeMilliseconds = 60 * 60 * 1_000): Promise<PluginHostDoctorReport> {
    const existing = this.loading.get(bundleId);
    if (existing) return existing;
    const operation = this.loadOnce(bundleId, lifetimeMilliseconds).finally(() => this.loading.delete(bundleId));
    this.loading.set(bundleId, operation);
    return operation;
  }
  private async loadOnce(bundleId: string, lifetimeMilliseconds: number): Promise<PluginHostDoctorReport> {
    const entry = this.entry(bundleId);
    const loader = this.loaders.get(entry.loaderKey);
    this.persist(bundleId, "loading", null, null); this.event(bundleId, "load-started", "Fresh local conformance started.");
    try {
      if (!loader) throw new Error("Pinned local plugin loader is missing.");
      const qualifiedAt = this.now(), expiresAt = new Date(Date.parse(qualifiedAt) + lifetimeMilliseconds).toISOString();
      const loaded = await loader.load({ qualifiedAt, expiresAt });
      this.assertPinned(entry, loaded.bundle);
      const receipt = await runCustomerLocalPluginConformance({ bundle: loaded.bundle, harness: loaded.harness, actionAlias: loaded.actionAlias, observerAlias: loaded.observerAlias, actionScope: loaded.actionScope, observerScope: loaded.observerScope, qualifiedAt, expiresAt });
      if (receipt.state !== "passed") throw new Error(`Plugin conformance failed ${receipt.failedChecks} controls.`);
      assertCustomerLocalPluginConformanceReceipt(receipt, loaded.bundle, qualifiedAt);
      const credentialPostureDigest = customerLocalPluginHostDigest({ action: loaded.bundle.credentials.inspect(entry.actionAlias), observer: loaded.bundle.credentials.inspect(entry.observerAlias) });
      this.active.set(bundleId, { loaded, receipt, credentialPostureDigest });
      this.persist(bundleId, "conformant", receipt, null); this.event(bundleId, "load-conformant", `Passed ${receipt.passedChecks} frozen controls.`);
    } catch (error) { this.quarantine(bundleId, error); }
    return this.doctor(bundleId);
  }
  private assertPinned(entry: CustomerLocalPluginHostManifestEntry, bundle: CustomerLocalPluginBundle): void {
    const values = { sourcePackageDigest: bundle.sourcePackageDigest, providerDigest: bundle.credentials.providerDigest, resolverImplementationDigest: bundle.credentials.resolverImplementationDigest, actionTransportDigest: bundle.action.transport.implementationDigest, observerTransportDigest: bundle.observer.transport.implementationDigest, actionProfileDigest: profilePinDigest(bundle.action.profile), observerProfileDigest: profilePinDigest(bundle.observer.profile) };
    for (const [key, value] of Object.entries(values)) if (value !== entry[key as keyof typeof values]) throw new Error(`Pinned ${key} changed; package is quarantined.`);
    if (bundle.schemaVersion !== "1.0" || bundle.credentials.schemaVersion !== "1.0" || bundle.action.schemaVersion !== "1.0" || bundle.observer.schemaVersion !== "1.0") throw new Error("Plugin schema version changed.");
  }

  doctor(bundleId: string): PluginHostDoctorReport {
    const entry = this.entry(bundleId), row = this.row(bundleId) ?? { bundle_id: bundleId, state: "reload-required" as const, receipt_json: null, quarantine_reason: null, updated_at: this.now() };
    const controls: PluginHostDoctorCheck[] = [], blockers: PluginHostBlocker[] = [];
    const add = (checkId: string, passed: boolean, detail: string, blocker?: PluginHostBlocker) => { controls.push({ checkId, passed, detail }); if (!passed && blocker) blockers.push(blocker); };
    const active = this.active.get(bundleId);
    add("manifest.allowlisted", true, "Bundle is present in the explicit manifest.");
    add("loader.present", this.loaders.has(entry.loaderKey), this.loaders.has(entry.loaderKey) ? "Pinned loader is present." : "Pinned loader is missing.", { blockerId: "missing-loader", remediationClass: "plugin-package", detail: "Restore the exact allowlisted local loader." });
    add("restart.fresh-conformance", Boolean(active), active ? "This process completed fresh conformance." : "This process has no fresh conformance.", { blockerId: "fresh-conformance-required", remediationClass: "restart", detail: "Load the pinned bundle and rerun conformance in this process." });
    let receipt: CustomerLocalPluginConformanceReceipt | null = active?.receipt ?? (row.receipt_json ? JSON.parse(row.receipt_json) as CustomerLocalPluginConformanceReceipt : null);
    if (active) {
      try { this.assertPinned(entry, active.loaded.bundle); assertCustomerLocalPluginConformanceReceipt(active.receipt, active.loaded.bundle, this.now()); add("package.pins-current", true, "Source and implementation pins are current."); }
      catch (error) { add("package.pins-current", false, safeDetail(error), { blockerId: "package-drift", remediationClass: "plugin-package", detail: safeDetail(error) }); this.quarantine(bundleId, error); receipt = null; }
      let credentialsCurrent = false;
      try { const action = active.loaded.bundle.credentials.inspect(entry.actionAlias), observer = active.loaded.bundle.credentials.inspect(entry.observerAlias); credentialsCurrent = Boolean(action && observer && !action.revoked && !observer.revoked && action.scopes.includes(entry.actionScope) && observer.scopes.includes(entry.observerScope) && Date.parse(action.expiresAt) > Date.parse(this.now()) && Date.parse(observer.expiresAt) > Date.parse(this.now()) && customerLocalPluginHostDigest({ action, observer }) === active.credentialPostureDigest); }
      catch (error) { this.quarantine(bundleId, `Credential doctor crashed: ${safeDetail(error)}`); }
      add("credentials.posture", credentialsCurrent, credentialsCurrent ? "Aliases, scopes, expiry and revocation posture are current." : "Credential metadata changed, expired, revoked, crossed scope or the doctor failed.", { blockerId: "credential-posture", remediationClass: "credentials", detail: "Restore and reconform exact aliases/scopes/revisions." });
      let transportsCurrent = false;
      try { const actionProbe = active.loaded.bundle.action.probe(), observerProbe = active.loaded.bundle.observer.probe(); transportsCurrent = actionProbe.reachable && observerProbe.reachable && actionProbe.endpointDigest !== observerProbe.endpointDigest && active.loaded.bundle.action.transport.implementationDigest !== active.loaded.bundle.observer.transport.implementationDigest && active.loaded.bundle.action.transport.sourceId !== active.loaded.bundle.observer.transport.sourceId; }
      catch (error) { this.quarantine(bundleId, `Transport doctor crashed: ${safeDetail(error)}`); }
      add("transports.posture", transportsCurrent, transportsCurrent ? "Separate exact transports are reachable." : "Transport reachability, routing, separation changed or the doctor failed.", { blockerId: "transport-posture", remediationClass: "transport", detail: "Repair exact separate transports and rerun conformance." });
      if (!credentialsCurrent || !transportsCurrent) { this.quarantine(bundleId, "Doctor detected changed credential or transport posture."); receipt = null; }
      try { const scan = canonical({ receipt: active.receipt, events: active.loaded.harness.emissions(), artifacts: active.loaded.harness.serializedArtifacts() }); if (canaryShaped.test(scan)) throw new Error("Redaction scan found secret-shaped material."); add("redaction.scan", true, "Receipt, events and artifacts passed canary scan."); }
      catch (error) { add("redaction.scan", false, safeDetail(error), { blockerId: "redaction-failure", remediationClass: "operator-review", detail: "Quarantine artifacts and repair redaction before reuse." }); this.quarantine(bundleId, error); receipt = null; }
    } else add("redaction.scan", false, "No active in-process bundle is available to scan.", { blockerId: "redaction-not-run", remediationClass: "conformance", detail: "Fresh load and conformance are required." });
    const finalRow = this.row(bundleId)!;
    const state = finalRow.state;
    if (state === "quarantined") blockers.push({ blockerId: "bundle-quarantined", remediationClass: "operator-review", detail: finalRow.quarantine_reason ?? "Bundle is quarantined." });
    const withoutDigest = { schemaVersion: "1.0" as const, tenantId: this.manifest.tenantId, bundleId, state, usableForCf029: state === "conformant" && blockers.length === 0, packageIdentity: { loaderKey: entry.loaderKey, sourcePackageDigest: entry.sourcePackageDigest, providerDigest: entry.providerDigest, resolverImplementationDigest: entry.resolverImplementationDigest, actionTransportDigest: entry.actionTransportDigest, observerTransportDigest: entry.observerTransportDigest }, conformance: { receiptDigest: receipt?.receiptDigest ?? null, passedControls: receipt?.passedChecks ?? 0, failedControls: receipt?.failedChecks ?? 0, expiresAt: receipt?.expiresAt ?? null }, controls, blockers, checkedAt: this.now(), executionAuthorityEffect: "none" as const, activationEffect: "none" as const };
    return { ...withoutDigest, reportDigest: customerLocalPluginHostDigest(withoutDigest) };
  }

  resolveCf029Inputs(bundleId: string) {
    const report = this.doctor(bundleId);
    if (!report.usableForCf029) throw new Error(`Plugin host blocked CF-029 inputs: ${report.blockers.map((item) => item.blockerId).join(", ")}`);
    const active = this.active.get(bundleId)!;
    return provideCf029InputsFromConformantPlugins({ receipt: active.receipt, bundle: active.loaded.bundle, now: this.now() });
  }

  evidenceExport(): PluginHostEvidenceExport {
    const bundles = this.manifest.entries.map((entry) => { const row = this.row(entry.bundleId)!; return { bundleId: entry.bundleId, state: row.state, receipt: row.receipt_json ? JSON.parse(row.receipt_json) as CustomerLocalPluginConformanceReceipt : null, quarantineReason: row.quarantine_reason }; });
    const events = this.database.prepare("SELECT sequence, bundle_id, event_type, detail, recorded_at FROM customer_local_plugin_events WHERE tenant_id = ? ORDER BY sequence").all(this.manifest.tenantId) as Array<{ sequence: number; bundle_id: string; event_type: string; detail: string; recorded_at: string }>;
    const withoutDigest = { schemaVersion: "1.0" as const, tenantId: this.manifest.tenantId, manifestDigest: this.manifest.manifestDigest, bundles, events: events.map((item) => ({ sequence: item.sequence, bundleId: item.bundle_id, eventType: item.event_type, detail: item.detail, recordedAt: item.recorded_at })), exportedAt: this.now(), executionAuthorityEffect: "none" as const, activationEffect: "none" as const };
    const evidence = { ...withoutDigest, evidenceDigest: customerLocalPluginHostDigest(withoutDigest) };
    if (canaryShaped.test(canonical(evidence))) throw new Error("Plugin host evidence export failed redaction.");
    return evidence;
  }
  evidenceImport(evidence: PluginHostEvidenceExport): void {
    const { evidenceDigest, ...payload } = evidence;
    if (evidenceDigest !== customerLocalPluginHostDigest(payload) || evidence.tenantId !== this.manifest.tenantId || evidence.manifestDigest !== this.manifest.manifestDigest || evidence.executionAuthorityEffect !== "none" || evidence.activationEffect !== "none" || canaryShaped.test(canonical(evidence))) throw new Error("Plugin host evidence import failed integrity, tenant, manifest, authority or redaction validation.");
    this.database.prepare("INSERT OR IGNORE INTO customer_local_plugin_imports (evidence_digest, tenant_id, evidence_json, imported_at) VALUES (?, ?, ?, ?)").run(evidence.evidenceDigest, this.manifest.tenantId, JSON.stringify(evidence), this.now());
    this.event("host", "evidence-imported", `Imported non-authorizing evidence ${evidence.evidenceDigest}.`);
  }
  close(): void { this.active.clear(); this.database.close(); }
}

export function createReferencePluginHostManifest(tenantId: string): { manifest: CustomerLocalPluginHostManifest; loaders: CustomerLocalPluginHostLoader[] } {
  const entries: CustomerLocalPluginHostManifestEntry[] = [], loaders: CustomerLocalPluginHostLoader[] = [];
  for (const shape of ["map-direct", "callback-queued"] as ReferencePluginShape[]) {
    const sample = createReferenceCustomerLocalPluginFixture(shape);
    const loaderKey = `reference:${shape}:v1`;
    entries.push({ schemaVersion: "1.0", bundleId: sample.bundle.bundleId, loaderKey, sourcePackageDigest: sample.bundle.sourcePackageDigest, providerDigest: sample.bundle.credentials.providerDigest, resolverImplementationDigest: sample.bundle.credentials.resolverImplementationDigest, actionTransportDigest: sample.bundle.action.transport.implementationDigest, observerTransportDigest: sample.bundle.observer.transport.implementationDigest, actionProfileDigest: profilePinDigest(sample.bundle.action.profile), observerProfileDigest: profilePinDigest(sample.bundle.observer.profile), actionAlias: sample.actionAlias, observerAlias: sample.observerAlias, actionScope: sample.actionScope, observerScope: sample.observerScope });
    loaders.push({ loaderKey, load: ({ qualifiedAt, expiresAt }) => createReferenceCustomerLocalPluginFixture(shape, { qualifiedAt, expiresAt }) });
  }
  const withoutDigest = { schemaVersion: "1.0" as const, tenantId, entries };
  return { manifest: { ...withoutDigest, manifestDigest: customerLocalPluginHostDigest(withoutDigest) }, loaders };
}

export function hostedOnboardingCompilationRuntimeResolver(host: CustomerLocalPluginHost, selectBundleId: (input: Parameters<OnboardingCompilationRuntimeResolver["resolve"]>[0]) => string, registries: { primitiveRegistryDigest: string; verifierRegistryDigest: string }): OnboardingCompilationRuntimeResolver {
  return { resolve(input) { const hosted = host.resolveCf029Inputs(selectBundleId(input)); return { ...hosted, primitiveRegistryDigest: registries.primitiveRegistryDigest, verifierRegistryDigest: registries.verifierRegistryDigest }; } };
}

function sameToken(left: string | undefined, right: string): boolean { if (!left) return false; return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest()); }
function parseBundleId(request: FastifyRequest): string { const value = (request.params as { bundleId?: unknown }).bundleId; if (typeof value !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.:-]{1,179}$/.test(value)) throw new Error("Invalid plugin bundle identity."); return value; }
function replyError(reply: FastifyReply, error: unknown) { reply.code(400); return { error: safeDetail(error) }; }

export function createCustomerLocalPluginHostSidecar(input: { host: CustomerLocalPluginHost; accessToken: string }): FastifyInstance {
  if (input.accessToken.length < 16) throw new Error("Plugin host access token must contain at least 16 characters.");
  const app = Fastify({ logger: false, bodyLimit: 2_000_000 });
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => { if (!sameToken(typeof request.headers["x-capability-sidecar-token"] === "string" ? request.headers["x-capability-sidecar-token"] : undefined, input.accessToken)) await reply.code(401).send({ error: "Unauthorized" }); };
  app.get("/health", async () => ({ status: "ok", boundary: "customer-local-plugin-host" }));
  app.post("/v1/plugins/:bundleId/load", { preHandler: authorize }, async (request, reply) => { try { return await input.host.load(parseBundleId(request)); } catch (error) { return replyError(reply, error); } });
  app.get("/v1/plugins/:bundleId/doctor", { preHandler: authorize }, async (request, reply) => { try { return input.host.doctor(parseBundleId(request)); } catch (error) { return replyError(reply, error); } });
  app.get("/v1/evidence/export", { preHandler: authorize }, async (_request, reply) => { try { return input.host.evidenceExport(); } catch (error) { return replyError(reply, error); } });
  app.post("/v1/evidence/import", { preHandler: authorize }, async (request, reply) => { try { input.host.evidenceImport(request.body as PluginHostEvidenceExport); reply.code(202); return { imported: true, executionAuthorityEffect: "none", activationEffect: "none" }; } catch (error) { return replyError(reply, error); } });
  return app;
}
