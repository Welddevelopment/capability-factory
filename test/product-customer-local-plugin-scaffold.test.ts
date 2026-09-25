import { generateKeyPairSync } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCustomerLocalPluginConformance } from "../src/product/customer-local-plugin-conformance.js";
import { CustomerLocalPluginHost, createReferencePluginHostManifest } from "../src/product/customer-local-plugin-host.js";
import { createReferenceCustomerLocalPluginFixture, type ReferencePluginShape } from "../src/product/customer-local-reference-plugins.js";
import {
  buildCustomerLocalPlugin,
  createPluginReleaseManifest,
  pluginScaffoldDigest,
  proposePluginHostInstall,
  scaffoldCustomerLocalPlugin,
  signPluginRelease,
  verifyPluginReleaseSignature,
  type PluginScaffoldMetadata,
} from "../src/product/customer-local-plugin-scaffold.js";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));
// Real-clock anchor: secret-lease expiry is enforced against real time, so
// fixed historical dates lapse as wall time passes.
const T0 = Date.now();
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
async function temp(name: string) { const directory = await mkdtemp(path.join(os.tmpdir(), `cf-plugin-scaffold-${name}-`)); temporaryDirectories.push(directory); return directory; }
const completedImplementation = `import type { Lease, Metadata, Request, Response } from "./contract.js";\nconst records = new Map<string, unknown>();\nexport function inspect(alias: string): Metadata | null { return { alias, scopes: [], revision: 1, revoked: false, expiresAt: "2099-01-01T00:00:00.000Z" }; }\nexport async function lease(): Promise<Lease> { let used=false; return { take(){ if(used) throw new Error("lease consumed"); used=true; return "process-local-fixture-value"; }, release(){ used=true; } }; }\nexport async function action(request: Request, handle: Lease): Promise<Response> { handle.take(); records.set(request.scope, request.body); return { status: 201, body: { accepted: true } }; }\nexport async function observe(request: Request, handle: Lease): Promise<Response> { handle.take(); return { status: 200, body: records.get(request.scope) ?? null }; }\nexport function probeAction(){ return { reachable:true }; }\nexport function probeObserver(){ return { reachable:true }; }\nexport function reconcileLostResponse(){ return { reconcileBeforeRetry:true, blindRetryAllowed:false }; }\n`;

function setup(shape: ReferencePluginShape, pluginId: string) {
  const fixture = createReferenceCustomerLocalPluginFixture(shape, { qualifiedAt: at(0), expiresAt: at(7_200_000) });
  const metadata: PluginScaffoldMetadata = { schemaVersion: "1.0", pluginId, providerClass: shape === "map-direct" ? "map-backed-local" : "callback-local", actionAlias: fixture.actionAlias, observerAlias: fixture.observerAlias, actionProfile: fixture.bundle.action.profile, observerProfile: fixture.bundle.observer.profile };
  return { fixture, metadata };
}

describe("customer-local plugin scaffold and signed release workflow", () => {
  it("generates a safe failing self-contained project mapped to all 21 controls", async () => {
    const root = await temp("safe"), { metadata } = setup("map-direct", "aurora-local-plugin");
    const result = scaffoldCustomerLocalPlugin(root, metadata);
    expect(result.files).toHaveLength(8); expect(result.generatedLines).toBeGreaterThan(50); expect(result.decisionCount).toBe(7);
    const plugin = await readFile(path.join(result.projectPath, "src/plugin.ts"), "utf8");
    expect(plugin).toContain("not implemented; scaffold remains quarantined");
    expect(plugin).not.toMatch(/credential.*value\s*[:=]/i);
    const mapping = JSON.parse(await readFile(path.join(result.projectPath, "test/conformance-map.json"), "utf8"));
    expect(mapping.controls).toHaveLength(21); expect(mapping.controls.every((item: any) => item.state === "declared-not-run")).toBe(true);
    expect(buildCustomerLocalPlugin(result.projectPath).diagnostics).toBe(0);
  });

  it("rejects path/template injection, shared boundaries and secret-shaped metadata", async () => {
    const root = await temp("injection"), base = setup("map-direct", "valid-plugin").metadata;
    for (const pluginId of ["../escape", "/absolute", "x;postinstall", "${injection}"]) expect(() => scaffoldCustomerLocalPlugin(root, { ...base, pluginId })).toThrow();
    expect(() => scaffoldCustomerLocalPlugin(root, { ...base, actionAlias: base.observerAlias })).toThrow(/distinct/i);
    expect(() => scaffoldCustomerLocalPlugin(root, { ...base, actionProfile: { ...base.actionProfile, serverUrl: "https://safe.invalid?token=CF_CANARY_ESCAPE" } })).toThrow(/credential|secret/i);
    expect(() => scaffoldCustomerLocalPlugin(root, { ...base, observerProfile: { ...base.observerProfile, implementationDigest: base.actionProfile.implementationDigest } })).toThrow(/shared/i);
  });

  it.each([["map-direct", "aurora-release-plugin"], ["callback-queued", "mistral-release-plugin"]] as Array<[ReferencePluginShape,string]>)("builds, signs, releases, proposes and restart-loads %s", async (shape, pluginId) => {
    const root = await temp(pluginId), { fixture, metadata } = setup(shape, pluginId), scaffold = scaffoldCustomerLocalPlugin(root, metadata);
    await writeFile(path.join(scaffold.projectPath, "src/plugin.ts"), completedImplementation, { mode: 0o600 });
    const release = createPluginReleaseManifest({ projectPath: scaffold.projectPath, metadata, releaseVersion: "1.0.0", sourcePackageDigest: fixture.bundle.sourcePackageDigest, providerDigest: fixture.bundle.credentials.providerDigest, resolverImplementationDigest: fixture.bundle.credentials.resolverImplementationDigest, actionTransportDigest: fixture.bundle.action.transport.implementationDigest, observerTransportDigest: fixture.bundle.observer.transport.implementationDigest, createdAt: at(0), expiresAt: at(86_400_000) });
    expect(buildCustomerLocalPlugin(scaffold.projectPath).buildDigest).toBe(release.buildDigest);
    const keys = generateKeyPairSync("ed25519"), signature = signPluginRelease(release, keys.privateKey, "fixture-signer-v1");
    expect(() => verifyPluginReleaseSignature(release, signature, keys.publicKey, "fixture-signer-v1")).not.toThrow();
    const conformance = await runCustomerLocalPluginConformance({ ...fixture, qualifiedAt: at(0), expiresAt: at(7_200_000) });
    const configured = createReferencePluginHostManifest("release-tenant"), entry = configured.manifest.entries.find((item) => item.bundleId === fixture.bundle.bundleId)!;
    let host = new CustomerLocalPluginHost(configured.manifest, { statePath: path.join(root, "host.sqlite"), loaders: configured.loaders, now: () => at(0) });
    const doctor = await host.load(entry.bundleId); expect(doctor.usableForCf029).toBe(true);
    const proposal = proposePluginHostInstall({ tenantId: "release-tenant", loaderKey: entry.loaderKey, projectPath: scaffold.projectPath, metadata, manifest: release, conformance, doctor, reviewPhrase: `INSTALL ${pluginId} 1.0.0 FOR release-tenant`, signaturePolicy: { required: true, signerKeyId: "fixture-signer-v1", publicKey: keys.publicKey }, signature, now: at(0) });
    expect(proposal).toMatchObject({ state: "reviewed-install-proposal", executionAuthorityEffect: "none", activationEffect: "none" });
    host.close();
    host = new CustomerLocalPluginHost(configured.manifest, { statePath: path.join(root, "host.sqlite"), loaders: configured.loaders, now: () => at(60_000) });
    expect(host.doctor(entry.bundleId).usableForCf029).toBe(false); expect((await host.load(entry.bundleId)).usableForCf029).toBe(true); host.close();
    console.log(`CF035_METRICS=${JSON.stringify({ shape, pluginId, generatedFiles: scaffold.files.length, generatedLines: scaffold.generatedLines, explicitDecisions: scaffold.decisionCount, manuallyImplementedFiles: 1, manuallyImplementedLines: completedImplementation.split("\n").length - 1, workflowCommandsOrCalls: 9, conformanceControls: conformance.passedChecks, restartReloadPassed: true })}`);
  });

  it("rejects tampering, unsigned/wrong signer, stale/cross-tenant reuse, source drift, script abuse and install conflicts", async () => {
    const root = await temp("attacks"), { fixture, metadata } = setup("map-direct", "attack-plugin"), scaffold = scaffoldCustomerLocalPlugin(root, metadata);
    await writeFile(path.join(scaffold.projectPath, "src/plugin.ts"), completedImplementation, { mode: 0o600 });
    const release = createPluginReleaseManifest({ projectPath: scaffold.projectPath, metadata, releaseVersion: "1.0.0", sourcePackageDigest: fixture.bundle.sourcePackageDigest, providerDigest: fixture.bundle.credentials.providerDigest, resolverImplementationDigest: fixture.bundle.credentials.resolverImplementationDigest, actionTransportDigest: fixture.bundle.action.transport.implementationDigest, observerTransportDigest: fixture.bundle.observer.transport.implementationDigest, createdAt: at(0), expiresAt: at(86_400_000) });
    const keys = generateKeyPairSync("ed25519"), wrong = generateKeyPairSync("ed25519"), signature = signPluginRelease(release, keys.privateKey, "trusted-signer");
    expect(() => verifyPluginReleaseSignature(release, signature, wrong.publicKey, "trusted-signer")).toThrow();
    expect(() => verifyPluginReleaseSignature({ ...release, buildDigest: pluginScaffoldDigest("tampered") }, signature, keys.publicKey, "trusted-signer")).toThrow();
    const conformance = await runCustomerLocalPluginConformance({ ...fixture, qualifiedAt: at(0), expiresAt: at(7_200_000) });
    const configured = createReferencePluginHostManifest("attack-tenant"), entry = configured.manifest.entries[0]!, host = new CustomerLocalPluginHost(configured.manifest, { statePath: path.join(root, "host.sqlite"), loaders: configured.loaders, now: () => at(0) });
    const doctor = await host.load(entry.bundleId), base = { tenantId: "attack-tenant", loaderKey: entry.loaderKey, projectPath: scaffold.projectPath, metadata, manifest: release, conformance, doctor, reviewPhrase: "INSTALL attack-plugin 1.0.0 FOR attack-tenant", signaturePolicy: { required: true, signerKeyId: "trusted-signer", publicKey: keys.publicKey }, now: at(0) } as const;
    expect(() => proposePluginHostInstall(base)).toThrow(/signature/i);
    expect(() => proposePluginHostInstall({ ...base, signature, now: at(165_600_000) })).toThrow(/stale/i);
    expect(() => proposePluginHostInstall({ ...base, signature, tenantId: "other-tenant", reviewPhrase: "INSTALL attack-plugin 1.0.0 FOR other-tenant" })).toThrow(/same-tenant/i);
    expect(() => proposePluginHostInstall({ ...base, signature, existingEntries: [entry] })).toThrow(/conflict/i);
    await writeFile(path.join(scaffold.projectPath, "src/plugin.ts"), `${completedImplementation}\n// changed after release\n`, { mode: 0o600 });
    expect(() => proposePluginHostInstall({ ...base, signature })).toThrow(/changed/i);
    const pkgPath = path.join(scaffold.projectPath, "package.json"), pkg = JSON.parse(await readFile(pkgPath, "utf8")); pkg.scripts = { postinstall: "curl attacker" }; await writeFile(pkgPath, JSON.stringify(pkg), { mode: 0o600 });
    expect(() => buildCustomerLocalPlugin(scaffold.projectPath)).toThrow(/scripts/i);
    host.close();
  });
});
