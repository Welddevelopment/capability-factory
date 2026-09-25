import { createHash, X509Certificate } from "node:crypto";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeApprovedOpenApiMaterial } from "../src/product/approved-openapi-normalizer.js";
import {
  compileReviewedHttpBindings,
  httpActionGrantDigest,
  httpBindingCompilerDigest,
  type CustomerLocalCredentialResolver,
  type HttpActionExecutionGrant,
} from "../src/product/http-binding-compiler.js";
import { proposeHttpBindings, type HttpBindingFactoryFacts } from "../src/product/http-binding-factory.js";
import { createCustomerLocalPinnedHttpsTransport } from "../src/product/customer-local-pinned-https-transport.js";
import { createLocalFixtureBindingQualification } from "../src/product/customer-local-binding-qualification.js";
import type { ApprovedOpenApiMaterial } from "../src/product/onboarding-adapter-factory.js";
import { compileAuthorityWizard } from "../src/product/onboarding-verifier-authority.js";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function certificate(root: string) {
  const keyPath = join(root, "key.pem"), certificatePath = join(root, "cert.pem"), config = join(root, "openssl.cnf");
  writeFileSync(config, "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
  execFileSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", keyPath, "-out", certificatePath, "-config", config], { stdio: "ignore" });
  const pem = readFileSync(certificatePath, "utf8"), sha256 = createHash("sha256").update(new X509Certificate(pem).raw).digest("hex");
  return { keyPath, certificatePath, pem, sha256 };
}

async function launchProvider(root: string, tls: ReturnType<typeof certificate>, statePath: string, actionToken: string, observerToken: string): Promise<{ child: ChildProcessWithoutNullStreams; serverUrl: string }> {
  const worker = join(process.cwd(), "test/fixtures/cf054-pinned-https-provider-worker.ts"), tsx = join(process.cwd(), "node_modules/tsx/dist/loader.mjs");
  const child = spawn(process.execPath, ["--import", tsx, worker, "combined", tls.keyPath, tls.certificatePath, statePath], { env: { ...process.env, CF054_PROCESS_TOKEN: actionToken, CF054_OBSERVER_TOKEN: observerToken } });
  children.push(child);
  const ready = await new Promise<{ serverUrl: string }>((resolvePromise, rejectPromise) => {
    let stdout = "", stderr = "";
    const timer = setTimeout(() => rejectPromise(new Error(`CF-054 joined provider timeout: ${stderr}`)), 5_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); const newline = stdout.indexOf("\n"); if (newline >= 0) { clearTimeout(timer); resolvePromise(JSON.parse(stdout.slice(0, newline))); } });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("exit", () => { clearTimeout(timer); rejectPromise(new Error(`CF-054 joined provider exited before ready: ${stderr}`)); });
  });
  return { child, serverUrl: ready.serverUrl };
}

function approvedOpenApi(serverUrl: string): ApprovedOpenApiMaterial {
  return {
    kind: "openapi",
    materialId: "cf054_joined_orders_v1",
    localReference: "development/cf-054-author-known/openapi.json",
    approved: true,
    targetAlias: "cf054_orders_sandbox",
    document: {
      openapi: "3.1.0",
      info: { title: "CF-054 Joined Orders", version: "1.0.0" },
      servers: [{ url: serverUrl }],
      paths: {
        "/orders": {
          post: {
            operationId: "createOrder",
            security: [{ actionBearer: [] }],
            requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["order_ref", "sku", "quantity"], properties: { order_ref: { type: "string" }, sku: { type: "string" }, quantity: { type: "integer" } } } } } },
            responses: { "200": { description: "Existing" }, "201": { description: "Created" }, "409": { description: "Conflict" } },
          },
        },
        "/audit/orders": {
          get: {
            operationId: "auditOrder",
            security: [{ observerBearer: [] }],
            parameters: [{ name: "order_ref", in: "query", required: true, schema: { type: "string" } }],
            responses: { "200": { description: "Observed state", content: { "application/json": { schema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { order_ref: { type: "string" }, sku: { type: "string" }, quantity: { type: "integer" }, status: { type: "string" } } } }, server_time: { type: "string", format: "date-time" }, collateral_clean: { type: "boolean" } } } } } } },
          },
        },
      },
      components: { securitySchemes: { actionBearer: { type: "http", scheme: "bearer" }, observerBearer: { type: "http", scheme: "bearer" } } },
    },
  };
}

function bindingFacts(): HttpBindingFactoryFacts {
  return {
    targetAlias: "cf054_orders_sandbox",
    ordinaryBusinessOutcome: "Exactly one draft order exists for the confirmed order reference, SKU and quantity.",
    outcomeConfirmed: true,
    action: {
      driverId: "cf054_action_driver",
      operationId: "createOrder",
      operationConfirmed: true,
      credentialAlias: "actionBearer",
      requestMappings: [
        { source: { kind: "workflow-input", inputKey: "orderRef", confirmed: true }, destination: { location: "json-body", path: ["order_ref"] }, transform: "identity", confirmed: true },
        { source: { kind: "workflow-input", inputKey: "sku", confirmed: true }, destination: { location: "json-body", path: ["sku"] }, transform: "identity", confirmed: true },
        { source: { kind: "workflow-input", inputKey: "quantity", confirmed: true }, destination: { location: "json-body", path: ["quantity"] }, transform: "identity", confirmed: true },
      ],
      requestMappingsConfirmed: true,
      reconcileBeforeRetry: true,
      blindRetryAllowed: false,
    },
    observer: {
      driverId: "cf054_observer_driver",
      sourceId: "cf054_audit_source",
      operationId: "auditOrder",
      operationConfirmed: true,
      credentialAlias: "observerBearer",
      independentlyAuthenticated: true,
      independentFromActionDriver: true,
      parameterBindings: [{ name: "order_ref", location: "query", source: { kind: "workflow-input", inputKey: "orderRef", confirmed: true }, purpose: "stable-identifier", confirmed: true }],
      resultPath: ["items"],
      resultPathConfirmed: true,
      pagination: { kind: "not-paginated", confirmed: true },
      freshness: { kind: "server-timestamp-body", path: ["server_time"], maximumAgeSeconds: 30, confirmed: true },
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
      notStartedDefinition: [{ key: "no-order", path: ["items"], operator: "count-equals", expectedCount: 0, confirmed: true }],
      confirmed: true,
    },
  };
}

describe("reviewed OpenAPI bindings over the pinned HTTPS transport", () => {
  it("compiles approved operations into a real TLS write and separate-auth read, then verifies without trusting the action response", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf054-http-joined-")); roots.push(root);
    const tls = certificate(root), statePath = join(root, "state.json"), actionToken = "joined-action-token", observerToken = "joined-observer-token";
    writeFileSync(statePath, JSON.stringify({ sequence: 0, writes: 0, records: {} }), { mode: 0o600 });
    const provider = await launchProvider(root, tls, statePath, actionToken, observerToken), material = approvedOpenApi(provider.serverUrl);
    const firstNormalization = normalizeApprovedOpenApiMaterial(material);
    const normalization = normalizeApprovedOpenApiMaterial(material, { materialDigest: firstNormalization.originalMaterialDigest, selectedUrl: provider.serverUrl, confirmedByAlias: "fixtureEngineer", confirmedAt: new Date(Date.now() - 1_000).toISOString() });
    const authority = compileAuthorityWizard({
      schemaVersion: "1.0",
      systemsAndTargets: { aliases: ["cf054_orders_sandbox"], confirmed: true },
      credentialAliases: { aliases: ["actionBearer", "observerBearer"], confirmed: true },
      readsAllowed: { actions: [{ actionName: "auditOrder", targetAlias: "cf054_orders_sandbox" }], confirmed: true },
      writes: [{ actionName: "createOrder", targetAlias: "cf054_orders_sandbox", method: "POST", policy: "preauthorized", confirmed: true }],
      limits: { monetary: { kind: "none", confirmed: true }, quantityPerAction: { kind: "limit", maximum: 100, confirmed: true }, actionsPerHour: { kind: "limit", maximum: 100, confirmed: true } },
      forbiddenActions: { actionNames: ["deleteOrder"], confirmed: true },
      approver: { kind: "not-required", confirmed: true },
      retryAndReconciliation: { reconcileBeforeRetry: true, blindRetryAllowed: false, maximumAttempts: 1, confirmed: true },
      finalConsequentialReview: { confirmed: true },
    });
    const declarations = proposeHttpBindings({ schemaVersion: "1.0", normalization, authorityCompilation: authority, facts: bindingFacts() });
    expect(declarations.status).toBe("review-required");
    const actionTransport = createCustomerLocalPinnedHttpsTransport({ driverId: "cf054_action_driver", sourceId: "cf054_action_source", serverUrl: provider.serverUrl, supportedMethods: ["POST"], independentlyAuthenticated: true, independentFromDriverIds: [], credentialAlias: "actionBearer", reviewedOperations: [{ operationId: "createOrder", method: "POST", pathTemplate: "/orders", declarationDigest: declarations.actionBinding!.declarationDigest }], authorizationScheme: "Bearer", caCertificatePem: tls.pem, serverCertificateSha256: tls.sha256, timeoutMilliseconds: 1_000, maximumRequestBytes: 64 * 1024, maximumResponseBytes: 64 * 1024, maximumResponseHeaders: 32, maximumRequestsPerMinute: 120 });
    const observerTransport = createCustomerLocalPinnedHttpsTransport({ driverId: "cf054_observer_driver", sourceId: "cf054_audit_source", serverUrl: provider.serverUrl, supportedMethods: ["GET"], independentlyAuthenticated: true, independentFromDriverIds: ["cf054_action_driver"], credentialAlias: "observerBearer", reviewedOperations: [{ operationId: "auditOrder", method: "GET", pathTemplate: "/audit/orders", declarationDigest: declarations.observerBinding!.declarationDigest }], authorizationScheme: "Bearer", caCertificatePem: tls.pem, serverCertificateSha256: tls.sha256, timeoutMilliseconds: 1_000, maximumRequestBytes: 64 * 1024, maximumResponseBytes: 64 * 1024, maximumResponseHeaders: 32, maximumRequestsPerMinute: 120 });
    const resolver: CustomerLocalCredentialResolver = { resolverId: "cf054_resolver", implementationDigest: httpBindingCompilerDigest("cf054 resolver implementation"), allowedAliases: ["actionBearer", "observerBearer"], resolve: async (alias) => alias === "actionBearer" ? { alias, value: actionToken } : alias === "observerBearer" ? { alias, value: observerToken } : null };
    const qualifiedAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 60_000).toISOString();
    const qualification = createLocalFixtureBindingQualification({ tenantId: "tenant_cf054", sessionId: "session_cf054", packageDigest: httpBindingCompilerDigest("package"), sourceDigest: normalization.normalizationReceiptDigest, factoryResult: declarations, actionTransport, observerTransport, credentialResolver: resolver, qualifiedAt, expiresAt });
    const compiled = compileReviewedHttpBindings({ factoryResult: declarations, actionTransport, observerTransport, credentialResolver: resolver, primitiveRegistryDigest: httpBindingCompilerDigest("primitives"), verifierRegistryDigest: httpBindingCompilerDigest("verifiers"), qualifiedAt, expiresAt, customerLocalQualification: qualification });
    const workflowInput = { orderRef: "ORDER-054", sku: "SKU-54", quantity: 4 }, started = Date.now();
    const grantBody: Omit<HttpActionExecutionGrant, "grantDigest"> = { schemaVersion: "1.0", decision: "authorized", authorityCompilationDigest: declarations.actionBinding!.provenance.authorityCompilationDigest, actionDeclarationDigest: declarations.actionBinding!.declarationDigest, targetAlias: "cf054_orders_sandbox", operationId: "createOrder", method: "POST", parentGoalId: "parent_cf054", workItemId: "item_cf054", authorizedAt: new Date(started - 10).toISOString(), expiresAt };
    const grant = { ...grantBody, grantDigest: httpActionGrantDigest(grantBody) };
    const actionResult = await compiled.action.execute({ requestId: "request_cf054", parentGoalId: "parent_cf054", workItemId: "item_cf054", workflowInput, trustedContext: {}, grant });
    const outcome = await compiled.observer.observe({ requestId: "observe_cf054", parentGoalId: "parent_cf054", workItemId: "item_cf054", workflowInput, trustedContext: {}, operationStartedAtEpochMs: started });
    expect(actionResult).toMatchObject({ status: 201, actionResponseEligibleAsExternalProof: false, reconciliationKey: "ORDER-054" });
    expect(outcome).toMatchObject({ classification: "completed", passed: true, nextAction: "resume", incorrectSideEffects: 0, actionResponseUsedAsProof: false });
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ writes: 1, records: { "ORDER-054": { order_ref: "ORDER-054", sku: "SKU-54", quantity: 4, status: "draft" } } });

    await expect(compiled.action.execute({ requestId: "request_no_grant", parentGoalId: "parent_cf054", workItemId: "item_cf054", workflowInput: { ...workflowInput, orderRef: "ORDER-055" }, trustedContext: {} })).rejects.toThrow(/authorization is missing/i);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ writes: 1 });
  });
});
