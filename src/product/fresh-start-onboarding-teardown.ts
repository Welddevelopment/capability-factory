import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  JsonFileGenericAcceptanceCampaignStore,
  runGenericAcceptanceCampaign,
  type GenericAcceptanceBinding,
  type GenericAcceptanceCampaignSummary,
} from "./generic-acceptance-executor.js";
import { onboardingPreparationDigest, type OnboardingPreparationSnapshot } from "./onboarding-preparation-workflow.js";
import {
  REQUIRED_PILOT_ADAPTER_CASES,
  type PilotAdapterAcceptanceCase,
  type PilotAdapterAcceptanceResult,
} from "./pilot-adapter.js";

export const FRESH_START_ONBOARDING_TEARDOWN_SCHEMA_VERSION = "1.0" as const;

interface BindingDeclarations {
  schemaVersion: "1.0";
  evidenceBoundary: string;
  actionBinding: {
    driverId: string;
    targetAlias: string;
    credentialAlias: string;
    allowedOperations: string[];
    implementationState: string;
  };
  observationBinding: {
    sourceId: string;
    observationKeys: string[];
    independentFromActionBinding: boolean;
    implementationState: string;
  };
  reviewDecisions: {
    operationInventoryReviewed: true;
    authorityBoundaryReviewed: true;
    observableCompletionReviewed: true;
    disposableResetReviewed: true;
    confirmedByAlias: string;
    confirmedAt: string;
  };
}

interface AcceptanceFixtureCase {
  intendedWrites: number;
  checks: string[];
}

interface AcceptanceFixture {
  schemaVersion: "1.0";
  evidenceBoundary: string;
  cases: Record<PilotAdapterAcceptanceCase, AcceptanceFixtureCase>;
}

export interface FreshStartOnboardingTeardownOptions {
  packageDirectory: string;
  outputDirectory: string;
  projectDirectory?: string;
}

export interface FreshStartOnboardingTeardownReport {
  schemaVersion: typeof FRESH_START_ONBOARDING_TEARDOWN_SCHEMA_VERSION;
  rehearsalType: "automated-author-independent-packaging-rehearsal";
  evidenceBoundary: string;
  spendUsd: 0;
  modelCalls: 0;
  fixturePackage: {
    packageDirectory: string;
    intakeDigest: string;
    bindingDeclarationDigest: string;
    actionBindingDigest: string;
    observationBindingDigest: string;
    genericAcceptanceBindingDigest: string;
    acceptanceFixtureDigest: string;
    importedRepositoryHelperFixtures: false;
  };
  measuredJourney: {
    machineWallClockMs: number;
    participantCommands: string[];
    commandCount: number;
    preparationStatus: string;
    acceptanceStatus: string;
    timeToPreparationReadyMs: number;
    timeToAcceptanceCompleteMs: number;
    actualHumanActiveMinutes: null;
    underOneDayClaimSupported: false;
  };
  confirmations: {
    explicitFixtureConfirmations: string[];
    automaticallyDigestBound: string[];
  };
  generatedArtifacts: string[];
  restartAndReuse: {
    preparationReadFromFreshCliProcess: boolean;
    preparationSnapshotDigestStable: boolean;
    acceptanceReloadedFromDurableStore: boolean;
    acceptanceReceiptCountStable: boolean;
    acceptanceAttemptsStable: boolean;
  };
  acceptance: {
    passed: boolean;
    cases: number;
    receipts: number;
    incorrectSideEffects: number;
  };
  customerSpecificWork: {
    executableCustomerCodeWrittenInRehearsal: 0;
    bindingDeclarationLines: number;
    acceptanceFixtureDeclarationLines: number;
    explicitProxy: string;
  };
  authorOnlyStepDisposition: Array<{
    step: string;
    disposition: "automated" | "ordinary-language-decision-artifact" | "precise-blocker";
    detail: string;
  }>;
  preciseRemainingBlockers: Array<{
    blockerId: string;
    requiredWork: string;
    ownerClass: "platform-engineer" | "workspace-admin" | "fresh-human-evaluator";
  }>;
  conclusion: string;
  reportPath: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function countNonBlankLines(filePath: string): number {
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function runPreparationCli(
  projectDirectory: string,
  args: string[],
): { value: unknown; elapsedMs: number; displayCommand: string } {
  const scriptPath = path.join(projectDirectory, "src/product/run-onboarding-preparation.ts");
  const startedAt = performance.now();
  const stdout = execFileSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
    cwd: projectDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const elapsedMs = performance.now() - startedAt;
  return {
    value: JSON.parse(stdout),
    elapsedMs,
    displayCommand: `pnpm product:onboarding:prepare ${args.join(" ")}`,
  };
}

class DeclarativeFixtureAcceptanceBinding implements GenericAcceptanceBinding {
  readonly bindingId = "northstar-fixture-binding";
  readonly bindingVersion = "1.0.0";
  readonly bindingDigest: string;
  readonly caseIds = [...REQUIRED_PILOT_ADAPTER_CASES];

  constructor(
    private readonly fixture: AcceptanceFixture,
    private readonly evidenceDirectory: string,
    bindingDigest: string,
  ) {
    this.bindingDigest = bindingDigest;
  }

  async execute(caseId: PilotAdapterAcceptanceCase): Promise<PilotAdapterAcceptanceResult> {
    const declaration = this.fixture.cases[caseId];
    if (!declaration) throw new Error(`Fixture package did not declare ${caseId}.`);
    const externalStatePath = path.join(this.evidenceDirectory, `${caseId}.external-state.json`);
    const externalState = {
      caseId,
      intendedWrites: declaration.intendedWrites,
      incorrectSideEffects: 0,
      checks: declaration.checks,
      fixtureClassification: caseId === "wrong-or-partial-outcome" ? "partial-rejected" : "expected-case-behavior-observed",
    };
    writeJson(externalStatePath, externalState);
    const independentlyRead = readJson<typeof externalState>(externalStatePath);
    const checks = independentlyRead.checks.map((detail, index) => ({
      id: `fixture-${caseId}-${index + 1}`,
      passed: true,
      detail,
    }));
    checks.push({
      id: `fixture-${caseId}-independent-file-read`,
      passed: independentlyRead.caseId === caseId && independentlyRead.incorrectSideEffects === 0,
      detail: "The rehearsal read the serialized fixture state after the case instead of trusting an action return value.",
    });
    return {
      caseId,
      passed: checks.every((check) => check.passed),
      intendedWrites: independentlyRead.intendedWrites,
      incorrectSideEffects: independentlyRead.incorrectSideEffects,
      checks,
      artifactReferences: [`file://${externalStatePath}`],
      completedAt: "2026-08-14T01:10:00.000Z",
    };
  }
}

function receiptAttempts(summary: GenericAcceptanceCampaignSummary): number[] {
  return summary.state.cases.map((item) => item.attemptCount);
}

export async function runFreshStartOnboardingTeardown(
  options: FreshStartOnboardingTeardownOptions,
): Promise<FreshStartOnboardingTeardownReport> {
  const projectDirectory = path.resolve(options.projectDirectory ?? process.cwd());
  const packageDirectory = path.resolve(options.packageDirectory);
  const outputDirectory = path.resolve(options.outputDirectory);
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });

  const intakePath = path.join(packageDirectory, "intake.json");
  const bindingPath = path.join(packageDirectory, "binding-declarations.json");
  const acceptanceFixturePath = path.join(packageDirectory, "acceptance-fixture.json");
  const statePath = path.join(outputDirectory, "preparation.sqlite");
  const reviewPath = path.join(outputDirectory, "review.json");
  const reportPath = path.join(outputDirectory, "teardown-report.json");
  const acceptanceStateDirectory = path.join(outputDirectory, "acceptance-state");
  const acceptanceEvidenceDirectory = path.join(outputDirectory, "acceptance-evidence");

  const bindings = readJson<BindingDeclarations>(bindingPath);
  const acceptanceFixture = readJson<AcceptanceFixture>(acceptanceFixturePath);
  const commands: string[] = [];
  const overallStartedAt = performance.now();

  const start = runPreparationCli(projectDirectory, ["start", "--state", statePath, "--input", intakePath, "--include-artifacts"]);
  commands.push(start.displayCommand);
  const proposed = start.value as OnboardingPreparationSnapshot;
  if (proposed.status !== "review-required") {
    throw new Error(`Fresh-start fixture did not reach review-required: ${proposed.blockers.join(", ")}`);
  }

  const bindingDeclarationDigest = digest(bindings);
  const actionBindingDigest = digest(bindings.actionBinding);
  const observationBindingDigest = digest(bindings.observationBinding);
  const genericAcceptanceBindingDigest = digest({
    fixtureBindingVersion: "1.0.0",
    bindings,
    acceptanceFixture,
  });
  const review = {
    sessionId: proposed.sessionId,
    expectedInputDigest: proposed.inputDigest,
    expectedSnapshotDigest: proposed.snapshotDigest,
    review: {
      adapterProposalDigest: onboardingPreparationDigest(proposed.adapterProposal),
      verifierContractDigest: onboardingPreparationDigest(proposed.verifierContract),
      authorityCompilationDigest: onboardingPreparationDigest(proposed.authorityCompilation),
      authorityRuntimeBindingDigest: actionBindingDigest,
      observationAdapterBindingDigest: observationBindingDigest,
      confirmedByAlias: bindings.reviewDecisions.confirmedByAlias,
      confirmedAt: bindings.reviewDecisions.confirmedAt,
    },
  };
  writeJson(reviewPath, review);

  const reviewRun = runPreparationCli(projectDirectory, ["review", "--state", statePath, "--input", reviewPath, "--include-artifacts"]);
  commands.push(reviewRun.displayCommand);
  const reviewed = reviewRun.value as OnboardingPreparationSnapshot;
  if (reviewed.status !== "acceptance-scaffold-ready" || !reviewed.acceptancePlan) {
    throw new Error(`Reviewed fixture did not reach acceptance-scaffold-ready: ${reviewed.blockers.join(", ")}`);
  }
  const preparationReadyAt = performance.now();

  const freshStatus = runPreparationCli(projectDirectory, ["status", "--state", statePath, "--session", proposed.sessionId, "--include-artifacts"]);
  commands.push(freshStatus.displayCommand);
  const freshSnapshot = freshStatus.value as OnboardingPreparationSnapshot;
  const events = runPreparationCli(projectDirectory, ["events", "--state", statePath, "--session", proposed.sessionId]);
  commands.push(events.displayCommand);

  const binding = new DeclarativeFixtureAcceptanceBinding(acceptanceFixture, acceptanceEvidenceDirectory, genericAcceptanceBindingDigest);
  const store = new JsonFileGenericAcceptanceCampaignStore(acceptanceStateDirectory);
  const campaignOptions = {
    campaignId: "fresh-start-teardown-campaign",
    declarationDigest: reviewed.acceptancePlan.inputDigest,
    binding,
    store,
    now: () => "2026-08-14T01:10:00.000Z",
  };
  const firstAcceptance = await runGenericAcceptanceCampaign(campaignOptions);
  commands.push("generic acceptance executor: run fixed ten-case campaign");
  if (!firstAcceptance.passed) throw new Error(`Fresh-start acceptance fixture did not complete: ${firstAcceptance.status}`);
  const acceptanceCompleteAt = performance.now();

  const reloadedStore = new JsonFileGenericAcceptanceCampaignStore(acceptanceStateDirectory);
  const secondAcceptance = await runGenericAcceptanceCampaign({ ...campaignOptions, store: reloadedStore });
  commands.push("generic acceptance executor: reload completed campaign from durable state");
  const overallCompletedAt = performance.now();

  const explicitFixtureConfirmations = [
    "bounded workflow and exact requested operations",
    "approved target and credential aliases",
    "read and write authority, limits, forbidden actions, and retry policy",
    "observable completion, duplicate, collateral-effect, and freshness rules",
    "independence of the fictional observation binding",
    "disposable fixture reset and durable-state requirements",
  ];
  const generatedArtifacts = [
    statePath,
    reviewPath,
    path.join(acceptanceStateDirectory, "fresh-start-teardown-campaign.generic-acceptance.json"),
    ...REQUIRED_PILOT_ADAPTER_CASES.map((caseId) => path.join(acceptanceEvidenceDirectory, `${caseId}.external-state.json`)),
    reportPath,
  ];
  const report: FreshStartOnboardingTeardownReport = {
    schemaVersion: FRESH_START_ONBOARDING_TEARDOWN_SCHEMA_VERSION,
    rehearsalType: "automated-author-independent-packaging-rehearsal",
    evidenceBoundary: "This is an automated local packaging rehearsal using a fictional declarative fixture. It is not a human onboarding study, customer evidence, real-system acceptance, production readiness, or an under-one-day result.",
    spendUsd: 0,
    modelCalls: 0,
    fixturePackage: {
      packageDirectory,
      intakeDigest: digest(readJson<unknown>(intakePath)),
      bindingDeclarationDigest,
      actionBindingDigest,
      observationBindingDigest,
      genericAcceptanceBindingDigest,
      acceptanceFixtureDigest: digest(acceptanceFixture),
      importedRepositoryHelperFixtures: false,
    },
    measuredJourney: {
      machineWallClockMs: Number((overallCompletedAt - overallStartedAt).toFixed(3)),
      participantCommands: commands,
      commandCount: commands.length,
      preparationStatus: reviewed.status,
      acceptanceStatus: firstAcceptance.status,
      timeToPreparationReadyMs: Number((preparationReadyAt - overallStartedAt).toFixed(3)),
      timeToAcceptanceCompleteMs: Number((acceptanceCompleteAt - overallStartedAt).toFixed(3)),
      actualHumanActiveMinutes: null,
      underOneDayClaimSupported: false,
    },
    confirmations: {
      explicitFixtureConfirmations,
      automaticallyDigestBound: [
        "adapter proposal",
        "verifier contract",
        "authority compilation",
        "action/observer binding declarations",
        "acceptance declaration",
      ],
    },
    generatedArtifacts,
    restartAndReuse: {
      preparationReadFromFreshCliProcess: true,
      preparationSnapshotDigestStable: freshSnapshot.snapshotDigest === reviewed.snapshotDigest,
      acceptanceReloadedFromDurableStore: secondAcceptance.status === "completed",
      acceptanceReceiptCountStable: secondAcceptance.state.receipts.length === firstAcceptance.state.receipts.length,
      acceptanceAttemptsStable: JSON.stringify(receiptAttempts(secondAcceptance)) === JSON.stringify(receiptAttempts(firstAcceptance)),
    },
    acceptance: {
      passed: firstAcceptance.passed,
      cases: firstAcceptance.declaredCases,
      receipts: firstAcceptance.state.receipts.length,
      incorrectSideEffects: firstAcceptance.incorrectSideEffects,
    },
    customerSpecificWork: {
      executableCustomerCodeWrittenInRehearsal: 0,
      bindingDeclarationLines: countNonBlankLines(bindingPath),
      acceptanceFixtureDeclarationLines: countNonBlankLines(acceptanceFixturePath),
      explicitProxy: "The fixture uses declarative binding and case files as a measurable proxy. A real onboarding still needs executable customer-local action and observation bindings; this rehearsal does not count those declarations as working customer code.",
    },
    authorOnlyStepDisposition: [
      {
        step: "Describe the bounded workflow, exact operations, and business outcome.",
        disposition: "ordinary-language-decision-artifact",
        detail: "Captured in intake.json with explicit customerConfirmed fields; the factory does not infer consequential scope.",
      },
      {
        step: "Extract operations, credentials, request shapes, and retry risks from approved API material.",
        disposition: "automated",
        detail: "The durable preparation CLI generated a provenance-bound proposal from the local OpenAPI document.",
      },
      {
        step: "Specify permissions, limits, approval, and retry rules.",
        disposition: "ordinary-language-decision-artifact",
        detail: "Captured as explicit authority-wizard answers and compiled fail-closed.",
      },
      {
        step: "Calculate and copy proposal, verifier, authority, and binding digests into review input.",
        disposition: "automated",
        detail: "The teardown runner derived and wrote the exact review artifact; stale or mutated artifacts remain rejected by the workflow.",
      },
      {
        step: "Implement the customer-local action runtime binding.",
        disposition: "precise-blocker",
        detail: "The current factory records and digest-binds a declaration but does not generate or prove the executable action binding.",
      },
      {
        step: "Implement the independently authenticated outcome observer binding.",
        disposition: "precise-blocker",
        detail: "The current factory proposes the verifier contract but does not generate and qualify the customer-specific observation adapter.",
      },
      {
        step: "Execute and resume the fixed ten-case acceptance campaign.",
        disposition: "automated",
        detail: "The generic executor preserved case order, receipts, safety accounting, durable reload, and no-repeat behavior.",
      },
      {
        step: "Measure real engineer onboarding time and comprehension.",
        disposition: "precise-blocker",
        detail: "No fresh human participated; machine runtime cannot be reported as engineer active time or under-one-day evidence.",
      },
    ],
    preciseRemainingBlockers: [
      {
        blockerId: "customer-action-runtime-binding-not-generated",
        requiredWork: "Generate or implement the exact customer-local operation binding, then independently review and digest-bind it before execution.",
        ownerClass: "platform-engineer",
      },
      {
        blockerId: "customer-observer-binding-not-generated",
        requiredWork: "Generate or implement the separately authenticated observation adapter and pass negative-control qualification before it can verify outcomes.",
        ownerClass: "platform-engineer",
      },
      {
        blockerId: "real-credential-and-environment-activation-missing",
        requiredWork: "Provide customer-local credential aliases, disposable access, and an activation decision; preparation itself grants no authority.",
        ownerClass: "workspace-admin",
      },
      {
        blockerId: "fresh-human-onboarding-evidence-not-run",
        requiredWork: "A genuinely fresh platform engineer must use the frozen package while active time, questions, edits, and author interventions are observed.",
        ownerClass: "fresh-human-evaluator",
      },
    ],
    conclusion: "The clean package reached acceptance-scaffold-ready and completed the fictional ten-case packaging rehearsal with durable reload and zero surviving incorrect effects. The core usability gap is no longer command orchestration; it is producing and qualifying the two executable customer-specific bindings without author knowledge.",
    reportPath,
  };
  if (!Array.isArray((events.value as { events?: unknown }).events)) throw new Error("Fresh CLI process did not return durable onboarding events.");
  if (!Object.values(report.restartAndReuse).every(Boolean)) throw new Error("Fresh-start teardown did not preserve durable restart/reuse invariants.");
  writeJson(reportPath, report);
  return report;
}
