import { describe, expect, it } from "vitest";
import type {
  CapabilityMode,
  CapabilityModeDescriptor,
  CapabilityModeEnvelope,
} from "../src/product/capability-mode-contract.js";
import { CAPABILITY_MODE_SCHEMA_VERSION } from "../src/product/capability-mode-contract.js";
import {
  CapabilityModeRouter,
  type CapabilityModeRunner,
} from "../src/product/capability-mode-router.js";
import {
  DEFAULT_RUNTIME_FAMILY_REGISTRY,
  type CapabilityBundle,
  type CapabilityBundleSource,
  type RuntimeFamily,
  type UniversalGoal,
} from "../src/product/universal-capability-contract.js";
import {
  UniversalCapabilityCoordinator,
  type PreparedCapabilityRoute,
} from "../src/product/universal-capability-coordinator.js";
import { createCapabilitySidecar } from "../src/product/sidecar.js";

const hash = "a".repeat(64);
const now = "2026-08-05T00:00:00.000Z";

const modeFamily: Record<CapabilityMode, RuntimeFamily> = {
  "constrained-http-api": "service-api",
  "experimental-browser-actions": "browser-web",
  "experimental-file-transfer-actions": "file-object-edi",
  "experimental-inbox-message-actions": "message-event",
  "experimental-document-actions": "document-media",
  "experimental-database-actions": "database-query",
  "experimental-trusted-tool-actions": "trusted-tool-code",
  "experimental-agent-delegation-actions": "agent-service-delegation",
};

function descriptor(mode: CapabilityMode): CapabilityModeDescriptor {
  return {
    capabilityMode: mode,
    label: mode,
    driverVersion: `${mode}-v1`,
    maturity: mode === "constrained-http-api" ? "working-local-pilot-mvp" : "experimental-local",
    configured: true,
    claimBoundary: `${mode} remains inside its separate local evidence boundary.`,
  };
}

function envelope(mode: CapabilityMode, ordinaryGoal: string): CapabilityModeEnvelope {
  const common = {
    tenantId: "tenant-one",
    requestId: "request-one",
    parentGoalId: "goal-one",
    ordinaryGoal,
  };
  if (mode === "constrained-http-api") {
    return {
      schemaVersion: CAPABILITY_MODE_SCHEMA_VERSION,
      capabilityMode: mode,
      request: { schemaVersion: "1.0", ...common, scopeKey: "scope-one", visibility: "summary" },
    };
  }
  if (mode === "experimental-browser-actions") {
    return {
      schemaVersion: CAPABILITY_MODE_SCHEMA_VERSION,
      capabilityMode: mode,
      request: { ...common, needKey: "need-one", uiContractHash: hash, operationKey: "operation-one", input: {}, approvals: ["approve-one"] },
    };
  }
  if (mode === "experimental-file-transfer-actions") {
    return {
      schemaVersion: CAPABILITY_MODE_SCHEMA_VERSION,
      capabilityMode: mode,
      request: { ...common, needKey: "need-one", contractHash: hash, operationKey: "operation-one", inputFileAlias: "file-one", expectedInputSha256: hash, approvals: ["approve-one"] },
    };
  }
  if (mode === "experimental-inbox-message-actions") {
    return {
      schemaVersion: CAPABILITY_MODE_SCHEMA_VERSION,
      capabilityMode: mode,
      request: { ...common, needKey: "need-one", contractHash: hash, operationKey: "operation-one", inputMessageAlias: "message-one", expectedMessageSha256: hash, approvals: ["approve-one"] },
    };
  }
  if (mode === "experimental-database-actions") {
    return {
      schemaVersion: CAPABILITY_MODE_SCHEMA_VERSION,
      capabilityMode: mode,
      request: { ...common, needKey: "need-one", contractHash: hash, operationKey: "operation-one", input: { recordId: "record-one" }, approvals: ["approve-one"] },
    };
  }
  if (mode === "experimental-trusted-tool-actions") {
    return {
      schemaVersion: CAPABILITY_MODE_SCHEMA_VERSION,
      capabilityMode: mode,
      request: { ...common, needKey: "need-one", contractHash: hash, operationKey: "operation-one", toolId: "tool-one", toolVersion: "1.0.0", values: [1, 2], approvals: ["approve-one"] },
    };
  }
  if (mode === "experimental-agent-delegation-actions") {
    return {
      schemaVersion: CAPABILITY_MODE_SCHEMA_VERSION,
      capabilityMode: mode,
      request: { ...common, needKey: "need-one", contractHash: hash, operationKey: "operation-one", delegateId: "delegate-one", delegateVersion: "1_0_0", taskKey: "task-one", input: {}, approvals: ["approve-one"] },
    };
  }
  return {
    schemaVersion: CAPABILITY_MODE_SCHEMA_VERSION,
    capabilityMode: mode,
    request: { ...common, needKey: "need-one", contractHash: hash, operationKey: "operation-one", inputDocumentAlias: "document-one", expectedDocumentSha256: hash, approvals: ["approve-one"] },
  };
}

function bundle(family: RuntimeFamily, source: CapabilityBundleSource = "built-manifest"): CapabilityBundle {
  return {
    schemaVersion: "1.0",
    capabilityId: `capability-${family}`,
    tenantId: "tenant-one",
    needKey: "need-one",
    summary: `Bounded ${family} capability.`,
    source,
    runtime: {
      family,
      driverId: `driver-${family}`,
      driverVersion: "1.0.0",
      executionBoundary: source === "sandboxed-residual" ? "isolated-sandbox" : "customer-local",
    },
    manifest: { mediaType: "application/json", digest: hash, reference: `manifest-${family}`, generated: source !== "retained" },
    authority: {
      targetAliases: ["system-one"],
      secretAliases: ["credential-one"],
      approvalKeys: ["approve-one"],
      risk: "consequential-write",
    },
    verification: {
      preUseVerifierKey: "pre-use-one",
      outcomeVerifierKey: "outcome-one",
      observationSource: "external-state-one",
      independentFromExecution: true,
      contractHash: hash,
    },
    recovery: {
      operationKey: "operation-one",
      idempotency: "required",
      reconcileBeforeRetry: true,
      blindRetryAllowed: false,
      quarantineOn: ["verification-failure", "incorrect-outcome", "unknown-outcome"],
    },
    provenance: { trustedSourceIds: ["source-one"], sourceHashes: [hash], builderVersion: "builder-one", builtAt: now },
    retention: { version: 1, reusable: true, scopeDigest: hash },
  };
}

function goal(): UniversalGoal {
  return {
    schemaVersion: "1.0",
    tenantId: "tenant-one",
    requestId: "request-one",
    parentGoalId: "goal-one",
    ordinaryGoal: "Complete the approved work and prove the external result.",
    gap: {
      key: "need-one",
      summary: "One externally verifiable ability is missing.",
      requiredActions: ["action-one"],
      targetAliases: ["system-one"],
      requiredObservationKeys: ["external-state-one"],
      maximumRisk: "consequential-write",
    },
    authority: {
      allowedTargetAliases: ["system-one"],
      allowedSecretAliases: ["credential-one"],
      allowedActions: ["action-one"],
      grantedApprovals: ["approve-one"],
      maximumRisk: "consequential-write",
    },
  };
}

function route(mode: CapabilityMode, source: CapabilityBundleSource = "built-manifest", priority = 10): PreparedCapabilityRoute {
  return {
    routeId: `route-${mode}-${source}`,
    family: modeFamily[mode],
    envelope: envelope(mode, goal().ordinaryGoal),
    bundle: bundle(modeFamily[mode], source),
    supportedActions: ["action-one"],
    targetAliases: ["system-one"],
    observationKeys: ["external-state-one"],
    requiredSecretAliases: ["credential-one"],
    requiredApprovalKeys: ["approve-one"],
    priority,
  };
}

function coordinator(seen: CapabilityMode[], resultStatus: "completed" | "handoff" = "completed"): UniversalCapabilityCoordinator {
  const modes = Object.keys(modeFamily) as CapabilityMode[];
  const runners: CapabilityModeRunner[] = modes.map((mode) => ({
    descriptor: descriptor(mode),
    async run(value) {
      seen.push(value.capabilityMode);
      return {
        capabilityMode: value.capabilityMode,
        status: resultStatus,
        parentResumed: resultStatus === "completed",
        parentCompleted: resultStatus === "completed",
        summary: resultStatus === "completed" ? "The original goal completed after independent verification." : "Exact authority is missing.",
        ...(resultStatus === "completed" ? { capabilityId: `capability-${modeFamily[mode]}` } : {}),
      };
    },
  }));
  return new UniversalCapabilityCoordinator(new CapabilityModeRouter(runners), { now: () => now });
}

describe("effectively universal capability coordinator", () => {
  it("registers every major family without claiming that planned and future families work", () => {
    expect(DEFAULT_RUNTIME_FAMILY_REGISTRY).toHaveLength(15);
    expect(DEFAULT_RUNTIME_FAMILY_REGISTRY.filter((item) => item.enabled).map((item) => item.family)).toEqual([
      "service-api",
      "browser-web",
      "file-object-edi",
      "message-event",
      "document-media",
      "database-query",
      "trusted-tool-code",
      "agent-service-delegation",
    ]);
    expect(DEFAULT_RUNTIME_FAMILY_REGISTRY.filter((item) => !item.enabled).every((item) => item.maturity === "planned" || item.maturity === "future")).toBe(true);
  });

  it.each(Object.keys(modeFamily) as CapabilityMode[])("selects %s from the diagnosed gap without a caller-supplied mode", async (mode) => {
    const seen: CapabilityMode[] = [];
    const result = await coordinator(seen).resolve(goal(), [route(mode)]);
    expect(result).toMatchObject({
      status: "autonomous-completion",
      selectedFamily: modeFamily[mode],
      metrics: { correctlyResolved: true, autonomouslyCompleted: true, preciseHandoff: false, silentFalseCompletion: false },
    });
    expect(seen).toEqual([mode]);
    expect(result.receiptDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("searches retained and trusted-existing bundles before composition, construction, sandbox or delegation", () => {
    const selected = coordinator([]).select(goal(), [
      route("constrained-http-api", "sandboxed-residual", 0),
      route("constrained-http-api", "built-manifest", 0),
      route("constrained-http-api", "composed", 0),
      route("constrained-http-api", "trusted-existing", 0),
      route("constrained-http-api", "retained", 99),
    ]).selected;
    expect(selected?.bundle.source).toBe("retained");
  });

  it("hands off precisely when every route fails authority, coverage, family or verification gates", async () => {
    const invalid = route("experimental-browser-actions");
    invalid.requiredSecretAliases = ["unapproved-secret"];
    invalid.observationKeys = [];
    invalid.bundle.runtime.family = "database-query";
    const result = await coordinator([]).resolve(goal(), [invalid]);
    expect(result).toMatchObject({
      status: "precise-handoff",
      metrics: { correctlyResolved: true, autonomouslyCompleted: false, preciseHandoff: true, silentFalseCompletion: false },
    });
    expect(result.rejectedRoutes[0]?.reasons).toEqual(expect.arrayContaining([
      "The bundle runtime family does not match the route.",
      "The route lacks an independent observation required by the outcome contract.",
      "One or more route credentials are outside customer authority.",
    ]));
  });

  it("does not convert an incomplete or unknown mode result into autonomous completion", async () => {
    const seen: CapabilityMode[] = [];
    const mode = "constrained-http-api" as const;
    const runner: CapabilityModeRunner = {
      descriptor: descriptor(mode),
      async run() {
        seen.push(mode);
        return {
          capabilityMode: mode,
          status: "unknown",
          parentResumed: false,
          parentCompleted: false,
          summary: "External state could not be established.",
        };
      },
    };
    const result = await new UniversalCapabilityCoordinator(new CapabilityModeRouter([runner]), { now: () => now }).resolve(goal(), [route(mode)]);
    expect(result).toMatchObject({
      status: "unresolved-safe",
      metrics: { correctlyResolved: false, autonomouslyCompleted: false, preciseHandoff: false, silentFalseCompletion: false },
    });
    expect(seen).toEqual([mode]);
  });

  it("accepts an ordinary sidecar goal without a caller-selected mode and routes it through trusted preparation", async () => {
    const seen: CapabilityMode[] = [];
    const universal = coordinator(seen);
    const app = createCapabilitySidecar(undefined, { resolve: () => undefined }, {
      accessToken: "universal-test-token",
      universalCapabilities: {
        coordinator: universal,
        async prepare(submission) {
          expect(submission).not.toHaveProperty("capabilityMode");
          expect(submission).not.toHaveProperty("gap");
          return { goal: goal(), routes: [route("experimental-browser-actions")] };
        },
      },
    });
    try {
      const unauthorized = await app.inject({ method: "GET", url: "/v1/runtime-families" });
      expect(unauthorized.statusCode).toBe(401);

      const registry = await app.inject({
        method: "GET",
        url: "/v1/runtime-families",
        headers: { "x-capability-sidecar-token": "universal-test-token" },
      });
      expect(registry.statusCode).toBe(200);
      expect(registry.json()).toMatchObject({ selection: "trusted-automatic", callerSelectsMode: false });
      expect(registry.json().families).toHaveLength(15);

      const response = await app.inject({
        method: "POST",
        url: "/v1/universal-goals",
        headers: { "x-capability-sidecar-token": "universal-test-token" },
        payload: {
          schemaVersion: "1.0",
          tenantId: "tenant-one",
          requestId: "request-one",
          parentGoalId: "goal-one",
          ordinaryGoal: goal().ordinaryGoal,
          scopeKey: "scope-one",
          visibility: "summary",
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "autonomous-completion", selectedFamily: "browser-web" });
      expect(seen).toEqual(["experimental-browser-actions"]);
    } finally {
      await app.close();
    }
  });

  it("rejects a trusted preparer that changes the immutable goal identity", async () => {
    const seen: CapabilityMode[] = [];
    const universal = coordinator(seen);
    const app = createCapabilitySidecar(undefined, { resolve: () => undefined }, {
      accessToken: "universal-test-token",
      universalCapabilities: {
        coordinator: universal,
        async prepare() {
          return { goal: { ...goal(), ordinaryGoal: "A changed goal." }, routes: [route("constrained-http-api")] };
        },
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/universal-goals",
        headers: { "x-capability-sidecar-token": "universal-test-token" },
        payload: {
          schemaVersion: "1.0",
          tenantId: "tenant-one",
          requestId: "request-one",
          parentGoalId: "goal-one",
          ordinaryGoal: goal().ordinaryGoal,
          scopeKey: "scope-one",
          visibility: "summary",
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/changed the immutable ordinary-goal identity/);
      expect(seen).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
