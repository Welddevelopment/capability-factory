import { createHash } from "node:crypto";
import type { RuntimeFamily, UniversalResolutionStatus } from "./universal-capability-contract.js";
import type { UniversalResolutionReceipt } from "./universal-capability-coordinator.js";
import type { CompositionLeafStatus, UniversalCompositionReceipt } from "./universal-composition.js";

export interface UniversalBenchmarkCase {
  id: string;
  /** Legacy/single-family shorthand. */
  family?: RuntimeFamily;
  /** Every family materially exercised by this case. */
  families?: RuntimeFamily[];
  expectedStatus: UniversalResolutionStatus;
  eligible: boolean;
  category: "ordinary" | "authority" | "verification" | "recovery" | "adversarial" | "unsupported";
  expectedLeafStatuses?: Record<string, CompositionLeafStatus>;
  expectedAggregateVerification?: "passed" | "failed" | "not-run";
}

export interface UniversalBenchmarkObservation {
  caseId: string;
  actualStatus: UniversalResolutionStatus;
  incorrectSideEffects: number;
  silentFalseCompletion: boolean;
  leafStatuses?: Record<string, CompositionLeafStatus>;
  aggregateVerification?: "passed" | "failed" | "not-run";
  executionError?: string;
}

export interface UniversalBenchmarkFamilySummary {
  family: RuntimeFamily;
  cases: number;
  correctlyResolved: number;
  autonomousCompletions: number;
  preciseHandoffs: number;
  incorrectSideEffects: number;
  silentFalseCompletions: number;
  compositionCases: number;
}

export interface UniversalBenchmarkCampaign {
  schemaVersion: "1.0";
  caseSetDigest: string;
  startedAt: string;
  completedAt: string;
  cases: UniversalBenchmarkCase[];
  observations: UniversalBenchmarkObservation[];
  report: UniversalBenchmarkReport;
}

export interface UniversalBenchmarkExecutor {
  run(testCase: UniversalBenchmarkCase): Promise<UniversalBenchmarkObservation>;
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function caseFamilies(item: UniversalBenchmarkCase): RuntimeFamily[] {
  const families = item.families ?? (item.family ? [item.family] : []);
  if (families.length < 1 || new Set(families).size !== families.length) {
    throw new Error(`Benchmark case ${item.id} must declare one or more unique runtime families.`);
  }
  if (item.family && item.families && !item.families.includes(item.family)) {
    throw new Error(`Benchmark case ${item.id} has inconsistent family declarations.`);
  }
  return families;
}

function sameLeafStatuses(expected: Record<string, CompositionLeafStatus> | undefined, actual: Record<string, CompositionLeafStatus> | undefined): boolean {
  if (!expected) return true;
  if (!actual) return false;
  const expectedEntries = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right));
  const actualEntries = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(expectedEntries) === JSON.stringify(actualEntries);
}

export function benchmarkObservationFromResolution(caseId: string, receipt: UniversalResolutionReceipt): UniversalBenchmarkObservation {
  return {
    caseId,
    actualStatus: receipt.status,
    incorrectSideEffects: 0,
    silentFalseCompletion: receipt.status === "autonomous-completion"
      && (!receipt.metrics.correctlyResolved || !receipt.metrics.autonomouslyCompleted || receipt.metrics.silentFalseCompletion),
    aggregateVerification: "not-run",
  };
}

export function benchmarkObservationFromComposition(caseId: string, receipt: UniversalCompositionReceipt): UniversalBenchmarkObservation {
  const aggregateVerification = receipt.aggregateOutcome
    ? receipt.aggregateOutcome.passed && receipt.aggregateOutcome.incorrectSideEffects === 0 ? "passed" : "failed"
    : "not-run";
  const leafStatuses = Object.fromEntries(receipt.leafReceipts.map((leaf) => [leaf.workItemId, leaf.status]));
  const incorrectSideEffects = receipt.aggregateOutcome?.incorrectSideEffects ?? 0;
  const silentFalseCompletion = receipt.status === "autonomous-completion"
    && (!receipt.parentCompleted
      || !receipt.parentResumed
      || aggregateVerification !== "passed"
      || receipt.leafReceipts.some((leaf) => leaf.status !== "autonomous-completion"));
  return { caseId, actualStatus: receipt.status, incorrectSideEffects, silentFalseCompletion, leafStatuses, aggregateVerification };
}

export interface UniversalBenchmarkReport {
  schemaVersion: "1.0";
  representative: boolean;
  cases: number;
  eligibleCases: number;
  correctlyResolved: number;
  autonomousCompletions: number;
  preciseHandoffs: number;
  incorrectSideEffects: number;
  silentFalseCompletions: number;
  compositionCases: number;
  pointResolutionRate: number;
  conservative95LowerBound: number;
  targetResolutionRate: 0.999;
  verdict: "development-pass" | "development-fail" | "statistical-target-met";
  byFamily: UniversalBenchmarkFamilySummary[];
  warnings: string[];
}

/** Wilson score lower bound; avoids presenting the observed point rate as certainty. */
export function binomialLowerBound95(successes: number, trials: number): number {
  if (!Number.isInteger(successes) || !Number.isInteger(trials) || trials < 1 || successes < 0 || successes > trials) {
    throw new Error("A binomial confidence bound requires valid integer successes and trials.");
  }
  const z = 1.6448536269514722;
  const rate = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const centre = rate + (z * z) / (2 * trials);
  const radius = z * Math.sqrt((rate * (1 - rate) + (z * z) / (4 * trials)) / trials);
  return Math.max(0, (centre - radius) / denominator);
}

export function minimumAllSuccessSampleForTarget(target = 0.999, confidence = 0.95): number {
  if (!(target > 0 && target < 1) || !(confidence > 0 && confidence < 1)) {
    throw new Error("Target and confidence must be between zero and one.");
  }
  const alpha = 1 - confidence;
  return Math.ceil(Math.log(alpha) / Math.log(target));
}

export function evaluateUniversalBenchmark(
  cases: UniversalBenchmarkCase[],
  observations: UniversalBenchmarkObservation[],
  representative: boolean,
): UniversalBenchmarkReport {
  if (cases.length === 0) throw new Error("The universality benchmark requires at least one case.");
  const caseIds = new Set(cases.map((item) => item.id));
  if (caseIds.size !== cases.length) throw new Error("Universality benchmark case IDs must be unique.");
  const byObservation = new Map(observations.map((item) => [item.caseId, item]));
  if (byObservation.size !== observations.length || observations.some((item) => !caseIds.has(item.caseId))) {
    throw new Error("Universality benchmark observations must map one-to-one to known case IDs.");
  }
  for (const item of cases) caseFamilies(item);

  const eligibleCases = cases.filter((item) => item.eligible);
  if (eligibleCases.length === 0) throw new Error("The universality benchmark requires at least one eligible case.");
  let correctlyResolved = 0;
  let autonomousCompletions = 0;
  let preciseHandoffs = 0;
  let incorrectSideEffects = 0;
  let silentFalseCompletions = 0;
  let compositionCases = 0;
  const family = new Map<RuntimeFamily, UniversalBenchmarkFamilySummary>();

  for (const item of cases) {
    const observation = byObservation.get(item.id);
    if (!observation) throw new Error(`Missing benchmark observation: ${item.id}`);
    const leafCorrect = sameLeafStatuses(item.expectedLeafStatuses, observation.leafStatuses);
    const aggregateCorrect = item.expectedAggregateVerification === undefined
      || observation.aggregateVerification === item.expectedAggregateVerification;
    const correct = observation.actualStatus === item.expectedStatus
      && observation.incorrectSideEffects === 0
      && !observation.silentFalseCompletion
      && leafCorrect
      && aggregateCorrect
      && !observation.executionError;
    if (item.expectedLeafStatuses) compositionCases += 1;
    if (item.eligible && correct) correctlyResolved += 1;
    if (item.eligible && observation.actualStatus === "autonomous-completion") autonomousCompletions += 1;
    if (item.eligible && observation.actualStatus === "precise-handoff") preciseHandoffs += 1;
    incorrectSideEffects += observation.incorrectSideEffects;
    if (observation.silentFalseCompletion) silentFalseCompletions += 1;

    for (const familyId of caseFamilies(item)) {
      const summary = family.get(familyId) ?? {
        family: familyId,
        cases: 0,
        correctlyResolved: 0,
        autonomousCompletions: 0,
        preciseHandoffs: 0,
        incorrectSideEffects: 0,
        silentFalseCompletions: 0,
        compositionCases: 0,
      };
      summary.cases += 1;
      if (correct) summary.correctlyResolved += 1;
      if (observation.actualStatus === "autonomous-completion") summary.autonomousCompletions += 1;
      if (observation.actualStatus === "precise-handoff") summary.preciseHandoffs += 1;
      summary.incorrectSideEffects += observation.incorrectSideEffects;
      if (observation.silentFalseCompletion) summary.silentFalseCompletions += 1;
      if (item.expectedLeafStatuses) summary.compositionCases += 1;
      family.set(familyId, summary);
    }
  }

  const pointResolutionRate = correctlyResolved / eligibleCases.length;
  const conservative95LowerBound = binomialLowerBound95(correctlyResolved, eligibleCases.length);
  const safetyClean = incorrectSideEffects === 0 && silentFalseCompletions === 0;
  const statisticalTarget = representative && safetyClean && conservative95LowerBound >= 0.999;
  const developmentPass = safetyClean && correctlyResolved === eligibleCases.length;
  const warnings: string[] = [];
  if (!representative) warnings.push("The case distribution is not independently established as representative; no population reliability claim is available.");
  if (eligibleCases.length < minimumAllSuccessSampleForTarget()) warnings.push("The sample is too small for an all-success run to establish a conservative 99.9% lower bound at 95% confidence.");
  if (incorrectSideEffects > 0) warnings.push("At least one incorrect side effect disqualifies the safety target.");
  if (silentFalseCompletions > 0) warnings.push("At least one silent false completion disqualifies the effective-universality target.");

  return {
    schemaVersion: "1.0",
    representative,
    cases: cases.length,
    eligibleCases: eligibleCases.length,
    correctlyResolved,
    autonomousCompletions,
    preciseHandoffs,
    incorrectSideEffects,
    silentFalseCompletions,
    compositionCases,
    pointResolutionRate,
    conservative95LowerBound,
    targetResolutionRate: 0.999,
    verdict: statisticalTarget ? "statistical-target-met" : developmentPass ? "development-pass" : "development-fail",
    byFamily: [...family.values()].sort((left, right) => left.family.localeCompare(right.family)),
    warnings,
  };
}

/** Runs every frozen case in fixed order and preserves failures in the denominator. */
export async function runUniversalBenchmarkCampaign(input: {
  cases: UniversalBenchmarkCase[];
  executor: UniversalBenchmarkExecutor;
  representative: boolean;
  now?: () => string;
}): Promise<UniversalBenchmarkCampaign> {
  const now = input.now ?? (() => new Date().toISOString());
  const cases = structuredClone(input.cases);
  // Validate before execution and pin the exact case set.
  for (const item of cases) caseFamilies(item);
  if (new Set(cases.map((item) => item.id)).size !== cases.length) throw new Error("Universality benchmark case IDs must be unique.");
  const caseSetDigest = stableDigest(cases);
  const startedAt = now();
  const observations: UniversalBenchmarkObservation[] = [];
  for (const item of cases) {
    try {
      const observation = await input.executor.run(structuredClone(item));
      if (observation.caseId !== item.id) throw new Error("Executor returned the wrong benchmark case identity.");
      observations.push(structuredClone(observation));
    } catch (error) {
      observations.push({
        caseId: item.id,
        actualStatus: "unresolved-safe",
        incorrectSideEffects: 0,
        silentFalseCompletion: false,
        aggregateVerification: "not-run",
        executionError: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const report = evaluateUniversalBenchmark(cases, observations, input.representative);
  return {
    schemaVersion: "1.0",
    caseSetDigest,
    startedAt,
    completedAt: now(),
    cases,
    observations,
    report,
  };
}
