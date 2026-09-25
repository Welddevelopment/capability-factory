import { describe, expect, it } from "vitest";
import type { CapabilityMode, CapabilityModeEnvelope } from "../src/product/capability-mode-contract.js";
import { buildCapabilityBundle, prepareCapabilityRoute, type PreparedRouteBuildInput } from "../src/product/capability-bundle-factory.js";

const digest = "e".repeat(64);

function envelope(mode: CapabilityMode): CapabilityModeEnvelope {
  const common = { tenantId: "tenant-one", requestId: "request-one", parentGoalId: "goal-one", ordinaryGoal: "Complete the approved work." };
  if (mode === "constrained-http-api") return { schemaVersion: "1.0", capabilityMode: mode, request: { schemaVersion: "1.0", ...common, scopeKey: "scope-one", visibility: "summary" } };
  if (mode === "experimental-browser-actions") return { schemaVersion: "1.0", capabilityMode: mode, request: { ...common, needKey: "need-one", uiContractHash: digest, operationKey: "operation-one", input: {}, approvals: ["approve-one"] } };
  if (mode === "experimental-file-transfer-actions") return { schemaVersion: "1.0", capabilityMode: mode, request: { ...common, needKey: "need-one", contractHash: digest, operationKey: "operation-one", inputFileAlias: "file-one", expectedInputSha256: digest, approvals: ["approve-one"] } };
  if (mode === "experimental-inbox-message-actions") return { schemaVersion: "1.0", capabilityMode: mode, request: { ...common, needKey: "need-one", contractHash: digest, operationKey: "operation-one", inputMessageAlias: "message-one", expectedMessageSha256: digest, approvals: ["approve-one"] } };
  if (mode === "experimental-document-actions") return { schemaVersion: "1.0", capabilityMode: mode, request: { ...common, needKey: "need-one", contractHash: digest, operationKey: "operation-one", inputDocumentAlias: "document-one", expectedDocumentSha256: digest, approvals: ["approve-one"] } };
  if (mode === "experimental-trusted-tool-actions") return { schemaVersion: "1.0", capabilityMode: mode, request: { ...common, needKey: "need-one", contractHash: digest, operationKey: "operation-one", toolId: "tool-one", toolVersion: "1.0.0", values: [1, 2], approvals: ["approve-one"] } };
  if (mode === "experimental-agent-delegation-actions") return { schemaVersion: "1.0", capabilityMode: mode, request: { ...common, needKey: "need-one", contractHash: digest, operationKey: "operation-one", delegateId: "delegate-one", delegateVersion: "1_0_0", taskKey: "task-one", input: {}, approvals: ["approve-one"] } };
  return { schemaVersion: "1.0", capabilityMode: mode, request: { ...common, needKey: "need-one", contractHash: digest, operationKey: "operation-one", input: {}, approvals: ["approve-one"] } };
}

function input(mode: CapabilityMode): PreparedRouteBuildInput {
  return {
    envelope: envelope(mode),
    needKey: "need-one",
    summary: "One bounded capability bundle.",
    capabilityId: `capability-${mode}`,
    source: "built-manifest",
    driverId: `driver-${mode}`,
    driverVersion: "1.0.0",
    executionBoundary: "customer-local",
    manifest: { mediaType: "application/json", digest, reference: `manifest-${mode}`, generated: true },
    authority: { targetAliases: ["target-one"], secretAliases: ["secret-one"], approvalKeys: ["approve-one"], risk: "consequential-write" },
    verification: { preUseVerifierKey: "probe-one", outcomeVerifierKey: "outcome-one", observationSource: "external-one", contractHash: digest },
    recovery: { operationKey: "operation-one", idempotency: "required", quarantineOn: ["verification-failure", "incorrect-outcome", "unknown-outcome"] },
    provenance: { trustedSourceIds: ["source-one"], sourceHashes: [digest], builderVersion: "builder-one", builtAt: "2026-08-05T00:00:00.000Z" },
    retention: { version: 1, reusable: true, scopeDigest: digest },
    routeId: `route-${mode}`,
    supportedActions: ["action-one"],
    observationKeys: ["external-one"],
    priority: 1,
  };
}

describe("shared complete capability-bundle factory", () => {
  it.each([
    ["constrained-http-api", "service-api"],
    ["experimental-browser-actions", "browser-web"],
    ["experimental-file-transfer-actions", "file-object-edi"],
    ["experimental-inbox-message-actions", "message-event"],
    ["experimental-document-actions", "document-media"],
    ["experimental-database-actions", "database-query"],
    ["experimental-trusted-tool-actions", "trusted-tool-code"],
    ["experimental-agent-delegation-actions", "agent-service-delegation"],
  ] as const)("binds %s to %s without a caller-supplied family", (mode, family) => {
    const bundle = buildCapabilityBundle(input(mode));
    expect(bundle.runtime.family).toBe(family);
    expect(bundle.verification.independentFromExecution).toBe(true);
    expect(bundle.recovery).toMatchObject({ reconcileBeforeRetry: true, blindRetryAllowed: false });
  });

  it("produces a prepared route whose coverage and authority derive from one complete bundle input", () => {
    const route = prepareCapabilityRoute(input("experimental-database-actions"));
    expect(route).toMatchObject({
      family: "database-query",
      supportedActions: ["action-one"],
      targetAliases: ["target-one"],
      observationKeys: ["external-one"],
      requiredSecretAliases: ["secret-one"],
      requiredApprovalKeys: ["approve-one"],
    });
  });

  it("rejects credential-shaped literals and malformed recovery or provenance through the strict bundle schema", () => {
    const malformed = input("constrained-http-api");
    malformed.authority.secretAliases = ["literal secret with spaces"];
    expect(() => buildCapabilityBundle(malformed)).toThrow();
  });
});
