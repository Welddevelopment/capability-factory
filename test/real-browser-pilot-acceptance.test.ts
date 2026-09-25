import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBrowserPortalExperimentalPilotAdapter,
} from "../src/customer-world/browser-pilot-acceptance.js";
import { DisposableBrowserPortal } from "../src/customer-world/browser-portal.js";
import {
  preflightExperimentalBrowserPilotAdapter,
  runExperimentalBrowserPilotAcceptance,
} from "../src/experimental/browser-pilot-adapter.js";

const enabled = process.env.CF_REAL_BROWSER === "1";
const testIfEnabled = enabled ? it : it.skip;
const PORTAL_KEY = "browser-acceptance-secret-value";
const portals: DisposableBrowserPortal[] = [];

afterEach(async () => {
  await Promise.all(portals.splice(0).map((portal) => portal.close()));
});

function filesBelow(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(root, entry.name);
    return entry.isDirectory() ? filesBelow(filename) : [filename];
  });
}

describe("experimental browser pilot adapter", () => {
  testIfEnabled("passes isolated descriptor preflight and the frozen ten-case Chromium acceptance campaign", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-browser-acceptance-"));
    const portal = new DisposableBrowserPortal(path.join(root, "portal.sqlite"), PORTAL_KEY);
    await portal.start();
    portals.push(portal);
    const adapter = createBrowserPortalExperimentalPilotAdapter({
      portal,
      portalKey: PORTAL_KEY,
      dataDirectory: root,
    });

    const preflight = await preflightExperimentalBrowserPilotAdapter(adapter);
    expect(preflight.filter((item) => !item.passed)).toEqual([]);
    const campaign = await runExperimentalBrowserPilotAcceptance(adapter);

    expect(campaign).toMatchObject({
      passed: true,
      abortedForSafety: false,
      requiredCases: 10,
      completedCases: 10,
      failedCases: [],
      notRunCases: [],
      incorrectSideEffects: 0,
    });
    expect(campaign.results).toHaveLength(10);
    expect(campaign.results.every((result) => result.passed && result.checks.every((item) => item.passed))).toBe(true);
    const evidenceFiles = filesBelow(path.join(root, "browser-acceptance-evidence"));
    expect(evidenceFiles).toHaveLength(10);
    expect(evidenceFiles.some((filename) => fs.readFileSync(filename, "utf8").includes(PORTAL_KEY))).toBe(false);
  }, 240_000);
});
