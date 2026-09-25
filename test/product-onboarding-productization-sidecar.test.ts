import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GenericAcceptanceCampaignState, GenericAcceptanceCampaignStore } from "../src/product/generic-acceptance-executor.js";
import {
  createOnboardingProductizationSidecar,
  onboardingAcceptanceBindingId,
  type OnboardingProductizationSidecarOptions,
} from "../src/product/onboarding-productization-sidecar.js";
import {
  readinessTestBindingArtifacts,
  readinessTestCampaign,
  readinessTestFacts,
  readinessTestPreparation,
  readinessTestStartInput,
} from "./product-onboarding-readiness-receipt.test.js";

const token = "customer-local-onboarding-token";
const tenantId = "northstar-tenant";
const now = () => "2026-08-14T12:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class MemoryAcceptanceStore implements GenericAcceptanceCampaignStore {
  constructor(private readonly campaigns = new Map<string, GenericAcceptanceCampaignState>()) {}
  async load(campaignId: string) { return this.campaigns.has(campaignId) ? structuredClone(this.campaigns.get(campaignId)!) : null; }
  async save(state: GenericAcceptanceCampaignState, expectedRevision: number | null) {
    const current = this.campaigns.get(state.campaignId);
    if ((current?.revision ?? null) !== expectedRevision) throw new Error("Campaign revision conflict.");
    this.campaigns.set(state.campaignId, structuredClone(state));
  }
  set(state: GenericAcceptanceCampaignState) { this.campaigns.set(state.campaignId, structuredClone(state)); }
}

function auth() { return { "x-capability-sidecar-token": token }; }

function reviewBody(started: Record<string, any>) {
  return {
    sessionId: started.sessionId,
    expectedInputDigest: started.inputDigest,
    expectedSnapshotDigest: started.snapshotDigest,
    review: {
      adapterProposalDigest: started.reviewArtifacts.adapterProposalDigest,
      verifierContractDigest: started.reviewArtifacts.verifierContractDigest,
      authorityCompilationDigest: started.reviewArtifacts.authorityCompilationDigest,
      authorityRuntimeBindingDigest: "a".repeat(64),
      observationAdapterBindingDigest: "b".repeat(64),
      confirmedByAlias: "fixtureEngineer",
      confirmedAt: "2026-08-14T11:00:00.000Z",
    },
  };
}

describe("customer-local onboarding productization sidecar", () => {
  it("joins the exact journey, survives restart, and rejects unauthorized, cross-tenant, replay-conflict, cross-session and mutation attacks", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cf-onboarding-sidecar-"));
    temporaryDirectories.push(directory);
    const statePath = path.join(directory, "onboarding.sqlite");
    const intake = readinessTestStartInput();
    const offlinePreparation = readinessTestPreparation(intake);
    const built = readinessTestBindingArtifacts(offlinePreparation);
    const acceptanceStore = new MemoryAcceptanceStore();
    const bindingId = onboardingAcceptanceBindingId(tenantId, intake.sessionId, built.pair.pairDigest);
    const campaign = readinessTestCampaign(built.pair.pairDigest, bindingId);
    acceptanceStore.set(campaign);
    const options: OnboardingProductizationSidecarOptions = {
      accessToken: token,
      tenantId,
      statePath,
      acceptanceStore,
      compilationRuntimes: { resolve: () => built.runtime },
      now,
    };

    let app = createOnboardingProductizationSidecar(options);
    const unauthorized = await app.inject({ method: "GET", url: `/v1/onboarding/sessions/${intake.sessionId}`, headers: { "x-capability-sidecar-token": "wrong-customer-local-token" } });
    expect(unauthorized.statusCode).toBe(401);

    const crossTenant = structuredClone(intake);
    crossTenant.tenantId = "other-tenant";
    crossTenant.sessionId = "other-tenant-session";
    expect((await app.inject({ method: "POST", url: "/v1/onboarding/sessions", headers: auth(), payload: crossTenant })).statusCode).toBe(400);

    const startedResponse = await app.inject({ method: "POST", url: "/v1/onboarding/sessions", headers: auth(), payload: intake });
    expect(startedResponse.statusCode).toBe(202);
    const started = startedResponse.json();
    expect(started).toMatchObject({ sessionId: intake.sessionId, tenantId, status: "review-required", activation: "not-activated" });
    expect(started.reviewArtifacts).toMatchObject({ note: expect.stringContaining("not repository-internal") });

    const review = reviewBody(started);
    const reviewed = await app.inject({ method: "POST", url: `/v1/onboarding/sessions/${intake.sessionId}/review`, headers: auth(), payload: review });
    expect(reviewed.statusCode).toBe(202);
    expect(reviewed.json()).toMatchObject({ status: "acceptance-scaffold-ready", activation: "not-activated", acceptance: { declaredCases: 10, executable: false, passed: false } });

    const bindingRequest = { schemaVersion: "1.0", normalization: built.normalization, facts: readinessTestFacts(), qualification: { qualifiedAt: "2026-08-14T11:00:00.000Z", expiresAt: "2026-09-13T11:00:00.000Z" } };
    const bindings = await app.inject({ method: "POST", url: `/v1/onboarding/sessions/${intake.sessionId}/bindings`, headers: auth(), payload: bindingRequest });
    expect(bindings.statusCode).toBe(202);
    expect(bindings.json()).toMatchObject({ state: "compiled-acceptance-only", activated: false, customerValidated: false, pairDigest: built.pair.pairDigest });
    expect(bindings.json().credentialAndTransportQualification).toMatchObject({ state: "qualified-for-acceptance-compilation", executionAuthorityEffect: "none", activationEffect: "none" });
    const qualification = await app.inject({ method: "GET", url: `/v1/onboarding/sessions/${intake.sessionId}/qualification`, headers: auth() });
    expect(qualification.statusCode).toBe(200);
    expect(qualification.json()).toMatchObject({ tenantId, sessionId: intake.sessionId, state: "qualified-for-acceptance-compilation", executionAuthorityEffect: "none", activationEffect: "none" });
    expect(qualification.body).not.toContain("opaque-customer-local-handle");

    const acceptanceLink = { schemaVersion: "1.0", campaignId: campaign.campaignId, expectedPairDigest: built.pair.pairDigest, expectedCampaignRevision: campaign.revision, expectedLatestReceiptHash: campaign.receipts.at(-1)!.receiptHash };
    const linked = await app.inject({ method: "POST", url: `/v1/onboarding/sessions/${intake.sessionId}/acceptance-link`, headers: auth(), payload: acceptanceLink });
    expect(linked.statusCode).toBe(202);
    expect(linked.json()).toMatchObject({ status: "completed", declaredCases: 10, evidenceReceipts: 10, activationEffect: "none" });

    const readiness = await app.inject({ method: "GET", url: `/v1/onboarding/sessions/${intake.sessionId}/readiness`, headers: auth() });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toMatchObject({ state: "synthetic-acceptance-complete-activation-blocked", activated: false, customerEvidence: false, productionReady: false, artifactStates: { activationAuthority: "not-established" } });

    // Exact retries are idempotent, while a same-session semantic change is rejected.
    expect((await app.inject({ method: "POST", url: "/v1/onboarding/sessions", headers: auth(), payload: intake })).statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url: `/v1/onboarding/sessions/${intake.sessionId}/review`, headers: auth(), payload: review })).statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url: `/v1/onboarding/sessions/${intake.sessionId}/bindings`, headers: auth(), payload: bindingRequest })).statusCode).toBe(202);
    const conflictBinding = structuredClone(bindingRequest);
    conflictBinding.facts.ordinaryBusinessOutcome = "A conflicting desired outcome.";
    expect((await app.inject({ method: "POST", url: `/v1/onboarding/sessions/${intake.sessionId}/bindings`, headers: auth(), payload: conflictBinding })).statusCode).toBe(409);

    // A second session cannot attach the first session's otherwise valid campaign.
    const secondIntake = structuredClone(intake);
    secondIntake.sessionId = "northstar-second-session";
    const secondStarted = (await app.inject({ method: "POST", url: "/v1/onboarding/sessions", headers: auth(), payload: secondIntake })).json();
    expect((await app.inject({ method: "POST", url: `/v1/onboarding/sessions/${secondIntake.sessionId}/review`, headers: auth(), payload: reviewBody(secondStarted) })).statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url: `/v1/onboarding/sessions/${secondIntake.sessionId}/bindings`, headers: auth(), payload: bindingRequest })).statusCode).toBe(202);
    const crossSessionLink = await app.inject({ method: "POST", url: `/v1/onboarding/sessions/${secondIntake.sessionId}/acceptance-link`, headers: auth(), payload: acceptanceLink });
    expect(crossSessionLink.statusCode).toBe(409);

    await app.close();
    app = createOnboardingProductizationSidecar(options);
    const afterRestart = await app.inject({ method: "GET", url: `/v1/onboarding/sessions/${intake.sessionId}/readiness`, headers: auth() });
    expect(afterRestart.statusCode).toBe(200);
    expect(afterRestart.json().identity.sessionId).toBe(intake.sessionId);
    await app.close();

    // Persisted mutation is detected before the artifact is trusted after another restart.
    const database = new DatabaseSync(statePath);
    const row = database.prepare("SELECT envelope_json FROM onboarding_productization_artifacts WHERE tenant_id = ? AND session_id = ? AND stage = 'acceptance-link'").get(tenantId, intake.sessionId) as { envelope_json: string };
    const mutated = JSON.parse(row.envelope_json);
    mutated.payload.expectedCampaignRevision += 1;
    database.prepare("UPDATE onboarding_productization_artifacts SET envelope_json = ? WHERE tenant_id = ? AND session_id = ? AND stage = 'acceptance-link'").run(JSON.stringify(mutated), tenantId, intake.sessionId);
    database.close();
    app = createOnboardingProductizationSidecar(options);
    const mutationRejected = await app.inject({ method: "GET", url: `/v1/onboarding/sessions/${intake.sessionId}/readiness`, headers: auth() });
    expect(mutationRejected.statusCode).toBe(400);
    expect(mutationRejected.json().error).toMatch(/integrity/i);
    await app.close();
  });
});
