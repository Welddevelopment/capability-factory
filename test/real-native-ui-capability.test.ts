import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NativeUiDriver, NativeUiRefusal, defaultHelperPath, type NativeUiSurface } from "../src/experimental/native-ui-driver.js";
import { startNativeDealerDeskWorld, type NativeDealerDeskWorld } from "../src/customer-world/native-dealer-desk-world.js";

// Opt-in like every real-world suite: drives a genuine native app via the
// accessibility API. Requires the built Dealer Desk bundle and the
// Accessibility permission.
const enabled = process.env.CF_REAL_NATIVE_UI === "1";

const SURFACE: NativeUiSurface = {
  appBundleId: "com.capabilityfactory.fictional.dealerdesk",
  controls: [
    { identifier: "dealer-desk.item-field", role: "AXTextField", actions: ["settext"] },
    { identifier: "dealer-desk.quantity-field", role: "AXTextField", actions: ["settext"] },
    { identifier: "dealer-desk.submit-button", role: "AXButton", actions: ["press"], commitsWrite: true },
    // Deliberately ABSENT: dealer-desk.wipe-button — the tripwire the driver must refuse.
  ],
};

describe.skipIf(!enabled)("real native-UI capability containment (Dealer Desk)", () => {
  const repositoryRoot = process.cwd();
  let world: NativeDealerDeskWorld;
  let driver: NativeUiDriver;

  beforeAll(async () => {
    world = await startNativeDealerDeskWorld({
      repositoryRoot,
      // tmpdir, not the repo: a Launch-Services-spawned app has no TCC grant
      // for ~/Desktop, so writes under the repo fail silently.
      dataDirectory: mkdtempSync(path.join(os.tmpdir(), "cf-native-ui-")),
    });
    driver = new NativeUiDriver(defaultHelperPath(repositoryRoot), world.pid, SURFACE);
  }, 60_000);

  afterAll(() => {
    world?.stop();
  });

  it("snapshots a sanitized surface: roles, identifiers and opaque ids only", () => {
    const snapshot = driver.snapshot();
    const identifiers = snapshot.map((entry) => entry.identifier);
    expect(identifiers).toContain("dealer-desk.submit-button");
    expect(identifiers).toContain("dealer-desk.wipe-button");
    for (const entry of snapshot) {
      expect(Object.keys(entry).sort()).toEqual(["identifier", "opaqueId", "role"]);
      expect(entry.opaqueId).toMatch(/^ax-[0-9a-f]{16}$/);
    }
  });

  it("performs exactly one intended write, verified through the independent database channel", () => {
    expect(world.countRestockRequests()).toBe(0);
    driver.setText("dealer-desk.item-field", "Fictional Widget B");
    driver.setText("dealer-desk.quantity-field", "3");
    driver.press("dealer-desk.submit-button");
    expect(world.countRestockRequests()).toBe(1);
    expect(world.listRestockRequests()).toEqual([{ item: "Fictional Widget B", quantity: 3 }]);
  });

  it("refuses a real button that is outside the declared surface (the wipe tripwire)", () => {
    expect(() => driver.press("dealer-desk.wipe-button")).toThrow(NativeUiRefusal);
    expect(world.countRestockRequests()).toBe(1);
  });

  it("refuses a second commit once the write budget is spent", () => {
    driver.setText("dealer-desk.item-field", "Fictional Widget C");
    driver.setText("dealer-desk.quantity-field", "2");
    expect(() => driver.press("dealer-desk.submit-button")).toThrow(/write budget exhausted/);
    expect(world.countRestockRequests()).toBe(1);
  });

  it("refuses actions not permitted on a declared control", () => {
    expect(() => driver.press("dealer-desk.item-field")).toThrow(NativeUiRefusal);
    expect(() => driver.setText("dealer-desk.submit-button", "x")).toThrow(NativeUiRefusal);
  });

  it("fails closed when the app is gone", () => {
    world.stop();
    expect(() => driver.snapshot()).toThrow();
  });
});
