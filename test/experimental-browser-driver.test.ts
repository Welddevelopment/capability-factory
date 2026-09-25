import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  browserRequestPathMatches,
  ExperimentalBrowserDriver,
  type ExperimentalBrowserCapability,
  type ExperimentalBrowserOutcomeVerifier,
  type ExperimentalBrowserSession,
  type ExperimentalBrowserSessionFactory,
} from "../src/experimental/browser-driver.js";

const UI_HASH = createHash("sha256").update("unit-browser-ui-v2").digest("hex");

function manifest(): ExperimentalBrowserCapability {
  const locator = (value: string) => ({ kind: "test-id" as const, value });
  return {
    schemaVersion: "0.4",
    capabilityMode: "experimental-browser-actions",
    id: "local-order-form",
    needKey: "create-local-order",
    targetAlias: "local_portal",
    outcomeVerifierKey: "direct-local-db-v1",
    uiContractHash: UI_HASH,
    steps: [
      { kind: "navigate", path: "/orders/new" },
      { kind: "assert-text", locator: locator("page-title"), expectedText: "Create order" },
      { kind: "fill", locator: locator("order-reference"), inputKey: "reference" },
      { kind: "click", locator: locator("submit-order"), effect: "write", approvalKey: "create-order" },
      { kind: "assert-text", locator: locator("confirmation"), expectedText: "Created" },
      { kind: "read-text", locator: locator("confirmation"), outputKey: "confirmation" },
    ],
  };
}

async function fixture(failure: "none" | "after-complete" | "after-partial" = "none") {
  const state = { outcome: "not-started" as "not-started" | "complete" | "partial", opened: 0, clicks: 0, value: "" };
  const factory: ExperimentalBrowserSessionFactory = {
    open: async () => {
      state.opened += 1;
      const session: ExperimentalBrowserSession = {
        navigate: async (url) => { if (!url.endsWith("/orders/new")) throw new Error("wrong page"); },
        inspect: async () => undefined,
        readText: async (target) => target.kind === "test-id" && target.value === "page-title" ? "Create order" : state.outcome === "complete" ? "Created" : "Not created",
        fill: async (_testId, value) => { state.value = value; },
        click: async () => {
          state.clicks += 1;
          state.outcome = failure === "after-partial" ? "partial" : "complete";
          if (failure !== "none") throw new Error("browser process lost after click");
        },
        close: async () => undefined,
      };
      return session;
    },
  };
  const verifier: ExperimentalBrowserOutcomeVerifier = {
    key: "direct-local-db-v1",
    verify: async () => ({ outcome: state.outcome, detail: "The fictional database was read outside the browser session." }),
  };
  const driver = new ExperimentalBrowserDriver({
    local_portal: {
      origin: "http://127.0.0.1:4567",
      allowedNavigationPaths: ["/orders/new"],
      allowedRequests: [
        { path: "/orders/new", method: "GET", purpose: "read", maxPerSession: 1 },
        { path: "/orders", method: "POST", purpose: "business-write", maxPerSession: 1 },
      ],
      allowedLocators: ["page-title", "order-reference", "submit-order", "confirmation"].map((value) => ({ kind: "test-id", value })),
    },
  }, factory);
  const verification = await driver.verifyCapability(manifest());
  expect(verification.passed).toBe(true);
  return { state, verifier, driver, verification };
}

function options(verification: Awaited<ReturnType<ExperimentalBrowserDriver["verifyCapability"]>>) {
  return {
    operationKey: "operation-123",
    runId: "run-123",
    input: { reference: "ORDER-42" },
    approvals: ["create-order"],
    verification,
  };
}

describe("isolated experimental browser capability driver", () => {
  it("matches only bounded integer and static-asset request templates", () => {
    expect(browserRequestPathMatches("/issues/42", "/issues/:integer")).toBe(true);
    expect(browserRequestPathMatches("/issues/0", "/issues/:integer")).toBe(false);
    expect(browserRequestPathMatches("/issues/latest", "/issues/:integer")).toBe(false);
    expect(browserRequestPathMatches("/assets/js/index.ABC-123.js", "/assets/js/:asset")).toBe(true);
    expect(browserRequestPathMatches("/assets/js/nested/index.js", "/assets/js/:asset")).toBe(false);
    expect(browserRequestPathMatches("/admin", "/assets/js/:asset")).toBe(false);
  });

  it("requires exact approval, reconciles first, performs one bounded write, and verifies outside the browser", async () => {
    const { state, verifier, driver, verification } = await fixture();
    const openedAfterVerification = state.opened;
    expect(await driver.execute(manifest(), { ...options(verification), approvals: [] }, verifier)).toMatchObject({
      status: "blocked",
      writesAttempted: 0,
      quarantined: false,
    });
    expect(state.opened).toBe(openedAfterVerification);
    const result = await driver.execute(manifest(), options(verification), verifier);
    expect(result).toMatchObject({
      status: "completed",
      reconciledBeforeAction: true,
      writePerformed: true,
      outputs: { confirmation: "Created" },
      verification: { outcome: "complete" },
    });
    expect(state.clicks).toBe(1);
    const replay = await driver.execute(manifest(), {
      ...options(verification),
      approvals: [],
    }, verifier);
    expect(replay).toMatchObject({ status: "completed", writePerformed: false });
    expect(state.clicks).toBe(1);
  });

  it("recovers a lost browser response when direct state proves completion", async () => {
    const { state, verifier, driver, verification } = await fixture("after-complete");
    expect(await driver.execute(manifest(), options(verification), verifier)).toMatchObject({
      status: "completed",
      writePerformed: true,
      verification: { outcome: "complete" },
    });
    expect(state.clicks).toBe(1);
    expect(driver.isQuarantined(manifest().id)).toBe(false);
  });

  it("blocks blind retry and quarantines the capability when the external outcome is partial", async () => {
    const { verifier, driver, verification } = await fixture("after-partial");
    expect(await driver.execute(manifest(), options(verification), verifier)).toMatchObject({
      status: "blocked",
      writesAttempted: 1,
      quarantined: true,
      verification: { outcome: "partial" },
    });
    await expect(driver.execute(manifest(), options(verification), verifier)).rejects.toThrow(/quarantined/);
  });

  it("rejects unapproved selectors, paths, origins, multi-write manifests, and stale verification", async () => {
    const { verifier, driver, verification } = await fixture();
    const badSelector = manifest();
    badSelector.steps[1] = { kind: "assert-text", locator: { kind: "test-id", value: "arbitrary-css" }, expectedText: "x" };
    await expect(driver.execute(badSelector, options(verification), verifier)).rejects.toThrow(/verification receipt|not allowlisted/);
    const multipleWrites = manifest();
    multipleWrites.steps.push({ kind: "click", locator: { kind: "test-id", value: "submit-order" }, effect: "write", approvalKey: "create-order" });
    await expect(driver.execute(multipleWrites, options(verification), verifier)).rejects.toThrow(/at most one consequential click/);
    const mutationAfterWrite = manifest();
    mutationAfterWrite.steps.push({ kind: "fill", locator: { kind: "test-id", value: "order-reference" }, inputKey: "reference" });
    await expect(driver.verifyCapability(mutationAfterWrite)).rejects.toThrow(/Only bounded observations/);
    const duplicateOutput = manifest();
    duplicateOutput.steps.push({ kind: "read-text", locator: { kind: "test-id", value: "confirmation" }, outputKey: "confirmation" });
    await expect(driver.verifyCapability(duplicateOutput)).rejects.toThrow(/output keys must be unique/);
    const external = new ExperimentalBrowserDriver({
      local_portal: {
        origin: "https://example.com",
        allowedNavigationPaths: ["/orders/new"],
        allowedRequests: [{ path: "/orders/new", method: "GET", purpose: "read", maxPerSession: 1 }],
        allowedLocators: ["page-title", "order-reference", "submit-order", "confirmation"].map((value) => ({ kind: "test-id", value })),
      },
    }, { open: async () => { throw new Error("must not open"); } });
    await expect(external.verifyCapability(manifest())).rejects.toThrow(/localhost/);
  });

  it("applies the customer stop control before opening a verification browser", async () => {
    const { state, driver } = await fixture();
    const openedBeforeBlockedVerification = state.opened;
    await expect(driver.verifyCapability(manifest(), {
      runId: "halted-verification",
      operationalControl: {
        beforeAction: () => { throw new Error("customer kill switch is active"); },
        afterAction: () => undefined,
      },
    })).rejects.toThrow(/kill switch/);
    expect(state.opened).toBe(openedBeforeBlockedVerification);
  });
});
