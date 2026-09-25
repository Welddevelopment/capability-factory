import fs from "node:fs";
import path from "node:path";
import { artifactsRoot } from "./config.js";
import type { FinalVerdictRecord } from "./verdict.js";

type JsonRecord = Record<string, unknown>;

function findSummary(id: string): { kind: string; value: Record<string, unknown> } {
  const candidates = [
    ["run", path.join(artifactsRoot(), "runs", id, "summary.json")],
    ["suite", path.join(artifactsRoot(), "suites", id, "summary.json")],
    ["iteration", path.join(artifactsRoot(), "iterations", id, "summary.json")],
    ["campaign", path.join(artifactsRoot(), "campaigns", id, "summary.json")],
    ["baseline", path.join(artifactsRoot(), "baselines", id, "summary.json")],
  ] as const;
  for (const [kind, filename] of candidates) {
    if (fs.existsSync(filename)) {
      return { kind, value: JSON.parse(fs.readFileSync(filename, "utf8")) as Record<string, unknown> };
    }
  }
  throw new Error(`No run, suite, or baseline summary found for ${id}`);
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function sanitizeVerification(value: unknown): JsonRecord | undefined {
  const verification = record(value);
  if (!verification) return undefined;
  const checks = Array.isArray(verification.checks)
    ? verification.checks.map((check) => {
        const item = record(check) ?? {};
        return {
          id: String(item.id ?? ""),
          passed: item.passed === true,
          detail: String(item.detail ?? ""),
        };
      })
    : [];
  return {
    passed: verification.passed === true,
    checks,
    incorrectSideEffects: Number(verification.incorrectSideEffects ?? 0),
  };
}

function sanitizeTaskState(value: unknown): JsonRecord | undefined {
  const taskState = record(value);
  if (!taskState) return undefined;
  return {
    status: String(taskState.status ?? "unknown"),
    completedSteps: Array.isArray(taskState.completedSteps)
      ? taskState.completedSteps.map(String)
      : [],
    capabilitySearchResult: String(taskState.capabilitySearchResult ?? "unknown"),
    installedCapabilities: Array.isArray(taskState.installedCapabilities)
      ? taskState.installedCapabilities.map(String)
      : [],
    blockedAction: taskState.blockedAction === null ? null : String(taskState.blockedAction ?? ""),
    handoffReason: taskState.handoffReason === null ? null : String(taskState.handoffReason ?? ""),
    finalAnswer: taskState.finalAnswer === null ? null : String(taskState.finalAnswer ?? ""),
  };
}

function sanitizePhase(value: unknown): JsonRecord | undefined {
  const phase = record(value);
  if (!phase) return undefined;
  return {
    runId: String(phase.runId ?? ""),
    startedAt: String(phase.startedAt ?? ""),
    finishedAt: String(phase.finishedAt ?? ""),
    costUsd: Number(phase.costUsd ?? 0),
    taskState: sanitizeTaskState(phase.taskState),
    verification: sanitizeVerification(phase.verification),
  };
}

function sanitizeResult(value: unknown): JsonRecord {
  const result = record(value) ?? {};
  return {
    runId: String(result.runId ?? ""),
    mode: String(result.mode ?? ""),
    scenarioId: String(result.scenarioId ?? ""),
    startedAt: String(result.startedAt ?? ""),
    finishedAt: String(result.finishedAt ?? ""),
    passed: result.passed === true,
    reused: result.reused === true,
    costUsd: Number(result.costUsd ?? 0),
    taskState: sanitizeTaskState(result.taskState),
    verification: sanitizeVerification(result.verification),
  };
}

function sanitizeFreeze(value: unknown): JsonRecord | undefined {
  const freeze = record(value);
  if (!freeze) return undefined;
  return {
    schemaVersion: String(freeze.schemaVersion ?? ""),
    createdAt: String(freeze.createdAt ?? ""),
    commitSha: String(freeze.commitSha ?? ""),
    dependencyLockHash: String(freeze.dependencyLockHash ?? ""),
    promptHash: String(freeze.promptHash ?? ""),
    generatorHash: String(freeze.generatorHash ?? ""),
    verifierHash: String(freeze.verifierHash ?? ""),
    scenarioGeneratorHash: String(freeze.scenarioGeneratorHash ?? ""),
    manifestSchemaHash: String(freeze.manifestSchemaHash ?? ""),
    limits: freeze.limits,
  };
}

function sanitizeSummary(kind: string, value: JsonRecord): JsonRecord {
  if (kind === "suite" || kind === "iteration") {
    return {
      ...(kind === "suite"
        ? { suiteId: String(value.suiteId ?? "") }
        : { iterationId: String(value.iterationId ?? "") }),
      phase: String(value.phase ?? ""),
      freeze: sanitizeFreeze(value.freeze),
      seed: String(value.seed ?? ""),
      startedAt: String(value.startedAt ?? ""),
      finishedAt: String(value.finishedAt ?? ""),
      results: Array.isArray(value.results) ? value.results.map(sanitizeResult) : [],
      provisionalVerdict: String(value.provisionalVerdict ?? "not classified"),
      finalVerdict: String(value.finalVerdict ?? "not locked"),
      ...(kind === "iteration"
        ? {
            passed: value.passed === true,
            lockedVerdict: value.lockedVerdict,
          }
        : {}),
    };
  }
  if (kind === "baseline") {
    return {
      baselineId: String(value.baselineId ?? ""),
      sourceSuiteId: String(value.sourceSuiteId ?? ""),
      seed: String(value.seed ?? ""),
      firstUse: sanitizePhase(value.firstUse),
      freshSession: sanitizePhase(value.freshSession),
      note: String(value.note ?? ""),
    };
  }
  if (kind === "campaign") {
    const cases = Array.isArray(value.cases) ? value.cases : [];
    return {
      campaignId: String(value.campaignId ?? ""),
      phase: String(value.phase ?? ""),
      status: String(value.status ?? ""),
      freeze: sanitizeFreeze(value.freeze),
      seed: String(value.seed ?? ""),
      startedAt: String(value.startedAt ?? ""),
      finishedAt: value.finishedAt === null ? null : String(value.finishedAt ?? ""),
      maxCampaignCostUsd: Number(value.maxCampaignCostUsd ?? 0),
      campaignCostUsd: Number(value.campaignCostUsd ?? 0),
      cases: cases.map((entry) => {
        const campaignCase = record(entry) ?? {};
        return {
          name: String(campaignCase.name ?? ""),
          passed: campaignCase.passed === true,
          results: Array.isArray(campaignCase.results)
            ? campaignCase.results.map(sanitizeResult)
            : [],
        };
      }),
      passed: value.passed === true,
      lockedVerdict: value.lockedVerdict,
    };
  }
  return sanitizePhase(value) ?? {};
}

export function generateSanitizedReport(id: string): string {
  const { kind, value } = findSummary(id);
  const reportsDirectory = path.resolve("reports");
  fs.mkdirSync(reportsDirectory, { recursive: true });
  const safeId = id.replaceAll(/[^a-zA-Z0-9._-]/g, "-");
  const filename = path.join(reportsDirectory, `${safeId}.md`);
  const campaignCases = Array.isArray(value.cases)
    ? (value.cases as Array<Record<string, unknown>>)
    : [];
  const results = Array.isArray(value.results)
    ? (value.results as Array<Record<string, unknown>>)
    : campaignCases.flatMap((entry) =>
        Array.isArray(entry.results) ? (entry.results as Array<Record<string, unknown>>) : [],
      );
  const verdictFilename = path.join(artifactsRoot(), "verdict", "final.json");
  const finalVerdict = fs.existsSync(verdictFilename)
    ? (JSON.parse(fs.readFileSync(verdictFilename, "utf8")) as FinalVerdictRecord)
    : undefined;
  const baselinePhases = ["firstUse", "freshSession"]
    .map((key) => [key, value[key]] as const)
    .filter((entry): entry is readonly [string, Record<string, unknown>] =>
      Boolean(entry[1]) && typeof entry[1] === "object",
    );
  const baselineTable = baselinePhases.length
    ? [
        "| Baseline phase | Correct | Duration (s) | Cost (USD) |",
        "|---|---:|---:|---:|",
        ...baselinePhases.map(([key, phase]) => {
          const verification = phase.verification as Record<string, unknown> | undefined;
          const duration =
            (Date.parse(String(phase.finishedAt)) - Date.parse(String(phase.startedAt))) / 1_000;
          return `| ${key} | ${String(verification?.passed ?? false)} | ${duration.toFixed(2)} | ${Number(phase.costUsd ?? 0).toFixed(4)} |`;
        }),
      ].join("\n")
    : undefined;
  const resultTable = results.length
    ? [
        "| Phase | Scenario | Passed | Reused | Duration (s) | Cost (USD) | Incorrect side effects |",
        "|---|---|---:|---:|---:|---:|---:|",
        ...results.map((result) => {
          const verification = result.verification as Record<string, unknown> | undefined;
          const duration =
            (Date.parse(String(result.finishedAt)) - Date.parse(String(result.startedAt))) / 1_000;
          const phase =
            kind === "campaign"
              ? `${String(
                  campaignCases.find((entry) =>
                    Array.isArray(entry.results) &&
                    entry.results.some(
                      (candidate) =>
                        record(candidate)?.runId === result.runId,
                    ),
                  )?.name ?? "edge case",
                )}: ${result.taskState && record(result.taskState)?.status === "handed_off" ? "safe handoff" : result.reused ? "reuse" : "build"}`
              : value.phase === "day7_confirmation" || value.phase === "post_day7_development"
              ? result.reused
                ? "fresh-session reuse"
                : "fresh build"
              : String(result.mode ?? "held-out");
          return `| ${phase} | ${String(result.scenarioId)} | ${String(result.passed)} | ${String(result.reused)} | ${duration.toFixed(2)} | ${Number(result.costUsd ?? 0).toFixed(4)} | ${String(verification?.incorrectSideEffects ?? "n/a")} |`;
        }),
      ].join("\n")
    : baselineTable ?? "This artifact contains one run; inspect the machine-readable summary below.";
  const failures = results.flatMap((result) => {
    const verification = result.verification as { checks?: Array<Record<string, unknown>> } | undefined;
    const failedChecks = (verification?.checks ?? [])
      .filter((check) => check.passed === false)
      .map((check) => `- ${String(result.scenarioId)} — ${String(check.id)}: ${String(check.detail)}`);
    const taskState = record(result.taskState);
    if (failedChecks.length > 0 && taskState?.finalAnswer) {
      failedChecks.push(`  - Worker terminal message: ${String(taskState.finalAnswer)}`);
    }
    return failedChecks;
  });
  const passedFreshBuild = results.some((result) => result.passed === true && result.reused === false);
  const reusedResult = results.find((result) => result.reused === true);
  const reusedVerification = record(reusedResult?.verification);
  const exactClaim =
    kind === "baseline"
      ? "Both illustrative direct-HTTP baseline phases passed independent outcome verification. The baseline does not build, verify, register, or reuse a capability and is not part of the colour classification."
      : kind === "campaign"
        ? value.passed === true
          ? `The current candidate passed all ${campaignCases.length} targeted post-Day-7 edge cases, covering API-key and bearer capability build/reuse, no-product handoff, permission-denial handoff, and structured-error recovery. Campaign cost was $${Number(value.campaignCostUsd ?? 0).toFixed(6)} and every run recorded zero incorrect side effects.`
          : `The targeted post-Day-7 edge campaign passed ${campaignCases.filter((entry) => entry.passed === true).length} of ${campaignCases.length} cases. It remains development evidence and does not rewrite earlier artifacts.`
      : kind === "iteration"
        ? value.passed === true
          ? "This post-Day-7 development iteration passed fresh build, independent verification, correct external action, goal resumption, and fresh-session registry reuse. It is additional development evidence and does not alter the locked Day 7 colour."
          : "This post-Day-7 development iteration did not pass both the fresh-build and fresh-session reuse phases. It does not alter the locked Day 7 colour."
      : finalVerdict?.colour === "green"
      ? "In this frozen local evaluation, the worker completed a fresh capability build, passed independent state verification, resumed the goal, and reused the saved capability in a fresh session. This is evidence of possibility in the tested harness, not production reliability or generality."
      : finalVerdict?.colour === "yellow"
        ? passedFreshBuild && reusedResult
          ? `The frozen fresh-build run completed the acquire → verify → install → act → resume loop. The fresh session found and reused the saved capability and produced the independently correct external state, but its worker task ended with status ${String(record(reusedResult.taskState)?.status ?? "unknown")}; fresh-session goal resumption was therefore not demonstrated. Incorrect side effects in that run: ${String(reusedVerification?.incorrectSideEffects ?? "n/a")}.`
          : "The local harness demonstrated part of the capability loop, but the frozen evidence did not satisfy the preregistered green threshold."
        : finalVerdict?.colour === "red"
          ? "The frozen evaluation did not demonstrate the preregistered build → verify → resume result reliably enough to support the claim."
          : "No final colour is locked. Offline or provisional results must not be presented as a successful kill test.";
  const strongest = results.find((result) => result.passed) ?? results[0];
  const reuseRunId = reusedResult?.runId ? String(reusedResult.runId) : undefined;
  const evidenceEdit =
    kind === "baseline"
      ? "Use this artifact only as a clearly labeled direct-HTTP comparison. Do not present it as evidence of capability acquisition, verification, registration, or reuse."
      : kind === "campaign"
        ? `Label this as the current candidate's targeted post-Day-7 edge campaign. Preserve all case results and do not omit failed runs. Run IDs: ${results.map((result) => `**${String(result.runId ?? "unknown")}**`).join(", ")}.`
      : kind === "iteration"
        ? `Label this explicitly as a post-Day-7 development iteration. Show both run IDs without cutting around failures: **${String(strongest?.runId ?? "not available")}** and **${reuseRunId ?? "not available"}**. Do not imply that it changed the locked Day 7 verdict.`
      : finalVerdict?.colour === "green"
        ? `Show the uncut fresh-build run **${String(strongest?.runId ?? "no passing run available")}** followed by the uncut fresh-session reuse run **${reuseRunId ?? "not available"}**. Keep timestamps, run IDs, verifier outcomes, and external SQLite state visible.`
        : `Show the uncut successful fresh-build run **${String(strongest?.runId ?? "no passing run available")}**, then the uncut fresh-session run **${reuseRunId ?? "not available"}** through its failed ending. Keep timestamps, run IDs, verifier outcomes, and external SQLite state visible; do not reconstruct the failure or imply that fresh-session goal resumption passed.`;
  const architecture =
    kind === "baseline"
      ? `\`\`\`mermaid
flowchart LR
  Goal --> Worker
  Worker --> Docs
  Worker --> DirectHTTP
  DirectHTTP --> CompanyAPIs
  CompanyAPIs --> SQLite
  SQLite --> OutcomeVerifier
\`\`\``
      : `\`\`\`mermaid
flowchart LR
  Goal --> Worker
  Worker -->|installed tools| CompanyAPIs
  Worker -->|missing operation| Registry
  Registry -->|no match| Factory
  Factory --> Docs
  Factory --> ManifestVerifier
  ManifestVerifier --> Registry
  Registry --> Worker
  CompanyAPIs --> SQLite
  SQLite --> OutcomeVerifier
\`\`\``;
  const sanitized = sanitizeSummary(kind, value);
  const scopeLimitation =
    kind === "campaign"
      ? "- Post-Day-7 targeted development campaign, not a production reliability study."
      : kind === "iteration"
      ? "- Post-Day-7 development iteration, not a preregistered replacement final verdict."
      : "- One worker model and a small preregistered suite.";
  const evidenceStatusNote =
    kind === "campaign"
      ? "This report describes additional evidence about the current development candidate. It preserves historical failures but does not establish production reliability."
      : "This report does not convert a provisional result into a company-level green verdict. A single pass is evidence of possibility only. Failed runs remain part of the private evidence package.";
  const content = `# Capability Factory evaluation report: ${id}

Artifact kind: **${kind}**
Generated: **${new Date().toISOString()}**

## Results

${resultTable}

Provisional verdict: **${String(value.provisionalVerdict ?? "not classified")}**
Locked final colour: **${finalVerdict?.colour ?? "not locked"}**

${evidenceStatusNote}

## Exact supported claim

${exactClaim}

## Failure analysis

${failures.length > 0 ? failures.join("\n") : "No failed verifier checks are present in this artifact. This does not erase failures preserved in other suites."}

## Architecture

${architecture}

## Machine-readable sanitized summary

\`\`\`json
${JSON.stringify(sanitized, null, 2)}
\`\`\`

## Limitations

- Local fictional HTTP APIs only.
- Declarative manifests, not arbitrary code or MCP servers.
${scopeLimitation}
- Baseline results, when present, are illustrative single runs.
- No claim of universal capability acquisition, production reliability, customers, or traction.

## 60–90 second evidence edit

${evidenceEdit}
`;
  fs.writeFileSync(filename, content, "utf8");
  return filename;
}
