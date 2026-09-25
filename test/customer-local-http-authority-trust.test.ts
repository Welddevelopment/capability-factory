import { createHash, generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  CustomerLocalHttpAuthorityTrustStore,
  restoreSignedCustomerLocalHttpAuthorityTrustBackup,
  signWorkspaceHttpAuthorityActivationRevocation,
} from "../src/product/customer-local-http-authority-trust.js";
import {
  CustomerLocalTrustStore,
  createRotationReceipt,
  type CustomerLocalTrustConfiguration,
} from "../src/product/customer-local-trust-backup.js";
import {
  createTestCustomerLocalHttpWriteAuthorityFromTrustStore,
  customerLocalAuthorityDigest,
  customerLocalHttpAuthorityTrustContractDigest,
  signWorkspaceHttpAuthorityActivation,
  type CustomerLocalHttpWriteAuthorityTrustConfig,
} from "../src/product/customer-local-http-write-authority.js";
import type { CompiledHttpRequest } from "../src/product/http-binding-compiler.js";
import type { HttpActionBindingDeclaration } from "../src/product/http-binding-factory.js";
import { compileAuthorityWizard } from "../src/product/onboarding-verifier-authority.js";

const roots: string[] = [], closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0).reverse()) {
    try { close(); } catch { /* already closed by an availability test */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(label: string): string {
  const path = mkdtempSync(join(tmpdir(), `cf057-${label}-`));
  roots.push(path);
  return path;
}

async function runRaceWorker(inputPath: string): Promise<{ mode: "consume" | "revoke"; status: "fulfilled" | "rejected"; startedAtEpochMs: number; completedAtEpochMs: number; message?: string }> {
  const worker = join(process.cwd(), "test/fixtures/cf057-authority-trust-race-worker.ts"), tsx = join(process.cwd(), "node_modules/tsx/dist/loader.mjs"), child = spawn(process.execPath, ["--import", tsx, worker, inputPath]);
  return await new Promise((resolvePromise, rejectPromise) => {
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", rejectPromise);
    child.once("exit", (code) => code === 0 ? resolvePromise(JSON.parse(stdout)) : rejectPromise(new Error(`CF-057 race worker failed: ${stderr}`)));
  });
}

async function runResolveWorker(inputPath: string): Promise<{ status: "fulfilled" | "rejected"; message?: string }> {
  const worker = join(process.cwd(), "test/fixtures/cf057-authority-trust-resolve-worker.ts"), tsx = join(process.cwd(), "node_modules/tsx/dist/loader.mjs"), child = spawn(process.execPath, ["--import", tsx, worker, inputPath]);
  return await new Promise((resolvePromise, rejectPromise) => {
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", rejectPromise);
    child.once("exit", (code) => code === 0 ? resolvePromise(JSON.parse(stdout)) : rejectPromise(new Error(`CF-057 resolve worker failed: ${stderr}`)));
  });
}

function pem(key: ReturnType<typeof generateKeyPairSync>["publicKey"]): string {
  return key.export({ type: "spki", format: "pem" }).toString();
}

function keyDigest(key: ReturnType<typeof generateKeyPairSync>["publicKey"]): string {
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
}

function authorityCompilation() {
  return compileAuthorityWizard({
    schemaVersion: "1.0",
    systemsAndTargets: { aliases: ["orders"], confirmed: true },
    credentialAliases: { aliases: ["actionBearer", "observerBearer"], confirmed: true },
    readsAllowed: { actions: [{ actionName: "auditOrder", targetAlias: "orders" }], confirmed: true },
    writes: [{ actionName: "createOrder", targetAlias: "orders", method: "POST", policy: "preauthorized", confirmed: true }],
    limits: { monetary: { kind: "none", confirmed: true }, quantityPerAction: { kind: "limit", maximum: 10, confirmed: true }, actionsPerHour: { kind: "limit", maximum: 5, confirmed: true } },
    forbiddenActions: { actionNames: ["deleteOrder"], confirmed: true },
    approver: { kind: "not-required", confirmed: true },
    retryAndReconciliation: { reconcileBeforeRetry: true, blindRetryAllowed: false, maximumAttempts: 1, confirmed: true },
    finalConsequentialReview: { confirmed: true },
  });
}

function actionDeclaration(compilation: ReturnType<typeof authorityCompilation>): HttpActionBindingDeclaration {
  const body: Omit<HttpActionBindingDeclaration, "declarationDigest"> = {
    schemaVersion: "1.0", kind: "constrained-http-action-binding-declaration", state: "proposal-only", executable: false, qualified: false, activated: false,
    driverId: "orders_action", targetAlias: "orders", serverUrl: "https://localhost:9443/", operation: { operationId: "createOrder", method: "POST", pathTemplate: "/orders" }, credentialAlias: "actionBearer", requestMappings: [],
    reconciliationKeySource: { kind: "workflow-input", inputKey: "orderRef", confirmed: true }, acceptedStatuses: [201], authorityPolicy: "preauthorized", retry: { reconcileBeforeRetry: true, blindRetryAllowed: false },
    provenance: { normalizedMaterialDigest: "a".repeat(64), normalizationReceiptDigest: "b".repeat(64), authorityCompilationDigest: compilation.compilationDigest, confirmedFactsDigest: "c".repeat(64), operationPointer: "/paths/~1orders/post" },
  };
  return { ...body, declarationDigest: customerLocalAuthorityDigest(body) };
}

function setup(label: string, clockInput?: { value: number }) {
  const directory = root(label), clock = clockInput ?? { value: Date.now() }, old = generateKeyPairSync("ed25519"), next = generateKeyPairSync("ed25519"), authorityKeys = generateKeyPairSync("ed25519");
  const config: CustomerLocalTrustConfiguration = {
    schemaVersion: "1.0", tenantId: "tenant_cf057", environment: "local",
    keys: [{ keyId: "workspace_admin_v1", issuer: "customer_admin", publicKeyPem: pem(old.publicKey), notBefore: new Date(clock.value - 60_000).toISOString(), notAfter: new Date(clock.value + 7 * 24 * 60 * 60 * 1_000).toISOString() }],
  };
  const trustStore = clockInput
    ? new CustomerLocalTrustStore(join(directory, "trust.sqlite"), config, () => new Date(clock.value).toISOString())
    : new CustomerLocalTrustStore(join(directory, "trust.sqlite"), config);
  const authorityTrustStore = new CustomerLocalHttpAuthorityTrustStore({ statePath: join(directory, "authority-trust.sqlite"), workspaceId: "workspace_cf057", initialAdminKeyId: "workspace_admin_v1", trustStore, ...(clockInput ? { testOnly: true as const } : {}) });
  closers.push(() => authorityTrustStore.close(), () => trustStore.close());
  const compilation = authorityCompilation(), declaration = actionDeclaration(compilation);
  const authorityConfig: CustomerLocalHttpWriteAuthorityTrustConfig = {
    statePath: join(directory, "authority.sqlite"), issuerId: "cf057_authority", signerKeyId: "cf057_authority_key", privateKey: authorityKeys.privateKey, publicKey: authorityKeys.publicKey,
    authorityCompilation: compilation, actionDeclaration: declaration, transportAuthorityBoundaryDigest: "d".repeat(64), credentialResolverDigest: "e".repeat(64), quantityMetric: { kind: "json-body-number", field: "quantity" }, maximumLeaseMilliseconds: 2_000, workspaceAuthorityTrustStore: authorityTrustStore,
  };
  const contractDigest = customerLocalHttpAuthorityTrustContractDigest(authorityConfig);
  const activate = (keys = old, keyId = "workspace_admin_v1", nonce = "1".repeat(48), lifetimeMilliseconds = 60_000) => {
    const measured = clockInput ? clock.value : Date.now();
    const receipt = signWorkspaceHttpAuthorityActivation({ adminSignerKeyId: keyId, workspaceId: "workspace_cf057", authorityContractDigest: contractDigest, privateKey: keys.privateKey, issuedAt: new Date(measured - 1).toISOString(), expiresAt: new Date(measured + lifetimeMilliseconds).toISOString(), activationNonce: nonce });
    authorityTrustStore.importActivation(receipt);
    return receipt;
  };
  const request = (): CompiledHttpRequest => ({ requestId: "request_cf057", parentGoalId: "parent_cf057", workItemId: "item_cf057", driverId: "orders_action", targetAlias: "orders", serverUrl: "https://localhost:9443/", operationId: "createOrder", method: "POST", path: "/orders", query: {}, headers: {}, body: { order_ref: "ORDER-057", quantity: 1 }, credentialAlias: "actionBearer", reconciliationKey: "ORDER-057", declarationDigest: declaration.declarationDigest });
  return { directory, clock, old, next, authorityKeys, config, trustStore, authorityTrustStore, authorityConfig, contractDigest, activate, request };
}

describe("CF-057 independent workspace-admin authority trust", () => {
  it("resolves an exact activation across restart and rejects constructor, store, workspace, key, receipt and clock substitution", () => {
    const fixture = setup("restart", { value: Date.now() }), receipt = fixture.activate();
    const first = fixture.authorityTrustStore.resolveCurrent(fixture.contractDigest);
    expect(first).toMatchObject({ workspaceId: "workspace_cf057", adminSignerKeyId: "workspace_admin_v1", activationReceiptDigest: receipt.receiptDigest, trustConfigurationDigest: fixture.trustStore.configDigest, executionAuthorityEffect: "activation-only", auditAccessAllowed: true });
    expect(() => createTestCustomerLocalHttpWriteAuthorityFromTrustStore({ ...fixture.authorityConfig, testOnly: true })).toThrow(/test-only.*clock/i);
    fixture.authorityTrustStore.close();
    const reopened = new CustomerLocalHttpAuthorityTrustStore({ statePath: join(fixture.directory, "authority-trust.sqlite"), workspaceId: "workspace_cf057", initialAdminKeyId: "workspace_admin_v1", trustStore: fixture.trustStore, testOnly: true });
    closers.push(() => reopened.close());
    expect(reopened.resolveCurrent(fixture.contractDigest).activationReceiptDigest).toBe(receipt.receiptDigest);
    expect(() => new CustomerLocalHttpAuthorityTrustStore({ statePath: join(fixture.directory, "authority-trust.sqlite"), workspaceId: "workspace_other", initialAdminKeyId: "workspace_admin_v1", trustStore: fixture.trustStore, testOnly: true })).toThrow(/pinned|workspace|conflicts/i);
    expect(() => new CustomerLocalHttpAuthorityTrustStore({ statePath: join(fixture.directory, "authority-trust.sqlite"), workspaceId: "workspace_cf057", initialAdminKeyId: "attacker_admin", trustStore: fixture.trustStore, testOnly: true })).toThrow(/substitute|bootstrap/i);
    expect(() => createTestCustomerLocalHttpWriteAuthorityFromTrustStore({ ...fixture.authorityConfig, testOnly: true, workspaceAuthority: { adminPublicKey: fixture.old.publicKey, activationReceipt: receipt } } as never)).toThrow(/caller-supplied admin key|workspaceAuthority/i);
    expect(() => new CustomerLocalHttpAuthorityTrustStore({ statePath: join(fixture.directory, "production-with-test-clock.sqlite"), workspaceId: "workspace_cf057", initialAdminKeyId: "workspace_admin_v1", trustStore: fixture.trustStore })).toThrow(/caller-controlled clock/i);
    expect(() => reopened.resolveCurrent("f".repeat(64))).toThrow(/no current/i);
    const attacker = generateKeyPairSync("ed25519"), tampered = signWorkspaceHttpAuthorityActivation({ adminSignerKeyId: "workspace_admin_v1", workspaceId: "workspace_cf057", authorityContractDigest: fixture.contractDigest, privateKey: attacker.privateKey, issuedAt: new Date(fixture.clock.value - 1).toISOString(), expiresAt: new Date(fixture.clock.value + 60_000).toISOString(), activationNonce: "2".repeat(48) });
    expect(() => reopened.importActivation(tampered)).toThrow(/forged|non-current/i);
    fixture.clock.value -= 1;
    expect(() => reopened.resolveCurrent(fixture.contractDigest)).toThrow(/clock moved backward/i);
  });

  it("requires explicit dual-signed admin rotation and a fresh successor activation without losing historical audit", () => {
    const fixture = setup("rotation", { value: Date.now() }), oldActivation = fixture.activate();
    fixture.clock.value += 2;
    const rotationPayload = { schemaVersion: "1.0" as const, tenantId: fixture.config.tenantId, environment: fixture.config.environment, oldKeyId: "workspace_admin_v1", oldPublicKeyDigest: keyDigest(fixture.old.publicKey), newKeyId: "workspace_admin_v2", newIssuer: "customer_admin", newPublicKeyPem: pem(fixture.next.publicKey), newPublicKeyDigest: keyDigest(fixture.next.publicKey), effectiveAt: new Date(fixture.clock.value).toISOString(), newNotAfter: new Date(fixture.clock.value + 8 * 24 * 60 * 60 * 1_000).toISOString(), issuedAt: new Date(fixture.clock.value - 1).toISOString(), executionAuthorityEffect: "none" as const, activationEffect: "none" as const };
    const rotation = createRotationReceipt({ payload: rotationPayload, oldPrivateKey: fixture.old.privateKey, newPrivateKey: fixture.next.privateKey });
    fixture.trustStore.rotate(rotation);
    expect(() => fixture.authorityTrustStore.resolveCurrent(fixture.contractDigest)).toThrow(/rotated|retiring|active/i);
    expect(() => fixture.authorityTrustStore.importActivation(oldActivation)).toThrow(/rotated|retiring|active/i);
    fixture.authorityTrustStore.adoptAdminRotation(rotation);
    expect(() => fixture.authorityTrustStore.resolveCurrent(fixture.contractDigest)).toThrow(/activation|changed/i);
    fixture.clock.value += 1;
    const successor = fixture.activate(fixture.next, "workspace_admin_v2", "3".repeat(48));
    expect(fixture.authorityTrustStore.resolveCurrent(fixture.contractDigest)).toMatchObject({ adminSignerKeyId: "workspace_admin_v2", activationReceiptDigest: successor.receiptDigest });
    const audit = fixture.authorityTrustStore.auditActivations();
    expect(audit).toHaveLength(2);
    expect(audit.find((entry) => entry.activationDigest === oldActivation.receiptDigest)).toMatchObject({ isCurrentHead: false, adminSignerKeyId: "workspace_admin_v1" });
    expect(audit.find((entry) => entry.activationDigest === successor.receiptDigest)).toMatchObject({ isCurrentHead: true, adminSignerKeyId: "workspace_admin_v2" });
  });

  it("revokes one exact activation before lease consumption while preserving non-authorizing audit access", async () => {
    const fixture = setup("revocation"), activation = fixture.activate(), authority = createTestCustomerLocalHttpWriteAuthorityFromTrustStore({ ...fixture.authorityConfig, testOnly: true }), exactRequest = fixture.request();
    const lease = await authority.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer", transportReservationDigest: "9".repeat(64) });
    expect(lease.workspaceAuthorityActivationDigest).toBe(activation.receiptDigest);
    const revocation = signWorkspaceHttpAuthorityActivationRevocation({ workspaceId: "workspace_cf057", authorityContractDigest: fixture.contractDigest, activationReceiptDigest: activation.receiptDigest, trustConfigurationDigest: fixture.trustStore.configDigest, revocationSignerKeyId: "workspace_admin_v1", revocationSignerPublicKeyDigest: keyDigest(fixture.old.publicKey), issuedAt: new Date(fixture.clock.value).toISOString(), effectiveAt: new Date(fixture.clock.value).toISOString(), reason: "Customer operator stopped this exact authority activation.", revocationNonce: "4".repeat(48), privateKey: fixture.old.privateKey });
    fixture.authorityTrustStore.revokeActivation(revocation);
    expect(() => authority.verifier.consume({ lease, request: exactRequest, credentialAlias: "actionBearer", transportReservationDigest: "9".repeat(64) })).toThrow(/revoked|activation/i);
    expect(() => fixture.authorityTrustStore.resolveCurrent(fixture.contractDigest)).toThrow(/revoked|activation/i);
    expect(fixture.authorityTrustStore.auditActivations()).toMatchObject([{ activationDigest: activation.receiptDigest, isCurrentHead: true, revokedAt: revocation.effectiveAt, revocationDigest: revocation.receiptDigest }]);
    const database = new DatabaseSync(fixture.authorityConfig.statePath, { readOnly: true });
    expect(database.prepare("SELECT status,consumed_at_epoch_ms FROM http_authority_leases").get()).toMatchObject({ status: "issued", consumed_at_epoch_ms: null });
    database.close(); authority.verifier.close(); authority.issuer.close();
  });

  it("defines consumption as the revocation serialization point and detects materialized audit tamper", async () => {
    const consumedFirst = setup("consume-before-revoke"), activation = consumedFirst.activate(), authority = createTestCustomerLocalHttpWriteAuthorityFromTrustStore({ ...consumedFirst.authorityConfig, testOnly: true }), exactRequest = consumedFirst.request();
    const lease = await authority.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer" });
    authority.verifier.consume({ lease, request: exactRequest, credentialAlias: "actionBearer" });
    const revocation = signWorkspaceHttpAuthorityActivationRevocation({ workspaceId: "workspace_cf057", authorityContractDigest: consumedFirst.contractDigest, activationReceiptDigest: activation.receiptDigest, trustConfigurationDigest: consumedFirst.trustStore.configDigest, revocationSignerKeyId: "workspace_admin_v1", revocationSignerPublicKeyDigest: keyDigest(consumedFirst.old.publicKey), issuedAt: new Date(consumedFirst.clock.value).toISOString(), effectiveAt: new Date(consumedFirst.clock.value).toISOString(), reason: "Stop later work without rewriting the already consumed attempt.", revocationNonce: "5".repeat(48), privateKey: consumedFirst.old.privateKey });
    consumedFirst.authorityTrustStore.revokeActivation(revocation);
    const authorityDatabase = new DatabaseSync(consumedFirst.authorityConfig.statePath, { readOnly: true });
    expect(authorityDatabase.prepare("SELECT status FROM http_authority_leases").get()).toMatchObject({ status: "consumed" });
    authorityDatabase.close();
    expect(() => authority.verifier.consume({ lease, request: exactRequest, credentialAlias: "actionBearer" })).toThrow(/revoked|activation|replay/i);
    authority.verifier.close(); authority.issuer.close();

    const tamper = setup("audit-tamper"), tamperActivation = tamper.activate();
    const tamperRevocation = signWorkspaceHttpAuthorityActivationRevocation({ workspaceId: "workspace_cf057", authorityContractDigest: tamper.contractDigest, activationReceiptDigest: tamperActivation.receiptDigest, trustConfigurationDigest: tamper.trustStore.configDigest, revocationSignerKeyId: "workspace_admin_v1", revocationSignerPublicKeyDigest: keyDigest(tamper.old.publicKey), issuedAt: new Date(tamper.clock.value).toISOString(), effectiveAt: new Date(tamper.clock.value).toISOString(), reason: "Create an immutable audit event.", revocationNonce: "6".repeat(48), privateKey: tamper.old.privateKey });
    tamper.authorityTrustStore.revokeActivation(tamperRevocation);
    const tamperDatabase = new DatabaseSync(join(tamper.directory, "authority-trust.sqlite"));
    tamperDatabase.prepare("UPDATE authority_activations SET revoked_at=NULL,revocation_digest=NULL WHERE activation_digest=?").run(tamperActivation.receiptDigest);
    tamperDatabase.close();
    expect(() => tamper.authorityTrustStore.auditActivations()).toThrow(/revocation state diverges|event lineage/i);
    expect(() => tamper.authorityTrustStore.resolveCurrent(tamper.contractDigest)).toThrow(/revocation state diverges|event lineage/i);

    const cryptographic = setup("event-signature-tamper"), cryptographicActivation = cryptographic.activate(), cryptographicDatabase = new DatabaseSync(join(cryptographic.directory, "authority-trust.sqlite"));
    const event = cryptographicDatabase.prepare("SELECT sequence,event_type,payload_json,previous_event_digest,recorded_at FROM authority_trust_events WHERE sequence=1").get() as { sequence: number; event_type: string; payload_json: string; previous_event_digest: string | null; recorded_at: string };
    const payload = { ...JSON.parse(event.payload_json), signature: Buffer.alloc(64, 7).toString("base64") };
    const eventDigest = customerLocalAuthorityDigest({ sequence: event.sequence, eventType: event.event_type, payloadDigest: customerLocalAuthorityDigest(payload), previousEventDigest: event.previous_event_digest, recordedAt: event.recorded_at });
    cryptographicDatabase.prepare("UPDATE authority_trust_events SET payload_json=?,event_digest=? WHERE sequence=1").run(JSON.stringify(payload), eventDigest);
    cryptographicDatabase.prepare("UPDATE authority_trust_meta SET value=? WHERE key='event_head_digest'").run(eventDigest);
    cryptographicDatabase.close();
    expect(() => cryptographic.authorityTrustStore.resolveCurrent(cryptographic.contractDigest)).toThrow(/signed historical replay|signature|activation event/i);
    expect(payload.signature).not.toBe(cryptographicActivation.signature);
  });

  it("fails closed under real cross-process activation-revocation versus lease-consumption contention", async () => {
    for (let index = 0; index < 3; index += 1) {
      const fixture = setup(`process-race-${index}`), activation = fixture.activate(), authority = createTestCustomerLocalHttpWriteAuthorityFromTrustStore({ ...fixture.authorityConfig, testOnly: true }), exactRequest = fixture.request();
      const lease = await authority.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer" });
      authority.verifier.close(); authority.issuer.close();
      const now = Date.now(), revocation = signWorkspaceHttpAuthorityActivationRevocation({ workspaceId: "workspace_cf057", authorityContractDigest: fixture.contractDigest, activationReceiptDigest: activation.receiptDigest, trustConfigurationDigest: fixture.trustStore.configDigest, revocationSignerKeyId: "workspace_admin_v1", revocationSignerPublicKeyDigest: keyDigest(fixture.old.publicKey), issuedAt: new Date(now).toISOString(), effectiveAt: new Date(now).toISOString(), reason: "Cross-process serialization control.", revocationNonce: (index + 10).toString(16).padStart(48, "0"), privateKey: fixture.old.privateKey });
      const { workspaceAuthorityTrustStore: _store, privateKey, publicKey, ...authorityConfig } = fixture.authorityConfig;
      const shared = {
        startAtEpochMs: Date.now() + 150,
        trustPath: join(fixture.directory, "trust.sqlite"), authorityTrustPath: join(fixture.directory, "authority-trust.sqlite"), workspaceId: "workspace_cf057", initialAdminKeyId: "workspace_admin_v1", trustConfig: fixture.config,
        authority: { ...authorityConfig, privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() },
        lease, request: exactRequest, revocation,
      };
      const consumePath = join(fixture.directory, "consume.json"), revokePath = join(fixture.directory, "revoke.json");
      writeFileSync(consumePath, JSON.stringify({ ...shared, mode: "consume" }));
      writeFileSync(revokePath, JSON.stringify({ ...shared, mode: "revoke" }));
      const [consume, revoke] = await Promise.all([runRaceWorker(consumePath), runRaceWorker(revokePath)]);
      expect([consume.status, revoke.status]).toContain("fulfilled");
      if (revoke.status === "fulfilled" && revoke.completedAtEpochMs <= consume.startedAtEpochMs) expect(consume.status).toBe("rejected");
      const authorityDatabase = new DatabaseSync(fixture.authorityConfig.statePath, { readOnly: true }), row = authorityDatabase.prepare("SELECT status,consumed_at_epoch_ms FROM http_authority_leases").get() as { status: string; consumed_at_epoch_ms: number | null };
      authorityDatabase.close();
      if (consume.status === "fulfilled") expect(row).toMatchObject({ status: "consumed" });
      else expect(row).toMatchObject({ status: "issued", consumed_at_epoch_ms: null });
      if (consume.status === "rejected") expect(consume.message).toMatch(/revoked|activation|busy|locked|current/i);
      if (revoke.status === "rejected") expect(revoke.message).toMatch(/busy|locked|already revoked|current/i);
    }
  });

  it("rejects cross-workspace and exact-expiry activation use before any new authority consumption", async () => {
    const fixture = setup("expiry"), activation = fixture.activate(fixture.old, "workspace_admin_v1", "1".repeat(48), 100), authority = createTestCustomerLocalHttpWriteAuthorityFromTrustStore({ ...fixture.authorityConfig, testOnly: true }), exactRequest = fixture.request();
    const crossWorkspace = signWorkspaceHttpAuthorityActivation({ adminSignerKeyId: "workspace_admin_v1", workspaceId: "workspace_other", authorityContractDigest: fixture.contractDigest, privateKey: fixture.old.privateKey, issuedAt: new Date(fixture.clock.value - 1).toISOString(), expiresAt: new Date(fixture.clock.value + 60_000).toISOString(), activationNonce: "7".repeat(48) });
    expect(() => fixture.authorityTrustStore.importActivation(crossWorkspace)).toThrow(/cross-workspace|forged|stale/i);
    const lease = await authority.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.max(0, Date.parse(activation.expiresAt) - Date.now()) + 2));
    expect(() => authority.verifier.consume({ lease, request: exactRequest, credentialAlias: "actionBearer" })).toThrow(/stale|activation|expiry/i);
    await expect(authority.issuer.issueLease({ request: { ...exactRequest, requestId: "request_after_expiry", parentGoalId: "parent_after_expiry", workItemId: "item_after_expiry" }, credentialAlias: "actionBearer" })).rejects.toThrow(/stale|activation|expiry/i);
    const database = new DatabaseSync(fixture.authorityConfig.statePath, { readOnly: true });
    expect(database.prepare("SELECT status,consumed_at_epoch_ms FROM http_authority_leases").get()).toMatchObject({ status: "issued", consumed_at_epoch_ms: null });
    database.close(); authority.verifier.close(); authority.issuer.close();
  });

  it("fails issuance and consumption closed when the independent trust boundary disappears", async () => {
    const issueFixture = setup("unavailable-issue"); issueFixture.activate();
    const issueAuthority = createTestCustomerLocalHttpWriteAuthorityFromTrustStore({ ...issueFixture.authorityConfig, testOnly: true });
    issueFixture.authorityTrustStore.close();
    await expect(issueAuthority.issuer.issueLease({ request: issueFixture.request(), credentialAlias: "actionBearer" })).rejects.toThrow(/closed|trust store/i);
    issueAuthority.verifier.close(); issueAuthority.issuer.close();

    const consumeFixture = setup("unavailable-consume"); consumeFixture.activate();
    const consumeAuthority = createTestCustomerLocalHttpWriteAuthorityFromTrustStore({ ...consumeFixture.authorityConfig, testOnly: true }), exactRequest = consumeFixture.request();
    const lease = await consumeAuthority.issuer.issueLease({ request: exactRequest, credentialAlias: "actionBearer" });
    consumeFixture.authorityTrustStore.close();
    expect(() => consumeAuthority.verifier.consume({ lease, request: exactRequest, credentialAlias: "actionBearer" })).toThrow(/closed|trust store/i);
    consumeAuthority.verifier.close(); consumeAuthority.issuer.close();
  });

  it("restores a signed authority-trust backup as audit-only and requires a strictly fresh signed activation", async () => {
    const fixture = setup("signed-audit-restore", { value: Date.now() }), activation = fixture.activate();
    const revocation = signWorkspaceHttpAuthorityActivationRevocation({
      workspaceId: "workspace_cf057", authorityContractDigest: fixture.contractDigest, activationReceiptDigest: activation.receiptDigest,
      trustConfigurationDigest: fixture.trustStore.configDigest, revocationSignerKeyId: "workspace_admin_v1", revocationSignerPublicKeyDigest: keyDigest(fixture.old.publicKey),
      issuedAt: new Date(fixture.clock.value).toISOString(), effectiveAt: new Date(fixture.clock.value).toISOString(), reason: "Preserve this revoked activation as audit evidence.", revocationNonce: "8".repeat(48), privateKey: fixture.old.privateKey,
    });
    fixture.authorityTrustStore.revokeActivation(revocation);
    const backupDirectory = join(fixture.directory, "authority-trust-backup");
    const backup = fixture.authorityTrustStore.createSignedAuditBackup({ directory: backupDirectory, signerKeyId: "workspace_admin_v1", signerPrivateKey: fixture.old.privateKey, expiresAt: new Date(fixture.clock.value + 60_000).toISOString() });
    const destinationStatePath = join(fixture.directory, "restored-authority-trust.sqlite");
    let stagedMode = "";
    const restored = restoreSignedCustomerLocalHttpAuthorityTrustBackup({
      backupDirectory, destinationStatePath, trustStore: fixture.trustStore, expectedWorkspaceId: "workspace_cf057", testOnly: true,
      _testOnlyBeforePublish: (temporaryStatePath, finalStatePath) => {
        expect(finalStatePath).toBe(destinationStatePath);
        expect(existsSync(finalStatePath)).toBe(false);
        const staged = new DatabaseSync(temporaryStatePath, { readOnly: true });
        stagedMode = (staged.prepare("SELECT value FROM authority_trust_meta WHERE key='activation_mode'").get() as { value: string }).value;
        staged.close();
      },
    });
    closers.push(() => restored.store.close());
    expect(stagedMode).toBe("audit-only-restored");
    expect(restored).toMatchObject({ manifestDigest: backup.manifest.manifestDigest, auditOnly: true, executionAuthority: false, activationAuthority: false, rollbackProtectionRequiresExternalMonotonicAnchor: true });
    expect(restored.store.auditActivations()).toMatchObject([{ activationDigest: activation.receiptDigest, revokedAt: revocation.effectiveAt, revocationDigest: revocation.receiptDigest }]);
    expect(() => restored.store.resolveCurrent(fixture.contractDigest)).toThrow(/audit-only|fresh post-restore/i);
    const resolveInputPath = join(fixture.directory, "resolve-after-publication.json");
    writeFileSync(resolveInputPath, JSON.stringify({ trustPath: join(fixture.directory, "trust.sqlite"), authorityTrustPath: destinationStatePath, workspaceId: "workspace_cf057", initialAdminKeyId: "workspace_admin_v1", authorityContractDigest: fixture.contractDigest, now: new Date(fixture.clock.value).toISOString(), trustConfig: fixture.config }));
    const independent = await runResolveWorker(resolveInputPath);
    expect(independent).toMatchObject({ status: "rejected" });
    expect(independent.message).toMatch(/audit-only|fresh post-restore/i);
    expect(restored.store.importActivation(activation)).toEqual({ activationReceiptDigest: activation.receiptDigest, authorityContractDigest: fixture.contractDigest });
    expect(() => restored.store.resolveCurrent(fixture.contractDigest)).toThrow(/audit-only|fresh post-restore/i);
    fixture.clock.value += 2;
    const successor = signWorkspaceHttpAuthorityActivation({ adminSignerKeyId: "workspace_admin_v1", workspaceId: "workspace_cf057", authorityContractDigest: fixture.contractDigest, privateKey: fixture.old.privateKey, issuedAt: new Date(fixture.clock.value).toISOString(), expiresAt: new Date(fixture.clock.value + 60_000).toISOString(), activationNonce: "9".repeat(48) });
    restored.store.importActivation(successor);
    expect(restored.store.resolveCurrent(fixture.contractDigest)).toMatchObject({ activationReceiptDigest: successor.receiptDigest, authorityContractDigest: fixture.contractDigest });
  });

  it("rejects signed-backup substitution, raw tamper, torn restore and cross-workspace recovery", () => {
    const fixture = setup("signed-audit-attacks", { value: Date.now() }); fixture.activate();
    const backupDirectory = join(fixture.directory, "authority-trust-backup");
    fixture.authorityTrustStore.createSignedAuditBackup({ directory: backupDirectory, signerKeyId: "workspace_admin_v1", signerPrivateKey: fixture.old.privateKey, expiresAt: new Date(fixture.clock.value + 60_000).toISOString() });
    expect(() => restoreSignedCustomerLocalHttpAuthorityTrustBackup({ backupDirectory, destinationStatePath: join(fixture.directory, "wrong-workspace.sqlite"), trustStore: fixture.trustStore, expectedWorkspaceId: "workspace_other", testOnly: true })).toThrow(/scope|workspace|boundary/i);
    expect(() => restoreSignedCustomerLocalHttpAuthorityTrustBackup({
      backupDirectory, destinationStatePath: join(fixture.directory, "copy-tamper.sqlite"), trustStore: fixture.trustStore, expectedWorkspaceId: "workspace_cf057", testOnly: true,
      _testOnlyAfterCopy: (path) => writeFileSync(path, Buffer.from("not a sqlite database")),
    })).toThrow(/changed during restore|database|identity/i);
    const signaturePath = join(backupDirectory, "manifest.sig"), originalSignature = readFileSync(signaturePath);
    const detached = JSON.parse(originalSignature.toString("utf8")) as { signature: string };
    detached.signature = Buffer.alloc(64, 3).toString("base64");
    writeFileSync(signaturePath, JSON.stringify(detached));
    expect(() => restoreSignedCustomerLocalHttpAuthorityTrustBackup({ backupDirectory, destinationStatePath: join(fixture.directory, "signature-tamper.sqlite"), trustStore: fixture.trustStore, expectedWorkspaceId: "workspace_cf057", testOnly: true })).toThrow(/signature|signer/i);
    writeFileSync(signaturePath, originalSignature);
    const database = new DatabaseSync(join(backupDirectory, "authority-trust.sqlite"));
    database.prepare("UPDATE authority_trust_meta SET value='workspace_attacker' WHERE key='workspace_id'").run();
    database.close();
    expect(() => restoreSignedCustomerLocalHttpAuthorityTrustBackup({ backupDirectory, destinationStatePath: join(fixture.directory, "raw-tamper.sqlite"), trustStore: fixture.trustStore, expectedWorkspaceId: "workspace_cf057", testOnly: true })).toThrow(/raw database identity|changed|signed/i);
  });
});
