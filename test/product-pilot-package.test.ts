import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPilotPackageSidecar, PilotPackageManager } from "../src/product/pilot-package.js";
import { REQUIRED_PILOT_ADAPTER_CASES, type ControlledPilotAdapter } from "../src/product/pilot-adapter.js";

const temporaryDirectories: string[] = [];
function temporaryDirectory(): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), "cf-pilot-package-")); temporaryDirectories.push(value); return value; }
function runtimeFile(root: string): string { const filename = path.join(root, "runtime.mjs"); fs.writeFileSync(filename, "export const createPilotRuntime = () => undefined;\n", { mode: 0o600 }); return filename; }
function managerFor(root: string): PilotPackageManager { return new PilotPackageManager(root, { portProbe: async () => true }); }
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe("customer-local pilot package", () => {
  it("initializes private secrets, pins the runtime, and passes readiness without exposing secrets", async () => {
    const fixture = temporaryDirectory(); const manager = managerFor(path.join(fixture, "installation"));
    const config = manager.initialize({ installationId: "pilot-one", tenantId: "customer_one", productVersion: "0.1.0", adapterRuntimePath: runtimeFile(fixture), port: 43171 });
    const token = manager.readAccessTokenForLocalClient(); const continuation = manager.readContinuationSecretForLocalRuntime();
    expect(token.length).toBeGreaterThanOrEqual(32); expect(continuation.length).toBeGreaterThanOrEqual(32);
    expect(JSON.stringify(config)).not.toContain(token); expect(fs.statSync(manager.resolve(config.files.accessToken)).mode & 0o077).toBe(0);
    const readiness = await manager.readiness(); expect(readiness.ready).toBe(true);
    expect(JSON.stringify(readiness)).not.toContain(token); expect(JSON.stringify(readiness)).not.toContain(continuation);
  });
  it("fails readiness when pinned runtime bytes change or a secret becomes group-readable", async () => {
    const fixture = temporaryDirectory(); const manager = managerFor(path.join(fixture, "installation"));
    const config = manager.initialize({ installationId: "pilot-two", tenantId: "customer_two", productVersion: "0.1.0", adapterRuntimePath: runtimeFile(fixture), port: 43172 });
    fs.appendFileSync(manager.resolve(config.adapterRuntime.path), "// tampered\n"); fs.chmodSync(manager.resolve(config.files.accessToken), 0o640);
    const readiness = await manager.readiness(); expect(readiness.ready).toBe(false);
    expect(readiness.checks.find((item) => item.id === "adapter-runtime")?.passed).toBe(false);
    expect(readiness.checks.find((item) => item.id === "access-token")?.passed).toBe(false);
  });
  it("creates an immutable sanitized evidence export", async () => {
    const fixture = temporaryDirectory(); const manager = managerFor(path.join(fixture, "installation"));
    const config = manager.initialize({ installationId: "pilot-three", tenantId: "customer_three", productVersion: "0.1.0", adapterRuntimePath: runtimeFile(fixture), port: 43173 });
    const token = manager.readAccessTokenForLocalClient(); const reportPath = path.join(fixture, "report.json");
    fs.writeFileSync(reportPath, JSON.stringify({ status: "passed", authorization: `Bearer ${token}`, nested: { apiKey: token } }));
    const outputPath = path.join(fixture, "evidence.json"); const exported = await manager.exportEvidence({ reportPath, outputPath });
    const serialized = fs.readFileSync(outputPath, "utf8"); expect(serialized).not.toContain(token);
    expect(exported.suppliedReportSha256).toMatch(/^[a-f0-9]{64}$/); expect(exported.package.adapterRuntimeSha256).toBe(config.adapterRuntime.sha256);
    await expect(manager.exportEvidence({ reportPath, outputPath })).rejects.toThrow(/immutable/i);
  });
  it("exports an immutable support bundle without secrets or customer payloads", async () => {
    const fixture = temporaryDirectory(); const manager = managerFor(path.join(fixture, "installation"));
    manager.initialize({ installationId: "pilot-support", tenantId: "customer_support", productVersion: "0.1.0", adapterRuntimePath: runtimeFile(fixture), port: 43176 });
    const token = manager.readAccessTokenForLocalClient(); const continuation = manager.readContinuationSecretForLocalRuntime();
    const outputPath = path.join(fixture, "support.json"); const bundle = await manager.exportSupportBundle(outputPath);
    const serialized = fs.readFileSync(outputPath, "utf8");
    expect(serialized).not.toContain(token); expect(serialized).not.toContain(continuation);
    expect(bundle.guarantees).toEqual({ secretValuesIncluded: false, customerPayloadsIncluded: false, immutableOutput: true });
    expect(bundle.storage.map((entry) => entry.role)).toEqual(expect.arrayContaining(["goal-jobs", "validated-plans"]));
    await expect(manager.exportSupportBundle(outputPath)).rejects.toThrow(/immutable/i);
  });
  it("will not overwrite an existing path", () => {
    const fixture = temporaryDirectory(); const root = path.join(fixture, "installation"); fs.mkdirSync(root);
    expect(() => new PilotPackageManager(root).initialize({ installationId: "pilot-four", tenantId: "customer_four", productVersion: "0.1.0", adapterRuntimePath: runtimeFile(fixture) })).toThrow(/will not overwrite/i);
  });

  it("assembles the validated adapter, durable queue, and authenticated sidecar without manual wiring", async () => {
    const fixture = temporaryDirectory(); const manager = managerFor(path.join(fixture, "installation"));
    manager.initialize({ installationId: "pilot-five", tenantId: "customer_five", productVersion: "0.1.0", adapterRuntimePath: runtimeFile(fixture), port: 43175 });
    const adapter: ControlledPilotAdapter = {
      descriptor: {
        schemaVersion: "1.0", adapterId: "customer_five_adapter", adapterVersion: "1.0.0",
        capabilityMode: "constrained-http-api", environmentId: "customer_five_local",
        scopeKeys: ["customer_five_scope"], workflowKeys: ["customer_five_workflow"],
        targetAliases: ["customer_system"], credentialAliases: ["customer_key"],
        documentation: [{ targetAlias: "customer_system", sha256: "a".repeat(64) }],
        operations: [{ name: "read_customer_state", targetAlias: "customer_system", method: "GET", consequence: "read", retrySafety: "not-applicable", outcomeVerifierKey: "verify_customer_state" }],
        acceptanceCases: [...REQUIRED_PILOT_ADAPTER_CASES],
        dataBoundary: { execution: "customer-local", credentials: "customer-local-alias-only", externalVerification: "customer-local-independent" },
      },
      scopes: { resolve: async () => undefined },
      runtimes: { open: async () => undefined },
      preflight: async () => [{ id: "fixture-ready", passed: true, detail: "Fixture is ready." }],
    };
    const built = await buildPilotPackageSidecar(manager, async (context) => {
      expect(context.tenantId).toBe("customer_five"); expect(context.operations.mode()).toBe("running");
      return { adapter, planner: { propose: async () => { throw new Error("Planner must not run during readiness."); } } };
    });
    const response = await built.app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ status: "ready" });
    await built.close();
  });
});
