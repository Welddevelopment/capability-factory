// WASM gate gauntlet — deterministic, $0, zero model calls.
//
// Marches four hand-assembled WebAssembly artifacts through the EXISTING
// trusted-tool gate (src/experimental/trusted-tool-sandbox.ts, untouched):
//   1. a good pinned adder — completes a real computation, retains, reuses;
//   2. an import-carrying module — REFUSED at admission (artifact.import-free);
//   3. an infinite loop — KILLED by the worker timeout, host stays alive;
//   4. a wrong-math module (i32.add flipped to i32.sub) — structurally clean,
//      caught behaviourally by the probe, and by the independent verifier
//      (with quarantine) when the probe is deliberately mis-pinned.
// Case 5 re-runs the gauntlet through the shared CapabilityModeRouter.
//
// The absence of a model is the feature being demonstrated: the sandbox leaves
// a model nothing to author, select, or decide. No API key, no BudgetTracker —
// the receipt states modelCalls: 0, spentUsd: 0 as structural literals.
//
// The three adversarial byte arrays were machine-verified against Node's real
// WebAssembly implementation before integration (imports/exports/behaviour).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CAPABILITY_MODE_SCHEMA_VERSION } from "../product/capability-mode-contract.js";
import { CapabilityModeRouter, createTrustedToolModeRunner } from "../product/capability-mode-router.js";
import {
  ExperimentalTrustedToolCapabilitySdk,
  TrustedToolCapabilityRegistry,
  TrustedToolSandbox,
  type TrustedToolArtifact,
  type TrustedToolDescriptor,
  type TrustedToolResultVerifier,
} from "../experimental/trusted-tool-sandbox.js";

// (module (func (export "add") (param i32 i32) (result i32)
//   local.get 0 local.get 1 i32.add))
const ADD_WASM = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

// (module (import "env" "host" (func))
//   (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))
const IMPORTING_ADD_WASM = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x0a, 0x02, 0x60, 0x00, 0x00, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x02, 0x0c, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x04, 0x68, 0x6f, 0x73, 0x74, 0x00, 0x00,
  0x03, 0x02, 0x01, 0x01,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x01,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

// (module (func (export "add") (param i32 i32) (result i32) (loop (br 0)) unreachable))
const LOOPING_ADD_WASM = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
  0x0a, 0x0a, 0x01, 0x08, 0x00, 0x03, 0x40, 0x0c, 0x00, 0x0b, 0x00, 0x0b,
]);

// ADD_WASM with the single opcode 0x6a (i32.add) flipped to 0x6b (i32.sub).
const SUBTRACTING_ADD_WASM = Uint8Array.from(ADD_WASM);
SUBTRACTING_ADD_WASM[SUBTRACTING_ADD_WASM.length - 2] = 0x6b;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function descriptorFor(toolId: string, bytes: Uint8Array, overrides: Partial<TrustedToolDescriptor> = {}): TrustedToolDescriptor {
  return {
    schemaVersion: "1.0",
    toolId,
    version: "1.0.0",
    artifactSha256: sha256(bytes),
    exportName: "add",
    maximumArtifactBytes: 1_024,
    maximumInputs: 2,
    timeoutMs: 1_000,
    workerMemoryMb: 16,
    probeInputs: [2, 3],
    expectedProbeOutput: 5,
    approvalKey: `run-${toolId}`,
    resultVerifierKey: "addition-verifier",
    ...overrides,
  };
}

function artifactFor(toolId: string, bytes: Uint8Array, overrides: Partial<TrustedToolDescriptor> = {}): TrustedToolArtifact {
  return { descriptor: descriptorFor(toolId, bytes, overrides), wasmBytes: bytes };
}

function requestFor(tool: TrustedToolArtifact, requestId: string, values: number[]): Record<string, unknown> {
  return {
    tenantId: "tenant-one",
    requestId,
    parentGoalId: "goal-gauntlet",
    ordinaryGoal: "Calculate the approved bounded result and continue the original goal.",
    needKey: tool.descriptor.toolId,
    contractHash: tool.descriptor.artifactSha256,
    operationKey: `calculate-${requestId}`,
    toolId: tool.descriptor.toolId,
    toolVersion: tool.descriptor.version,
    values,
    approvals: [tool.descriptor.approvalKey],
  };
}

function additionVerifier(): TrustedToolResultVerifier {
  return {
    key: "addition-verifier",
    async verify(input: number[], output: number) {
      const passed = output === input.reduce((sum, value) => sum + value, 0);
      return { passed, stateDigest: sha256(Uint8Array.from(Buffer.from(String(output)))), detail: "Independent arithmetic verification." };
    },
  };
}

interface CheckRecord {
  name: string;
  passed: boolean;
  detail: string;
}

interface CaseRecord {
  id: number;
  title: string;
  artifact: string;
  expected: string;
  firstFailedGate: string;
  checks: CheckRecord[];
  passed: boolean;
}

const cases: CaseRecord[] = [];

function startCase(id: number, title: string, artifactName: string, expected: string, firstFailedGate: string): CaseRecord {
  const record: CaseRecord = { id, title, artifact: artifactName, expected, firstFailedGate, checks: [], passed: true };
  cases.push(record);
  console.log(`\n--- Case ${id}: ${title}`);
  console.log(`    artifact: ${artifactName} | expected: ${expected}`);
  return record;
}

function check(record: CaseRecord, name: string, passed: boolean, detail: string): void {
  record.checks.push({ name, passed, detail });
  if (!passed) record.passed = false;
  console.log(`    ${passed ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

function firstFailedCheckId(checks: Array<{ id: string; passed: boolean }>): string {
  return checks.find((item) => !item.passed)?.id ?? "none";
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log("=== WASM GATE GAUNTLET ===");
  console.log("DETERMINISTIC | $0 | ZERO MODEL CALLS — no API key, no BudgetTracker, nothing to meter.");
  console.log("Four artifacts through the existing trusted-tool gate: one honest adder,");
  console.log("then an importer, an infinite loop, and a flipped-opcode subtractor.");
  console.log("The absence of a model is the point: the gate leaves a model nothing to author.");

  const sandbox = new TrustedToolSandbox();

  // ----- Case 1: pinned happy path and retention -----
  const c1 = startCase(1, "Pinned happy path and retention", "ADD_WASM", "complete, then retained-reuse", "none");
  const addTool = artifactFor("bounded-addition", ADD_WASM);
  const addProbe = await sandbox.probe(addTool);
  check(c1, "probe.passed", addProbe.passed, "hash, import-free, export and deterministic probe all hold");
  for (const id of ["artifact.hash", "artifact.import-free", "artifact.export", "artifact.probe"]) {
    const item = addProbe.checks.find((entry) => entry.id === id);
    check(c1, `probe.${id}`, item?.passed === true, `${id} passed`);
  }
  const registry1 = new TrustedToolCapabilityRegistry();
  const sdk1 = new ExperimentalTrustedToolCapabilitySdk(
    sandbox,
    registry1,
    new Map([["bounded-addition@1.0.0", addTool]]),
    new Map([["addition-verifier", additionVerifier()]]),
  );
  const first = await sdk1.completeGoal(requestFor(addTool, "first", [20, 22]));
  check(c1, "first-run.completed", first.status === "completed" && first.path === "trusted-existing", `status=${first.status} path=${String(first.path)}`);
  check(c1, "first-run.parent-resumed", first.parent.resumed === true && first.parent.completed === true, "the original goal resumed after verified compute");
  const second = await sdk1.completeGoal(requestFor(addTool, "second", [10, 5]));
  check(c1, "second-run.retained-reuse", second.status === "completed" && second.path === "retained-reuse", `status=${second.status} path=${String(second.path)}`);
  registry1.close();
  c1.firstFailedGate = firstFailedCheckId(addProbe.checks);
  check(c1, "first-failed-gate", c1.firstFailedGate === "none", `first failed gate check: ${c1.firstFailedGate}`);

  // ----- Case 2: import-carrying module refused at admission -----
  const c2 = startCase(2, "Import-carrying module refused before instantiation", "IMPORTING_ADD_WASM", "refused at artifact.import-free", "artifact.import-free");
  // Honest descriptor: the hash matches the importing bytes, so the refusal is
  // attributable to the import check alone, not to hash drift.
  const importingTool = artifactFor("importing-add", IMPORTING_ADD_WASM);
  const importingPreflight = sandbox.preflight(importingTool);
  check(c2, "preflight.refused", importingPreflight.passed === false, "preflight refuses the module");
  const importFreeCheck = importingPreflight.checks.find((item) => item.id === "artifact.import-free");
  const exportCheck = importingPreflight.checks.find((item) => item.id === "artifact.export");
  check(c2, "import-free.failed", importFreeCheck?.passed === false, "artifact.import-free is the failing check (module imports env.host)");
  check(c2, "export.passed", exportCheck?.passed === true, "the export check alone would have admitted it — imports are what stopped it");
  const executeRefusal = await sandbox.execute(importingTool, [2, 3]).then(() => "", (error: Error) => error.message);
  check(c2, "execute.refused", /preflight/.test(executeRefusal), `execute rejects: "${executeRefusal}"`);
  const registry2 = new TrustedToolCapabilityRegistry();
  const sdk2 = new ExperimentalTrustedToolCapabilitySdk(
    sandbox,
    registry2,
    new Map([["importing-add@1.0.0", importingTool]]),
    new Map([["addition-verifier", additionVerifier()]]),
  );
  const importingResult = await sdk2.completeGoal(requestFor(importingTool, "importing", [2, 3]));
  check(c2, "sdk.handoff", importingResult.status === "handoff" && /pre-use verification/.test(importingResult.parent.summary), `SDK hands off: "${importingResult.parent.summary}"`);
  registry2.close();
  const c2First = firstFailedCheckId(importingPreflight.checks);
  check(c2, "first-failed-gate", c2First === "artifact.import-free", `first failed gate check: ${c2First}`);
  c2.firstFailedGate = c2First;

  // ----- Case 3: infinite loop killed at the boundary -----
  const c3 = startCase(3, "Infinite loop killed by the worker timeout", "LOOPING_ADD_WASM", "probe times out, worker terminated, host survives", "artifact.probe (timeout)");
  const loopingTool = artifactFor("looping-add", LOOPING_ADD_WASM, { timeoutMs: 250 });
  const loopingPreflight = sandbox.preflight(loopingTool);
  check(c3, "preflight.passed", loopingPreflight.passed === true, "the module is structurally clean — structure checks cannot see the loop");
  const probeStarted = Date.now();
  const loopingProbe = await sandbox.probe(loopingTool);
  const probeMs = Date.now() - probeStarted;
  const loopingProbeCheck = loopingProbe.checks.find((item) => item.id === "artifact.probe");
  check(c3, "probe.refused", loopingProbe.passed === false && loopingProbeCheck?.passed === false, "the deterministic probe fails (timed out)");
  check(c3, "probe.timing-band", probeMs >= 250 && probeMs <= 2_000, `probe took ${probeMs}ms — >= the 250ms timeout and well under 5s, so the worker was terminated, it did not finish`);
  const loopingRefusal = await sandbox.execute(loopingTool, [2, 3]).then(() => "", (error: Error) => error.message);
  check(c3, "execute.killed", /timeout|terminated/.test(loopingRefusal), `execute rejects: "${loopingRefusal}"`);
  const registry3 = new TrustedToolCapabilityRegistry();
  const sdk3 = new ExperimentalTrustedToolCapabilitySdk(
    sandbox,
    registry3,
    new Map([["looping-add@1.0.0", loopingTool]]),
    new Map([["addition-verifier", additionVerifier()]]),
  );
  const loopingResult = await sdk3.completeGoal(requestFor(loopingTool, "looping", [2, 3]));
  check(c3, "sdk.handoff", loopingResult.status === "handoff", `SDK hands off: "${loopingResult.parent.summary}"`);
  registry3.close();
  check(c3, "host.survived", true, "this line printing IS the assertion — the worker died, not the host, and the gauntlet continues");
  c3.firstFailedGate = "artifact.probe (timeout)";

  // ----- Case 4: wrong-math module — structure passes, behaviour fails, quarantine works -----
  const c4 = startCase(4, "Flipped-opcode module caught behaviourally, then quarantined", "SUBTRACTING_ADD_WASM", "preflight clean, probe/verifier refuse, retention quarantined", "artifact.probe / verifier-quarantine");
  const subtractingTool = artifactFor("subtracting-add", SUBTRACTING_ADD_WASM);
  const subtractingPreflight = sandbox.preflight(subtractingTool);
  check(c4, "preflight.passed", subtractingPreflight.passed === true, "size, hash, import-free and export ALL pass — structure checks cannot see the flipped opcode; this is the point of the case");
  const subtractingProbe = await sandbox.probe(subtractingTool);
  const subtractingProbeCheck = subtractingProbe.checks.find((item) => item.id === "artifact.probe");
  const structuralChecksClean = subtractingProbe.checks.filter((item) => item.id !== "artifact.probe").every((item) => item.passed);
  check(c4, "probe.refused", subtractingProbe.passed === false && subtractingProbeCheck?.passed === false && structuralChecksClean, "only artifact.probe fails: add(2,3) produced -1, pinned expectation is 5");
  // Bypass demonstration: mis-pin the probe to -1 so execution proceeds, and
  // show the independent verifier rejecting and quarantining a previously
  // retained capability (mirrors the quarantine wiring in completeGoal).
  const mispinnedTool = artifactFor("subtracting-add", SUBTRACTING_ADD_WASM, { expectedProbeOutput: -1 });
  const registry4 = new TrustedToolCapabilityRegistry();
  const toolKey = "subtracting-add@1.0.0";
  registry4.retain("tenant-one", "subtracting-add", toolKey, mispinnedTool.descriptor.artifactSha256);
  check(c4, "retention.before", registry4.isRetained("tenant-one", "subtracting-add", toolKey, mispinnedTool.descriptor.artifactSha256), "the capability is retained before the bypass run (simulating a past admission)");
  const sdk4 = new ExperimentalTrustedToolCapabilitySdk(
    sandbox,
    registry4,
    new Map([[toolKey, mispinnedTool]]),
    new Map([["addition-verifier", additionVerifier()]]),
  );
  const bypassResult = await sdk4.completeGoal(requestFor(mispinnedTool, "bypass", [2, 3]));
  check(c4, "verifier.refused", bypassResult.status === "handoff" && /verifier rejected/.test(bypassResult.parent.summary), `independent verifier rejects -1 !== 2+3: "${bypassResult.parent.summary}"`);
  check(c4, "retention.quarantined", registry4.isRetained("tenant-one", "subtracting-add", toolKey, mispinnedTool.descriptor.artifactSha256) === false, "the previously retained capability flipped to quarantined");
  registry4.close();
  c4.firstFailedGate = "artifact.probe / verifier-quarantine";

  // ----- Case 5: the same gauntlet through the shared mode router -----
  const c5 = startCase(5, "Same gauntlet through the shared CapabilityModeRouter", "all four", "case 1 completes; cases 2-4 surface as handoffs, never thrown crossovers", "n/a (router boundary)");
  const registry5 = new TrustedToolCapabilityRegistry();
  const sdk5 = new ExperimentalTrustedToolCapabilitySdk(
    sandbox,
    registry5,
    new Map([
      ["bounded-addition@1.0.0", addTool],
      ["importing-add@1.0.0", importingTool],
      ["looping-add@1.0.0", loopingTool],
      ["subtracting-add@1.0.0", subtractingTool],
    ]),
    new Map([["addition-verifier", additionVerifier()]]),
  );
  const router = new CapabilityModeRouter([createTrustedToolModeRunner(sdk5)]);
  const envelope = (tool: TrustedToolArtifact, requestId: string) => ({
    schemaVersion: CAPABILITY_MODE_SCHEMA_VERSION,
    capabilityMode: "experimental-trusted-tool-actions",
    request: requestFor(tool, requestId, [40, 2]),
  });
  const routedGood = await router.execute(envelope(addTool, "routed-good"));
  check(c5, "router.good-completes", routedGood.capabilityMode === "experimental-trusted-tool-actions" && routedGood.status === "completed" && routedGood.acquisitionPath === "trusted-existing", `mode=${routedGood.capabilityMode} status=${routedGood.status} path=${String(routedGood.acquisitionPath)}`);
  for (const [name, tool] of [["importing", importingTool], ["looping", loopingTool], ["subtracting", subtractingTool]] as const) {
    const routed = await router.execute(envelope(tool, `routed-${name}`)).then(
      (result) => ({ threw: false, status: result.status }),
      () => ({ threw: true, status: "threw" }),
    );
    check(c5, `router.${name}-handoff`, !routed.threw && routed.status === "handoff", `surfaced as status=${routed.status}, not a thrown driver crossover`);
  }
  const claimBoundary = router.descriptors()[0]?.claimBoundary ?? "";
  check(c5, "claim-boundary.unchanged", /not general package installation or arbitrary code/i.test(claimBoundary), `the demo does not drift the claim: "${claimBoundary}"`);
  registry5.close();

  // ----- Receipt -----
  const passed = cases.every((item) => item.passed);
  const adversarialRefusalsFired = cases
    .filter((item) => item.id >= 2 && item.id <= 4)
    .every((item) => item.passed);
  const completedAt = new Date().toISOString();
  const report = {
    demo: "wasm-gauntlet",
    deterministic: true,
    modelCalls: 0,
    spentUsd: 0,
    startedAt,
    completedAt,
    passed,
    safetyFailure: !adversarialRefusalsFired,
    firstFailedGateByArtifact: cases.slice(0, 4).map((item) => ({ artifact: item.artifact, firstFailedGate: item.firstFailedGate })),
    cases,
  };
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  const takeDir = path.join(repoRoot, "artifacts", "wasm-gauntlet", "takes", new Date().toISOString().replaceAll(/[:.]/g, "-"));
  fs.mkdirSync(takeDir, { recursive: true });
  fs.writeFileSync(path.join(takeDir, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  // Structural zero, not a measurement: no gateway or BudgetTracker exists in
  // this process to spend anything. Written so the demo bank table shows 0/0.
  fs.writeFileSync(path.join(takeDir, "model-budget.json"), `${JSON.stringify({ spentUsd: 0, calls: 0 }, null, 2)}\n`);

  console.log("\n=== RECEIPT ===");
  for (const item of cases.slice(0, 4)) {
    console.log(`  ${item.artifact}: first failed gate check -> ${item.firstFailedGate}`);
  }
  console.log(`  modelCalls: 0 | spentUsd: 0 (structural — no model gateway in this process)`);
  console.log(`  result: ${path.join(takeDir, "result.json")}`);
  console.log(passed
    ? "\nGAUNTLET PASSED — one honest completion, three refusals, all for the documented reasons."
    : "\nGAUNTLET FAILED — see FAIL lines above; do not describe this take as green.");
  process.exitCode = passed ? 0 : 1;
}

main().catch((error) => {
  console.error("Gauntlet crashed:", error);
  process.exitCode = 1;
});
