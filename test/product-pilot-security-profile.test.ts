import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assessPilotSandboxSecurity, pilotSecurityProfileSchema } from "../src/product/pilot-security-profile.js";

const profile = pilotSecurityProfileSchema.parse(JSON.parse(fs.readFileSync(path.resolve("examples/pilot-security-profile.example.json"), "utf8")));

describe("customer sandbox security profile", () => {
  it("fails closed while model disclosure and customer approvals are pending", () => {
    expect(assessPilotSandboxSecurity(profile)).toEqual({ ready: false, blockers: ["model-context-not-approved", "model-disclosure-incomplete", "customer-security-approvals"] });
  });

  it("becomes ready only after exact disclosure and every customer approval", () => {
    const agreed = { ...profile,
      model: { ...profile.model, provider: "customer-approved-provider", modelId: "customer-approved-model", providerRetentionStatement: "Customer reviewed the provider API retention and data-use terms on the recorded date.", customerApproved: true },
      customerApprovals: { technical: true, security: true, dataOwner: true, incidentOwner: true } };
    expect(assessPilotSandboxSecurity(agreed)).toEqual({ ready: true, blockers: [] });
  });
});
