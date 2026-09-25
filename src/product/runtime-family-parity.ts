import { z } from "zod";
import {
  DEFAULT_RUNTIME_FAMILY_REGISTRY,
  runtimeFamilySchema,
  type RuntimeFamily,
} from "./universal-capability-contract.js";

/**
 * A family is not raised to the HTTP reference bar because it has one happy
 * path. The levels below make the transfer, safety and onboarding gaps
 * explicit and prevent a growing mode count from being mistaken for quality.
 */
export const runtimeFamilyParityLevelSchema = z.enum([
  "registered",
  "bounded-loop",
  "hardened-local",
  "transfer-local",
  "onboarding-validated",
]);
export type RuntimeFamilyParityLevel = z.infer<typeof runtimeFamilyParityLevelSchema>;

export const runtimeFamilyParityRequirementSchema = z.enum([
  "complete-capability-bundle",
  "ordinary-goal-entry",
  "no-write-pre-use-probe",
  "explicit-authority-zero-write-stop",
  "independent-external-outcome-observer",
  "incorrect-partial-unknown-rejection",
  "lost-response-reconciliation",
  "duplicate-safe-operation-identity",
  "quarantine-or-revocation",
  "restart-recovery-without-replanning",
  "fresh-process-retained-reuse",
  "customer-local-package-boundary",
  "executed-ten-case-acceptance",
  "second-distinct-system-or-contract",
  "generic-scaffold-or-factory",
  "fresh-engineer-no-author-validation",
]);
export type RuntimeFamilyParityRequirement = z.infer<typeof runtimeFamilyParityRequirementSchema>;

export const RUNTIME_FAMILY_PARITY_LEVEL_REQUIREMENTS: Readonly<
  Record<Exclude<RuntimeFamilyParityLevel, "registered">, readonly RuntimeFamilyParityRequirement[]>
> = {
  "bounded-loop": [
    "complete-capability-bundle",
    "ordinary-goal-entry",
    "no-write-pre-use-probe",
    "explicit-authority-zero-write-stop",
    "independent-external-outcome-observer",
    "incorrect-partial-unknown-rejection",
    "fresh-process-retained-reuse",
  ],
  "hardened-local": [
    "lost-response-reconciliation",
    "duplicate-safe-operation-identity",
    "quarantine-or-revocation",
    "restart-recovery-without-replanning",
    "customer-local-package-boundary",
    "executed-ten-case-acceptance",
  ],
  "transfer-local": [
    "second-distinct-system-or-contract",
    "generic-scaffold-or-factory",
  ],
  "onboarding-validated": [
    "fresh-engineer-no-author-validation",
  ],
} as const;

const boundedText = z.string().trim().min(1).max(2_000);
const evidenceReferenceSchema = z.object({
  path: z.string().trim().min(1).max(500),
  detail: boundedText,
}).strict();

export const runtimeFamilyParityEvidenceSchema = z.object({
  requirement: runtimeFamilyParityRequirementSchema,
  status: z.enum(["demonstrated", "missing", "not-applicable"]),
  evidence: z.array(evidenceReferenceSchema).max(32),
  boundary: boundedText,
}).strict().superRefine((value, context) => {
  if (value.status === "demonstrated" && value.evidence.length === 0) {
    context.addIssue({ code: "custom", message: "Demonstrated parity requirements need at least one evidence reference." });
  }
  if (value.status !== "demonstrated" && value.evidence.length > 0) {
    context.addIssue({ code: "custom", message: "Missing or not-applicable requirements cannot carry passing evidence." });
  }
});
export type RuntimeFamilyParityEvidence = z.infer<typeof runtimeFamilyParityEvidenceSchema>;

export const runtimeFamilyParityProfileSchema = z.object({
  schemaVersion: z.literal("1.0"),
  family: runtimeFamilySchema,
  currentMode: z.string().min(1).max(160),
  assessedAt: z.string().date(),
  target: z.literal("http-reference-quality"),
  evidence: z.array(runtimeFamilyParityEvidenceSchema)
    .length(runtimeFamilyParityRequirementSchema.options.length),
  claimBoundary: boundedText,
}).strict().superRefine((value, context) => {
  const keys = value.evidence.map((item) => item.requirement);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", message: "A parity profile cannot repeat a requirement." });
  }
  for (const required of runtimeFamilyParityRequirementSchema.options) {
    if (!keys.includes(required)) {
      context.addIssue({ code: "custom", message: `Parity profile is missing ${required}.` });
    }
  }
});
export type RuntimeFamilyParityProfile = z.infer<typeof runtimeFamilyParityProfileSchema>;

const LEVEL_ORDER: readonly RuntimeFamilyParityLevel[] = [
  "registered",
  "bounded-loop",
  "hardened-local",
  "transfer-local",
  "onboarding-validated",
];

function requirementsThrough(level: RuntimeFamilyParityLevel): RuntimeFamilyParityRequirement[] {
  const end = LEVEL_ORDER.indexOf(level);
  return LEVEL_ORDER.slice(1, end + 1).flatMap((item) =>
    RUNTIME_FAMILY_PARITY_LEVEL_REQUIREMENTS[item as Exclude<RuntimeFamilyParityLevel, "registered">] ?? []
  );
}

export interface RuntimeFamilyParityAssessment {
  family: RuntimeFamily;
  achievedLevel: RuntimeFamilyParityLevel;
  nextLevel?: RuntimeFamilyParityLevel;
  blockers: Array<{ requirement: RuntimeFamilyParityRequirement; boundary: string }>;
  demonstrated: RuntimeFamilyParityRequirement[];
  claimBoundary: string;
}

export function assessRuntimeFamilyParity(rawProfile: unknown): RuntimeFamilyParityAssessment {
  const profile = runtimeFamilyParityProfileSchema.parse(rawProfile);
  const descriptor = DEFAULT_RUNTIME_FAMILY_REGISTRY.find((item) => item.family === profile.family);
  if (!descriptor?.enabled) throw new Error(`Parity can be assessed only for an enabled runtime family: ${profile.family}.`);
  if (descriptor.currentMode !== profile.currentMode) {
    throw new Error(`Parity mode ${profile.currentMode} does not match registered mode ${descriptor.currentMode ?? "none"}.`);
  }

  const byRequirement = new Map(profile.evidence.map((item) => [item.requirement, item]));
  let achievedLevel: RuntimeFamilyParityLevel = "registered";
  for (const level of LEVEL_ORDER.slice(1)) {
    const satisfied = requirementsThrough(level).every((requirement) => {
      const item = byRequirement.get(requirement);
      return item?.status === "demonstrated" || item?.status === "not-applicable";
    });
    if (!satisfied) break;
    achievedLevel = level;
  }
  const currentIndex = LEVEL_ORDER.indexOf(achievedLevel);
  const nextLevel = LEVEL_ORDER[currentIndex + 1];
  const blockers = nextLevel
    ? requirementsThrough(nextLevel)
      .map((requirement) => byRequirement.get(requirement))
      .filter((item): item is RuntimeFamilyParityEvidence => Boolean(item) && item!.status === "missing")
      .map((item) => ({ requirement: item.requirement, boundary: item.boundary }))
    : [];

  return {
    family: profile.family,
    achievedLevel,
    ...(nextLevel ? { nextLevel } : {}),
    blockers,
    demonstrated: profile.evidence
      .filter((item) => item.status === "demonstrated")
      .map((item) => item.requirement),
    claimBoundary: profile.claimBoundary,
  };
}

export function makeParityEvidence(
  demonstrated: Partial<Record<RuntimeFamilyParityRequirement, { path: string; detail: string }[]>>,
  missingBoundaries: Partial<Record<RuntimeFamilyParityRequirement, string>> = {},
): RuntimeFamilyParityEvidence[] {
  return runtimeFamilyParityRequirementSchema.options.map((requirement) => {
    const evidence = demonstrated[requirement];
    if (evidence) {
      return {
        requirement,
        status: "demonstrated" as const,
        evidence,
        boundary: "Local development evidence only; it is not customer or production validation.",
      };
    }
    return {
      requirement,
      status: "missing" as const,
      evidence: [],
      boundary: missingBoundaries[requirement] ?? `No qualifying evidence is recorded for ${requirement}.`,
    };
  });
}
