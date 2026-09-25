import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  REAL_GITEA_BROWSER_UI_CONTRACT,
  RealGiteaBrowserWorld,
} from "../src/customer-world/real-gitea-browser-world.js";
import {
  GITEA_DISCOVERY_PASSWORD_ALIAS,
  GITEA_DISCOVERY_USERNAME_ALIAS,
  giteaBrowserDiscoveryBoundary,
} from "../src/customer-world/gitea-browser-discovery.js";
import { startRealGiteaWorld } from "../src/customer-world/real-gitea-world.js";
import {
  ExperimentalBrowserCapabilitySdk,
  StaticTrustedBrowserCapabilitySource,
} from "../src/experimental/browser-capability-sdk.js";
import { BrowserDiscoveryGoalRunner } from "../src/experimental/browser-discovery-sdk.js";
import { ConservativeHeuristicBrowserDiscoveryPlanner } from "../src/experimental/browser-discovery-planner.js";
import { ExperimentalBrowserDriver } from "../src/experimental/browser-driver.js";
import { PlaywrightBrowserDiscoverer } from "../src/experimental/playwright-browser-discovery.js";
import { FileBrowserCapabilityRegistry } from "../src/experimental/browser-registry.js";
import { PlaywrightBrowserSessionFactory } from "../src/experimental/playwright-browser-session.js";
import { RotatingMemorySecretProvider, type SecretScope } from "../src/product/secrets.js";

const enabled = process.env.CF_REAL_BROWSER === "1" && process.env.CF_REAL_GITEA === "1";
const testIfEnabled = enabled ? it : it.skip;
describe("genuine Gitea trusted-login browser discovery", () => {
  testIfEnabled("discovers the issue UI after trusted session bootstrap, builds, verifies and reuses", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-gitea-browser-discovery-"));
    const world = await startRealGiteaWorld({
      repositoryRoot: process.cwd(),
      artifactDirectory: path.join(root, "gitea"),
    });
    const target = new RealGiteaBrowserWorld(world, path.join(root, "reference-world")).target();
    const credentials = world.browserSessionCredentials();
    const secrets = new RotatingMemorySecretProvider();
    const scope: SecretScope = {
      targetAliases: ["gitea_browser"],
      actionNames: ["browser-discovery-session-auth", "browser-capability-verification", "browser-write"],
      methods: ["BROWSER"],
    };
    secrets.set({ alias: GITEA_DISCOVERY_USERNAME_ALIAS, version: "gitea-discovery-v1", scope }, credentials.username);
    secrets.set({ alias: GITEA_DISCOVERY_PASSWORD_ALIAS, version: "gitea-discovery-v1", scope }, credentials.password);
    const registry = new FileBrowserCapabilityRegistry(path.join(root, "registry"));
    const runner = new BrowserDiscoveryGoalRunner(
      target,
      giteaBrowserDiscoveryBoundary(),
      new PlaywrightBrowserDiscoverer({ secretProvider: secrets }),
      new ConservativeHeuristicBrowserDiscoveryPlanner(),
      registry,
      ({ target: effectiveTarget, builder }) => new ExperimentalBrowserCapabilitySdk({
        driver: new ExperimentalBrowserDriver({ gitea_browser: effectiveTarget }, new PlaywrightBrowserSessionFactory()),
        registry,
        trustedSource: new StaticTrustedBrowserCapabilitySource("empty-gitea-discovery-catalog", []),
        builder,
        secretProvider: secrets,
        outcomeVerifier: (request) => {
          const marker = request.input.body?.match(/^\[CF-DISCOVERY:[^\]]+\]/)?.[0];
          if (!marker) throw new Error("Gitea discovery request requires a unique body marker.");
          return {
            key: REAL_GITEA_BROWSER_UI_CONTRACT.outcomeVerifierKey,
            verify: async (operationKey: string) => {
              if (operationKey !== request.operationKey) return { outcome: "unknown" as const, detail: "Wrong operation identity." };
              const direct = await world.verifyBrowserIssue({
                marker,
                title: request.input.title!,
                body: request.input.body!,
              });
              return direct.passed
                ? { outcome: "complete" as const, detail: direct.detail, stateDigest: direct.stateHash }
                : {
                    outcome: direct.incorrectSideEffects > 0 ? "incorrect" as const : "not-started" as const,
                    detail: direct.detail,
                    stateDigest: direct.stateHash,
                  };
            },
          };
        },
      }),
    );
    const request = (suffix: string) => ({
      tenantId: "gitea-browser-discovery-tenant",
      requestId: `gitea-browser-discovery-request-${suffix}`,
      parentGoalId: `gitea-browser-discovery-parent-${suffix}`,
      ordinaryGoal: `Create and verify the approved synthetic Gitea incident ${suffix}, then continue the original goal.`,
      needKey: "create-gitea-issue-through-ui",
      operationKey: `gitea-browser-discovery-operation-${suffix}`,
      input: {
        title: `[${suffix}] Discovered browser incident`,
        body: `[CF-DISCOVERY:${suffix}]\n\nSynthetic incident created through read-only UI discovery.`,
      },
      approvals: ["create-gitea-issue"],
    });

    await world.reset("approved-write");
    const built = await runner.completeGoal(request("build"));
    expect(built).toMatchObject({
      status: "completed",
      snapshot: { pages: [{ finalPath: "/cf-admin/cf-incident-intake/issues/new" }], humanGates: [] },
      capability: { status: "completed", path: "built-capability", parent: { resumed: true } },
    });
    if (!built.snapshot) throw new Error("Completed Gitea discovery must preserve its trusted snapshot.");
    expect(built.snapshot.pages[0]?.controls.some((control) => control.accessibleName === "Create Issue")).toBe(true);

    await world.reset("fresh-process-reuse");
    const reused = await runner.completeGoal(request("reuse"));
    expect(reused).toMatchObject({ status: "completed", capability: { path: "retained-capability" }, drift: [] });
    expect(registry.list("gitea-browser-discovery-tenant")).toEqual([
      expect.objectContaining({ status: "active", reuseCount: 1, discoverySnapshotHash: built.snapshot.snapshotHash }),
    ]);

    secrets.set({ alias: GITEA_DISCOVERY_PASSWORD_ALIAS, version: "gitea-discovery-rejected-v2", scope }, "definitely-wrong-password");
    const rejected = await runner.completeGoal(request("rejected-auth"));
    expect(rejected).toMatchObject({
      status: "blocked",
      drift: [],
      handoff: {
        reason: "human-authentication-required",
        summary: expect.stringContaining("did not leave the approved login page"),
        writesAttempted: 0,
      },
    });
    expect("snapshot" in rejected).toBe(false);
    expect(registry.list("gitea-browser-discovery-tenant")).toEqual([
      expect.objectContaining({ status: "active", reuseCount: 1 }),
    ]);
    const rejectedMarker = "[CF-DISCOVERY:rejected-auth]";
    const absent = await world.verifyBrowserIssue({
      marker: rejectedMarker,
      title: "[rejected-auth] Discovered browser incident",
      body: `${rejectedMarker}\n\nSynthetic incident created through read-only UI discovery.`,
    });
    expect(absent.passed).toBe(false);
    expect(absent.incorrectSideEffects).toBe(0);
  }, 180_000);
});
