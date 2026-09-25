import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFileTransferPilotAcceptanceHarness } from "../src/customer-world/file-transfer-pilot-acceptance.js";
import { runPilotAdapterAcceptanceHarness } from "../src/product/pilot-adapter.js";

const enabled = process.env.CF_REAL_NETWORK_FILE === "1";

describe("file/EDI parity acceptance", () => {
  (enabled ? it : it.skip)("executes all ten mandatory cases with zero surviving incorrect side effects", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-file-parity-"));
    try {
      const result = await runPilotAdapterAcceptanceHarness(createFileTransferPilotAcceptanceHarness(root));
      expect(result).toMatchObject({ passed: true, requiredCases: 10, completedCases: 10, failedCases: [], notRunCases: [], incorrectSideEffects: 0, abortedForSafety: false });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
});
