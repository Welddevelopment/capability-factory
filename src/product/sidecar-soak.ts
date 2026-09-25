import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SIDECAR_SOAK_PROTOCOL = "sidecar-volume-restart-soak-v2";

export interface SidecarSoakLatencySummary {
  samples: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface SidecarSoakReport {
  protocol: typeof SIDECAR_SOAK_PROTOCOL;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  passed: boolean;
  candidateCommit: string;
  sourceHashes: Record<string, string>;
  configuration: {
    tenants: number;
    uniqueJobs: number;
    submissionsPerJob: number;
    totalSubmissions: number;
    abruptRunningRecoveries: number;
    cleanRestarts: number;
    conflictingRequests: number;
    crossTenantReadProbes: number;
  };
  results: {
    completedJobs: number;
    uniqueBusinessExecutions: number;
    duplicateBusinessExecutions: number;
    missingTerminalRecords: number;
    conflictRejections: number;
    crossTenantReadsBlocked: number;
    prematureCompletionSignals: number;
    retryLimitViolations: number;
    redactionFailures: number;
  };
  performance: {
    submission: SidecarSoakLatencySummary;
    statusRead: SidecarSoakLatencySummary;
    startup: SidecarSoakLatencySummary;
    phases: Array<{
      uniqueJobConcurrency: number;
      uniqueJobs: number;
      submissions: number;
      durationMs: number;
      submission: SidecarSoakLatencySummary;
    }>;
    throughputUniqueJobsPerSecond: number;
    maxObservedNonterminalJobs: number;
    memory: { startRssBytes: number; peakRssBytes: number; finalRssBytes: number; peakHeapUsedBytes: number };
    storage: { databaseBytes: number; walBytes: number; eventRecords: number };
  };
  failures: string[];
  evidenceBoundary: string;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashSidecarSoakSources(repositoryRoot: string, files: readonly string[]): Record<string, string> {
  return Object.fromEntries(files.map((filename) => {
    const absolute = path.resolve(repositoryRoot, filename);
    if (!fs.existsSync(absolute)) throw new Error(`Sidecar soak source is missing: ${filename}`);
    return [filename, sha256(fs.readFileSync(absolute))];
  }));
}

export function writeSidecarSoakArtifacts(directory: string, report: SidecarSoakReport): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync(path.join(directory, "result.json"), json, { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(path.join(directory, "result.json.sha256"), `${sha256(json)}\n`, { encoding: "utf8", mode: 0o600 });
  const lines = [
    "# Durable sidecar volume and restart soak",
    "",
    `- Result: ${report.passed ? "PASS" : "NOT PASSING"}`,
    `- Unique durable jobs: ${report.configuration.uniqueJobs}`,
    `- Duplicate HTTP submissions: ${report.configuration.totalSubmissions}`,
    `- Tenants: ${report.configuration.tenants}`,
    `- Abrupt running-job recoveries: ${report.configuration.abruptRunningRecoveries}`,
    `- Clean process restarts: ${report.configuration.cleanRestarts}`,
    `- Completed terminal records: ${report.results.completedJobs}`,
    `- Duplicate business executions: ${report.results.duplicateBusinessExecutions}`,
    `- Cross-tenant reads blocked: ${report.results.crossTenantReadsBlocked}/${report.configuration.crossTenantReadProbes}`,
    `- Premature completion signals: ${report.results.prematureCompletionSignals}`,
    `- Missing terminal records: ${report.results.missingTerminalRecords}`,
    `- Redaction failures: ${report.results.redactionFailures}`,
    `- Submission latency p50/p95/p99: ${report.performance.submission.p50Ms}/${report.performance.submission.p95Ms}/${report.performance.submission.p99Ms} ms`,
    `- Status latency p50/p95/p99: ${report.performance.statusRead.p50Ms}/${report.performance.statusRead.p95Ms}/${report.performance.statusRead.p99Ms} ms`,
    `- Unique-job throughput: ${report.performance.throughputUniqueJobsPerSecond}/s`,
    `- Peak RSS: ${report.performance.memory.peakRssBytes} bytes`,
    `- Durable database/WAL: ${report.performance.storage.databaseBytes}/${report.performance.storage.walBytes} bytes`,
    `- Durable events: ${report.performance.storage.eventRecords}`,
    "",
    report.failures.length > 0 ? `Failures: ${report.failures.join(" | ")}` : "Failures: none",
    "",
    `Evidence boundary: ${report.evidenceBoundary}`,
    "",
  ];
  fs.writeFileSync(path.join(directory, "REPORT.md"), lines.join("\n"), { encoding: "utf8", mode: 0o600 });
}
