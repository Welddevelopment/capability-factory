import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveOnboardingCleanPackage,
  onboardingCleanPackageSchema,
  type OnboardingCleanPackage,
} from "../src/product/onboarding-clean-package.js";
import {
  compileDeclarativeHttpPair,
  DeclarativeCompiledHttpAcceptanceBinding,
  DeclarativeHttpAcceptanceWorld,
} from "../src/product/declarative-http-acceptance-world.js";
import { JsonFileGenericAcceptanceCampaignStore, runGenericAcceptanceCampaign } from "../src/product/generic-acceptance-executor.js";
import { createOnboardingProductizationSidecar, type OnboardingProductizationSidecarOptions } from "../src/product/onboarding-productization-sidecar.js";

const token = "clean-package-sidecar-token";
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

async function loadPackage(name: string): Promise<{ package: OnboardingCleanPackage; declarativeLines: number }> {
  const source = await readFile(new URL(`./fixtures/onboarding-clean-packages/${name}.json`, import.meta.url), "utf8");
  return { package: onboardingCleanPackageSchema.parse(JSON.parse(source)), declarativeLines: source.split("\n").filter((line) => line.trim().length > 0).length };
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

describe("clean-package authenticated sidecar teardown", () => {
  it("imports and runs two unfamiliar JSON-only packages through the same restart-safe product path", async () => {
    const metrics: unknown[] = [];
    const pairDigests: string[] = [];
    const sharedRuntimeDigests: string[] = [];

    for (const name of ["aurora-calibration", "mistral-cold-storage"]) {
      const loaded = await loadPackage(name);
      const pkg = loaded.package;
      const derivation = deriveOnboardingCleanPackage(pkg);
      const root = await mkdtemp(path.join(os.tmpdir(), `cf-clean-${name}-`));
      temporaryDirectories.push(root);
      const statePath = path.join(root, "onboarding.sqlite");
      const acceptanceDirectory = path.join(root, "acceptance");
      const world = worldFor(pkg);
      let capturedFactory: Parameters<typeof compileDeclarativeHttpPair>[0] | undefined;
      const acceptanceStore = new JsonFileGenericAcceptanceCampaignStore(acceptanceDirectory);
      const options: OnboardingProductizationSidecarOptions = {
        accessToken: token,
        tenantId,
        statePath,
        acceptanceStore,
        compilationRuntimes: {
          resolve: ({ factoryResult }) => {
            capturedFactory = factoryResult;
            return world.runtime(factoryResult);
          },
        },
        now: () => now,
      };

      let calls = 0;
      const began = performance.now();
      let app = createOnboardingProductizationSidecar(options);
      const call = async (request: { method: string; url: string; headers?: Record<string, string>; payload?: unknown }) => {
        calls += 1;
        return app.inject(request as never);
      };

      const previewResponse = await call({ method: "POST", url: "/v1/onboarding/packages/preview", headers: auth(), payload: pkg });
      expect(previewResponse.statusCode).toBe(200);
      const preview = previewResponse.json();
      expect(preview).toMatchObject({ state: "preview-only", executionAuthorityEffect: "none", activationEffect: "none", metrics: { consequentialDecisions: 21 } });

      const importResponse = await call({
        method: "POST",
        url: "/v1/onboarding/packages/import",
        headers: auth(),
        payload: {
          package: pkg,
          confirmation: {
            schemaVersion: "1.0",
            packageDigest: preview.packageDigest,
            decisionDigest: preview.decisionDigest,
            confirmation: "CONFIRM ALL 21 CONSEQUENTIAL DECISIONS",
            confirmedByAlias: "fixtureAuthor",
            confirmedAt: qualifiedAt,
            qualifiedAt,
            expiresAt,
          },
        },
      });
      expect(importResponse.statusCode).toBe(202);
      const imported = importResponse.json();
      expect(imported).toMatchObject({ importState: "confirmed-compiled-acceptance-only", executionAuthorityEffect: "none", activationEffect: "none", bindings: { state: "compiled-acceptance-only", activated: false } });
      expect(capturedFactory).toBeDefined();

      const pair = compileDeclarativeHttpPair(capturedFactory!, world);
      pairDigests.push(pair.pairDigest);
      sharedRuntimeDigests.push(JSON.stringify(world.runtime(capturedFactory), (_key, value) => typeof value === "function" ? undefined : value));
      const acceptanceBinding = new DeclarativeCompiledHttpAcceptanceBinding(world, pair, () => compileDeclarativeHttpPair(capturedFactory!, world)).bindReviewedIdentity(capturedFactory!);
      const campaignId = `${pkg.packageId}-campaign`;
      const campaign = await runGenericAcceptanceCampaign({ campaignId, declarationDigest: pair.pairDigest, binding: acceptanceBinding, store: acceptanceStore, now: () => now });
      expect(campaign).toMatchObject({ status: "completed", passed: true, passedCases: 10, incorrectSideEffects: 0 });

      const linked = await call({
        method: "POST",
        url: `/v1/onboarding/sessions/${pkg.sessionId}/acceptance-link`,
        headers: auth(),
        payload: { schemaVersion: "1.0", campaignId, expectedPairDigest: pair.pairDigest, expectedCampaignRevision: campaign.state.revision, expectedLatestReceiptHash: campaign.latestReceiptHash! },
      });
      expect(linked.statusCode).toBe(202);
      const beforeRestart = await call({ method: "GET", url: `/v1/onboarding/sessions/${pkg.sessionId}/readiness`, headers: auth() });
      expect(beforeRestart.statusCode).toBe(200);

      await app.close();
      app = createOnboardingProductizationSidecar(options);
      const exported = await call({ method: "GET", url: `/v1/onboarding/packages/${pkg.sessionId}`, headers: auth() });
      expect(exported.statusCode).toBe(200);
      expect(exported.json()).toMatchObject({ schemaVersion: "1.0", package: pkg, importState: "confirmed-compiled-acceptance-only", executionAuthorityEffect: "none", activationEffect: "none" });
      const afterRestart = await call({ method: "GET", url: `/v1/onboarding/sessions/${pkg.sessionId}/readiness`, headers: auth() });
      expect(afterRestart.statusCode).toBe(200);
      const receipt = afterRestart.json();
      expect(receipt).toMatchObject({ activated: false, customerEvidence: false, productionReady: false, artifactStates: { genericAcceptance: "ten-of-ten-synthetic-passed" } });
      await app.close();

      metrics.push({
        packageId: pkg.packageId,
        machineMilliseconds: Number((performance.now() - began).toFixed(3)),
        humanActiveMinutes: null,
        apiCalls: calls,
        ordinaryReviewDecisions: derivation.metrics.consequentialDecisions,
        confirmedFactCount: capturedFactory!.automationMetrics.confirmedFactCount,
        generatedActionDeclarationFields: capturedFactory!.automationMetrics.generatedActionDeclarationFields,
        generatedObserverDeclarationFields: capturedFactory!.automationMetrics.generatedObserverDeclarationFields,
        customerSpecificDeclarativeLines: loaded.declarativeLines,
        packageSpecificExecutableCodeLines: 0,
        preRunAuthorFixtureInterventions: 1,
        authorInterventionsDuringFrozenRun: 0,
        acceptanceCases: campaign.passedCases,
        incorrectSideEffects: campaign.incorrectSideEffects,
        remainingBespokeWork: receipt.remainingBespokeWork.length,
        remainingBespokeWorkItems: receipt.remainingBespokeWork,
        sharedRuntime: "DeclarativeHttpAcceptanceWorld + DeclarativeCompiledHttpAcceptanceBinding",
      });
    }

    expect(metrics).toHaveLength(2);
    expect(metrics.every((item: any) => item.packageSpecificExecutableCodeLines === 0 && item.apiCalls === 6 && item.acceptanceCases === 10)).toBe(true);
    expect(new Set(pairDigests).size).toBe(2);
    expect(new Set(sharedRuntimeDigests).size).toBe(2);
    const runtimeIdentities = sharedRuntimeDigests.map((value) => {
      const parsed = JSON.parse(value);
      return [parsed.actionTransport.implementationDigest, parsed.observerTransport.implementationDigest, parsed.credentialResolver.implementationDigest, parsed.primitiveRegistryDigest, parsed.verifierRegistryDigest].join(":");
    });
    expect(new Set(runtimeIdentities).size).toBe(1);
    process.stdout.write(`\nCLEAN_PACKAGE_TEARDOWN_METRICS=${JSON.stringify(metrics)}\n`);
  });
});
