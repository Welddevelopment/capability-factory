import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CustomerLocalPluginHost,
  createCustomerLocalPluginHostSidecar,
  createReferencePluginHostManifest,
  customerLocalPluginHostDigest,
  hostedOnboardingCompilationRuntimeResolver,
  type CustomerLocalPluginHostLoader,
  type CustomerLocalPluginHostManifest,
} from "../src/product/customer-local-plugin-host.js";
import { createReferenceCustomerLocalPluginFixture } from "../src/product/customer-local-reference-plugins.js";
import { bindingQualificationSchemaDigests } from "../src/product/customer-local-binding-qualification.js";
import { readinessTestBindingArtifacts, readinessTestPreparation, readinessTestStartInput } from "./product-onboarding-readiness-receipt.test.js";

const tenantId = "plugin-host-tenant";
const token = "customer-local-plugin-host-token";
// Real-clock anchor: secret-lease expiry is enforced against real time, so
// fixed historical dates lapse as wall time passes.
const T0 = Date.now();
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));
async function statePath(name: string) { const directory = await mkdtemp(path.join(os.tmpdir(), `cf-plugin-host-${name}-`)); temporaryDirectories.push(directory); return path.join(directory, "host.sqlite"); }
function remanifest(manifest: CustomerLocalPluginHostManifest): CustomerLocalPluginHostManifest { const { manifestDigest: _old, ...payload } = manifest; return { ...payload, manifestDigest: customerLocalPluginHostDigest(payload) }; }

describe("restart-safe customer-local plugin host and doctor", () => {
  it("loads and doctors both explicit reference bundles, serializes concurrent load, and exposes CF-029 inputs", async () => {
    const configured = createReferencePluginHostManifest(tenantId);
    let loads = 0;
    const loaders = configured.loaders.map((loader) => ({ ...loader, async load(input: Parameters<CustomerLocalPluginHostLoader["load"]>[0]) { loads += 1; await Promise.resolve(); return loader.load(input); } }));
    const host = new CustomerLocalPluginHost(configured.manifest, { statePath: await statePath("healthy"), loaders, now: () => at(0) });
    try {
      const first = configured.manifest.entries[0]!;
      const reports = await Promise.all(Array.from({ length: 8 }, () => host.load(first.bundleId)));
      expect(loads).toBe(1);
      expect(reports.every((report) => report.usableForCf029 && report.state === "conformant")).toBe(true);
      const second = await host.load(configured.manifest.entries[1]!.bundleId);
      expect(second).toMatchObject({ state: "conformant", usableForCf029: true, executionAuthorityEffect: "none", activationEffect: "none" });
      expect(host.resolveCf029Inputs(first.bundleId).qualificationRuntime.actionProfile.role).toBe("action");
      expect(host.doctor(first.bundleId).controls.map((item) => item.checkId)).toEqual(expect.arrayContaining(["manifest.allowlisted", "restart.fresh-conformance", "credentials.posture", "transports.posture", "redaction.scan"]));
    } finally { host.close(); }
  });

  it("requires fresh conformance after restart and recovers only by reloading the exact pinned plugin", async () => {
    const state = await statePath("restart"), configured = createReferencePluginHostManifest(tenantId), entry = configured.manifest.entries[0]!;
    let host = new CustomerLocalPluginHost(configured.manifest, { statePath: state, loaders: configured.loaders, now: () => at(0) });
    expect((await host.load(entry.bundleId)).usableForCf029).toBe(true);
    host.close();
    host = new CustomerLocalPluginHost(configured.manifest, { statePath: state, loaders: configured.loaders, now: () => at(60_000) });
    expect(host.doctor(entry.bundleId)).toMatchObject({ state: "reload-required", usableForCf029: false });
    expect(() => host.resolveCf029Inputs(entry.bundleId)).toThrow(/blocked/i);
    expect((await host.load(entry.bundleId)).usableForCf029).toBe(true);
    host.close();
  });

  it("turns an interrupted persisted loading state into quarantine on restart", async () => {
    const state = await statePath("interrupted"), configured = createReferencePluginHostManifest(tenantId), entry = configured.manifest.entries[0]!;
    let host = new CustomerLocalPluginHost(configured.manifest, { statePath: state, loaders: configured.loaders, now: () => at(0) });
    host.close();
    const database = new DatabaseSync(state);
    database.prepare("UPDATE customer_local_plugin_bundles SET state = 'loading' WHERE tenant_id = ? AND bundle_id = ?").run(tenantId, entry.bundleId);
    database.close();
    host = new CustomerLocalPluginHost(configured.manifest, { statePath: state, loaders: configured.loaders, now: () => at(60_000) });
    expect(host.doctor(entry.bundleId)).toMatchObject({ state: "quarantined", usableForCf029: false });
    host.close();
  });

  it("quarantines source/code/config drift, missing plugins and loader crashes", async () => {
    const configured = createReferencePluginHostManifest(tenantId), entry = configured.manifest.entries[0]!;
    const missing = new CustomerLocalPluginHost(configured.manifest, { statePath: await statePath("missing"), loaders: [], now: () => at(0) });
    expect(await missing.load(entry.bundleId)).toMatchObject({ state: "quarantined", usableForCf029: false }); missing.close();

    const crashLoader: CustomerLocalPluginHostLoader = { loaderKey: entry.loaderKey, load: () => { throw new Error("loader crash CF_CANARY_ACTION_must_not_persist"); } };
    const crashed = new CustomerLocalPluginHost(configured.manifest, { statePath: await statePath("crash"), loaders: [crashLoader], now: () => at(0) });
    const crashedReport = await crashed.load(entry.bundleId);
    expect(crashedReport.state).toBe("quarantined");
    expect(JSON.stringify(crashed.evidenceExport())).not.toContain("CF_CANARY_ACTION_must_not_persist"); crashed.close();

    const original = configured.loaders[0]!;
    const driftLoader: CustomerLocalPluginHostLoader = { loaderKey: entry.loaderKey, async load(input) { const loaded = await original.load(input); loaded.bundle.action.profile.serverUrl = "https://changed.invalid"; return loaded; } };
    const drifted = new CustomerLocalPluginHost(configured.manifest, { statePath: await statePath("drift"), loaders: [driftLoader], now: () => at(0) });
    expect(await drifted.load(entry.bundleId)).toMatchObject({ state: "quarantined", usableForCf029: false }); drifted.close();
  });

  it("quarantines rotation, revocation, expiry, transport failure and doctor crashes after load", async () => {
    for (const fault of ["rotate", "revoke", "expire", "transport", "doctor-crash"] as const) {
      const configured = createReferencePluginHostManifest(tenantId), entry = configured.manifest.entries[0]!;
      let currentNow = at(0);
      let captured: Awaited<ReturnType<CustomerLocalPluginHostLoader["load"]>> | undefined;
      const original = configured.loaders[0]!;
      const loader: CustomerLocalPluginHostLoader = { loaderKey: entry.loaderKey, async load(input) { captured = await original.load(input); return captured; } };
      const host = new CustomerLocalPluginHost(configured.manifest, { statePath: await statePath(fault), loaders: [loader], now: () => currentNow });
      expect((await host.load(entry.bundleId, 60_000)).usableForCf029).toBe(true);
      if (fault === "rotate") captured!.harness.rotate(entry.actionAlias);
      if (fault === "revoke") captured!.harness.revoke(entry.observerAlias);
      if (fault === "expire") currentNow = at(120_000);
      if (fault === "transport") captured!.harness.setTransportState("observer", "unavailable");
      if (fault === "doctor-crash") captured!.bundle.credentials.inspect = () => { throw new Error("doctor crash CF_CANARY_OBSERVER_hidden"); };
      const report = host.doctor(entry.bundleId);
      expect(report.state).toBe("quarantined");
      expect(report.usableForCf029).toBe(false);
      expect(() => host.resolveCf029Inputs(entry.bundleId)).toThrow();
      expect(JSON.stringify(host.evidenceExport())).not.toMatch(/CF_CANARY_(?:ACTION|OBSERVER)/);
      host.close();
    }
  });

  it("quarantines observer/action sharing even when the changed bundle is repinned", async () => {
    const configured = createReferencePluginHostManifest(tenantId), entry = configured.manifest.entries[0]!;
    let manifest = structuredClone(configured.manifest);
    const loader: CustomerLocalPluginHostLoader = { loaderKey: entry.loaderKey, load(input) { const loaded = createReferenceCustomerLocalPluginFixture("map-direct", input); loaded.bundle.observer.transport.implementationDigest = loaded.bundle.action.transport.implementationDigest; loaded.bundle.observer.profile.implementationDigest = loaded.bundle.action.profile.implementationDigest; return loaded; } };
    const preview = await loader.load({ qualifiedAt: at(0), expiresAt: at(3_600_000) });
    manifest.entries[0]!.observerTransportDigest = preview.bundle.observer.transport.implementationDigest;
    const { reviewedAt: _r, expiresAt: _e, ...pinnedProfile } = preview.bundle.observer.profile;
    manifest.entries[0]!.observerProfileDigest = customerLocalPluginHostDigest(pinnedProfile);
    manifest = remanifest(manifest);
    const host = new CustomerLocalPluginHost(manifest, { statePath: await statePath("sharing"), loaders: [loader], now: () => at(0) });
    expect(await host.load(entry.bundleId)).toMatchObject({ state: "quarantined", usableForCf029: false }); host.close();
  });

  it("exports/imports only redacted tenant-bound integrity evidence and never authorizes imported state", async () => {
    const configured = createReferencePluginHostManifest(tenantId), state = await statePath("export"), entry = configured.manifest.entries[0]!;
    const source = new CustomerLocalPluginHost(configured.manifest, { statePath: state, loaders: configured.loaders, now: () => at(0) });
    await source.load(entry.bundleId);
    const evidence = source.evidenceExport(); source.close();
    expect(evidence).toMatchObject({ tenantId, executionAuthorityEffect: "none", activationEffect: "none" });
    expect(JSON.stringify(evidence)).not.toContain("CF_CANARY");

    const target = new CustomerLocalPluginHost(configured.manifest, { statePath: await statePath("import"), loaders: configured.loaders, now: () => "2026-08-14T02:05:00.000Z" });
    target.evidenceImport(evidence);
    expect(target.doctor(entry.bundleId).usableForCf029).toBe(false);
    const tampered = structuredClone(evidence); tampered.tenantId = "other-tenant";
    expect(() => target.evidenceImport(tampered)).toThrow();
    target.close();

    const bytes = await readFile(state);
    expect(bytes.toString("utf8")).not.toContain("CF_CANARY");
  });

  it("exposes authenticated load/doctor/export/import routes without an activation route", async () => {
    const configured = createReferencePluginHostManifest(tenantId), entry = configured.manifest.entries[0]!;
    const host = new CustomerLocalPluginHost(configured.manifest, { statePath: await statePath("sidecar"), loaders: configured.loaders, now: () => at(0) });
    const app = createCustomerLocalPluginHostSidecar({ host, accessToken: token });
    try {
      const url = `/v1/plugins/${encodeURIComponent(entry.bundleId)}`;
      expect((await app.inject({ method: "POST", url: `${url}/load`, headers: { "x-capability-sidecar-token": "wrong-token-value" } })).statusCode).toBe(401);
      const loaded = await app.inject({ method: "POST", url: `${url}/load`, headers: { "x-capability-sidecar-token": token } });
      expect(loaded.statusCode).toBe(200); expect(loaded.json()).toMatchObject({ usableForCf029: true, activationEffect: "none" });
      expect((await app.inject({ method: "GET", url: `${url}/doctor`, headers: { "x-capability-sidecar-token": token } })).json().state).toBe("conformant");
      const exported = await app.inject({ method: "GET", url: "/v1/evidence/export", headers: { "x-capability-sidecar-token": token } });
      expect(exported.statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/v1/evidence/import", headers: { "x-capability-sidecar-token": token }, payload: exported.json() })).statusCode).toBe(202);
      expect((await app.inject({ method: "POST", url: `${url}/activate`, headers: { "x-capability-sidecar-token": token } })).statusCode).toBe(404);
    } finally { await app.close(); host.close(); }
  });

  it("provides the exact existing onboarding-sidecar runtime resolver only after hosted conformance", async () => {
    const intake = readinessTestStartInput(); intake.sessionId = "hosted-runtime-resolver-session";
    const preparation = readinessTestPreparation(intake), built = readinessTestBindingArtifacts(preparation);
    const action = built.factoryResult.actionBinding!, observer = built.factoryResult.observerBinding!, schemas = bindingQualificationSchemaDigests(built.factoryResult);
    const make = (qualifiedAt: string, expiresAt: string) => createReferenceCustomerLocalPluginFixture("callback-queued", { qualifiedAt, expiresAt, sourcePackageDigest: built.normalization.normalizedMaterialDigest, actionAlias: action.credentialAlias, observerAlias: observer.credentialAlias, action: { driverId: action.driverId, sourceId: "northstar-write-api", serverUrl: action.serverUrl, path: action.operation.pathTemplate, method: action.operation.method, requestSchemaDigest: schemas.actionRequest, responseSchemaDigest: schemas.actionResponse, sourceDigest: built.normalization.normalizedMaterialDigest }, observer: { driverId: observer.driverId, sourceId: observer.sourceId, serverUrl: observer.serverUrl, path: observer.operation.pathTemplate, method: observer.operation.method, requestSchemaDigest: schemas.observerRequest, responseSchemaDigest: schemas.observerResponse, sourceDigest: built.normalization.normalizedMaterialDigest } });
    const sample = make(at(0), at(3_600_000)), loaderKey = "hosted:northstar:callback:v1";
    const pin = (profile: typeof sample.bundle.action.profile) => { const { reviewedAt: _r, expiresAt: _e, ...value } = profile; return customerLocalPluginHostDigest(value); };
    const entry = { schemaVersion: "1.0" as const, bundleId: sample.bundle.bundleId, loaderKey, sourcePackageDigest: sample.bundle.sourcePackageDigest, providerDigest: sample.bundle.credentials.providerDigest, resolverImplementationDigest: sample.bundle.credentials.resolverImplementationDigest, actionTransportDigest: sample.bundle.action.transport.implementationDigest, observerTransportDigest: sample.bundle.observer.transport.implementationDigest, actionProfileDigest: pin(sample.bundle.action.profile), observerProfileDigest: pin(sample.bundle.observer.profile), actionAlias: sample.actionAlias, observerAlias: sample.observerAlias, actionScope: sample.actionScope, observerScope: sample.observerScope };
    const payload = { schemaVersion: "1.0" as const, tenantId, entries: [entry] };
    const manifest = { ...payload, manifestDigest: customerLocalPluginHostDigest(payload) };
    const loader: CustomerLocalPluginHostLoader = { loaderKey, load: ({ qualifiedAt, expiresAt }) => make(qualifiedAt, expiresAt) };
    const host = new CustomerLocalPluginHost(manifest, { statePath: await statePath("resolver"), loaders: [loader], now: () => at(0) });
    try {
      expect((await host.load(entry.bundleId)).usableForCf029).toBe(true);
      const resolver = hostedOnboardingCompilationRuntimeResolver(host, () => entry.bundleId, { primitiveRegistryDigest: built.runtime.primitiveRegistryDigest, verifierRegistryDigest: built.runtime.verifierRegistryDigest });
      const runtime = resolver.resolve({ tenantId, sessionId: intake.sessionId, preparation, factoryResult: built.factoryResult });
      expect(runtime).toMatchObject({ primitiveRegistryDigest: built.runtime.primitiveRegistryDigest, verifierRegistryDigest: built.runtime.verifierRegistryDigest });
      expect(runtime?.qualificationRuntime?.credentialInspector.inspect(action.credentialAlias)?.scopes).toEqual([`${action.operation.method} ${action.operation.pathTemplate}`]);
    } finally { host.close(); }
  });
});
