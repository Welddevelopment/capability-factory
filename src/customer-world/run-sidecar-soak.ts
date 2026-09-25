import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCapabilitySidecar } from "../product/sidecar.js";
import {
  BROAD_GOAL_REQUEST_SCHEMA_VERSION,
  type BroadGoalRequest,
  type BroadGoalRunResult,
} from "../product/broad-goal-sdk.js";
import {
  isSidecarGoalJobReceipt,
  SidecarGoalJobService,
  SidecarGoalJobStore,
  type SidecarGoalJobReceipt,
} from "../product/sidecar-jobs.js";
import {
  hashSidecarSoakSources,
  SIDECAR_SOAK_PROTOCOL,
  writeSidecarSoakArtifacts,
  type SidecarSoakReport,
  type SidecarSoakLatencySummary,
} from "../product/sidecar-soak.js";

const ACCESS_TOKEN = "soak-token-must-never-enter-artifacts";
const TENANTS = 50;
const UNIQUE_JOBS = 1_000;
const SUBMISSIONS_PER_JOB = 5;
const ABRUPT_RECOVERIES = 20;
const CLEAN_RESTARTS = 2;
const CONFLICTS = 50;
const CROSS_TENANT_PROBES = 100;
const SOURCE_FILES = [
  "src/product/broad-goal-sdk.ts",
  "src/product/sidecar-jobs.ts",
  "src/product/sidecar.ts",
  "src/product/sidecar-soak.ts",
  "src/customer-world/run-sidecar-soak.ts",
] as const;

function latencySummary(samples: number[]): SidecarSoakLatencySummary {
  if (samples.length === 0) return { samples: 0, minMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (percentile: number) => sorted[Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1)]!;
  const rounded = (value: number) => Number(value.toFixed(3));
  return {
    samples: sorted.length,
    minMs: rounded(sorted[0]!),
    p50Ms: rounded(at(0.5)),
    p95Ms: rounded(at(0.95)),
    p99Ms: rounded(at(0.99)),
    maxMs: rounded(sorted.at(-1)!),
  };
}

function commit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function request(index: number): BroadGoalRequest {
  return {
    schemaVersion: BROAD_GOAL_REQUEST_SCHEMA_VERSION,
    tenantId: `tenant-${String(index % TENANTS).padStart(2, "0")}`,
    parentGoalId: `soak-parent-${String(index).padStart(4, "0")}`,
    requestId: `soak-request-${String(index).padStart(4, "0")}`,
    scopeKey: "sidecar-soak-scope",
    ordinaryGoal: `Complete bounded soak job ${index}.`,
    visibility: "summary",
  };
}

function completed(input: BroadGoalRequest): BroadGoalRunResult {
  const now = new Date().toISOString();
  const digest = Buffer.from(`${input.tenantId}:${input.parentGoalId}`).toString("hex").slice(0, 64).padEnd(64, "0");
  return {
    status: "completed",
    tenantId: input.tenantId,
    parentGoalId: input.parentGoalId,
    requestId: input.requestId,
    planning: {
      source: "retained-validated-plan",
      attempts: 0,
      validationReceiptId: `soak-validation-${input.requestId}`,
      planDigest: digest,
      workItems: 1,
    },
    state: {
      schemaVersion: "1.0",
      tenantId: input.tenantId,
      parentGoalId: input.parentGoalId,
      requestId: input.requestId,
      planDigest: digest,
      version: 1,
      lifecycle: "completed",
      items: {},
      aggregate: {
        verifierVersion: "sidecar-soak-verifier-v1",
        receiptId: `soak-outcome-${input.requestId}`,
        result: "complete",
        passed: true,
        requiredItems: 1,
        completedItems: 1,
        blockedItems: 0,
        failedItems: 0,
        unknownItems: 0,
        incorrectSideEffects: 0,
        stateDigest: digest,
        checks: [{ id: "independent-outcome", passed: true, detail: "The bounded simulated write is externally recorded once." }],
        verifiedAt: now,
      },
      resume: { completed: true, summary: "Parent resumed only after the aggregate verifier passed." },
      createdAt: now,
      updatedAt: now,
    },
  };
}

function parseReceipt(body: string): SidecarGoalJobReceipt {
  const value: unknown = JSON.parse(body);
  if (!isSidecarGoalJobReceipt(value)) throw new Error(`Invalid sidecar receipt: ${body.slice(0, 200)}`);
  return value;
}

async function main(): Promise<void> {
  const repositoryRoot = process.cwd();
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const timestamp = startedAt.replaceAll(/[:.]/g, "-");
  const directory = path.resolve("artifacts", "sidecar-soak", `${SIDECAR_SOAK_PROTOCOL}-${timestamp}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const databasePath = path.join(directory, "jobs.sqlite");
  const inputs = Array.from({ length: UNIQUE_JOBS }, (_, index) => request(index));
  const jobIds = new Map<number, string>();
  const executions = new Map<string, number>();
  const failures: string[] = [];
  let conflictRejections = 0;
  let crossTenantReadsBlocked = 0;
  let prematureCompletionSignals = 0;
  const submissionLatencies: number[] = [];
  const statusReadLatencies: number[] = [];
  const startupLatencies: number[] = [];
  const phaseMetrics: SidecarSoakReport["performance"]["phases"] = [];
  const startMemory = process.memoryUsage();
  let peakRssBytes = startMemory.rss;
  let peakHeapUsedBytes = startMemory.heapUsed;
  let maxObservedNonterminalJobs = 0;

  const sampleMemory = () => {
    const current = process.memoryUsage();
    peakRssBytes = Math.max(peakRssBytes, current.rss);
    peakHeapUsedBytes = Math.max(peakHeapUsedBytes, current.heapUsed);
  };

  // Simulate a process disappearing after durable claim but before the runner
  // returns. The replacement sidecar must recover these exact jobs.
  const interruptedStore = new SidecarGoalJobStore(databasePath);
  for (let index = 0; index < ABRUPT_RECOVERIES; index += 1) {
    const input = inputs[index]!;
    const created = interruptedStore.create(input).job;
    jobIds.set(index, created.jobId);
    if (!interruptedStore.claim(input.tenantId, created.jobId)) {
      failures.push(`Could not preclaim interrupted job ${index}.`);
    }
  }
  interruptedStore.close();

  const runner = {
    completeGoal: async (input: BroadGoalRequest): Promise<BroadGoalRunResult> => {
      // Yield so status reads and duplicate submissions overlap the worker.
      await new Promise((resolve) => setTimeout(resolve, 2));
      const key = `${input.tenantId}\u001f${input.parentGoalId}`;
      executions.set(key, (executions.get(key) ?? 0) + 1);
      return completed(input);
    },
  };

  let app: ReturnType<typeof createCapabilitySidecar> | undefined;
  let service: SidecarGoalJobService | undefined;
  const startSidecar = async () => {
    const startupStarted = performance.now();
    service = new SidecarGoalJobService(new SidecarGoalJobStore(databasePath), runner, { maxAttempts: 3 });
    app = createCapabilitySidecar(undefined, { resolve: () => undefined }, { accessToken: ACCESS_TOKEN, goalJobs: service });
    await app.ready();
    startupLatencies.push(performance.now() - startupStarted);
    sampleMemory();
  };
  const stopSidecar = async () => {
    if (app) await app.close();
    app = undefined;
    service = undefined;
  };
  const auth = { "x-capability-sidecar-token": ACCESS_TOKEN };

  const submitRange = async (from: number, to: number, uniqueJobConcurrency: number) => {
    if (!app || !service) throw new Error("Sidecar is not running.");
    const phaseStarted = performance.now();
    const phaseLatencies: number[] = [];
    for (let batchStart = from; batchStart < to; batchStart += uniqueJobConcurrency) {
      const batchEnd = Math.min(to, batchStart + uniqueJobConcurrency);
      const pending: Array<Promise<unknown>> = [];
      for (let index = batchStart; index < batchEnd; index += 1) {
        const input = inputs[index]!;
        for (let duplicate = 0; duplicate < SUBMISSIONS_PER_JOB; duplicate += 1) {
          const submissionStarted = performance.now();
          pending.push(app.inject({ method: "POST", url: "/v1/goal-jobs", headers: auth, payload: input }).then((response) => {
            const elapsed = performance.now() - submissionStarted;
            submissionLatencies.push(elapsed);
            phaseLatencies.push(elapsed);
            if (![200, 202].includes(response.statusCode)) {
              failures.push(`Submission ${index}/${duplicate} returned HTTP ${response.statusCode}.`);
              return;
            }
            const receipt = parseReceipt(response.body);
            const known = jobIds.get(index);
            if (known && known !== receipt.jobId) failures.push(`Duplicate submission ${index} changed durable job identity.`);
            jobIds.set(index, receipt.jobId);
            if (receipt.status !== "completed" && receipt.result !== undefined) prematureCompletionSignals += 1;
          }));
        }
      }
      await Promise.all(pending);
      const nonterminal = Array.from({ length: batchEnd - batchStart }, (_, offset) => {
        const index = batchStart + offset;
        const input = inputs[index]!;
        const status = service!.get(input.tenantId, jobIds.get(index)!)?.status;
        return status === "queued" || status === "running" ? 1 : 0;
      }).reduce<number>((sum, value) => sum + value, 0);
      maxObservedNonterminalJobs = Math.max(maxObservedNonterminalJobs, nonterminal);
      sampleMemory();
    }
    await service.idle();
    phaseMetrics.push({
      uniqueJobConcurrency,
      uniqueJobs: to - from,
      submissions: (to - from) * SUBMISSIONS_PER_JOB,
      durationMs: Number((performance.now() - phaseStarted).toFixed(3)),
      submission: latencySummary(phaseLatencies),
    });
    sampleMemory();
  };

  try {
    await startSidecar();
    await submitRange(0, 100, 1);
    await stopSidecar();
    await startSidecar();
    await submitRange(100, 400, 10);
    await stopSidecar();
    await startSidecar();
    await submitRange(400, 700, 50);
    await submitRange(700, UNIQUE_JOBS, 100);

    if (!app || !service) throw new Error("Final sidecar is not running.");
    for (let index = 0; index < CONFLICTS; index += 1) {
      const sourceIndex = index * Math.floor(UNIQUE_JOBS / CONFLICTS);
      const base = inputs[sourceIndex]!;
      const response = await app.inject({
        method: "POST",
        url: "/v1/goal-jobs",
        headers: auth,
        payload: { ...base, requestId: `${base.requestId}-conflict`, ordinaryGoal: `${base.ordinaryGoal} Changed.` },
      });
      if (response.statusCode === 409) conflictRejections += 1;
      else failures.push(`Conflicting request ${sourceIndex} returned HTTP ${response.statusCode}.`);
    }

    for (let probe = 0; probe < CROSS_TENANT_PROBES; probe += 1) {
      const index = probe * Math.floor(UNIQUE_JOBS / CROSS_TENANT_PROBES);
      const input = inputs[index]!;
      const jobId = jobIds.get(index)!;
      const wrongTenant = input.tenantId === "tenant-49" ? "tenant-48" : "tenant-49";
      const response = await app.inject({
        method: "GET",
        url: `/v1/goal-jobs/${jobId}?tenantId=${wrongTenant}`,
        headers: auth,
      });
      if (response.statusCode === 404) crossTenantReadsBlocked += 1;
      else failures.push(`Cross-tenant probe ${probe} returned HTTP ${response.statusCode}.`);
    }

    const unauthorized = await app.inject({ method: "GET", url: "/v1/goal-jobs/00000000000000000000000000000000?tenantId=tenant-00" });
    if (unauthorized.statusCode !== 401) failures.push("Unauthenticated status read was not rejected.");

    let completedJobs = 0;
    let missingTerminalRecords = 0;
    let retryLimitViolations = 0;
    let eventRecords = 0;
    for (let index = 0; index < UNIQUE_JOBS; index += 1) {
      const input = inputs[index]!;
      const receipt = service.get(input.tenantId, jobIds.get(index)!);
      if (!receipt || receipt.status !== "completed" || receipt.result?.status !== "completed") {
        missingTerminalRecords += 1;
        continue;
      }
      completedJobs += 1;
      if (
        receipt.result.state.aggregate?.passed !== true
        || receipt.result.state.aggregate.incorrectSideEffects !== 0
        || receipt.result.state.resume?.completed !== true
      ) {
        prematureCompletionSignals += 1;
      }
      const expectedAttempts = index < ABRUPT_RECOVERIES ? 2 : 1;
      if (receipt.attempts !== expectedAttempts || receipt.attempts > 3) retryLimitViolations += 1;
      const events = service.events(input.tenantId, receipt.jobId);
      eventRecords += events.length;
      if (events.at(-1)?.type !== "job.completed") missingTerminalRecords += 1;
    }

    for (let index = 0; index < 250; index += 1) {
      const sourceIndex = index * 4;
      const input = inputs[sourceIndex]!;
      const statusStarted = performance.now();
      const response = await app.inject({
        method: "GET",
        url: `/v1/goal-jobs/${jobIds.get(sourceIndex)!}?tenantId=${input.tenantId}`,
        headers: auth,
      });
      statusReadLatencies.push(performance.now() - statusStarted);
      if (response.statusCode !== 200) failures.push(`Status latency probe ${sourceIndex} returned HTTP ${response.statusCode}.`);
    }
    sampleMemory();

    const duplicateBusinessExecutions = [...executions.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
    const provisional = {
      completedJobs,
      uniqueBusinessExecutions: executions.size,
      duplicateBusinessExecutions,
      missingTerminalRecords,
      conflictRejections,
      crossTenantReadsBlocked,
      prematureCompletionSignals,
      retryLimitViolations,
      redactionFailures: 0,
    };
    const candidateCommit = commit();
    const sourceHashes = hashSidecarSoakSources(repositoryRoot, SOURCE_FILES);
    const passBeforeRedaction = completedJobs === UNIQUE_JOBS
      && executions.size === UNIQUE_JOBS
      && duplicateBusinessExecutions === 0
      && missingTerminalRecords === 0
      && conflictRejections === CONFLICTS
      && crossTenantReadsBlocked === CROSS_TENANT_PROBES
      && prematureCompletionSignals === 0
      && retryLimitViolations === 0
      && failures.length === 0;
    const durationMs = Number((performance.now() - start).toFixed(3));
    const finalMemory = process.memoryUsage();
    const fileBytes = (filename: string) => fs.existsSync(filename) ? fs.statSync(filename).size : 0;
    let report: SidecarSoakReport = {
      protocol: SIDECAR_SOAK_PROTOCOL,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs,
      passed: passBeforeRedaction,
      candidateCommit,
      sourceHashes,
      configuration: {
        tenants: TENANTS,
        uniqueJobs: UNIQUE_JOBS,
        submissionsPerJob: SUBMISSIONS_PER_JOB,
        totalSubmissions: UNIQUE_JOBS * SUBMISSIONS_PER_JOB,
        abruptRunningRecoveries: ABRUPT_RECOVERIES,
        cleanRestarts: CLEAN_RESTARTS,
        conflictingRequests: CONFLICTS,
        crossTenantReadProbes: CROSS_TENANT_PROBES,
      },
      results: provisional,
      performance: {
        submission: latencySummary(submissionLatencies),
        statusRead: latencySummary(statusReadLatencies),
        startup: latencySummary(startupLatencies),
        phases: phaseMetrics,
        throughputUniqueJobsPerSecond: Number((UNIQUE_JOBS / (durationMs / 1_000)).toFixed(3)),
        maxObservedNonterminalJobs,
        memory: {
          startRssBytes: startMemory.rss,
          peakRssBytes,
          finalRssBytes: finalMemory.rss,
          peakHeapUsedBytes,
        },
        storage: {
          databaseBytes: fileBytes(databasePath),
          walBytes: fileBytes(`${databasePath}-wal`),
          eventRecords,
        },
      },
      failures,
      evidenceBoundary: "High-volume deterministic local sidecar evidence using simulated bounded writes. It is not long-duration production load, a customer deployment, genuine-system throughput evidence, or a production reliability percentage.",
    };
    writeSidecarSoakArtifacts(directory, report);
    const artifactText = ["result.json", "REPORT.md"].map((file) => fs.readFileSync(path.join(directory, file), "utf8")).join("\n");
    const redactionFailures = artifactText.includes(ACCESS_TOKEN) || /Bearer\s+[A-Za-z0-9._-]+/.test(artifactText) ? 1 : 0;
    if (redactionFailures > 0) failures.push("A configured secret appeared in a report artifact.");
    report = {
      ...report,
      passed: report.passed && redactionFailures === 0,
      results: { ...report.results, redactionFailures },
      failures,
    };
    writeSidecarSoakArtifacts(directory, report);
    console.log(JSON.stringify({ directory, passed: report.passed, durationMs: report.durationMs, configuration: report.configuration, results: report.results }, null, 2));
    if (!report.passed) process.exitCode = 1;
  } finally {
    await stopSidecar();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
