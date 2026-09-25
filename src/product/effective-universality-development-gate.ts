import { DEFAULT_RUNTIME_FAMILY_REGISTRY, type RuntimeFamily } from "./universal-capability-contract.js";

export type EffectiveUniversalityConcern =
  | "ordinary-goal"
  | "route-selection"
  | "authority"
  | "pre-use-verification"
  | "outcome-verification"
  | "recovery"
  | "retention"
  | "composition"
  | "durability"
  | "claim-accounting";

export interface EffectiveUniversalityDevelopmentGateEntry {
  file: string;
  families: RuntimeFamily[];
  concerns: EffectiveUniversalityConcern[];
  boundary: string;
}

/**
 * Frozen, zero-cost local development gate. This is a committed list rather
 * than a test-file glob so a new or failing mode cannot silently disappear
 * from the denominator. Passing it is not a population reliability result.
 */
export const EFFECTIVE_UNIVERSALITY_DEVELOPMENT_GATE_V1 = {
  schemaVersion: "1.0" as const,
  gateId: "effective-universality-development-gate-v1",
  frozenAt: "2026-08-05",
  representative: false,
  targetClaim: "development-gate-only",
  entries: [
    {
      file: "test/broad-goal-capability-layer.test.ts",
      families: ["service-api"],
      concerns: ["ordinary-goal", "authority", "outcome-verification", "retention"],
      boundary: "Deterministic local constrained-HTTP broad-goal behavior.",
    },
    {
      file: "test/customer-world-transfer.test.ts",
      families: ["service-api"],
      concerns: ["pre-use-verification", "outcome-verification", "recovery"],
      boundary: "Fictional local HTTP transfer world; not a customer system.",
    },
    {
      file: "test/experimental-browser-driver.test.ts",
      families: ["browser-web"],
      concerns: ["authority", "pre-use-verification", "outcome-verification", "recovery", "retention"],
      boundary: "Bounded local browser driver only; not arbitrary-site operation.",
    },
    {
      file: "test/experimental-file-transfer-driver.test.ts",
      families: ["file-object-edi"],
      concerns: ["authority", "pre-use-verification", "outcome-verification", "recovery", "retention"],
      boundary: "Bounded local file/EDI contract only; not general EDI transport.",
    },
    {
      file: "test/experimental-network-file-transfer.test.ts",
      families: ["file-object-edi"],
      concerns: ["authority", "outcome-verification", "recovery"],
      boundary: "Authenticated disposable network-shaped file transport.",
    },
    {
      file: "test/experimental-inbox-message-driver.test.ts",
      families: ["message-event"],
      concerns: ["authority", "pre-use-verification", "outcome-verification", "recovery", "retention"],
      boundary: "Bounded signed local message ingress; not general email or messaging.",
    },
    {
      file: "test/experimental-document-loop.test.ts",
      families: ["document-media"],
      concerns: ["ordinary-goal", "pre-use-verification", "outcome-verification", "retention"],
      boundary: "Pinned machine-readable PDF layouts only; no arbitrary PDF or OCR claim.",
    },
    {
      file: "test/experimental-document-table-layout.test.ts",
      families: ["document-media"],
      concerns: ["pre-use-verification", "outcome-verification"],
      boundary: "Second pinned layout guards against one-layout overfitting only.",
    },
    {
      file: "test/experimental-database-capability.test.ts",
      families: ["database-query"],
      concerns: ["route-selection", "authority", "pre-use-verification", "outcome-verification", "recovery", "retention"],
      boundary: "Reviewed operations only; arbitrary SQL is explicitly outside scope.",
    },
    {
      file: "test/experimental-database-real-sqlite.test.ts",
      families: ["database-query"],
      concerns: ["outcome-verification", "recovery"],
      boundary: "Disposable local SQLite world; not a production database.",
    },
    {
      file: "test/experimental-trusted-tool-sandbox.test.ts",
      families: ["trusted-tool-code"],
      concerns: ["route-selection", "authority", "pre-use-verification", "outcome-verification", "recovery", "retention"],
      boundary: "Pinned import-free WebAssembly only; no host access or arbitrary packages.",
    },
    {
      file: "test/experimental-agent-delegation.test.ts",
      families: ["agent-service-delegation"],
      concerns: ["route-selection", "authority", "pre-use-verification", "outcome-verification", "recovery", "retention"],
      boundary: "One pinned signed local delegate; signed self-report is not outcome proof.",
    },
    {
      file: "test/universal-goal-preparation.test.ts",
      families: ["service-api", "browser-web", "file-object-edi", "message-event", "document-media", "database-query", "trusted-tool-code", "agent-service-delegation"],
      concerns: ["ordinary-goal", "route-selection", "authority"],
      boundary: "Planner selects trusted keys only; trusted local code owns capabilities and authority.",
    },
    {
      file: "test/universal-capability-coordinator.test.ts",
      families: ["service-api", "browser-web", "file-object-edi", "message-event", "document-media", "database-query", "trusted-tool-code", "agent-service-delegation"],
      concerns: ["route-selection", "authority", "pre-use-verification", "outcome-verification", "recovery", "retention"],
      boundary: "Cross-mode coordinator contract; mode evidence remains separate.",
    },
    {
      file: "test/universal-verifier.test.ts",
      families: ["service-api", "browser-web", "file-object-edi", "message-event", "document-media", "database-query", "trusted-tool-code", "agent-service-delegation"],
      concerns: ["outcome-verification", "claim-accounting"],
      boundary: "Declarative verifier independence and fail-closed accounting.",
    },
    {
      file: "test/universal-composition-real-modes.test.ts",
      families: ["trusted-tool-code", "database-query"],
      concerns: ["composition", "authority", "outcome-verification", "retention"],
      boundary: "One genuine local two-family composition; not general dataflow.",
    },
    {
      file: "test/universal-composition-preparation.test.ts",
      families: ["service-api", "trusted-tool-code", "database-query"],
      concerns: ["ordinary-goal", "route-selection", "authority", "composition"],
      boundary: "Trusted predeclared DAG selection; no arbitrary generated workflow graph.",
    },
    {
      file: "test/universal-composition-jobs.test.ts",
      families: ["trusted-tool-code", "database-query"],
      concerns: ["composition", "durability", "recovery", "outcome-verification"],
      boundary: "Customer-local exact-plan durability; not distributed execution.",
    },
    {
      file: "test/universal-benchmark.test.ts",
      families: ["service-api", "browser-web", "database-query", "trusted-tool-code"],
      concerns: ["claim-accounting", "composition"],
      boundary: "Benchmark accounting only; synthetic examples do not establish representativeness.",
    },
  ] satisfies EffectiveUniversalityDevelopmentGateEntry[],
};

export function validateEffectiveUniversalityDevelopmentGate(): {
  files: string[];
  enabledFamilies: RuntimeFamily[];
  concerns: EffectiveUniversalityConcern[];
} {
  const entries = EFFECTIVE_UNIVERSALITY_DEVELOPMENT_GATE_V1.entries;
  const files = entries.map((entry) => entry.file);
  if (new Set(files).size !== files.length) throw new Error("The effective-universality development gate contains duplicate test files.");
  const enabledFamilies = DEFAULT_RUNTIME_FAMILY_REGISTRY.filter((item) => item.enabled).map((item) => item.family);
  const coveredFamilies = new Set(entries.flatMap((entry) => entry.families));
  const missingFamilies = enabledFamilies.filter((family) => !coveredFamilies.has(family));
  if (missingFamilies.length > 0) throw new Error(`Development gate is missing enabled families: ${missingFamilies.join(", ")}`);
  const concerns: EffectiveUniversalityConcern[] = [
    "ordinary-goal",
    "route-selection",
    "authority",
    "pre-use-verification",
    "outcome-verification",
    "recovery",
    "retention",
    "composition",
    "durability",
    "claim-accounting",
  ];
  const coveredConcerns = new Set(entries.flatMap((entry) => entry.concerns));
  const missingConcerns = concerns.filter((concern) => !coveredConcerns.has(concern));
  if (missingConcerns.length > 0) throw new Error(`Development gate is missing concerns: ${missingConcerns.join(", ")}`);
  if (EFFECTIVE_UNIVERSALITY_DEVELOPMENT_GATE_V1.representative !== false) {
    throw new Error("The current development gate must not be marked representative.");
  }
  return { files, enabledFamilies, concerns };
}
