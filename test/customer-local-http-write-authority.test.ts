import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertTrustedCustomerLocalHttpWriteAuthorityIssuer,
  assertTrustedCustomerLocalHttpWriteAuthorityVerifier,
  compiledHttpWriteRequestDigest,
  customerLocalHttpAuthorityContractDigest,
  customerLocalHttpAuthorityTrustContractDigest,
  createTestCustomerLocalHttpWriteAuthorityFromTrustStore,
  createTestCustomerLocalHttpWriteAuthority,
  customerLocalAuthorityDigest,
  createTestCustomerLocalHttpNotStartedObserverSigner,
  signHttpActionApproval,
  signWorkspaceHttpAuthorityActivation,
  type TestCustomerLocalHttpWriteAuthorityConfig,
  type HttpActionAuthorityLease,
} from "../src/product/customer-local-http-write-authority.js";
import { CustomerLocalHttpAuthorityTrustStore } from "../src/product/customer-local-http-authority-trust.js";
import { CustomerLocalTrustStore } from "../src/product/customer-local-trust-backup.js";
import { DurableExternalMonotonicContinuityAnchor } from "../src/product/external-monotonic-continuity-anchor.js";
import { createCustomerLocalAuthorityContinuityGuard } from "../src/product/customer-local-authority-continuity-guard.js";
import type { CompiledHttpObservationResult, CompiledHttpRequest } from "../src/product/http-binding-compiler.js";
import type { HttpActionBindingDeclaration } from "../src/product/http-binding-factory.js";
import { compileAuthorityWizard } from "../src/product/onboarding-verifier-authority.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function temp(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `cf055-${label}-`)); roots.push(root); return root;
}

async function runCf060ReplacementWorker(inputPath: string): Promise<{ status: "fulfilled"; lease: HttpActionAuthorityLease } | { status: "rejected"; message: string }> {
  const worker = join(process.cwd(), "test/fixtures/cf060-unconsumed-generation-replacement-worker.ts"), tsx = join(process.cwd(), "node_modules/tsx/dist/loader.mjs");
  const child = spawn(process.execPath, ["--import", tsx, worker, inputPath]);
  return await new Promise((resolvePromise, rejectPromise) => {
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code !== 0) rejectPromise(new Error(`CF-060 replacement worker failed: ${stderr}`));
      else resolvePromise(JSON.parse(stdout.trim()));
    });
  });
}

function request(orderRef = "ORDER-55", quantity = 4): CompiledHttpRequest {
  return {
    requestId: `request_${orderRef.replaceAll("-", "_")}`,
    parentGoalId: "parent_cf055",
    workItemId: `item_${orderRef.replaceAll("-", "_")}`,
    driverId: "cf055_action_driver",
    targetAlias: "cf055_orders_sandbox",
    serverUrl: "https://localhost:9443/",
    operationId: "createOrder",
    method: "POST",
    path: "/orders",
    query: {},
    headers: {},
    body: { order_ref: orderRef, quantity },
    credentialAlias: "actionBearer",
    reconciliationKey: orderRef,
    declarationDigest: "f".repeat(64),
  };
}

function compilation(policy: "preauthorized" | "requires-approval", maximumActionsPerHour = 3, maximumAttempts = 1) {
  return compileAuthorityWizard({
    schemaVersion: "1.0",
    systemsAndTargets: { aliases: ["cf055_orders_sandbox"], confirmed: true },
    credentialAliases: { aliases: ["actionBearer", "observerBearer"], confirmed: true },
    readsAllowed: { actions: [{ actionName: "auditOrder", targetAlias: "cf055_orders_sandbox" }], confirmed: true },
    writes: [{ actionName: "createOrder", targetAlias: "cf055_orders_sandbox", method: "POST", policy, confirmed: true }],
    limits: {
      monetary: { kind: "none", confirmed: true },
      quantityPerAction: { kind: "limit", maximum: 10, confirmed: true },
      actionsPerHour: { kind: "limit", maximum: maximumActionsPerHour, confirmed: true },
    },
    forbiddenActions: { actionNames: ["deleteOrder"], confirmed: true },
    approver: policy === "requires-approval" ? { kind: "owner", ownerAlias: "opsOwner", confirmed: true } : { kind: "not-required", confirmed: true },
    retryAndReconciliation: { reconcileBeforeRetry: true, blindRetryAllowed: false, maximumAttempts, confirmed: true },
    finalConsequentialReview: { confirmed: true },
  });
}

function declaration(authorityCompilation: ReturnType<typeof compilation>, policy: "preauthorized" | "requires-approval"): HttpActionBindingDeclaration {
  const payload: Omit<HttpActionBindingDeclaration, "declarationDigest"> = {
    schemaVersion: "1.0",
    kind: "constrained-http-action-binding-declaration",
    state: "proposal-only",
    executable: false,
    qualified: false,
    activated: false,
    driverId: "cf055_action_driver",
    targetAlias: "cf055_orders_sandbox",
    serverUrl: "https://localhost:9443/",
    operation: { operationId: "createOrder", method: "POST", pathTemplate: "/orders" },
    credentialAlias: "actionBearer",
    requestMappings: [],
    reconciliationKeySource: { kind: "workflow-input", inputKey: "orderRef", confirmed: true },
    acceptedStatuses: [201],
    authorityPolicy: policy,
    retry: { reconcileBeforeRetry: true, blindRetryAllowed: false },
    provenance: {
      normalizedMaterialDigest: "a".repeat(64),
      normalizationReceiptDigest: "b".repeat(64),
      authorityCompilationDigest: authorityCompilation.compilationDigest,
      confirmedFactsDigest: "c".repeat(64),
      operationPointer: "/paths/~1orders/post",
    },
  };
  return { ...payload, declarationDigest: customerLocalAuthorityDigest(payload) };
}

function harness(input: {
  label: string;
  policy?: "preauthorized" | "requires-approval";
  maximumActionsPerHour?: number;
  now: () => number;
  approvalKeys?: ReturnType<typeof generateKeyPairSync>;
  maximumAttempts?: number;
}) {
  const policy = input.policy ?? "preauthorized", authorityCompilation = compilation(policy, input.maximumActionsPerHour, input.maximumAttempts), actionDeclaration = declaration(authorityCompilation, policy);
  const authorityKeys = generateKeyPairSync("ed25519"), adminKeys = generateKeyPairSync("ed25519"), boundary = "d".repeat(64), resolver = "e".repeat(64);
  const draft = {
    testOnly: true as const,
    statePath: join(temp(input.label), "authority.sqlite"),
    issuerId: "cf055_authority",
    signerKeyId: "cf055_authority_key",
    privateKey: authorityKeys.privateKey,
    publicKey: authorityKeys.publicKey,
    authorityCompilation,
    actionDeclaration,
    transportAuthorityBoundaryDigest: boundary,
    credentialResolverDigest: resolver,
    quantityMetric: { kind: "json-body-number" as const, field: "quantity" },
    maximumLeaseMilliseconds: 1_000,
    now: input.now,
    nonce: (() => { let index = 1; return () => (index++).toString(16).padStart(48, "0"); })(),
    ...(policy === "requires-approval" ? { approval: { signerKeyId: "cf055_approver_key", publicKey: input.approvalKeys!.publicKey } } : {}),
    workspaceAuthority: { workspaceId: "workspace_cf055", adminSignerKeyId: "workspace_admin_key", adminPublicKey: adminKeys.publicKey },
  };
  const authorityContractDigest = customerLocalHttpAuthorityContractDigest(draft);
  const activationReceipt = signWorkspaceHttpAuthorityActivation({ adminSignerKeyId: "workspace_admin_key", workspaceId: "workspace_cf055", authorityContractDigest, privateKey: adminKeys.privateKey, issuedAt: new Date(input.now() - 1).toISOString(), expiresAt: new Date(input.now() + 24 * 60 * 60 * 1_000).toISOString(), activationNonce: "b".repeat(48) });
  const config: TestCustomerLocalHttpWriteAuthorityConfig = { ...draft, workspaceAuthority: { ...draft.workspaceAuthority, activationReceipt } };
  const authority = createTestCustomerLocalHttpWriteAuthority(config);
  const makeRequest = (orderRef = "ORDER-55", quantity = 4) => ({ ...request(orderRef, quantity), declarationDigest: actionDeclaration.declarationDigest });
  return { ...authority, config, authorityKeys, adminKeys, actionDeclaration, authorityCompilation, makeRequest };
}

function notStartedObservation(observedAt: number): CompiledHttpObservationResult {
  return {
    classification: "not-started",
    passed: false,
    nextAction: "retry-after-authority-recheck",
    incorrectSideEffects: 0,
    stateDigest: customerLocalAuthorityDigest({ records: [] }),
    checks: [
      { key: "one-order", role: "success", passed: false },
      { key: "no-order", role: "not-started", passed: true },
      { key: "duplicate-check", role: "duplicate", passed: false },
      { key: "collateral-clean", role: "collateral", passed: true },
      { key: "freshness", role: "freshness", passed: true },
    ],
    observedAt: new Date(observedAt).toISOString(),
    actionResponseUsedAsProof: false,
  };
}

function recoveryHarness(input: { label: string; now: () => number }) {
  const authorityCompilation = compilation("preauthorized", 10, 2), actionDeclaration = declaration(authorityCompilation, "preauthorized");
  const authorityKeys = generateKeyPairSync("ed25519"), adminKeys = generateKeyPairSync("ed25519"), observerKeys = generateKeyPairSync("ed25519");
  const recoveryObserver = {
    signerKeyId: "cf056_recovery_observer_key",
    publicKey: observerKeys.publicKey,
    observerImplementationDigest: "1".repeat(64),
    observerBindingDigest: "2".repeat(64),
    observerQualificationDigest: "3".repeat(64),
  };
  const draft = {
    testOnly: true as const,
    statePath: join(temp(input.label), "authority.sqlite"),
    issuerId: "cf056_authority",
    signerKeyId: "cf056_authority_key",
    privateKey: authorityKeys.privateKey,
    publicKey: authorityKeys.publicKey,
    authorityCompilation,
    actionDeclaration,
    transportAuthorityBoundaryDigest: "d".repeat(64),
    credentialResolverDigest: "e".repeat(64),
    quantityMetric: { kind: "json-body-number" as const, field: "quantity" },
    maximumLeaseMilliseconds: 1_000,
    maximumRecoveryEvidenceMilliseconds: 5_000,
    recoveryObserver,
    now: input.now,
    nonce: (() => { let index = 1; return () => (index++).toString(16).padStart(48, "0"); })(),
    workspaceAuthority: { workspaceId: "workspace_cf056", adminSignerKeyId: "workspace_admin_key", adminPublicKey: adminKeys.publicKey },
  };
  const authorityContractDigest = customerLocalHttpAuthorityContractDigest(draft);
  const activationReceipt = signWorkspaceHttpAuthorityActivation({ adminSignerKeyId: draft.workspaceAuthority.adminSignerKeyId, workspaceId: draft.workspaceAuthority.workspaceId, authorityContractDigest, privateKey: adminKeys.privateKey, issuedAt: new Date(input.now() - 1).toISOString(), expiresAt: new Date(input.now() + 60_000).toISOString(), activationNonce: "e".repeat(48) });
  const config: TestCustomerLocalHttpWriteAuthorityConfig = { ...draft, workspaceAuthority: { ...draft.workspaceAuthority, activationReceipt } };
  const authority = createTestCustomerLocalHttpWriteAuthority(config);
  const observerSigner = createTestCustomerLocalHttpNotStartedObserverSigner({
    testOnly: true,
    ...recoveryObserver,
    privateKey: observerKeys.privateKey,
    maximumReceiptMilliseconds: 2_000,
    now: input.now,
    nonce: () => "f".repeat(48),
  });
  const makeRequest = (orderRef = "ORDER-55", quantity = 4) => ({ ...request(orderRef, quantity), declarationDigest: actionDeclaration.declarationDigest });
  const makeObservationRequest = (exactRequest: CompiledHttpRequest) => ({ ...exactRequest, requestId: `observe_${exactRequest.requestId}`, driverId: "cf056_observer_driver", operationId: "auditOrder", method: "GET" as const, path: "/audit/orders", query: { order_ref: exactRequest.reconciliationKey }, headers: {}, body: null, credentialAlias: "observerBearer", declarationDigest: recoveryObserver.observerBindingDigest });
  const signRecovery = (priorLease: HttpActionAuthorityLease, exactRequest: CompiledHttpRequest, observation: CompiledHttpObservationResult) => {
    const session = observerSigner.begin({ priorLease, actionRequest: exactRequest, observationRequest: makeObservationRequest(exactRequest) });
    const receipt = observerSigner.complete({ session, observation });
    return { receipt, observation: { ...observation, notStartedRecoveryReceipt: receipt } };
  };
  return { ...authority, config, observerKeys, recoveryObserver, observerSigner, makeRequest, makeObservationRequest, signRecovery };
}

describe("customer-local immediate HTTP write authority", () => {
  it("requires and continuously rechecks external recovery continuity at lease issue and consumption", async () => {
    const root = temp("continuity-bound"), authorityKeys = generateKeyPairSync("ed25519"), adminKeys = generateKeyPairSync("ed25519"), anchorKeys = generateKeyPairSync("ed25519");
    const authorityCompilation = compilation("preauthorized"), actionDeclaration = declaration(authorityCompilation, "preauthorized");
    const trustStore = new CustomerLocalTrustStore(join(root, "root-trust.sqlite"), {
      schemaVersion: "1.0", tenantId: "tenant_continuity", environment: "local",
      keys: [{ keyId: "workspace_admin_key", issuer: "customer_admin", publicKeyPem: adminKeys.publicKey.export({ type: "spki", format: "pem" }).toString(), notBefore: new Date(Date.now() - 60_000).toISOString(), notAfter: new Date(Date.now() + 3_600_000).toISOString() }],
    });
    const authorityTrustStore = new CustomerLocalHttpAuthorityTrustStore({ statePath: join(root, "authority-trust.sqlite"), workspaceId: "workspace_continuity", initialAdminKeyId: "workspace_admin_key", trustStore });
    const base = {
      statePath: join(root, "write-authority.sqlite"), issuerId: "continuity_authority", signerKeyId: "continuity_authority_key",
      privateKey: authorityKeys.privateKey, publicKey: authorityKeys.publicKey, authorityCompilation, actionDeclaration,
      transportAuthorityBoundaryDigest: "d".repeat(64), credentialResolverDigest: "e".repeat(64),
      quantityMetric: { kind: "json-body-number" as const, field: "quantity" }, maximumLeaseMilliseconds: 1_000,
      workspaceAuthorityTrustStore: authorityTrustStore,
    };
    const authorityContractDigest = customerLocalHttpAuthorityTrustContractDigest(base), signActivation = (nonce: string) => signWorkspaceHttpAuthorityActivation({
      adminSignerKeyId: "workspace_admin_key", workspaceId: "workspace_continuity", authorityContractDigest,
      privateKey: adminKeys.privateKey, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), activationNonce: customerLocalAuthorityDigest(nonce),
    });
    authorityTrustStore.importActivation(signActivation("before-recovery"));
    const anchor = new DurableExternalMonotonicContinuityAnchor(join(root, "external-anchor.sqlite"), {
      schemaVersion: "1.0", anchorId: "anchor_continuity", tenantId: "tenant_continuity", installationId: "installation_continuity",
      workspaceId: "workspace_continuity", authorityContractDigest, trustConfigurationDigest: authorityTrustStore.trustConfigurationDigest,
      signerKeyId: "anchor_signer", signerPublicKeyPem: anchorKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    }, { signerPrivateKey: anchorKeys.privateKey });
    const recoveryManifestDigest = customerLocalAuthorityDigest("recovery-manifest"), recoveryReceiptDigest = customerLocalAuthorityDigest("recovery-receipt"), recovery = anchor.pinRecoveryManifest(recoveryManifestDigest);
    const completion = anchor.withCurrentRecovery(recoveryManifestDigest, () => ({ value: null, recoveryReceiptDigest })).completionCheckpoint;
    const guard = createCustomerLocalAuthorityContinuityGuard({ anchor, recoveryManifestDigest, recoveryReceiptDigest, recoveryCheckpointDigest: recovery.checkpointDigest, completionCheckpoint: completion });
    expect(() => createTestCustomerLocalHttpWriteAuthorityFromTrustStore({ ...base, continuityGuard: guard, testOnly: true })).toThrow(/no recovery lineage|cannot be attached/i);
    authorityTrustStore.markRestoredAuditOnly();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2)); authorityTrustStore.importActivation(signActivation("after-recovery"));
    expect(() => createTestCustomerLocalHttpWriteAuthorityFromTrustStore({ ...base, testOnly: true })).toThrow(/requires.*continuity guard/i);
    const authority = createTestCustomerLocalHttpWriteAuthorityFromTrustStore({ ...base, continuityGuard: guard, testOnly: true });
    const exactRequest = { ...request("ORDER-CONTINUITY"), declarationDigest: actionDeclaration.declarationDigest };
    const lease = await authority.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer" });
    anchor.pinRecoveryManifest(customerLocalAuthorityDigest("newer-recovery-manifest"));
    await expect(authority.issuer.issueLease({ request: { ...exactRequest, requestId: "request_newer", workItemId: "item_newer", reconciliationKey: "ORDER-NEWER", body: { order_ref: "ORDER-NEWER", quantity: 1 } }, credentialAlias: "actionBearer" })).rejects.toThrow(/continuity.*missing|stale|superseded|mismatched/i);
    expect(() => authority.verifier.consume({ lease, request: exactRequest, credentialAlias: "actionBearer" })).toThrow(/continuity.*missing|stale|superseded|mismatched/i);
    authority.issuer.close(); authority.verifier.close(); anchor.close(); authorityTrustStore.close(); trustStore.close();
  });

  it("rejects structurally similar issuer and verifier substitutions", () => {
    expect(() => assertTrustedCustomerLocalHttpWriteAuthorityIssuer({} as never)).toThrow(/not an instance/i);
    expect(() => assertTrustedCustomerLocalHttpWriteAuthorityVerifier({} as never)).toThrow(/not an instance/i);
  });

  it("issues one exact signed lease and durably rejects replay, mutation, forgery, expiry, revocation, and rate or quantity widening", async () => {
    let clock = Date.parse("2026-08-14T12:00:00.000Z");
    const first = harness({ label: "exact", maximumActionsPerHour: 3, now: () => clock });
    expect(() => createTestCustomerLocalHttpWriteAuthorityFromTrustStore(first.config as never)).toThrow(/caller-controlled time/i);
    expect(() => createTestCustomerLocalHttpWriteAuthority({ ...first.config, statePath: join(temp("forged-admin"), "authority.sqlite"), workspaceAuthority: { ...first.config.workspaceAuthority, activationReceipt: { ...first.config.workspaceAuthority.activationReceipt, authorityContractDigest: "a".repeat(64) } } })).toThrow(/workspace authority activation/i);
    const exactRequest = first.makeRequest();
    if (first.config.authorityCompilation.guardrails.limits.quantityPerAction.kind === "limit") first.config.authorityCompilation.guardrails.limits.quantityPerAction.maximum = 10_000;
    first.config.actionDeclaration.operation.operationId = "deleteOrder";
    const reservationDigest = customerLocalAuthorityDigest("exact transport reservation");
    const lease = await first.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer", transportReservationDigest: reservationDigest });
    expect(lease).toMatchObject({ schemaVersion: "2.1", requestDigest: compiledHttpWriteRequestDigest(exactRequest), policyEpoch: 1, credentialAlias: "actionBearer", transportReservationDigest: reservationDigest });
    const legacyLease = { ...lease, schemaVersion: "2.0" } as unknown as HttpActionAuthorityLease;
    expect(() => first.verifier.consume({ lease: legacyLease, request: exactRequest, credentialAlias: "actionBearer", transportReservationDigest: reservationDigest })).toThrow(/forged|different exact work/i);
    expect(() => first.verifier.consume({ lease, request: exactRequest, credentialAlias: "actionBearer", transportReservationDigest: customerLocalAuthorityDigest("wrong reservation") })).toThrow(/different exact work/i);
    first.verifier.consume({ lease, request: exactRequest, credentialAlias: "actionBearer", transportReservationDigest: reservationDigest });
    expect(() => first.verifier.consume({ lease, request: exactRequest, credentialAlias: "actionBearer", transportReservationDigest: reservationDigest })).toThrow(/replayed|durable state/i);
    await expect(first.issuer.issueLease({ request: { ...exactRequest, requestId: "different_request_same_work" }, credentialAlias: "actionBearer" })).rejects.toThrow();
    clock -= 1;
    await expect(first.issuer.issueLease({ request: first.makeRequest("ORDER-CLOCK"), credentialAlias: "actionBearer" })).rejects.toThrow(/clock rollback/i);
    clock += 1;

    const mutationLease = await first.issuer.issueLease({ request: first.makeRequest("ORDER-56"), credentialAlias: "actionBearer" });
    expect(() => first.verifier.consume({ lease: mutationLease, request: first.makeRequest("ORDER-56", 5), credentialAlias: "actionBearer" })).toThrow(/different exact work/i);
    const forged = { ...mutationLease, workItemId: "different_item" } as HttpActionAuthorityLease;
    forged.leaseDigest = customerLocalAuthorityDigest({ payload: { ...forged, signature: undefined, leaseDigest: undefined }, signature: forged.signature });
    expect(() => first.verifier.consume({ lease: forged, request: first.makeRequest("ORDER-56"), credentialAlias: "actionBearer" })).toThrow(/forged|different exact work/i);

    const expiring = await first.issuer.issueLease({ request: first.makeRequest("ORDER-57"), credentialAlias: "actionBearer" });
    clock += 1_001;
    expect(() => first.verifier.consume({ lease: expiring, request: first.makeRequest("ORDER-57"), credentialAlias: "actionBearer" })).toThrow(/not currently valid/i);
    await expect(first.issuer.issueLease({ request: first.makeRequest("ORDER-OVER", 11), credentialAlias: "actionBearer" })).rejects.toThrow(/quantity limit/i);
    await expect(first.issuer.issueLease({ request: first.makeRequest("ORDER-RATE"), credentialAlias: "actionBearer" })).rejects.toThrow(/actions-per-hour/i);

    clock += 3_600_001;
    const revoked = await first.issuer.issueLease({ request: first.makeRequest("ORDER-58"), credentialAlias: "actionBearer" });
    first.issuer.revokeAll("Operator revoked the write policy.");
    expect(() => first.verifier.consume({ lease: revoked, request: first.makeRequest("ORDER-58"), credentialAlias: "actionBearer" })).toThrow(/revoked|durable state/i);
    first.verifier.close(); first.issuer.close();
  });

  it("requires an exact separately signed approval and consumes it only once", async () => {
    const approvalKeys = generateKeyPairSync("ed25519"), now = Date.parse("2026-08-14T13:00:00.000Z");
    const approved = harness({ label: "approval", policy: "requires-approval", now: () => now, approvalKeys });
    const exactRequest = approved.makeRequest("ORDER-APPROVED");
    await expect(approved.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer" })).rejects.toThrow(/signed approval/i);
    const receipt = signHttpActionApproval({ signerKeyId: "cf055_approver_key", approverOwnerAlias: "opsOwner", request: exactRequest, privateKey: approvalKeys.privateKey, issuedAt: new Date(now - 1).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), approvalNonce: "a".repeat(48) });
    const lease = await approved.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer", approvalReceipt: receipt });
    approved.verifier.consume({ lease, request: exactRequest, credentialAlias: "actionBearer" });
    await expect(approved.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer", approvalReceipt: receipt })).rejects.toThrow();
    const otherRequest = approved.makeRequest("ORDER-DIFFERENT");
    await expect(approved.issuer.issueLease({ request: otherRequest, credentialAlias: "actionBearer", approvalReceipt: receipt })).rejects.toThrow(/different exact work/i);
    approved.verifier.close(); approved.issuer.close();
  });

  it("preserves one-shot lease state across verifier restart and serializes concurrent duplicate issuance", async () => {
    const now = Date.parse("2026-08-14T14:00:00.000Z"), first = harness({ label: "restart", maximumActionsPerHour: 10, now: () => now });
    const exactRequest = first.makeRequest("ORDER-RESTART"), lease = await first.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer" });
    first.verifier.consume({ lease, request: exactRequest, credentialAlias: "actionBearer" });
    first.verifier.close();
    const reopened = createTestCustomerLocalHttpWriteAuthority(first.config);
    expect(() => reopened.verifier.consume({ lease, request: exactRequest, credentialAlias: "actionBearer" })).toThrow(/replayed|durable state/i);
    const duplicateWork = first.makeRequest("ORDER-CONCURRENT");
    const [left, right] = await Promise.allSettled([
      first.issuer.issueLease({ request: duplicateWork, credentialAlias: "actionBearer" }),
      reopened.issuer.issueLease({ request: { ...duplicateWork, requestId: "second_concurrent_request" }, credentialAlias: "actionBearer" }),
    ]);
    expect([left.status, right.status].sort()).toEqual(["fulfilled", "rejected"]);
    reopened.verifier.close(); reopened.issuer.close(); first.issuer.close();
  });

  it("retires one exact expired unconsumed generation across restart and permits only one concurrent replacement", async () => {
    let now = Date.parse("2026-08-14T14:30:00.000Z");
    const first = harness({ label: "unconsumed-generation-restart", maximumActionsPerHour: 10, now: () => now });
    const exactRequest = first.makeRequest("ORDER-GENERATION");
    const firstReservation = customerLocalAuthorityDigest("generation one reservation");
    const firstLease = await first.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer", transportReservationDigest: firstReservation });
    expect(firstLease).toMatchObject({ attempt: 1, generation: 1, transportReservationDigest: firstReservation });
    await expect(first.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer", transportReservationDigest: customerLocalAuthorityDigest("premature replacement"), unconsumedReplacement: { priorLease: firstLease, reason: "expired-before-consume" } })).rejects.toThrow(/expired.*unconsumed|expired.*live/i);
    await expect(first.issuer.issueLease({ request: first.makeRequest("ORDER-GENERATION-CROSS"), credentialAlias: "actionBearer", transportReservationDigest: customerLocalAuthorityDigest("cross work replacement"), unconsumedReplacement: { priorLease: firstLease, reason: "expired-before-consume" } })).rejects.toThrow(/different exact work/i);
    await expect(first.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer", transportReservationDigest: customerLocalAuthorityDigest("forged generation replacement"), unconsumedReplacement: { priorLease: { ...firstLease, generation: 2 }, reason: "expired-before-consume" } })).rejects.toThrow(/forged|different exact work/i);
    first.verifier.close(); first.issuer.close();

    now += 1_000;
    const leftReservation = customerLocalAuthorityDigest("generation two left reservation"), rightReservation = customerLocalAuthorityDigest("generation two right reservation");
    const { privateKey: _privateKey, publicKey: _publicKey, now: _now, nonce: _nonce, workspaceAuthority, ...serializableConfig } = first.config;
    const { adminPublicKey: _adminPublicKey, ...serializableWorkspaceAuthority } = workspaceAuthority;
    const workerConfig = {
      ...serializableConfig,
      privateKeyPem: first.authorityKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      publicKeyPem: first.authorityKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      workspaceAuthority: {
        ...serializableWorkspaceAuthority,
        adminPublicKeyPem: first.adminKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
    };
    const workerRoot = temp("unconsumed-generation-workers"), leftInput = join(workerRoot, "left.json"), rightInput = join(workerRoot, "right.json");
    writeFileSync(leftInput, JSON.stringify({ config: workerConfig, now, nonce: "8".repeat(48), request: exactRequest, priorLease: firstLease, reservationDigest: leftReservation }), { mode: 0o600 });
    writeFileSync(rightInput, JSON.stringify({ config: workerConfig, now, nonce: "9".repeat(48), request: exactRequest, priorLease: firstLease, reservationDigest: rightReservation }), { mode: 0o600 });
    const [left, right] = await Promise.allSettled([
      runCf060ReplacementWorker(leftInput),
      runCf060ReplacementWorker(rightInput),
    ]);
    const workerResults = [left, right].flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const successfulWorkers = workerResults.filter((result): result is Extract<typeof result, { status: "fulfilled" }> => result.status === "fulfilled");
    expect(successfulWorkers).toHaveLength(1);
    const replacement = successfulWorkers[0]!.lease;
    expect(replacement).toMatchObject({ attempt: 1, generation: 2, priorUnconsumedLeaseDigest: firstLease.leaseDigest });
    const reopened = createTestCustomerLocalHttpWriteAuthority(first.config);
    const generationDatabase = new DatabaseSync(first.config.statePath);
    expect((generationDatabase.prepare("SELECT COUNT(*) AS count FROM http_authority_leases WHERE status = 'issued' AND retired_at_epoch_ms IS NULL").get() as { count: number }).count).toBe(1);
    generationDatabase.close();
    expect(() => reopened.verifier.consume({ lease: firstLease, request: exactRequest, credentialAlias: "actionBearer", transportReservationDigest: firstReservation })).toThrow(/valid|retired|stale/i);
    reopened.verifier.consume({ lease: replacement, request: exactRequest, credentialAlias: "actionBearer", transportReservationDigest: replacement.transportReservationDigest! });
    now += 1_001;
    await expect(reopened.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer", transportReservationDigest: customerLocalAuthorityDigest("forbidden post-consume replacement"), unconsumedReplacement: { priorLease: replacement, reason: "expired-before-consume" } })).rejects.toThrow(/durably unconsumed|live lease generation/i);
    reopened.verifier.close(); reopened.issuer.close();
  });

  it("requires fresh approval for every replacement generation and enforces the generation ceiling", async () => {
    let now = Date.parse("2026-08-14T14:45:00.000Z");
    const approvalKeys = generateKeyPairSync("ed25519");
    const approved = harness({ label: "unconsumed-generation-approval", policy: "requires-approval", maximumActionsPerHour: 10, now: () => now, approvalKeys });
    const exactRequest = approved.makeRequest("ORDER-GENERATION-APPROVAL");
    const approval = (nonce: string) => signHttpActionApproval({ signerKeyId: "cf055_approver_key", approverOwnerAlias: "opsOwner", request: exactRequest, privateKey: approvalKeys.privateKey, issuedAt: new Date(now - 1).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), approvalNonce: nonce.repeat(48) });
    const firstApproval = approval("a");
    const firstLease = await approved.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer", transportReservationDigest: customerLocalAuthorityDigest("approved generation one"), approvalReceipt: firstApproval });
    now += 1_001;
    await expect(approved.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer", transportReservationDigest: customerLocalAuthorityDigest("reused approval replacement"), approvalReceipt: firstApproval, unconsumedReplacement: { priorLease: firstLease, reason: "expired-before-consume" } })).rejects.toThrow();
    const approvalDatabase = new DatabaseSync(approved.config.statePath);
    expect(approvalDatabase.prepare("SELECT status, consumed_at_epoch_ms, retired_at_epoch_ms FROM http_authority_leases WHERE lease_id = ?").get(firstLease.leaseId)).toEqual({ status: "issued", consumed_at_epoch_ms: null, retired_at_epoch_ms: null });
    approvalDatabase.close();
    const secondLease = await approved.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer", transportReservationDigest: customerLocalAuthorityDigest("approved generation two"), approvalReceipt: approval("b"), unconsumedReplacement: { priorLease: firstLease, reason: "expired-before-consume" } });
    expect(secondLease).toMatchObject({ attempt: 1, generation: 2, priorUnconsumedLeaseDigest: firstLease.leaseDigest });
    now += 1_001;
    const thirdLease = await approved.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer", transportReservationDigest: customerLocalAuthorityDigest("approved generation three"), approvalReceipt: approval("c"), unconsumedReplacement: { priorLease: secondLease, reason: "expired-before-consume" } });
    expect(thirdLease).toMatchObject({ attempt: 1, generation: 3, priorUnconsumedLeaseDigest: secondLease.leaseDigest });
    now += 1_001;
    await expect(approved.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer", transportReservationDigest: customerLocalAuthorityDigest("generation four forbidden"), approvalReceipt: approval("d"), unconsumedReplacement: { priorLease: thirdLease, reason: "expired-before-consume" } })).rejects.toThrow(/over-generation/i);
    approved.verifier.close(); approved.issuer.close();
  });

  it("fails closed for both serialized outcomes of replacement racing policy revocation", async () => {
    let now = Date.parse("2026-08-14T14:55:00.000Z");
    const revokedFirst = harness({ label: "generation-revoke-first", maximumActionsPerHour: 10, now: () => now });
    const requestA = revokedFirst.makeRequest("ORDER-REVOKE-FIRST"), leaseA = await revokedFirst.issuer.issueLease({ request: requestA, credentialAlias: "actionBearer", transportReservationDigest: customerLocalAuthorityDigest("revoke first generation one") });
    now += 1_000;
    revokedFirst.issuer.revokeAll("Policy revoked before replacement serialization.");
    await expect(revokedFirst.issuer.issueLease({ request: requestA, credentialAlias: "actionBearer", transportReservationDigest: customerLocalAuthorityDigest("revoke first replacement"), unconsumedReplacement: { priorLease: leaseA, reason: "expired-before-consume" } })).rejects.toThrow(/revoked/i);
    revokedFirst.verifier.close(); revokedFirst.issuer.close();

    now = Date.parse("2026-08-14T15:05:00.000Z");
    const replacementFirst = harness({ label: "generation-replace-first", maximumActionsPerHour: 10, now: () => now });
    const requestB = replacementFirst.makeRequest("ORDER-REPLACE-FIRST"), leaseB = await replacementFirst.issuer.issueLease({ request: requestB, credentialAlias: "actionBearer", transportReservationDigest: customerLocalAuthorityDigest("replace first generation one") });
    now += 1_000;
    const replacementReservation = customerLocalAuthorityDigest("replace first generation two");
    const replacement = await replacementFirst.issuer.issueLease({ request: requestB, credentialAlias: "actionBearer", transportReservationDigest: replacementReservation, unconsumedReplacement: { priorLease: leaseB, reason: "expired-before-consume" } });
    replacementFirst.issuer.revokeAll("Policy revoked after replacement serialization.");
    expect(() => replacementFirst.verifier.consume({ lease: replacement, request: requestB, credentialAlias: "actionBearer", transportReservationDigest: replacementReservation })).toThrow(/revoked|durable state/i);
    replacementFirst.verifier.close(); replacementFirst.issuer.close();
  });

  it("caps leases at configured workspace-admin activation expiry and stops new issuance afterward", async () => {
    let now = Date.parse("2026-08-14T15:00:00.000Z");
    const base = harness({ label: "activation-expiry-base", maximumActionsPerHour: 10, now: () => now });
    base.verifier.close(); base.issuer.close();
    const draft = { ...base.config, statePath: join(temp("activation-expiry"), "authority.sqlite"), workspaceAuthority: { workspaceId: base.config.workspaceAuthority.workspaceId, adminSignerKeyId: base.config.workspaceAuthority.adminSignerKeyId, adminPublicKey: base.config.workspaceAuthority.adminPublicKey } };
    const authorityContractDigest = customerLocalHttpAuthorityContractDigest(draft), activationExpiresAt = now + 500;
    const activationReceipt = signWorkspaceHttpAuthorityActivation({ adminSignerKeyId: draft.workspaceAuthority.adminSignerKeyId, workspaceId: draft.workspaceAuthority.workspaceId, authorityContractDigest, privateKey: base.adminKeys.privateKey, issuedAt: new Date(now - 1).toISOString(), expiresAt: new Date(activationExpiresAt).toISOString(), activationNonce: "d".repeat(48) });
    const authority = createTestCustomerLocalHttpWriteAuthority({ ...draft, workspaceAuthority: { ...draft.workspaceAuthority, activationReceipt } });
    const exactRequest = base.makeRequest("ORDER-ACTIVATION-EXPIRY"), lease = await authority.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer" });
    expect(Date.parse(lease.expiresAt)).toBe(activationExpiresAt);
    now = activationExpiresAt + 1;
    expect(() => authority.verifier.consume({ lease, request: exactRequest, credentialAlias: "actionBearer" })).toThrow(/not currently valid/i);
    await expect(authority.issuer.issueLease({ request: base.makeRequest("ORDER-AFTER-ACTIVATION"), credentialAlias: "actionBearer" })).rejects.toThrow(/activation has expired/i);
    authority.verifier.close(); authority.issuer.close();
  });

  it("permits one exact restart-safe reissue only after later signed not-started evidence", async () => {
    let now = Date.parse("2026-08-14T16:00:00.000Z");
    const first = recoveryHarness({ label: "not-started-reissue", now: () => now });
    const exactRequest = first.makeRequest("ORDER-RETRY");
    const firstLease = await first.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer" });
    expect(firstLease.attempt).toBe(1);
    first.verifier.consume({ lease: firstLease, request: exactRequest, credentialAlias: "actionBearer" });
    first.verifier.close(); first.issuer.close();

    now += 100;
    const reopened = createTestCustomerLocalHttpWriteAuthority(first.config);
    const signed = first.signRecovery(firstLease, exactRequest, notStartedObservation(now)), receipt = signed.receipt, observation = signed.observation;
    const retryLease = await reopened.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer", notStartedRecovery: { priorLease: firstLease, receipt, observation } });
    expect(retryLease).toMatchObject({ attempt: 2, generation: 1, priorLeaseDigest: firstLease.leaseDigest, notStartedRecoveryReceiptDigest: receipt.receiptDigest });
    now += 1_001;
    const replacementReservation = customerLocalAuthorityDigest("attempt two replacement reservation");
    const replacementRetryLease = await reopened.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer", transportReservationDigest: replacementReservation, unconsumedReplacement: { priorLease: retryLease, reason: "expired-before-consume" } });
    expect(replacementRetryLease).toMatchObject({ attempt: 2, generation: 2, priorUnconsumedLeaseDigest: retryLease.leaseDigest });
    reopened.verifier.consume({ lease: replacementRetryLease, request: exactRequest, credentialAlias: "actionBearer", transportReservationDigest: replacementReservation });
    await expect(reopened.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer", notStartedRecovery: { priorLease: firstLease, receipt, observation } })).rejects.toThrow();
    now += 1;
    const secondSigned = first.signRecovery(replacementRetryLease, exactRequest, notStartedObservation(now));
    await expect(reopened.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer", notStartedRecovery: { priorLease: replacementRetryLease, receipt: secondSigned.receipt, observation: secondSigned.observation } })).rejects.toThrow(/first attempt|different exact work/i);
    reopened.verifier.close(); reopened.issuer.close();
  });

  it("rejects unconsumed, forged, stale, contradictory, cross-work and concurrent recovery evidence", async () => {
    let now = Date.parse("2026-08-14T17:00:00.000Z");
    const unconsumed = recoveryHarness({ label: "unconsumed", now: () => now }), requestA = unconsumed.makeRequest("ORDER-A"), leaseA = await unconsumed.issuer.issueLease({ request: requestA, credentialAlias: "actionBearer" });
    const signedA = unconsumed.signRecovery(leaseA, requestA, notStartedObservation(now)), observationA = signedA.observation, receiptA = signedA.receipt;
    await expect(unconsumed.issuer.issueLease({ request: requestA, credentialAlias: "actionBearer", notStartedRecovery: { priorLease: leaseA, receipt: receiptA, observation: observationA } })).rejects.toThrow(/durably consumed/i);
    unconsumed.verifier.consume({ lease: leaseA, request: requestA, credentialAlias: "actionBearer" });

    const wrongRequest = unconsumed.makeRequest("ORDER-B");
    expect(() => unconsumed.observerSigner.begin({ priorLease: leaseA, actionRequest: requestA, observationRequest: unconsumed.makeObservationRequest(wrongRequest) })).toThrow(/exact read-side query/i);
    await expect(unconsumed.issuer.issueLease({ request: wrongRequest, credentialAlias: "actionBearer", notStartedRecovery: { priorLease: leaseA, receipt: receiptA, observation: observationA } })).rejects.toThrow(/different prior or requested work/i);
    await expect(unconsumed.issuer.issueLease({ request: requestA, credentialAlias: "actionBearer", notStartedRecovery: { priorLease: leaseA, receipt: { ...receiptA, signature: receiptA.signature.slice(0, -2) + "AA" }, observation: observationA } })).rejects.toThrow(/signature or integrity/i);
    const contradictory = { ...observationA, checks: observationA.checks.map((check) => check.role === "success" ? { ...check, passed: true } : check) };
    expect(() => unconsumed.signRecovery(leaseA, requestA, contradictory)).toThrow(/contradictory/i);
    for (const classification of ["completed", "partial", "incorrect", "duplicate", "stale", "collateral", "unknown", "unavailable"] as const) {
      const unsafe = { ...observationA, classification, nextAction: classification === "completed" ? "resume" as const : ["partial", "incorrect", "duplicate", "stale", "collateral"].includes(classification) ? "quarantine" as const : "handoff" as const };
      expect(() => unconsumed.signRecovery(leaseA, requestA, unsafe)).toThrow(/not-started/i);
    }

    now += 6_000;
    await expect(unconsumed.issuer.issueLease({ request: requestA, credentialAlias: "actionBearer", notStartedRecovery: { priorLease: leaseA, receipt: receiptA, observation: observationA } })).rejects.toThrow(/stale/i);
    unconsumed.verifier.close(); unconsumed.issuer.close();

    now = Date.parse("2026-08-14T18:00:00.000Z");
    const concurrent = recoveryHarness({ label: "concurrent-recovery", now: () => now }), exactRequest = concurrent.makeRequest("ORDER-C"), firstLease = await concurrent.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer" });
    concurrent.verifier.consume({ lease: firstLease, request: exactRequest, credentialAlias: "actionBearer" });
    now += 10;
    const signed = concurrent.signRecovery(firstLease, exactRequest, notStartedObservation(now)), observation = signed.observation, receipt = signed.receipt;
    const [left, right] = await Promise.allSettled([
      concurrent.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer", notStartedRecovery: { priorLease: firstLease, receipt, observation } }),
      concurrent.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer", notStartedRecovery: { priorLease: firstLease, receipt, observation } }),
    ]);
    expect([left.status, right.status].sort()).toEqual(["fulfilled", "rejected"]);
    concurrent.verifier.close(); concurrent.issuer.close();
  });

  it("rejects an observation that began before durable consumption even when its server time appears later", async () => {
    let now = Date.parse("2026-08-14T19:00:00.000Z");
    const first = recoveryHarness({ label: "causal-order", now: () => now }), exactRequest = first.makeRequest("ORDER-CAUSAL"), firstLease = await first.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer" });
    const session = first.observerSigner.begin({ priorLease: firstLease, actionRequest: exactRequest, observationRequest: first.makeObservationRequest(exactRequest) });
    now += 10;
    first.verifier.consume({ lease: firstLease, request: exactRequest, credentialAlias: "actionBearer" });
    now += 10;
    const futureServerObservation = { ...notStartedObservation(now), observedAt: new Date(now + 60_000).toISOString() };
    const receipt = first.observerSigner.complete({ session, observation: futureServerObservation });
    const observation = { ...futureServerObservation, notStartedRecoveryReceipt: receipt };
    await expect(first.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer", notStartedRecovery: { priorLease: firstLease, receipt, observation } })).rejects.toThrow(/later independent observation/i);
    first.verifier.close(); first.issuer.close();
  });
});
