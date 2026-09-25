import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EFFECTIVE_UNIVERSALITY_DEVELOPMENT_GATE_V1 } from "../src/product/effective-universality-development-gate.js";
import { EFFECTIVE_UNIVERSALITY_DEVELOPMENT_GATE_V2, validateEffectiveUniversalityDevelopmentGateV2 } from "../src/product/effective-universality-development-gate-v2.js";

describe("effective-universality development gate v2", () => {
  it("preserves v1 and adds compiler, artifact and parity evidence without claiming representativeness", () => {
    const validated = validateEffectiveUniversalityDevelopmentGateV2();
    const files = new Set(validated.files);
    expect(EFFECTIVE_UNIVERSALITY_DEVELOPMENT_GATE_V1.entries.every((entry) => files.has(entry.file))).toBe(true);
    expect(files.has("test/capability-resolution-compiler.test.ts")).toBe(true);
    expect(files.has("test/experimental-file-transfer-pilot-acceptance.test.ts")).toBe(true);
    expect(validated.files.every(existsSync)).toBe(true);
    expect(EFFECTIVE_UNIVERSALITY_DEVELOPMENT_GATE_V2.representative).toBe(false);
  });
});
