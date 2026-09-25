/**
 * Fictional installation-rehearsal runtime only.
 *
 * It deliberately resolves no customer scope, so an authenticated goal request
 * must stop with a precise zero-write handoff. It proves that the distributed
 * image, adapter boundary, durable queue, authentication and response contract
 * compose without pretending to be a customer adapter or product-success case.
 */
const acceptanceCases = [
  "read-only-happy-path",
  "approved-write",
  "fresh-process-reuse",
  "missing-credential",
  "missing-permission",
  "lost-response-reconciliation",
  "wrong-or-partial-outcome",
  "sidecar-restart",
  "duplicate-submission",
  "conflicting-parent-reuse",
];

export function createPilotRuntime(context) {
  const adapter = {
    descriptor: {
      schemaVersion: "1.0",
      adapterId: "clean_room_handoff_adapter",
      adapterVersion: "1.0.0",
      capabilityMode: "constrained-http-api",
      environmentId: "fictional_clean_room",
      scopeKeys: ["clean_room_scope"],
      workflowKeys: ["clean_room_workflow"],
      targetAliases: ["fictional_target"],
      credentialAliases: ["fictional_credential"],
      documentation: [{ targetAlias: "fictional_target", sha256: "a".repeat(64) }],
      operations: [{
        name: "read_fictional_state",
        targetAlias: "fictional_target",
        method: "GET",
        consequence: "read",
        retrySafety: "not-applicable",
        outcomeVerifierKey: "verify_fictional_state",
      }],
      acceptanceCases,
      dataBoundary: {
        execution: "customer-local",
        credentials: "customer-local-alias-only",
        externalVerification: "customer-local-independent",
      },
    },
    scopes: { resolve: async () => undefined },
    runtimes: { open: async () => undefined },
    preflight: async () => [{
      id: "fictional-runtime-boundary",
      passed: context.tenantId.length > 0,
      detail: "The fictional clean-room adapter is connected without customer authority.",
    }],
  };
  return {
    adapter,
    planner: {
      propose: async () => {
        throw new Error("The clean-room runtime must hand off before planning because no customer scope exists.");
      },
    },
  };
}
