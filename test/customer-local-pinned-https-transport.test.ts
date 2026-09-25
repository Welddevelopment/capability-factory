import { createHash, X509Certificate } from "node:crypto";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCustomerLocalPinnedHttpsTransport,
  pinnedHttpsTransportDigest,
  type CustomerLocalPinnedHttpsTransportConfig,
} from "../src/product/customer-local-pinned-https-transport.js";
import type { CompiledHttpRequest, CustomerLocalHttpTransport } from "../src/product/http-binding-compiler.js";

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

function tlsFixture(root: string): { keyPath: string; certificatePath: string; certificatePem: string; certificateDigest: string } {
  const keyPath = join(root, "server-key.pem"), certificatePath = join(root, "server-cert.pem"), configPath = join(root, "openssl.cnf");
  writeFileSync(configPath, "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
  execFileSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", keyPath, "-out", certificatePath, "-config", configPath], { stdio: "ignore" });
  const certificatePem = readFileSync(certificatePath, "utf8"), certificateDigest = createHash("sha256").update(new X509Certificate(certificatePem).raw).digest("hex");
  return { keyPath, certificatePath, certificatePem, certificateDigest };
}

async function launch(root: string, plane: "action" | "observer", tls: ReturnType<typeof tlsFixture>, statePath: string, token: string): Promise<{ child: ChildProcessWithoutNullStreams; serverUrl: string }> {
  const worker = join(process.cwd(), "test/fixtures/cf054-pinned-https-provider-worker.ts"), tsx = join(process.cwd(), "node_modules/tsx/dist/loader.mjs");
  const child = spawn(process.execPath, ["--import", tsx, worker, plane, tls.keyPath, tls.certificatePath, statePath], { env: { ...process.env, CF054_PROCESS_TOKEN: token } });
  children.push(child);
  const message = await new Promise<{ serverUrl: string }>((resolvePromise, rejectPromise) => {
    let stdout = "", stderr = "";
    const timer = setTimeout(() => rejectPromise(new Error(`CF-054 worker timeout: ${stderr}`)), 5_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); const newline = stdout.indexOf("\n"); if (newline >= 0) { clearTimeout(timer); resolvePromise(JSON.parse(stdout.slice(0, newline))); } });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("exit", () => { clearTimeout(timer); rejectPromise(new Error(`CF-054 worker exited before ready: ${stderr}`)); });
  });
  return { child, serverUrl: message.serverUrl };
}

function transport(input: { plane: "action" | "observer"; serverUrl: string; tls: ReturnType<typeof tlsFixture>; tokenAlias: string; actionDriver?: string; maximumResponseBytes?: number; timeoutMilliseconds?: number; certificateDigest?: string }): CustomerLocalHttpTransport {
  const method = input.plane === "action" ? "POST" as const : "GET" as const;
  return createCustomerLocalPinnedHttpsTransport({
    driverId: `${input.plane}_driver`,
    sourceId: `${input.plane}_source`,
    serverUrl: input.serverUrl,
    supportedMethods: input.plane === "action" ? ["POST"] : ["GET"],
    independentlyAuthenticated: input.plane === "observer",
    independentFromDriverIds: input.plane === "observer" ? [input.actionDriver ?? "action_driver"] : [],
    credentialAlias: input.tokenAlias,
    reviewedOperations: [
      { operationId: "reviewed_operation", method, pathTemplate: input.plane === "action" ? "/orders" : "/audit/orders", declarationDigest: "d".repeat(64) },
      { operationId: "redirect_operation", method, pathTemplate: "/redirect", declarationDigest: "d".repeat(64) },
      { operationId: "oversized_operation", method, pathTemplate: "/oversized", declarationDigest: "d".repeat(64) },
      { operationId: "slow_operation", method, pathTemplate: "/slow", declarationDigest: "d".repeat(64) },
      { operationId: "plain_operation", method, pathTemplate: "/plain", declarationDigest: "d".repeat(64) },
    ],
    authorizationScheme: "Bearer",
    caCertificatePem: input.tls.certificatePem,
    serverCertificateSha256: input.certificateDigest ?? input.tls.certificateDigest,
    timeoutMilliseconds: input.timeoutMilliseconds ?? 500,
    maximumRequestBytes: 64 * 1024,
    maximumResponseBytes: input.maximumResponseBytes ?? 64 * 1024,
    maximumResponseHeaders: 32,
    maximumRequestsPerMinute: 100,
  });
}

function request(input: Partial<CompiledHttpRequest> & Pick<CompiledHttpRequest, "driverId" | "serverUrl" | "method" | "path" | "credentialAlias">): CompiledHttpRequest {
  return {
    requestId: "request_one",
    parentGoalId: "parent_one",
    workItemId: "item_one",
    targetAlias: "fictional_target",
    operationId: "reviewed_operation",
    query: {},
    headers: {},
    body: null,
    reconciliationKey: "ORDER-1",
    declarationDigest: "d".repeat(64),
    ...input,
  };
}

describe("customer-local pinned HTTPS transport", () => {
  it("executes a reviewed write and independent read through separate authenticated TLS processes", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf054-pinned-https-")); roots.push(root);
    const tls = tlsFixture(root), statePath = join(root, "state.json");
    writeFileSync(statePath, JSON.stringify({ sequence: 0, writes: 0, records: {} }), { mode: 0o600 });
    const actionToken = "action-process-token", observerToken = "observer-process-token";
    const actionProcess = await launch(root, "action", tls, statePath, actionToken), observerProcess = await launch(root, "observer", tls, statePath, observerToken);
    const action = transport({ plane: "action", serverUrl: actionProcess.serverUrl, tls, tokenAlias: "cred.action" });
    const observer = transport({ plane: "observer", serverUrl: observerProcess.serverUrl, tls, tokenAlias: "cred.observer", actionDriver: action.driverId });
    const actionResult = await action.perform(request({ driverId: action.driverId, serverUrl: action.serverUrl, method: "POST", path: "/orders", credentialAlias: "cred.action", body: { order_ref: "ORDER-1", sku: "SKU-7", quantity: 3 } }), { alias: "cred.action", value: actionToken });
    const observation = await observer.perform(request({ driverId: observer.driverId, serverUrl: observer.serverUrl, method: "GET", path: "/audit/orders", credentialAlias: "cred.observer", query: { order_ref: "ORDER-1" } }), { alias: "cred.observer", value: observerToken });
    expect(actionResult).toMatchObject({ status: 201, body: { accepted: true, sequence: 1 } });
    expect(observation).toMatchObject({ status: 200, body: { items: [{ order_ref: "ORDER-1", sku: "SKU-7", quantity: 3, status: "draft" }], collateral_clean: true } });
    expect(actionProcess.child.pid).not.toBe(observerProcess.child.pid);
    expect(readFileSync(statePath, "utf8")).not.toContain(actionToken);
    expect(readFileSync(statePath, "utf8")).not.toContain(observerToken);
    expect(JSON.stringify(action)).not.toContain(actionToken);
    expect(JSON.stringify(observer)).not.toContain(observerToken);
  });

  it("fails closed on certificate drift, redirect, oversized response, timeout, non-JSON and forbidden headers", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf054-pinned-https-negative-")); roots.push(root);
    const tls = tlsFixture(root), statePath = join(root, "state.json"), token = "negative-process-token";
    writeFileSync(statePath, JSON.stringify({ sequence: 0, writes: 0, records: {} }), { mode: 0o600 });
    const launched = await launch(root, "action", tls, statePath, token);
    const base = transport({ plane: "action", serverUrl: launched.serverUrl, tls, tokenAlias: "cred.action" });
    const operationFor = (path: string) => `${path.slice(1)}_operation`;
    const call = (path: string, current = base) => current.perform(request({ driverId: current.driverId, serverUrl: current.serverUrl, method: "POST", path, operationId: operationFor(path), credentialAlias: "cred.action" }), { alias: "cred.action", value: token });
    await expect(call("/redirect")).rejects.toThrow(/redirect/i);
    await expect(call("/oversized", transport({ plane: "action", serverUrl: launched.serverUrl, tls, tokenAlias: "cred.action", maximumResponseBytes: 1_024 }))).rejects.toThrow(/byte bound/i);
    await expect(call("/slow", transport({ plane: "action", serverUrl: launched.serverUrl, tls, tokenAlias: "cred.action", timeoutMilliseconds: 100 }))).rejects.toThrow(/timeout/i);
    await expect(call("/plain")).rejects.toThrow(/reviewed JSON/i);
    await expect(base.perform(request({ driverId: base.driverId, serverUrl: base.serverUrl, method: "POST", path: "/orders", credentialAlias: "cred.action", headers: { Authorization: "caller-controlled" } }), { alias: "cred.action", value: token })).rejects.toThrow(/forbidden header/i);
    const wrongPin = transport({ plane: "action", serverUrl: launched.serverUrl, tls, tokenAlias: "cred.action", certificateDigest: "f".repeat(64) });
    await expect(wrongPin.perform(request({ driverId: wrongPin.driverId, serverUrl: wrongPin.serverUrl, method: "POST", path: "/orders", operationId: "reviewed_operation", credentialAlias: "cred.action" }), { alias: "cred.action", value: token })).rejects.toThrow(/certificate identity/i);
  });

  it("rejects cross-server, cross-driver, cross-method, unsafe path, query and credential substitution before sending", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf054-pinned-https-boundary-")); roots.push(root);
    const tls = tlsFixture(root), statePath = join(root, "state.json"), token = "boundary-process-token";
    writeFileSync(statePath, JSON.stringify({ sequence: 0, writes: 0, records: {} }), { mode: 0o600 });
    const launched = await launch(root, "action", tls, statePath, token), action = transport({ plane: "action", serverUrl: launched.serverUrl, tls, tokenAlias: "cred.action" });
    const base = request({ driverId: action.driverId, serverUrl: action.serverUrl, method: "POST", path: "/orders", credentialAlias: "cred.action", body: { order_ref: "ORDER-1", sku: "SKU-7", quantity: 3 } });
    await expect(action.perform({ ...base, serverUrl: "https://localhost:1/v1" }, { alias: "cred.action", value: token })).rejects.toThrow(/transport identity/i);
    await expect(action.perform({ ...base, driverId: "other_driver" }, { alias: "cred.action", value: token })).rejects.toThrow(/transport identity/i);
    await expect(action.perform({ ...base, method: "DELETE" }, { alias: "cred.action", value: token })).rejects.toThrow(/method/i);
    await expect(action.perform({ ...base, path: "/../escape" }, { alias: "cred.action", value: token })).rejects.toThrow(/path/i);
    await expect(action.perform({ ...base, path: "/%2e%2e/escape" }, { alias: "cred.action", value: token })).rejects.toThrow(/path|operation/i);
    await expect(action.perform({ ...base, query: { "bad key": "value" } }, { alias: "cred.action", value: token })).rejects.toThrow(/query/i);
    await expect(action.perform(base, { alias: "cred.other", value: token })).rejects.toThrow(/credential/i);
    await expect(action.perform(base, { alias: "cred.action", value: "bad\r\ntoken" })).rejects.toThrow(/credential/i);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ writes: 0, records: {} });
  });

  it("rejects accessors, proxies, serialization hooks and over-rate requests without a write", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf054-pinned-https-hostile-input-")); roots.push(root);
    const tls = tlsFixture(root), statePath = join(root, "state.json"), token = "hostile-process-token";
    writeFileSync(statePath, JSON.stringify({ sequence: 0, writes: 0, records: {} }), { mode: 0o600 });
    const launched = await launch(root, "action", tls, statePath, token), action = createCustomerLocalPinnedHttpsTransport({ driverId: "action_driver", sourceId: "action_source", serverUrl: launched.serverUrl, supportedMethods: ["POST"], independentlyAuthenticated: false, independentFromDriverIds: [], credentialAlias: "cred.action", reviewedOperations: [{ operationId: "reviewed_operation", method: "POST", pathTemplate: "/orders", declarationDigest: "d".repeat(64) }], authorizationScheme: "Bearer", caCertificatePem: tls.certificatePem, serverCertificateSha256: tls.certificateDigest, timeoutMilliseconds: 500, maximumRequestBytes: 64 * 1024, maximumResponseBytes: 64 * 1024, maximumResponseHeaders: 32, maximumRequestsPerMinute: 1 });
    const base = request({ driverId: action.driverId, serverUrl: action.serverUrl, method: "POST", path: "/orders", credentialAlias: "cred.action", body: { order_ref: "ORDER-1", sku: "SKU-7", quantity: 3 } });
    const accessorBody: Record<string, unknown> = { order_ref: "ORDER-2", sku: "SKU-7" }; Object.defineProperty(accessorBody, "quantity", { enumerable: true, get: () => 3 });
    await expect(action.perform({ ...base, body: accessorBody }, { alias: "cred.action", value: token })).rejects.toThrow(/accessor/i);
    await expect(action.perform({ ...base, body: new Proxy(base.body!, {}) }, { alias: "cred.action", value: token })).rejects.toThrow(/plain bounded JSON/i);
    await expect(action.perform({ ...base, body: { ...base.body, toJSON: () => ({}) } }, { alias: "cred.action", value: token })).rejects.toThrow(/serialization hooks/i);
    await expect(action.perform(base, { alias: "cred.action", value: token })).resolves.toMatchObject({ status: 201 });
    await expect(action.perform({ ...base, body: { order_ref: "ORDER-2", sku: "SKU-7", quantity: 3 } }, { alias: "cred.action", value: token })).rejects.toThrow(/rate bound/i);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ writes: 1 });
  });

  it("snapshots the qualified config so caller mutation cannot widen behavior or replace TLS identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf054-pinned-https-config-mutation-")); roots.push(root);
    const tls = tlsFixture(root), statePath = join(root, "state.json"), token = "mutation-process-token";
    writeFileSync(statePath, JSON.stringify({ sequence: 0, writes: 0, records: {} }), { mode: 0o600 });
    const launched = await launch(root, "action", tls, statePath, token);
    const config: CustomerLocalPinnedHttpsTransportConfig = { driverId: "action_driver", sourceId: "action_source", serverUrl: launched.serverUrl, supportedMethods: ["POST"], independentlyAuthenticated: false, independentFromDriverIds: [], credentialAlias: "cred.action", reviewedOperations: [{ operationId: "reviewed_operation", method: "POST", pathTemplate: "/orders", declarationDigest: "d".repeat(64) }], authorizationScheme: "Bearer", caCertificatePem: tls.certificatePem, serverCertificateSha256: tls.certificateDigest, timeoutMilliseconds: 500, maximumRequestBytes: 64 * 1024, maximumResponseBytes: 64 * 1024, maximumResponseHeaders: 32, maximumRequestsPerMinute: 10 };
    const action = createCustomerLocalPinnedHttpsTransport(config), originalDigest = action.implementationDigest;
    config.supportedMethods.push("DELETE");
    config.reviewedOperations.push({ operationId: "deleteOrder", method: "DELETE", pathTemplate: "/orders", declarationDigest: "e".repeat(64) });
    config.credentialAlias = "cred.attacker";
    config.caCertificatePem = "-----BEGIN CERTIFICATE-----\nattacker\n-----END CERTIFICATE-----";
    config.serverCertificateSha256 = "f".repeat(64);
    config.maximumResponseBytes = 1;
    expect(action.implementationDigest).toBe(originalDigest);
    expect(action.supportedMethods).toEqual(["POST"]);
    expect(() => action.supportedMethods.push("DELETE")).toThrow();
    expect(() => action.independentFromDriverIds.push("attacker_driver")).toThrow();
    await expect(action.perform(request({ driverId: action.driverId, serverUrl: action.serverUrl, method: "DELETE", path: "/orders", operationId: "deleteOrder", declarationDigest: "e".repeat(64), credentialAlias: "cred.attacker" }), { alias: "cred.attacker", value: token })).rejects.toThrow(/transport identity|reviewed operation|credential/i);
    await expect(action.perform(request({ driverId: action.driverId, serverUrl: action.serverUrl, method: "POST", path: "/orders", operationId: "reviewed_operation", credentialAlias: "cred.action", body: { order_ref: "ORDER-1", sku: "SKU-7", quantity: 3 } }), { alias: "cred.action", value: token })).resolves.toMatchObject({ status: 201 });
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ writes: 1 });
  });
});
