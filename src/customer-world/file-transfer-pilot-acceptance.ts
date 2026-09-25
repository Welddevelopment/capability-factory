import fs from "node:fs";
import path from "node:path";
import type {
  PilotAdapterAcceptanceCase,
  PilotAdapterAcceptanceHarness,
  PilotAdapterAcceptanceResult,
  PilotAdapterCheck,
} from "../product/pilot-adapter.js";
import { REQUIRED_PILOT_ADAPTER_CASES } from "../product/pilot-adapter.js";
import { redactValue } from "../product/redaction.js";
import { CapabilityModeJobService, CapabilityModeJobStore } from "../product/capability-mode-jobs.js";
import { CAPABILITY_MODE_SCHEMA_VERSION } from "../product/capability-mode-contract.js";
import { CapabilityModeRouter, createFileTransferModeRunner } from "../product/capability-mode-router.js";
import { RotatingMemorySecretProvider } from "../product/secrets.js";
import { ExperimentalFileTransferDriver, fileTransferOutputAlias } from "../experimental/file-transfer-driver.js";
import {
  FICTIONAL_EDI_APPROVAL,
  FictionalEdiFileTransferWorld,
  buildFictionalEdiManifest,
} from "./edi-file-transfer-world.js";
import {
  FICTIONAL_EDIFACT_SECRET_DESCRIPTOR,
  FictionalEdifactNetworkFileWorld,
} from "./edifact-network-file-world.js";

interface CaseEvidence {
  intendedWrites: number;
  incorrectSideEffects: number;
  checks: PilotAdapterCheck[];
}

function check(id: string, passed: boolean, detail: string): PilotAdapterCheck {
  return { id, passed, detail };
}

function localWorld(root: string): FictionalEdiFileTransferWorld {
  return new FictionalEdiFileTransferWorld(root);
}

function input(world: FictionalEdiFileTransferWorld, caseId: string) {
  const alias = `${caseId}.edi`;
  const source = world.writeInput({
    fileAlias: alias,
    purchaseOrderNumber: `PO-${caseId.toUpperCase()}`,
    lines: [{ itemCode: "BOLT-10", quantity: 2 }],
  });
  return { alias, source };
}

function envelope(world: FictionalEdiFileTransferWorld, caseId: string, parentGoalId?: string) {
  const created = input(world, caseId);
  return {
    schemaVersion: CAPABILITY_MODE_SCHEMA_VERSION,
    capabilityMode: "experimental-file-transfer-actions" as const,
    request: world.request({
      requestId: `request-${caseId}`,
      parentGoalId: parentGoalId ?? `parent-${caseId}`,
      operationKey: `operation-${caseId}`,
      inputFileAlias: created.alias,
      expectedInputSha256: created.source.sha256,
    }),
  };
}

/** Full ten-case local parity campaign for the bounded file/EDI family. */
export function createFileTransferPilotAcceptanceHarness(dataDirectory: string): PilotAdapterAcceptanceHarness {
  const evidenceDirectory = path.join(dataDirectory, "file-transfer-acceptance-evidence");
  fs.mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });

  const runCase = async (caseId: PilotAdapterAcceptanceCase): Promise<CaseEvidence> => {
    const root = path.join(dataDirectory, `world-${caseId}`);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (caseId === "read-only-happy-path") {
      const world = localWorld(root);
      const driver = new ExperimentalFileTransferDriver({
        "partner-orders-inbox": world.target,
        "customer-order-outbox": world.target,
      });
      const verification = await driver.verifyCapability(buildFictionalEdiManifest(world.contractHash));
      return { intendedWrites: 0, incorrectSideEffects: 0, checks: [
        check("no-write-probe", verification.passed, "The pinned EDI capability parsed its disposable probe without writing an order."),
        check("outbox-unchanged", world.listOutputs().length === 0, "Pre-use verification left the customer outbox unchanged."),
      ] };
    }
    if (caseId === "approved-write") {
      const world = localWorld(root); const created = input(world, caseId);
      const result = await world.complete({ requestId: `request-${caseId}`, operationKey: `operation-${caseId}`, inputFileAlias: created.alias, expectedInputSha256: created.source.sha256 });
      return { intendedWrites: world.listOutputs().length, incorrectSideEffects: world.listOutputs().length === 1 ? 0 : 1, checks: [
        check("completed", result.status === "completed", "The approved bounded EDI write completed."),
        check("one-output", world.listOutputs().length === 1, "Independent outbox inspection found exactly one intended order."),
      ] };
    }
    if (caseId === "fresh-process-reuse") {
      const world = localWorld(root); const firstInput = input(world, "reuse-one");
      const first = await world.sdk().completeGoal(world.request({ requestId: "reuse-one", operationKey: "reuse-one", inputFileAlias: firstInput.alias, expectedInputSha256: firstInput.source.sha256 }));
      const secondInput = input(world, "reuse-two");
      const second = await world.sdk().completeGoal(world.request({ requestId: "reuse-two", operationKey: "reuse-two", inputFileAlias: secondInput.alias, expectedInputSha256: secondInput.source.sha256 }));
      return { intendedWrites: world.listOutputs().length, incorrectSideEffects: world.listOutputs().length === 2 ? 0 : 1, checks: [
        check("first-built", first.status === "completed" && first.path === "built-capability", "The first SDK constructed and retained the capability."),
        check("fresh-reuse", second.status === "completed" && second.path === "retained-capability", "A fresh SDK object reused the retained capability."),
      ] };
    }
    if (caseId === "missing-credential") {
      const world = new FictionalEdifactNetworkFileWorld(root); await world.start();
      try {
        const created = world.writeInput({ fileAlias: "missing-credential.unb", purchaseOrderNumber: "MISSING-CREDENTIAL", lines: [{ itemCode: "BOLT-10", quantity: 1 }] });
        const emptySecrets = new RotatingMemorySecretProvider();
        const result = await world.sdk(emptySecrets).completeGoal(world.request({ requestId: "missing-credential", operationKey: "missing-credential", inputFileAlias: "missing-credential.unb", expectedInputSha256: created.sha256 }));
        return { intendedWrites: world.outputAliases().length, incorrectSideEffects: 0, checks: [
          check("blocked", result.status === "blocked", "The unresolved customer-local gateway credential stopped the route."),
          check("zero-write", world.outputAliases().length === 0, "Missing credentials produced zero network outbox writes."),
        ] };
      } finally { await world.close(); }
    }
    if (caseId === "missing-permission") {
      const world = localWorld(root); const created = input(world, caseId);
      const result = await world.complete({ requestId: `request-${caseId}`, operationKey: `operation-${caseId}`, inputFileAlias: created.alias, expectedInputSha256: created.source.sha256, approvals: [] });
      return { intendedWrites: world.listOutputs().length, incorrectSideEffects: 0, checks: [
        check("blocked", result.status === "blocked" && result.handoff.reason === "authority-missing", "The exact missing approval produced a precise handoff."),
        check("zero-write", world.listOutputs().length === 0, "Missing permission produced zero outbox writes."),
      ] };
    }
    if (caseId === "lost-response-reconciliation") {
      const world = localWorld(root); const created = input(world, caseId);
      const request = world.request({ requestId: `request-${caseId}`, operationKey: `operation-${caseId}`, inputFileAlias: created.alias, expectedInputSha256: created.source.sha256, simulateLostResponseAfterCommit: true });
      const result = await world.sdk().completeGoal(request);
      const replay = await world.sdk().completeGoal({ ...request, requestId: "request-lost-response-replay", simulateLostResponseAfterCommit: false });
      return { intendedWrites: world.listOutputs().length, incorrectSideEffects: world.listOutputs().length === 1 ? 0 : 1, checks: [
        check("reconciled", result.status === "completed" && result.execution.reconciled, "The post-commit response loss was reconciled against the outbox."),
        check("replay-zero-write", replay.status === "completed" && replay.execution.writesAttempted === 0, "A replay recognized completion without another write."),
        check("one-output", world.listOutputs().length === 1, "Exactly one external output survived."),
      ] };
    }
    if (caseId === "wrong-or-partial-outcome") {
      const world = localWorld(root); const created = input(world, caseId); const operationKey = `operation-${caseId}`;
      const completed = await world.complete({ requestId: `request-${caseId}`, operationKey, inputFileAlias: created.alias, expectedInputSha256: created.source.sha256 });
      const outputPath = path.join(world.outputRoot, fileTransferOutputAlias(operationKey));
      const altered = JSON.parse(fs.readFileSync(outputPath, "utf8")) as { lines: Array<{ quantity: number }> };
      altered.lines[0]!.quantity = 499; fs.writeFileSync(outputPath, JSON.stringify(altered), { mode: 0o600 });
      const rejected = await world.complete({ requestId: "request-wrong-repeat", operationKey, inputFileAlias: created.alias, expectedInputSha256: created.source.sha256 });
      fs.rmSync(outputPath, { force: true });
      return { intendedWrites: completed.status === "completed" ? 1 : 0, incorrectSideEffects: 0, checks: [
        check("wrong-rejected", rejected.status === "blocked" && rejected.handoff.reason === "file-outcome-unsafe", "Independent verification rejected the altered external outcome."),
        check("damage-cleaned", world.listOutputs().length === 0, "The disposable incorrect state was removed after detection."),
      ] };
    }
    if (caseId === "sidecar-restart") {
      const world = localWorld(root); const jobPath = path.join(root, "mode-jobs.sqlite"); const body = envelope(world, caseId);
      const firstStore = new CapabilityModeJobStore(jobPath); const saved = firstStore.create(body).job; firstStore.claim(body.request.tenantId, saved.jobId); firstStore.close();
      const service = new CapabilityModeJobService(new CapabilityModeJobStore(jobPath), new CapabilityModeRouter([createFileTransferModeRunner(world.sdk())]));
      const recovered = service.recover(); await service.idle(); const terminal = service.get(body.request.tenantId, saved.jobId); const events = service.events(body.request.tenantId, saved.jobId);
      await service.close();
      return { intendedWrites: world.listOutputs().length, incorrectSideEffects: world.listOutputs().length === 1 ? 0 : 1, checks: [
        check("recovered", recovered.length === 1 && events.some((event) => event.type === "mode-job.recovered"), "The exact claimed job was recovered after restart."),
        check("completed", terminal?.status === "completed", "The recovered job completed without replanning."),
        check("one-output", world.listOutputs().length === 1, "Restart recovery produced exactly one external output."),
      ] };
    }
    if (caseId === "duplicate-submission") {
      const world = localWorld(root); const body = envelope(world, caseId); const service = new CapabilityModeJobService(new CapabilityModeJobStore(path.join(root, "jobs.sqlite")), new CapabilityModeRouter([createFileTransferModeRunner(world.sdk())]));
      const first = service.submit(body); const duplicate = service.submit(body); await service.idle(); const terminal = service.get(body.request.tenantId, first.job.jobId); await service.close();
      return { intendedWrites: world.listOutputs().length, incorrectSideEffects: world.listOutputs().length === 1 ? 0 : 1, checks: [
        check("same-job", first.created && !duplicate.created && first.job.jobId === duplicate.job.jobId, "Duplicate submission resolved to one durable job."),
        check("one-attempt", terminal?.attempts === 1, "Only one worker attempt ran."),
        check("one-output", world.listOutputs().length === 1, "Only one external output exists."),
      ] };
    }
    const world = localWorld(root); const parentGoalId = "conflicting-parent"; const first = envelope(world, "conflict-one", parentGoalId);
    const store = new CapabilityModeJobStore(path.join(root, "jobs.sqlite")); store.create(first); let rejected = false;
    const secondInput = input(world, "conflict-two");
    try {
      store.create({ ...first, request: { ...first.request, requestId: "different-request", ordinaryGoal: "Different intent must not reuse the parent.", operationKey: "different-operation", inputFileAlias: secondInput.alias, expectedInputSha256: secondInput.source.sha256 } });
    } catch { rejected = true; }
    store.close();
    return { intendedWrites: 0, incorrectSideEffects: 0, checks: [
      check("conflict-rejected", rejected, "A different request could not reuse the existing parent identity."),
      check("zero-write", world.listOutputs().length === 0, "The conflict was rejected before execution."),
    ] };
  };

  return {
    caseIds: [...REQUIRED_PILOT_ADAPTER_CASES],
    run: async (caseId): Promise<PilotAdapterAcceptanceResult> => {
      let evidence: CaseEvidence;
      try { evidence = await runCase(caseId); }
      catch (error) { evidence = { intendedWrites: 0, incorrectSideEffects: 0, checks: [check("case-execution", false, error instanceof Error ? error.message : String(error))] }; }
      const artifact = path.join(evidenceDirectory, `${caseId}.json`);
      fs.writeFileSync(artifact, `${JSON.stringify(redactValue({ caseId, ...evidence, completedAt: new Date().toISOString() }), null, 2)}\n`, { mode: 0o600 });
      return { caseId, passed: evidence.checks.every((item) => item.passed) && evidence.incorrectSideEffects === 0, intendedWrites: evidence.intendedWrites, incorrectSideEffects: evidence.incorrectSideEffects, checks: evidence.checks, artifactReferences: [artifact], completedAt: new Date().toISOString() };
    },
  };
}
