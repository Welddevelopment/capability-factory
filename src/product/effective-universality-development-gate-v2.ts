import { DEFAULT_RUNTIME_FAMILY_REGISTRY, type RuntimeFamily } from "./universal-capability-contract.js";
import {
  EFFECTIVE_UNIVERSALITY_DEVELOPMENT_GATE_V1,
  type EffectiveUniversalityConcern,
  type EffectiveUniversalityDevelopmentGateEntry,
} from "./effective-universality-development-gate.js";

/**
 * Additive gate: v1 remains frozen, while v2 makes the compiler, verified
 * artifact flow and the deeper browser/file parity work impossible to omit
 * silently from future local confirmation.
 */
export const EFFECTIVE_UNIVERSALITY_DEVELOPMENT_GATE_V2 = {
  schemaVersion: "2.0" as const,
  gateId: "effective-universality-development-gate-v2",
  frozenAt: "2026-08-12",
  representative: false,
  targetClaim: "development-gate-only",
  entries: [
    ...EFFECTIVE_UNIVERSALITY_DEVELOPMENT_GATE_V1.entries,
    {
      file: "test/runtime-family-parity.test.ts",
      families: ["service-api", "browser-web", "file-object-edi", "message-event", "document-media", "database-query", "trusted-tool-code", "agent-service-delegation"],
      concerns: ["claim-accounting"],
      boundary: "Evidence-referenced local parity accounting; levels are not product or reliability claims.",
    },
    {
      file: "test/capability-resolution-compiler.test.ts",
      families: ["service-api", "browser-web", "file-object-edi", "message-event", "document-media", "database-query", "trusted-tool-code", "agent-service-delegation"],
      concerns: ["ordinary-goal", "route-selection", "authority", "composition", "outcome-verification"],
      boundary: "Deterministic trusted-primitive graph compilation only; no arbitrary model planning claim.",
    },
    {
      file: "test/verified-artifact-flow.test.ts",
      families: ["service-api", "browser-web", "file-object-edi", "message-event", "document-media", "database-query", "trusted-tool-code", "agent-service-delegation"],
      concerns: ["composition", "durability", "outcome-verification"],
      boundary: "Customer-local typed artifact binding; no distributed data plane or secret transport claim.",
    },
    {
      file: "test/real-browser-pilot-acceptance.test.ts",
      families: ["browser-web"],
      concerns: ["authority", "pre-use-verification", "outcome-verification", "recovery", "retention", "durability"],
      boundary: "Disposable local Chromium ten-case acceptance; not arbitrary-site or customer evidence.",
    },
    {
      file: "test/real-browser-discovery.test.ts",
      families: ["browser-web"],
      concerns: ["route-selection", "authority", "pre-use-verification", "outcome-verification", "recovery", "retention"],
      boundary: "Bounded semantic-control discovery and repair inside a trusted local navigation boundary.",
    },
    {
      file: "test/file-transfer-adapter-factory.test.ts",
      families: ["file-object-edi"],
      concerns: ["route-selection", "authority", "pre-use-verification"],
      boundary: "Reviewed metadata scaffolds two supported file contracts; it does not infer arbitrary formats.",
    },
    {
      file: "test/experimental-file-transfer-pilot-acceptance.test.ts",
      families: ["file-object-edi"],
      concerns: ["authority", "pre-use-verification", "outcome-verification", "recovery", "retention", "durability"],
      boundary: "Disposable local X12/EDIFACT ten-case acceptance; not a partner network or customer deployment.",
    },
  ] satisfies EffectiveUniversalityDevelopmentGateEntry[],
};

export function validateEffectiveUniversalityDevelopmentGateV2(): {
  files: string[];
  enabledFamilies: RuntimeFamily[];
  concerns: EffectiveUniversalityConcern[];
} {
  const entries = EFFECTIVE_UNIVERSALITY_DEVELOPMENT_GATE_V2.entries;
  const files = entries.map((entry) => entry.file);
  if (new Set(files).size !== files.length) throw new Error("Effective-universality v2 gate contains duplicate files.");
  const v1Files = new Set(EFFECTIVE_UNIVERSALITY_DEVELOPMENT_GATE_V1.entries.map((entry) => entry.file));
  if ([...v1Files].some((file) => !files.includes(file))) throw new Error("Effective-universality v2 gate cannot remove a frozen v1 entry.");
  const enabledFamilies = DEFAULT_RUNTIME_FAMILY_REGISTRY.filter((item) => item.enabled).map((item) => item.family);
  const coveredFamilies = new Set(entries.flatMap((entry) => entry.families));
  const missingFamilies = enabledFamilies.filter((family) => !coveredFamilies.has(family));
  if (missingFamilies.length > 0) throw new Error(`Effective-universality v2 gate is missing families: ${missingFamilies.join(", ")}`);
  const concerns: EffectiveUniversalityConcern[] = ["ordinary-goal", "route-selection", "authority", "pre-use-verification", "outcome-verification", "recovery", "retention", "composition", "durability", "claim-accounting"];
  const coveredConcerns = new Set(entries.flatMap((entry) => entry.concerns));
  const missingConcerns = concerns.filter((concern) => !coveredConcerns.has(concern));
  if (missingConcerns.length > 0) throw new Error(`Effective-universality v2 gate is missing concerns: ${missingConcerns.join(", ")}`);
  if (EFFECTIVE_UNIVERSALITY_DEVELOPMENT_GATE_V2.representative !== false) throw new Error("The v2 development gate must remain non-representative.");
  return { files, enabledFamilies, concerns };
}
