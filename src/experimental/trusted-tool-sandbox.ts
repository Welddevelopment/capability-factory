import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { z } from "zod";

const identifier = z.string().min(1).max(180).regex(/^[a-zA-Z0-9_.-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

interface WasmModuleDescription {
  kind: string;
  name: string;
}

interface WasmModuleConstructor {
  new(bytes: Uint8Array): unknown;
  imports(module: unknown): WasmModuleDescription[];
  exports(module: unknown): WasmModuleDescription[];
}

const webAssembly = (globalThis as unknown as {
  WebAssembly: { Module: WasmModuleConstructor };
}).WebAssembly;

export const trustedToolDescriptorSchema = z.object({
  schemaVersion: z.literal("1.0"),
  toolId: identifier,
  version: identifier,
  artifactSha256: digest,
  exportName: identifier,
  maximumArtifactBytes: z.number().int().min(8).max(1_048_576),
  maximumInputs: z.number().int().min(1).max(16),
  timeoutMs: z.number().int().min(10).max(5_000),
  workerMemoryMb: z.number().int().min(8).max(128),
  probeInputs: z.array(z.number().int()).min(1).max(16),
  expectedProbeOutput: z.number().int(),
  approvalKey: identifier,
  resultVerifierKey: identifier,
}).strict();
export type TrustedToolDescriptor = z.infer<typeof trustedToolDescriptorSchema>;

export interface TrustedToolArtifact {
  descriptor: TrustedToolDescriptor;
  wasmBytes: Uint8Array;
}

export interface TrustedToolPreflight {
  passed: boolean;
  checks: Array<{ id: string; passed: boolean; detail: string }>;
}

export interface TrustedToolExecutionReceipt {
  toolId: string;
  version: string;
  artifactSha256: string;
  output: number;
  durationMs: number;
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  try {
    const bytes = Uint8Array.from(workerData.bytes);
    const module = await WebAssembly.compile(bytes);
    const instance = await WebAssembly.instantiate(module, {});
    const fn = instance.exports[workerData.exportName];
    if (typeof fn !== 'function') throw new Error('Approved export is unavailable.');
    const output = fn(...workerData.inputs);
    if (typeof output !== 'number' || !Number.isInteger(output)) throw new Error('Tool output must be one integer.');
    parentPort.postMessage({ ok: true, output });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
})();`;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Import-free WebAssembly is used as the first residual compute boundary. With
 * no WASI or JavaScript imports the guest has no filesystem, network, process,
 * environment or credential API. A worker timeout contains infinite loops.
 */
export class TrustedToolSandbox {
  preflight(rawArtifact: TrustedToolArtifact): TrustedToolPreflight {
    const descriptor = trustedToolDescriptorSchema.parse(rawArtifact.descriptor);
    const checks = [
      {
        id: "artifact.size",
        passed: rawArtifact.wasmBytes.byteLength <= descriptor.maximumArtifactBytes,
        detail: "The WebAssembly artifact must remain inside its pinned byte ceiling.",
      },
      {
        id: "artifact.hash",
        passed: sha256(rawArtifact.wasmBytes) === descriptor.artifactSha256,
        detail: "The WebAssembly artifact must match the trusted provenance hash.",
      },
    ];
    try {
      const module = new webAssembly.Module(rawArtifact.wasmBytes);
      const imports = webAssembly.Module.imports(module);
      const exports = webAssembly.Module.exports(module);
      checks.push({
        id: "artifact.import-free",
        passed: imports.length === 0,
        detail: "The residual tool must import no host, WASI, filesystem, network, environment or credential functions.",
      });
      checks.push({
        id: "artifact.export",
        passed: exports.some((item) => item.kind === "function" && item.name === descriptor.exportName),
        detail: "The exact allowlisted function export must exist.",
      });
    } catch {
      checks.push({ id: "artifact.valid-wasm", passed: false, detail: "The artifact is not valid WebAssembly." });
    }
    return { passed: checks.every((check) => check.passed), checks };
  }

  async execute(rawArtifact: TrustedToolArtifact, inputs: number[]): Promise<TrustedToolExecutionReceipt> {
    const descriptor = trustedToolDescriptorSchema.parse(rawArtifact.descriptor);
    const preflight = this.preflight(rawArtifact);
    if (!preflight.passed) throw new Error("Trusted tool preflight failed.");
    if (inputs.length < 1 || inputs.length > descriptor.maximumInputs || inputs.some((value) => !Number.isInteger(value))) {
      throw new Error("Trusted tool inputs exceed the bounded integer contract.");
    }
    const started = Date.now();
    const output = await new Promise<number>((resolve, reject) => {
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { bytes: [...rawArtifact.wasmBytes], exportName: descriptor.exportName, inputs },
        resourceLimits: {
          maxOldGenerationSizeMb: descriptor.workerMemoryMb,
          maxYoungGenerationSizeMb: Math.min(16, descriptor.workerMemoryMb),
          stackSizeMb: 2,
        },
      });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        void worker.terminate();
        reject(new Error("Trusted tool execution exceeded its timeout and was terminated."));
      }, descriptor.timeoutMs);
      worker.once("message", (message: { ok: boolean; output?: number; error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        if (!message.ok || !Number.isInteger(message.output)) reject(new Error(message.error ?? "Trusted tool failed."));
        else resolve(message.output!);
      });
      worker.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      worker.once("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Trusted tool worker exited before a result (${code}).`));
      });
    });
    return {
      toolId: descriptor.toolId,
      version: descriptor.version,
      artifactSha256: descriptor.artifactSha256,
      output,
      durationMs: Date.now() - started,
    };
  }

  async probe(artifact: TrustedToolArtifact): Promise<TrustedToolPreflight> {
    const preflight = this.preflight(artifact);
    if (!preflight.passed) return preflight;
    try {
      const result = await this.execute(artifact, artifact.descriptor.probeInputs);
      const probePassed = result.output === artifact.descriptor.expectedProbeOutput;
      return {
        passed: probePassed,
        checks: [...preflight.checks, {
          id: "artifact.probe",
          passed: probePassed,
          detail: "The isolated deterministic probe must produce the pinned expected result.",
        }],
      };
    } catch {
      return {
        passed: false,
        checks: [...preflight.checks, { id: "artifact.probe", passed: false, detail: "The isolated deterministic probe failed or timed out." }],
      };
    }
  }
}

export interface TrustedToolResultVerifier {
  key: string;
  verify(input: number[], output: number): Promise<{ passed: boolean; stateDigest: string; detail: string }>;
}

export const trustedToolCapabilityRequestSchema = z.object({
  tenantId: identifier,
  requestId: identifier,
  parentGoalId: identifier,
  ordinaryGoal: z.string().trim().min(1).max(4_000),
  needKey: identifier,
  contractHash: digest,
  operationKey: identifier,
  toolId: identifier,
  toolVersion: identifier,
  values: z.array(z.number().int()).min(1).max(16),
  approvals: z.array(identifier).max(32),
}).strict();
export type TrustedToolCapabilityRequest = z.infer<typeof trustedToolCapabilityRequestSchema>;

export class TrustedToolCapabilityRegistry {
  private readonly database: DatabaseSync;

  constructor(databasePath = ":memory:") {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS trusted_tool_capabilities (
        tenant_id TEXT NOT NULL,
        need_key TEXT NOT NULL,
        tool_key TEXT NOT NULL,
        artifact_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'quarantined')),
        PRIMARY KEY (tenant_id, need_key)
      );
    `);
  }

  isRetained(tenantId: string, needKey: string, toolKey: string, artifactHash: string): boolean {
    const row = this.database.prepare(`
      SELECT tool_key, artifact_hash, status FROM trusted_tool_capabilities
      WHERE tenant_id = ? AND need_key = ?
    `).get(tenantId, needKey) as { tool_key: string; artifact_hash: string; status: "active" | "quarantined" } | undefined;
    return row?.status === "active" && row.tool_key === toolKey && row.artifact_hash === artifactHash;
  }

  retain(tenantId: string, needKey: string, toolKey: string, artifactHash: string): void {
    this.database.prepare(`
      INSERT INTO trusted_tool_capabilities (tenant_id, need_key, tool_key, artifact_hash, status)
      VALUES (?, ?, ?, ?, 'active')
      ON CONFLICT (tenant_id, need_key) DO UPDATE SET
        tool_key = excluded.tool_key,
        artifact_hash = excluded.artifact_hash,
        status = 'active'
    `).run(tenantId, needKey, toolKey, artifactHash);
  }

  quarantine(tenantId: string, needKey: string): void {
    this.database.prepare(`
      UPDATE trusted_tool_capabilities SET status = 'quarantined'
      WHERE tenant_id = ? AND need_key = ?
    `).run(tenantId, needKey);
  }

  close(): void {
    this.database.close();
  }
}

export interface TrustedToolGoalResult {
  status: "completed" | "handoff";
  path?: "trusted-existing" | "retained-reuse";
  capabilityId?: string;
  parent: { resumed: boolean; completed: boolean; summary: string };
}

export class ExperimentalTrustedToolCapabilitySdk {
  constructor(
    private readonly sandbox: TrustedToolSandbox,
    private readonly registry: TrustedToolCapabilityRegistry,
    private readonly catalog: Map<string, TrustedToolArtifact>,
    private readonly verifiers: Map<string, TrustedToolResultVerifier>,
  ) {}

  async completeGoal(rawInput: unknown): Promise<TrustedToolGoalResult> {
    const input = trustedToolCapabilityRequestSchema.parse(rawInput);
    const key = `${input.toolId}@${input.toolVersion}`;
    const artifact = this.catalog.get(key);
    if (!artifact || artifact.descriptor.version !== input.toolVersion) return this.handoff("No pinned trusted tool matches the required capability.");
    if (input.contractHash !== artifact.descriptor.artifactSha256) return this.handoff("The trusted tool artifact no longer matches the approved contract hash.");
    const probe = await this.sandbox.probe(artifact);
    if (!probe.passed) return this.handoff("The pinned tool failed isolated pre-use verification.");
    if (!input.approvals.includes(artifact.descriptor.approvalKey)) return this.handoff("The exact trusted-tool execution approval is missing.");
    const verifier = this.verifiers.get(artifact.descriptor.resultVerifierKey);
    if (!verifier) return this.handoff("No independent result verifier is configured for the trusted tool.");
    const retained = this.registry.isRetained(input.tenantId, input.needKey, key, artifact.descriptor.artifactSha256);
    let result: TrustedToolExecutionReceipt;
    try {
      result = await this.sandbox.execute(artifact, input.values);
    } catch {
      return this.handoff("The isolated trusted tool failed or exceeded its execution boundary.");
    }
    const outcome = await verifier.verify(input.values, result.output);
    if (!outcome.passed) {
      this.registry.quarantine(input.tenantId, input.needKey);
      return this.handoff("The independent trusted-tool result verifier rejected the output.");
    }
    const path = retained ? "retained-reuse" : "trusted-existing";
    this.registry.retain(input.tenantId, input.needKey, key, artifact.descriptor.artifactSha256);
    return {
      status: "completed",
      path,
      capabilityId: `trusted-tool-${artifact.descriptor.artifactSha256.slice(0, 24)}`,
      parent: { resumed: true, completed: true, summary: "The isolated trusted tool produced an independently verified result and the original goal resumed." },
    };
  }

  private handoff(summary: string): TrustedToolGoalResult {
    return { status: "handoff", parent: { resumed: false, completed: false, summary } };
  }
}
