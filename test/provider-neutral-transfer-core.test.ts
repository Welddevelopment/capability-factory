import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Cf053ContentAddressedCandidateRegistry,
  Cf053ProductionAuthorityBroker,
  adoptCf053ProcessGeneration,
  attemptCf053DevelopmentMismatchedBody,
  attemptCf053DevelopmentRawRequest,
  cf053Digest,
  checkCf053DevelopmentPlanAdmission,
  closeCf053ProviderProcesses,
  completeCf053ProductionParent,
  createCf053AuthoritySigner,
  createCf053ProviderNeutralContract,
  deriveCf053StableIdentity,
  deriveCf053ProviderNeutralContract,
  executeCf053DevelopmentTransfer,
  executeCf053Transfer,
  issueCf053DevelopmentAuthority,
  launchCf053DevelopmentProcesses,
  launchCf053ProviderProcesses,
  openCf053TrustedWorkspaceInputStore,
  runCf053AuthorKnownTwoItemGoal,
  readCf053BoundedResponseForDevelopment,
  recoverCf053AbandonedGeneration,
  recoverCf053AbandonedPendingGeneration,
  type Cf053AuthorityReceipt,
  type Cf053ProviderNeutralContract,
} from "../src/product/local-declarative-exact-record-core.js";
import { validateGoalPlan, type GoalPlanProposal, type TrustedGoalScope } from "../src/product/goal-coordination.js";
import { applyProviderEvidenceReuse, prepareProviderEvidenceReuse } from "../src/product/customer-local-provider-evidence-reuse.js";
import { closeProviderWorkEvidenceCoordinator, createCoordinatedProviderWorkBoard, createProviderWorkEvidenceCoordinator, providerWorkBoardDigest, type ProviderWorkBoardInput, type ProviderWorkJourneyReader } from "../src/product/customer-local-provider-work-board.js";
import { CF053_FIXTURE_NOW, cf053UpstreamFixture, cf053UpstreamSource } from "./fixtures/cf053-author-known-upstream.js";

// Anchored to the fixture's real-clock base: lease/authority expiry is enforced
// against real time in trust code, so a fixed historical NOW lapses as wall
// time passes.
const T0 = Date.parse(CF053_FIXTURE_NOW);
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const NOW = at(0);
const INPUT_ONE = { unit_code: "unit-a", amount: 7, confirmed: true };
const INPUT_TWO = { unit_code: "unit-b", amount: 12, confirmed: false };
const execFileAsync = promisify(execFile);

function contract(): Cf053ProviderNeutralContract {
  const roles = (["action", "no-write-probe", "reconciliation-readback", "independent-observer"] as const).map((role) => ({ role, module: `${role.replace(/-/g, "_")}_module`, className: "AuthorKnownClient", methodName: `${role.replace(/-/g, "_")}_method`, methodDigest: cf053Digest({ role }), parameters: [{ parameter: "unit_code", inputKey: "unit_code", type: "string" as const }, { parameter: "amount", inputKey: "amount", type: "number" as const }, { parameter: "confirmed", inputKey: "confirmed", type: "boolean" as const }] }));
  const bindingBody = { runtimeSemantics: "local-declarative-exact-record-v1" as const, roles, predicates: [{ key: "unit", path: ["unit_code"], operator: "equals-input" as const, inputKey: "unit_code" }, { key: "amount", path: ["amount"], operator: "equals-input" as const, inputKey: "amount" }, { key: "confirmed", path: ["confirmed"], operator: "equals-input" as const, inputKey: "confirmed" }], duplicatePath: ["matches"], collateralPredicates: [{ key: "clean", path: ["collateralClean"], operator: "equals-confirmed" as const, expected: true }], freshnessPath: ["observedAt"] };
  return createCf053ProviderNeutralContract({
    schemaVersion: "1.0",
    contractId: "author_known_contract",
    tenantId: "author_known_tenant",
    sourceChain: {
      cf041ReviewedContractDigest: "1".repeat(64),
      cf051SourceReviewReceiptDigest: "2".repeat(64),
      cf036WorkPackDigest: "3".repeat(64),
      cf051BoardSnapshotDigest: "4".repeat(64),
    },
    workspaceIssuerPublicKeyDigest: "5".repeat(64),
    inputSchema: [
      { key: "unit_code", type: "string", required: true },
      { key: "amount", type: "number", required: true },
      { key: "confirmed", type: "boolean", required: true },
    ],
    stableIdentityKeys: ["unit_code"],
    exactOutcomeKeys: ["unit_code", "amount", "confirmed"],
    actionScope: "commit one exact fictional author-known unit",
    observerScope: "observe one exact fictional author-known unit",
    targetAlias: "author_known_target",
    policyVersion: "author_known_policy_v1",
    maximumAgeSeconds: 30,
    reconcileBeforeAction: true,
    blindRetryAllowed: false,
    separateObserverRequired: true,
    executionBinding: { ...bindingBody, bindingDigest: cf053Digest(bindingBody) },
  });
}

async function live(root: string) {
  const currentContract = contract();
  const registry = new Cf053ContentAddressedCandidateRegistry(join(root, "registry"));
  const candidate = registry.acquireDevelopment(currentContract, NOW);
  const signer = createCf053AuthoritySigner("test_local_authority");
  const processes = await launchCf053DevelopmentProcesses({ candidate, authoritySigner: signer, worldRoot: join(root, "world"), now: NOW });
  const launch = adoptCf053ProcessGeneration(processes);
  const issuedAt = new Date().toISOString();
  const expectedStableIds = [deriveCf053StableIdentity(currentContract, INPUT_ONE).stableId];
  const authority = issueCf053DevelopmentAuthority({ signer, candidate, exactInput: INPUT_ONE, expectedStableIds, issuedAt, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  return { currentContract, registry, candidate, processes, launch, signer, authority, issuedAt };
}

describe("CF-053 local declarative exact-record core (author-known development fixture only)", () => {
  it("runs the genuine author-known CF-036→041→051 production-derived path through the opaque broker", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf053-core-joined-production-"));
    let processes: Awaited<ReturnType<typeof launchCf053ProviderProcesses>> | null = null;
    const tenantId = "cf053Tenant", journeyId = "cf053Journey", boardId = "cf053Board";
    const upstream = cf053UpstreamFixture(), source = cf053UpstreamSource(upstream.workPack, upstream.contract, tenantId, journeyId);
    const reader: ProviderWorkJourneyReader = { read: () => structuredClone(source.snapshot), events: () => structuredClone(source.events) };
    const statePath = join(root, "provider.sqlite"), coordinator = createProviderWorkEvidenceCoordinator(statePath), board = createCoordinatedProviderWorkBoard({ statePath, sources: reader, coordinator, now: () => NOW });
    try {
      const startInput: ProviderWorkBoardInput = { schemaVersion: "1.2", boardId, tenantId, providerId: upstream.workPack.providerId, journeyId, originMode: "cf041-progressive", importedStage: "cf041-semantic-review", importedSourceEventHeadDigest: source.snapshot.eventHeadDigest!, expectedJourneyDigest: source.snapshot.journeyDigest, expectedSourceIdentityDigest: source.snapshot.sourceIdentityDigest, expectedSourceEventStateDigest: providerWorkBoardDigest({ eventCount: source.snapshot.eventCount, eventHeadDigest: source.snapshot.eventHeadDigest }), createdAt: NOW };
      const started = board.start(startInput), reuse = prepareProviderEvidenceReuse({ reader, board: started, now: NOW });
      applyProviderEvidenceReuse({ board, reader, coordinator, plan: reuse, now: NOW });
      const derived = deriveCf053ProviderNeutralContract({ board, coordinator, reader, boardId, tenantId, trustedDeployment: { tenantId, targetAlias: "fictional_orders", policyVersion: "cf053_policy_v1", workspaceTrustRootDirectory: join(root, "trusted-workspace") } });
      const registry = new Cf053ContentAddressedCandidateRegistry(join(root, "registry")), candidate = registry.acquire(derived, NOW);
      const scope: TrustedGoalScope = { tenantId, parentGoalId: "cf053_joined_parent", requestId: "cf053_joined_request", ordinaryGoal: "Create two exact fictional orders and verify them independently.", deadline: { key: "joined_window", description: "The frozen author-known production-derived window." }, entities: [{ alias: "joined_order_one", kind: "order", systemAliases: ["fictional_orders"] }, { alias: "joined_order_two", kind: "order", systemAliases: ["fictional_orders"] }], systems: [{ targetAlias: "fictional_orders", credentialAliases: ["cred.writer"], operations: [{ name: "create", method: "POST", requiredCompanionActions: ["observe"] }, { name: "observe", method: "GET" }] }], completionCriteria: [{ key: "joined_exact", summary: "The independent observer sees exactly one order.", verifierKey: "observe" }], requiredCoverage: [{ key: "joined_coverage_one", entityAliases: ["joined_order_one"], workflowKey: "cf053_transfer", requiredActions: ["create", "observe"], targetAliases: ["fictional_orders"], completionCriterionKeys: ["joined_exact"] }, { key: "joined_coverage_two", entityAliases: ["joined_order_two"], workflowKey: "cf053_transfer", requiredActions: ["create", "observe"], targetAliases: ["fictional_orders"], completionCriterionKeys: ["joined_exact"], dependsOnCoverageKeys: ["joined_coverage_one"] }], authority: { allowedTargetAliases: ["fictional_orders"], allowedSecretAliases: ["cred.writer"], allowedMethods: ["GET", "POST"], writeAuthority: "preauthorized", approvedWriteActions: [] } };
      const proposal: GoalPlanProposal = { schemaVersion: "1.0", deadlineKey: "joined_window", summary: "Two exact joined items.", workItems: [{ key: "joined_one", groupKey: "transfer", groupLabel: "Transfer", summary: "Create the first joined order.", coverageKeys: ["joined_coverage_one"], entityAliases: ["joined_order_one"], workflowKey: "cf053_transfer", requiredActions: ["create", "observe"], targetAliases: ["fictional_orders"], completionCriterionKeys: ["joined_exact"], dependsOnKeys: [] }, { key: "joined_two", groupKey: "transfer", groupLabel: "Transfer", summary: "Create the second joined order.", coverageKeys: ["joined_coverage_two"], entityAliases: ["joined_order_two"], workflowKey: "cf053_transfer", requiredActions: ["create", "observe"], targetAliases: ["fictional_orders"], completionCriterionKeys: ["joined_exact"], dependsOnKeys: ["joined_one"] }] };
      const validated = validateGoalPlan(proposal, scope); if (validated.status !== "validated") throw new Error("joined plan unexpectedly rejected");
      const exactInputs = { [validated.plan.workItems[0]!.workItemId]: { orderRef: "ORDER-CF053-JOINED-ONE" }, [validated.plan.workItems[1]!.workItemId]: { orderRef: "ORDER-CF053-JOINED-TWO" } };
      const trustedWorkspaceInputs = openCf053TrustedWorkspaceInputStore({ candidate, rootDirectory: join(root, "trusted-workspace") }); trustedWorkspaceInputs.save(validated.plan, exactInputs);
      const broker = new Cf053ProductionAuthorityBroker({ candidate, proposal, scope, savedValidatedPlan: validated.plan, trustedWorkspaceInputs, policy: { policyVersion: "cf053_policy_v1", allowedTargetAliases: ["fictional_orders"], allowedActions: ["create", "observe"], allowedMethods: ["GET", "POST"], maximumItems: 2, maximumWritesPerItem: 1, grantTtlSeconds: 60 } });
      processes = await launchCf053ProviderProcesses({ candidate, authorityBroker: broker, worldRoot: join(root, "world") });
      const firstLaunch = adoptCf053ProcessGeneration(processes);
      expect(() => broker.issueGrant(processes!, validated.plan.workItems[1]!.workItemId)).toThrow(/dependent work item|prerequisite/i);
      const firstWorkItemId = validated.plan.workItems[0]!.workItemId, firstGrant = broker.issueGrant(processes, firstWorkItemId), firstReceipt = await executeCf053Transfer({ processes, candidate, authorityGrant: firstGrant, workItemId: firstWorkItemId });
      expect(firstReceipt).toMatchObject({ candidateSource: "built", reconciliationBeforeAction: "not-started", actionStatus: "committed", totalBusinessWrites: 1, outcome: "completed" });
      await closeCf053ProviderProcesses(processes); processes = null;
      const retainedCandidate = registry.acquire(derived, NOW); expect(retainedCandidate.source).toBe("retained");
      processes = await launchCf053ProviderProcesses({ candidate: retainedCandidate, authorityBroker: broker, worldRoot: join(root, "world") }); const secondLaunch = adoptCf053ProcessGeneration(processes); expect(secondLaunch).toMatchObject({ generation: 2, predecessorReceiptDigest: firstLaunch.receiptDigest });
      const secondWorkItemId = validated.plan.workItems[1]!.workItemId, secondGrant = broker.issueGrant(processes, secondWorkItemId), secondReceipt = await executeCf053Transfer({ processes, candidate: retainedCandidate, authorityGrant: secondGrant, workItemId: secondWorkItemId });
      expect(secondReceipt).toMatchObject({ candidateSource: "retained", reconciliationBeforeAction: "not-started", actionStatus: "committed", totalBusinessWrites: 2, outcome: "completed" });
      let resumed = 0; const completion = await completeCf053ProductionParent({ authorityBroker: broker, processes, executions: [firstReceipt, secondReceipt], resumeOriginalGoal: async () => { resumed += 1; return { completed: true }; } });
      expect(completion).toMatchObject({ requiredItems: 2, completedItems: 2, totalBusinessWrites: 2, resumedExactlyOnce: true }); expect(resumed).toBe(1);
      expect(() => trustedWorkspaceInputs.save(validated.plan, { [firstWorkItemId]: { orderRef: "SUBSTITUTED" }, [secondWorkItemId]: exactInputs[secondWorkItemId] })).toThrow(/unique|constraint/i);
      const substitutedPlan = structuredClone(validated.plan); substitutedPlan.summary = "substituted";
      expect(() => new Cf053ProductionAuthorityBroker({ candidate, proposal, scope, savedValidatedPlan: substitutedPlan, trustedWorkspaceInputs, policy: { policyVersion: "cf053_policy_v1", allowedTargetAliases: ["fictional_orders"], allowedActions: ["create", "observe"], allowedMethods: ["GET", "POST"], maximumItems: 2, maximumWritesPerItem: 1, grantTtlSeconds: 60 } })).toThrow(/substituted|non-reproducible/i);
      await closeCf053ProviderProcesses(processes); processes = null;
      expect(() => openCf053TrustedWorkspaceInputStore({ candidate, rootDirectory: join(root, "foreign-workspace") })).toThrow(/cannot mint trust|different trusted workspace issuer/i);
      const reopenedCandidate = new Cf053ContentAddressedCandidateRegistry(join(root, "registry")).acquire(derived, NOW);
      expect(() => openCf053TrustedWorkspaceInputStore({ candidate: reopenedCandidate, rootDirectory: join(root, "foreign-restart-workspace") })).toThrow(/cannot mint trust|durably pinned|different trusted workspace issuer/i);
      const reopenedInputs = openCf053TrustedWorkspaceInputStore({ candidate: reopenedCandidate, rootDirectory: join(root, "trusted-workspace") });
      const reopenedBroker = new Cf053ProductionAuthorityBroker({ candidate: reopenedCandidate, proposal, scope, savedValidatedPlan: validated.plan, trustedWorkspaceInputs: reopenedInputs, policy: { policyVersion: "cf053_policy_v1", allowedTargetAliases: ["fictional_orders"], allowedActions: ["create", "observe"], allowedMethods: ["GET", "POST"], maximumItems: 2, maximumWritesPerItem: 1, grantTtlSeconds: 60 } });
      expect(reopenedBroker).toBeInstanceOf(Cf053ProductionAuthorityBroker);
      const trustRootPath = join(root, "trusted-workspace", "cf053-workspace-trust-root.json"), pinPath = join(root, "registry", candidate.candidateDigest, "workspace-trust-pin.json"), trustRoot = JSON.parse(readFileSync(trustRootPath, "utf8")), pin = JSON.parse(readFileSync(pinPath, "utf8")), foreignKeys = generateKeyPairSync("ed25519"), foreignPublicKeyPem = foreignKeys.publicKey.export({ type: "spki", format: "pem" }).toString(), foreignPublicKeyDigest = createHash("sha256").update(foreignKeys.publicKey.export({ type: "spki", format: "der" })).digest("hex");
      const foreignRootBody = { ...trustRoot, privateKeyPem: foreignKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyPem: foreignPublicKeyPem, publicKeyDigest: foreignPublicKeyDigest }; delete foreignRootBody.rootDigest; writeFileSync(trustRootPath, JSON.stringify({ ...foreignRootBody, rootDigest: cf053Digest(foreignRootBody) }));
      const foreignPinBody = { ...pin, publicKeyDigest: foreignPublicKeyDigest }; delete foreignPinBody.pinDigest; writeFileSync(pinPath, JSON.stringify({ ...foreignPinBody, pinDigest: cf053Digest(foreignPinBody) }));
      const replacedCandidate = new Cf053ContentAddressedCandidateRegistry(join(root, "registry")).acquire(derived, NOW);
      expect(() => openCf053TrustedWorkspaceInputStore({ candidate: replacedCandidate, rootDirectory: join(root, "trusted-workspace") })).toThrow(/immutable issuer anchored|durably pinned/i);
    } finally {
      if (processes) await closeCf053ProviderProcesses(processes).catch(() => undefined);
      board.close(); closeProviderWorkEvidenceCoordinator(coordinator); rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs one real dependent two-item parent goal with build then retained reuse after process replacement", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf053-core-goal-"));
    try {
      const result = await runCf053AuthorKnownTwoItemGoal({ rootDirectory: root, contract: contract(), firstInput: INPUT_ONE, secondInput: INPUT_TWO, now: NOW });
      expect(result).toMatchObject({ registryBuilds: 1, retainedReuses: 1, totalBusinessWrites: 2, parentResumeCount: 1, claimBoundary: "local-fictional-author-known-development-fixture-only" });
      expect(result.executions.map((item) => [item.candidateSource, item.reconciliationBeforeAction, item.actionStatus, item.totalBusinessWrites])).toEqual([
        ["built", "not-started", "committed", 1],
        ["retained", "not-started", "committed", 2],
      ]);
      expect(result.launchReceipts[1]).toMatchObject({ generation: 2, predecessorReceiptDigest: result.launchReceipts[0]?.receiptDigest });
      expect(result.launchReceipts[0]?.action.pid).not.toBe(result.launchReceipts[1]?.action.pid);
      expect(result.launchReceipts[0]?.observer.pid).not.toBe(result.launchReceipts[1]?.observer.pid);
      expect(result.launchReceipts[0]?.action.launchNonce).not.toBe(result.launchReceipts[1]?.action.launchNonce);
      expect(result.launchReceipts[0]?.observer.processKeyDigest).not.toBe(result.launchReceipts[1]?.observer.processKeyDigest);
      expect(result.launchReceipts[0]?.action).toMatchObject({ authoritySignerKeyId: "cf053_local_authority", authorityPublicKeyDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(result.state).toMatchObject({ lifecycle: "completed", aggregate: { completedItems: 2, incorrectSideEffects: 0 }, resume: { completed: true } });
      expect(result.events.filter((event) => event.type === "goal.resumed")).toHaveLength(1);

      const replayCalls = result.executions.length;
      expect(replayCalls).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses parent resumption when a previously verified first outcome is deleted before the fresh aggregate observation", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf053-core-final-observer-"));
    try {
      await expect(runCf053AuthorKnownTwoItemGoal({
        rootDirectory: root,
        contract: contract(),
        firstInput: INPUT_ONE,
        secondInput: INPUT_TWO,
        now: NOW,
        afterFirstItemCommitted: (worldPath) => {
          const wrapped = JSON.parse(readFileSync(worldPath, "utf8")) as { body: { records: Record<string, unknown> }; stateDigest: string };
          const first = Object.keys(wrapped.body.records)[0]!;
          delete wrapped.body.records[first];
          wrapped.stateDigest = cf053Digest(wrapped.body);
          writeFileSync(worldPath, JSON.stringify(wrapped));
        },
      })).rejects.toThrow(/did not prove.*resumption|fresh aggregate|durable-state-integrity/i);
    } finally { await new Promise((resolve) => setTimeout(resolve, 50)); rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }); }
  });

  it("rejects missing, extra, nested, wrong-type, accessor and non-finite inputs before authority or writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf053-core-input-"));
    try {
      const registry = new Cf053ContentAddressedCandidateRegistry(join(root, "registry"));
      const candidate = registry.acquireDevelopment(contract(), NOW);
      const signer = createCf053AuthoritySigner("input_test_authority");
      await expect(launchCf053ProviderProcesses({ candidate, authorityBroker: {} as Cf053ProductionAuthorityBroker, worldRoot: join(root, "prod-world") })).rejects.toThrow(/authority broker/i);
      const base = { signer, candidate, expectedStableIds: [deriveCf053StableIdentity(contract(), INPUT_ONE).stableId], issuedAt: NOW, expiresAt: at(60_000) };
      for (const exactInput of [
        { unit_code: "unit-a", amount: 7 },
        { ...INPUT_ONE, extra: "forbidden" },
        { ...INPUT_ONE, amount: { nested: 7 } },
        { ...INPUT_ONE, confirmed: "true" },
        { ...INPUT_ONE, amount: Number.NaN },
        { ...INPUT_ONE, unit_code: "x".repeat(4_097) },
      ]) expect(() => issueCf053DevelopmentAuthority({ ...base, exactInput })).toThrow(/input|field/i);
      const accessor: Record<string, unknown> = { unit_code: "unit-a", confirmed: true };
      Object.defineProperty(accessor, "amount", { enumerable: true, get: () => 7 });
      expect(() => issueCf053DevelopmentAuthority({ ...base, exactInput: accessor })).toThrow(/accessor/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects missing, lying and +1 child request lengths at the real HTTP process boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf053-core-transport-bounds-")); let setup: Awaited<ReturnType<typeof live>> | undefined;
    try {
      setup = await live(root);
      await expect(attemptCf053DevelopmentRawRequest({ processes: setup.processes, plane: "action", chunks: [Buffer.from("{}")]})).resolves.toMatchObject({ status: 409, body: expect.stringMatching(/request-size-rejected/) });
      await expect(attemptCf053DevelopmentRawRequest({ processes: setup.processes, plane: "observer", declaredContentLength: 65_537, chunks: [Buffer.alloc(65_537, 32)] })).resolves.toMatchObject({ status: 409, body: expect.stringMatching(/request-size-rejected/) });
      const lying = await attemptCf053DevelopmentRawRequest({ processes: setup.processes, plane: "action", declaredContentLength: 1, chunks: [Buffer.from("{}")]}).catch((error: Error) => ({ status: 0, body: error.message }));
      expect(lying.status).not.toBe(200);
    } finally { if (setup) await closeCf053ProviderProcesses(setup.processes).catch(() => undefined); rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects missing, lying and streamed +1 response lengths before parsing JSON", async () => {
    await expect(readCf053BoundedResponseForDevelopment(new Response("{}", { headers: { "content-type": "application/json" } }))).rejects.toThrow(/omitted|content length/i);
    await expect(readCf053BoundedResponseForDevelopment(new Response("{}", { headers: { "content-length": "5" } }))).rejects.toThrow(/did not match/i);
    await expect(readCf053BoundedResponseForDevelopment(new Response(Buffer.alloc(65_537, 32), { headers: { "content-length": "65536" } }))).rejects.toThrow(/streamed.*exceeded/i);
  });

  it("type-tags stable identity and rejects contract/source-chain mutation", () => {
    const stringContract = contract();
    const { contractDigest: _discardNumber, executionBinding: priorBinding, ...baseNumber } = contract();
    const numberBindingBody = {
      ...priorBinding!,
      roles: priorBinding!.roles.map((role) => ({
        ...role,
        parameters: role.parameters.map((parameter) => parameter.inputKey === "unit_code"
          ? { ...parameter, type: "number" as const }
          : parameter),
      })),
    };
    const { bindingDigest: _oldBinding, ...numberBindingWithoutDigest } = numberBindingBody;
    const numberContract = createCf053ProviderNeutralContract({ ...baseNumber, contractId: "number_identity_contract", inputSchema: [{ key: "unit_code", type: "number", required: true }, { key: "amount", type: "number", required: true }, { key: "confirmed", type: "boolean", required: true }], stableIdentityKeys: ["unit_code"], exactOutcomeKeys: ["unit_code", "amount", "confirmed"], executionBinding: { ...numberBindingWithoutDigest, bindingDigest: cf053Digest(numberBindingWithoutDigest) } });
    expect(stringContract.contractDigest).not.toBe(numberContract.contractDigest);
    const stringIdentity = deriveCf053StableIdentity(stringContract, { unit_code: "1", amount: 7, confirmed: true });
    const numberIdentity = deriveCf053StableIdentity(numberContract, { unit_code: 1, amount: 7, confirmed: true });
    expect(stringIdentity.typedComponents).toEqual([{ key: "unit_code", type: "string", valueDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect(numberIdentity.typedComponents).toEqual([{ key: "unit_code", type: "number", valueDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect(stringIdentity.typedIdentityDigest).not.toBe(numberIdentity.typedIdentityDigest);
    const mutated = structuredClone(contract()) as Cf053ProviderNeutralContract;
    mutated.sourceChain.cf041ReviewedContractDigest = "9".repeat(64);
    const root = mkdtempSync(join(tmpdir(), "cf053-core-contract-"));
    try {
      const registry = new Cf053ContentAddressedCandidateRegistry(join(root, "registry"));
      expect(() => registry.acquireDevelopment(mutated, NOW)).toThrow(/contract identity|integrity/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed at +1 input-schema and reviewed-path bounds", () => {
    const { contractDigest: _digest, ...base } = contract();
    const tooManyFields = Array.from({ length: 25 }, (_, index) => ({ key: `field_${index}`, type: "string" as const, required: true as const }));
    expect(() => createCf053ProviderNeutralContract({ ...base, inputSchema: tooManyFields, stableIdentityKeys: ["field_0"], exactOutcomeKeys: ["field_0"] })).toThrow(/one to twenty-four|bound/i);
    const executionBinding = structuredClone(base.executionBinding!); executionBinding.predicates[0]!.path = Array.from({ length: 9 }, (_, index) => `part_${index}`);
    const { bindingDigest: _bindingDigest, ...bindingBody } = executionBinding; executionBinding.bindingDigest = cf053Digest(bindingBody);
    expect(() => createCf053ProviderNeutralContract({ ...base, executionBinding })).toThrow(/path limits|bound/i);
  });

  it("rejects a +1 durable-world plan at admission rather than failing midway", () => {
    const root = mkdtempSync(join(tmpdir(), "cf053-core-world-admission-"));
    try {
      const { contractDigest: _digest, ...base } = contract(), keys = ["unit_code", "payload_a", "payload_b", "payload_c"], schema = keys.map((key) => ({ key, type: "string" as const, required: true as const })), parameters = keys.map((key) => ({ parameter: key, inputKey: key, type: "string" as const })), roles = base.executionBinding!.roles.map((role) => ({ ...role, parameters }));
      const bindingBody = { ...base.executionBinding!, roles, predicates: keys.map((key) => ({ key, path: [key], operator: "equals-input" as const, inputKey: key })) }; delete (bindingBody as { bindingDigest?: string }).bindingDigest;
      const largeContract = createCf053ProviderNeutralContract({ ...base, contractId: "large_admission_contract", inputSchema: schema, stableIdentityKeys: ["unit_code"], exactOutcomeKeys: keys, executionBinding: { ...bindingBody, bindingDigest: cf053Digest(bindingBody) } });
      const registry = new Cf053ContentAddressedCandidateRegistry(join(root, "registry")), candidate = registry.acquireDevelopment(largeContract, NOW), payload = "x".repeat(4000);
      const items = Array.from({ length: 100 }, (_, index) => ({ workItemId: `item_${index}`, exactInput: { unit_code: `${index}-${payload}`, payload_a: payload, payload_b: payload, payload_c: payload } }));
      let maximumPassing = 0; for (let count = 1; count <= 100; count += 1) { try { checkCf053DevelopmentPlanAdmission({ candidate, workItems: items.slice(0, count) }); maximumPassing = count; } catch { break; } }
      expect(maximumPassing).toBeGreaterThan(1); expect(maximumPassing).toBeLessThan(100);
      expect(() => checkCf053DevelopmentPlanAdmission({ candidate, workItems: items.slice(0, maximumPassing + 1) })).toThrow(/worst-case durable world exceeds/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("serializes eight real worker-process registry acquisitions and adopts an exact orphan candidate", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf053-core-registry-workers-")), registryRoot = join(root, "shared"), contractPath = join(root, "contract.json");
    const { contractDigest: _digest, ...body } = contract(); writeFileSync(contractPath, JSON.stringify(body));
    const worker = join(process.cwd(), "test/fixtures/cf053-registry-worker.ts"), tsx = join(process.cwd(), "node_modules/tsx/dist/loader.mjs");
    const run = (targetRoot: string, path: string) => execFileAsync(process.execPath, ["--import", tsx, worker, targetRoot, path, NOW], { maxBuffer: 64 * 1024 });
    try {
      const same = await Promise.all(Array.from({ length: 8 }, () => run(registryRoot, contractPath)));
      const sameSources = same.map(({ stdout }) => (JSON.parse(stdout) as { source: string }).source);
      expect(sameSources.filter((source) => source === "built")).toHaveLength(1);
      expect(sameSources.filter((source) => source === "retained")).toHaveLength(7);
      const differentPaths = Array.from({ length: 8 }, (_, index) => { const path = join(root, `contract-${index}.json`); writeFileSync(path, JSON.stringify({ ...body, contractId: `author_known_contract_${index}` })); return path; });
      const different = await Promise.all(differentPaths.map((path) => run(registryRoot, path)));
      expect(different.map(({ stdout }) => (JSON.parse(stdout) as { source: string }).source)).toEqual(Array(8).fill("built"));
      const registry = new Cf053ContentAddressedCandidateRegistry(registryRoot), registryFile = JSON.parse(readFileSync(registry.registryPath, "utf8")) as { entries: unknown[] };
      expect(registryFile.entries).toHaveLength(9);

      const sourceRoot = join(root, "orphan-source"), sourceRegistry = new Cf053ContentAddressedCandidateRegistry(sourceRoot), sourceCandidate = sourceRegistry.acquireDevelopment(contract(), NOW);
      const orphanRoot = join(root, "orphan-target"), targetRegistry = new Cf053ContentAddressedCandidateRegistry(orphanRoot);
      cpSync(join(sourceRoot, sourceCandidate.candidateDigest), join(orphanRoot, sourceCandidate.candidateDigest), { recursive: true });
      const adopted = targetRegistry.acquireDevelopment(contract(), NOW);
      expect(adopted).toMatchObject({ candidateDigest: sourceCandidate.candidateDigest, source: "built" });
      expect(readdirSync(join(orphanRoot, sourceCandidate.candidateDigest))).toEqual(expect.arrayContaining(["contract.json"]));
    } finally { await new Promise((resolve) => setTimeout(resolve, 50)); rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }); }
  });

  it("serializes eight real worker-process generation-schema bootstraps", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf053-core-generation-bootstrap-workers-")), contractPath = join(root, "contract.json");
    const { contractDigest: _digest, ...body } = contract(); writeFileSync(contractPath, JSON.stringify(body));
    const worker = join(process.cwd(), "test/fixtures/cf053-generation-bootstrap-worker.ts"), tsx = join(process.cwd(), "node_modules/tsx/dist/loader.mjs");
    try {
      const results = await Promise.all(Array.from({ length: 8 }, () => execFileAsync(process.execPath, ["--import", tsx, worker, root, contractPath, NOW], { maxBuffer: 64 * 1024 })));
      const parsed = results.map(({ stdout }) => JSON.parse(stdout) as { candidateDigest: string; recovered: boolean });
      expect(new Set(parsed.map((item) => item.candidateDigest)).size).toBe(1);
      expect(parsed.every((item) => item.recovered === false)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("makes a caller-supplied plain CF-051 snapshot structurally unusable at the frozen derivation boundary", () => {
    const forgedSnapshot = { boardId: "forged_board", tenantId: "author_known_tenant", snapshotDigest: "a".repeat(64), tasks: [] };
    expect(() => deriveCf053ProviderNeutralContract({
      board: forgedSnapshot as never,
      coordinator: { boundary: "cf051-durable-coordinator", storeIdentityDigest: "b".repeat(64) } as never,
      reader: { read: () => { throw new Error("reader must not be reached"); }, events: () => [] },
      boardId: "forged_board",
      tenantId: "author_known_tenant",
      trustedDeployment: { tenantId: "author_known_tenant", targetAlias: "author_known_target", policyVersion: "author_known_policy_v1", workspaceTrustRootDirectory: join(tmpdir(), "must-not-be-created") },
    })).toThrow(/exact durable CF-051 work board/i);
  });

  it("binds signed authority to exact candidate/input/scope/time and rejects substitutions", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf053-core-authority-"));
    let processes: Awaited<ReturnType<typeof launchCf053DevelopmentProcesses>> | null = null;
    try {
      const setup = await live(root); processes = setup.processes;
      const parentStableIds = [deriveCf053StableIdentity(setup.currentContract, INPUT_TWO).stableId];
      const crossInput = issueCf053DevelopmentAuthority({ signer: setup.signer, candidate: setup.candidate, exactInput: INPUT_TWO, expectedStableIds: parentStableIds, issuedAt: setup.issuedAt, expiresAt: new Date(Date.now() + 60_000).toISOString() });
      await expect(executeCf053DevelopmentTransfer({ processes, candidate: setup.candidate, authoritySigner: setup.signer, authority: crossInput, exactInput: INPUT_ONE, expectedStableIds: parentStableIds, now: setup.issuedAt })).rejects.toThrow(/authority/i);

      const expired = issueCf053DevelopmentAuthority({ signer: setup.signer, candidate: setup.candidate, exactInput: INPUT_ONE, expectedStableIds: [setup.authority.stableId], issuedAt: at(-3_600_000), expiresAt: at(-3_540_000) });
      await expect(executeCf053DevelopmentTransfer({ processes, candidate: setup.candidate, authoritySigner: setup.signer, authority: expired, exactInput: INPUT_ONE, expectedStableIds: [expired.stableId], now: NOW })).rejects.toThrow(/authority/i);

      const forgedKeys = generateKeyPairSync("ed25519"), { signature: _signature, ...forgedBody } = setup.authority;
      const forged = { ...forgedBody, policyVersion: "foreign_policy", signature: sign(null, Buffer.from(JSON.stringify(forgedBody)), forgedKeys.privateKey).toString("base64") } as Cf053AuthorityReceipt;
      await expect(executeCf053DevelopmentTransfer({ processes, candidate: setup.candidate, authoritySigner: setup.signer, authority: forged, exactInput: INPUT_ONE, expectedStableIds: [setup.authority.stableId], now: setup.issuedAt })).rejects.toThrow(/authority/i);
      await expect(executeCf053DevelopmentTransfer({ processes, candidate: setup.candidate, authoritySigner: setup.signer, authority: setup.authority, exactInput: INPUT_ONE, expectedStableIds: [setup.authority.stableId, "f".repeat(64)], now: setup.issuedAt })).rejects.toThrow(/authority/i);
      await expect(attemptCf053DevelopmentMismatchedBody({ processes, candidate: setup.candidate, authority: setup.authority, signedInput: INPUT_ONE, substitutedBody: { ...INPUT_ONE, amount: 999 } })).rejects.toThrow(/input-digest-rejected/i);
    } finally {
      if (processes) await closeCf053ProviderProcesses(processes).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects cloned and old process handles and preserves the durable world across a new adopted generation", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf053-core-replace-"));
    let first: Awaited<ReturnType<typeof launchCf053DevelopmentProcesses>> | null = null;
    let second: Awaited<ReturnType<typeof launchCf053DevelopmentProcesses>> | null = null;
    try {
      const currentContract = contract(), registry = new Cf053ContentAddressedCandidateRegistry(join(root, "registry")), candidate = registry.acquireDevelopment(currentContract, NOW), signer = createCf053AuthoritySigner("replace_authority");
      first = await launchCf053DevelopmentProcesses({ candidate, authoritySigner: signer, worldRoot: join(root, "world"), now: NOW });
      const firstReceipt = adoptCf053ProcessGeneration(first), issuedAt = new Date().toISOString(), expectedStableIds = [deriveCf053StableIdentity(currentContract, INPUT_ONE).stableId], authority = issueCf053DevelopmentAuthority({ signer, candidate, exactInput: INPUT_ONE, expectedStableIds, issuedAt, expiresAt: new Date(Date.now() + 60_000).toISOString() });
      await expect(executeCf053DevelopmentTransfer({ processes: { ...first }, candidate, authoritySigner: signer, authority, exactInput: INPUT_ONE, expectedStableIds: [authority.stableId], now: issuedAt })).rejects.toThrow(/handle/i);
      const firstResult = await executeCf053DevelopmentTransfer({ processes: first, candidate, authoritySigner: signer, authority, exactInput: INPUT_ONE, expectedStableIds: [authority.stableId], now: issuedAt });
      expect(firstResult.totalBusinessWrites).toBe(1);
      await closeCf053ProviderProcesses(first); first = null;
      second = await launchCf053DevelopmentProcesses({ candidate: registry.acquireDevelopment(currentContract, NOW), authoritySigner: signer, worldRoot: join(root, "world"), now: NOW });
      const secondReceipt = adoptCf053ProcessGeneration(second);
      expect(secondReceipt).toMatchObject({ generation: 2, predecessorReceiptDigest: firstReceipt.receiptDigest });
      const reusedCandidate = registry.acquireDevelopment(currentContract, NOW), reusedAuthority = issueCf053DevelopmentAuthority({ signer, candidate: reusedCandidate, exactInput: INPUT_ONE, expectedStableIds, issuedAt, expiresAt: new Date(Date.now() + 60_000).toISOString() });
      const reconciled = await executeCf053DevelopmentTransfer({ processes: second, candidate: reusedCandidate, authoritySigner: signer, authority: reusedAuthority, exactInput: INPUT_ONE, expectedStableIds: [reusedAuthority.stableId], now: issuedAt });
      expect(reconciled).toMatchObject({ candidateSource: "retained", reconciliationBeforeAction: "completed", actionStatus: "already-exists", intendedWrites: 0, totalBusinessWrites: 1 });
    } finally {
      if (first) await closeCf053ProviderProcesses(first).catch(() => undefined);
      if (second) await closeCf053ProviderProcesses(second).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows exactly one pending launch in a dual reservation race", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf053-core-generation-race-"));
    const registry = new Cf053ContentAddressedCandidateRegistry(join(root, "registry")), candidate = registry.acquireDevelopment(contract(), NOW), signer = createCf053AuthoritySigner("generation_race_authority");
    const launches = await Promise.allSettled([
      launchCf053DevelopmentProcesses({ candidate, authoritySigner: signer, worldRoot: join(root, "world"), now: NOW }),
      launchCf053DevelopmentProcesses({ candidate, authoritySigner: signer, worldRoot: join(root, "world"), now: NOW }),
    ]);
    const winners = launches.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof launchCf053DevelopmentProcesses>>> => result.status === "fulfilled"), losers = launches.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(winners).toHaveLength(1); expect(losers).toHaveLength(1); expect(String(losers[0]!.reason)).toMatch(/one pending launch/i);
    const first = winners[0]!.value;
    try {
      expect(adoptCf053ProcessGeneration(first).generation).toBe(1);
    } finally {
      await closeCf053ProviderProcesses(first).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses replacement adoption while the exact predecessor remains active", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf053-core-active-replacement-"));
    const registry = new Cf053ContentAddressedCandidateRegistry(join(root, "registry")), candidate = registry.acquireDevelopment(contract(), NOW), signer = createCf053AuthoritySigner("active_replacement_authority");
    let first: Awaited<ReturnType<typeof launchCf053DevelopmentProcesses>> | null = null, replacement: Awaited<ReturnType<typeof launchCf053DevelopmentProcesses>> | null = null;
    try {
      first = await launchCf053DevelopmentProcesses({ candidate, authoritySigner: signer, worldRoot: join(root, "world"), now: NOW }); adoptCf053ProcessGeneration(first);
      replacement = await launchCf053DevelopmentProcesses({ candidate, authoritySigner: signer, worldRoot: join(root, "world"), now: NOW });
      expect(() => adoptCf053ProcessGeneration(replacement!)).toThrow(/still active|close and retire/i);
    } finally {
      if (replacement) await closeCf053ProviderProcesses(replacement).catch(() => undefined);
      if (first) await closeCf053ProviderProcesses(first).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers one explicitly abandoned pending launch after the separate launcher process exits", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf053-core-pending-crash-")), contractPath = join(root, "contract.json");
    const { contractDigest: _digest, ...body } = contract(); writeFileSync(contractPath, JSON.stringify(body));
    const worker = join(process.cwd(), "test/fixtures/cf053-pending-crash-worker.ts"), tsx = join(process.cwd(), "node_modules/tsx/dist/loader.mjs");
    let processes: Awaited<ReturnType<typeof launchCf053DevelopmentProcesses>> | null = null;
    try {
      const crashed = await execFileAsync(process.execPath, ["--import", tsx, worker, root, contractPath, NOW], { maxBuffer: 64 * 1024 });
      expect(JSON.parse(crashed.stdout)).toMatchObject({ pendingReservationLeft: true });
      const registry = new Cf053ContentAddressedCandidateRegistry(join(root, "registry")), candidate = registry.acquireDevelopment(contract(), NOW);
      expect(recoverCf053AbandonedPendingGeneration({ candidate, worldRoot: join(root, "world") })).toBe(true);
      const signer = createCf053AuthoritySigner("post_crash_authority"); processes = await launchCf053DevelopmentProcesses({ candidate, authoritySigner: signer, worldRoot: join(root, "world"), now: NOW });
      expect(adoptCf053ProcessGeneration(processes).generation).toBe(1);
    } finally {
      if (processes) await closeCf053ProviderProcesses(processes).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers a dead pending replacement without touching its healthy active predecessor", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf053-core-targeted-pending-recovery-")), contractPath = join(root, "contract.json");
    const { contractDigest: _digest, ...body } = contract(); writeFileSync(contractPath, JSON.stringify(body));
    const setup = await live(root), worker = join(process.cwd(), "test/fixtures/cf053-sigkill-launcher-worker.ts"), tsx = join(process.cwd(), "node_modules/tsx/dist/loader.mjs"), child = spawn(process.execPath, ["--import", tsx, worker, root, contractPath, NOW, "pending"], { stdio: ["ignore", "pipe", "pipe"] });
    let first: Awaited<ReturnType<typeof launchCf053DevelopmentProcesses>> | null = setup.processes, replacement: Awaited<ReturnType<typeof launchCf053DevelopmentProcesses>> | null = null;
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => { let stdout = "", stderr = ""; const timer = setTimeout(() => rejectPromise(new Error(`pending replacement worker timeout: ${stderr}`)), 5000); child.stdout.on("data", (chunk) => { stdout += String(chunk); if (stdout.includes("\n")) { clearTimeout(timer); resolvePromise(); } }); child.stderr.on("data", (chunk) => { stderr += String(chunk); }); child.once("exit", () => rejectPromise(new Error(`pending replacement worker exited before ready: ${stderr}`))); });
      child.kill("SIGKILL"); await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
      const database = new DatabaseSync(join(root, "world", "generation-state.sqlite"), { readOnly: true }), pending = database.prepare("SELECT reservation_id AS reservationId FROM cf053_generations WHERE status='pending'").get() as { reservationId: string }, activeBefore = database.prepare("SELECT receipt_digest AS receiptDigest FROM cf053_generations WHERE status='active'").get() as { receiptDigest: string }; database.close();
      expect(activeBefore.receiptDigest).toBe(setup.launch.receiptDigest);
      expect(recoverCf053AbandonedPendingGeneration({ candidate: setup.candidate, worldRoot: join(root, "world"), reservationId: pending.reservationId })).toBe(true);
      const after = new DatabaseSync(join(root, "world", "generation-state.sqlite"), { readOnly: true }), activeAfter = after.prepare("SELECT receipt_digest AS receiptDigest FROM cf053_generations WHERE status='active'").get() as { receiptDigest: string }, pendingAfter = after.prepare("SELECT reservation_id FROM cf053_generations WHERE status='pending'").get(); after.close();
      expect(activeAfter.receiptDigest).toBe(setup.launch.receiptDigest); expect(pendingAfter).toBeUndefined();
      const result = await executeCf053DevelopmentTransfer({ processes: first!, candidate: setup.candidate, authoritySigner: setup.signer, authority: setup.authority, exactInput: INPUT_ONE, expectedStableIds: [setup.authority.stableId], now: setup.issuedAt });
      expect(result).toMatchObject({ actionStatus: "committed", outcome: "completed", totalBusinessWrites: 1 });
      await closeCf053ProviderProcesses(first!); first = null;
      replacement = await launchCf053DevelopmentProcesses({ candidate: setup.registry.acquireDevelopment(setup.currentContract, NOW), authoritySigner: setup.signer, worldRoot: join(root, "world"), now: NOW });
      expect(adoptCf053ProcessGeneration(replacement)).toMatchObject({ generation: 2, predecessorReceiptDigest: setup.launch.receiptDigest });
    } finally { if (replacement) await closeCf053ProviderProcesses(replacement).catch(() => undefined); if (first) await closeCf053ProviderProcesses(first).catch(() => undefined); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); }
  });

  it("kills exact persisted orphan children after a real SIGKILL launcher crash", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf053-core-sigkill-crash-")), contractPath = join(root, "contract.json");
    const { contractDigest: _digest, ...body } = contract(); writeFileSync(contractPath, JSON.stringify(body));
    const worker = join(process.cwd(), "test/fixtures/cf053-sigkill-launcher-worker.ts"), tsx = join(process.cwd(), "node_modules/tsx/dist/loader.mjs"), child = spawn(process.execPath, ["--import", tsx, worker, root, contractPath, NOW], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => { let stdout = "", stderr = ""; const timer = setTimeout(() => rejectPromise(new Error(`SIGKILL worker timeout: ${stderr}`)), 5000); child.stdout.on("data", (chunk) => { stdout += String(chunk); if (stdout.includes("\n")) { clearTimeout(timer); resolvePromise(); } }); child.stderr.on("data", (chunk) => { stderr += String(chunk); }); child.once("exit", () => rejectPromise(new Error(`SIGKILL worker exited before ready: ${stderr}`))); });
      child.kill("SIGKILL"); await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
      const database = new DatabaseSync(join(root, "world", "generation-state.sqlite"), { readOnly: true }), row = database.prepare("SELECT action_pid AS actionPid,observer_pid AS observerPid FROM cf053_generations WHERE status='pending'").get() as {actionPid:number;observerPid:number}; database.close();
      expect(row.actionPid).toBeGreaterThan(1); expect(row.observerPid).toBeGreaterThan(1);
      const registry = new Cf053ContentAddressedCandidateRegistry(join(root, "registry")), candidate = registry.acquireDevelopment(contract(), NOW);
      expect(recoverCf053AbandonedPendingGeneration({ candidate, worldRoot: join(root, "world") })).toBe(true);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      for (const pid of [row.actionPid, row.observerPid]) expect(() => process.kill(pid, 0)).toThrow();
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); }
  });

  it("retires an authenticated active orphan after SIGKILL and adopts its exact replacement", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf053-core-sigkill-active-")), contractPath = join(root, "contract.json");
    const { contractDigest: _digest, ...body } = contract(); writeFileSync(contractPath, JSON.stringify(body));
    const worker = join(process.cwd(), "test/fixtures/cf053-sigkill-launcher-worker.ts"), tsx = join(process.cwd(), "node_modules/tsx/dist/loader.mjs"), child = spawn(process.execPath, ["--import", tsx, worker, root, contractPath, NOW, "active"], { stdio: ["ignore", "pipe", "pipe"] });
    let replacement: Awaited<ReturnType<typeof launchCf053DevelopmentProcesses>> | null = null;
    try {
      const ready = await new Promise<{ receiptDigest: string }>((resolvePromise, rejectPromise) => { let stdout = "", stderr = ""; const timer = setTimeout(() => rejectPromise(new Error(`active SIGKILL worker timeout: ${stderr}`)), 5000); child.stdout.on("data", (chunk) => { stdout += String(chunk); if (stdout.includes("\n")) { clearTimeout(timer); resolvePromise(JSON.parse(stdout.slice(0, stdout.indexOf("\n")))); } }); child.stderr.on("data", (chunk) => { stderr += String(chunk); }); child.once("exit", () => rejectPromise(new Error(`active SIGKILL worker exited before ready: ${stderr}`))); });
      child.kill("SIGKILL"); await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
      const registry = new Cf053ContentAddressedCandidateRegistry(join(root, "registry")), candidate = registry.acquireDevelopment(contract(), NOW);
      expect(recoverCf053AbandonedGeneration({ candidate, worldRoot: join(root, "world"), target: { lifecycle: "active", receiptDigest: ready.receiptDigest } })).toBe(true);
      const retiredDb = new DatabaseSync(join(root, "world", "generation-state.sqlite"), { readOnly: true }), retired = retiredDb.prepare("SELECT status,receipt_digest AS receiptDigest,action_endpoint AS actionEndpoint,action_recovery_token AS actionRecoveryToken,observer_endpoint AS observerEndpoint,observer_recovery_token AS observerRecoveryToken FROM cf053_generations WHERE generation=1").get() as Record<string, unknown>; retiredDb.close();
      expect(retired).toEqual({ status: "retired", receiptDigest: ready.receiptDigest, actionEndpoint: null, actionRecoveryToken: null, observerEndpoint: null, observerRecoveryToken: null });
      const signer = createCf053AuthoritySigner("post_active_crash_authority"); replacement = await launchCf053DevelopmentProcesses({ candidate, authoritySigner: signer, worldRoot: join(root, "world"), now: NOW });
      expect(adoptCf053ProcessGeneration(replacement)).toMatchObject({ generation: 2, predecessorReceiptDigest: ready.receiptDigest });
      await closeCf053ProviderProcesses(replacement); replacement = null;
      const closedDb = new DatabaseSync(join(root, "world", "generation-state.sqlite"), { readOnly: true }), closed = closedDb.prepare("SELECT action_endpoint AS actionEndpoint,action_recovery_token AS actionRecoveryToken,observer_endpoint AS observerEndpoint,observer_recovery_token AS observerRecoveryToken FROM cf053_generations WHERE generation=2 AND status='retired'").get(); closedDb.close();
      expect(closed).toEqual({ actionEndpoint: null, actionRecoveryToken: null, observerEndpoint: null, observerRecoveryToken: null });
    } finally { if (replacement) await closeCf053ProviderProcesses(replacement).catch(() => undefined); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); }
  });

  it("recovers or self-terminates children when the launcher dies in the registration window", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf053-core-registration-window-")), contractPath = join(root, "contract.json");
    const { contractDigest: _digest, ...body } = contract(); writeFileSync(contractPath, JSON.stringify(body));
    const worker = join(process.cwd(), "test/fixtures/cf053-sigkill-launcher-worker.ts"), tsx = join(process.cwd(), "node_modules/tsx/dist/loader.mjs"), child = spawn(process.execPath, ["--import", tsx, worker, root, contractPath, NOW], { stdio: ["ignore", "ignore", "pipe"] });
    try {
      const databasePath = join(root, "world", "generation-state.sqlite"), deadline = Date.now() + 5000;
      let pendingObserved = false;
      while (Date.now() < deadline) { if (existsSync(databasePath)) { let db: DatabaseSync | null = null; try { db = new DatabaseSync(databasePath, { readOnly: true }); const row = db.prepare("SELECT reservation_id FROM cf053_generations WHERE status='pending'").get(); if (row) { pendingObserved = true; break; } } catch {} finally { db?.close(); } } await new Promise((resolvePromise) => setTimeout(resolvePromise, 5)); }
      expect(existsSync(databasePath)).toBe(true);
      expect(pendingObserved).toBe(true);
      child.kill("SIGKILL"); await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
      const registry = new Cf053ContentAddressedCandidateRegistry(join(root, "registry")), candidate = registry.acquireDevelopment(contract(), NOW);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      expect(recoverCf053AbandonedPendingGeneration({ candidate, worldRoot: join(root, "world") })).toBe(true);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      const processes = await execFileAsync("/bin/ps", ["-axo", "command="], { maxBuffer: 1024 * 1024 });
      expect(processes.stdout).not.toContain(root);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); }
  });

  it("removes only exact dead-owner stage and next crash artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf053-core-crash-artifacts-")), registryRoot = join(root, "registry"), worldRoot = join(root, "world"); mkdirSync(registryRoot, { recursive: true }); mkdirSync(worldRoot, { recursive: true });
    const deadPid = 999_999, stage = join(registryRoot, `${"a".repeat(64)}.stage.${deadPid}.00000000-0000-4000-8000-000000000000`), next = join(worldRoot, `state.json.${deadPid}.00000000-0000-4000-8000-000000000000.next`), unrelated = join(registryRoot, "keep-me.stage"); mkdirSync(stage); writeFileSync(next, "{}"); writeFileSync(unrelated, "keep");
    let processes: Awaited<ReturnType<typeof launchCf053DevelopmentProcesses>> | null = null;
    try {
      const registry = new Cf053ContentAddressedCandidateRegistry(registryRoot), candidate = registry.acquireDevelopment(contract(), NOW), signer = createCf053AuthoritySigner("artifact_cleanup_authority");
      processes = await launchCf053DevelopmentProcesses({ candidate, authoritySigner: signer, worldRoot, now: NOW });
      expect(existsSync(stage)).toBe(false); expect(existsSync(next)).toBe(false); expect(readFileSync(unrelated, "utf8")).toBe("keep");
    } finally { if (processes) await closeCf053ProviderProcesses(processes).catch(() => undefined); rmSync(root, { recursive: true, force: true }); }
  });

  it("deletes zero artifacts when exact crash candidates exceed the inspection bound", () => {
    const root = mkdtempSync(join(tmpdir(), "cf053-core-crash-bound-")), registryRoot = join(root, "registry"); mkdirSync(registryRoot, { recursive: true });
    try {
      for (let index = 0; index < 257; index += 1) mkdirSync(join(registryRoot, `${"a".repeat(64)}.stage.999999.${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`));
      expect(() => new Cf053ContentAddressedCandidateRegistry(registryRoot)).toThrow(/256-item atomic inspection bound/i);
      expect(readdirSync(registryRoot).filter((name) => name.includes(".stage."))).toHaveLength(257);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects registry, candidate-byte and durable-world tampering before execution", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf053-core-tamper-"));
    let processes: Awaited<ReturnType<typeof launchCf053DevelopmentProcesses>> | null = null;
    try {
      const currentContract = contract(), registryRoot = join(root, "registry"), registry = new Cf053ContentAddressedCandidateRegistry(registryRoot), candidate = registry.acquireDevelopment(currentContract, NOW);
      const registryBytes = readFileSync(registry.registryPath, "utf8");
      writeFileSync(registry.registryPath, registryBytes.replace('"buildOrdinal": 1', '"buildOrdinal": 2'));
      expect(() => new Cf053ContentAddressedCandidateRegistry(registryRoot)).toThrow(/registry/i);
      writeFileSync(registry.registryPath, registryBytes);

      const actionPath = join(registryRoot, candidate.candidateDigest, `${JSON.parse(registryBytes).entries[0].actionSourceDigest}.mjs`);
      const actionBytes = readFileSync(actionPath, "utf8"); writeFileSync(actionPath, `${actionBytes}\n// tampered`);
      expect(() => registry.acquireDevelopment(currentContract, NOW)).toThrow(/tampered/i);
      writeFileSync(actionPath, actionBytes);

      const postAcquire = registry.acquireDevelopment(currentContract, NOW);
      writeFileSync(actionPath, `${actionBytes}\n// overwritten after acquire`);
      const postAcquireSigner = createCf053AuthoritySigner("post_acquire_authority");
      await expect(launchCf053DevelopmentProcesses({ candidate: postAcquire, authoritySigner: postAcquireSigner, worldRoot: join(root, "post-acquire-world"), now: NOW })).rejects.toThrow(/bytes changed before launch/i);
      writeFileSync(actionPath, actionBytes);

      const signer = createCf053AuthoritySigner("tamper_authority");
      processes = await launchCf053DevelopmentProcesses({ candidate: registry.acquireDevelopment(currentContract, NOW), authoritySigner: signer, worldRoot: join(root, "world"), now: NOW }); adoptCf053ProcessGeneration(processes);
      const statePath = join(root, "world", "state.json"), state = JSON.parse(readFileSync(statePath, "utf8")); state.body.writes = 99; writeFileSync(statePath, JSON.stringify(state));
      const issuedAt = new Date().toISOString(), authority = issueCf053DevelopmentAuthority({ signer, candidate: registry.acquireDevelopment(currentContract, NOW), exactInput: INPUT_ONE, expectedStableIds: [deriveCf053StableIdentity(currentContract, INPUT_ONE).stableId], issuedAt, expiresAt: new Date(Date.now() + 60_000).toISOString() });
      await expect(executeCf053DevelopmentTransfer({ processes, candidate: registry.acquireDevelopment(currentContract, NOW), authoritySigner: signer, authority, exactInput: INPUT_ONE, expectedStableIds: [authority.stableId], now: issuedAt })).rejects.toThrow(/integrity/i);
    } finally {
      if (processes) await closeCf053ProviderProcesses(processes).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prevents a duplicate write on an identical replay and rejects stable-identity conflict", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf053-core-duplicate-"));
    let processes: Awaited<ReturnType<typeof launchCf053DevelopmentProcesses>> | null = null;
    try {
      const setup = await live(root); processes = setup.processes;
      const first = await executeCf053DevelopmentTransfer({ processes, candidate: setup.candidate, authoritySigner: setup.signer, authority: setup.authority, exactInput: INPUT_ONE, expectedStableIds: [setup.authority.stableId], now: setup.issuedAt });
      const second = await executeCf053DevelopmentTransfer({ processes, candidate: setup.candidate, authoritySigner: setup.signer, authority: setup.authority, exactInput: INPUT_ONE, expectedStableIds: [setup.authority.stableId], now: setup.issuedAt });
      expect([first.actionStatus, second.actionStatus, second.totalBusinessWrites]).toEqual(["committed", "already-exists", 1]);
      const conflict = { ...INPUT_ONE, amount: 999 }, conflictAuthority = issueCf053DevelopmentAuthority({ signer: setup.signer, candidate: setup.candidate, exactInput: conflict, expectedStableIds: [setup.authority.stableId], issuedAt: setup.issuedAt, expiresAt: new Date(Date.now() + 60_000).toISOString() });
      await expect(executeCf053DevelopmentTransfer({ processes, candidate: setup.candidate, authoritySigner: setup.signer, authority: conflictAuthority, exactInput: conflict, expectedStableIds: [conflictAuthority.stableId], now: setup.issuedAt })).rejects.toThrow(/reconciliation|conflict/i);
    } finally {
      if (processes) await closeCf053ProviderProcesses(processes).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["stale", new Date(Date.now() - 60_000).toISOString(), {}],
    ["future", new Date(Date.now() + 60_000).toISOString(), {}],
    ["collateral", new Date().toISOString(), { ["f".repeat(64)]: { stableId: "f".repeat(64), exactInputDigest: "e".repeat(64), input: INPUT_TWO, version: 1, updatedAt: new Date().toISOString() } }],
  ] as const)("fails closed for a real %s durable-state control", async (_label, observedAt, additionalRecords) => {
    const root = mkdtempSync(join(tmpdir(), `cf053-core-${_label}-`));
    let processes: Awaited<ReturnType<typeof launchCf053DevelopmentProcesses>> | null = null;
    try {
      const currentContract = contract(), registry = new Cf053ContentAddressedCandidateRegistry(join(root, "registry")), candidate = registry.acquireDevelopment(currentContract, NOW), signer = createCf053AuthoritySigner(`${_label}_authority`);
      const issuedAt = new Date().toISOString(), authority = issueCf053DevelopmentAuthority({ signer, candidate, exactInput: INPUT_ONE, expectedStableIds: [deriveCf053StableIdentity(currentContract, INPUT_ONE).stableId], issuedAt, expiresAt: new Date(Date.now() + 90_000).toISOString() });
      const record = { stableId: authority.stableId, exactInputDigest: authority.exactInputDigest, input: INPUT_ONE, version: 2, updatedAt: observedAt };
      const body = { sequence: 2, writes: 1 + Object.keys(additionalRecords).length, serverTimestamp: observedAt, records: { [authority.stableId]: record, ...additionalRecords } };
      const statePath = join(root, "world", "state.json");
      processes = await launchCf053DevelopmentProcesses({ candidate, authoritySigner: signer, worldRoot: join(root, "world"), now: NOW }); adoptCf053ProcessGeneration(processes);
      writeFileSync(statePath, JSON.stringify({ body, stateDigest: cf053Digest(body) }));
      await expect(executeCf053DevelopmentTransfer({ processes, candidate, authoritySigner: signer, authority, exactInput: INPUT_ONE, expectedStableIds: [authority.stableId], now: issuedAt })).rejects.toThrow(/freshness|collateral|outcome|durable-state-integrity/i);
    } finally {
      if (processes) await closeCf053ProviderProcesses(processes).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
