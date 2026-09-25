import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CapabilityRuntime } from "../runtime.js";
import {
  BROAD_GOAL_REQUEST_SCHEMA_VERSION,
  type BroadGoalRequest,
  type BroadGoalRunResult,
} from "../product/broad-goal-sdk.js";
import type {
  PilotAdapterAcceptanceCase,
  PilotAdapterAcceptanceHarness,
  PilotAdapterAcceptanceResult,
  PilotAdapterCheck,
} from "../product/pilot-adapter.js";
import { REQUIRED_PILOT_ADAPTER_CASES } from "../product/pilot-adapter.js";
import { SidecarGoalJobService, SidecarGoalJobStore } from "../product/sidecar-jobs.js";
import {
  createGiteaReferenceCapability,
  executeReconciledGiteaIssue,
  type GiteaAcceptanceCaseId,
  type GiteaCaseState,
  type RealGiteaWorld,
} from "./real-gitea-world.js";

export interface RealGiteaAcceptanceOptions {
  world: RealGiteaWorld;
  dataDirectory: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function request(caseId: PilotAdapterAcceptanceCase): BroadGoalRequest {
  return {
    schemaVersion: BROAD_GOAL_REQUEST_SCHEMA_VERSION,
    tenantId: "local-gitea-acceptance",
    parentGoalId: `parent-gitea-${caseId}`,
    requestId: `request-gitea-${caseId}`,
    scopeKey: "gitea-incident-intake-v1",
    ordinaryGoal: `Ensure the exact bounded synthetic incident for ${caseId} exists once in the approved repository.`,
    visibility: "full",
  };
}

function completed(input: BroadGoalRequest, writesAttempted: number): BroadGoalRunResult {
  const timestamp = new Date().toISOString();
  const planDigest = digest(`${input.requestId}:plan`);
  return {
    status: "completed",
    tenantId: input.tenantId,
    parentGoalId: input.parentGoalId,
    requestId: input.requestId,
    planning: {
      source: "newly-validated",
      attempts: 1,
      validationReceiptId: `validation-${input.requestId}`,
      planDigest,
      workItems: 1,
    },
    state: {
      schemaVersion: "1.0",
      tenantId: input.tenantId,
      parentGoalId: input.parentGoalId,
      requestId: input.requestId,
      planDigest,
      version: 1,
      lifecycle: "completed",
      items: {},
      aggregate: {
        verifierVersion: "gitea-independent-api-v1",
        receiptId: digest(`${input.requestId}:receipt`).slice(0, 32),
        result: "complete",
        passed: true,
        requiredItems: 1,
        completedItems: 1,
        blockedItems: 0,
        failedItems: 0,
        unknownItems: 0,
        incorrectSideEffects: 0,
        stateDigest: digest(`${input.requestId}:external-state:${writesAttempted}`),
        checks: [{ id: "gitea-direct", passed: true, detail: "Gitea state was independently verified." }],
        verifiedAt: timestamp,
      },
      resume: { completed: true, summary: "The bounded parent goal resumed after direct verification." },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

function check(id: string, passed: boolean, detail: string): PilotAdapterCheck {
  return { id, passed, detail };
}

async function execute(
  world: RealGiteaWorld,
  state: GiteaCaseState,
  profile: "full" | "read-only" | "missing",
  runId: string,
) {
  const manifest = createGiteaReferenceCapability(world.documentation, world.secretAlias(profile));
  const runtime = new CapabilityRuntime(world.runtimeConfiguration(profile));
  return executeReconciledGiteaIssue(manifest, runtime, state, runId);
}

async function runSidecar(
  world: RealGiteaWorld,
  state: GiteaCaseState,
  databasePath: string,
  caseId: GiteaAcceptanceCaseId,
) {
  let calls = 0;
  const service = new SidecarGoalJobService(
    new SidecarGoalJobStore(databasePath),
    {
      completeGoal: async (input) => {
        calls += 1;
        const receipts = await execute(world, state, "full", `gitea-sidecar-${caseId}-${calls}`);
        const direct = await world.verify(caseId);
        if (!direct.passed || direct.incorrectSideEffects > 0) {
          throw new Error("Independent Gitea verification rejected the sidecar result.");
        }
        return completed(input, receipts.filter((item) => item.action === "create_issue").length);
      },
    },
  );
  return { service, get calls() { return calls; } };
}

export function createRealGiteaPilotAcceptanceHarness(
  options: RealGiteaAcceptanceOptions,
): PilotAdapterAcceptanceHarness {
  const { world, dataDirectory } = options;
  return {
    caseIds: [...REQUIRED_PILOT_ADAPTER_CASES],
    run: async (caseId): Promise<PilotAdapterAcceptanceResult> => {
      const caseDirectory = path.join(dataDirectory, "cases", caseId);
      fs.mkdirSync(caseDirectory, { recursive: true, mode: 0o700 });
      const giteaCaseId: GiteaAcceptanceCaseId = caseId === "read-only-happy-path"
        ? "already-satisfied"
        : caseId;
      const state = await world.reset(giteaCaseId);
      const checks: PilotAdapterCheck[] = [];
      let intendedWrites = 0;
      let incorrectSideEffects = 0;

      switch (caseId) {
        case "read-only-happy-path": {
          const receipts = await execute(world, state, "full", "gitea-acceptance-already-satisfied");
          const direct = await world.verify(giteaCaseId);
          intendedWrites = direct.intendedWrites;
          incorrectSideEffects = direct.incorrectSideEffects;
          checks.push(
            check("read-before-decide", receipts.length === 1 && receipts[0]?.action === "list_issues", "The already-satisfied case performed only the bounded read."),
            check("direct-outcome", direct.passed, "Independent Gitea inspection confirmed the exact issue already existed."),
          );
          break;
        }
        case "approved-write": {
          const receipts = await execute(world, state, "full", "gitea-acceptance-approved");
          const direct = await world.verify(caseId);
          intendedWrites = direct.intendedWrites;
          incorrectSideEffects = direct.incorrectSideEffects;
          checks.push(
            check("list-before-create", receipts.map((item) => item.action).join(",") === "list_issues,create_issue", "Reconciliation preceded the one issue create."),
            check("direct-outcome", direct.passed, "Independent Gitea inspection found one exact issue."),
          );
          break;
        }
        case "fresh-process-reuse": {
          await execute(world, state, "full", "gitea-acceptance-reuse-first");
          const second = await execute(world, state, "full", "gitea-acceptance-reuse-fresh");
          const direct = await world.verify(caseId);
          intendedWrites = direct.intendedWrites;
          incorrectSideEffects = direct.incorrectSideEffects;
          checks.push(
            check("fresh-runtime-reconcile", second.length === 1 && second[0]?.action === "list_issues", "A fresh runtime found the existing issue and made no second write."),
            check("direct-outcome", direct.passed, "Independent inspection found exactly one issue."),
          );
          break;
        }
        case "missing-credential": {
          let refused = false;
          try {
            await execute(world, state, "missing", "gitea-acceptance-missing-credential");
          } catch (error) {
            refused = error instanceof Error && /Unknown secret alias/.test(error.message);
          }
          const direct = await world.verify(caseId);
          intendedWrites = direct.intendedWrites;
          incorrectSideEffects = direct.incorrectSideEffects;
          checks.push(
            check("credential-handoff-boundary", refused, "The runtime refused an unresolved credential alias before HTTP execution."),
            check("zero-write", direct.passed && direct.intendedWrites === 0, "No incident issue was created."),
          );
          break;
        }
        case "missing-permission": {
          let denied = false;
          try {
            await execute(world, state, "read-only", "gitea-acceptance-read-only");
          } catch (error) {
            denied = error instanceof Error && /HTTP 403/.test(error.message);
          }
          const direct = await world.verify(caseId);
          intendedWrites = direct.intendedWrites;
          incorrectSideEffects = direct.incorrectSideEffects;
          checks.push(
            check("genuine-read-only-denial", denied, "Gitea denied POST through a read:issue token."),
            check("zero-write", direct.passed && direct.intendedWrites === 0, "No incident issue was created."),
          );
          break;
        }
        case "lost-response-reconciliation": {
          const manifest = createGiteaReferenceCapability(world.documentation, world.secretAlias("full"));
          const runtime = new CapabilityRuntime(world.runtimeConfiguration("full"));
          const create = manifest.actions.find((item) => item.name === "create_issue")!;
          await runtime.execute(manifest, create.name, {
            owner: world.owner,
            repo: world.repository,
            title: state.title,
            body: state.body,
            labelId: state.labelId,
          }, { runId: "gitea-acceptance-lost-response-prelude" });
          const recovered = await executeReconciledGiteaIssue(
            manifest,
            runtime,
            state,
            "gitea-acceptance-lost-response-recovery",
          );
          const direct = await world.verify(caseId);
          intendedWrites = direct.intendedWrites;
          incorrectSideEffects = direct.incorrectSideEffects;
          checks.push(
            check("reconcile-before-retry", recovered.length === 1 && recovered[0]?.action === "list_issues", "The recovery inspected state and did not repeat the create."),
            check("direct-outcome", direct.passed, "Exactly one issue exists after the discarded response."),
          );
          break;
        }
        case "wrong-or-partial-outcome": {
          let rejected = false;
          try {
            await execute(world, state, "full", "gitea-acceptance-wrong-partial");
          } catch (error) {
            rejected = error instanceof Error && /incorrect partial issue/.test(error.message);
          }
          const detected = await world.verify(caseId);
          const cleanedState = await world.reset(caseId, { seedInitialState: false });
          const clean = await world.verify(cleanedState.caseId);
          intendedWrites = clean.intendedWrites;
          incorrectSideEffects = clean.incorrectSideEffects;
          checks.push(
            check("partial-outcome-rejected", rejected && !detected.passed && detected.incorrectSideEffects > 0, "The wrong partial issue was detected and no second issue was created over it."),
            check("cleanup-verified", clean.passed && clean.incorrectSideEffects === 0, "The deliberately injected bad state was removed and cleanup independently verified."),
          );
          break;
        }
        case "sidecar-restart": {
          const input = request(caseId);
          const databasePath = path.join(caseDirectory, "jobs.sqlite");
          const oldStore = new SidecarGoalJobStore(databasePath);
          const created = oldStore.create(input).job;
          oldStore.claim(input.tenantId, created.jobId);
          await execute(world, state, "full", "gitea-acceptance-restart-prelude");
          oldStore.close();
          const restarted = await runSidecar(world, state, databasePath, caseId);
          restarted.service.recover();
          await restarted.service.idle();
          const job = restarted.service.get(input.tenantId, created.jobId);
          const direct = await world.verify(caseId);
          intendedWrites = direct.intendedWrites;
          incorrectSideEffects = direct.incorrectSideEffects;
          checks.push(
            check("restart-recovered", job?.status === "completed" && job.attempts === 2, "The durable running job recovered after restart."),
            check("no-duplicate", direct.passed && restarted.calls === 1, "Recovery reconciled the existing issue without a duplicate."),
          );
          await restarted.service.close();
          break;
        }
        case "duplicate-submission": {
          const input = request(caseId);
          const runner = await runSidecar(world, state, path.join(caseDirectory, "jobs.sqlite"), caseId);
          const submissions = Array.from({ length: 12 }, () => runner.service.submit(input));
          await runner.service.idle();
          const direct = await world.verify(caseId);
          intendedWrites = direct.intendedWrites;
          incorrectSideEffects = direct.incorrectSideEffects;
          checks.push(
            check("single-job-identity", new Set(submissions.map((item) => item.job.jobId)).size === 1, "All exact duplicates resolved to one durable job."),
            check("single-execution", runner.calls === 1 && direct.passed, "The job executed once and produced one exact issue."),
          );
          await runner.service.close();
          break;
        }
        case "conflicting-parent-reuse": {
          const input = request(caseId);
          const runner = await runSidecar(world, state, path.join(caseDirectory, "jobs.sqlite"), caseId);
          runner.service.submit(input);
          let rejected = false;
          try {
            runner.service.submit({
              ...input,
              requestId: `${input.requestId}-conflict`,
              ordinaryGoal: `${input.ordinaryGoal} Conflicting replacement.`,
            });
          } catch (error) {
            rejected = error instanceof Error && /different request/.test(error.message);
          }
          await runner.service.idle();
          const direct = await world.verify(caseId);
          intendedWrites = direct.intendedWrites;
          incorrectSideEffects = direct.incorrectSideEffects;
          checks.push(
            check("conflict-rejected", rejected, "A different request could not replace the same parent identity."),
            check("original-only", runner.calls === 1 && direct.passed, "Only the original job executed and one exact issue exists."),
          );
          await runner.service.close();
          break;
        }
      }

      const artifactPath = path.join(caseDirectory, "result.json");
      const passed = checks.length > 0 && checks.every((item) => item.passed) && incorrectSideEffects === 0;
      const result: PilotAdapterAcceptanceResult = {
        caseId,
        passed,
        intendedWrites,
        incorrectSideEffects,
        checks,
        artifactReferences: [artifactPath],
        completedAt: new Date().toISOString(),
      };
      fs.writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      return result;
    },
  };
}
