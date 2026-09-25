import fs from "node:fs";
import path from "node:path";
import type { CapabilityManifest } from "../manifest.js";
import { CapabilityRuntime, type RuntimeConfiguration } from "../runtime.js";
import type { BroadGoalCoordinatorSdk, BroadGoalRequest } from "../product/broad-goal-sdk.js";
import type { CapabilityRequest, OutcomeReceipt } from "../product/contracts.js";
import { CapabilityCoordinator, manifestDigest, type CapabilityBuilder, type CapabilityVerifier, type RuntimeResolver } from "../product/coordinator.js";
import type { PilotAdapterAcceptanceCase, PilotAdapterAcceptanceHarness, PilotAdapterAcceptanceResult, PilotAdapterCheck } from "../product/pilot-adapter.js";
import { REQUIRED_PILOT_ADAPTER_CASES } from "../product/pilot-adapter.js";
import { redactValue } from "../product/redaction.js";
import { CapabilityFactorySdk, type CapabilityWorkflow } from "../product/sdk.js";
import { SidecarGoalJobService, SidecarGoalJobStore } from "../product/sidecar-jobs.js";
import { FileTenantCapabilityStore } from "../product/store.js";
import { executeProcurementPlan, executeReconciledProcurementPlan } from "./real-erpnext-procurement-execution.js";
import { createProcurementReferenceCapability, type RealErpNextProcurementWorld } from "./real-erpnext-procurement-world.js";

interface AcceptanceEvidence {
  intendedWrites: number;
  incorrectSideEffects: number;
  checks: PilotAdapterCheck[];
  detail?: Record<string, unknown>;
}

export interface RealErpNextPilotAcceptanceOptions {
  world: RealErpNextProcurementWorld;
  dataDirectory: string;
  scopeKey: string;
  ordinaryGoal: string;
  createBroadGoalCoordinator(rootDirectory: string): Promise<BroadGoalCoordinatorSdk>;
}

const TENANT = "local-erpnext-pilot";

function pass(id: string, detail: string): PilotAdapterCheck {
  return { id, passed: true, detail };
}

function check(id: string, passed: boolean, detail: string): PilotAdapterCheck {
  return { id, passed, detail };
}

function runtimeWithoutCredentials(configuration: RuntimeConfiguration): RuntimeConfiguration {
  return { targets: structuredClone(configuration.targets), secrets: {} };
}

function broadGoalRequest(parentGoalId: string, requestId: string, scopeKey: string, ordinaryGoal: string): BroadGoalRequest {
  return {
    schemaVersion: "1.0",
    tenantId: TENANT,
    parentGoalId,
    requestId,
    scopeKey,
    ordinaryGoal,
    visibility: "full",
  };
}

function capabilityRequest(world: RealErpNextProcurementWorld, caseId: string, requestId: string): CapabilityRequest {
  const secretAlias = world.secretAlias(caseId);
  return {
    context: {
      tenantId: "erpnext-pilot-acceptance",
      requestId,
      workflowKey: "approved-material-request-to-purchase-order",
      ordinaryGoal: world.cases.find((candidate) => candidate.id === caseId)!.ordinaryGoal,
      blockedAt: new Date().toISOString(),
      blockedReason: "The configured abilities cannot complete the approved ERPNext procurement workflow.",
      visibility: "full",
    },
    need: {
      key: "create-linked-purchase-order",
      summary: "Create and record one exact approved ERPNext Purchase Order with reconciliation before retry.",
      requiredActions: ["read_material_request", "find_purchase_order", "create_purchase_order", "update_material_request"],
      targetAliases: ["customer_system"],
      secretAliases: [secretAlias],
      documentationHash: world.documentation.sha256,
    },
    authority: {
      allowedTargetAliases: ["customer_system"],
      allowedSecretAliases: [secretAlias],
      allowedMethods: ["GET", "POST", "PUT"],
      writeAuthority: "preauthorized",
      approvedWriteActions: [],
    },
    runtimeProfile: caseId,
  };
}

class AcceptanceBuilder implements CapabilityBuilder {
  calls = 0;
  constructor(private readonly world: RealErpNextProcurementWorld) {}
  async build(request: CapabilityRequest): Promise<CapabilityManifest> {
    this.calls += 1;
    return createProcurementReferenceCapability(this.world.documentation, request.need.secretAliases[0]!);
  }
}

class ReadProbeVerifier implements CapabilityVerifier {
  constructor(private readonly world: RealErpNextProcurementWorld) {}
  async verify(request: CapabilityRequest, manifest: CapabilityManifest, runtime: CapabilityRuntime) {
    const materialRequestId = this.world.requestId(request.runtimeProfile);
    const required = request.need.requiredActions.every((name) => manifest.actions.some((action) => action.name === name));
    let readable = false;
    try {
      runtime.validateManifest(manifest);
      const action = manifest.actions.find((candidate) => candidate.name === "read_material_request")!;
      await runtime.execute(manifest, action.name, { materialRequestId }, { runId: `acceptance-probe-${request.context.requestId}`, testMode: true });
      readable = true;
    } catch {
      readable = false;
    }
    const checks = [
      check("required-actions", required, "The manifest contains the complete bounded procurement action set."),
      check("customer-local-read-probe", readable, "The candidate passed a non-consequential read probe through the customer-local runtime."),
    ];
    return {
      verifierVersion: "erpnext-pilot-acceptance-read-probe-v1",
      manifestDigest: manifestDigest(manifest),
      documentationHash: request.need.documentationHash,
      passed: checks.every((item) => item.passed),
      checks,
      verifiedAt: new Date().toISOString(),
    };
  }
}

class AcceptanceRuntimeResolver implements RuntimeResolver {
  constructor(private readonly world: RealErpNextProcurementWorld) {}
  resolve(request: CapabilityRequest): CapabilityRuntime {
    return new CapabilityRuntime(this.world.runtimeConfiguration(request.runtimeProfile));
  }
}

class AcceptanceWorkflow implements CapabilityWorkflow {
  constructor(private readonly world: RealErpNextProcurementWorld, private readonly caseId: string) {}
  execute(_request: CapabilityRequest, manifest: CapabilityManifest, runtime: CapabilityRuntime) {
    return executeReconciledProcurementPlan(manifest, runtime, this.world.requestId(this.caseId), `acceptance-${this.caseId}`);
  }
  async verifyOutcome(): Promise<OutcomeReceipt> {
    const direct = this.world.verify(this.caseId);
    return {
      verifierVersion: "erpnext-pilot-acceptance-direct-v1",
      passed: direct.passed,
      intendedWrites: direct.intendedWrites,
      incorrectSideEffects: direct.incorrectSideEffects,
      stateDigest: direct.stateHash,
      checks: direct.issues.length > 0
        ? direct.issues.map((issue) => ({ id: issue.code, passed: false, detail: issue.message }))
        : [{ id: "exact-external-state", passed: true, detail: "Direct ERPNext state matched the case contract." }],
      verifiedAt: new Date().toISOString(),
    };
  }
  async resume() {
    const direct = this.world.verify(this.caseId);
    return { completed: direct.passed, summary: "The ordinary procurement goal resumed only after direct ERPNext verification." };
  }
}

function capabilitySdk(world: RealErpNextProcurementWorld, registryDirectory: string, builder: AcceptanceBuilder): CapabilityFactorySdk {
  const runtimeResolver = new AcceptanceRuntimeResolver(world);
  return new CapabilityFactorySdk({
    coordinator: new CapabilityCoordinator({
      store: new FileTenantCapabilityStore(registryDirectory),
      builder,
      verifier: new ReadProbeVerifier(world),
      runtimeResolver,
      maxVerificationRepairs: 0,
    }),
    runtimeResolver,
  });
}

export function createRealErpNextPilotAcceptanceHarness(options: RealErpNextPilotAcceptanceOptions): PilotAdapterAcceptanceHarness {
  const { world, dataDirectory } = options;
  const evidenceDirectory = path.join(dataDirectory, "acceptance-evidence");
  fs.mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });

  const save = (caseId: PilotAdapterAcceptanceCase, evidence: AcceptanceEvidence): string => {
    const filename = path.join(evidenceDirectory, `${caseId}.json`);
    fs.writeFileSync(filename, `${JSON.stringify(redactValue({ caseId, ...evidence, completedAt: new Date().toISOString() }), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return filename;
  };

  const cases: Record<PilotAdapterAcceptanceCase, () => Promise<AcceptanceEvidence>> = {
    "read-only-happy-path": async () => {
      const before = world.reset("preflight-build");
      const manifest = createProcurementReferenceCapability(world.documentation, world.secretAlias("preflight-build"));
      const runtime = new CapabilityRuntime(world.runtimeConfiguration("preflight-build"));
      const action = manifest.actions.find((candidate) => candidate.name === "read_material_request")!;
      const receipt = await runtime.execute(manifest, action.name, { materialRequestId: world.requestId("preflight-build") }, { runId: "acceptance-read-only" });
      const after = world.stateHash();
      return { intendedWrites: 0, incorrectSideEffects: 0, checks: [check("read-succeeded", receipt.status === 200, "The approved customer-local read returned HTTP 200."), check("state-unchanged", before === after, "Direct database state was unchanged after the read-only action.")] };
    },
    "approved-write": async () => {
      world.reset("preflight-build");
      const manifest = createProcurementReferenceCapability(world.documentation, world.secretAlias("preflight-build"));
      await executeReconciledProcurementPlan(manifest, new CapabilityRuntime(world.runtimeConfiguration("preflight-build")), world.requestId("preflight-build"), "acceptance-approved-write");
      const direct = world.verify("preflight-build");
      return { intendedWrites: direct.intendedWrites, incorrectSideEffects: direct.incorrectSideEffects, checks: [check("direct-outcome", direct.passed, "Direct ERPNext inspection found the exact approved outcome."), check("no-incorrect-side-effects", direct.incorrectSideEffects === 0, "No duplicate, wrong-record or collateral write survived.")], detail: { stateHash: direct.stateHash } };
    },
    "fresh-process-reuse": async () => {
      const root = path.join(dataDirectory, "acceptance-fresh-process-reuse");
      const registry = path.join(root, "registry");
      const builder = new AcceptanceBuilder(world);
      world.reset("preflight-build");
      const built = await capabilitySdk(world, registry, builder).completeBlockedGoal(capabilityRequest(world, "preflight-build", "acceptance-build"), new AcceptanceWorkflow(world, "preflight-build"));
      world.reset("preflight-reuse");
      const reused = await capabilitySdk(world, registry, builder).completeBlockedGoal(capabilityRequest(world, "preflight-reuse", "acceptance-reuse"), new AcceptanceWorkflow(world, "preflight-reuse"));
      const direct = world.verify("preflight-reuse");
      const builtSource = built.status === "completed" ? built.capabilitySource : "handoff";
      const reusedSource = reused.status === "completed" ? reused.capabilitySource : "handoff";
      return { intendedWrites: direct.intendedWrites, incorrectSideEffects: direct.incorrectSideEffects, checks: [check("initial-build", builtSource === "built", "The first SDK process built and retained the capability."), check("fresh-process-reuse", reusedSource === "reused", "A new SDK object reused the retained verified capability."), check("builder-called-once", builder.calls === 1, "Reuse did not call the builder again."), check("direct-outcome", direct.passed, "The reused capability produced the exact verified ERPNext outcome.")] };
    },
    "missing-credential": async () => {
      const before = world.reset("preflight-build");
      const manifest = createProcurementReferenceCapability(world.documentation, world.secretAlias("preflight-build"));
      let stopped = false;
      try { new CapabilityRuntime(runtimeWithoutCredentials(world.runtimeConfiguration("preflight-build"))).validateManifest(manifest); } catch { stopped = true; }
      const after = world.stateHash();
      return { intendedWrites: 0, incorrectSideEffects: 0, checks: [check("credential-stop", stopped, "The trusted runtime rejected the missing credential alias before execution."), check("zero-write-state", before === after, "Direct database state remained unchanged.")] };
    },
    "missing-permission": async () => {
      const before = world.reset("preflight-permission");
      const manifest = createProcurementReferenceCapability(world.documentation, world.secretAlias("preflight-permission"));
      let stopped = false;
      try { await executeReconciledProcurementPlan(manifest, new CapabilityRuntime(world.runtimeConfiguration("preflight-permission")), world.requestId("preflight-permission"), "acceptance-permission-denial"); } catch { stopped = true; }
      const after = world.stateHash();
      const direct = world.verify("preflight-permission");
      return { intendedWrites: 0, incorrectSideEffects: direct.incorrectSideEffects, checks: [check("permission-stop", stopped, "The restricted ERPNext role could read but could not perform the write."), check("zero-write-state", before === after && direct.intendedWrites === 0, "The permission failure left business state unchanged.")] };
    },
    "lost-response-reconciliation": async () => {
      world.reset("preflight-lost-response");
      const requestId = world.requestId("preflight-lost-response");
      const manifest = createProcurementReferenceCapability(world.documentation, world.secretAlias("preflight-lost-response"));
      const runtime = new CapabilityRuntime(world.runtimeConfiguration("preflight-lost-response"));
      await executeProcurementPlan(manifest, runtime, requestId, "acceptance-lost-response-original");
      await executeReconciledProcurementPlan(manifest, runtime, requestId, "acceptance-lost-response-recovered");
      const direct = world.verify("preflight-lost-response");
      return { intendedWrites: direct.intendedWrites, incorrectSideEffects: direct.incorrectSideEffects, checks: [check("reconciled-existing-write", direct.passed, "After the first result was treated as lost, recovery inspected external state and completed without a second order."), check("no-duplicate", !direct.issues.some((issue) => issue.code === "duplicate-write"), "Direct verification found exactly one Purchase Order.")] };
    },
    "wrong-or-partial-outcome": async () => {
      const resetHash = world.reset("preflight-build");
      const requestId = world.requestId("preflight-build");
      const manifest = createProcurementReferenceCapability(world.documentation, world.secretAlias("preflight-build"));
      const partialManifest = structuredClone(manifest);
      partialManifest.actions = partialManifest.actions.filter((action) => action.name !== "update_material_request");
      let executionStopped = false;
      try { await executeProcurementPlan(partialManifest, new CapabilityRuntime(world.runtimeConfiguration("preflight-build")), requestId, "acceptance-partial-outcome"); } catch { executionStopped = true; }
      const detected = world.verify("preflight-build");
      const restoredHash = world.reset("preflight-build");
      return { intendedWrites: 0, incorrectSideEffects: 0, checks: [check("partial-execution-observed", executionStopped, "The deliberately incomplete capability could not finish its declared workflow."), check("direct-verifier-rejected", !detected.passed, "Independent ERPNext inspection rejected the partial external state."), check("test-damage-removed", restoredHash === resetHash, "The disposable test fixture was reset after detection; no injected bad state survived.")], detail: { detectedIncorrectSideEffects: detected.incorrectSideEffects } };
    },
    "sidecar-restart": async () => {
      world.resetBroadGoal();
      const root = path.join(dataDirectory, "acceptance-sidecar-restart");
      const databasePath = path.join(root, "jobs.sqlite");
      const request = broadGoalRequest("acceptance-restart-parent", "acceptance-restart-request", options.scopeKey, options.ordinaryGoal);
      const oldStore = new SidecarGoalJobStore(databasePath);
      const created = oldStore.create(request).job;
      oldStore.claim(request.tenantId, created.jobId);
      oldStore.close();
      const service = new SidecarGoalJobService(new SidecarGoalJobStore(databasePath), await options.createBroadGoalCoordinator(path.join(root, "product")));
      const recovered = service.recover();
      await service.idle();
      const completed = service.get(request.tenantId, created.jobId);
      const eventTypes = service.events(request.tenantId, created.jobId).map((event) => event.type);
      await service.close();
      const direct = world.verifyBroadGoal();
      return { intendedWrites: direct.intendedWrites, incorrectSideEffects: direct.incorrectSideEffects, checks: [check("job-recovered", recovered.length === 1 && eventTypes.includes("job.recovered"), "A running durable job was re-queued after a simulated sidecar restart."), check("recovered-completion", completed?.status === "completed", "The recovered job completed through the unchanged product core."), check("direct-outcome", direct.passed, "The recovered job produced the exact aggregate ERPNext outcome.")] };
    },
    "duplicate-submission": async () => {
      world.resetBroadGoal();
      const root = path.join(dataDirectory, "acceptance-duplicate-submission");
      const service = new SidecarGoalJobService(new SidecarGoalJobStore(path.join(root, "jobs.sqlite")), await options.createBroadGoalCoordinator(path.join(root, "product")));
      const request = broadGoalRequest("acceptance-duplicate-parent", "acceptance-duplicate-request", options.scopeKey, options.ordinaryGoal);
      const first = service.submit(request);
      const duplicate = service.submit(request);
      await service.idle();
      const completed = service.get(request.tenantId, first.job.jobId);
      await service.close();
      const direct = world.verifyBroadGoal();
      return { intendedWrites: direct.intendedWrites, incorrectSideEffects: direct.incorrectSideEffects, checks: [check("same-job", first.created && !duplicate.created && first.job.jobId === duplicate.job.jobId, "The duplicate parent submission resolved to the original durable job."), check("one-worker-attempt", completed?.attempts === 1, "The duplicate did not start a second worker attempt."), check("no-duplicate-write", direct.passed && direct.incorrectSideEffects === 0, "Direct ERPNext inspection found no duplicated business write.")] };
    },
    "conflicting-parent-reuse": async () => {
      const root = path.join(dataDirectory, "acceptance-conflicting-parent");
      const store = new SidecarGoalJobStore(path.join(root, "jobs.sqlite"));
      const request = broadGoalRequest("acceptance-conflict-parent", "acceptance-conflict-request", options.scopeKey, options.ordinaryGoal);
      store.create(request);
      let rejected = false;
      try { store.create({ ...request, requestId: "different-request", ordinaryGoal: "A different ordinary goal must not reuse this parent ID." }); } catch { rejected = true; }
      store.close();
      return { intendedWrites: 0, incorrectSideEffects: 0, checks: [check("conflict-rejected", rejected, "The durable store rejected a different request attempting to reuse the same parent goal ID."), pass("no-run-started", "The conflict was rejected at persistence before a worker or external write started.")] };
    },
  };

  return {
    caseIds: [...REQUIRED_PILOT_ADAPTER_CASES],
    run: async (caseId): Promise<PilotAdapterAcceptanceResult> => {
      let evidence: AcceptanceEvidence;
      try {
        evidence = await cases[caseId]();
      } catch (error) {
        evidence = { intendedWrites: 0, incorrectSideEffects: 0, checks: [check("case-execution", false, error instanceof Error ? error.message : String(error))] };
      }
      const artifact = save(caseId, evidence);
      return {
        caseId,
        passed: evidence.checks.every((item) => item.passed) && evidence.incorrectSideEffects === 0,
        intendedWrites: evidence.intendedWrites,
        incorrectSideEffects: evidence.incorrectSideEffects,
        checks: evidence.checks,
        artifactReferences: [artifact],
        completedAt: new Date().toISOString(),
      };
    },
  };
}
