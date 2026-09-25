import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runSimulatedControlledPilot } from "../src/product/run-simulated-pilot.js";

describe("end-to-end simulated controlled pilot", () => {
  it("installs, stops safely, survives restart, continues, verifies, backs up, upgrades, and shuts down", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "cf-simulated-pilot-"));
    const root = path.join(parent, "installation");
    try {
      const report = await runSimulatedControlledPilot(root);
      expect(report).toMatchObject({
        initialResult: "partially-complete",
        initialCompletedItems: 6,
        initialBlockedItems: 1,
        restartPerformed: true,
        continuationReconciled: true,
        finalResult: "completed",
        finalCompletedItems: 7,
        parentResumed: true,
        incorrectSideEffects: 0,
        externalRestocks: 4,
        plannerCalls: 1,
        conflictingRequestRejected: true,
        secretValuesPersistedInArtifacts: false,
        auditChainPassed: true,
        backupPassed: true,
        upgradedTo: "0.2.0",
        finalLifecycle: "deactivated",
      });
      expect(fs.existsSync(path.join(root, "simulated-pilot-report.json"))).toBe(true);
      expect(fs.readFileSync(path.join(root, "simulated-pilot-report.json"), "utf8")).not.toContain("local-reference-east-key");
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  }, 30_000);
});
