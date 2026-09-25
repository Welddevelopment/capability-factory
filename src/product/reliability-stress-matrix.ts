import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const STRESS_MATRIX_PROTOCOL_VERSION = "deterministic-stress-matrix-v1";

export const STRESS_MATRIX_CLASSES = [
  { id: "clean-completion", trials: 20 },
  { id: "authority-boundary", trials: 15 },
  { id: "lost-result-recovery", trials: 15 },
  { id: "duplicate-submission", trials: 10 },
  { id: "conflicting-parent-reuse", trials: 10 },
  { id: "tenant-isolation", trials: 10 },
  { id: "incorrect-outcome-detection", trials: 10 },
  { id: "retry-limit", trials: 10 },
] as const;

export type StressMatrixClassId = (typeof STRESS_MATRIX_CLASSES)[number]["id"];

export interface StressMatrixTrialDefinition {
  id: string;
  classId: StressMatrixClassId;
  seed: string;
}

export interface StressMatrixTrialResult extends StressMatrixTrialDefinition {
  passed: boolean;
  safetyFailure: boolean;
  incorrectSideEffectsObserved: number;
  incorrectSideEffectsSurviving: number;
  durationMs: number;
  detail: Record<string, unknown>;
}

export interface StressMatrixReport {
  protocolVersion: typeof STRESS_MATRIX_PROTOCOL_VERSION;
  startedAt: string;
  completedAt: string;
  passed: boolean;
  abortedForSafety: boolean;
  expectedTrials: number;
  completedTrials: number;
  passedTrials: number;
  failedTrials: string[];
  incorrectSideEffectsObserved: number;
  incorrectSideEffectsSurviving: number;
  exactOneSided95SuccessLowerBound: number | null;
  sourceHashes: Record<string, string>;
  classes: Array<{
    classId: StressMatrixClassId;
    expected: number;
    completed: number;
    passed: number;
  }>;
  trials: StressMatrixTrialResult[];
  evidenceBoundary: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createStressMatrixDefinitions(): StressMatrixTrialDefinition[] {
  return STRESS_MATRIX_CLASSES.flatMap(({ id, trials }) =>
    Array.from({ length: trials }, (_, index) => {
      const ordinal = String(index + 1).padStart(2, "0");
      return {
        id: `${id}-${ordinal}`,
        classId: id,
        seed: digest(`${STRESS_MATRIX_PROTOCOL_VERSION}:${id}:${ordinal}`),
      };
    }),
  );
}

export function hashStressMatrixSources(repositoryRoot: string, relativeFiles: readonly string[]): Record<string, string> {
  return Object.fromEntries(relativeFiles.map((relative) => {
    const absolute = path.resolve(repositoryRoot, relative);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(`Stress-matrix source is missing: ${relative}`);
    }
    return [relative, digest(fs.readFileSync(absolute, "utf8"))];
  }));
}

export function exactOneSided95SuccessLowerBound(passed: number, total: number): number | null {
  if (total <= 0 || passed !== total) return null;
  return Math.pow(0.05, 1 / total);
}

export function summarizeStressMatrix(
  startedAt: string,
  completedAt: string,
  results: StressMatrixTrialResult[],
  sourceHashes: Record<string, string>,
  abortedForSafety: boolean,
): StressMatrixReport {
  const definitions = createStressMatrixDefinitions();
  const expectedIds = new Set(definitions.map((definition) => definition.id));
  const duplicateIds = results.length !== new Set(results.map((result) => result.id)).size;
  const unexpectedIds = results.filter((result) => !expectedIds.has(result.id)).map((result) => result.id);
  const failedTrials = results.filter((result) => !result.passed).map((result) => result.id);
  const incorrectSideEffectsSurviving = results.reduce(
    (total, result) => total + result.incorrectSideEffectsSurviving,
    0,
  );
  const passedTrials = results.filter((result) => result.passed).length;
  const complete = results.length === definitions.length && unexpectedIds.length === 0 && !duplicateIds;
  return {
    protocolVersion: STRESS_MATRIX_PROTOCOL_VERSION,
    startedAt,
    completedAt,
    passed: complete
      && !abortedForSafety
      && failedTrials.length === 0
      && incorrectSideEffectsSurviving === 0,
    abortedForSafety,
    expectedTrials: definitions.length,
    completedTrials: results.length,
    passedTrials,
    failedTrials,
    incorrectSideEffectsObserved: results.reduce(
      (total, result) => total + result.incorrectSideEffectsObserved,
      0,
    ),
    incorrectSideEffectsSurviving,
    exactOneSided95SuccessLowerBound: exactOneSided95SuccessLowerBound(passedTrials, results.length),
    sourceHashes,
    classes: STRESS_MATRIX_CLASSES.map(({ id, trials }) => {
      const classResults = results.filter((result) => result.classId === id);
      return {
        classId: id,
        expected: trials,
        completed: classResults.length,
        passed: classResults.filter((result) => result.passed).length,
      };
    }),
    trials: results,
    evidenceBoundary:
      "Constrained local deterministic stress evidence only. Repeated seeded trials are not independent customer deployments, production reliability, a security certification, or a formal green verdict.",
  };
}

export function writeStressMatrixArtifacts(directory: string, report: StressMatrixReport): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync(path.join(directory, "result.json"), json, { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(path.join(directory, "result.json.sha256"), `${digest(json)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const lines = [
    "# Deterministic reliability stress matrix",
    "",
    `- Result: ${report.passed ? "PASS" : "NOT PASSING"}`,
    `- Trials: ${report.passedTrials}/${report.expectedTrials}`,
    `- Aborted for safety: ${report.abortedForSafety ? "yes" : "no"}`,
    `- Incorrect side effects observed in deliberate detection cases: ${report.incorrectSideEffectsObserved}`,
    `- Incorrect side effects surviving cleanup: ${report.incorrectSideEffectsSurviving}`,
    `- Exact one-sided 95% lower success bound for this matrix: ${report.exactOneSided95SuccessLowerBound === null ? "not available" : `${(report.exactOneSided95SuccessLowerBound * 100).toFixed(2)}%`}`,
    "",
    "| Class | Passed | Expected |",
    "| --- | ---: | ---: |",
    ...report.classes.map((item) => `| ${item.classId} | ${item.passed} | ${item.expected} |`),
    "",
    `Evidence boundary: ${report.evidenceBoundary}`,
    "",
    "The statistical bound describes only repeated execution of this fixed local matrix. It must not be presented as a customer or production success rate.",
    "",
  ];
  fs.writeFileSync(path.join(directory, "REPORT.md"), lines.join("\n"), {
    encoding: "utf8",
    mode: 0o600,
  });
}
