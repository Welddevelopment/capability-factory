export type OnboardingArtifactState = "not-started" | "proposed" | "review-required" | "confirmed" | "blocked";

export interface OnboardingArtifactSummary {
  state: OnboardingArtifactState;
  summary: string;
  blockers: string[];
  provenance?: {
    observed: number;
    extracted: number;
    inferredProposal: number;
    customerConfirmed: number;
    independentlyVerified: number;
    unknown: number;
  };
}

export interface AssistedOnboardingInputs {
  blockedWorkflow?: OnboardingArtifactSummary;
  approvedSystemMaterial?: OnboardingArtifactSummary;
  proposedOperations?: OnboardingArtifactSummary;
  authorityContract?: OnboardingArtifactSummary;
  outcomeContract?: OnboardingArtifactSummary;
  adapterAndVerifier?: OnboardingArtifactSummary;
  acceptancePlan?: OnboardingArtifactSummary;
}

const DEFINITIONS = [
  {
    id: "workflow",
    title: "Describe blocked workflow",
    detail: "Capture the ordinary goal, exact attempted step, observed blocker, required outcome, and stable work identity without granting authority.",
    key: "blockedWorkflow" as const,
  },
  {
    id: "materials",
    title: "Import approved system material",
    detail: "Use local approved OpenAPI, MCP, SDK, or reference material. Record hashes and source provenance; never ingest credential values.",
    key: "approvedSystemMaterial" as const,
  },
  {
    id: "operations",
    title: "Review proposed operations",
    detail: "Inspect targets, read/write classification, request shapes, authentication aliases, retry requirements, and every inferred or unknown fact.",
    key: "proposedOperations" as const,
  },
  {
    id: "authority",
    title: "Confirm authority",
    detail: "Answer ordinary questions about permitted targets, writes, approvals, limits, forbidden actions, handoff owners, and retry policy.",
    key: "authorityContract" as const,
  },
  {
    id: "outcome",
    title: "Define observable completion",
    detail: "Choose an observation path independent from the action response and define complete, partial, incorrect, unknown, duplicate, and collateral states.",
    key: "outcomeContract" as const,
  },
  {
    id: "implementation",
    title: "Resolve implementation blockers",
    detail: "Review the fail-closed adapter and verifier scaffolds, then implement only the customer-specific pieces that cannot be generated safely.",
    key: "adapterAndVerifier" as const,
  },
  {
    id: "acceptance",
    title: "Prepare controlled comparison",
    detail: "Implement and run the ten precommitted cases in disposable state. A generated plan is not executed evidence and cannot activate a pilot.",
    key: "acceptancePlan" as const,
  },
] as const;

function displayStatus(artifact: OnboardingArtifactSummary | undefined): OnboardingArtifactState {
  if (!artifact) return "not-started";
  if (artifact.blockers.length > 0) return "blocked";
  return artifact.state;
}

export function projectAssistedOnboarding(inputs: AssistedOnboardingInputs | undefined) {
  const stages = DEFINITIONS.map((definition, index) => {
    const artifact = inputs?.[definition.key];
    return {
      id: definition.id,
      order: index + 1,
      title: definition.title,
      detail: definition.detail,
      status: displayStatus(artifact),
      summary: artifact?.summary ?? "No reviewed artifact has been attached.",
      blockers: artifact?.blockers ?? ["reviewed-artifact-not-attached"],
      provenance: artifact?.provenance ?? null,
    };
  });
  const completed = stages.filter((stage) => stage.status === "confirmed" && stage.blockers.length === 0).length;
  const blocked = stages.filter((stage) => stage.status === "blocked").length;
  const next = stages.find((stage) => stage.status !== "confirmed");
  const preparationReady = completed === stages.length && blocked === 0
    && stages.every((stage) => stage.blockers.length === 0);
  return {
    posture: "assisted-onboarding-private-alpha",
    preparationReady,
    activated: false,
    summary: {
      completed,
      total: stages.length,
      blocked,
      nextStage: next?.title ?? "Explicit controlled-pilot activation review",
    },
    stages,
    boundary: preparationReady
      ? "Onboarding preparation artifacts are confirmed. This does not prove acceptance passed and does not activate customer access."
      : "Onboarding remains fail-closed until every consequential boundary is explicitly reviewed and confirmed.",
  };
}
