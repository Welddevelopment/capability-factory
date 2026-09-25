import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assessPilotContractingReadiness, pilotContractingReadinessSchema } from "../src/product/pilot-contracting-readiness.js";

const readiness = pilotContractingReadinessSchema.parse(JSON.parse(fs.readFileSync(path.resolve("examples/pilot-contracting-readiness.example.json"), "utf8")));

describe("under-18 contracting and payment readiness", () => {
  it("fails closed while adult authority, advisers, money, documents, insurance, and education plans are unresolved", () => {
    const result = assessPilotContractingReadiness(readiness);
    expect(result.readyToSignAndCollectPayment).toBe(false);
    expect(result.blockers).toEqual(["parent-or-guardian-involvement", "professional-uk-advice", "contracting-party-and-signatory", "intellectual-property-terms", "banking-payment-and-tax", "customer-legal-documents", "insurance-assessment", "education-and-work-plan"]);
  });
});
