import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveOnboardingCleanPackage,
  derivedOpenApiDigestForCleanPackage,
  onboardingCleanPackageSchema,
  type OnboardingCleanPackage,
} from "../src/product/onboarding-clean-package.js";
import { DeclarativeHttpAcceptanceWorld } from "../src/product/declarative-http-acceptance-world.js";
import { JsonFileGenericAcceptanceCampaignStore } from "../src/product/generic-acceptance-executor.js";
import { createOnboardingProductizationSidecar, type OnboardingProductizationSidecarOptions } from "../src/product/onboarding-productization-sidecar.js";

const token = "clean-package-contract-token";
const tenantId = "clean-package-tenant";
const now = "2026-08-14T12:00:00.000Z";
const qualifiedAt = "2026-08-14T11:00:00.000Z";
const expiresAt = "2026-09-13T11:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function auth() {
  return { "x-capability-sidecar-token": token };
}

async function fixture(): Promise<OnboardingCleanPackage> {
  const source = await readFile(new URL("./fixtures/onboarding-clean-packages/aurora-calibration.json", import.meta.url), "utf8");
  return onboardingCleanPackageSchema.parse(JSON.parse(source));
}

function worldFor(pkg: OnboardingCleanPackage): DeclarativeHttpAcceptanceWorld {
  return new DeclarativeHttpAcceptanceWorld({
    fixtureId: pkg.packageId,
    tenantId: pkg.tenantId,
    sessionId: pkg.sessionId,
    serverUrl: pkg.serverUrl,
    actionDriverId: pkg.action.driverId,
    actionSourceId: pkg.action.sourceId,
    observerDriverId: pkg.observer.driverId,
    observerSourceId: pkg.observer.sourceId,
    actionCredentialAlias: pkg.action.credentialAlias,
    observerCredentialAlias: pkg.observer.credentialAlias,
    stableInputKey: pkg.stableInputKey,
    conflictInputKey: pkg.conflictInputKey,
    workflowInput: pkg.workflowInput,
    alternativeConflictValue: pkg.alternativeConflictValue,
    qualifiedAt,
    expiresAt,
    now,
    sourceDigest: pkg.approvedDocument.sourceOpenApiSha256,
  });
}

async function setup(pkg: OnboardingCleanPackage) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cf-package-contract-"));
  temporaryDirectories.push(root);
  const world = worldFor(pkg);
  const options: OnboardingProductizationSidecarOptions = {
    accessToken: token,
    tenantId,
    statePath: path.join(root, "onboarding.sqlite"),
    acceptanceStore: new JsonFileGenericAcceptanceCampaignStore(path.join(root, "acceptance")),
    compilationRuntimes: { resolve: ({ factoryResult }) => world.runtime(factoryResult) },
    now: () => now,
  };
  return { options, app: createOnboardingProductizationSidecar(options) };
}

function confirmation(preview: any) {
  return {
    schemaVersion: "1.0",
    packageDigest: preview.packageDigest,
    decisionDigest: preview.decisionDigest,
    confirmation: "CONFIRM ALL 21 CONSEQUENTIAL DECISIONS",
    confirmedByAlias: "fixtureAuthor",
    confirmedAt: qualifiedAt,
    qualifiedAt,
    expiresAt,
  };
}

describe("onboarding clean-package v1", () => {
  it("derives an exact non-authorizing 21-decision preview with approved-document provenance", async () => {
    const pkg = await fixture();
    const result = deriveOnboardingCleanPackage(pkg);
    expect(result).toMatchObject({
      state: "preview-only",
      executionAuthorityEffect: "none",
      activationEffect: "none",
      metrics: { consequentialDecisions: 21, customerSpecificExecutableCodeLines: 0 },
    });
    expect(result.decisions.map((decision) => decision.index)).toEqual(Array.from({ length: 21 }, (_value, index) => index + 1));
    expect(result.artifactDigests.approvedOpenApi).toBe(pkg.approvedDocument.derivedOpenApiSha256);
    expect(result.intake.adapter.materials[0]).toMatchObject({ approved: true, localReference: pkg.approvedDocument.localReference });
    expect(result.bindingPreview).toMatchObject({ status: "review-required", executable: false, qualified: false, activated: false });
  });

  it("fails closed on ambiguity, unsupported shape, unsafe server identity, and provenance drift", async () => {
    const pkg = await fixture();
    const fourFields = structuredClone(pkg) as any;
    fourFields.workflowInput.unreviewed = "extra";
    expect(() => deriveOnboardingCleanPackage(fourFields)).toThrow(/exactly three bounded workflow fields/i);

    const sameCredential = structuredClone(pkg);
    sameCredential.observer.credentialAlias = sameCredential.action.credentialAlias;
    expect(() => deriveOnboardingCleanPackage(sameCredential)).toThrow(/separately scoped/i);

    const missingStableKey = structuredClone(pkg);
    missingStableKey.stableInputKey = "missing_key";
    expect(() => deriveOnboardingCleanPackage(missingStableKey)).toThrow(/must exist/i);

    const unsafeServer = structuredClone(pkg);
    unsafeServer.serverUrl = "https://user:password@aurora-calibration.local.invalid/v1?scope=all";
    unsafeServer.approvedDocument.derivedOpenApiSha256 = derivedOpenApiDigestForCleanPackage(unsafeServer);
    expect(() => deriveOnboardingCleanPackage(unsafeServer)).toThrow(/cannot embed credentials/i);

    const provenanceDrift = structuredClone(pkg);
    provenanceDrift.approvedDocument.derivedOpenApiSha256 = "f".repeat(64);
    expect(() => deriveOnboardingCleanPackage(provenanceDrift)).toThrow(/provenance digest/i);

    const unsupportedMode = { ...structuredClone(pkg), capabilityMode: "arbitrary-code" };
    expect(() => deriveOnboardingCleanPackage(unsupportedMode)).toThrow();

    const unsupportedVersion = { ...structuredClone(pkg), schemaVersion: "2.0" };
    expect(() => deriveOnboardingCleanPackage(unsupportedVersion)).toThrow();

    const oversizedSummary = structuredClone(pkg);
    oversizedSummary.summary = "x".repeat(2_001);
    expect(() => deriveOnboardingCleanPackage(oversizedSummary)).toThrow();
  });

  it("redacts secret-shaped imports and persists nothing when exact confirmation is absent", async () => {
    const pkg = await fixture();
    const setupState = await setup(pkg);
    const app = setupState.app;
    const malicious = structuredClone(pkg);
    malicious.summary = "Use api_key=supersecretvalue123 for this request";
    const maliciousResponse = await app.inject({ method: "POST", url: "/v1/onboarding/packages/preview", headers: auth(), payload: malicious });
    expect(maliciousResponse.statusCode).toBe(400);
    expect(maliciousResponse.body).toContain("secret-shaped value");
    expect(maliciousResponse.body).not.toContain("supersecretvalue123");

    const preview = (await app.inject({ method: "POST", url: "/v1/onboarding/packages/preview", headers: auth(), payload: pkg })).json();
    const rejected = await app.inject({
      method: "POST",
      url: "/v1/onboarding/packages/import",
      headers: auth(),
      payload: { package: pkg, confirmation: { ...confirmation(preview), decisionDigest: "a".repeat(64) } },
    });
    expect(rejected.statusCode).toBe(400);
    const absent = await app.inject({ method: "GET", url: `/v1/onboarding/sessions/${pkg.sessionId}`, headers: auth() });
    expect(absent.statusCode).toBe(400);
    await app.close();
  });

  it("makes identical import idempotent, rejects a changed package, and exports the bound package after restart", async () => {
    const pkg = await fixture();
    const setupState = await setup(pkg);
    let app = setupState.app;
    const preview = (await app.inject({ method: "POST", url: "/v1/onboarding/packages/preview", headers: auth(), payload: pkg })).json();
    const payload = { package: pkg, confirmation: confirmation(preview) };
    const first = await app.inject({ method: "POST", url: "/v1/onboarding/packages/import", headers: auth(), payload });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ importState: "confirmed-compiled-acceptance-only", executionAuthorityEffect: "none", activationEffect: "none" });
    const replay = await app.inject({ method: "POST", url: "/v1/onboarding/packages/import", headers: auth(), payload });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().bindings.pairDigest).toBe(first.json().bindings.pairDigest);

    const changed = structuredClone(pkg);
    changed.requiredOutcome = `${changed.requiredOutcome} No unrelated queue state changes.`;
    const changedPreview = (await app.inject({ method: "POST", url: "/v1/onboarding/packages/preview", headers: auth(), payload: changed })).json();
    const conflict = await app.inject({ method: "POST", url: "/v1/onboarding/packages/import", headers: auth(), payload: { package: changed, confirmation: confirmation(changedPreview) } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toMatch(/conflict/i);

    await app.close();
    app = createOnboardingProductizationSidecar(setupState.options);
    const exported = await app.inject({ method: "GET", url: `/v1/onboarding/packages/${pkg.sessionId}`, headers: auth() });
    expect(exported.statusCode).toBe(200);
    expect(exported.json()).toMatchObject({
      schemaVersion: "1.0",
      package: pkg,
      importState: "confirmed-compiled-acceptance-only",
      executionAuthorityEffect: "none",
      activationEffect: "none",
    });
    expect(Object.values(exported.json().recordedArtifactDigests)).toHaveLength(5);
    expect(Object.values(exported.json().recordedArtifactDigests).every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value as string))).toBe(true);
    await app.close();
  });

  it("requires authentication and rejects cross-tenant package use", async () => {
    const pkg = await fixture();
    const setupState = await setup(pkg);
    const app = setupState.app;
    expect((await app.inject({ method: "POST", url: "/v1/onboarding/packages/preview", payload: pkg })).statusCode).toBe(401);
    const otherTenant = structuredClone(pkg);
    otherTenant.tenantId = "other-tenant";
    const response = await app.inject({ method: "POST", url: "/v1/onboarding/packages/preview", headers: auth(), payload: otherTenant });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/another tenant/i);
    await app.close();
  });
});
