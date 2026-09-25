import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  compileCapabilityResolutionGraph,
  type CapabilityResolutionCompilerContext,
  type CapabilityResolutionGraphProposal,
} from "../src/product/capability-resolution-compiler.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function context(): CapabilityResolutionCompilerContext {
  return {
    identity: { tenantId: "tenant-one", requestId: "request-one", parentGoalId: "goal-one", ordinaryGoalDigest: hash("restock goal") },
    primitives: [
      {
        key: "inventory.read-shortage-v1", version: "v1", effect: "Read and publish the independently observed shortage.",
        targetAlias: "inventory-system", actionKey: "read-shortage", maximumRisk: "read-only", requiredApprovalKeys: [],
        inputs: [{ key: "sku", schemaKey: "sku-v1", allowedSources: ["trusted-config"], maximumClassification: "internal" }],
        outputs: [{ key: "shortage", schemaKey: "quantity-v1", classification: "internal" }],
        routeBuilderKeys: ["inventory-read-route"], requiredObservationKeys: ["inventory-read-observer"],
        verifierTemplateKey: "read-observation-verifier", idempotency: "not-applicable", provenanceDigest: hash("read primitive"), enabled: true,
      },
      {
        key: "supplier.create-draft-v1", version: "v1", effect: "Create one duplicate-safe draft order.",
        targetAlias: "supplier-system", actionKey: "create-draft", maximumRisk: "reversible-write", requiredApprovalKeys: ["approve-draft"],
        inputs: [
          { key: "sku", schemaKey: "sku-v1", allowedSources: ["trusted-config"], maximumClassification: "internal" },
          { key: "quantity", schemaKey: "quantity-v1", allowedSources: ["verified-artifact"], maximumClassification: "internal" },
        ],
        outputs: [{ key: "draft-reference", schemaKey: "draft-reference-v1", classification: "internal" }],
        routeBuilderKeys: ["supplier-http-route"], requiredObservationKeys: ["supplier-draft-observer"],
        verifierTemplateKey: "draft-outcome-verifier", idempotency: "required", provenanceDigest: hash("write primitive"), enabled: true,
      },
    ],
    evidence: [{ evidenceId: "inventory-policy", digest: hash("evidence"), summary: "Approved inventory and supplier workflow.", permittedPrimitiveKeys: ["inventory.read-shortage-v1", "supplier.create-draft-v1"] }],
    trustedConfigValues: [{ key: "sku-widget", schemaKey: "sku-v1", classification: "internal", digest: hash("widget") }],
    trustedLiteralValues: [], evidenceValues: [],
    enabledRouteBuilderKeys: ["inventory-read-route", "supplier-http-route"],
    enabledObservationKeys: ["inventory-read-observer", "supplier-draft-observer"],
    enabledVerifierTemplateKeys: ["read-observation-verifier", "draft-outcome-verifier"],
    authority: { targetAliases: ["inventory-system", "supplier-system"], actionKeys: ["read-shortage", "create-draft"], approvalKeys: ["approve-draft"], maximumRisk: "reversible-write" },
    aggregateVerifier: { key: "restock-aggregate-v1", requiredTerminalOutputs: [{ workItemId: "create-draft", outputKey: "draft-reference" }] },
  };
}

function proposal() {
  return {
    schemaVersion: "1.0", decision: "compile", tenantId: "tenant-one", requestId: "request-one", parentGoalId: "goal-one",
    ordinaryGoalDigest: hash("restock goal"), summary: "Read the shortage and create one approved draft.",
    workItems: [
      { workItemId: "read-shortage", primitiveKey: "inventory.read-shortage-v1", primitiveVersion: "v1", citedEvidenceIds: ["inventory-policy"], dependsOn: [], bindings: [{ inputKey: "sku", kind: "trusted-config", valueKey: "sku-widget" }] },
      { workItemId: "create-draft", primitiveKey: "supplier.create-draft-v1", primitiveVersion: "v1", citedEvidenceIds: ["inventory-policy"], dependsOn: ["read-shortage"], bindings: [
        { inputKey: "sku", kind: "trusted-config", valueKey: "sku-widget" },
        { inputKey: "quantity", kind: "verified-artifact", producerWorkItemId: "read-shortage", outputKey: "shortage" },
      ] },
    ],
    terminalOutputs: [{ workItemId: "create-draft", outputKey: "draft-reference" }],
  };
}

describe("capability resolution compiler", () => {
  it("compiles a new typed graph from smaller trusted primitives", () => {
    const result = compileCapabilityResolutionGraph(proposal(), context());
    expect(result).toMatchObject({ status: "compiled", errors: [], plan: { orderedWorkItems: [{ workItemId: "read-shortage" }, { workItemId: "create-draft" }] } });
    expect(result.plan?.planDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts a strict enumerable trusted-evidence value descriptor", () => {
    const trusted = context();
    trusted.primitives[0]!.inputs[0] = {
      key: "record",
      schemaKey: "record-v1",
      allowedSources: ["trusted-evidence"],
      maximumClassification: "internal",
    };
    trusted.evidenceValues = [{
      evidenceId: "inventory-policy",
      key: "approved-record",
      schemaKey: "record-v1",
      classification: "internal",
      digest: hash("approved record"),
    }];
    const requested = proposal() as unknown as CapabilityResolutionGraphProposal;
    requested.workItems[0]!.bindings = [{
      inputKey: "record",
      kind: "trusted-evidence",
      evidenceId: "inventory-policy",
      valueKey: "approved-record",
    }];
    expect(compileCapabilityResolutionGraph(requested, trusted).status).toBe("compiled");
    expect(Object.keys(trusted.evidenceValues[0]!)).toContain("evidenceId");
  });

  it("rejects unknown primitives, cycles and identity changes", () => {
    const unknown = proposal(); unknown.workItems[0]!.primitiveKey = "invented.action";
    expect(compileCapabilityResolutionGraph(unknown, context()).errors.map((item) => item.code)).toContain("unknown-primitive");
    const cyclic = proposal(); cyclic.workItems[0]!.dependsOn = ["create-draft"];
    expect(compileCapabilityResolutionGraph(cyclic, context()).errors.map((item) => item.code)).toContain("invalid-graph");
    const changed = proposal(); changed.parentGoalId = "different-goal";
    expect(compileCapabilityResolutionGraph(changed, context()).errors.map((item) => item.code)).toContain("identity-mismatch");
  });

  it("rejects authority escalation and missing executable evidence", () => {
    const denied = context(); denied.authority = { ...denied.authority, targetAliases: ["inventory-system"], approvalKeys: [] };
    const codes = compileCapabilityResolutionGraph(proposal(), denied).errors.map((item) => item.code);
    expect(codes).toContain("authority-target");
    expect(codes).toContain("missing-approval");
    const noObserver = context(); noObserver.enabledObservationKeys = ["inventory-read-observer"];
    expect(compileCapabilityResolutionGraph(proposal(), noObserver).errors.map((item) => item.code)).toContain("missing-observer");
  });

  it("rejects untyped artifact flow and implicit dependencies", () => {
    const wrongType = context(); wrongType.primitives[0]!.outputs[0]!.schemaKey = "temperature-v1";
    expect(compileCapabilityResolutionGraph(proposal(), wrongType).errors.map((item) => item.code)).toContain("schema-mismatch");
    const hiddenDependency = proposal(); hiddenDependency.workItems[1]!.dependsOn = [];
    expect(compileCapabilityResolutionGraph(hiddenDependency, context()).errors.map((item) => item.code)).toContain("artifact-dependency");
  });

  it("requires exact aggregate outcome coverage", () => {
    const incomplete = proposal(); incomplete.terminalOutputs = [{ workItemId: "read-shortage", outputKey: "shortage" }];
    expect(compileCapabilityResolutionGraph(incomplete, context()).errors.map((item) => item.code)).toContain("incomplete-aggregate");
  });
});
