import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as compilerModule from "../src/product/provider-task-candidate-compiler.js";
import { closeCf052StrictLocalProvider, compileJoinedProviderTaskCandidate, compileProviderTaskCandidate, compileProviderTaskCandidatePrimitive, launchCf052StrictLocalProvider, type Cf052AuthorityReceipt, type Cf052StrictLocalProviderHandle } from "../src/product/provider-task-candidate-compiler.js";
import { sdkSemanticDigest, type ConfirmedFact, type SdkSemanticContract } from "../src/product/customer-local-sdk-semantic-compiler.js";
import { sdkSemanticDraftDigest, type SdkSemanticDraftSnapshot } from "../src/product/customer-local-sdk-semantic-drafting.js";
import { sdkWorkPackDigest, type SdkImplementationWorkPack } from "../src/product/customer-local-sdk-work-pack.js";
import { ONBOARDING_JOURNEY_STAGES, onboardingJourneyDigest, onboardingJourneySourceDigest, type JourneyArtifact, type JourneyEvent, type JourneyLineage, type JourneySnapshot, type OnboardingJourneyStage } from "../src/product/customer-local-onboarding-journey.js";
import { applyProviderEvidenceReuse, prepareProviderEvidenceReuse } from "../src/product/customer-local-provider-evidence-reuse.js";
import { closeProviderWorkEvidenceCoordinator, createCoordinatedProviderWorkBoard, createProviderWorkEvidenceCoordinator, providerWorkBoardDigest, type ProviderWorkBoardInput, type ProviderWorkJourneyReader } from "../src/product/customer-local-provider-work-board.js";

const now = "2026-08-14T04:00:00.000Z";
const expiresAt = "2026-08-15T04:00:00.000Z";
const temporary: string[] = [];
const providers: Cf052StrictLocalProviderHandle[] = [];
afterEach(async () => { for (const provider of providers.splice(0)) { try { closeCf052StrictLocalProvider(provider); } catch {} } await Promise.all(temporary.splice(0).map(item => rm(item, { recursive: true, force: true }))); });
const fact = (sourcePointer: string): ConfirmedFact => ({ provenance: "engineer-confirmed", confirmedBy: "fixtureEngineer", confirmedAt: now, sourcePointer });

function fixture(providerId = "cf052-provider", parameterType = "string", pagination: "none" | "cursor" = "none"): { workPack: SdkImplementationWorkPack; contract: SdkSemanticContract } {
  const roles = (["action", "no-write-probe", "reconciliation-readback", "independent-observer"] as const).map((role, index) => {
    const method = { module: index < 2 ? `${providerId}-write-sdk` : `${providerId}-read-sdk`, className: index < 2 ? "WriteClient" : "ReadClient", methodName: ["create", "ping", "find", "observe"][index]!, overloadId: "v1", parameters: [{ name: "orderRef", type: parameterType, required: true, sourcePointer: "#/parameters/orderRef" }], returnType: "Promise<Record<string, string | number | boolean | null>>", errorTypes: ["SdkError"], authAliasRequirements: [index < 2 ? "cred.writer" : "cred.observer"], pagination, retryCandidate: index === 0 ? "idempotency-key" as const : "read-only" as const, idempotencyCandidate: index === 0 ? "request-id" : null, sourcePointer: `#/methods/${role}` };
    return { review: { role, module: method.module, className: method.className, methodName: method.methodName, overloadId: "v1", expectedSourcePointer: method.sourcePointer, reviewerAlias: "fixtureEngineer", reviewedAt: now, exactOneToOne: true as const }, method, methodDigest: sdkWorkPackDigest(method), provenance: { sourceKind: "reference-json" as const, localReference: `fixture://${providerId}`, sourcePointer: method.sourcePointer, sdkSourceDigest: sdkSemanticDigest({ providerId, source: 1 }) } };
  });
  const packBody = { schemaVersion: "1.0" as const, state: "engineer-implementation-required" as const, providerId, pluginId: `${providerId}-plugin`, sdkSourceDigest: sdkSemanticDigest({ providerId, source: 1 }), factoryResultDigest: sdkSemanticDigest({ providerId, factory: 1 }), roles, normalized: { modules: roles.map(item => item.method.module), classes: ["ReadClient", "WriteClient"], methodCount: 4, parameterCount: 4, returnShapeCount: 1, errorShapeCount: 1, authAliasRequirements: ["observer", "writer"], paginationCandidates: [pagination], retryCandidates: ["idempotency-key", "read-only"], idempotencyCandidates: ["request-id"] }, blockedUnknowns: [], conformanceControls: [{ controlId: "cf052-reviewed-source", state: "not-run" as const }], generatedFiles: [], generatedLines: 0, mappedMethods: 4, mappedFields: 8, explicitReviews: 4, executionAuthorityEffect: "none" as const, activationEffect: "none" as const };
  const workPack = { ...packBody, workPackDigest: sdkWorkPackDigest(packBody) };
  const expression = { source: "workflow-input" as const, key: "orderRef", convert: "string" as const, fact: fact("#/input/orderRef") };
  const contractBody = { schemaVersion: "1.0" as const, contractId: `${providerId}-contract`, providerId, sdkSourceDigest: workPack.sdkSourceDigest, workPackDigest: workPack.workPackDigest, roles: roles.map(item => ({ role: item.review.role, methodDigest: item.methodDigest, fact: fact(item.method.sourcePointer) })), parameterMappings: roles.map(item => ({ role: item.review.role, parameter: "orderRef", expression, fact: fact(`${item.method.sourcePointer}/orderRef`) })), credentials: { action: { alias: "cred.writer", exactScope: "POST /orders", fact: fact("#/credentials/writer") }, observer: { alias: "cred.observer", exactScope: "GET /orders", fact: fact("#/credentials/observer") } }, stableIdentity: { expression, collisionPolicy: "reject-conflict" as const, fact: fact("#/identity") }, idempotency: { expression, conflictIdentity: [expression], reconcileBeforeRetry: true as const, blindRetryAllowed: false as const, fact: fact("#/idempotency") }, reconciliation: { role: "reconciliation-readback" as const, notFoundClassification: "not-started" as const, multipleClassification: "duplicate" as const, fact: fact("#/reconciliation") }, observer: { role: "independent-observer" as const, sourceId: `${providerId}-audit`, authIndependent: true as const, differentMethodFromAction: true as const, fact: fact("#/observer") }, outcome: { predicates: [{ key: "order", path: ["orderRef"], operator: "equals-input" as const, inputKey: "orderRef", fact: fact("#/outcome/order") }], duplicate: { collectionPath: ["matches"], expectedCount: 1 as const, fact: fact("#/outcome/duplicate") }, collateral: [{ key: "clean", path: ["collateralClean"], operator: "equals-confirmed" as const, expected: true, fact: fact("#/outcome/collateral") }], freshness: { path: ["observedAt"], maximumAgeSeconds: 60, notBefore: "operation-start" as const, fact: fact("#/outcome/freshness") }, fact: fact("#/outcome") }, pagination: { roles: [{ role: "reconciliation-readback" as const, mode: "not-paginated" as const, maximumPages: 1, fact: fact("#/pagination/reconcile") }, { role: "independent-observer" as const, mode: "not-paginated" as const, maximumPages: 1, fact: fact("#/pagination/observe") }], complete: true as const, fact: fact("#/pagination") }, policy: { timeoutMilliseconds: 5000, maximumRequestsPerMinute: 60, maximumAttempts: 2 as const, retryableErrors: ["TimeoutBeforeCommit"], terminalErrors: ["Unauthorized"], fact: fact("#/policy") }, sourceDigest: sdkSemanticDigest({ providerId, contract: 1 }), expiresAt, executionAuthorityEffect: "none" as const, activationEffect: "none" as const };
  return { workPack, contract: { ...contractBody, contractDigest: sdkSemanticDigest(contractBody) } };
}

function cf041Source(workPack: SdkImplementationWorkPack, contract: SdkSemanticContract, tenantId: string, journeyId: string) {
  const sourceIdentity = "cf052Source", sourceIdentityDigest = onboardingJourneySourceDigest({ journeyId, tenantId, sourceIdentity }), artifacts = {} as JourneySnapshot["artifacts"];
  const semanticBody: Omit<SdkSemanticDraftSnapshot, "snapshotDigest"> = { schemaVersion: "1.0", sessionId: "cf052Semantic", providerId: workPack.providerId, inputDigest: sdkSemanticDraftDigest({ providerId: workPack.providerId, input: 1 }), workPackDigest: workPack.workPackDigest, factoryResultDigest: workPack.factoryResultDigest, workflowSourceDigest: sdkSemanticDraftDigest({ providerId: workPack.providerId, workflow: 1 }), state: "reviewed-contract-ready", revision: 11, extractedFacts: [], questions: [], answers: [], partialContract: contract, blockers: [], dependencyDepth: 5, metrics: { extractedFacts: 0, questions: 0, explicitDecisions: 9, blockers: 0, generatedConfigObjects: 1, generatedExecutableCodeLines: 0, manualExecutableCodeFiles: 0, interventionPoints: 0 }, reviewedContract: contract, executionAuthorityEffect: "none", activationEffect: "none", createdAt: now, updatedAt: now };
  const semanticSnapshot: SdkSemanticDraftSnapshot = { ...semanticBody, snapshotDigest: sdkSemanticDraftDigest(semanticBody) };
  let previous: string | null = null;
  for (const stage of ONBOARDING_JOURNEY_STAGES.slice(0, 4)) {
    const lineageBody: Omit<JourneyLineage, "lineageDigest"> = { schemaVersion: "1.0", tenantId, journeyId, sourceIdentityDigest, previousLineageDigest: previous, ...(stage === "cf036-sdk-work-pack" ? { providerId: workPack.providerId, pluginId: workPack.pluginId, workPackDigest: workPack.workPackDigest, factoryResultDigest: workPack.factoryResultDigest } : {}), ...(stage === "cf041-semantic-review" ? { contractDigest: contract.contractDigest } : {}) };
    const lineageDigest: string = onboardingJourneyDigest(lineageBody);
    const lineage: JourneyLineage = { ...lineageBody, lineageDigest };
    previous = lineageDigest;
    const payload = stage === "cf036-sdk-work-pack" ? workPack : stage === "cf041-semantic-review" ? semanticSnapshot : { schemaVersion: "1.0", fixture: stage };
    const index = ONBOARDING_JOURNEY_STAGES.indexOf(stage), artifactBody = { schemaVersion: "1.1" as const, journeyId, tenantId, stage, owner: "engineer" as const, payload: payload as never, payloadDigest: onboardingJourneyDigest(payload), upstreamArtifactDigest: index === 0 ? null : artifacts[ONBOARDING_JOURNEY_STAGES[index - 1]!]!.artifactDigest, sourceDigest: sourceIdentityDigest, lineage, evidenceLinks: [`artifact://${journeyId}/${stage}`], failures: [], recordedBy: "fixtureEngineer", recordedAt: now, executionAuthorityEffect: "none" as const, activationEffect: "none" as const };
    artifacts[stage] = { ...artifactBody, artifactDigest: onboardingJourneyDigest(artifactBody) } as JourneyArtifact;
  }
  const state = { schemaVersion: "1.2" as const, journeyId, tenantId, sourceIdentity, sourceIdentityDigest, trustedReleaseSigner: null, revision: 5, state: "preparing" as const, currentStage: "cf041-semantic-review" as const, artifacts, failureLedger: [], failureResolutions: [], invalidatedArtifacts: [], dependencyGraph: ONBOARDING_JOURNEY_STAGES.map((stage, index) => ({ stage, dependsOn: index ? ONBOARDING_JOURNEY_STAGES[index - 1]! : null, owner: "engineer" as const })), availableNextActions: ["attach:cf037-acceptance-only-compile"], blockers: [], metrics: { commands: 5, uniqueConfirmations: 1, reusedConfirmations: 0, explicitDecisions: 1, manualCodeFiles: 0, manualConfigObjects: 1, restarts: 0, stageTransitions: 4, duplicateReviews: 0 as const }, executionAuthorityEffect: "none" as const, activationEffect: "none" as const, createdAt: now, updatedAt: now };
  const eventBody = { sequence: 1, journeyId, eventType: "artifact-attached" as const, revision: state.revision, statePayloadDigest: onboardingJourneyDigest(state), previousEventDigest: null, detail: "cf041-semantic-review attached from exact prior stage.", occurredAt: now }, event = { ...eventBody, eventDigest: onboardingJourneyDigest(eventBody) }, body = { ...state, eventCount: 1, eventHeadDigest: event.eventDigest }, snapshot = { ...body, journeyDigest: onboardingJourneyDigest(body) };
  return { snapshot, events: [event] as JourneyEvent[] };
}

describe("CF-052 isolated provider task candidate compiler primitive", () => {
  it("joins an exact progressive CF-051 source to one fresh fictional strict local candidate without acceptance or activation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cf052-joined-")); temporary.push(root);
    const tenantId = "cf052Tenant", journeyId = "cf052Journey", boardId = "cf052Board", provider = fixture("cf052-fulfillment");
    const source = cf041Source(provider.workPack, provider.contract, tenantId, journeyId), reader: ProviderWorkJourneyReader = { read: () => structuredClone(source.snapshot), events: () => structuredClone(source.events) };
    const statePath = path.join(root, "provider.sqlite"), coordinator = createProviderWorkEvidenceCoordinator(statePath), board = createCoordinatedProviderWorkBoard({ statePath, sources: reader, coordinator, now: () => now });
    const startInput: ProviderWorkBoardInput = { schemaVersion: "1.2", boardId, tenantId, providerId: provider.workPack.providerId, journeyId, originMode: "cf041-progressive", importedStage: "cf041-semantic-review", importedSourceEventHeadDigest: source.snapshot.eventHeadDigest!, expectedJourneyDigest: source.snapshot.journeyDigest, expectedSourceIdentityDigest: source.snapshot.sourceIdentityDigest, expectedSourceEventStateDigest: providerWorkBoardDigest({ eventCount: source.snapshot.eventCount, eventHeadDigest: source.snapshot.eventHeadDigest }), createdAt: now };
    const started = board.start(startInput), reuse = prepareProviderEvidenceReuse({ reader, board: started, now });
    applyProviderEvidenceReuse({ board, reader, coordinator, plan: reuse, now });
    const keys = generateKeyPairSync("ed25519"), publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString(), publicDer = keys.publicKey.export({ type: "spki", format: "der" }), canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value !== null && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);
    const signAuthority = (expected: { candidateIdentityDigest: string; exactInputDigest: string; tenantId: string; scope: string; target: string; policyVersion: string; now: string }): Cf052AuthorityReceipt => { const payload = { schemaVersion: "1.0" as const, candidateIdentityDigest: expected.candidateIdentityDigest, exactInputDigest: expected.exactInputDigest, tenantId: expected.tenantId, scope: expected.scope, target: expected.target, policyVersion: expected.policyVersion, issuedAt: expected.now, expiresAt: expiresAt, signerKeyId: "cf052Authority" }; return { ...payload, signature: sign(null, Buffer.from(canonical(payload)), keys.privateKey).toString("base64") }; };
    const localProvider = await launchCf052StrictLocalProvider({ artifactRoot: path.join(root, "provider-artifacts"), now }); providers.push(localProvider);
    let clock = now;
    const implementation = {
      localProvider, authorityPublicKeyPem: publicPem, authorityPublicKeyDigest: createHash("sha256").update(publicDer).digest("hex"), authoritySignerKeyId: "cf052Authority",
      currentTime: () => clock,
    };
    const candidate = await compileJoinedProviderTaskCandidate({ board, coordinator, source: reader, boardId, tenantId, contract: provider.contract, workPack: provider.workPack, implementation, qualificationInput: { orderRef: "ORDER-052" }, qualificationAuthority: signAuthority, target: "fictionalOrders", policyVersion: "policy-v1", now });
    expect(candidate).toMatchObject({ state: "qualified-local-candidate-not-accepted-not-activated", descriptor: { customerExecutable: false, accepted: false, activated: false }, manualAndUnknownResidual: expect.arrayContaining([expect.stringMatching(/not written back/i), expect.stringMatching(/acceptance remain unrun/i)]) });
    expect(Object.isFrozen(candidate.descriptor)).toBe(true); expect(Object.isFrozen((candidate.descriptor as { typedTaskReceiptDigests: object }).typedTaskReceiptDigests)).toBe(true);
    const next = { orderRef: "ORDER-053" }, authority = signAuthority({ candidateIdentityDigest: candidate.candidateIdentityDigest, exactInputDigest: providerWorkBoardDigest(next), tenantId, scope: provider.contract.credentials.action.exactScope, target: "fictionalOrders", policyVersion: "policy-v1", now });
    expect(await candidate.action(next, authority)).toMatchObject({ status: "committed", totalBusinessWrites: 2 });
    await expect(candidate.action({ orderRef: "ORDER-054" }, authority)).rejects.toThrow(/cross-input/i);
    expect(await candidate.observe({ orderRef: "ORDER-NOT-PRESENT" })).toMatchObject({ classification: "not-started", matchCount: 0, writeCount: 0 });
    const substituted = structuredClone(provider.contract);
    substituted.credentials.action.exactScope = "POST /admin/orders";
    const { contractDigest: _oldDigest, ...substitutedWithoutDigest } = substituted;
    substituted.contractDigest = sdkSemanticDigest(substitutedWithoutDigest);
    await expect(compileJoinedProviderTaskCandidate({ board, coordinator, source: reader, boardId, tenantId, contract: substituted, workPack: provider.workPack, implementation, qualificationInput: { orderRef: "ORDER-SUBSTITUTE" }, qualificationAuthority: signAuthority, target: "fictionalOrders", policyVersion: "policy-v1", now })).rejects.toThrow(/semantic contract.*exact.*CF-041|substitution/i);
    const selfConsistentFakeObserverHandle = { launchReceiptDigest: localProvider.launchReceiptDigest };
    await expect(compileJoinedProviderTaskCandidate({ board, coordinator, source: reader, boardId, tenantId, contract: provider.contract, workPack: provider.workPack, implementation: { ...implementation, localProvider: selfConsistentFakeObserverHandle }, qualificationInput: { orderRef: "ORDER-FORGED-HANDLE" }, qualificationAuthority: signAuthority, target: "fictionalOrders", policyVersion: "policy-v1", now })).rejects.toThrow(/handle|module-owned/i);
    const callerClaimedDualPortSameProcess = { launchReceiptDigest: localProvider.launchReceiptDigest, actionPid: process.pid, observerPid: process.pid, actionEndpoint: "http://127.0.0.1:41001/", observerEndpoint: "http://127.0.0.1:41002/" };
    await expect(compileJoinedProviderTaskCandidate({ board, coordinator, source: reader, boardId, tenantId, contract: provider.contract, workPack: provider.workPack, implementation: { ...implementation, localProvider: callerClaimedDualPortSameProcess }, qualificationInput: { orderRef: "ORDER-DUAL-PORT" }, qualificationAuthority: signAuthority, target: "fictionalOrders", policyVersion: "policy-v1", now })).rejects.toThrow(/handle|module-owned/i);
    await expect(compileJoinedProviderTaskCandidate({ board, coordinator, source: reader, boardId, tenantId, contract: provider.contract, workPack: provider.workPack, implementation: { ...implementation, localProvider: new Proxy(localProvider, {}) }, qualificationInput: { orderRef: "ORDER-PROXY-HANDLE" }, qualificationAuthority: signAuthority, target: "fictionalOrders", policyVersion: "policy-v1", now })).rejects.toThrow(/handle|module-owned/i);
    let getterReads = 0;
    const accessorInput = Object.defineProperty({}, "orderRef", { enumerable: true, get() { getterReads++; return getterReads === 1 ? "ORDER-A" : "ORDER-B"; } }) as Record<string, unknown>;
    await expect(candidate.action(accessorInput, {} as Cf052AuthorityReceipt)).rejects.toThrow(/accessors/i);
    expect(getterReads).toBe(0);
    await expect(candidate.action(new Proxy({ orderRef: "ORDER-PROXY" }, {}), {} as Cf052AuthorityReceipt)).rejects.toThrow(/proxies/i);
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, "0", { enumerable: true, get() { throw new Error("array getter must not run"); } });
    Object.defineProperty(accessorArray, "length", { value: 1 });
    await expect(candidate.action({ orderRef: accessorArray }, {} as Cf052AuthorityReceipt)).rejects.toThrow(/accessors/i);
    clock = expiresAt;
    await expect(candidate.action(next, authority)).rejects.toThrow(/stale/i);
    board.close(); closeProviderWorkEvidenceCoordinator(coordinator);
  });

  it("does not export the typed-receipt minter or artifact writer", () => {
    const exports = compilerModule as unknown as Record<string, unknown>;
    expect(exports.createProviderTaskTypedValidationReceipts).toBeUndefined();
    expect(exports.writeProviderTaskCandidate).toBeUndefined();
  });

  it("cannot produce board-derived output before CF-051 passes independent re-audit", () => {
    expect(() => compileProviderTaskCandidate({} as never)).toThrow(/dependency-blocked.*CF-051.*independent re-audit/i);
  });

  it("accepts the strict declarative subset but stays explicitly blocked on the CF-051 trust dependency", () => {
    const input = fixture();
    const result = compileProviderTaskCandidatePrimitive({ ...input, now });
    expect(result).toMatchObject({ state: "isolated-compiler-primitive-dependency-blocked", strictSubsetAccepted: true, semanticCompilerImplementationDigest: null, approvedSourceBytesTypedBound: false, executionAuthorityEffect: "none", activationEffect: "none" });
    expect(result.selfConsistentDraftIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(result.blockers).toEqual([expect.stringMatching(/CF-051.*re-audit/i)]);
  });

  it.each([
    ["nested parameter", fixture("nested-provider", "Record<string, unknown>"), /nested.*unsupported/i],
    ["pagination", fixture("paged-provider", "string", "cursor"), /pagination\/streaming.*outside/i],
  ])("fails closed for %s without granting authority", (_label, input, expected) => {
    const result = compileProviderTaskCandidatePrimitive({ ...input, now });
    expect(result.state).toBe("isolated-compiler-primitive-dependency-blocked");
    expect(result.strictSubsetAccepted).toBe(false);
    expect(result.blockers.join("\n")).toMatch(expected);
    expect(result).toMatchObject({ executionAuthorityEffect: "none", activationEffect: "none" });
  });

  it("rejects custom or cross-surface authentication as an exact blocker", () => {
    const input = fixture("auth-provider");
    input.workPack.roles[0]!.method.authAliasRequirements = ["writer", "secondFactor"];
    const result = compileProviderTaskCandidatePrimitive({ ...input, now });
    expect(result.strictSubsetAccepted).toBe(false);
    expect(result.blockers.join("\n")).toMatch(/custom, raw, multiple or cross-surface authentication/i);
  });

  it.each([
    ["optional parameter", (input: ReturnType<typeof fixture>) => { input.workPack.roles[0]!.method.parameters[0]!.required = false; }, /optional parameters/i],
    ["array parameter", (input: ReturnType<typeof fixture>) => { input.workPack.roles[0]!.method.parameters[0]!.type = "string[]"; }, /nested, collection, union or custom parameter/i],
    ["union parameter", (input: ReturnType<typeof fixture>) => { input.workPack.roles[0]!.method.parameters[0]!.type = "string | number"; }, /nested, collection, union or custom parameter/i],
    ["auth-shaped parameter", (input: ReturnType<typeof fixture>) => { input.workPack.roles[0]!.method.parameters[0]!.name = "api_token"; }, /authentication-shaped parameters/i],
    ["custom return", (input: ReturnType<typeof fixture>) => { input.workPack.roles[0]!.method.returnType = "Promise<CustomOrder>"; }, /return shape.*allowlist/i],
    ["streaming return", (input: ReturnType<typeof fixture>) => { input.workPack.roles[0]!.method.returnType = "AsyncIterable<Order>"; }, /streaming return/i],
    ["custom error", (input: ReturnType<typeof fixture>) => { input.workPack.roles[0]!.method.errorTypes = ["ProviderMysteryError"]; }, /custom or unknown error behavior/i],
    ["raw-secret alias", (input: ReturnType<typeof fixture>) => { input.contract.credentials.action.alias = "sk-12345678901234567890"; }, /raw-secret-like|exact cred/i],
    ["method conflation", (input: ReturnType<typeof fixture>) => { input.workPack.roles[3]!.method = structuredClone(input.workPack.roles[0]!.method); input.workPack.roles[3]!.methodDigest = input.workPack.roles[0]!.methodDigest; }, /conflated|distinct reviewed method/i],
    ["stale method digest", (input: ReturnType<typeof fixture>) => { input.workPack.roles[0]!.method.methodName = "changed"; }, /method digest is stale/i],
  ])("rejects %s before exposing a compiler identity", (_label, mutate, expected) => {
    const input = fixture(`attack-${String(_label).replace(/\s/g, "-")}`);
    mutate(input);
    const result = compileProviderTaskCandidatePrimitive({ ...input, now });
    expect(result.strictSubsetAccepted).toBe(false);
    expect(result.semanticCompilerImplementationDigest).toBeNull();
    expect(result.selfConsistentDraftIdentity).toBeNull();
    expect(result.blockers.join("\n")).toMatch(expected);
  });

  it.each(["apiKey", "accessToken", "authorizationHeader", "bearerToken", "clientSecret"])('normalizes and rejects camelCase auth field %s', field => {
    const input = fixture(`camel-${field}`);
    input.workPack.roles[0]!.method.parameters[0]!.name = field;
    const result = compileProviderTaskCandidatePrimitive({ ...input, now });
    expect(result.strictSubsetAccepted).toBe(false);
    expect(result.selfConsistentDraftIdentity).toBeNull();
    expect(result.blockers.join("\n")).toMatch(/authentication-shaped parameters/i);
  });

  it("rejects an expression source outside the exact two-value runtime allowlist", () => {
    const input = fixture("expression-source");
    (input.contract.parameterMappings[0]!.expression as unknown as { source: string }).source = "environment";
    const result = compileProviderTaskCandidatePrimitive({ ...input, now });
    expect(result.selfConsistentDraftIdentity).toBeNull();
    expect(result.blockers.join("\n")).toMatch(/workflow-input\/trusted-context allowlist/i);
  });

  it("requires exhaustive exact role cardinality with no duplicate or fifth role", () => {
    const duplicate = fixture("duplicate-role");
    duplicate.workPack.roles[3]!.review.role = "action";
    expect(compileProviderTaskCandidatePrimitive({ ...duplicate, now }).blockers.join("\n")).toMatch(/exactly one of each required role/i);
    const fifth = fixture("fifth-role");
    fifth.contract.roles.push(structuredClone(fifth.contract.roles[0]!));
    expect(compileProviderTaskCandidatePrimitive({ ...fifth, now }).blockers.join("\n")).toMatch(/no fifth role/i);
  });

  it("rejects self-inconsistent source pointer, source kind and local reference identity", () => {
    for (const mutate of [
      (input: ReturnType<typeof fixture>) => { input.workPack.roles[0]!.provenance.sourcePointer = "#/other"; },
      (input: ReturnType<typeof fixture>) => { (input.workPack.roles[0]!.provenance as unknown as { sourceKind: string }).sourceKind = "website-claim"; },
      (input: ReturnType<typeof fixture>) => { input.workPack.roles[0]!.provenance.localReference = "file://../escape"; },
    ]) {
      const input = fixture("provenance-attack"); mutate(input);
      const result = compileProviderTaskCandidatePrimitive({ ...input, now });
      expect(result.selfConsistentDraftIdentity).toBeNull();
      expect(result.blockers.join("\n")).toMatch(/not self-consistent/i);
    }
  });

  it("keeps descriptor mutation, forged writing and authority substitution unreachable behind the hard public gate", () => {
    const hostile = { boardReader: { read: () => ({}) }, boardId: "forged", tenantId: "other", contract: {}, workPack: {}, typedReceipts: [], now };
    expect(() => compileProviderTaskCandidate(hostile as never)).toThrow(/dependency-blocked/i);
    expect(() => compileProviderTaskCandidate({ ...hostile, authorityReceipt: { tenantId: "other", allowed: true } } as never)).toThrow(/dependency-blocked/i);
    expect(() => compileProviderTaskCandidate({ ...hostile, writeOutput: true, descriptor: { state: "activated" } } as never)).toThrow(/dependency-blocked/i);
  });
});
