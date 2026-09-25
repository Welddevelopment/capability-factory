import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GenericAcceptanceCampaignState, GenericAcceptanceCampaignStore } from "../src/product/generic-acceptance-executor.js";
import {
  createOnboardingProductizationSidecar,
  assertOnboardingProductizationArtifactSafe,
  onboardingAcceptanceBindingId,
  type OnboardingCompilationRuntime,
  type OnboardingProductizationSidecarOptions,
} from "../src/product/onboarding-productization-sidecar.js";
import {
  readinessTestBindingArtifacts,
  readinessTestCampaign,
  readinessTestFacts,
  readinessTestPreparation,
  readinessTestStartInput,
} from "./product-onboarding-readiness-receipt.test.js";

const token = "customer-local-security-token";
const tenantId = "northstar-tenant";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class MutableAcceptanceStore implements GenericAcceptanceCampaignStore {
  readonly campaigns = new Map<string, GenericAcceptanceCampaignState>();
  async load(id: string) { return this.campaigns.has(id) ? structuredClone(this.campaigns.get(id)!) : null; }
  async save(state: GenericAcceptanceCampaignState) { this.campaigns.set(state.campaignId, structuredClone(state)); }
  set(state: GenericAcceptanceCampaignState) { this.campaigns.set(state.campaignId, structuredClone(state)); }
}

async function fixture(runtimeOverride?: () => OnboardingCompilationRuntime) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cf-sidecar-security-"));
  temporaryDirectories.push(directory);
  const statePath = path.join(directory, "onboarding.sqlite");
  const intake = readinessTestStartInput();
  const built = readinessTestBindingArtifacts(readinessTestPreparation(intake));
  const store = new MutableAcceptanceStore();
  let currentNow = "2026-08-14T12:00:00.000Z";
  const options: OnboardingProductizationSidecarOptions = {
    accessToken: token, tenantId, statePath, acceptanceStore: store,
    compilationRuntimes: { resolve: () => runtimeOverride ? runtimeOverride() : built.runtime },
    now: () => currentNow,
  };
  return { statePath, intake, built, store, options, setNow: (value: string) => { currentNow = value; } };
}

function headers(value = token) { return { "x-capability-sidecar-token": value }; }

function reviewFrom(started: any) {
  return {
    sessionId: started.sessionId, expectedInputDigest: started.inputDigest, expectedSnapshotDigest: started.snapshotDigest,
    review: {
      adapterProposalDigest: started.reviewArtifacts.adapterProposalDigest, verifierContractDigest: started.reviewArtifacts.verifierContractDigest, authorityCompilationDigest: started.reviewArtifacts.authorityCompilationDigest,
      authorityRuntimeBindingDigest: "a".repeat(64), observationAdapterBindingDigest: "b".repeat(64), confirmedByAlias: "fixtureEngineer", confirmedAt: "2026-08-14T11:00:00.000Z",
    },
  };
}

async function prepareAndBind(app: ReturnType<typeof createOnboardingProductizationSidecar>, f: Awaited<ReturnType<typeof fixture>>) {
  const started = (await app.inject({ method: "POST", url: "/v1/onboarding/sessions", headers: headers(), payload: f.intake })).json();
  const review = reviewFrom(started);
  const reviewed = await app.inject({ method: "POST", url: `/v1/onboarding/sessions/${f.intake.sessionId}/review`, headers: headers(), payload: review });
  expect(reviewed.statusCode).toBe(202);
  const bindingRequest = { schemaVersion: "1.0", normalization: f.built.normalization, facts: readinessTestFacts(), qualification: { qualifiedAt: "2026-08-14T11:00:00.000Z", expiresAt: "2026-09-13T11:00:00.000Z" } };
  const bound = await app.inject({ method: "POST", url: `/v1/onboarding/sessions/${f.intake.sessionId}/bindings`, headers: headers(), payload: bindingRequest });
  expect(bound.statusCode).toBe(202);
  return { started, review, bindingRequest };
}

function seededStrings(seed: number, count: number): string[] {
  let state = seed >>> 0;
  return Array.from({ length: count }, (_, index) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    const length = (state % 96) + 1;
    return Array.from({ length }, (_unused, offset) => String.fromCharCode(33 + ((state + index * 17 + offset * 31) % 90))).join("");
  });
}

describe("onboarding sidecar adversarial boundary", () => {
  it("uniformly rejects malformed generated auth and path/header injection without leaking state", async () => {
    const f = await fixture();
    const app = createOnboardingProductizationSidecar(f.options);
    try {
      const candidates = ["", "x", "x".repeat(15), "x".repeat(16), "x".repeat(512), ...seededStrings(0xcafef00d, 64)].filter((value) => value !== token);
      for (const candidate of candidates) {
        const response = await app.inject({ method: "GET", url: `/v1/onboarding/sessions/${f.intake.sessionId}`, headers: headers(candidate) });
        expect(response.statusCode).toBe(401);
        expect(response.body).toBe('{"error":"Unauthorized"}');
      }
      for (const attack of ["../other", "' OR 1=1--", "x%2Fy", "x%00y", "x;DROP TABLE sessions", "__proto__"]) {
        const response = await app.inject({ method: "GET", url: `/v1/onboarding/sessions/${encodeURIComponent(attack)}`, headers: headers() });
        expect([400, 404]).toContain(response.statusCode);
        expect(response.body).not.toContain(token);
      }
      const headerInjection = await app.inject({ method: "GET", url: `/v1/onboarding/sessions/${f.intake.sessionId}`, headers: headers("wrong\r\nx-forged: true") });
      expect(headerInjection.statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it("rejects generated nested secrets, excessive depth/collections and oversized bodies with redacted errors", async () => {
    const f = await fixture();
    const app = createOnboardingProductizationSidecar(f.options);
    try {
      const secrets = [
        "Bearer abcdefghijklmnopqrstuvwxyz", "sk-abcdefghijklmnopqrstuvwxyz123456", "password=correct-horse-battery-staple", "api_key: abcdefghijklmnop", "-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----",
      ];
      for (let index = 0; index < secrets.length; index += 1) {
        const payload = structuredClone(f.intake);
        payload.sessionId = `secret-session-${index}`;
        payload.adapter.workflow.summary = `Nested ${secrets[index]}`;
        const response = await app.inject({ method: "POST", url: "/v1/onboarding/sessions", headers: headers(), payload });
        expect(response.statusCode).toBe(400);
        expect(response.body).not.toContain(secrets[index]!);
        expect(response.body).toContain("secret-shaped");
      }
      const deep = structuredClone(f.intake) as any;
      deep.sessionId = "deep-session";
      let cursor = deep.adapter.workflow as any;
      for (let index = 0; index < 80; index += 1) cursor = cursor[`depth${index}`] = {};
      const deepResponse = await app.inject({ method: "POST", url: "/v1/onboarding/sessions", headers: headers(), payload: deep });
      expect(deepResponse.statusCode).toBe(400);
      expect(deepResponse.json().error).toMatch(/nesting depth/i);

      const wide = structuredClone(f.intake) as any;
      wide.sessionId = "wide-session";
      wide.adapter.workflow.injected = Array.from({ length: 10_001 }, (_, index) => index);
      const wideResponse = await app.inject({ method: "POST", url: "/v1/onboarding/sessions", headers: headers(), payload: wide });
      expect(wideResponse.statusCode).toBe(400);
      expect(wideResponse.json().error).toMatch(/oversized collection/i);

      const huge = JSON.stringify({ data: "x".repeat(10_000_100) });
      const hugeResponse = await app.inject({ method: "POST", url: "/v1/onboarding/sessions", headers: { ...headers(), "content-type": "application/json" }, payload: huge });
      expect(hugeResponse.statusCode).toBe(413);
      expect(hugeResponse.body).not.toContain("x".repeat(100));

      const malformed = await app.inject({ method: "POST", url: "/v1/onboarding/sessions", headers: { ...headers(), "content-type": "application/json" }, payload: '{"sessionId":"x","secret":"Bearer abcdefghijklmnopqrstuvwxyz"' });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.body).not.toContain("abcdefghijklmnopqrstuvwxyz");

      const prototypePayload = JSON.stringify({ ...f.intake, adapter: { ...f.intake.adapter, workflow: JSON.parse('{"workflowId":"x","__proto__":{"polluted":true}}') } });
      const prototypeResponse = await app.inject({ method: "POST", url: "/v1/onboarding/sessions", headers: { ...headers(), "content-type": "application/json" }, payload: prototypePayload });
      expect(prototypeResponse.statusCode).toBe(400);
      expect(prototypeResponse.body).not.toContain("polluted");
      for (const key of ["__proto__", "constructor", "prototype"]) {
        const parsed = JSON.parse(`{"safe":{"${key}":{"polluted":true}}}`);
        expect(() => assertOnboardingProductizationArtifactSafe(parsed)).toThrow(/prototype-control/i);
      }
    } finally { await app.close(); }
  });

  it("recovers partial durable stages, rejects conflicting races, and does not pin a failed compile artifact", async () => {
    let leakRuntime = true;
    const f = await fixture(() => {
      if (leakRuntime) throw new Error("runtime failure Bearer extremely-private-runtime-token sk-abcdefghijklmnopqrstuvwxyz");
      return f.built.runtime;
    });
    let app = createOnboardingProductizationSidecar(f.options);
    const exactStarts = await Promise.all(Array.from({ length: 16 }, () => app.inject({ method: "POST", url: "/v1/onboarding/sessions", headers: headers(), payload: f.intake })));
    expect(exactStarts.every((response) => response.statusCode === 202)).toBe(true);
    const started = exactStarts[0]!.json();

    // Simulate process death after workflow commit but before API-envelope commit.
    await app.close();
    let database = new DatabaseSync(f.statePath);
    database.prepare("DELETE FROM onboarding_productization_artifacts WHERE tenant_id = ? AND session_id = ? AND stage = 'intake'").run(tenantId, f.intake.sessionId);
    database.close();
    app = createOnboardingProductizationSidecar(f.options);
    expect((await app.inject({ method: "POST", url: "/v1/onboarding/sessions", headers: headers(), payload: f.intake })).statusCode).toBe(202);

    const review = reviewFrom(started);
    expect((await app.inject({ method: "POST", url: `/v1/onboarding/sessions/${f.intake.sessionId}/review`, headers: headers(), payload: review })).statusCode).toBe(202);
    await app.close();
    database = new DatabaseSync(f.statePath);
    database.prepare("DELETE FROM onboarding_productization_artifacts WHERE tenant_id = ? AND session_id = ? AND stage = 'review'").run(tenantId, f.intake.sessionId);
    database.close();
    app = createOnboardingProductizationSidecar(f.options);
    expect((await app.inject({ method: "POST", url: `/v1/onboarding/sessions/${f.intake.sessionId}/review`, headers: headers(), payload: review })).statusCode).toBe(202);

    const bindingRequest = { schemaVersion: "1.0", normalization: f.built.normalization, facts: readinessTestFacts(), qualification: { qualifiedAt: "2026-08-14T11:00:00.000Z", expiresAt: "2026-09-13T11:00:00.000Z" } };
    const leaked = await app.inject({ method: "POST", url: `/v1/onboarding/sessions/${f.intake.sessionId}/bindings`, headers: headers(), payload: bindingRequest });
    expect(leaked.statusCode).toBe(400);
    expect(leaked.body).not.toContain("extremely-private-runtime-token");
    expect(leaked.body).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    leakRuntime = false;
    expect((await app.inject({ method: "POST", url: `/v1/onboarding/sessions/${f.intake.sessionId}/bindings`, headers: headers(), payload: bindingRequest })).statusCode).toBe(202);

    const conflicting = structuredClone(f.intake);
    conflicting.adapter.workflow.summary = "Conflicting concurrent intent.";
    const race = await Promise.all([
      app.inject({ method: "POST", url: "/v1/onboarding/sessions", headers: headers(), payload: f.intake }),
      app.inject({ method: "POST", url: "/v1/onboarding/sessions", headers: headers(), payload: conflicting }),
    ]);
    expect(race.map((response) => response.statusCode).sort()).toEqual([202, 409]);
    await app.close();
  });

  it("rejects pair crossing, forged acceptance chains, qualification expiry and stored-envelope substitution", async () => {
    const f = await fixture();
    let app = createOnboardingProductizationSidecar(f.options);
    await prepareAndBind(app, f);
    const bindingId = onboardingAcceptanceBindingId(tenantId, f.intake.sessionId, f.built.pair.pairDigest);
    const campaign = readinessTestCampaign(f.built.pair.pairDigest, bindingId);
    f.store.set(campaign);
    const validLink = { schemaVersion: "1.0", campaignId: campaign.campaignId, expectedPairDigest: f.built.pair.pairDigest, expectedCampaignRevision: campaign.revision, expectedLatestReceiptHash: campaign.receipts.at(-1)!.receiptHash };
    for (const fakeDigest of seededStrings(0x1234abcd, 12).map((value) => Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64))) {
      const crossed = await app.inject({ method: "POST", url: `/v1/onboarding/sessions/${f.intake.sessionId}/acceptance-link`, headers: headers(), payload: { ...validLink, expectedPairDigest: fakeDigest } });
      expect(crossed.statusCode).toBe(409);
    }
    expect((await app.inject({ method: "POST", url: `/v1/onboarding/sessions/${f.intake.sessionId}/acceptance-link`, headers: headers(), payload: validLink })).statusCode).toBe(202);
    expect((await app.inject({ method: "GET", url: `/v1/onboarding/sessions/${f.intake.sessionId}/readiness`, headers: headers() })).statusCode).toBe(200);

    const forged = structuredClone(campaign);
    forged.receipts[4]!.result.incorrectSideEffects = 1;
    f.store.set(forged);
    const forgedResponse = await app.inject({ method: "GET", url: `/v1/onboarding/sessions/${f.intake.sessionId}/readiness`, headers: headers() });
    expect(forgedResponse.statusCode).toBe(400);
    expect(forgedResponse.json().error).toMatch(/integrity|incorrect side effect/i);
    f.store.set(campaign);

    f.setNow("2026-09-14T12:00:00.000Z");
    const expired = await app.inject({ method: "GET", url: `/v1/onboarding/sessions/${f.intake.sessionId}/readiness`, headers: headers() });
    expect(expired.statusCode).toBe(400);
    expect(expired.json().error).toMatch(/expired/i);
    f.setNow("2026-08-14T12:00:00.000Z");
    const substitutedIntake = structuredClone(f.intake);
    substitutedIntake.sessionId = "substituted-session";
    expect((await app.inject({ method: "POST", url: "/v1/onboarding/sessions", headers: headers(), payload: substitutedIntake })).statusCode).toBe(202);
    await app.close();

    // Copy an intact envelope under another session key: identity binding must reject it.
    const database = new DatabaseSync(f.statePath);
    const row = database.prepare("SELECT envelope_json, envelope_digest FROM onboarding_productization_artifacts WHERE tenant_id = ? AND session_id = ? AND stage = 'intake'").get(tenantId, f.intake.sessionId) as { envelope_json: string; envelope_digest: string };
    database.prepare("INSERT OR REPLACE INTO onboarding_productization_artifacts (tenant_id, session_id, stage, envelope_json, envelope_digest) VALUES (?, ?, 'intake', ?, ?)").run(tenantId, "substituted-session", row.envelope_json, row.envelope_digest);
    database.close();
    app = createOnboardingProductizationSidecar(f.options);
    const substituted = await app.inject({ method: "GET", url: "/v1/onboarding/sessions/substituted-session/readiness", headers: headers() });
    expect(substituted.statusCode).toBe(400);
    await app.close();
  });
});
