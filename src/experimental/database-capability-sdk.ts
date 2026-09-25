import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const identifier = z.string().min(1).max(180).regex(/^[a-zA-Z0-9_.-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const databaseOperationContractSchema = z.object({
  schemaVersion: z.literal("1.0"),
  targetAlias: identifier,
  procedureKey: identifier,
  schemaHash: digest,
  requiredInputKeys: z.array(identifier).min(1).max(32),
  approvalKey: identifier,
  preUseVerifierKey: identifier,
  outcomeVerifierKey: identifier,
}).strict();
export type DatabaseOperationContract = z.infer<typeof databaseOperationContractSchema>;

export const databaseCapabilityRequestSchema = z.object({
  tenantId: identifier,
  requestId: identifier,
  parentGoalId: identifier,
  ordinaryGoal: z.string().trim().min(1).max(4_000),
  needKey: identifier,
  contractHash: digest,
  operationKey: identifier,
  input: z.record(identifier, z.string().max(2_000)),
  approvals: z.array(identifier).max(32),
  simulateLostResponseAfterCommit: z.boolean().optional(),
}).strict();
export type DatabaseCapabilityRequest = z.infer<typeof databaseCapabilityRequestSchema>;

export interface DatabaseCapabilityManifest {
  id: string;
  needKey: string;
  contractHash: string;
  targetAlias: string;
  procedureKey: string;
  requiredInputKeys: string[];
  approvalKey: string;
  preUseVerifierKey: string;
  outcomeVerifierKey: string;
  version: 1;
}

export interface DatabaseOutcomeReceipt {
  passed: boolean;
  incorrectSideEffects: number;
  stateDigest: string;
  detail: string;
}

export interface DatabaseCapabilityAdapter {
  contract: DatabaseOperationContract;
  /** Validates procedure, schema and input without committing a business write. */
  probe(manifest: DatabaseCapabilityManifest, input: Record<string, string>): Promise<{ passed: boolean; detail: string }>;
  reconcile(operationKey: string, input: Record<string, string>): Promise<"completed" | "not-started" | "unknown">;
  execute(manifest: DatabaseCapabilityManifest, operationKey: string, input: Record<string, string>): Promise<void>;
  verifyOutcome(operationKey: string, input: Record<string, string>): Promise<DatabaseOutcomeReceipt>;
}

export interface DatabaseCapabilityRecord {
  tenantId: string;
  needKey: string;
  manifest: DatabaseCapabilityManifest;
  status: "active" | "quarantined";
}

export class DatabaseCapabilityRegistry {
  private readonly database: DatabaseSync;

  constructor(databasePath = ":memory:") {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS database_capabilities (
        tenant_id TEXT NOT NULL,
        need_key TEXT NOT NULL,
        contract_hash TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'quarantined')),
        PRIMARY KEY (tenant_id, need_key)
      );
    `);
  }

  find(tenantId: string, needKey: string, contractHash: string): DatabaseCapabilityRecord | undefined {
    const row = this.database.prepare(`
      SELECT tenant_id, need_key, contract_hash, manifest_json, status
      FROM database_capabilities WHERE tenant_id = ? AND need_key = ?
    `).get(tenantId, needKey) as { tenant_id: string; need_key: string; contract_hash: string; manifest_json: string; status: "active" | "quarantined" } | undefined;
    if (!row || row.status !== "active" || row.contract_hash !== contractHash) return undefined;
    return {
      tenantId: row.tenant_id,
      needKey: row.need_key,
      manifest: JSON.parse(row.manifest_json) as DatabaseCapabilityManifest,
      status: row.status,
    };
  }

  retain(record: DatabaseCapabilityRecord): void {
    this.database.prepare(`
      INSERT INTO database_capabilities
        (tenant_id, need_key, contract_hash, manifest_json, status)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, need_key) DO UPDATE SET
        contract_hash = excluded.contract_hash,
        manifest_json = excluded.manifest_json,
        status = excluded.status
    `).run(record.tenantId, record.needKey, record.manifest.contractHash, JSON.stringify(record.manifest), record.status);
  }

  quarantine(tenantId: string, needKey: string): void {
    this.database.prepare(`
      UPDATE database_capabilities SET status = 'quarantined'
      WHERE tenant_id = ? AND need_key = ?
    `).run(tenantId, needKey);
  }

  close(): void {
    this.database.close();
  }
}

export interface DatabaseCapabilityGoalResult {
  status: "completed" | "handoff" | "unknown";
  path?: "built-capability" | "retained-reuse";
  capabilityId?: string;
  parent: { resumed: boolean; completed: boolean; summary: string };
  outcome?: DatabaseOutcomeReceipt;
}

function stableManifest(needKey: string, contract: DatabaseOperationContract): DatabaseCapabilityManifest {
  const id = createHash("sha256")
    .update(JSON.stringify({ needKey, contract }))
    .digest("hex")
    .slice(0, 24);
  return {
    id: `database-capability-${id}`,
    needKey,
    contractHash: contract.schemaHash,
    targetAlias: contract.targetAlias,
    procedureKey: contract.procedureKey,
    requiredInputKeys: [...contract.requiredInputKeys],
    approvalKey: contract.approvalKey,
    preUseVerifierKey: contract.preUseVerifierKey,
    outcomeVerifierKey: contract.outcomeVerifierKey,
    version: 1,
  };
}

function complete(path: "built-capability" | "retained-reuse", manifest: DatabaseCapabilityManifest, outcome: DatabaseOutcomeReceipt): DatabaseCapabilityGoalResult {
  return {
    status: "completed",
    path,
    capabilityId: manifest.id,
    parent: { resumed: true, completed: true, summary: "The reviewed database operation was independently verified and the original goal resumed." },
    outcome,
  };
}

function handoff(summary: string): DatabaseCapabilityGoalResult {
  return { status: "handoff", parent: { resumed: false, completed: false, summary } };
}

/**
 * Bounded database family: only a reviewed operation key may execute. No SQL,
 * table name, procedure body or credential value is generated by the model.
 */
export class ExperimentalDatabaseCapabilitySdk {
  constructor(
    private readonly registry: DatabaseCapabilityRegistry,
    private readonly adapter: DatabaseCapabilityAdapter,
  ) {}

  async completeGoal(rawRequest: unknown): Promise<DatabaseCapabilityGoalResult> {
    const request = databaseCapabilityRequestSchema.parse(rawRequest);
    const contract = databaseOperationContractSchema.parse(this.adapter.contract);
    if (request.contractHash !== contract.schemaHash) return handoff("The trusted database contract changed; a new reviewed capability is required.");
    if (!contract.requiredInputKeys.every((key) => Object.hasOwn(request.input, key))) {
      return handoff("Required reviewed-operation inputs are missing.");
    }

    const retained = this.registry.find(request.tenantId, request.needKey, request.contractHash);
    const manifest = retained?.manifest ?? stableManifest(request.needKey, contract);
    const path = retained ? "retained-reuse" : "built-capability";
    const probe = await this.adapter.probe(manifest, request.input);
    if (!probe.passed) return handoff("The reviewed database capability failed its no-write pre-use probe.");
    if (!request.approvals.includes(contract.approvalKey)) return handoff("The exact database write approval is missing.");

    const before = await this.adapter.reconcile(request.operationKey, request.input);
    if (before === "unknown") return { status: "unknown", parent: { resumed: false, completed: false, summary: "Database state is unknown; no write or blind retry was attempted." } };
    if (before === "completed") {
      const outcome = await this.adapter.verifyOutcome(request.operationKey, request.input);
      if (!outcome.passed || outcome.incorrectSideEffects !== 0) {
        this.registry.quarantine(request.tenantId, request.needKey);
        return handoff("Existing database state did not satisfy the independent outcome contract.");
      }
      this.registry.retain({ tenantId: request.tenantId, needKey: request.needKey, manifest, status: "active" });
      return complete(path, manifest, outcome);
    }

    let executionFailed = false;
    try {
      await this.adapter.execute(manifest, request.operationKey, request.input);
      if (request.simulateLostResponseAfterCommit) throw new Error("Simulated response loss after commit.");
    } catch {
      executionFailed = true;
    }
    if (executionFailed) {
      const reconciled = await this.adapter.reconcile(request.operationKey, request.input);
      if (reconciled !== "completed") {
        this.registry.quarantine(request.tenantId, request.needKey);
        return reconciled === "unknown"
          ? { status: "unknown", parent: { resumed: false, completed: false, summary: "Database commit state is unknown; the capability was quarantined and no retry occurred." } }
          : handoff("The reviewed database action did not complete and was not retried blindly.");
      }
    }

    const outcome = await this.adapter.verifyOutcome(request.operationKey, request.input);
    if (!outcome.passed || outcome.incorrectSideEffects !== 0) {
      this.registry.quarantine(request.tenantId, request.needKey);
      return handoff("The independent database outcome verifier rejected the result.");
    }
    this.registry.retain({ tenantId: request.tenantId, needKey: request.needKey, manifest, status: "active" });
    return complete(path, manifest, outcome);
  }
}
