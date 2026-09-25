import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BroadGoalReferenceWorld,
  createBroadGoalPlanProposal,
  createBroadGoalTrustedScope,
  type BroadGoalAuthorityScenario,
} from "./broad-goal-reference-world.js";
import { GoalPlanCompiler, type GoalPlanner, type ValidatedGoalPlan } from "../product/goal-coordination.js";
import {
  FileGoalCoordinationStore,
  GoalScheduler,
  type GoalWorkItemExecutionInput,
  type GoalWorkItemExecutor,
} from "../product/goal-scheduler.js";
import {
  BROAD_GOAL_REQUEST_SCHEMA_VERSION,
  type BroadGoalRequest,
  type BroadGoalRunResult,
} from "../product/broad-goal-sdk.js";
import { SidecarGoalJobService, SidecarGoalJobStore } from "../product/sidecar-jobs.js";
import {
  createStressMatrixDefinitions,
  hashStressMatrixSources,
  summarizeStressMatrix,
  writeStressMatrixArtifacts,
  type StressMatrixTrialDefinition,
  type StressMatrixTrialResult,
} from "../product/reliability-stress-matrix.js";

const SOURCE_FILES = [
  "src/product/reliability-stress-matrix.ts",
  "src/customer-world/run-reliability-stress-matrix.ts",
  "src/customer-world/broad-goal-reference-world.ts",
  "src/product/goal-coordination.ts",
  "src/product/goal-scheduler.ts",
  "src/product/sidecar-jobs.ts",
] as const;

function short(seed: string): string {
  return seed.slice(0, 12);
}

function indexFor(seed: string, length: number): number {
  return createHash("sha256").update(seed).digest().readUInt32LE(0) % length;
}

async function compilePlan(
  seed: string,
  scenario: BroadGoalAuthorityScenario,
  parentPrefix: string,
): Promise<ValidatedGoalPlan> {
  const planner: GoalPlanner = { propose: async () => createBroadGoalPlanProposal() };
  const compiled = await new GoalPlanCompiler(planner, 1).compile(
    createBroadGoalTrustedScope(
      `${parentPrefix}-${short(seed)}`,
      `request-${short(seed)}`,
      scenario,
    ),
  );
  if (compiled.status !== "validated") throw new Error("Trusted reference plan did not validate.");
  return compiled.plan;
}

function scheduler(directory: string, world: BroadGoalReferenceWorld, executor: GoalWorkItemExecutor = world) {
  return new GoalScheduler(
    new FileGoalCoordinationStore(path.join(directory, "coordination")),
    executor,
    world,
    world,
    world,
  );
}

function request(definition: StressMatrixTrialDefinition, tenantId = `tenant-${short(definition.seed)}`): BroadGoalRequest {
  return {
    schemaVersion: BROAD_GOAL_REQUEST_SCHEMA_VERSION,
    tenantId,
    parentGoalId: `parent-${definition.id}-${short(definition.seed)}`,
    requestId: `request-${definition.id}-${short(definition.seed)}`,
    scopeKey: "stress-matrix-scope",
    ordinaryGoal: `Complete the bounded stress trial ${definition.id}.`,
    visibility: "summary",
  };
}

function completed(input: BroadGoalRequest): BroadGoalRunResult {
  const timestamp = new Date().toISOString();
  return {
    status: "completed",
    tenantId: input.tenantId,
    parentGoalId: input.parentGoalId,
    requestId: input.requestId,
    planning: {
      source: "newly-validated",
      attempts: 1,
      validationReceiptId: `validation-${input.requestId}`,
      planDigest: createHash("sha256").update(input.requestId).digest("hex"),
      workItems: 1,
    },
    state: {
      schemaVersion: "1.0",
      tenantId: input.tenantId,
      parentGoalId: input.parentGoalId,
      requestId: input.requestId,
      planDigest: createHash("sha256").update(input.requestId).digest("hex"),
      version: 1,
      lifecycle: "completed",
      items: {},
      aggregate: {
        verifierVersion: "stress-matrix-direct-v1",
        receiptId: `aggregate-${input.requestId}`,
        result: "complete",
        passed: true,
        requiredItems: 0,
        completedItems: 0,
        blockedItems: 0,
        failedItems: 0,
        unknownItems: 0,
        incorrectSideEffects: 0,
        stateDigest: createHash("sha256").update(`${input.requestId}:state`).digest("hex"),
        checks: [{ id: "stress", passed: true, detail: "Bounded deterministic result." }],
        verifiedAt: timestamp,
      },
      resume: { completed: true, summary: "Bounded deterministic parent resumed." },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

async function runClean(definition: StressMatrixTrialDefinition, directory: string) {
  const world = new BroadGoalReferenceWorld(path.join(directory, "world.sqlite"));
  try {
    const plan = await compilePlan(definition.seed, "complete-authority", "clean");
    const result = await scheduler(directory, world).run(plan);
    const snapshot = world.stateSnapshot();
    const passed = result.lifecycle === "completed"
      && result.resume?.completed === true
      && result.aggregate?.incorrectSideEffects === 0
      && (snapshot.restocks as unknown[]).length === 4;
    return { passed, observed: 0, surviving: 0, detail: { lifecycle: result.lifecycle, aggregate: result.aggregate } };
  } finally {
    world.close();
  }
}

async function runAuthority(definition: StressMatrixTrialDefinition, directory: string) {
  const world = new BroadGoalReferenceWorld(path.join(directory, "world.sqlite"));
  try {
    const plan = await compilePlan(definition.seed, "partial-authority", "authority");
    const result = await scheduler(directory, world).run(plan);
    const restocks = world.stateSnapshot().restocks as Array<{ sku: string }>;
    const unauthorized = restocks.filter((row) => row.sku === "sku_calibrated_sensor").length;
    const passed = result.lifecycle === "partially-complete"
      && result.aggregate?.blockedItems === 1
      && result.aggregate.incorrectSideEffects === 0
      && result.resume === undefined
      && unauthorized === 0;
    return { passed, observed: unauthorized, surviving: unauthorized, detail: { lifecycle: result.lifecycle, aggregate: result.aggregate } };
  } finally {
    world.close();
  }
}

async function runRecovery(definition: StressMatrixTrialDefinition, directory: string) {
  const databasePath = path.join(directory, "world.sqlite");
  const plan = await compilePlan(definition.seed, "complete-authority", "recovery");
  const candidates = ["north-coolant", "north-labels", "east-crates", "regulated-sensors"];
  const interruptedKey = candidates[indexFor(definition.seed, candidates.length)]!;
  const modes: Array<{ key: string; mode: string }> = [];
  const firstWorld = new BroadGoalReferenceWorld(databasePath);
  let interrupted = false;
  const interrupting: GoalWorkItemExecutor = {
    execute: async (input: GoalWorkItemExecutionInput) => {
      modes.push({ key: input.item.key, mode: input.mode });
      const receipt = await firstWorld.execute(input);
      if (input.item.key === interruptedKey && !interrupted) {
        interrupted = true;
        throw new Error("Injected process loss after external commit.");
      }
      return receipt;
    },
  };
  try {
    await scheduler(directory, firstWorld, interrupting).run(plan);
    throw new Error("Injected interruption did not interrupt the first process.");
  } catch (error) {
    if (!(error instanceof Error) || !/Injected process loss/.test(error.message)) throw error;
  } finally {
    firstWorld.close();
  }
  const restarted = new BroadGoalReferenceWorld(databasePath);
  try {
    const resumed = await scheduler(directory, restarted, {
      execute: async (input) => {
        modes.push({ key: input.item.key, mode: input.mode });
        return restarted.execute(input);
      },
    }).run(plan);
    const rows = (restarted.stateSnapshot().restocks as Array<{ sku: string; operation_key: string }>);
    const uniqueOperations = new Set(rows.map((row) => row.operation_key));
    const passed = resumed.lifecycle === "completed"
      && resumed.resume?.completed === true
      && resumed.aggregate?.incorrectSideEffects === 0
      && rows.length === 4
      && uniqueOperations.size === rows.length
      && modes.some((entry) => entry.key === interruptedKey && entry.mode === "reconcile");
    return { passed, observed: 0, surviving: 0, detail: { interruptedKey, modes, aggregate: resumed.aggregate } };
  } finally {
    restarted.close();
  }
}

async function withJobService<T>(
  directory: string,
  execute: (input: BroadGoalRequest) => Promise<BroadGoalRunResult>,
  operation: (service: SidecarGoalJobService) => Promise<T>,
  maxAttempts = 2,
): Promise<T> {
  const service = new SidecarGoalJobService(
    new SidecarGoalJobStore(path.join(directory, "jobs.sqlite")),
    { completeGoal: execute },
    { maxAttempts },
  );
  try {
    return await operation(service);
  } finally {
    await service.close();
  }
}

async function runDuplicate(definition: StressMatrixTrialDefinition, directory: string) {
  let calls = 0;
  return withJobService(directory, async (input) => {
    calls += 1;
    return completed(input);
  }, async (service) => {
    const input = request(definition);
    const submissions = Array.from({ length: 12 }, () => service.submit(input));
    await service.idle();
    const jobIds = new Set(submissions.map((entry) => entry.job.jobId));
    const job = service.get(input.tenantId, submissions[0]!.job.jobId);
    const passed = calls === 1 && jobIds.size === 1 && job?.status === "completed";
    return { passed, observed: 0, surviving: 0, detail: { calls, jobIds: jobIds.size, status: job?.status } };
  });
}

async function runConflict(definition: StressMatrixTrialDefinition, directory: string) {
  let calls = 0;
  return withJobService(directory, async (input) => {
    calls += 1;
    return completed(input);
  }, async (service) => {
    const first = request(definition);
    service.submit(first);
    let rejected = false;
    try {
      service.submit({
        ...first,
        requestId: `${first.requestId}-conflict`,
        ordinaryGoal: `${first.ordinaryGoal} Conflicting mutation.`,
      });
    } catch (error) {
      rejected = error instanceof Error && /different request/i.test(error.message);
    }
    await service.idle();
    const passed = rejected && calls === 1;
    return { passed, observed: 0, surviving: 0, detail: { rejected, calls } };
  });
}

async function runTenant(definition: StressMatrixTrialDefinition, directory: string) {
  let calls = 0;
  return withJobService(directory, async (input) => {
    calls += 1;
    return completed(input);
  }, async (service) => {
    const tenantA = request(definition, `tenant-a-${short(definition.seed)}`);
    const tenantB = { ...request(definition, `tenant-b-${short(definition.seed)}`), parentGoalId: tenantA.parentGoalId };
    const first = service.submit(tenantA).job;
    const hidden = service.get(tenantB.tenantId, first.jobId);
    const second = service.submit(tenantB).job;
    await service.idle();
    const passed = hidden === undefined
      && first.jobId !== second.jobId
      && calls === 2
      && service.get(tenantA.tenantId, first.jobId)?.status === "completed"
      && service.get(tenantB.tenantId, second.jobId)?.status === "completed";
    return { passed, observed: 0, surviving: 0, detail: { hidden: hidden === undefined, calls } };
  });
}

async function runIncorrectOutcome(definition: StressMatrixTrialDefinition, directory: string) {
  const world = new BroadGoalReferenceWorld(path.join(directory, "world.sqlite"));
  try {
    const plan = await compilePlan(definition.seed, "complete-authority", "incorrect");
    const corruptKeys = ["north-coolant", "north-labels", "east-crates", "regulated-sensors"];
    const corruptKey = corruptKeys[indexFor(definition.seed, corruptKeys.length)]!;
    const corrupting: GoalWorkItemExecutor = {
      execute: async (input) => {
        const receipt = await world.execute(input);
        if (input.item.key === corruptKey && receipt.status === "executed") {
          const snapshot = world.stateSnapshot();
          const original = (snapshot.restocks as Array<{ sku: string; supplier: string; quantity: number }>).find(
            (row) => row.sku === ({
              "north-coolant": "sku_coolant_pack",
              "north-labels": "sku_cold_chain_labels",
              "east-crates": "sku_insulated_crate",
              "regulated-sensors": "sku_calibrated_sensor",
            } as Record<string, string>)[corruptKey],
          );
          if (!original) throw new Error(`Could not find injected side-effect target ${corruptKey}.`);
          world.database.prepare(
            "INSERT INTO restocks (sku, supplier, quantity, operation_key) VALUES (?, ?, ?, ?)",
          ).run(original.sku, original.supplier, original.quantity, `injected-${short(definition.seed)}`);
        }
        return receipt;
      },
    };
    const result = await scheduler(directory, world, corrupting).run(plan);
    const observed = result.aggregate?.incorrectSideEffects ?? 0;
    const detected = result.lifecycle === "failed" && result.resume === undefined && observed > 0;
    world.reset();
    const clean = (world.stateSnapshot().restocks as unknown[]).length === 0;
    return {
      passed: detected && clean,
      observed,
      surviving: clean ? 0 : observed,
      detail: { corruptKey, lifecycle: result.lifecycle, aggregate: result.aggregate, cleaned: clean },
    };
  } finally {
    world.close();
  }
}

async function runRetryLimit(definition: StressMatrixTrialDefinition, directory: string) {
  let calls = 0;
  return withJobService(directory, async () => {
    calls += 1;
    throw new Error("Injected unavailable executor with Bearer must-be-redacted");
  }, async (service) => {
    const input = request(definition);
    const submitted = service.submit(input).job;
    await service.idle();
    const first = service.get(input.tenantId, submitted.jobId);
    let retryRejected = false;
    try {
      service.retry(input.tenantId, submitted.jobId);
    } catch (error) {
      retryRejected = error instanceof Error && /retry limit/i.test(error.message);
    }
    const serialized = JSON.stringify(first);
    const passed = first?.status === "unknown"
      && first.attempts === 1
      && retryRejected
      && calls === 1
      && !serialized.includes("must-be-redacted");
    return { passed, observed: 0, surviving: 0, detail: { status: first?.status, attempts: first?.attempts, retryRejected, calls } };
  }, 1);
}

async function executeTrial(definition: StressMatrixTrialDefinition, root: string): Promise<StressMatrixTrialResult> {
  const started = performance.now();
  const directory = path.join(root, "trials", definition.id);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let outcome: { passed: boolean; observed: number; surviving: number; detail: Record<string, unknown> };
  try {
    switch (definition.classId) {
      case "clean-completion": outcome = await runClean(definition, directory); break;
      case "authority-boundary": outcome = await runAuthority(definition, directory); break;
      case "lost-result-recovery": outcome = await runRecovery(definition, directory); break;
      case "duplicate-submission": outcome = await runDuplicate(definition, directory); break;
      case "conflicting-parent-reuse": outcome = await runConflict(definition, directory); break;
      case "tenant-isolation": outcome = await runTenant(definition, directory); break;
      case "incorrect-outcome-detection": outcome = await runIncorrectOutcome(definition, directory); break;
      case "retry-limit": outcome = await runRetryLimit(definition, directory); break;
    }
  } catch (error) {
    outcome = {
      passed: false,
      observed: 0,
      surviving: 0,
      detail: { error: error instanceof Error ? { name: error.name, message: error.message } : String(error) },
    };
  }
  return {
    ...definition,
    passed: outcome.passed,
    safetyFailure: outcome.surviving > 0,
    incorrectSideEffectsObserved: outcome.observed,
    incorrectSideEffectsSurviving: outcome.surviving,
    durationMs: Number((performance.now() - started).toFixed(3)),
    detail: outcome.detail,
  };
}

export async function runReliabilityStressMatrix(options: { repositoryRoot?: string; artifactRoot?: string } = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const artifactRoot = path.resolve(options.artifactRoot ?? path.join(repositoryRoot, "artifacts", "reliability-stress"));
  const directory = path.join(artifactRoot, `${STRESS_MATRIX_RUN_PREFIX}-${timestamp}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const sourceHashes = hashStressMatrixSources(repositoryRoot, SOURCE_FILES);
  const definitions = createStressMatrixDefinitions();
  const results: StressMatrixTrialResult[] = [];
  let abortedForSafety = false;
  for (const definition of definitions) {
    const result = await executeTrial(definition, directory);
    results.push(result);
    if (result.safetyFailure) {
      abortedForSafety = true;
      break;
    }
  }
  const report = summarizeStressMatrix(
    startedAt,
    new Date().toISOString(),
    results,
    sourceHashes,
    abortedForSafety,
  );
  writeStressMatrixArtifacts(directory, report);
  return { directory, report };
}

export const STRESS_MATRIX_RUN_PREFIX = "stress-v1";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { directory, report } = await runReliabilityStressMatrix();
  console.log(`Deterministic stress matrix: ${report.passedTrials}/${report.expectedTrials}`);
  console.log(`Result: ${report.passed ? "PASS" : "NOT PASSING"}`);
  console.log(`Evidence: ${directory}`);
  if (!report.passed) process.exitCode = 1;
}
