import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assessPilotEngagement, pilotEngagementSchema, type PilotEngagement } from "../src/product/pilot-engagement.js";
import { CUSTOMER_PILOT_ACTIVATION_GATES } from "../src/product/pilot-readiness.js";

const example = pilotEngagementSchema.parse(JSON.parse(fs.readFileSync(path.resolve("examples/pilot-engagement.example.json"), "utf8")));

describe("pilot offer and activation decision", () => {
  it("allows a qualified synthetic reproduction but refuses customer activation", () => {
    expect(assessPilotEngagement(example)).toMatchObject({ discoveryReady: true, reproductionReady: true, activationReady: false });
  });

  it("requires every customer gate, owner, agreed term, and representativeness confirmation", () => {
    const active: PilotEngagement = { ...example, status: "agreed", phase: "customer-sandbox",
      environment: { ...example.environment, kind: "customer-sandbox" },
      owners: { technical: "technical-owner", economic: "economic-owner", security: "security-owner", incident: "incident-owner" },
      commercial: { setup: { ...example.commercial.setup, status: "customer-agreed" }, recurring: { ...example.commercial.recurring, status: "customer-agreed" }, paymentPathConfirmed: true, contractingPathConfirmed: true },
      successCriteria: { ...example.successCriteria, customerConfirmsRepresentative: true },
      activationEvidence: CUSTOMER_PILOT_ACTIVATION_GATES.map((gate) => ({ gate, status: "passed", summary: `${gate} passed.`, artifactReferences: [`evidence/${gate}.json`] })),
    };
    expect(assessPilotEngagement(active)).toEqual({ discoveryReady: true, reproductionReady: true, activationReady: true, blockers: [] });
  });

  it("cannot call hypothesis pricing customer-agreed by changing only engagement status", () => {
    expect(assessPilotEngagement({ ...example, status: "agreed" }).blockers).toContain("commercial-and-contracting-path");
  });
});
