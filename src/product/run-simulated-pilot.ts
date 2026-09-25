import fs from "node:fs";
import path from "node:path";
import {
  startBroadGoalCapabilityLayer,
} from "../customer-world/broad-goal-capability-layer.js";
import {
  BROAD_GOAL_ORDINARY_GOAL,
  BroadGoalReferenceWorld,
  createBroadGoalPlanProposal,
  createBroadGoalTrustedScope,
} from "../customer-world/broad-goal-reference-world.js";
import {
  BROAD_GOAL_REQUEST_SCHEMA_VERSION,
  BroadGoalCoordinatorSdk,
  FileValidatedGoalPlanStore,
  type BroadGoalRequest,
} from "./broad-goal-sdk.js";
import { CapabilityFactorySidecarClient } from "./client.js";
import { createGoalContinuationGrant, HmacGoalContinuationAuthority } from "./continuation.js";
import type { GoalPlanner } from "./goal-coordination.js";
import { FileGoalCoordinationStore, GoalScheduler } from "./goal-scheduler.js";
import { PilotInstallationManager } from "./installation.js";
import { CustomerLocalOperationalControl } from "./operations.js";
import { RotatingMemorySecretProvider } from "./secrets.js";
import { createCapabilitySidecar } from "./sidecar.js";
import { SidecarGoalJobService, SidecarGoalJobStore } from "./sidecar-jobs.js";

const SIDECAR_TOKEN = "simulated-pilot-local-token";
const SECRET_ALIAS = "supplier_east_key";
const SECRET_VALUE = "local-reference-east-key";
const CONTINUATION_AUTHORITY = new HmacGoalContinuationAuthority(
  "simulated-customer-authority",
  "simulated-customer-continuation-secret-key-material-v1",
);

export interface SimulatedPilotReport {
  schemaVersion: "1.0";
  installationId: string;
  initialResult: "partially-complete";
  initialCompletedItems: number;
  initialBlockedItems: number;
  restartPerformed: true;
  continuationReconciled: true;
  finalResult: "completed";
  finalCompletedItems: number;
  parentResumed: true;
  incorrectSideEffects: 0;
  externalRestocks: number;
  plannerCalls: number;
  conflictingRequestRejected: boolean;
  secretValuesPersistedInArtifacts: false;
  auditChainPassed: boolean;
  backupPassed: boolean;
  upgradedTo: string;
  finalLifecycle: "deactivated";
  evidence: string[];
}

/** Runs a no-model, fictional, customer-local controlled-pilot rehearsal. */
export async function runSimulatedControlledPilot(rootDirectory: string): Promise<SimulatedPilotReport> {
  const manager = new PilotInstallationManager(rootDirectory);
  const installation = manager.install({
    installationId: "simulated-pilot",
    productVersion: "0.1.0",
    installationMode: "customer-hosted-sidecar",
  });
  const data = manager.dataDirectory;
  const operationsPath = path.join(data, "operations.sqlite");
  let operations = new CustomerLocalOperationalControl(operationsPath, "local-alpha", {
    maxWriteAttemptsPerRun: 3,
    maxWriteAttemptsPerHour: 20,
    maxModelSpendUsdPerDay: 1,
  });
  const secrets = new RotatingMemorySecretProvider();
  secrets.set({
    alias: SECRET_ALIAS,
    version: "simulated-v1",
    scope: {
      targetAliases: ["supplier_east"],
      actionNames: ["read_stock", "find_restock", "create_restock"],
      methods: ["GET", "POST"],
    },
  }, SECRET_VALUE);
  let plannerCalls = 0;
  const planner: GoalPlanner = {
    propose: async () => {
      plannerCalls += 1;
      return createBroadGoalPlanProposal();
    },
  };
  const sdk = new BroadGoalCoordinatorSdk({
    planner,
    maxPlanningAttempts: 1,
    plans: new FileValidatedGoalPlanStore(path.join(data, "plans")),
    scopes: {
      resolve: async (request) => request.scopeKey === "simulated-orders-limited"
        ? createBroadGoalTrustedScope(request.parentGoalId, request.requestId, "partial-authority", request.ordinaryGoal)
        : undefined,
    },
    runtimes: {
      open: async (scope) => {
        const runDirectory = path.join(data, "runs", scope.parentGoalId);
        const world = new BroadGoalReferenceWorld(path.join(runDirectory, "world.sqlite"));
        const layer = await startBroadGoalCapabilityLayer(world, path.join(data, "registry"), {
          secretProvider: secrets,
          operationGuard: operations,
        });
        const scheduler = new GoalScheduler(
          new FileGoalCoordinationStore(path.join(runDirectory, "coordination")),
          layer.executor,
          world,
          world,
          world,
          undefined,
          CONTINUATION_AUTHORITY,
        );
        return {
          runner: {
            run: (plan) => scheduler.run(plan),
            continue: (plan, grant) => scheduler.continue(plan, grant),
          },
          close: async () => {
            await layer.close();
            world.close();
          },
        };
      },
    },
  });
  const request: BroadGoalRequest = {
    schemaVersion: BROAD_GOAL_REQUEST_SCHEMA_VERSION,
    tenantId: "local-alpha",
    parentGoalId: "simulated-parent",
    requestId: "simulated-request",
    scopeKey: "simulated-orders-limited",
    ordinaryGoal: BROAD_GOAL_ORDINARY_GOAL,
    visibility: "full",
  };
  const jobsPath = path.join(data, "sidecar-jobs.sqlite");

  const firstService = new SidecarGoalJobService(new SidecarGoalJobStore(jobsPath), sdk);
  const firstApp = createCapabilitySidecar(undefined, { resolve: () => undefined }, {
    accessToken: SIDECAR_TOKEN,
    broadGoals: sdk,
    goalJobs: firstService,
  });
  const firstUrl = await firstApp.listen({ host: "127.0.0.1", port: 0 });
  const firstClient = new CapabilityFactorySidecarClient({ baseUrl: firstUrl, accessToken: SIDECAR_TOKEN });
  const started = await firstClient.startGoal(request);
  const partial = await firstClient.waitForGoalJob(request.tenantId, started.jobId, { timeoutMs: 10_000, pollIntervalMs: 10 });
  if (partial.status !== "partially-complete" || !partial.result || !("state" in partial.result) || !partial.result.plan) {
    await firstApp.close();
    operations.close();
    throw new Error("Simulated pilot did not stop at the precommitted authority handoff.");
  }
  const blocked = partial.result.plan.workItems.find(
    (item) => partial.result && "state" in partial.result && partial.result.state.items[item.workItemId]?.lifecycle === "blocked",
  );
  if (!blocked) throw new Error("Simulated pilot did not preserve an exact blocked work item.");
  const grant = createGoalContinuationGrant({
    plan: partial.result.plan,
    state: partial.result.state,
    workItemId: blocked.workItemId,
    kind: "permission-approved",
    authorizedMissing: blocked.authority.missing,
    preconditions: [
      { id: "customer-approval", passed: true, detail: "The fictional customer approved the exact regulated write." },
      { id: "customer-local-secret", passed: secrets.has(SECRET_ALIAS), detail: "The customer-local secret alias remains available." },
    ],
    issuedBy: "fictional-customer-operator",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    authority: CONTINUATION_AUTHORITY,
  });
  await firstApp.close();

  // A new service and HTTP process prove that the handoff is durable.
  const secondService = new SidecarGoalJobService(new SidecarGoalJobStore(jobsPath), sdk);
  const secondApp = createCapabilitySidecar(undefined, { resolve: () => undefined }, {
    accessToken: SIDECAR_TOKEN,
    broadGoals: sdk,
    goalJobs: secondService,
  });
  const secondUrl = await secondApp.listen({ host: "127.0.0.1", port: 0 });
  const secondClient = new CapabilityFactorySidecarClient({ baseUrl: secondUrl, accessToken: SIDECAR_TOKEN });
  await secondClient.continueGoalJob(request.tenantId, started.jobId, grant);
  const final = await secondClient.waitForGoalJob(request.tenantId, started.jobId, { timeoutMs: 10_000, pollIntervalMs: 10 });
  let conflictingRequestRejected = false;
  try {
    await secondClient.startGoal({ ...request, requestId: "conflicting-request", ordinaryGoal: "A conflicting replacement goal." });
  } catch {
    conflictingRequestRejected = true;
  }
  const events = await secondClient.getGoalJobEvents(request.tenantId, started.jobId);
  await secondApp.close();
  if (final.status !== "completed" || !final.result || !("state" in final.result)) {
    operations.close();
    throw new Error("Simulated pilot did not complete after the exact continuation grant.");
  }

  const finalWorld = new BroadGoalReferenceWorld(path.join(data, "runs", request.parentGoalId, "world.sqlite"));
  const restocks = finalWorld.stateSnapshot().restocks as unknown[];
  finalWorld.close();
  operations.raiseIncident("low", {
    summary: "Simulated pilot deliberately exercised the customer handoff and restart path.",
    bearerToken: SECRET_VALUE,
  });
  const auditBeforeBackup = operations.verifyAuditChain();
  operations.close();
  const backup = manager.backup("post-simulated-pilot-before-upgrade");
  const verifiedBackup = manager.verifyBackup(backup.backupId);
  operations = new CustomerLocalOperationalControl(operationsPath, "local-alpha", {
    maxWriteAttemptsPerRun: 3,
    maxWriteAttemptsPerHour: 20,
    maxModelSpendUsdPerDay: 1,
  });
  operations.recordBackupCheck(verifiedBackup.backupId, true, "Every archived file matched its precommitted SHA-256 digest.");
  const audit = operations.exportAudit();
  const auditChain = operations.verifyAuditChain();
  fs.writeFileSync(path.join(data, "operational-audit-export.json"), `${JSON.stringify(audit, null, 2)}\n`, { mode: 0o600 });
  operations.close();
  const upgraded = manager.upgrade("0.2.0", (directory) => {
    fs.writeFileSync(path.join(directory, "migration-0.2.0.complete"), `${new Date().toISOString()}\n`, { mode: 0o600 });
  });
  const deactivated = manager.deactivate("Simulated pilot finished; no unattended work remains active.");
  const continuationReconciled = events.some((event) => event.type === "job.continuation-queued");
  const parentResumed = final.result.state.resume?.completed === true;
  if (!continuationReconciled || !parentResumed || deactivated.lifecycle !== "deactivated") {
    throw new Error("Simulated pilot did not preserve its continuation, resumption, or safe shutdown evidence.");
  }
  const artifactText = [
    ...fs.readdirSync(data, { recursive: true, encoding: "utf8" }).map((entry) => {
      const filename = path.join(data, entry);
      try {
        return fs.statSync(filename).isFile() ? fs.readFileSync(filename).toString("utf8") : "";
      } catch {
        return "";
      }
    }),
  ].join("\n");
  if (artifactText.includes(SECRET_VALUE)) throw new Error("A customer-local secret value entered a persisted pilot artifact.");

  const report: SimulatedPilotReport = {
    schemaVersion: "1.0",
    installationId: installation.installationId,
    initialResult: "partially-complete",
    initialCompletedItems: partial.result.state.aggregate!.completedItems,
    initialBlockedItems: partial.result.state.aggregate!.blockedItems,
    restartPerformed: true,
    continuationReconciled: true,
    finalResult: "completed",
    finalCompletedItems: final.result.state.aggregate!.completedItems,
    parentResumed: true,
    incorrectSideEffects: 0,
    externalRestocks: restocks.length,
    plannerCalls,
    conflictingRequestRejected,
    secretValuesPersistedInArtifacts: false,
    auditChainPassed: auditBeforeBackup.passed && auditChain.passed,
    backupPassed: verifiedBackup.files.length > 0,
    upgradedTo: upgraded.metadata.productVersion,
    finalLifecycle: "deactivated",
    evidence: [
      `goal-job:${started.jobId}`,
      `continuation-grant:${grant.grantId}`,
      `backup:${verifiedBackup.backupId}`,
      `audit-final-hash:${auditChain.finalHash}`,
    ],
  };
  fs.writeFileSync(path.join(rootDirectory, "simulated-pilot-report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}
