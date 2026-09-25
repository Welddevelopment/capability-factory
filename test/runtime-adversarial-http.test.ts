import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createManualProcurementManifest } from "../src/manual-manifest.js";
import { RotatingMemorySecretProvider } from "../src/product/secrets.js";
import { CapabilityRuntime } from "../src/runtime.js";
import { developmentScenario } from "../src/scenario.js";
import { TraceWriter } from "../src/trace.js";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const scenario = developmentScenario();
  const manifest = createManualProcurementManifest(scenario, { openapi: "3.1.0" });
  const input = {
    requiredMinTempC: -18,
    requiredMaxTempC: -14,
    deliverBy: scenario.shipments[0]!.arrivalAt,
  };
  return { scenario, manifest, input };
}

describe("adversarial constrained HTTP runtime", () => {
  it("encodes path inputs and preserves the approved origin without injected query or fragment data", async () => {
    const { scenario, manifest, input } = fixture();
    manifest.actions[0]!.request.pathTemplate = "/objects/{{input.deliverBy}}";
    let requested: URL | undefined;
    vi.stubGlobal("fetch", (url: URL) => {
      requested = url;
      return Promise.resolve(new Response(JSON.stringify({ products: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    });
    const runtime = new CapabilityRuntime({
      targets: { procurement: { baseUrl: "http://127.0.0.1:65530", allowedPaths: ["/objects/:value", scenario.contract.orderPath] } },
      secrets: { [scenario.credential.secretAlias]: scenario.credential.secretValue },
    });
    await runtime.execute(manifest, "search_equipment", { ...input, deliverBy: "//attacker.invalid/path?stolen=yes#fragment" }, { runId: "path-boundary" });
    expect(requested?.origin).toBe("http://127.0.0.1:65530");
    expect(requested?.pathname).toContain("%2F%2Fattacker.invalid%2Fpath%3Fstolen%3Dyes%23fragment");
    expect(requested?.search).not.toContain("stolen=yes");
    expect(requested?.hash).toBe("");
  });

  it("rejects query, fragment, backslash, and credential-bearing target syntax before fetch", () => {
    const { scenario, manifest } = fixture();
    const runtime = new CapabilityRuntime({
      targets: { procurement: { baseUrl: "http://127.0.0.1:65530", allowedPaths: ["/catalog", scenario.contract.orderPath] } },
      secrets: { [scenario.credential.secretAlias]: scenario.credential.secretValue },
    });
    manifest.actions[0]!.request.pathTemplate = "/catalog?unexpected=true";
    expect(() => runtime.validateManifest(manifest)).toThrow(/must not contain a query/i);
    manifest.actions[0]!.request.pathTemplate = "/catalog\\escape";
    expect(() => runtime.validateManifest(manifest)).toThrow(/backslash/i);
    const credentialTarget = new CapabilityRuntime({
      targets: { procurement: { baseUrl: "http://user:password@127.0.0.1:65530", allowedPaths: ["/catalog", scenario.contract.orderPath] } },
      secrets: { [scenario.credential.secretAlias]: scenario.credential.secretValue },
    });
    manifest.actions[0]!.request.pathTemplate = "/catalog";
    expect(() => credentialTarget.validateManifest(manifest)).toThrow(/cannot contain credentials/i);
  });

  it("cancels a streaming response as soon as the declared byte ceiling is crossed", async () => {
    const { scenario, manifest, input } = fixture();
    manifest.actions[0]!.safety.maxResponseBytes = 10;
    let cancelled = false;
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("12345678901")); },
      cancel() { cancelled = true; },
    }), { status: 200 })));
    const runtime = new CapabilityRuntime({
      targets: { procurement: { baseUrl: "http://127.0.0.1:65530", allowedPaths: [scenario.contract.catalogPath, scenario.contract.orderPath] } },
      secrets: { [scenario.credential.secretAlias]: scenario.credential.secretValue },
    });
    await expect(runtime.execute(manifest, "search_equipment", input, { runId: "stream-limit" }))
      .rejects.toMatchObject({ category: "response_size" });
    expect(cancelled).toBe(true);
  });

  it("treats malformed JSON and missing declared outputs as unknown rather than successful", async () => {
    const { scenario, manifest, input } = fixture();
    const runtime = new CapabilityRuntime({
      targets: { procurement: { baseUrl: "http://127.0.0.1:65530", allowedPaths: [scenario.contract.catalogPath, scenario.contract.orderPath] } },
      secrets: { [scenario.credential.secretAlias]: scenario.credential.secretValue },
    });
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("{not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    await expect(runtime.execute(manifest, "search_equipment", input, { runId: "malformed-json" }))
      .rejects.toMatchObject({ category: "response_parse" });

    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify({ different: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    await expect(runtime.execute(manifest, "search_equipment", input, { runId: "missing-output" }))
      .rejects.toMatchObject({ category: "response_schema" });
  });

  it("redacts a customer-local credential even when the target API echoes it under a non-sensitive key", async () => {
    const { scenario, manifest, input } = fixture();
    const secretValue = "customer-local-echo-secret-value";
    const provider = new RotatingMemorySecretProvider();
    provider.set({
      alias: scenario.credential.secretAlias,
      version: "rotation-1",
      scope: { targetAliases: ["procurement"], actionNames: ["search_equipment"], methods: ["GET"] },
    }, secretValue);
    const traceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cf-http-redaction-"));
    try {
      const trace = new TraceWriter("echo-redaction", traceDirectory);
      const runtime = new CapabilityRuntime({
        targets: { procurement: { baseUrl: "http://127.0.0.1:65530", allowedPaths: [scenario.contract.catalogPath, scenario.contract.orderPath] } },
        secrets: {},
        secretProvider: provider,
      }, trace);
      vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify({ products: [secretValue] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })));
      const result = await runtime.execute(manifest, "search_equipment", input, { runId: "echo-redaction" });
      expect(result.output.products).toEqual(["[REDACTED]"]);
      expect(JSON.stringify(result.raw)).not.toContain(secretValue);
      expect(fs.readFileSync(trace.filename, "utf8")).not.toContain(secretValue);
    } finally {
      fs.rmSync(traceDirectory, { recursive: true, force: true });
    }
  });

  it("classifies authentication and rate-limit responses precisely without retrying", async () => {
    const { scenario, manifest, input } = fixture();
    const runtime = new CapabilityRuntime({
      targets: { procurement: { baseUrl: "http://127.0.0.1:65530", allowedPaths: [scenario.contract.catalogPath, scenario.contract.orderPath] } },
      secrets: { [scenario.credential.secretAlias]: scenario.credential.secretValue },
    });
    let calls = 0;
    vi.stubGlobal("fetch", () => {
      calls += 1;
      return Promise.resolve(new Response(JSON.stringify({ error: "expired" }), { status: 401 }));
    });
    await expect(runtime.execute(manifest, "search_equipment", input, { runId: "expired" }))
      .rejects.toMatchObject({ category: "credential", status: 401 });
    expect(calls).toBe(1);
    vi.stubGlobal("fetch", () => {
      calls += 1;
      return Promise.resolve(new Response(JSON.stringify({ error: "slow down" }), {
        status: 429,
        headers: { "retry-after": "60" },
      }));
    });
    await expect(runtime.execute(manifest, "search_equipment", input, { runId: "rate-limit" }))
      .rejects.toMatchObject({ category: "rate_limit", status: 429 });
    expect(calls).toBe(2);
  });
});
