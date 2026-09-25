import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityModeRouter, type CapabilityModeRunner } from "../src/product/capability-mode-router.js";
import type { CapabilityBundle, UniversalGoalSubmission } from "../src/product/universal-capability-contract.js";
import { UniversalCapabilityCoordinator, type PreparedCapabilityRoute } from "../src/product/universal-capability-coordinator.js";
import {
  UniversalCompositionCoordinator,
  type UniversalCompositionPlan,
  type UniversalCompositionVerifier,
} from "../src/product/universal-composition.js";
import {
  UniversalCompositionJobService,
  UniversalCompositionJobStore,
} from "../src/product/universal-composition-jobs.js";
import { createCapabilitySidecar } from "../src/product/sidecar.js";

const cleanup: string[] = [];
const hash = "c".repeat(64);
const ordinaryGoal = "Complete the bounded cross-mode work and independently prove the external result.";

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "cf-composition-jobs-"));
  cleanup.push(directory);
  return join(directory, "jobs.sqlite");
}

function submission(overrides: Partial<UniversalGoalSubmission> = {}): UniversalGoalSubmission {
  return {
    schemaVersion: "1.0",
    tenantId: "tenant-one",
    requestId: "composition-request-one",
    parentGoalId: "parent-goal-one",
    ordinaryGoal,
    scopeKey: "trusted-scope-one",
    visibility: "full",
    ...overrides,
  };
}

function bundle(): CapabilityBundle {
  return {
    schemaVersion: "1.0",
    capabilityId: "capability-tool-one",
    tenantId: "tenant-one",
    needKey: "need-compute",
    summary: "Pinned local compute capability.",
    source: "trusted-existing",
    runtime: { family: "trusted-tool-code", driverId: "trusted-tool-driver", driverVersion: "1.0.0", executionBoundary: "isolated-sandbox" },
    manifest: { mediaType: "application/wasm", digest: hash, reference: "tool-one", generated: false },
    authority: { targetAliases: ["tool-one"], secretAliases: [], approvalKeys: ["approve-compute"], risk: "consequential-write" },
    verification: {
      preUseVerifierKey: "tool-probe",
      outcomeVerifierKey: "tool-outcome",
      observationSource: "tool-state",
      independentFromExecution: true,
      contractHash: hash,
    },
    recovery: {
      operationKey: "compute",
      idempotency: "not-applicable",
      reconcileBeforeRetry: true,
      blindRetryAllowed: false,
      quarantineOn: ["verification-failure", "incorrect-outcome", "unknown-outcome"],
    },
    provenance: { trustedSourceIds: ["trusted-catalog"], sourceHashes: [hash], builderVersion: "builder-one", builtAt: "2026-08-05T00:00:00.000Z" },
    retention: { version: 1, reusable: true, scopeDigest: hash },
  };
}

function route(): PreparedCapabilityRoute {
  return {
    routeId: "route-tool-one",
    family: "trusted-tool-code",
    envelope: {
      schemaVersion: "1.0",
      capabilityMode: "experimental-trusted-tool-actions",
      request: {
        tenantId: "tenant-one",
        requestId: "leaf-request-one",
        parentGoalId: "parent-goal-one",
        ordinaryGoal,
        needKey: "need-compute",
        contractHash: hash,
        operationKey: "compute",
        toolId: "tool-one",
        toolVersion: "1.0.0",
        values: [2, 3],
        approvals: ["approve-compute"],
      },
    },
    bundle: bundle(),
    supportedActions: ["compute"],
    targetAliases: ["tool-one"],
    observationKeys: ["tool-state"],
    requiredSecretAliases: [],
    requiredApprovalKeys: ["approve-compute"],
    priority: 1,
  };
}

function plan(): UniversalCompositionPlan {
  return {
    schemaVersion: "1.0",
    tenantId: "tenant-one",
    requestId: "composition-request-one",
    parentGoalId: "parent-goal-one",
    ordinaryGoal,
    failurePolicy: "stop-all",
    workItems: [{
      workItemId: "compute",
      dependencies: [],
      goal: {
        schemaVersion: "1.0",
        tenantId: "tenant-one",
        requestId: "leaf-request-one",
        parentGoalId: "parent-goal-one",
        ordinaryGoal,
        gap: {
          key: "need-compute",
          summary: "Compute the bounded value.",
          requiredActions: ["compute"],
          targetAliases: ["tool-one"],
          requiredObservationKeys: ["tool-state"],
          maximumRisk: "consequential-write",
        },
        authority: {
          allowedTargetAliases: ["tool-one"],
          allowedSecretAliases: [],
          allowedActions: ["compute"],
          grantedApprovals: ["approve-compute"],
          maximumRisk: "consequential-write",
        },
      },
      routes: [route()],
    }],
  };
}

function verifier(overrides: Partial<UniversalCompositionVerifier> = {}): UniversalCompositionVerifier {
  return {
    key: "aggregate-verifier-one",
    sourceId: "separate-state-observer-one",
    kind: "independent-external-state",
    async verify({ leafReceipts }) {
      return {
        passed: leafReceipts.length === 1,
        incorrectSideEffects: 0,
        stateDigest: hash,
        detail: "Separate observer found the exact bounded result.",
      };
    },
    ...overrides,
  };
}

function coordinator(): UniversalCompositionCoordinator {
  const runner: CapabilityModeRunner = {
    descriptor: {
      capabilityMode: "experimental-trusted-tool-actions",
      label: "Trusted tool",
      driverVersion: "1.0.0",
      maturity: "experimental-local",
      configured: true,
      claimBoundary: "Durability test only.",
    },
    async run() {
      return {
        capabilityMode: "experimental-trusted-tool-actions",
        status: "completed",
        parentResumed: true,
        parentCompleted: true,
        summary: "Bounded tool completed.",
      };
    },
  };
  const leaf = new UniversalCapabilityCoordinator(new CapabilityModeRouter([runner]), {
    now: () => "2026-08-05T00:00:00.000Z",
  });
  return new UniversalCompositionCoordinator(leaf, () => "2026-08-05T00:00:01.000Z");
}

function preparer(counter: { calls: number }, selectedVerifier = verifier()) {
  return async (_submission: UniversalGoalSubmission) => {
    counter.calls += 1;
    return { plan: plan(), verifier: selectedVerifier, selectedCompositionKey: "composition-one" };
  };
}

describe("durable universal-composition jobs", () => {
  it("persists one exact plan, completes it, and never prepares an exact duplicate twice", async () => {
    const calls = { calls: 0 };
    const selectedVerifier = verifier();
    const service = new UniversalCompositionJobService(
      new UniversalCompositionJobStore(databasePath()),
      coordinator(),
      preparer(calls, selectedVerifier),
      () => selectedVerifier,
    );

    const first = await service.submit(submission());
    await service.idle();
    const completed = service.get("tenant-one", first.job.jobId)!;
    const duplicate = await service.submit(submission());

    expect(first.created).toBe(true);
    expect(completed).toMatchObject({ status: "autonomous-completion", attempts: 1, result: { parentCompleted: true } });
    expect(duplicate).toMatchObject({ created: false, job: { status: "autonomous-completion" } });
    expect(calls.calls).toBe(1);
    expect(service.events("tenant-one", first.job.jobId).map((event) => event.type)).toEqual([
      "composition-job.queued",
      "composition-job.started",
      "composition-job.finished",
    ]);
    await service.close();
  });

  it("rejects a changed request under the same parent identity before preparation", async () => {
    const calls = { calls: 0 };
    const selectedVerifier = verifier();
    const service = new UniversalCompositionJobService(
      new UniversalCompositionJobStore(databasePath()), coordinator(), preparer(calls, selectedVerifier), () => selectedVerifier,
    );
    await service.submit(submission());
    await service.idle();
    await expect(service.submit(submission({ requestId: "different-request" }))).rejects.toThrow(/different universal-composition submission/i);
    expect(calls.calls).toBe(1);
    await service.close();
  });

  it("recovers an interrupted exact plan without calling the preparer or replanning", async () => {
    const path = databasePath();
    const selectedVerifier = verifier();
    const firstStore = new UniversalCompositionJobStore(path);
    const saved = firstStore.create({ submission: submission(), compositionKey: "composition-one", plan: plan(), verifier: selectedVerifier });
    expect(firstStore.claim("tenant-one", saved.job.jobId)?.job.status).toBe("running");
    firstStore.close();

    const calls = { calls: 0 };
    const recovered = new UniversalCompositionJobService(
      new UniversalCompositionJobStore(path), coordinator(), preparer(calls, selectedVerifier), () => selectedVerifier,
    );
    expect(recovered.recover()).toHaveLength(1);
    await recovered.idle();
    expect(recovered.get("tenant-one", saved.job.jobId)).toMatchObject({ status: "autonomous-completion", attempts: 2 });
    expect(calls.calls).toBe(0);
    expect(recovered.events("tenant-one", saved.job.jobId).map((event) => event.type)).toContain("composition-job.recovered");
    await recovered.close();
  });

  it("fails closed if the persisted verifier identity is no longer in the trusted registry", async () => {
    const path = databasePath();
    const originalVerifier = verifier();
    const firstStore = new UniversalCompositionJobStore(path);
    const saved = firstStore.create({ submission: submission(), compositionKey: "composition-one", plan: plan(), verifier: originalVerifier });
    expect(firstStore.claim("tenant-one", saved.job.jobId)).toBeDefined();
    firstStore.close();

    const changedVerifier = verifier({ key: "different-verifier" });
    const recovered = new UniversalCompositionJobService(
      new UniversalCompositionJobStore(path), coordinator(), preparer({ calls: 0 }, changedVerifier), () => changedVerifier,
    );
    recovered.recover();
    await recovered.idle();
    expect(recovered.get("tenant-one", saved.job.jobId)).toMatchObject({
      status: "unresolved-safe",
      error: "The persisted composition verifier identity is no longer trusted.",
    });
    await recovered.close();
  });

  it("stops at the recovery ceiling and keeps job and event lookups tenant-scoped", async () => {
    const path = databasePath();
    const selectedVerifier = verifier();
    const firstStore = new UniversalCompositionJobStore(path);
    const saved = firstStore.create({ submission: submission(), compositionKey: "composition-one", plan: plan(), verifier: selectedVerifier });
    expect(firstStore.claim("tenant-one", saved.job.jobId)).toBeDefined();
    firstStore.close();

    const recovered = new UniversalCompositionJobService(
      new UniversalCompositionJobStore(path), coordinator(), preparer({ calls: 0 }, selectedVerifier), () => selectedVerifier, 1,
    );
    expect(recovered.recover()).toEqual([]);
    expect(recovered.get("tenant-one", saved.job.jobId)).toMatchObject({
      status: "unresolved-safe",
      error: "Recovery attempt ceiling reached.",
    });
    expect(recovered.get("tenant-two", saved.job.jobId)).toBeUndefined();
    expect(recovered.events("tenant-two", saved.job.jobId)).toEqual([]);
    await recovered.close();
  });

  it("refuses a corrupted stored plan instead of executing or silently completing it", async () => {
    const path = databasePath();
    const selectedVerifier = verifier();
    const store = new UniversalCompositionJobStore(path);
    const saved = store.create({ submission: submission(), compositionKey: "composition-one", plan: plan(), verifier: selectedVerifier });
    store.close();

    const database = new (await import("node:sqlite")).DatabaseSync(path);
    database.prepare("UPDATE universal_composition_jobs SET plan_json = ? WHERE job_id = ?").run(JSON.stringify({ changed: true }), saved.job.jobId);
    database.close();

    const service = new UniversalCompositionJobService(
      new UniversalCompositionJobStore(path), coordinator(), preparer({ calls: 0 }, selectedVerifier), () => selectedVerifier,
    );
    service.recover();
    await service.idle();
    expect(service.get("tenant-one", saved.job.jobId)).toMatchObject({
      status: "unresolved-safe",
      error: "Stored universal-composition plan digest mismatch.",
    });
    await service.close();
  });

  it("exposes authenticated durable submit, lookup, and append-only events through the customer-local sidecar", async () => {
    const calls = { calls: 0 };
    const selectedVerifier = verifier();
    const service = new UniversalCompositionJobService(
      new UniversalCompositionJobStore(databasePath()), coordinator(), preparer(calls, selectedVerifier), () => selectedVerifier,
    );
    const token = "composition-test-token-1234";
    const app = createCapabilitySidecar(undefined, { resolve: () => undefined }, {
      accessToken: token,
      universalCompositionJobs: service,
    });
    await app.ready();

    const unauthorized = await app.inject({ method: "POST", url: "/v1/universal-composition-jobs", payload: submission() });
    expect(unauthorized.statusCode).toBe(401);

    const started = await app.inject({
      method: "POST",
      url: "/v1/universal-composition-jobs",
      headers: { "x-capability-sidecar-token": token },
      payload: submission(),
    });
    expect([200, 202]).toContain(started.statusCode);
    const startedBody = started.json() as { jobId: string };
    await service.idle();

    const found = await app.inject({
      method: "GET",
      url: `/v1/universal-composition-jobs/${startedBody.jobId}?tenantId=tenant-one`,
      headers: { "x-capability-sidecar-token": token },
    });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({ status: "autonomous-completion", attempts: 1 });

    const events = await app.inject({
      method: "GET",
      url: `/v1/universal-composition-jobs/${startedBody.jobId}/events?tenantId=tenant-one&after=0`,
      headers: { "x-capability-sidecar-token": token },
    });
    expect(events.statusCode).toBe(200);
    expect((events.json() as { events: Array<{ sequence: number }> }).events).toHaveLength(3);
    const cursor = (events.json() as { events: Array<{ sequence: number }> }).events[1]!.sequence;
    const after = await app.inject({
      method: "GET",
      url: `/v1/universal-composition-jobs/${startedBody.jobId}/events?tenantId=tenant-one&after=${cursor}`,
      headers: { "x-capability-sidecar-token": token },
    });
    expect((after.json() as { events: Array<{ type: string }> }).events.map((event) => event.type)).toEqual(["composition-job.finished"]);
    expect(calls.calls).toBe(1);
    await app.close();
  });
});
