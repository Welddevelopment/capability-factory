import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPilotConversionRehearsal } from "../src/product/pilot-conversion-rehearsal.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("pilot conversion rehearsal", () => {
  it("joins intake, adapter, package, acceptance, safety, contracting, evidence and console gates", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "cf-conversion-rehearsal-")); roots.push(parent);
    const report = await runPilotConversionRehearsal(path.join(parent, "run"));
    expect(report).toMatchObject({ fictionalDryRun: true, customerEvidence: false, modelCalls: 0, paidCalls: 0 });
    expect(report.checks.every((check) => check.passed)).toBe(true);
    expect(report.adapter).toMatchObject({ descriptorChecksPassed: true, acceptanceCases: 10, incorrectSideEffects: 0 });
    expect(report.package).toMatchObject({ ready: true, sidecarReadyEndpoint: true });
    expect(report.console).toEqual({ activationReady: true, passedGates: 6, totalGates: 6 });
    expect(report.claimBoundary).toMatch(/not a customer/i);
  });
});
