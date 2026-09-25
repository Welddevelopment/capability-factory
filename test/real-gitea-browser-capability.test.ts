import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  REAL_GITEA_BROWSER_SECRET_DESCRIPTORS,
  REAL_GITEA_BROWSER_UI_CONTRACT,
  RealGiteaBrowserWorld,
} from "../src/customer-world/real-gitea-browser-world.js";
import { startRealGiteaWorld } from "../src/customer-world/real-gitea-world.js";
import {
  buildCapabilityModePackageSidecar,
  CapabilityModePackageManager,
} from "../src/product/capability-mode-package.js";
import { CAPABILITY_MODE_SCHEMA_VERSION } from "../src/product/capability-mode-contract.js";

const enabled = process.env.CF_REAL_BROWSER === "1" && process.env.CF_REAL_GITEA === "1";
const testIfEnabled = enabled ? it : it.skip;

describe("genuine Gitea browser capability", () => {
  testIfEnabled("runs the third-party Gitea UI through the customer-local packaged sidecar and retains the verified capability", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-real-gitea-browser-package-"));
    const world = await startRealGiteaWorld({
      repositoryRoot: process.cwd(),
      artifactDirectory: path.join(root, "gitea"),
    });
    await world.reset("approved-write");
    const contractSource = path.join(root, "gitea-browser-ui-contract.json");
    fs.writeFileSync(contractSource, `${JSON.stringify(REAL_GITEA_BROWSER_UI_CONTRACT, null, 2)}\n`, { mode: 0o600 });
    const manager = new CapabilityModePackageManager(path.join(root, "package"), {
      portProbe: async () => true,
    });
    manager.initialize({
      installationId: "real-gitea-browser-package",
      productVersion: "0.1.0",
      tenantId: "real-gitea-browser-tenant",
      modes: [{
        capabilityMode: "experimental-browser-actions",
        driverVersion: "browser-driver-v0.1",
        contractFiles: [{ sourcePath: contractSource, packagedName: "gitea-browser-ui-contract.json" }],
        requiredSecrets: REAL_GITEA_BROWSER_SECRET_DESCRIPTORS,
      }],
    });
    const credentials = world.browserSessionCredentials();
    manager.writeSecret("gitea_browser_username", credentials.username);
    manager.writeSecret("gitea_browser_password", credentials.password);

    let packagedBrowser: RealGiteaBrowserWorld | undefined;
    const built = await buildCapabilityModePackageSidecar(manager, async (context) => {
      packagedBrowser = new RealGiteaBrowserWorld(
        world,
        path.join(context.stateDirectory, "gitea-browser"),
        {},
        undefined,
        context.secrets,
      );
      return [packagedBrowser.modeRunner()];
    });
    const token = manager.readAccessTokenForLocalClient();
    const submitAndWait = async (suffix: string) => {
      const request = packagedBrowser!.request(suffix);
      const submitted = await built.app.inject({
        method: "POST",
        url: "/v1/capability-mode-jobs",
        headers: { "x-capability-sidecar-token": token },
        payload: {
          schemaVersion: CAPABILITY_MODE_SCHEMA_VERSION,
          capabilityMode: "experimental-browser-actions",
          request,
        },
      });
      expect(submitted.statusCode).toBe(202);
      const jobId = submitted.json().jobId as string;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const response = await built.app.inject({
          method: "GET",
          url: `/v1/capability-mode-jobs/${jobId}?tenantId=${request.tenantId}`,
          headers: { "x-capability-sidecar-token": token },
        });
        const job = response.json();
        if (job.status !== "queued" && job.status !== "running") return { request, job };
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("Packaged Gitea browser job did not finish.");
    };

    try {
      expect(await manager.readiness()).toMatchObject({ ready: true });
      const first = await submitAndWait("GITEA-PACKAGED-FIRST");
      expect(first.job).toMatchObject({
        capabilityMode: "experimental-browser-actions",
        status: "completed",
        result: {
          parentResumed: true,
          parentCompleted: true,
          acquisitionPath: "built-capability",
        },
      });
      expect(await world.verifyBrowserIssue({
        marker: "[CF-BROWSER:GITEA-PACKAGED-FIRST]",
        title: first.request.input.title!,
        body: first.request.input.body!,
      })).toMatchObject({ passed: true, intendedWrites: 1, incorrectSideEffects: 0 });

      await world.reset("approved-write");
      const second = await submitAndWait("GITEA-PACKAGED-SECOND");
      expect(second.job).toMatchObject({
        status: "completed",
        result: {
          parentResumed: true,
          parentCompleted: true,
          acquisitionPath: "retained-capability",
        },
      });
      expect(await world.verifyBrowserIssue({
        marker: "[CF-BROWSER:GITEA-PACKAGED-SECOND]",
        title: second.request.input.title!,
        body: second.request.input.body!,
      })).toMatchObject({ passed: true, intendedWrites: 1, incorrectSideEffects: 0 });
      expect(
        fs.readFileSync(manager.configFilename, "utf8"),
      ).not.toContain(credentials.password);
    } finally {
      await built.close();
    }
  }, 300_000);

  testIfEnabled("logs in, builds a constrained UI capability, creates one issue, independently verifies it, then reuses after reset", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-real-gitea-browser-"));
    const world = await startRealGiteaWorld({
      repositoryRoot: process.cwd(),
      artifactDirectory: path.join(root, "gitea"),
    });
    await world.reset("approved-write");
    const browser = new RealGiteaBrowserWorld(world, root);
    const firstRequest = browser.request("GITEA-BROWSER-FIRST");
    const first = await browser.complete(firstRequest);

    expect(first).toMatchObject({
      status: "completed",
      path: "built-capability",
      execution: {
        reconciledBeforeAction: true,
        writePerformed: true,
        verification: { outcome: "complete" },
      },
      parent: { resumed: true, completed: true },
    });
    const firstDirect = await world.verifyBrowserIssue({
      marker: "[CF-BROWSER:GITEA-BROWSER-FIRST]",
      title: firstRequest.input.title!,
      body: firstRequest.input.body!,
    });
    expect(firstDirect).toMatchObject({ passed: true, intendedWrites: 1, incorrectSideEffects: 0 });

    await world.reset("approved-write");
    const secondRequest = browser.request("GITEA-BROWSER-SECOND");
    const second = await browser.complete(secondRequest);
    expect(second).toMatchObject({
      status: "completed",
      path: "retained-capability",
      execution: { verification: { outcome: "complete" } },
      parent: { resumed: true, completed: true },
    });
    const secondDirect = await world.verifyBrowserIssue({
      marker: "[CF-BROWSER:GITEA-BROWSER-SECOND]",
      title: secondRequest.input.title!,
      body: secondRequest.input.body!,
    });
    expect(secondDirect).toMatchObject({ passed: true, intendedWrites: 1, incorrectSideEffects: 0 });
  }, 240_000);

  testIfEnabled("fails session authentication during pre-use verification and leaves genuine Gitea state unchanged", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-real-gitea-browser-auth-fail-"));
    const world = await startRealGiteaWorld({
      repositoryRoot: process.cwd(),
      artifactDirectory: path.join(root, "gitea"),
    });
    await world.reset("approved-write");
    const before = await world.stateHash();
    const browser = new RealGiteaBrowserWorld(world, root, { password: "intentionally-wrong-local-password" });
    const result = await browser.complete(browser.request("GITEA-BROWSER-AUTH-FAIL"));

    expect(result).toMatchObject({
      status: "blocked",
      handoff: { reason: "capability-unavailable", writesAttempted: 0 },
      parent: { resumed: false, completed: false },
    });
    expect(await world.stateHash()).toBe(before);
  }, 240_000);
});
