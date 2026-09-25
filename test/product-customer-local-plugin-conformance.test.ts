import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCustomerLocalPluginConformanceReceipt,
  customerLocalPluginDigest,
  provideCf029InputsFromConformantPlugins,
  runCustomerLocalPluginConformance,
} from "../src/product/customer-local-plugin-conformance.js";
import { createReferenceCustomerLocalPluginFixture, type ReferencePluginShape } from "../src/product/customer-local-reference-plugins.js";
import { bindingQualificationSchemaDigests, qualifyCustomerLocalBindings } from "../src/product/customer-local-binding-qualification.js";
import { readinessTestBindingArtifacts, readinessTestPreparation, readinessTestStartInput } from "./product-onboarding-readiness-receipt.test.js";

// Real-clock anchor: secret-lease expiry is enforced against real time, so
// fixed historical dates lapse as wall time passes.
const T0 = Date.now();
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const qualifiedAt = at(0);
const expiresAt = at(2_592_000_000);
const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

async function run(shape: ReferencePluginShape) {
  const fixture = createReferenceCustomerLocalPluginFixture(shape, { qualifiedAt, expiresAt });
  const receipt = await runCustomerLocalPluginConformance({ ...fixture, qualifiedAt, expiresAt });
  return { fixture, receipt };
}

describe("provider-neutral customer-local plugin conformance", () => {
  it.each(["map-direct", "callback-queued"] as ReferencePluginShape[])("passes the %s provider/transport shape with all frozen controls", async (shape) => {
    const { fixture, receipt } = await run(shape);
    expect(receipt).toMatchObject({ state: "passed", failedChecks: 0, executionAuthorityEffect: "none", activationEffect: "none", sourcePackageDigest: fixture.bundle.sourcePackageDigest });
    expect(receipt.passedChecks).toBeGreaterThanOrEqual(20);
    assertCustomerLocalPluginConformanceReceipt(receipt, fixture.bundle, at(3_600_000));
    const serialized = JSON.stringify(receipt);
    for (const canary of fixture.harness.canaryValues()) expect(serialized).not.toContain(canary);
  });

  it("allows only an exact passing receipt to provide CF-029 inputs and keeps resolved values non-enumerable", async () => {
    const { fixture, receipt } = await run("map-direct");
    const inputs = provideCf029InputsFromConformantPlugins({ receipt, bundle: fixture.bundle, now: at(3_600_000) });
    expect(inputs.qualificationRuntime.credentialInspector.inspect(fixture.actionAlias)?.scopes).toEqual([fixture.actionScope]);
    const handle = await inputs.credentialResolver.resolve(fixture.actionAlias);
    expect(handle?.value).toContain("CF_CANARY_ACTION");
    expect(JSON.stringify(handle)).toBe(JSON.stringify({ alias: fixture.actionAlias }));

    const tampered = structuredClone(receipt);
    tampered.sourcePackageDigest = customerLocalPluginDigest("another package");
    expect(() => provideCf029InputsFromConformantPlugins({ receipt: tampered, bundle: fixture.bundle, now: at(3_600_000) })).toThrow(/integrity/i);
    expect(() => provideCf029InputsFromConformantPlugins({ receipt: { ...receipt, state: "failed", failedChecks: 1 }, bundle: fixture.bundle, now: at(3_600_000) })).toThrow();
  });

  it("fails a bundle with inconsistent provider metadata or shared action/observer implementation", async () => {
    const providerFault = createReferenceCustomerLocalPluginFixture("map-direct", { qualifiedAt, expiresAt });
    const originalInspect = providerFault.bundle.credentials.inspect.bind(providerFault.bundle.credentials);
    providerFault.bundle.credentials.inspect = (alias) => { const result = originalInspect(alias); return result ? { ...result, providerDigest: customerLocalPluginDigest("wrong provider") } : null; };
    const providerReceipt = await runCustomerLocalPluginConformance({ ...providerFault, qualifiedAt, expiresAt });
    expect(providerReceipt.state).toBe("failed");
    expect(providerReceipt.checks.find((item) => item.checkId === "credentials.metadata-only")?.passed).toBe(false);

    const shared = createReferenceCustomerLocalPluginFixture("callback-queued", { qualifiedAt, expiresAt });
    shared.bundle.observer.transport.implementationDigest = shared.bundle.action.transport.implementationDigest;
    const sharedReceipt = await runCustomerLocalPluginConformance({ ...shared, qualifiedAt, expiresAt });
    expect(sharedReceipt.state).toBe("failed");
    expect(sharedReceipt.checks.find((item) => item.checkId === "transports.independent")?.passed).toBe(false);
  });

  it("keeps seeded canaries out of JSON, SQLite pages, logs, events and snapshots", async () => {
    const { fixture, receipt } = await run("callback-queued");
    const directory = await mkdtemp(path.join(os.tmpdir(), "cf-plugin-conformance-"));
    temporaryDirectories.push(directory);
    const jsonPath = path.join(directory, "receipt.json");
    const databasePath = path.join(directory, "receipt.sqlite");
    await writeFile(jsonPath, JSON.stringify({ receipt, events: fixture.harness.emissions(), snapshots: fixture.harness.serializedArtifacts() }), { mode: 0o600 });
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE evidence (payload TEXT NOT NULL)");
    database.prepare("INSERT INTO evidence (payload) VALUES (?)").run(JSON.stringify(receipt));
    database.close();
    const bytes = Buffer.concat([await readFile(jsonPath), await readFile(databasePath)]).toString("utf8");
    for (const canary of fixture.harness.canaryValues()) expect(bytes).not.toContain(canary);
  });

  it("rejects expired, source-drifted and implementation-drifted receipts", async () => {
    const { fixture, receipt } = await run("map-direct");
    expect(() => assertCustomerLocalPluginConformanceReceipt(receipt, fixture.bundle, at(4_143_600_000))).toThrow(/expired/i);
    fixture.bundle.action.profile.sourceDigest = customerLocalPluginDigest("drifted");
    expect(() => assertCustomerLocalPluginConformanceReceipt(receipt, fixture.bundle, at(3_600_000))).toThrow(/differs/i);
  });

  it("joins a passing plugin receipt into the exact CF-029 qualification gate", async () => {
    const intake = readinessTestStartInput();
    intake.sessionId = "plugin-conformance-cf029-join";
    const prepared = readinessTestPreparation(intake);
    const built = readinessTestBindingArtifacts(prepared);
    const action = built.factoryResult.actionBinding!, observer = built.factoryResult.observerBinding!;
    const schemas = bindingQualificationSchemaDigests(built.factoryResult);
    const fixture = createReferenceCustomerLocalPluginFixture("callback-queued", {
      qualifiedAt, expiresAt, sourcePackageDigest: built.normalization.normalizedMaterialDigest,
      actionAlias: action.credentialAlias, observerAlias: observer.credentialAlias,
      action: { driverId: action.driverId, sourceId: "northstar-write-api", serverUrl: action.serverUrl, path: action.operation.pathTemplate, method: action.operation.method, requestSchemaDigest: schemas.actionRequest, responseSchemaDigest: schemas.actionResponse, sourceDigest: built.normalization.normalizedMaterialDigest },
      observer: { driverId: observer.driverId, sourceId: observer.sourceId, serverUrl: observer.serverUrl, path: observer.operation.pathTemplate, method: observer.operation.method, requestSchemaDigest: schemas.observerRequest, responseSchemaDigest: schemas.observerResponse, sourceDigest: built.normalization.normalizedMaterialDigest },
    });
    const conformance = await runCustomerLocalPluginConformance({ ...fixture, qualifiedAt, expiresAt });
    expect(conformance.state).toBe("passed");
    const inputs = provideCf029InputsFromConformantPlugins({ receipt: conformance, bundle: fixture.bundle, now: qualifiedAt });
    const qualification = qualifyCustomerLocalBindings({ tenantId: intake.tenantId, sessionId: intake.sessionId, packageDigest: prepared.inputDigest, sourceDigest: built.normalization.normalizedMaterialDigest, factoryResult: built.factoryResult, actionTransport: inputs.actionTransport, observerTransport: inputs.observerTransport, credentialResolver: inputs.credentialResolver, runtime: inputs.qualificationRuntime, qualifiedAt, expiresAt });
    expect(qualification).toMatchObject({ state: "qualified-for-acceptance-compilation", tenantId: intake.tenantId, sessionId: intake.sessionId, executionAuthorityEffect: "none", activationEffect: "none" });
  });
});
