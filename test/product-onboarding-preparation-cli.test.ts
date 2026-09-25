import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runOnboardingPreparationCli } from "../src/product/onboarding-preparation-cli.js";

function output() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write(value: string) { stdout += value; } },
      stderr: { write(value: string) { stderr += value; } },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("onboarding preparation CLI", () => {
  it("returns concise usage errors without stack traces", async () => {
    const capture = output();
    expect(await runOnboardingPreparationCli([], capture.io)).toBe(1);
    expect(capture.stdout()).toBe("");
    expect(capture.stderr()).toMatch(/^Usage:/);
    expect(capture.stderr()).not.toMatch(/\n\s+at /);
  });

  it("requires a durable existing session for status and events", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cf-onboarding-cli-"));
    const state = path.join(directory, "preparation.sqlite");
    for (const command of ["status", "events"] as const) {
      const capture = output();
      expect(await runOnboardingPreparationCli([
        command,
        "--state",
        state,
        "--session",
        "unknown-session",
      ], capture.io)).toBe(1);
      expect(capture.stderr()).toMatch(/session does not exist/i);
    }
  });

  it("rejects duplicate and confused command options", async () => {
    const capture = output();
    expect(await runOnboardingPreparationCli([
      "start",
      "--state", "/tmp/a.sqlite",
      "--state", "/tmp/b.sqlite",
      "--input", "/tmp/input.json",
    ], capture.io)).toBe(1);
    expect(capture.stderr()).toMatch(/only once/);
  });
});
