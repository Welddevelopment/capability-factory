import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CAPABILITY_MODE_SCHEMA_VERSION } from "../src/product/capability-mode-contract.js";
import { CapabilityModeRouter, createTrustedToolModeRunner } from "../src/product/capability-mode-router.js";
import {
  ExperimentalTrustedToolCapabilitySdk,
  TrustedToolCapabilityRegistry,
  TrustedToolSandbox,
  type TrustedToolArtifact,
} from "../src/experimental/trusted-tool-sandbox.js";

// (module (func (export "add") (param i32 i32) (result i32)
//   local.get 0 local.get 1 i32.add))
const ADD_WASM = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

function artifact(): TrustedToolArtifact {
  return {
    descriptor: {
      schemaVersion: "1.0",
      toolId: "bounded-addition",
      version: "1.0.0",
      artifactSha256: createHash("sha256").update(ADD_WASM).digest("hex"),
      exportName: "add",
      maximumArtifactBytes: 1_024,
      maximumInputs: 2,
      timeoutMs: 1_000,
      workerMemoryMb: 16,
      probeInputs: [2, 3],
      expectedProbeOutput: 5,
      approvalKey: "run-bounded-addition",
      resultVerifierKey: "addition-verifier",
    },
    wasmBytes: ADD_WASM,
  };
}

function requestFor(tool: TrustedToolArtifact, values: number[], approvals = ["run-bounded-addition"]) {
  return {
    tenantId: "tenant-one",
    requestId: `request-${values.join("-")}`,
    parentGoalId: "goal-one",
    ordinaryGoal: "Calculate the approved bounded result and continue the original goal.",
    needKey: "bounded-addition",
    contractHash: tool.descriptor.artifactSha256,
    operationKey: `calculate-${values.join("-")}`,
    toolId: "bounded-addition",
    toolVersion: "1.0.0",
    values,
    approvals,
  };
}

function verifier() {
  return {
    key: "addition-verifier",
    async verify(input: number[], output: number) {
      const passed = output === input.reduce((sum, value) => sum + value, 0);
      return { passed, stateDigest: createHash("sha256").update(String(output)).digest("hex"), detail: "Independent arithmetic verification." };
    },
  };
}

describe("import-free trusted-tool WebAssembly sandbox", () => {
  it("pins provenance, imports no host powers, probes, executes and independently verifies before resumption", async () => {
    const tool = artifact();
    const sandbox = new TrustedToolSandbox();
    const probe = await sandbox.probe(tool);
    expect(probe.passed).toBe(true);
    expect(probe.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "artifact.hash", passed: true }),
      expect.objectContaining({ id: "artifact.import-free", passed: true }),
      expect.objectContaining({ id: "artifact.probe", passed: true }),
    ]));

    const sdk = new ExperimentalTrustedToolCapabilitySdk(
      sandbox,
      new TrustedToolCapabilityRegistry(),
      new Map([["bounded-addition@1.0.0", tool]]),
      new Map([["addition-verifier", verifier()]]),
    );
    expect(await sdk.completeGoal(requestFor(tool, [20, 22]))).toMatchObject({
      status: "completed", path: "trusted-existing", parent: { resumed: true, completed: true },
    });
    expect(await sdk.completeGoal(requestFor(tool, [10, 5]))).toMatchObject({
      status: "completed", path: "retained-reuse",
    });
  });

  it("rejects hash drift, missing exports, unbounded inputs and absent independent verifiers", async () => {
    const sandbox = new TrustedToolSandbox();
    const drifted = artifact();
    drifted.descriptor.artifactSha256 = "f".repeat(64);
    expect(sandbox.preflight(drifted).passed).toBe(false);
    await expect(sandbox.execute(drifted, [1, 2])).rejects.toThrow(/preflight/);

    const wrongExport = artifact();
    wrongExport.descriptor.exportName = "deleteEverything";
    expect(sandbox.preflight(wrongExport).passed).toBe(false);

    await expect(sandbox.execute(artifact(), [1, 2, 3])).rejects.toThrow(/inputs/);
    const tool = artifact();
    const sdk = new ExperimentalTrustedToolCapabilitySdk(
      sandbox,
      new TrustedToolCapabilityRegistry(),
      new Map([["bounded-addition@1.0.0", tool]]),
      new Map(),
    );
    expect(await sdk.completeGoal({
      tenantId: "tenant-one",
      requestId: "request-one",
      parentGoalId: "goal-one",
      ordinaryGoal: "Calculate one approved bounded result.",
      needKey: "bounded-addition",
      contractHash: tool.descriptor.artifactSha256,
      operationKey: "calculate-one",
      toolId: "bounded-addition",
      toolVersion: "1.0.0",
      values: [1, 2],
      approvals: ["run-bounded-addition"],
    })).toMatchObject({ status: "handoff" });
  });

  it("requires the exact approval and preserves verified retention across a fresh process registry", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-trusted-tool-"));
    const databasePath = join(directory, "registry.sqlite");
    const tool = artifact();
    try {
      const firstRegistry = new TrustedToolCapabilityRegistry(databasePath);
      const firstSdk = new ExperimentalTrustedToolCapabilitySdk(
        new TrustedToolSandbox(),
        firstRegistry,
        new Map([["bounded-addition@1.0.0", tool]]),
        new Map([["addition-verifier", verifier()]]),
      );
      expect(await firstSdk.completeGoal(requestFor(tool, [3, 4], []))).toMatchObject({ status: "handoff" });
      expect(await firstSdk.completeGoal(requestFor(tool, [3, 4]))).toMatchObject({ status: "completed", path: "trusted-existing" });
      firstRegistry.close();

      const recoveredRegistry = new TrustedToolCapabilityRegistry(databasePath);
      const recoveredSdk = new ExperimentalTrustedToolCapabilitySdk(
        new TrustedToolSandbox(),
        recoveredRegistry,
        new Map([["bounded-addition@1.0.0", tool]]),
        new Map([["addition-verifier", verifier()]]),
      );
      expect(await recoveredSdk.completeGoal(requestFor(tool, [8, 9]))).toMatchObject({ status: "completed", path: "retained-reuse" });
      recoveredRegistry.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("runs through the strict shared mode router without crossing its family boundary", async () => {
    const tool = artifact();
    const sdk = new ExperimentalTrustedToolCapabilitySdk(
      new TrustedToolSandbox(),
      new TrustedToolCapabilityRegistry(),
      new Map([["bounded-addition@1.0.0", tool]]),
      new Map([["addition-verifier", verifier()]]),
    );
    const router = new CapabilityModeRouter([createTrustedToolModeRunner(sdk)]);
    const result = await router.execute({
      schemaVersion: CAPABILITY_MODE_SCHEMA_VERSION,
      capabilityMode: "experimental-trusted-tool-actions",
      request: requestFor(tool, [40, 2]),
    });
    expect(result).toMatchObject({
      capabilityMode: "experimental-trusted-tool-actions",
      status: "completed",
      parentResumed: true,
      parentCompleted: true,
      acquisitionPath: "trusted-existing",
    });
    expect(router.descriptors()[0]?.claimBoundary).toMatch(/not general package installation or arbitrary code/i);
  });
});
