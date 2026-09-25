export const CURRENT_CAPABILITY_MODE = "constrained-http-api" as const;

/**
 * The current product core is intentionally limited to constrained HTTP APIs.
 * Future modes should be added as separate trusted drivers instead of widening
 * the HTTP manifest or allowing generated code to execute inside this runtime.
 */
export type SupportedCapabilityMode = typeof CURRENT_CAPABILITY_MODE;

export const CONTROLLED_PILOT_MVP_GATES = [
  "claim-boundary",
  "adapter-kit",
  "joined-real-system-loop",
  "authority-and-secret-boundary",
  "independent-verification-and-recovery",
  "durable-operator-path",
  "install-and-clean-start",
  "frozen-readiness-campaign",
] as const;

export const CUSTOMER_PILOT_ACTIVATION_GATES = [
  "named-safe-workflow",
  "approved-test-environment",
  "least-privilege-local-credentials",
  "customer-authority-envelope",
  "customer-adapter-acceptance",
  "operations-and-stop-agreement",
] as const;

export type ControlledPilotMvpGate = (typeof CONTROLLED_PILOT_MVP_GATES)[number];
export type CustomerPilotActivationGate = (typeof CUSTOMER_PILOT_ACTIVATION_GATES)[number];
export type ReadinessGate = ControlledPilotMvpGate | CustomerPilotActivationGate;
export type ReadinessGateStatus = "passed" | "failed" | "not-run";

export interface ReadinessEvidence {
  gate: ReadinessGate;
  status: ReadinessGateStatus;
  summary: string;
  artifactReferences: string[];
}

export interface ReadinessAssessment {
  ready: boolean;
  passed: ReadinessGate[];
  missing: ReadinessGate[];
  failed: ReadinessGate[];
}

function assess(required: readonly ReadinessGate[], evidence: readonly ReadinessEvidence[]): ReadinessAssessment {
  const byGate = new Map<ReadinessGate, ReadinessEvidence>();
  for (const item of evidence) {
    if (byGate.has(item.gate)) throw new Error(`Duplicate readiness evidence for gate: ${item.gate}`);
    if (item.summary.trim().length === 0) throw new Error(`Readiness evidence needs a summary: ${item.gate}`);
    if (item.status === "passed" && item.artifactReferences.length === 0) {
      throw new Error(`A passing readiness gate needs at least one artifact reference: ${item.gate}`);
    }
    byGate.set(item.gate, item);
  }

  const passed = required.filter((gate) => byGate.get(gate)?.status === "passed");
  const failed = required.filter((gate) => byGate.get(gate)?.status === "failed");
  const missing = required.filter((gate) => {
    const status = byGate.get(gate)?.status;
    return status === undefined || status === "not-run";
  });
  return { ready: passed.length === required.length, passed: [...passed], missing: [...missing], failed: [...failed] };
}

/** Can the current product truthfully be offered for a tightly controlled pilot? */
export function assessControlledPilotMvp(evidence: readonly ReadinessEvidence[]): ReadinessAssessment {
  return assess(CONTROLLED_PILOT_MVP_GATES, evidence);
}

/** Can a named customer's specific pilot be activated? This is deliberately separate from MVP readiness. */
export function assessCustomerPilotActivation(evidence: readonly ReadinessEvidence[]): ReadinessAssessment {
  return assess(CUSTOMER_PILOT_ACTIVATION_GATES, evidence);
}
