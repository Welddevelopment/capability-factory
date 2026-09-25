import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EFFECTIVE_UNIVERSALITY_DEVELOPMENT_GATE_V1,
  validateEffectiveUniversalityDevelopmentGate,
} from "../src/product/effective-universality-development-gate.js";

describe("frozen effective-universality development gate", () => {
  it("covers every enabled family and mandatory safety concern without claiming representativeness", () => {
    const validated = validateEffectiveUniversalityDevelopmentGate();
    expect(EFFECTIVE_UNIVERSALITY_DEVELOPMENT_GATE_V1).toMatchObject({
      representative: false,
      targetClaim: "development-gate-only",
    });
    expect(validated.enabledFamilies).toHaveLength(8);
    expect(validated.concerns).toHaveLength(10);
    expect(validated.files.every((file) => existsSync(file))).toBe(true);
    expect(EFFECTIVE_UNIVERSALITY_DEVELOPMENT_GATE_V1.entries.every((entry) => entry.boundary.length > 20)).toBe(true);
  });
});
