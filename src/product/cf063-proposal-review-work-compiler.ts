import { createHash } from "node:crypto";
import { loadCf010Benchmark, preflightCf010Case, scoreSingleCf010Execution, type Cf010ModelProposal } from "./cf010-adapter-verifier-model-benchmark.js";
import type { OnboardingPreparationReceipt } from "./onboarding-preparation-workflow.js";

const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value !== null && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);
const digest = (value: unknown): string => createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
const unique = (values: string[]): string[] => [...new Set(values)].sort();

export interface Cf063ReviewTask {
  taskId: string;
  owner: "customer-role-owner" | "workspace-admin" | "platform-engineer" | "independent-verifier";
  state: "required-not-complete";
  description: string;
  grantsAuthority: false;
  countsAsEvidence: false;
}

export interface Cf063ReviewWorkPack {
  schemaVersion: "1.0";
  checkpointId: "CF-063";
  campaignId: string;
  sealDigest: string;
  caseId: string;
  sourceMaterialDigest: string;
  proposalDigest: string;
  proposalProvenance: "model-or-provider-proposal-untrusted";
  proposalScore: number;
  benchmarkCasePassed: boolean;
  readiness: "review-required" | "blocked";
  executable: false;
  writeAuthorized: false;
  activation: "blocked";
  actionOperationKeys: string[];
  observerOperationKeys: string[];
  credentialAliases: string[];
  verifier: Cf010ModelProposal["verifier"];
  clarifyingQuestions: string[];
  proposalBlockers: string[];
  mandatoryProductBlockers: string[];
  tasks: Cf063ReviewTask[];
  claimBoundary: string;
  workPackDigest: string;
}

export interface Cf063OnboardingReviewProjection extends OnboardingPreparationReceipt {
  sourceCheckpoint: "CF-063";
  sourceWorkPackDigest: string;
  sourceProposalDigest: string;
  benchmarkCasePassed: boolean;
}

function tasks(proposal: Cf010ModelProposal): Cf063ReviewTask[] {
  const values: Array<Omit<Cf063ReviewTask, "state" | "grantsAuthority" | "countsAsEvidence">> = [
    { taskId: "confirm-operation-semantics", owner: "customer-role-owner", description: "Confirm every selected action and observation matches the intended business workflow." },
    { taskId: "resolve-credential-aliases", owner: "workspace-admin", description: "Resolve alias names customer-locally without exposing credential values to the proposal." },
    { taskId: "compile-explicit-authority", owner: "workspace-admin", description: "Define exact targets, writes, limits, approvals, retry policy and handoff owner." },
    { taskId: "implement-action-binding", owner: "platform-engineer", description: "Compile and probe the bounded action binding against approved source material." },
    { taskId: "implement-independent-observer", owner: "platform-engineer", description: proposal.verifier.status === "blocked" ? "Supply the missing independent observation surface before any write can qualify." : "Implement a separately authenticated read-only observer for the proposed predicates." },
    { taskId: "qualify-verifier-negative-controls", owner: "independent-verifier", description: "Run completed, partial, incorrect, duplicate, collateral, stale, unknown and lost-response controls." },
    { taskId: "run-mandatory-acceptance", owner: "independent-verifier", description: "Execute the mandatory acceptance contract; declarations are not passing evidence." },
    { taskId: "review-activation-separately", owner: "workspace-admin", description: "Consider activation only from separately accepted customer-environment evidence." },
  ];
  return values.map((item) => ({ ...item, state: "required-not-complete", grantsAuthority: false, countsAsEvidence: false }));
}

export function compileCf063ProposalReviewWorkPack(input: { benchmarkDirectory: string; caseId: string; proposal: Cf010ModelProposal }): Cf063ReviewWorkPack {
  const bundle = loadCf010Benchmark(input.benchmarkDirectory);
  const item = bundle.campaign.cases.find((candidate) => candidate.caseId === input.caseId);
  if (!item) throw new Error(`Unknown CF-063 benchmark case ${input.caseId}.`);
  if (!preflightCf010Case(bundle, input.caseId).providerAllowed) throw new Error("Preflight-rejected material cannot enter CF-063 proposal review.");
  const score = scoreSingleCf010Execution(bundle, { caseId: input.caseId, providerCalled: true, proposal: input.proposal });
  if (score.hardSafetyFailures.length > 0) throw new Error(`Unsafe proposal cannot enter review: ${score.hardSafetyFailures.join(", ")}`);
  const sourceMaterial = bundle.materials.get(input.caseId);
  const mandatoryProductBlockers = unique([
    "customer-operation-confirmation-required", "credential-values-unresolved", "authority-unconfigured",
    "action-binding-unimplemented", "independent-observer-unqualified", "verifier-negative-controls-not-run",
    "mandatory-acceptance-not-run", "customer-environment-conformance-not-run", "activation-not-authorized",
  ]);
  const body = {
    schemaVersion: "1.0" as const, checkpointId: "CF-063" as const, campaignId: bundle.campaign.campaignId,
    sealDigest: bundle.seal.sealDigest, caseId: input.caseId, sourceMaterialDigest: digest(sourceMaterial), proposalDigest: digest(input.proposal),
    proposalProvenance: "model-or-provider-proposal-untrusted" as const, proposalScore: score.score, benchmarkCasePassed: score.passed,
    readiness: input.proposal.verifier.status === "blocked" || input.proposal.actionOperationKeys.length === 0 ? "blocked" as const : "review-required" as const,
    executable: false as const, writeAuthorized: false as const, activation: "blocked" as const,
    actionOperationKeys: [...input.proposal.actionOperationKeys], observerOperationKeys: [...input.proposal.observerOperationKeys], credentialAliases: [...input.proposal.credentialAliases],
    verifier: structuredClone(input.proposal.verifier), clarifyingQuestions: [...input.proposal.clarifyingQuestions], proposalBlockers: [...input.proposal.blockers], mandatoryProductBlockers,
    tasks: tasks(input.proposal),
    claimBoundary: "Review work only. Provider output remains an untrusted proposal and grants no authority, execution, verification, acceptance or activation evidence.",
  };
  return { ...body, workPackDigest: digest(body) };
}

export function assertCf063ReviewWorkPackIntegrity(pack: Cf063ReviewWorkPack, proposal: Cf010ModelProposal): void {
  const { workPackDigest, ...body } = pack;
  if (digest(body) !== workPackDigest || digest(proposal) !== pack.proposalDigest) throw new Error("CF-063 work pack or source proposal failed its integrity check.");
  if (pack.executable !== false || pack.writeAuthorized !== false || pack.activation !== "blocked" || pack.tasks.some((task) => task.grantsAuthority || task.countsAsEvidence || task.state !== "required-not-complete")) throw new Error("CF-063 work pack widened proposal authority or evidence.");
}

/**
 * Re-opens the frozen benchmark rather than trusting only the identities copied
 * into the work pack. This prevents a valid proposal/work-pack pair from being
 * presented against replaced source material or a different campaign seal.
 */
export function assertCf063ReviewWorkPackAgainstBenchmark(input: {
  benchmarkDirectory: string;
  pack: Cf063ReviewWorkPack;
  proposal: Cf010ModelProposal;
}): void {
  assertCf063ReviewWorkPackIntegrity(input.pack, input.proposal);
  const bundle = loadCf010Benchmark(input.benchmarkDirectory);
  const item = bundle.campaign.cases.find((candidate) => candidate.caseId === input.pack.caseId);
  if (!item) throw new Error("CF-063 work pack case is absent from the current benchmark.");
  const material = bundle.materials.get(input.pack.caseId);
  if (
    input.pack.campaignId !== bundle.campaign.campaignId
    || input.pack.sealDigest !== bundle.seal.sealDigest
    || input.pack.sourceMaterialDigest !== digest(material)
  ) throw new Error("CF-063 work pack is stale or does not match the current benchmark source and seal.");
}

/**
 * Projects model/provider output into the same review vocabulary used by the
 * durable onboarding workflow. It deliberately does not create a full adapter,
 * verifier, authority contract, acceptance plan, execution plan, or activation.
 */
export function projectCf063OnboardingReview(pack: Cf063ReviewWorkPack): Cf063OnboardingReviewProjection {
  const implementationWorkRemaining = unique([
    ...pack.proposalBlockers,
    ...pack.mandatoryProductBlockers,
    ...pack.tasks.map((task) => task.description),
  ]);
  return {
    sourceCheckpoint: "CF-063",
    sourceWorkPackDigest: pack.workPackDigest,
    sourceProposalDigest: pack.proposalDigest,
    benchmarkCasePassed: pack.benchmarkCasePassed,
    readiness: pack.readiness,
    activation: "not-activated",
    adapterProposalState: "proposal-only",
    verifierState: pack.verifier.status === "blocked" ? "blocked" : "provisional-review-required",
    authorityState: "blocked",
    acceptanceState: "not-generated",
    suppliedByCustomerOrEngineer: [
      "approved source material represented by the frozen benchmark input",
      "bounded workflow and observable outcome represented by the frozen benchmark case",
    ],
    generatedByCapabilityFactory: [
      "untrusted operation, credential-alias and verifier proposal",
      "integrity-bound review tasks and explicit remaining blockers",
    ],
    confirmationsRequired: pack.readiness === "blocked"
      ? ["resolve the proposal's exact blockers before adapter, verifier and authority review"]
      : pack.tasks.map((task) => `${task.owner}: ${task.description}`),
    implementationWorkRemaining,
    evidenceBoundary: "This projection is preparation-only. It grants no authority, contains no executable adapter or observer, proves no acceptance case, and activates nothing.",
  };
}
