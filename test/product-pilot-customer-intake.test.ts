import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { adapterIntakeFromCustomerIntake, assessPilotCustomerIntake, pilotCustomerIntakeSchema } from "../src/product/pilot-customer-intake.js";

const intake = pilotCustomerIntakeSchema.parse(JSON.parse(fs.readFileSync(path.resolve("examples/pilot-customer-intake.example.json"), "utf8")));

describe("customer intake and onboarding gates", () => {
  it("separates discovery/reproduction readiness from adapter and paid-pilot readiness", () => {
    expect(assessPilotCustomerIntake(intake)).toEqual({ discoveryReady: true, reproductionReady: true, adapterScaffoldReady: false, paidPilotDiscussionReady: false, missing: ["adapter-scaffold-input", "paid-pilot-commercial-path"] });
  });

  it("refuses to create an adapter input until aliases and technical draft exist", () => {
    expect(() => adapterIntakeFromCustomerIntake(intake)).toThrow(/cannot create an adapter scaffold/);
  });
});
