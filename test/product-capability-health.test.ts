import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityManifest } from "../src/manifest.js";
import { CapabilityHealthLedger, CapabilityHealthMonitor } from "../src/product/capability-health.js";
import { manifestDigest } from "../src/product/coordinator.js";
import type { VerificationReceipt } from "../src/product/contracts.js";
import { FileTenantCapabilityStore, type VerifiedCapabilityRecord } from "../src/product/store.js";

const roots: string[] = [];
function root(): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), "cf-health-")); roots.push(value); return value; }
afterEach(() => { for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true }); });

function manifest(id: string, version: string, documentationHash: string): CapabilityManifest {
  return {
    schemaVersion: "1", id, version, service: "Fictional customer system", description: "Reads one bounded record.",
    baseUrlAlias: "customer_system", auth: { kind: "apiKey", secretAlias: "customer_key", headerName: "x-api-key" },
    actions: [{ name: "read_record", description: "Read one record.", inputSchema: { type: "object", properties: { recordId: { type: "string", description: "Record identifier." } }, required: ["recordId"], additionalProperties: false },
      request: { method: "GET", pathTemplate: "/records/{recordId}", queryTemplate: {}, headerTemplate: {}, bodyTemplate: null },
      response: { acceptedStatuses: [200], outputPointers: { recordId: "/id" } }, safety: { idempotency: "none", timeoutMs: 1_000, maxResponseBytes: 10_000 } }],
    provenance: { documentationHash, model: "deterministic-test", createdAt: "2026-07-29T00:00:00.000Z" },
  };
}

function verification(value: CapabilityManifest, passed = true): VerificationReceipt {
  return { verifierVersion: "health-test-1", manifestDigest: manifestDigest(value), documentationHash: value.provenance.documentationHash,
    passed, checks: [{ id: "direct-probe", passed, detail: passed ? "Direct probe passed." : "Direct probe failed." }], verifiedAt: "2026-07-29T00:01:00.000Z" };
}

function record(id = "customer-reader", version = "1.0.0", documentationHash = "a".repeat(64)): VerifiedCapabilityRecord {
  const value = manifest(id, version, documentationHash);
  return { tenantId: "tenant-one", needKey: "read-customer-record", manifest: value, verification: verification(value), origin: "built", status: "active", registeredAt: "2026-07-29T00:01:00.000Z", reuseCount: 0 };
}

function fixture(options: { observedHash?: string; probePassed?: boolean } = {}) {
  const directory = root(); const store = new FileTenantCapabilityStore(path.join(directory, "registry")); const ledger = new CapabilityHealthLedger(path.join(directory, "health.sqlite"));
  const monitor = new CapabilityHealthMonitor({ store, ledger,
    documentation: { currentHash: async () => options.observedHash ?? "a".repeat(64) },
    probe: { verify: async (candidate) => verification(candidate.manifest, options.probePassed ?? true) } });
  return { store, ledger, monitor };
}

describe("retained capability health and drift", () => {
  it("keeps a directly reverified capability active and shows dependent workflows", async () => {
    const { store, ledger, monitor } = fixture(); const candidate = record(); store.register(candidate);
    ledger.registerDependency("tenant-one", candidate.manifest.id, "daily-order-sync"); ledger.registerDependency("tenant-one", candidate.manifest.id, "support-lookup");
    const run = await monitor.runOnce("tenant-one");
    expect(run).toMatchObject({ checked: 1, healthy: 1, quarantined: 0 });
    expect(run.assessments[0]?.dependentWorkflows).toEqual(["daily-order-sync", "support-lookup"]);
    expect(store.list("tenant-one")[0]?.status).toBe("active"); ledger.close();
  });

  it("quarantines documentation drift before future reuse", async () => {
    const { store, ledger, monitor } = fixture({ observedHash: "b".repeat(64) }); store.register(record());
    const run = await monitor.runOnce("tenant-one");
    expect(run.assessments[0]).toMatchObject({ status: "quarantined", reason: "documentation-drift" });
    expect(store.list("tenant-one")[0]?.status).toBe("quarantined"); ledger.close();
  });

  it("quarantines a capability whose independent probe no longer passes", async () => {
    const { store, ledger, monitor } = fixture({ probePassed: false }); store.register(record());
    expect((await monitor.runOnce("tenant-one")).assessments[0]).toMatchObject({ reason: "verification-failed" });
    expect(ledger.history("tenant-one", "customer-reader")).toHaveLength(1); ledger.close();
  });

  it("activates only a newer independently verified replacement and carries dependency visibility forward", async () => {
    const { store, ledger, monitor } = fixture(); const prior = record(); store.register(prior); ledger.registerDependency("tenant-one", prior.manifest.id, "daily-order-sync");
    await expect(monitor.activateVerifiedReplacement("tenant-one", prior.manifest.id, record("customer-reader-v2", "1.0.0"))).rejects.toThrow(/greater semantic version/);
    const replacement = record("customer-reader-v2", "1.1.0"); await monitor.activateVerifiedReplacement("tenant-one", prior.manifest.id, replacement);
    expect(store.list("tenant-one").map((item) => [item.manifest.id, item.status])).toEqual([["customer-reader", "quarantined"], ["customer-reader-v2", "active"]]);
    expect(ledger.dependencies("tenant-one", "customer-reader-v2")).toEqual(["daily-order-sync"]); ledger.close();
  });
});

