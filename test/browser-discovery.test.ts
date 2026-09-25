import { describe, expect, it } from "vitest";
import {
  browserDiscoveryBoundaryHash,
  compileBrowserDiscoveryPlan,
  defineBrowserDiscoverySnapshot,
  discoveredControlId,
  type BrowserDiscoveryBoundary,
  type BrowserDiscoveryPlan,
} from "../src/experimental/browser-discovery.js";
import type { ExperimentalBrowserLocator, ExperimentalBrowserTarget } from "../src/experimental/browser-driver.js";

const path = "/approved/new";
const title = { kind: "label", value: "Title", exact: true } as const satisfies ExperimentalBrowserLocator;
const submit = { kind: "role", role: "button", name: "Create", exact: true } as const satisfies ExperimentalBrowserLocator;
const confirmation = { kind: "role", role: "main" } as const satisfies ExperimentalBrowserLocator;

function boundary(): BrowserDiscoveryBoundary {
  return {
    schemaVersion: "1.0",
    boundaryId: "unit-discovery-v1",
    capabilityIdPrefix: "unit-discovered-action",
    needKey: "create-approved-record",
    targetAlias: "unit_portal",
    outcomeVerifierKey: "unit-direct-verifier-v1",
    seedPaths: [path],
    allowedPaths: [path],
    inputs: [{ key: "title", description: "Approved record title." }],
    secretAliases: [],
    writeApprovalKey: "create-approved-record",
    maxBusinessWrites: 1,
    completion: { kind: "input-contains", description: "Created record page.", inputKey: "title" },
    authentication: { kind: "none", humanGatePolicy: "stop-and-handoff" },
  };
}

function target(): ExperimentalBrowserTarget {
  return {
    origin: "http://127.0.0.1:43210",
    allowedNavigationPaths: [path],
    allowedRequests: [
      { path, method: "GET", purpose: "read", maxPerSession: 1 },
      { path: "/approved", method: "POST", purpose: "business-write", maxPerSession: 1 },
    ],
    allowedLocators: [title, submit, confirmation],
  };
}

function fixture() {
  const trustedBoundary = boundary();
  const titleId = discoveredControlId(path, title);
  const submitId = discoveredControlId(path, submit);
  const confirmationId = discoveredControlId(path, confirmation);
  const snapshot = defineBrowserDiscoverySnapshot({
    schemaVersion: "1.0",
    boundaryId: trustedBoundary.boundaryId,
    boundaryHash: browserDiscoveryBoundaryHash(trustedBoundary),
    targetAlias: trustedBoundary.targetAlias,
    pages: [{
      requestedPath: path,
      finalPath: path,
      title: "Approved records",
      headings: ["Create record"],
      controls: [
        { controlId: titleId, pagePath: path, locator: title, element: "input", accessibleName: "Title", inputType: "text", hrefPath: null, canRead: true, canFill: true, canClick: false, humanGateSignal: "none" },
        { controlId: submitId, pagePath: path, locator: submit, element: "button", accessibleName: "Create", inputType: null, hrefPath: null, canRead: true, canFill: false, canClick: true, humanGateSignal: "none" },
        { controlId: confirmationId, pagePath: path, locator: confirmation, element: "other", accessibleName: "", inputType: null, hrefPath: null, canRead: true, canFill: false, canClick: false, humanGateSignal: "none" },
      ],
    }],
    humanGates: [],
  });
  const plan: BrowserDiscoveryPlan = {
    schemaVersion: "1.0",
    needKey: trustedBoundary.needKey,
    snapshotHash: snapshot.snapshotHash,
    steps: [
      { kind: "navigate", path },
      { kind: "fill", controlId: titleId, inputKey: "title" },
      { kind: "click", controlId: submitId, effect: "write", approvalKey: trustedBoundary.writeApprovalKey, sessionSecretAliases: [] },
      { kind: "assert-input-text", controlId: confirmationId, inputKey: "title" },
    ],
  };
  return { trustedBoundary, snapshot, plan };
}

describe("browser discovery trusted compiler", () => {
  it("compiles observed controls into a one-write constrained capability", () => {
    const { trustedBoundary, snapshot, plan } = fixture();
    const capability = compileBrowserDiscoveryPlan({ target: target(), boundary: trustedBoundary, snapshot, plan });
    expect(capability).toMatchObject({
      capabilityMode: "experimental-browser-actions",
      needKey: trustedBoundary.needKey,
      uiContractHash: snapshot.snapshotHash,
      steps: [
        { kind: "navigate", path },
        { kind: "fill", inputKey: "title" },
        { kind: "click", effect: "write", approvalKey: "create-approved-record" },
        { kind: "assert-input-text", inputKey: "title" },
      ],
    });
  });

  it("rejects invented paths, controls, changed authority and zero-write plans", () => {
    const { trustedBoundary, snapshot, plan } = fixture();
    const compile = (candidate: BrowserDiscoveryPlan) => compileBrowserDiscoveryPlan({ target: target(), boundary: trustedBoundary, snapshot, plan: candidate });
    expect(() => compile({ ...plan, steps: [{ kind: "navigate", path: "/invented" }, ...plan.steps.slice(1)] }))
      .toThrow(/invented an unapproved path/);
    expect(() => compile({ ...plan, steps: [plan.steps[0]!, { kind: "fill", controlId: "f".repeat(64), inputKey: "title" }, ...plan.steps.slice(2)] }))
      .toThrow(/invented an unobserved control/);
    const changedAuthority = plan.steps.map((step) => step.kind === "click"
      ? { ...step, approvalKey: "broader-authority" }
      : step) as BrowserDiscoveryPlan["steps"];
    expect(() => compile({ ...plan, steps: changedAuthority })).toThrow(/changed the trusted write authority/);
    expect(() => compile({ ...plan, steps: plan.steps.filter((step) => step.kind !== "click") }))
      .toThrow(/exactly one trusted consequential browser write/);
  });

  it("rejects a snapshot whose boundary identity or content hash was altered", () => {
    const { trustedBoundary, snapshot, plan } = fixture();
    expect(() => compileBrowserDiscoveryPlan({
      target: target(),
      boundary: { ...trustedBoundary, writeApprovalKey: "different-policy" },
      snapshot,
      plan,
    })).toThrow(/different trusted boundary/);
    expect(() => compileBrowserDiscoveryPlan({
      target: target(),
      boundary: trustedBoundary,
      snapshot: { ...snapshot, pages: [{ ...snapshot.pages[0]!, title: "Tampered" }] },
      plan,
    })).toThrow(/hash does not match/);
  });
});
