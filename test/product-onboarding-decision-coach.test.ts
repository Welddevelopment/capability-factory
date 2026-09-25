import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableCleanPackageAuthoringWorkflow, type CleanPackageAuthoringInput } from "../src/product/onboarding-clean-package-authoring.js";
import { assessOnboardingDecisionAnswers, exportPortableCoachSession, importPortableCoachSession, projectOnboardingDecisionCoach } from "../src/product/onboarding-decision-coach.js";
import { JsonFileGenericAcceptanceCampaignStore } from "../src/product/generic-acceptance-executor.js";
import { createOnboardingProductizationSidecar } from "../src/product/onboarding-productization-sidecar.js";

const now = "2026-08-14T15:00:00.000Z";
const expiry = "2026-08-15T15:00:00.000Z";
const token = "decision-coach-access-token";
const tenantId = "coach-tenant";
const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

async function input(name: "helios" | "northstar"): Promise<CleanPackageAuthoringInput> {
  const helios = name === "helios";
  const filename = helios ? "helios-lens-openapi.json" : "northstar-vault-openapi.json";
  const document = JSON.parse(await readFile(new URL(`./fixtures/onboarding-clean-package-authoring/${filename}`, import.meta.url), "utf8"));
  return {
    schemaVersion: "1.0", authoringSessionId: `${name}-coach-session`, tenantId,
    packageIdentity: { packageId: `${name}-coach-package`, packageSessionId: `${name}-coach-package-session`, adapterId: `${name}-coach-adapter`, adapterVersion: "1.0.0" },
    approvedMaterial: { kind: "openapi", materialId: `${name}-coach-material`, localReference: `fixture://${name}/openapi`, approved: true, targetAlias: helios ? "helios_lens" : "northstar_vault", approvedByAlias: "fixtureReviewer", approvedAt: now, document },
    selection: helios
      ? { serverUrl: "https://helios-lens.local.invalid/v1", actionOperationId: "scheduleLensCleaning", observerOperationId: "listLensCleaningReservations", actionCredentialAlias: "heliosLensWriter", observerCredentialAlias: "heliosLensObserver" }
      : { serverUrl: "https://northstar-vault.local.invalid/api", actionOperationId: "createSampleHold", observerOperationId: "findSampleHolds", actionCredentialAlias: "northstarHoldWriter", observerCredentialAlias: "northstarHoldReader" },
    workflow: { workflowId: `${name}-coach-workflow`, summary: "Complete one bounded fictional workflow.", requiredOutcome: "Exactly one fresh matching record exists and collateral state remains unchanged.", customerConfirmed: true },
  };
}

describe("offline onboarding decision coach", () => {
  it("explains and dependency-orders two unfamiliar authoring sessions without answering them", async () => {
    const metrics: unknown[] = [];
    for (const name of ["helios", "northstar"] as const) {
      const workflow = new DurableCleanPackageAuthoringWorkflow(":memory:", { now: () => now });
      const snapshot = workflow.start(await input(name));
      const projection = projectOnboardingDecisionCoach(snapshot);
      expect(projection).toMatchObject({ mode: "read-only-rehearsal", remainingHumanDecisions: 32, dryRun: { mutation: false, executionAuthorityEffect: "none", activationEffect: "none" } });
      expect(projection.maximumDependencyDepth).toBeGreaterThanOrEqual(3);
      expect(projection.questions.every((item) => item.explanation && item.whyItMatters && item.safeExample && item.counterexample && item.source.factKey && item.downstreamEffect)).toBe(true);
      expect(projection.questions.find((item) => item.questionId === "final-review")?.state).toBe("locked");
      expect(projection.questions.find((item) => item.questionId === "stable-input-key")?.state).toBe("available");
      expect(snapshot.snapshotDigest).toBe(workflow.read(snapshot.authoringSessionId).snapshotDigest);
      metrics.push({ fixture: name, questionCount: projection.questions.length, dependencyDepth: projection.maximumDependencyDepth, detectedContradictions: 0, remainingHumanDecisions: projection.remainingHumanDecisions, packageSpecificExecutableCodeLines: snapshot.metrics.packageSpecificExecutableCodeLines });
      workflow.close();
    }
    expect(metrics).toHaveLength(2);
    process.stdout.write(`\nONBOARDING_DECISION_COACH_METRICS=${JSON.stringify(metrics)}\n`);
  });

  it("detects dependency violations, contradictions, unsafe combinations, placeholders, and source-inconsistent answers", async () => {
    const workflow = new DurableCleanPackageAuthoringWorkflow(":memory:", { now: () => now });
    const snapshot = workflow.start(await input("helios"));
    const assessment = assessOnboardingDecisionAnswers(snapshot, [
      { questionId: "stable-input-key", value: "reservation_ref" },
      { questionId: "conflict-input-key", value: "reservation_ref" },
      { questionId: "action-driver-id", value: "same_driver" },
      { questionId: "observer-driver-id", value: "same_driver" },
      { questionId: "independent-observation", value: true },
      { questionId: "blind-retry", value: true },
      { questionId: "action-source-id", value: "TBD" },
      { questionId: "observer-result-path", value: "made_up_path" },
      { questionId: "final-review", value: true },
    ]);
    expect(assessment.acceptedForSubmission).toBe(false);
    expect(assessment.contradictions).toEqual(expect.arrayContaining(["stable-and-conflict-identifiers-equal", "independence-claimed-despite-conflation"]));
    expect(assessment.unsafeCombinations).toEqual(expect.arrayContaining(["action-observer-driver-conflation", "blind-retry-without-reconciliation"]));
    expect(assessment.lowInformationAnswers).toContain("action-source-id");
    expect(assessment.sourceInconsistencies.join(" ")).toMatch(/observer-result-path/);
    expect(assessment.lockedQuestionIds).toEqual(expect.arrayContaining(["independent-observation", "blind-retry", "observer-result-path", "final-review"]));
    expect(workflow.read(snapshot.authoringSessionId).snapshotDigest).toBe(snapshot.snapshotDigest);
    workflow.close();
  });

  it("exports and imports a redacted integrity-bound portable rehearsal and rejects expiry, forgery, stale revision, and cross-tenant reuse", async () => {
    const workflow = new DurableCleanPackageAuthoringWorkflow(":memory:", { now: () => now });
    const snapshot = workflow.start(await input("northstar"));
    const bundle = exportPortableCoachSession(snapshot, { tenantId, issuedAt: now, expiresAt: expiry, signingKey: token });
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("northstarHoldWriter");
    expect(serialized).not.toContain("Northstar Sample Vault");
    expect(importPortableCoachSession(bundle, { tenantId, authoringSessionId: snapshot.authoringSessionId, sourceInputDigest: snapshot.sourceInputDigest, snapshotDigest: snapshot.snapshotDigest, signingKey: token, now })).toEqual(projectOnboardingDecisionCoach(snapshot));
    expect(() => importPortableCoachSession(bundle, { tenantId: "other-tenant", authoringSessionId: snapshot.authoringSessionId, sourceInputDigest: snapshot.sourceInputDigest, snapshotDigest: snapshot.snapshotDigest, signingKey: token, now })).toThrow(/different tenant/i);
    expect(() => importPortableCoachSession(bundle, { tenantId, authoringSessionId: snapshot.authoringSessionId, sourceInputDigest: snapshot.sourceInputDigest, snapshotDigest: snapshot.snapshotDigest, signingKey: token, now: "2026-08-16T00:00:00.000Z" })).toThrow(/expired/i);
    const forged = structuredClone(bundle); forged.redactedProjection.remainingHumanDecisions = 0;
    expect(() => importPortableCoachSession(forged, { tenantId, authoringSessionId: snapshot.authoringSessionId, sourceInputDigest: snapshot.sourceInputDigest, snapshotDigest: snapshot.snapshotDigest, signingKey: token, now })).toThrow(/digest/i);
    expect(() => importPortableCoachSession(bundle, { tenantId, authoringSessionId: snapshot.authoringSessionId, sourceInputDigest: snapshot.sourceInputDigest, snapshotDigest: "f".repeat(64), signingKey: token, now })).toThrow(/different tenant, session, source, or revision/i);
    workflow.close();
  });

  it("exposes authenticated zero-mutation coach routes and preserves exact replay after restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cf-coach-sidecar-")); temporary.push(root);
    const options = { accessToken: token, tenantId, statePath: path.join(root, "state.sqlite"), acceptanceStore: new JsonFileGenericAcceptanceCampaignStore(path.join(root, "acceptance")), compilationRuntimes: { resolve: () => undefined }, now: () => now };
    let app = createOnboardingProductizationSidecar(options);
    const source = await input("helios");
    const started = await app.inject({ method: "POST", url: "/v1/onboarding/authoring/sessions", headers: { "x-capability-sidecar-token": token }, payload: source });
    const snapshot = started.json();
    const coach = await app.inject({ method: "GET", url: `/v1/onboarding/authoring/sessions/${source.authoringSessionId}/coach`, headers: { "x-capability-sidecar-token": token } });
    expect(coach.statusCode).toBe(200);
    const assessment = await app.inject({ method: "POST", url: `/v1/onboarding/authoring/sessions/${source.authoringSessionId}/coach/assess`, headers: { "x-capability-sidecar-token": token }, payload: { answers: [{ questionId: "action-driver-id", value: "reviewed_action_driver" }] } });
    expect(assessment.json()).toMatchObject({ acceptedForSubmission: true, mutation: false, executionAuthorityEffect: "none", activationEffect: "none" });
    const exported = await app.inject({ method: "POST", url: `/v1/onboarding/authoring/sessions/${source.authoringSessionId}/coach/export`, headers: { "x-capability-sidecar-token": token }, payload: { expiresAt: expiry } });
    expect(exported.statusCode).toBe(200);
    const imported = await app.inject({ method: "POST", url: `/v1/onboarding/authoring/sessions/${source.authoringSessionId}/coach/import`, headers: { "x-capability-sidecar-token": token }, payload: exported.json() });
    expect(imported.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/v1/onboarding/authoring/sessions/${source.authoringSessionId}`, headers: { "x-capability-sidecar-token": token } })).json().snapshotDigest).toBe(snapshot.snapshotDigest);
    await app.close(); app = createOnboardingProductizationSidecar(options);
    const replay = await app.inject({ method: "POST", url: `/v1/onboarding/authoring/sessions/${source.authoringSessionId}/coach/import`, headers: { "x-capability-sidecar-token": token }, payload: exported.json() });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(imported.json());
    expect((await app.inject({ method: "GET", url: `/v1/onboarding/authoring/sessions/${source.authoringSessionId}`, headers: { "x-capability-sidecar-token": token } })).json().snapshotDigest).toBe(snapshot.snapshotDigest);
    await app.close();
  });
});
