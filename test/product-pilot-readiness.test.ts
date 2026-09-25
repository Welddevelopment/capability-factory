import { describe, expect, it } from "vitest";
import {
  CONTROLLED_PILOT_MVP_GATES,
  CUSTOMER_PILOT_ACTIVATION_GATES,
  assessControlledPilotMvp,
  assessCustomerPilotActivation,
  type ReadinessEvidence,
  type ReadinessGate,
} from "../src/product/pilot-readiness.js";

function passed(gates: readonly ReadinessGate[]): ReadinessEvidence[] {
  return gates.map((gate) => ({
    gate,
    status: "passed",
    summary: `${gate} passed its defined acceptance check.`,
    artifactReferences: [`artifact://${gate}`],
  }));
}

describe("controlled-pilot readiness contract", () => {
  it("does not confuse locally ready MVP machinery with an activated customer pilot", () => {
    const mvpEvidence = passed(CONTROLLED_PILOT_MVP_GATES);
    expect(assessControlledPilotMvp(mvpEvidence)).toMatchObject({ ready: true, missing: [], failed: [] });
    expect(assessCustomerPilotActivation(mvpEvidence)).toMatchObject({
      ready: false,
      missing: [...CUSTOMER_PILOT_ACTIVATION_GATES],
      failed: [],
    });
  });

  it("requires every gate and preserves explicit failures", () => {
    const evidence = passed(CONTROLLED_PILOT_MVP_GATES.slice(0, -1));
    evidence.push({
      gate: "frozen-readiness-campaign",
      status: "failed",
      summary: "The joined campaign found a failure.",
      artifactReferences: ["report://failed-campaign"],
    });
    expect(assessControlledPilotMvp(evidence)).toMatchObject({
      ready: false,
      missing: [],
      failed: ["frozen-readiness-campaign"],
    });
  });

  it("rejects unsupported evidence laundering", () => {
    expect(() => assessControlledPilotMvp([
      {
        gate: "claim-boundary",
        status: "passed",
        summary: "Claim boundary documented.",
        artifactReferences: [],
      },
    ])).toThrow(/artifact reference/i);
  });
});
