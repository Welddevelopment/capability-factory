import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DisposableBrowserPortal } from "../src/customer-world/browser-portal.js";
import {
  ExperimentalBrowserCapabilitySdk,
  StaticTrustedBrowserCapabilitySource,
} from "../src/experimental/browser-capability-sdk.js";
import { BrowserDiscoveryGoalRunner } from "../src/experimental/browser-discovery-sdk.js";
import { ConservativeHeuristicBrowserDiscoveryPlanner } from "../src/experimental/browser-discovery-planner.js";
import type { BrowserDiscoveryBoundary } from "../src/experimental/browser-discovery.js";
import { ExperimentalBrowserDriver } from "../src/experimental/browser-driver.js";
import { PlaywrightBrowserDiscoverer } from "../src/experimental/playwright-browser-discovery.js";
import { FileBrowserCapabilityRegistry } from "../src/experimental/browser-registry.js";
import { PlaywrightBrowserSessionFactory } from "../src/experimental/playwright-browser-session.js";
import { RotatingMemorySecretProvider } from "../src/product/secrets.js";

const enabled = process.env.CF_REAL_BROWSER === "1";
const testIfEnabled = enabled ? it : it.skip;
const PORTAL_KEY = "browser-discovery-local-secret";
const portals: DisposableBrowserPortal[] = [];

afterEach(async () => {
  await Promise.all(portals.splice(0).map((portal) => portal.close()));
});

function boundary(): BrowserDiscoveryBoundary {
  return {
    schemaVersion: "1.0",
    boundaryId: "dealer-restock-discovery-v1",
    capabilityIdPrefix: "discovered-dealer-restock",
    needKey: "create-dealer-restock-request",
    targetAlias: "dealer_portal",
    outcomeVerifierKey: "dealer-portal-direct-db-v1",
    seedPaths: ["/portal/home", "/portal/orders", "/portal/orders/new"],
    allowedPaths: ["/portal/home", "/portal/orders", "/portal/orders/new"],
    inputs: [
      { key: "operationKey", description: "Unique operation key used for duplicate-safe reconciliation." },
      { key: "reference", description: "Stock reference for the approved restock request." },
      { key: "quantity", description: "Quantity or units needed for restocking." },
    ],
    secretAliases: ["dealer_portal_key"],
    writeApprovalKey: "create-restock-request",
    maxBusinessWrites: 1,
    completion: {
      kind: "exact-text",
      description: "Submission status confirmation shown after the request is created.",
      expectedText: "Created",
    },
    authentication: { kind: "none", humanGatePolicy: "stop-and-handoff" },
  };
}

async function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-browser-discovery-"));
  const portal = new DisposableBrowserPortal(path.join(root, "portal.sqlite"), PORTAL_KEY);
  await portal.start();
  portals.push(portal);
  const registry = new FileBrowserCapabilityRegistry(path.join(root, "registry"));
  const secrets = new RotatingMemorySecretProvider();
  secrets.set({
    alias: "dealer_portal_key",
    version: "discovery-v1",
    scope: {
      targetAliases: ["dealer_portal"],
      actionNames: ["browser-write"],
      methods: ["BROWSER"],
    },
  }, PORTAL_KEY);
  const target = portal.discoveryTarget();
  const runner = new BrowserDiscoveryGoalRunner(
    target,
    boundary(),
    new PlaywrightBrowserDiscoverer(),
    new ConservativeHeuristicBrowserDiscoveryPlanner(),
    registry,
    ({ target: effectiveTarget, builder }) => new ExperimentalBrowserCapabilitySdk({
      driver: new ExperimentalBrowserDriver({ dealer_portal: effectiveTarget }, new PlaywrightBrowserSessionFactory()),
      registry,
      trustedSource: new StaticTrustedBrowserCapabilitySource("empty-discovery-catalog", []),
      builder,
      outcomeVerifier: (request) => portal.verifier({
        operationKey: request.operationKey,
        reference: request.input.reference!,
        quantity: Number(request.input.quantity),
      }),
      secretProvider: secrets,
    }),
  );
  const request = (suffix: string) => ({
    tenantId: "browser-discovery-tenant",
    requestId: `browser-discovery-request-${suffix}`,
    parentGoalId: `browser-discovery-parent-${suffix}`,
    ordinaryGoal: "Review the approved restock work, create the required request, verify it, and continue the inventory goal.",
    needKey: "create-dealer-restock-request",
    operationKey: `browser-discovery-operation-${suffix}`,
    input: {
      operationKey: `browser-discovery-operation-${suffix}`,
      reference: `DISCOVERED-${suffix.toUpperCase()}`,
      quantity: "4",
    },
    approvals: ["create-restock-request"],
  });
  return { portal, registry, runner, request };
}

describe("trusted browser UI discovery, drift repair and handoff", () => {
  testIfEnabled("discovers a three-page route, constructs once, verifies, resumes and reuses", async () => {
    const current = await world();
    const first = await current.runner.completeGoal(current.request("first"));
    expect(first).toMatchObject({
      status: "completed",
      snapshot: { pages: [{ finalPath: "/portal/home" }, { finalPath: "/portal/orders" }, { finalPath: "/portal/orders/new" }], humanGates: [] },
      drift: [],
      capability: { status: "completed", path: "built-capability", parent: { resumed: true } },
    });
    const second = await current.runner.completeGoal(current.request("second"));
    expect(second).toMatchObject({
      status: "completed",
      drift: [],
      capability: { status: "completed", path: "retained-capability" },
    });
    if (!first.snapshot) throw new Error("Completed discovery result must include its trusted snapshot.");
    expect(current.portal.count()).toBe(2);
    expect(current.registry.list("browser-discovery-tenant")).toEqual([
      expect.objectContaining({ status: "active", reuseCount: 1, discoverySnapshotHash: first.snapshot.snapshotHash }),
    ]);
  }, 120_000);

  testIfEnabled("detects repairable UI drift, quarantines the old evidence, builds a versioned replacement and reuses it", async () => {
    const current = await world();
    const initial = await current.runner.completeGoal(current.request("before-drift"));
    expect(initial.status).toBe("completed");
    current.portal.setMode("ui-drift-repairable");
    const repaired = await current.runner.completeGoal(current.request("after-drift"));
    expect(repaired).toMatchObject({
      status: "completed",
      drift: [expect.objectContaining({ capabilityId: expect.any(String), reason: expect.stringContaining("snapshot changed") })],
      capability: { status: "completed", path: "built-capability" },
    });
    if (!initial.snapshot || !repaired.snapshot) throw new Error("Completed drift results must include trusted snapshots.");
    expect(repaired.snapshot.snapshotHash).not.toBe(initial.snapshot.snapshotHash);
    const reused = await current.runner.completeGoal(current.request("after-drift-reuse"));
    expect(reused).toMatchObject({ status: "completed", drift: [], capability: { path: "retained-capability" } });
    const records = current.registry.list("browser-discovery-tenant");
    expect(records).toHaveLength(2);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "quarantined", statusReason: expect.stringContaining("snapshot changed") }),
      expect.objectContaining({ status: "active", supersedesCapabilityId: repaired.drift[0]?.capabilityId, reuseCount: 1 }),
    ]));
    expect(current.portal.count()).toBe(3);
  }, 120_000);

  testIfEnabled("stops on an MFA gate before planning, capability registration or business action", async () => {
    const current = await world();
    current.portal.setMode("mfa-gate");
    const result = await current.runner.completeGoal(current.request("mfa"));
    expect(result).toMatchObject({
      status: "blocked",
      handoff: { reason: "human-authentication-required", writesAttempted: 0 },
    });
    expect(result.snapshot?.humanGates.some((gate) => gate.signal === "mfa")).toBe(true);
    expect(current.registry.list("browser-discovery-tenant")).toEqual([]);
    expect(current.portal.count()).toBe(0);
  }, 120_000);

  testIfEnabled("blocks a page that attempts a business write during read-only discovery", async () => {
    const current = await world();
    current.portal.setMode("write-during-verification");
    await expect(current.runner.completeGoal(current.request("write-during-discovery")))
      .rejects.toThrow(/Read-only browser discovery blocked a request/);
    expect(current.registry.list("browser-discovery-tenant")).toEqual([]);
    expect(current.portal.count()).toBe(0);
  }, 120_000);
});
