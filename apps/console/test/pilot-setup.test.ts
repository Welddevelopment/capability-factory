import { describe, expect, it } from "vitest";
import engagementJson from "../../../examples/pilot-engagement.example.json" with { type: "json" };
import intakeJson from "../../../examples/pilot-customer-intake.example.json" with { type: "json" };
import securityJson from "../../../examples/pilot-security-profile.example.json" with { type: "json" };
import contractingJson from "../../../examples/pilot-contracting-readiness.example.json" with { type: "json" };
import { pilotEngagementSchema } from "../../../src/product/pilot-engagement.js";
import { pilotCustomerIntakeSchema } from "../../../src/product/pilot-customer-intake.js";
import { pilotSecurityProfileSchema } from "../../../src/product/pilot-security-profile.js";
import { pilotContractingReadinessSchema } from "../../../src/product/pilot-contracting-readiness.js";
import { projectPilotSetup } from "../server/pilot-setup.js";

describe("pilot setup projection", () => {
  it("combines the real readiness documents without turning partial preparation into activation", () => {
    const projected = projectPilotSetup({
      engagement: pilotEngagementSchema.parse(engagementJson),
      customerIntake: pilotCustomerIntakeSchema.parse(intakeJson),
      securityProfile: pilotSecurityProfileSchema.parse(securityJson),
      contractingReadiness: pilotContractingReadinessSchema.parse(contractingJson),
      acceptance: { passed: true, caseCount: 10, incorrectSideEffects: 0, artifactReferences: ["private://acceptance/report"] },
      packageReadiness: { ready: true, checks: [{ id: "adapter-runtime", passed: true, detail: "Pinned bytes match." }] },
      evidenceExports: [{ label: "Sanitized local acceptance", createdAt: "2026-07-29T00:00:00.000Z", sha256: "a".repeat(64) }],
      capabilityHealth: { checkedAt: "2026-07-29T00:00:00.000Z", checked: 1, healthy: 1, quarantined: 0 },
    }, {
      operationalMode: "running", auditPassed: true, openHandoffs: 0, activeCapabilities: 1, quarantinedCapabilities: 0,
    });
    expect(projected.summary).toMatchObject({ configured: 6, passed: 3, total: 6 });
    expect(projected.activationReady).toBe(false);
    expect(projected.gates.find((gate) => gate.id === "acceptance")?.status).toBe("passed");
    expect(projected.gates.find((gate) => gate.id === "package")?.status).toBe("passed");
    expect(projected.gates.find((gate) => gate.id === "security")?.blockers).toContain("model-context-not-approved");
    expect(projected.boundary.productionAccess).toBe(false);
  });
});
