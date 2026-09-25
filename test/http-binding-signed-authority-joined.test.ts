import { createHash, generateKeyPairSync, X509Certificate, type KeyObject } from "node:crypto";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeApprovedOpenApiMaterial } from "../src/product/approved-openapi-normalizer.js";
import { createLocalFixtureBindingQualification } from "../src/product/customer-local-binding-qualification.js";
import {
  createTestCustomerLocalHttpWriteAuthorityFromTrustStore,
  createCustomerLocalHttpNotStartedObserverSigner,
  customerLocalHttpAuthorityTrustContractDigest,
  signWorkspaceHttpAuthorityActivation,
  type CustomerLocalHttpWriteAuthorityContractInput,
} from "../src/product/customer-local-http-write-authority.js";
import { CustomerLocalTrustStore, type CustomerLocalTrustConfiguration } from "../src/product/customer-local-trust-backup.js";
import { CustomerLocalHttpAuthorityTrustStore } from "../src/product/customer-local-http-authority-trust.js";
import {
  createCustomerLocalPinnedHttpsTransport,
  createAuthorityEnforcedCustomerLocalPinnedHttpsTransport,
  pinnedHttpsAuthorityBoundaryDigest,
  type CustomerLocalPinnedHttpsTransportConfig,
} from "../src/product/customer-local-pinned-https-transport.js";
import {
  CompiledHttpActionDispatchUncertainError,
  compileAuthorityEnforcedReviewedHttpBindings,
  compileReviewedHttpBindings,
  httpBindingCompilerDigest,
  type CustomerLocalCredentialResolver,
} from "../src/product/http-binding-compiler.js";
import { proposeHttpBindings, type HttpBindingFactoryFacts } from "../src/product/http-binding-factory.js";
import type { ApprovedOpenApiMaterial } from "../src/product/onboarding-adapter-factory.js";
import { compileAuthorityWizard } from "../src/product/onboarding-verifier-authority.js";

const roots: string[] = [], children: ChildProcessWithoutNullStreams[] = [], closers: Array<() => void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) close();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspaceAuthorityTrust(root: string, draft: CustomerLocalHttpWriteAuthorityContractInput, adminKeys: { publicKey: KeyObject; privateKey: KeyObject }) {
  const { workspaceAuthority, ...base } = draft;
  const now = new Date(), trustConfig: CustomerLocalTrustConfiguration = {
    schemaVersion: "1.0",
    tenantId: `tenant_${workspaceAuthority.workspaceId}`,
    environment: "local",
    keys: [{
      keyId: workspaceAuthority.adminSignerKeyId,
      issuer: "fixture_customer_admin",
      publicKeyPem: adminKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      notBefore: new Date(now.getTime() - 60_000).toISOString(),
      notAfter: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1_000).toISOString(),
    }],
  };
  const trustStore = new CustomerLocalTrustStore(join(root, `${workspaceAuthority.workspaceId}-trust.sqlite`), trustConfig);
  const authorityTrustStore = new CustomerLocalHttpAuthorityTrustStore({ statePath: join(root, `${workspaceAuthority.workspaceId}-authority-trust.sqlite`), workspaceId: workspaceAuthority.workspaceId, initialAdminKeyId: workspaceAuthority.adminSignerKeyId, trustStore });
  const authorityConfig = { ...base, workspaceAuthorityTrustStore: authorityTrustStore };
  const authorityContractDigest = customerLocalHttpAuthorityTrustContractDigest(authorityConfig);
  const activationReceipt = signWorkspaceHttpAuthorityActivation({ adminSignerKeyId: workspaceAuthority.adminSignerKeyId, workspaceId: workspaceAuthority.workspaceId, authorityContractDigest, privateKey: adminKeys.privateKey, issuedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), activationNonce: createHash("sha256").update(`${workspaceAuthority.workspaceId}:${authorityContractDigest}`).digest("hex") });
  authorityTrustStore.importActivation(activationReceipt);
  closers.push(() => authorityTrustStore.close(), () => trustStore.close());
  return { authorityConfig, authorityContractDigest, activationReceipt, trustStore, authorityTrustStore };
}

function certificate(root: string) {
  const keyPath = join(root, "key.pem"), certificatePath = join(root, "cert.pem"), config = join(root, "openssl.cnf");
  writeFileSync(config, "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
  execFileSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", keyPath, "-out", certificatePath, "-config", config], { stdio: "ignore" });
  const pem = readFileSync(certificatePath, "utf8"), sha256 = createHash("sha256").update(new X509Certificate(pem).raw).digest("hex");
  return { keyPath, certificatePath, pem, sha256 };
}

async function launchProvider(root: string, tls: ReturnType<typeof certificate>, statePath: string, actionToken: string, observerToken: string) {
  const worker = join(process.cwd(), "test/fixtures/cf054-pinned-https-provider-worker.ts"), tsx = join(process.cwd(), "node_modules/tsx/dist/loader.mjs");
  const child = spawn(process.execPath, ["--import", tsx, worker, "combined", tls.keyPath, tls.certificatePath, statePath], { env: { ...process.env, CF054_PROCESS_TOKEN: actionToken, CF054_OBSERVER_TOKEN: observerToken } });
  children.push(child);
  const ready = await new Promise<{ serverUrl: string }>((resolvePromise, rejectPromise) => {
    let stdout = "", stderr = "";
    const timer = setTimeout(() => rejectPromise(new Error(`CF-055 joined provider timeout: ${stderr}`)), 5_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); const newline = stdout.indexOf("\n"); if (newline >= 0) { clearTimeout(timer); resolvePromise(JSON.parse(stdout.slice(0, newline))); } });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("exit", () => { clearTimeout(timer); rejectPromise(new Error(`CF-055 joined provider exited before ready: ${stderr}`)); });
  });
  return { child, serverUrl: ready.serverUrl };
}

async function launchRecoveryProvider(root: string, tls: ReturnType<typeof certificate>, statePath: string, actionToken: string, observerToken: string) {
  const worker = join(process.cwd(), "test/fixtures/cf056-not-started-recovery-provider-worker.ts"), tsx = join(process.cwd(), "node_modules/tsx/dist/loader.mjs");
  const child = spawn(process.execPath, ["--import", tsx, worker, tls.keyPath, tls.certificatePath, statePath], { env: { ...process.env, CF056_ACTION_TOKEN: actionToken, CF056_OBSERVER_TOKEN: observerToken } });
  children.push(child);
  const ready = await new Promise<{ serverUrl: string }>((resolvePromise, rejectPromise) => {
    let stdout = "", stderr = "";
    const timer = setTimeout(() => rejectPromise(new Error(`CF-056 recovery provider timeout: ${stderr}`)), 5_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); const newline = stdout.indexOf("\n"); if (newline >= 0) { clearTimeout(timer); resolvePromise(JSON.parse(stdout.slice(0, newline))); } });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("exit", () => { clearTimeout(timer); rejectPromise(new Error(`CF-056 recovery provider exited before ready: ${stderr}`)); });
  });
  return { child, serverUrl: ready.serverUrl };
}

function approvedOpenApi(serverUrl: string): ApprovedOpenApiMaterial {
  return {
    kind: "openapi", materialId: "cf055_orders_v1", localReference: "development/cf-055/openapi.json", approved: true, targetAlias: "cf055_orders_sandbox",
    document: {
      openapi: "3.1.0", info: { title: "CF-055 Orders", version: "1.0.0" }, servers: [{ url: serverUrl }],
      paths: {
        "/orders": { post: { operationId: "createOrder", security: [{ actionBearer: [] }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["order_ref", "sku", "quantity"], properties: { order_ref: { type: "string" }, sku: { type: "string" }, quantity: { type: "integer" } } } } } }, responses: { "201": { description: "Created" } } } },
        "/audit/orders": { get: { operationId: "auditOrder", security: [{ observerBearer: [] }], parameters: [{ name: "order_ref", in: "query", required: true, schema: { type: "string" } }], responses: { "200": { description: "Observed", content: { "application/json": { schema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { order_ref: { type: "string" }, sku: { type: "string" }, quantity: { type: "integer" }, status: { type: "string" } } } }, server_time: { type: "string" }, collateral_clean: { type: "boolean" } } } } } } } } },
      },
      components: { securitySchemes: { actionBearer: { type: "http", scheme: "bearer" }, observerBearer: { type: "http", scheme: "bearer" } } },
    },
  };
}

function bindingFacts(): HttpBindingFactoryFacts {
  return {
    targetAlias: "cf055_orders_sandbox", ordinaryBusinessOutcome: "Exactly one draft order exists for the confirmed reference.", outcomeConfirmed: true,
    action: {
      driverId: "cf055_action_driver", operationId: "createOrder", operationConfirmed: true, credentialAlias: "actionBearer",
      requestMappings: [
        { source: { kind: "workflow-input", inputKey: "orderRef", confirmed: true }, destination: { location: "json-body", path: ["order_ref"] }, transform: "identity", confirmed: true },
        { source: { kind: "workflow-input", inputKey: "sku", confirmed: true }, destination: { location: "json-body", path: ["sku"] }, transform: "identity", confirmed: true },
        { source: { kind: "workflow-input", inputKey: "quantity", confirmed: true }, destination: { location: "json-body", path: ["quantity"] }, transform: "identity", confirmed: true },
      ],
      requestMappingsConfirmed: true, reconcileBeforeRetry: true, blindRetryAllowed: false,
    },
    observer: {
      driverId: "cf055_observer_driver", sourceId: "cf055_audit_source", operationId: "auditOrder", operationConfirmed: true, credentialAlias: "observerBearer", independentlyAuthenticated: true, independentFromActionDriver: true,
      parameterBindings: [{ name: "order_ref", location: "query", source: { kind: "workflow-input", inputKey: "orderRef", confirmed: true }, purpose: "stable-identifier", confirmed: true }],
      resultPath: ["items"], resultPathConfirmed: true, pagination: { kind: "not-paginated", confirmed: true }, freshness: { kind: "server-timestamp-body", path: ["server_time"], maximumAgeSeconds: 30, confirmed: true },
    },
    outcome: {
      predicates: [
        { key: "one-order", path: ["items"], operator: "count-equals", expectedCount: 1, confirmed: true },
        { key: "same-reference", path: ["items", 0, "order_ref"], operator: "equals-input", inputKey: "orderRef", confirmed: true },
        { key: "same-sku", path: ["items", 0, "sku"], operator: "equals-input", inputKey: "sku", confirmed: true },
        { key: "same-quantity", path: ["items", 0, "quantity"], operator: "equals-input", inputKey: "quantity", confirmed: true },
      ],
      duplicateCheck: { collectionPath: ["items"], uniqueKeyPath: ["order_ref"], expectedCount: 1, confirmed: true },
      collateralChecks: [{ key: "collateral-clean", path: ["collateral_clean"], operator: "equals-confirmed", expected: true, confirmed: true }],
      notStartedDefinition: [{ key: "no-order", path: ["items"], operator: "count-equals", expectedCount: 0, confirmed: true }], confirmed: true,
    },
  };
}

describe("reviewed HTTP binding with signed immediate transport authority", () => {
  it("writes only after the real transport consumes an exact signed lease, then verifies external state independently", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf055-joined-")); roots.push(root);
    const tls = certificate(root), statePath = join(root, "state.json"), actionToken = "signed-action-token", observerToken = "signed-observer-token";
    writeFileSync(statePath, JSON.stringify({ sequence: 0, writes: 0, records: {} }), { mode: 0o600 });
    const provider = await launchProvider(root, tls, statePath, actionToken, observerToken), material = approvedOpenApi(provider.serverUrl);
    const first = normalizeApprovedOpenApiMaterial(material), normalization = normalizeApprovedOpenApiMaterial(material, { materialDigest: first.originalMaterialDigest, selectedUrl: provider.serverUrl, confirmedByAlias: "fixtureEngineer", confirmedAt: new Date(Date.now() - 1_000).toISOString() });
    const authorityCompilation = compileAuthorityWizard({
      schemaVersion: "1.0", systemsAndTargets: { aliases: ["cf055_orders_sandbox"], confirmed: true }, credentialAliases: { aliases: ["actionBearer", "observerBearer"], confirmed: true },
      readsAllowed: { actions: [{ actionName: "auditOrder", targetAlias: "cf055_orders_sandbox" }], confirmed: true },
      writes: [{ actionName: "createOrder", targetAlias: "cf055_orders_sandbox", method: "POST", policy: "preauthorized", confirmed: true }],
      limits: { monetary: { kind: "none", confirmed: true }, quantityPerAction: { kind: "limit", maximum: 10, confirmed: true }, actionsPerHour: { kind: "limit", maximum: 10, confirmed: true } },
      forbiddenActions: { actionNames: ["deleteOrder"], confirmed: true }, approver: { kind: "not-required", confirmed: true },
      retryAndReconciliation: { reconcileBeforeRetry: true, blindRetryAllowed: false, maximumAttempts: 1, confirmed: true }, finalConsequentialReview: { confirmed: true },
    });
    const declarations = proposeHttpBindings({ schemaVersion: "1.0", normalization, authorityCompilation, facts: bindingFacts() });
    expect(declarations.status).toBe("review-required");
    const resolver: CustomerLocalCredentialResolver = { resolverId: "cf055_resolver", implementationDigest: httpBindingCompilerDigest("cf055 resolver"), allowedAliases: ["actionBearer", "observerBearer"], resolve: async (alias) => alias === "actionBearer" ? { alias, value: actionToken } : alias === "observerBearer" ? { alias, value: observerToken } : null };
    const actionConfig: CustomerLocalPinnedHttpsTransportConfig = { driverId: "cf055_action_driver", sourceId: "cf055_action_source", serverUrl: provider.serverUrl, supportedMethods: ["POST"], independentlyAuthenticated: true, independentFromDriverIds: [], credentialAlias: "actionBearer", reviewedOperations: [{ operationId: "createOrder", method: "POST", pathTemplate: "/orders", declarationDigest: declarations.actionBinding!.declarationDigest }], authorizationScheme: "Bearer", caCertificatePem: tls.pem, serverCertificateSha256: tls.sha256, timeoutMilliseconds: 1_000, maximumRequestBytes: 64 * 1024, maximumResponseBytes: 64 * 1024, maximumResponseHeaders: 32, maximumRequestsPerMinute: 2 };
    const keys = generateKeyPairSync("ed25519"), adminKeys = generateKeyPairSync("ed25519"), authorityDraft = { statePath: join(root, "authority.sqlite"), issuerId: "cf055_authority", signerKeyId: "cf055_signer", privateKey: keys.privateKey, publicKey: keys.publicKey, authorityCompilation, actionDeclaration: declarations.actionBinding!, transportAuthorityBoundaryDigest: pinnedHttpsAuthorityBoundaryDigest(actionConfig), credentialResolverDigest: resolver.implementationDigest, quantityMetric: { kind: "json-body-number" as const, field: "quantity" }, maximumLeaseMilliseconds: 2_000, workspaceAuthority: { workspaceId: "workspace_cf055", adminSignerKeyId: "workspace_admin_key", adminPublicKey: adminKeys.publicKey } };
    const { authorityConfig } = workspaceAuthorityTrust(root, authorityDraft, adminKeys);
    const authority = createTestCustomerLocalHttpWriteAuthorityFromTrustStore({ ...authorityConfig, testOnly: true });
    const actionTransport = createAuthorityEnforcedCustomerLocalPinnedHttpsTransport({ ...actionConfig, writeAuthorityVerifier: authority.verifier });
    const observerTransport = createCustomerLocalPinnedHttpsTransport({ driverId: "cf055_observer_driver", sourceId: "cf055_audit_source", serverUrl: provider.serverUrl, supportedMethods: ["GET"], independentlyAuthenticated: true, independentFromDriverIds: ["cf055_action_driver"], credentialAlias: "observerBearer", reviewedOperations: [{ operationId: "auditOrder", method: "GET", pathTemplate: "/audit/orders", declarationDigest: declarations.observerBinding!.declarationDigest }], authorizationScheme: "Bearer", caCertificatePem: tls.pem, serverCertificateSha256: tls.sha256, timeoutMilliseconds: 1_000, maximumRequestBytes: 64 * 1024, maximumResponseBytes: 64 * 1024, maximumResponseHeaders: 32, maximumRequestsPerMinute: 120 });
    const directRequest = { requestId: "direct_unsigned", parentGoalId: "parent_unsigned", workItemId: "item_unsigned", driverId: "cf055_action_driver", targetAlias: "cf055_orders_sandbox", serverUrl: provider.serverUrl, operationId: "createOrder", method: "POST" as const, path: "/orders", query: {}, headers: {}, body: { order_ref: "UNSIGNED", sku: "SKU-U", quantity: 1 }, credentialAlias: "actionBearer", reconciliationKey: "UNSIGNED", declarationDigest: declarations.actionBinding!.declarationDigest };
    const firstReservation = actionTransport.prepareWrite!(directRequest, { alias: "actionBearer", value: actionToken });
    const secondReservation = actionTransport.prepareWrite!({ ...directRequest, requestId: "direct_unsigned_two", parentGoalId: "parent_unsigned_two", workItemId: "item_unsigned_two" }, { alias: "actionBearer", value: actionToken });
    expect(() => actionTransport.prepareWrite!({ ...directRequest, requestId: "direct_unsigned_three", parentGoalId: "parent_unsigned_three", workItemId: "item_unsigned_three" }, { alias: "actionBearer", value: actionToken })).toThrow(/rate bound reached before authority issuance/i);
    firstReservation.cancelBeforeAuthority();
    secondReservation.cancelBeforeAuthority();
    expect(() => secondReservation.cancelBeforeAuthority()).toThrow(/already cancelled|absent/i);
    const authorityDatabase = new DatabaseSync(authorityDraft.statePath);
    expect((authorityDatabase.prepare("SELECT COUNT(*) AS count FROM http_authority_leases").get() as { count: number }).count).toBe(0);
    await expect(actionTransport.perform(directRequest, { alias: "actionBearer", value: actionToken })).rejects.toThrow(/signed immediate write-authority lease is missing/i);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ writes: 0 });
    const qualifiedAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 60_000).toISOString(), qualification = createLocalFixtureBindingQualification({ tenantId: "tenant_cf055", sessionId: "session_cf055", packageDigest: httpBindingCompilerDigest("cf055 package"), sourceDigest: normalization.normalizationReceiptDigest, factoryResult: declarations, actionTransport, observerTransport, credentialResolver: resolver, qualifiedAt, expiresAt });
    const compilerInput = { factoryResult: declarations, actionTransport, observerTransport, credentialResolver: resolver, primitiveRegistryDigest: httpBindingCompilerDigest("cf055 primitives"), verifierRegistryDigest: httpBindingCompilerDigest("cf055 verifiers"), qualifiedAt, expiresAt, customerLocalQualification: qualification, writeAuthorityIssuer: authority.issuer };
    const forgedTransport = { ...actionTransport, perform: async () => ({ status: 201, headers: {}, body: { forged: true } }) };
    expect(() => compileAuthorityEnforcedReviewedHttpBindings({ ...compilerInput, actionTransport: forgedTransport })).toThrow(/not an instance of the trusted authority-enforced/i);
    const compiled = compileAuthorityEnforcedReviewedHttpBindings(compilerInput);
    (compilerInput as { actionTransport: unknown }).actionTransport = observerTransport;
    resolver.allowedAliases.splice(0);
    resolver.resolve = async () => null;
    qualification.runtime.actionProfile.method = "DELETE";
    declarations.actionBinding!.operation.operationId = "deleteOrder";
    declarations.actionBinding!.requestMappings[2]!.destination = { location: "json-body", path: ["mutated_quantity"] };
    const workflowInput = { orderRef: "ORDER-055", sku: "SKU-55", quantity: 4 }, started = Date.now();
    await expect(compiled.action.execute({ requestId: "request_mutated_runtime", parentGoalId: "parent_cf055", workItemId: "item_mutated_runtime", workflowInput: { orderRef: "ORDER-MUTATED", sku: "SKU-M", quantity: 4 }, trustedContext: {} })).rejects.toThrow(/qualified transport/i);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ writes: 0 });
    qualification.runtime.actionProfile.method = "POST";
    const result = await compiled.action.execute({ requestId: "request_cf055", parentGoalId: "parent_cf055", workItemId: "item_cf055", workflowInput, trustedContext: {} });
    const outcome = await compiled.observer.observe({ requestId: "observe_cf055", parentGoalId: "parent_cf055", workItemId: "item_cf055", workflowInput, trustedContext: {}, operationStartedAtEpochMs: started });
    expect(result).toMatchObject({ status: 201, actionResponseEligibleAsExternalProof: false });
    expect(outcome).toMatchObject({ classification: "completed", passed: true, actionResponseUsedAsProof: false });
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ writes: 1, records: { "ORDER-055": { quantity: 4 } } });
    expect((authorityDatabase.prepare("SELECT COUNT(*) AS count FROM http_authority_leases").get() as { count: number }).count).toBe(1);
    await expect(compiled.action.execute({ requestId: "request_over_limit", parentGoalId: "parent_cf055", workItemId: "item_over_limit", workflowInput: { orderRef: "ORDER-056", sku: "SKU-56", quantity: 11 }, trustedContext: {} })).rejects.toThrow(/quantity limit/i);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ writes: 1 });
    expect((authorityDatabase.prepare("SELECT COUNT(*) AS count FROM http_authority_leases").get() as { count: number }).count).toBe(1);
    await expect(compiled.action.execute({ requestId: "request_after_cancelled_reservation", parentGoalId: "parent_cf055_second", workItemId: "item_cf055_second", workflowInput: { orderRef: "ORDER-057", sku: "SKU-57", quantity: 2 }, trustedContext: {} })).resolves.toMatchObject({ status: 201 });
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ writes: 2, records: { "ORDER-057": { quantity: 2 } } });
    expect((authorityDatabase.prepare("SELECT COUNT(*) AS count FROM http_authority_leases").get() as { count: number }).count).toBe(2);
    await expect(compiled.action.execute({ requestId: "request_rejected_before_authority", parentGoalId: "parent_cf055_third", workItemId: "item_cf055_third", workflowInput: { orderRef: "ORDER-058", sku: "SKU-58", quantity: 1 }, trustedContext: {} })).rejects.toThrow(/rate bound reached before authority issuance/i);
    expect((authorityDatabase.prepare("SELECT COUNT(*) AS count FROM http_authority_leases").get() as { count: number }).count).toBe(2);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ writes: 2 });
    authorityDatabase.close();
    authority.verifier.close(); authority.issuer.close();
  });

  it("reissues the exact request once after a real precommit response loss and signed independent not-started observation", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf056-joined-")); roots.push(root);
    const tls = certificate(root), statePath = join(root, "state.json"), actionToken = "recovery-action-token", observerToken = "recovery-observer-token";
    writeFileSync(statePath, JSON.stringify({ sequence: 0, writes: 0, precommitDrops: 0, records: {} }), { mode: 0o600 });
    const provider = await launchRecoveryProvider(root, tls, statePath, actionToken, observerToken), material = approvedOpenApi(provider.serverUrl);
    const first = normalizeApprovedOpenApiMaterial(material), normalization = normalizeApprovedOpenApiMaterial(material, { materialDigest: first.originalMaterialDigest, selectedUrl: provider.serverUrl, confirmedByAlias: "fixtureEngineer", confirmedAt: new Date(Date.now() - 1_000).toISOString() });
    const authorityCompilation = compileAuthorityWizard({
      schemaVersion: "1.0", systemsAndTargets: { aliases: ["cf055_orders_sandbox"], confirmed: true }, credentialAliases: { aliases: ["actionBearer", "observerBearer"], confirmed: true },
      readsAllowed: { actions: [{ actionName: "auditOrder", targetAlias: "cf055_orders_sandbox" }], confirmed: true },
      writes: [{ actionName: "createOrder", targetAlias: "cf055_orders_sandbox", method: "POST", policy: "preauthorized", confirmed: true }],
      limits: { monetary: { kind: "none", confirmed: true }, quantityPerAction: { kind: "limit", maximum: 10, confirmed: true }, actionsPerHour: { kind: "limit", maximum: 10, confirmed: true } },
      forbiddenActions: { actionNames: ["deleteOrder"], confirmed: true }, approver: { kind: "not-required", confirmed: true },
      retryAndReconciliation: { reconcileBeforeRetry: true, blindRetryAllowed: false, maximumAttempts: 2, confirmed: true }, finalConsequentialReview: { confirmed: true },
    });
    const declarations = proposeHttpBindings({ schemaVersion: "1.0", normalization, authorityCompilation, facts: bindingFacts() });
    const resolver: CustomerLocalCredentialResolver = { resolverId: "cf056_resolver", implementationDigest: httpBindingCompilerDigest("cf056 resolver"), allowedAliases: ["actionBearer", "observerBearer"], resolve: async (alias) => alias === "actionBearer" ? { alias, value: actionToken } : alias === "observerBearer" ? { alias, value: observerToken } : null };
    const actionConfig: CustomerLocalPinnedHttpsTransportConfig = { driverId: "cf055_action_driver", sourceId: "cf056_action_source", serverUrl: provider.serverUrl, supportedMethods: ["POST"], independentlyAuthenticated: true, independentFromDriverIds: [], credentialAlias: "actionBearer", reviewedOperations: [{ operationId: "createOrder", method: "POST", pathTemplate: "/orders", declarationDigest: declarations.actionBinding!.declarationDigest }], authorizationScheme: "Bearer", caCertificatePem: tls.pem, serverCertificateSha256: tls.sha256, timeoutMilliseconds: 1_000, maximumRequestBytes: 64 * 1024, maximumResponseBytes: 64 * 1024, maximumResponseHeaders: 32, maximumRequestsPerMinute: 120 };
    const observerTransport = createCustomerLocalPinnedHttpsTransport({ driverId: "cf055_observer_driver", sourceId: "cf055_audit_source", serverUrl: provider.serverUrl, supportedMethods: ["GET"], independentlyAuthenticated: true, independentFromDriverIds: ["cf055_action_driver"], credentialAlias: "observerBearer", reviewedOperations: [{ operationId: "auditOrder", method: "GET", pathTemplate: "/audit/orders", declarationDigest: declarations.observerBinding!.declarationDigest }], authorizationScheme: "Bearer", caCertificatePem: tls.pem, serverCertificateSha256: tls.sha256, timeoutMilliseconds: 1_000, maximumRequestBytes: 64 * 1024, maximumResponseBytes: 64 * 1024, maximumResponseHeaders: 32, maximumRequestsPerMinute: 120 });
    const preliminaryActionTransport = createCustomerLocalPinnedHttpsTransport(actionConfig);
    const qualifiedAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 60_000).toISOString(), primitiveRegistryDigest = httpBindingCompilerDigest("cf056 primitives"), verifierRegistryDigest = httpBindingCompilerDigest("cf056 verifiers");
    const preliminaryQualification = createLocalFixtureBindingQualification({ tenantId: "tenant_cf056_preliminary", sessionId: "session_cf056_preliminary", packageDigest: httpBindingCompilerDigest("cf056 preliminary package"), sourceDigest: normalization.normalizationReceiptDigest, factoryResult: declarations, actionTransport: preliminaryActionTransport, observerTransport, credentialResolver: resolver, qualifiedAt, expiresAt });
    const preliminary = compileReviewedHttpBindings({ factoryResult: declarations, actionTransport: preliminaryActionTransport, observerTransport, credentialResolver: resolver, primitiveRegistryDigest, verifierRegistryDigest, qualifiedAt, expiresAt, customerLocalQualification: preliminaryQualification });
    const observerKeys = generateKeyPairSync("ed25519"), recoveryObserver = { signerKeyId: "cf056_recovery_observer_key", publicKey: observerKeys.publicKey, observerImplementationDigest: preliminary.observer.implementationDigest, observerBindingDigest: preliminary.observer.declarationDigest, observerQualificationDigest: preliminary.observer.qualification.qualificationDigest };
    const observerSigner = createCustomerLocalHttpNotStartedObserverSigner({ ...recoveryObserver, privateKey: observerKeys.privateKey, maximumReceiptMilliseconds: 10_000 });
    const authorityKeys = generateKeyPairSync("ed25519"), adminKeys = generateKeyPairSync("ed25519"), authorityDraft = { statePath: join(root, "authority.sqlite"), issuerId: "cf056_authority", signerKeyId: "cf056_authority_key", privateKey: authorityKeys.privateKey, publicKey: authorityKeys.publicKey, authorityCompilation, actionDeclaration: declarations.actionBinding!, transportAuthorityBoundaryDigest: pinnedHttpsAuthorityBoundaryDigest(actionConfig), credentialResolverDigest: resolver.implementationDigest, quantityMetric: { kind: "json-body-number" as const, field: "quantity" }, maximumLeaseMilliseconds: 100, maximumRecoveryEvidenceMilliseconds: 10_000, recoveryObserver, workspaceAuthority: { workspaceId: "workspace_cf056", adminSignerKeyId: "workspace_admin_key", adminPublicKey: adminKeys.publicKey } };
    const { authorityConfig } = workspaceAuthorityTrust(root, authorityDraft, adminKeys);
    const firstAuthority = createTestCustomerLocalHttpWriteAuthorityFromTrustStore({ ...authorityConfig, testOnly: true });
    const firstActionTransport = createAuthorityEnforcedCustomerLocalPinnedHttpsTransport({ ...actionConfig, writeAuthorityVerifier: firstAuthority.verifier });
    const workflowInput = { orderRef: "ORDER-056-RETRY", sku: "SKU-56", quantity: 3 }, actionInput = { requestId: "request_cf056_retry", parentGoalId: "parent_cf056", workItemId: "item_cf056", workflowInput, trustedContext: {} }, started = Date.now();
    const strandedRequest = { requestId: actionInput.requestId, parentGoalId: actionInput.parentGoalId, workItemId: actionInput.workItemId, driverId: "cf055_action_driver", targetAlias: "cf055_orders_sandbox", serverUrl: provider.serverUrl, operationId: "createOrder", method: "POST" as const, path: "/orders", query: {}, headers: {}, body: { order_ref: workflowInput.orderRef, sku: workflowInput.sku, quantity: workflowInput.quantity }, credentialAlias: "actionBearer", reconciliationKey: workflowInput.orderRef, declarationDigest: declarations.actionBinding!.declarationDigest };
    const strandedPreparation = firstActionTransport.prepareWrite!(strandedRequest, { alias: "actionBearer", value: actionToken });
    const strandedLease = await firstAuthority.issuer.issueLease({ request: strandedRequest, credentialAlias: "actionBearer", transportReservationDigest: strandedPreparation.reservationDigest });
    expect(strandedLease).toMatchObject({ attempt: 1, generation: 1 });
    firstAuthority.verifier.close(); firstAuthority.issuer.close();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));

    const authority = createTestCustomerLocalHttpWriteAuthorityFromTrustStore({ ...authorityConfig, testOnly: true });
    const actionTransport = createAuthorityEnforcedCustomerLocalPinnedHttpsTransport({ ...actionConfig, writeAuthorityVerifier: authority.verifier });
    const qualification = createLocalFixtureBindingQualification({ tenantId: "tenant_cf056", sessionId: "session_cf056", packageDigest: httpBindingCompilerDigest("cf056 package"), sourceDigest: normalization.normalizationReceiptDigest, factoryResult: declarations, actionTransport, observerTransport, credentialResolver: resolver, qualifiedAt, expiresAt });
    const compiled = compileAuthorityEnforcedReviewedHttpBindings({ factoryResult: declarations, actionTransport, observerTransport, credentialResolver: resolver, primitiveRegistryDigest, verifierRegistryDigest, qualifiedAt, expiresAt, customerLocalQualification: qualification, writeAuthorityIssuer: authority.issuer, recoveryObserverSigner: observerSigner });
    let interrupted: CompiledHttpActionDispatchUncertainError | undefined;
    try { await compiled.action.execute({ ...actionInput, unconsumedReplacement: { priorLease: strandedLease, reason: "expired-before-consume" } }); } catch (error) { if (error instanceof CompiledHttpActionDispatchUncertainError) interrupted = error; else throw error; }
    expect(interrupted).toBeInstanceOf(CompiledHttpActionDispatchUncertainError);
    expect(interrupted!.consumedAuthorityLease).toMatchObject({ attempt: 1, generation: 2, priorUnconsumedLeaseDigest: strandedLease.leaseDigest });
    await expect(strandedPreparation.dispatch(strandedLease)).rejects.toThrow(/closed|valid|retired|stale/i);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ precommitDrops: 1, writes: 0, records: {} });
    const notStarted = await compiled.observer.observe({ requestId: "observe_cf056_not_started", parentGoalId: actionInput.parentGoalId, workItemId: actionInput.workItemId, workflowInput, trustedContext: {}, operationStartedAtEpochMs: started, recoveryContext: { priorLease: interrupted!.consumedAuthorityLease, actionRequest: interrupted!.request } });
    expect(notStarted).toMatchObject({ classification: "not-started", actionResponseUsedAsProof: false, incorrectSideEffects: 0 });
    const recoveryReceipt = notStarted.notStartedRecoveryReceipt!;
    const completed = await compiled.action.execute({ ...actionInput, notStartedRecovery: { priorLease: interrupted!.consumedAuthorityLease, receipt: recoveryReceipt, observation: notStarted } });
    expect(completed).toMatchObject({ status: 201, actionResponseEligibleAsExternalProof: false });
    const observed = await compiled.observer.observe({ requestId: "observe_cf056_completed", parentGoalId: actionInput.parentGoalId, workItemId: actionInput.workItemId, workflowInput, trustedContext: {}, operationStartedAtEpochMs: started });
    expect(observed).toMatchObject({ classification: "completed", passed: true, actionResponseUsedAsProof: false });
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ precommitDrops: 1, writes: 1, records: { "ORDER-056-RETRY": { quantity: 3 } } });
    await expect(compiled.action.execute({ ...actionInput, notStartedRecovery: { priorLease: interrupted!.consumedAuthorityLease, receipt: recoveryReceipt, observation: notStarted } })).rejects.toThrow();
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ writes: 1 });
    authority.verifier.close(); authority.issuer.close();
  });
});
