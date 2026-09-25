import { describe, expect, it } from "vitest";
import { ProcurementBuildReuseAdapter } from "../src/customer-world/reliability-procurement-adapter.js";

describe("procurement reliability adapter", () => {
  it("binds the versioned R3 case", () => {
    expect(new ProcurementBuildReuseAdapter()).toMatchObject({
      id: "R3",
      version: "procurement-reliability-adapter-v1",
    });
  });

  it("precommits separate fixtures and the exact safe procurement sequence", () => {
    const checks = new ProcurementBuildReuseAdapter().preflight();
    expect(checks).toHaveLength(2);
    expect(checks.every((check) => check.passed)).toBe(true);
    expect(checks.map((check) => check.id)).toEqual(["case-contracts", "exact-action-sequence"]);
  });
});
