import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CapabilityManifest } from "../src/manifest.js";
import { CapabilityRuntime } from "../src/runtime.js";
import type {
  CapabilityEvent,
  CapabilityRequest,
  OutcomeReceipt,
} from "../src/product/contracts.js";
import {
  CapabilityCoordinator,
  manifestDigest,
  type CapabilityBuilder,
  type CapabilityEventSink,
  type CapabilityVerifier,
  type RuntimeResolver,
} from "../src/product/coordinator.js";
import {
  CapabilityFactorySdk,
  classifyExternalOutcome,
  type CapabilityWorkflow,
} from "../src/product/sdk.js";
import { FileTenantCapabilityStore } from "../src/product/store.js";

const DOCUMENTATION_HASH = "d".repeat(64);
const CAPABILITY_ID = "containment-test-capability";

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "capability-factory-containment-"));
}

function request(requestId = "containment-request"): CapabilityRequest {
  return {
    context: {
      tenantId: "tenant-containment",
      requestId,
      workflowKey: "containment-check",
      ordinaryGoal: "Create exactly one authorized fictional record.",
      blockedAt: "2026-07-27T00:00:00.000Z",
      blockedReason: "The required write capability is absent.",
      visibility: "full",
    },
    need: {
      key: "create-fictional-record",
      summary: "Create one fictional record.",
      requiredActions: ["create_record"],
      targetAliases: ["customer_system"],
      secretAliases: ["CUSTOMER_TEST_TOKEN"],
      documentationHash: DOCUMENTATION_HASH,
    },
    authority: {
      allowedTargetAliases: ["customer_system"],
      allowedSecretAliases: ["CUSTOMER_TEST_TOKEN"],
      allowedMethods: ["POST"],
      writeAuthority: "preauthorized",
      approvedWriteActions: [],
    },
    runtimeProfile: "containment",
  };
}

function manifest(): CapabilityManifest {
  return {
    schemaVersion: "1",
    id: CAPABILITY_ID,
    version: "1.0.0",
    service: "Fictional containment service",
    description: "Create one fictional record for containment testing.",
    baseUrlAlias: "customer_system",
    auth: { kind: "apiKey", secretAlias: "CUSTOMER_TEST_TOKEN", headerName: "Authorization" },
    actions: [
      {
        name: "create_record",
        description: "Create one fictional record.",
        inputSchema: {
          type: "object",
          properties: { recordId: { type: "string", description: "Exact fictional record ID" } },
          required: ["recordId"],
          additionalProperties: false,
        },
        request: {
          method: "POST",
          pathTemplate: "/records",
          queryTemplate: {},
          headerTemplate: {},
          bodyTemplate: { id: "{{input.recordId}}" },
        },
        response: { acceptedStatuses: [201], outputPointers: { recordId: "/id" } },
        safety: { idempotency: "required", timeoutMs: 1_000, maxResponseBytes: 10_000 },
      },
    ],
    provenance: {
      documentationHash: DOCUMENTATION_HASH,
      model: "deterministic-containment-test",
      createdAt: "2026-07-27T00:00:00.000Z",
    },
  };
}

class Builder implements CapabilityBuilder {
  calls = 0;
  async build(): Promise<CapabilityManifest> {
    this.calls += 1;
    return manifest();
  }
}

class Verifier implements CapabilityVerifier {
  async verify(requestValue: CapabilityRequest, manifestValue: CapabilityManifest) {
    return {
      verifierVersion: "containment-verifier-1",
      manifestDigest: manifestDigest(manifestValue),
      documentationHash: requestValue.need.documentationHash,
      passed: true,
      checks: [{ id: "candidate", passed: true, detail: "Candidate passed the isolated pre-use check." }],
      verifiedAt: "2026-07-27T00:00:01.000Z",
    };
  }
}

class Resolver implements RuntimeResolver {
  resolve(): CapabilityRuntime {
    return new CapabilityRuntime({
      targets: {
        customer_system: {
          baseUrl: "http://127.0.0.1:9",
          allowedPaths: ["/records"],
          allowedMethods: { POST: ["/records"] },
        },
      },
      secrets: { CUSTOMER_TEST_TOKEN: "synthetic-test-token" },
    });
  }
}

function outcome(overrides: Partial<OutcomeReceipt> = {}): OutcomeReceipt {
  return {
    verifierVersion: "independent-containment-outcome-1",
    passed: true,
    intendedWrites: 1,
    incorrectSideEffects: 0,
    stateDigest: "state-digest",
    checks: [{ id: "exact-state", passed: true, detail: "Exact state matched." }],
    verifiedAt: "2026-07-27T00:00:02.000Z",
    ...overrides,
  };
}

function system() {
  const events: CapabilityEvent[] = [];
  const store = new FileTenantCapabilityStore(path.join(temporaryDirectory(), "registry"));
  const builder = new Builder();
  const resolver = new Resolver();
  const sink: CapabilityEventSink = { record: (event) => void events.push(event) };
  const coordinator = new CapabilityCoordinator({
    store,
    builder,
    verifier: new Verifier(),
    runtimeResolver: resolver,
    events: sink,
  });
  const sdk = new CapabilityFactorySdk({ coordinator, runtimeResolver: resolver, events: sink });
  return { events, store, builder, coordinator, sdk };
}

function workflow(verifyOutcome: CapabilityWorkflow["verifyOutcome"]): CapabilityWorkflow {
  return {
    execute: async () => [{ action: "create_record", status: 201, output: { recordId: "record-1" } }],
    verifyOutcome,
    resume: async () => ({ completed: true, summary: "The fictional goal resumed." }),
  };
}

describe("failed-outcome containment", () => {
  it("classifies independently observed external state conservatively", () => {
    expect(classifyExternalOutcome(outcome())).toBe("completed");
    expect(classifyExternalOutcome(outcome({ passed: false, intendedWrites: 0 }))).toBe("not-started");
    expect(classifyExternalOutcome(outcome({ passed: false, intendedWrites: 1 }))).toBe("partial");
    expect(
      classifyExternalOutcome(outcome({ passed: false, intendedWrites: 1, incorrectSideEffects: 1 })),
    ).toBe("incorrect");
  });

  it("inspects external state after an execution error and never retries blindly", async () => {
    const product = system();
    let executeCalls = 0;
    let outcomeCalls = 0;
    const result = await product.sdk.completeBlockedGoal(request(), {
      execute: async () => {
        executeCalls += 1;
        throw new Error("response lost after the external service may have acted");
      },
      verifyOutcome: async () => {
        outcomeCalls += 1;
        return outcome({
          passed: false,
          intendedWrites: 0,
          checks: [{ id: "final-state", passed: false, detail: "The intended record is absent." }],
        });
      },
      resume: async () => ({ completed: true, summary: "Must not run" }),
    });

    expect(executeCalls).toBe(1);
    expect(outcomeCalls).toBe(1);
    expect(result).toMatchObject({
      status: "handoff",
      handoff: {
        reason: "execution-failed",
        incident: {
          externalOutcome: "not-started",
          executionErrorObserved: true,
          automaticRetryBlocked: true,
          capabilityQuarantined: true,
          mitigationAttempted: false,
          nextStep: "review-before-retry",
        },
        failedChecks: expect.arrayContaining([
          expect.objectContaining({ id: "execution-error", passed: false }),
          expect.objectContaining({ id: "final-state", passed: false }),
        ]),
      },
    });
    expect(product.store.list("tenant-containment")[0]).toMatchObject({ status: "quarantined" });
    expect(product.events.map((event) => event.type)).toContain("incident.created");
  });

  it("does not infer safe resumption from a clean outcome after an execution error", async () => {
    const product = system();
    const result = await product.sdk.completeBlockedGoal(request(), {
      execute: async () => { throw new Error("write response was lost"); },
      verifyOutcome: async () => outcome(),
      resume: async () => ({ completed: true, summary: "The ordinary path must not be used." }),
    });

    expect(result).toMatchObject({
      status: "handoff",
      handoff: {
        reason: "execution-failed",
        incident: {
          externalOutcome: "completed",
          executionErrorObserved: true,
          automaticRetryBlocked: true,
          capabilityQuarantined: true,
          mitigationAttempted: false,
          nextStep: "resume-from-verified-state",
        },
        failedChecks: expect.arrayContaining([
          expect.objectContaining({ id: "verified-state-resumption", passed: false }),
        ]),
      },
    });
    expect(product.store.list("tenant-containment")[0]).toMatchObject({ status: "quarantined" });
  });

  it("resumes only through an explicit verified-state path when the final outcome is clean", async () => {
    const product = system();
    let ordinaryResumeCalls = 0;
    let reconciledResumeCalls = 0;
    const result = await product.sdk.completeBlockedGoal(request(), {
      execute: async () => { throw new Error("write response was lost"); },
      verifyOutcome: async () => outcome(),
      resume: async () => {
        ordinaryResumeCalls += 1;
        return { completed: true, summary: "Wrong path" };
      },
      resumeAfterVerifiedExecutionError: async (_request, verifiedOutcome) => {
        reconciledResumeCalls += 1;
        expect(verifiedOutcome.passed).toBe(true);
        return { completed: true, summary: "Resumed from independently verified external state." };
      },
    });

    expect(ordinaryResumeCalls).toBe(0);
    expect(reconciledResumeCalls).toBe(1);
    expect(result).toMatchObject({
      status: "completed",
      actions: [],
      reconciliation: {
        reason: "execution-error",
        outcomeEstablished: true,
        actionReceiptsComplete: false,
        resumedFromVerifiedState: true,
      },
    });
    expect(product.store.list("tenant-containment")[0]).toMatchObject({ status: "active" });
    expect(product.events.map((event) => event.type)).toContain("execution.reconciled");
  });

  it("quarantines an outcome mismatch before returning the handoff", async () => {
    const product = system();
    const result = await product.sdk.completeBlockedGoal(
      request(),
      workflow(async () =>
        outcome({
          passed: false,
          checks: [{ id: "wrong-record", passed: false, detail: "The wrong fictional record exists." }],
        }),
      ),
    );

    expect(result).toMatchObject({
      status: "handoff",
      handoff: {
        reason: "outcome-failed",
        incident: {
          externalOutcome: "partial",
          executionErrorObserved: false,
          automaticRetryBlocked: true,
          capabilityQuarantined: true,
          mitigationAttempted: false,
          nextStep: "inspect-or-authorize-mitigation",
        },
      },
    });
    expect(product.store.list("tenant-containment")).toEqual([
      expect.objectContaining({ status: "quarantined" }),
    ]);
    expect(product.events.map((event) => event.type)).toContain("capability.quarantined");

    const replacement = await product.coordinator.acquire(request("replacement"));
    expect(replacement).toMatchObject({ status: "acquired", acquired: { source: "built" } });
    expect(product.builder.calls).toBe(2);
  });

  it("quarantines a capability when an incorrect side effect is observed", async () => {
    const product = system();
    const result = await product.sdk.completeBlockedGoal(
      request(),
      workflow(async () =>
        outcome({
          passed: false,
          incorrectSideEffects: 1,
          checks: [{ id: "duplicate", passed: false, detail: "A duplicate fictional record exists." }],
        }),
      ),
    );

    expect(result).toMatchObject({
      status: "handoff",
      handoff: {
        incident: {
          externalOutcome: "incorrect",
          nextStep: "contain-and-authorize-mitigation",
        },
        failedChecks: expect.arrayContaining([
          expect.objectContaining({ id: "incorrect-side-effects", passed: false }),
        ]),
      },
    });
    expect(product.store.list("tenant-containment")[0]).toMatchObject({ status: "quarantined" });
  });

  it("treats an unavailable outcome channel as unknown and quarantines", async () => {
    const product = system();
    const result = await product.sdk.completeBlockedGoal(
      request(),
      workflow(async () => { throw new Error("read-only evidence channel unavailable"); }),
    );

    expect(result).toMatchObject({
      status: "handoff",
      handoff: {
        reason: "outcome-failed",
        incident: {
          externalOutcome: "unknown",
          executionErrorObserved: false,
          automaticRetryBlocked: true,
          capabilityQuarantined: true,
          mitigationAttempted: false,
          nextStep: "restore-verification",
        },
        failedChecks: expect.arrayContaining([
          expect.objectContaining({ id: "outcome-verifier", passed: false }),
        ]),
      },
    });
    expect(product.store.list("tenant-containment")[0]).toMatchObject({ status: "quarantined" });
  });

  it("keeps a capability active only when the independent outcome passes cleanly", async () => {
    const product = system();
    const result = await product.sdk.completeBlockedGoal(
      request(),
      workflow(async () => outcome()),
    );

    expect(result).toMatchObject({ status: "completed", capabilitySource: "built" });
    expect(product.store.list("tenant-containment")[0]).toMatchObject({ status: "active" });
    expect(product.events.map((event) => event.type)).not.toContain("capability.quarantined");
  });
});
