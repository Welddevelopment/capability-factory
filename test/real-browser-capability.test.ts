import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BROWSER_PORTAL_UI_CONTRACT,
  BROWSER_PORTAL_UI_CONTRACT_HASH,
  DisposableBrowserPortal,
  trustedBrowserPortalCapability,
  type BrowserPortalMode,
} from "../src/customer-world/browser-portal.js";
import {
  ExperimentalBrowserCapabilitySdk,
  StaticTrustedBrowserCapabilitySource,
  type BrowserCapabilityGoalRequest,
} from "../src/experimental/browser-capability-sdk.js";
import { ExperimentalBrowserDriver } from "../src/experimental/browser-driver.js";
import { PlaywrightBrowserSessionFactory } from "../src/experimental/playwright-browser-session.js";
import { FileBrowserCapabilityRegistry } from "../src/experimental/browser-registry.js";
import { TrustedUiContractBrowserCapabilityBuilder } from "../src/experimental/browser-ui-contract.js";
import { CustomerLocalOperationalControl } from "../src/product/operations.js";
import { RotatingMemorySecretProvider } from "../src/product/secrets.js";

const runRealBrowser = process.env.CF_REAL_BROWSER === "1";
const PORTAL_KEY = "local-browser-secret-value";
const activeWorlds: BrowserWorld[] = [];

interface BrowserWorld {
  directory: string;
  portal: DisposableBrowserPortal;
  registry: FileBrowserCapabilityRegistry;
  secrets: RotatingMemorySecretProvider;
  operations: CustomerLocalOperationalControl;
  sdk(withSecrets?: boolean, acquisition?: "trusted" | "built"): ExperimentalBrowserCapabilitySdk;
  request(operationKey: string, suffix?: string): BrowserCapabilityGoalRequest;
  close(): Promise<void>;
}

async function createWorld(mode: BrowserPortalMode = "normal", tenantId = "browser-tenant"): Promise<BrowserWorld> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cf-real-browser-"));
  const portal = new DisposableBrowserPortal(path.join(directory, "portal.sqlite"), PORTAL_KEY);
  await portal.start();
  portal.setMode(mode);
  const registry = new FileBrowserCapabilityRegistry(path.join(directory, "registry"));
  const secrets = new RotatingMemorySecretProvider();
  secrets.set({
    alias: "dealer_portal_key",
    version: "local-v1",
    scope: {
      targetAliases: ["dealer_portal"],
      actionNames: ["browser-write"],
      methods: ["BROWSER"],
    },
  }, PORTAL_KEY);
  const operations = new CustomerLocalOperationalControl(path.join(directory, "operations.sqlite"), tenantId, {
    maxWriteAttemptsPerRun: 1,
    maxWriteAttemptsPerHour: 50,
    maxModelSpendUsdPerDay: 1,
  });
  const sdk = (withSecrets = true, acquisition: "trusted" | "built" = "trusted") => new ExperimentalBrowserCapabilitySdk({
    driver: new ExperimentalBrowserDriver({ dealer_portal: portal.target() }, new PlaywrightBrowserSessionFactory()),
    registry: new FileBrowserCapabilityRegistry(path.join(directory, "registry")),
    trustedSource: new StaticTrustedBrowserCapabilitySource(
      "local-reviewed-catalog-v1",
      acquisition === "trusted" ? [trustedBrowserPortalCapability()] : [],
    ),
    ...(acquisition === "built"
      ? { builder: new TrustedUiContractBrowserCapabilityBuilder("trusted-ui-contract-builder-v1", [BROWSER_PORTAL_UI_CONTRACT]) }
      : {}),
    outcomeVerifier: (request) => portal.verifier({
      operationKey: request.operationKey,
      reference: request.input.reference!,
      quantity: Number(request.input.quantity),
    }),
    ...(withSecrets ? { secretProvider: secrets } : {}),
    operationalControl: operations,
  });
  const request = (operationKey: string, suffix = operationKey): BrowserCapabilityGoalRequest => ({
    tenantId,
    requestId: `request-${suffix}`,
    parentGoalId: `parent-${suffix}`,
    ordinaryGoal: `Create the approved dealer restock request ${suffix} and continue the original inventory goal.`,
    needKey: "create-dealer-restock-request",
    uiContractHash: BROWSER_PORTAL_UI_CONTRACT_HASH,
    operationKey,
    input: { operationKey, reference: `RESTOCK-${suffix}`, quantity: "3" },
    approvals: ["create-restock-request"],
  });
  const world: BrowserWorld = {
    directory,
    portal,
    registry,
    secrets,
    operations,
    sdk,
    request,
    close: async () => {
      operations.close();
      await portal.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
  activeWorlds.push(world);
  return world;
}

afterEach(async () => {
  while (activeWorlds.length > 0) await activeWorlds.pop()!.close();
});

describe.skipIf(!runRealBrowser)("real Chromium browser capability", () => {
  it("constructs the unsupported residual from a trusted UI contract and then retains it", async () => {
    const world = await createWorld();
    const first = await world.sdk(true, "built").completeGoal(world.request("operation-built", "built"));
    expect(first).toMatchObject({
      status: "completed",
      path: "built-capability",
      parent: { resumed: true, completed: true },
    });
    expect(world.registry.list("browser-tenant")[0]).toMatchObject({
      origin: "built:trusted-ui-contract-builder-v1",
      status: "active",
    });
    const reused = await world.sdk(true, "built").completeGoal(world.request("operation-built-reuse", "built-reuse"));
    expect(reused).toMatchObject({ status: "completed", path: "retained-capability" });
  });

  it("acquires a trusted capability, completes the original goal, and reuses it in a fresh SDK", async () => {
    const world = await createWorld();
    const first = await world.sdk().completeGoal(world.request("operation-a", "a"));
    expect(first).toMatchObject({
      status: "completed",
      path: "trusted-capability",
      parent: { resumed: true, completed: true },
      execution: { verification: { outcome: "complete" }, writePerformed: true },
    });
    expect(world.portal.count()).toBe(1);

    const second = await world.sdk().completeGoal(world.request("operation-b", "b"));
    expect(second).toMatchObject({
      status: "completed",
      path: "retained-capability",
      parent: { resumed: true, completed: true },
      execution: { verification: { outcome: "complete" }, writePerformed: true },
    });
    expect(world.portal.count()).toBe(2);
    expect(world.registry.list("browser-tenant")[0]).toMatchObject({ status: "active", reuseCount: 1 });
  });

  it("reconciles an already completed operation without opening a duplicate write path", async () => {
    const world = await createWorld();
    const request = world.request("operation-replay", "replay-first");
    expect((await world.sdk().completeGoal(request)).status).toBe("completed");
    const replay = await world.sdk(false).completeGoal({
      ...request,
      requestId: "request-replay-second",
      parentGoalId: "parent-replay-second",
      approvals: [],
    });
    expect(replay).toMatchObject({ status: "completed", path: "retained-capability", execution: { writePerformed: false } });
    expect(world.portal.count()).toBe(1);
  });

  it("stops before browser execution when approval, credentials, or operational authority are missing", async () => {
    const approvalWorld = await createWorld("normal", "approval-tenant");
    const withoutApproval = { ...approvalWorld.request("operation-no-approval"), approvals: [] };
    expect(await approvalWorld.sdk().completeGoal(withoutApproval)).toMatchObject({
      status: "blocked",
      handoff: { reason: "authority-or-credential-missing", writesAttempted: 0 },
      parent: { resumed: false },
    });
    expect(approvalWorld.portal.count()).toBe(0);

    const credentialWorld = await createWorld("normal", "credential-tenant");
    expect(await credentialWorld.sdk(false).completeGoal(credentialWorld.request("operation-no-secret"))).toMatchObject({
      status: "blocked",
      handoff: { reason: "authority-or-credential-missing", writesAttempted: 0 },
    });
    expect(credentialWorld.portal.count()).toBe(0);

    const haltedWorld = await createWorld("normal", "halted-tenant");
    haltedWorld.operations.setMode("halted", "Browser capability stop-control test.");
    expect(await haltedWorld.sdk().completeGoal(haltedWorld.request("operation-halted"))).toMatchObject({
      status: "blocked",
      handoff: { reason: "authority-or-credential-missing", writesAttempted: 0 },
    });
    expect(haltedWorld.portal.count()).toBe(0);
  });

  it("recovers a lost browser response from independent state without a second click", async () => {
    const world = await createWorld("lost-response-after-complete");
    const result = await world.sdk().completeGoal(world.request("operation-lost-response"));
    expect(result).toMatchObject({
      status: "completed",
      parent: { resumed: true },
      execution: { verification: { outcome: "complete" }, writePerformed: true },
    });
    expect(world.portal.count()).toBe(1);
  });

  it.each([
    ["partial-outcome", "partial"],
    ["incorrect-outcome", "incorrect"],
  ] as const)("quarantines %s and refuses automatic reacquisition", async (mode, outcome) => {
    const world = await createWorld(mode);
    const request = world.request(`operation-${mode}`);
    expect(await world.sdk().completeGoal(request)).toMatchObject({
      status: "blocked",
      handoff: { reason: "browser-outcome-unsafe", writesAttempted: 1 },
      execution: { quarantined: true, verification: { outcome } },
      parent: { resumed: false },
    });
    expect(world.registry.list("browser-tenant")[0]).toMatchObject({ status: "quarantined" });
    expect(await world.sdk().completeGoal({ ...request, requestId: `${request.requestId}-retry` })).toMatchObject({
      status: "blocked",
      handoff: { reason: "capability-unavailable", writesAttempted: 0 },
    });
    expect(world.portal.count()).toBe(1);
  });

  it.each([
    "ui-drift",
    "popup-escape",
    "download-escape",
    "redirect-escape",
    "write-during-verification",
  ] as const)("fails closed for %s", async (mode) => {
    const world = await createWorld(mode, `tenant-${mode}`);
    const result = await world.sdk().completeGoal(world.request(`operation-${mode}`));
    expect(result.status).toBe("blocked");
    expect(result.parent.resumed).toBe(false);
    expect(world.portal.count()).toBe(0);
  });

  it("quarantines a page that attempts more network writes than the target policy permits", async () => {
    const world = await createWorld("duplicate-network-write", "tenant-duplicate-network");
    const result = await world.sdk().completeGoal(world.request("operation-duplicate-network"));
    expect(result).toMatchObject({
      status: "blocked",
      execution: { quarantined: true, verification: { outcome: "complete" } },
      handoff: { reason: "browser-outcome-unsafe", writesAttempted: 1 },
      parent: { resumed: false },
    });
    expect(world.portal.count()).toBe(1);
  });

  it("quarantines a page that echoes a customer-local credential into an observable output", async () => {
    const world = await createWorld("secret-echo", "tenant-secret-echo");
    const result = await world.sdk().completeGoal(world.request("operation-secret-echo"));
    expect(result).toMatchObject({
      status: "blocked",
      execution: { quarantined: true, verification: { outcome: "complete" } },
      parent: { resumed: false },
    });
    expect(JSON.stringify(result)).not.toContain(PORTAL_KEY);
    expect(world.portal.count()).toBe(1);
  });

  it("does not persist the customer-local browser credential", async () => {
    const world = await createWorld();
    expect((await world.sdk().completeGoal(world.request("operation-secret-scan"))).status).toBe("completed");
    const files: string[] = [];
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(filename);
        else files.push(filename);
      }
    };
    visit(world.directory);
    for (const filename of files) {
      expect(fs.readFileSync(filename).includes(Buffer.from(PORTAL_KEY)), filename).toBe(false);
    }
  });

  it("keeps tenant registries isolated even when both tenants use the same trusted UI contract", async () => {
    const world = await createWorld();
    const first = world.request("tenant-a-operation", "tenant-a");
    const second = {
      ...world.request("tenant-b-operation", "tenant-b"),
      tenantId: "browser-tenant-b",
    };
    expect(await world.sdk(true, "built").completeGoal(first)).toMatchObject({
      status: "completed",
      path: "built-capability",
    });
    expect(await world.sdk(true, "built").completeGoal(second)).toMatchObject({
      status: "completed",
      path: "built-capability",
    });
    expect(world.registry.list("browser-tenant")).toHaveLength(1);
    expect(world.registry.list("browser-tenant-b")).toHaveLength(1);
    expect(world.registry.list("browser-tenant")[0]?.tenantId).toBe("browser-tenant");
    expect(world.registry.list("browser-tenant-b")[0]?.tenantId).toBe("browser-tenant-b");
    expect(world.portal.count()).toBe(2);
  });

  it("completes a bounded twenty-operation sequence with one construction and nineteen fresh-SDK reuses", async () => {
    const world = await createWorld();
    const paths: string[] = [];
    for (let index = 1; index <= 20; index += 1) {
      const result = await world.sdk(true, "built").completeGoal(
        world.request(`volume-operation-${index}`, `volume-${index}`),
      );
      expect(result.status).toBe("completed");
      if (result.status === "completed") paths.push(result.path);
    }
    expect(paths).toEqual([
      "built-capability",
      ...Array.from({ length: 19 }, () => "retained-capability"),
    ]);
    expect(world.portal.count()).toBe(20);
    expect(world.registry.list("browser-tenant")).toEqual([
      expect.objectContaining({ status: "active", reuseCount: 19 }),
    ]);
    expect(world.operations.verifyAuditChain()).toMatchObject({ passed: true });
  }, 240_000);
});
