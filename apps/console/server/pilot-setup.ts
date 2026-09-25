import { assessPilotContractingReadiness, pilotContractingReadinessSchema, type PilotContractingReadiness } from "../../../src/product/pilot-contracting-readiness.js";
import { assessPilotCustomerIntake, pilotCustomerIntakeSchema, type PilotCustomerIntake } from "../../../src/product/pilot-customer-intake.js";
import { assessPilotEngagement, pilotEngagementSchema, type PilotEngagement } from "../../../src/product/pilot-engagement.js";
import { assessPilotSandboxSecurity, pilotSecurityProfileSchema, type PilotSecurityProfile } from "../../../src/product/pilot-security-profile.js";

export interface ConsolePilotSetupInputs {
  engagement?: PilotEngagement;
  customerIntake?: PilotCustomerIntake;
  securityProfile?: PilotSecurityProfile;
  contractingReadiness?: PilotContractingReadiness;
  packageReadiness?: {
    ready: boolean;
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };
  acceptance?: {
    passed: boolean;
    caseCount: number;
    incorrectSideEffects: number;
    artifactReferences: string[];
  };
  evidenceExports?: Array<{ label: string; createdAt: string; sha256: string }>;
  capabilityHealth?: { checkedAt: string; checked: number; healthy: number; quarantined: number };
}

export interface ConsolePilotSetupRuntime {
  operationalMode: "running" | "draining" | "halted";
  auditPassed: boolean;
  openHandoffs: number;
  activeCapabilities: number;
  quarantinedCapabilities: number;
}

function gate(id: string, title: string, configured: boolean, passed: boolean, blockers: string[], detail: string) {
  return { id, title, configured, status: passed ? "passed" as const : configured ? "blocked" as const : "not-configured" as const, blockers, detail };
}

export function projectPilotSetup(inputs: ConsolePilotSetupInputs | undefined, runtime: ConsolePilotSetupRuntime) {
  const engagement = inputs?.engagement ? assessPilotEngagement(pilotEngagementSchema.parse(inputs.engagement)) : undefined;
  const intake = inputs?.customerIntake ? assessPilotCustomerIntake(pilotCustomerIntakeSchema.parse(inputs.customerIntake)) : undefined;
  const security = inputs?.securityProfile ? assessPilotSandboxSecurity(pilotSecurityProfileSchema.parse(inputs.securityProfile)) : undefined;
  const contracting = inputs?.contractingReadiness ? assessPilotContractingReadiness(pilotContractingReadinessSchema.parse(inputs.contractingReadiness)) : undefined;
  const acceptancePassed = inputs?.acceptance?.passed === true
    && inputs.acceptance.caseCount >= 10
    && inputs.acceptance.incorrectSideEffects === 0
    && inputs.acceptance.artifactReferences.length > 0;
  const packagePassed = inputs?.packageReadiness?.ready === true && inputs.packageReadiness.checks.length > 0
    && inputs.packageReadiness.checks.every((check) => check.passed);

  const gates = [
    gate("workflow", "Qualified workflow", Boolean(intake), intake?.reproductionReady === true,
      intake?.missing ?? ["customer-intake-not-configured"], "A recent HTTP blocker, resettable safe environment, trusted documentation, exact authority and independent success checks."),
    gate("security", "Security boundary", Boolean(security), security?.ready === true,
      security?.blockers ?? ["security-profile-not-configured"], "Customer-local execution, credential aliases, approved model context, retention and named incident owners."),
    gate("contracting", "Contract and payment", Boolean(contracting), contracting?.readyToSignAndCollectPayment === true,
      contracting?.blockers ?? ["contracting-readiness-not-configured"], "A legally reviewed contracting, payment, tax, insurance and guardian path; separate from technical readiness."),
    gate("acceptance", "Adapter acceptance", Boolean(inputs?.acceptance), acceptancePassed,
      acceptancePassed ? [] : ["ten-case-executable-acceptance-not-passed"], "All mandatory cases run against disposable state with artifacts and zero surviving incorrect side effects."),
    gate("package", "Customer-local package", Boolean(inputs?.packageReadiness), packagePassed,
      inputs?.packageReadiness?.checks.filter((check) => !check.passed).map((check) => check.id) ?? ["package-readiness-not-run"], "Pinned adapter bytes, private state, localhost boundary, durable queue and healthy customer-local runtime."),
    gate("activation", "Customer activation", Boolean(engagement), engagement?.activationReady === true,
      engagement?.blockers ?? ["pilot-engagement-not-configured"], "Explicit customer agreement, representative workflow, owners, commercial path and all six activation evidence gates."),
  ];
  const activationReady = gates.every((item) => item.status === "passed");
  const configured = gates.filter((item) => item.configured).length;
  const passed = gates.filter((item) => item.status === "passed").length;
  const next = gates.find((item) => item.status !== "passed");

  return {
    posture: "private-alpha-controlled-pilot",
    activationReady,
    summary: { configured, passed, total: gates.length, nextBlocker: next?.title ?? "None" },
    gates,
    runtime,
    evidence: inputs?.evidenceExports ?? [],
    capabilityHealth: inputs?.capabilityHealth ?? null,
    boundary: {
      currentCapabilityMode: "constrained-http-api",
      customerData: "fictional or customer sandbox only",
      productionAccess: false,
      claim: activationReady ? "All configured local gates pass; customer activation still requires an explicit operator decision." : "Not ready for customer activation.",
    },
  };
}
