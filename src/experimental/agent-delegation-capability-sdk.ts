import { createHash, verify as verifySignature } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const identifier = z.string().min(1).max(180).regex(/^[a-zA-Z0-9_.-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const agentDelegateContractSchema = z.object({
  schemaVersion: z.literal("1.0"),
  delegateId: identifier,
  version: identifier,
  contractHash: digest,
  publicKeyPem: z.string().min(80).max(8_000),
  publicKeySha256: digest,
  allowedTaskKeys: z.array(identifier).min(1).max(32),
  approvalKey: identifier,
  preUseVerifierKey: identifier,
  outcomeVerifierKey: identifier,
  timeoutMs: z.number().int().min(10).max(30_000),
}).strict();
export type AgentDelegateContract = z.infer<typeof agentDelegateContractSchema>;

export const agentDelegationRequestSchema = z.object({
  tenantId: identifier,
  requestId: identifier,
  parentGoalId: identifier,
  ordinaryGoal: z.string().trim().min(1).max(4_000),
  needKey: identifier,
  contractHash: digest,
  operationKey: identifier,
  delegateId: identifier,
  delegateVersion: identifier,
  taskKey: identifier,
  input: z.record(identifier, z.string().max(2_000)),
  approvals: z.array(identifier).max(32),
  simulateLostResponseAfterCommit: z.boolean().optional(),
}).strict();
export type AgentDelegationRequest = z.infer<typeof agentDelegationRequestSchema>;

export const signedDelegateReceiptBodySchema = z.object({
  schemaVersion: z.literal("1.0"),
  delegateId: identifier,
  delegateVersion: identifier,
  operationKey: identifier,
  taskKey: identifier,
  inputDigest: digest,
  status: z.literal("completed"),
  completedAt: z.string().datetime(),
  resultDigest: digest,
}).strict();
export type SignedDelegateReceiptBody = z.infer<typeof signedDelegateReceiptBodySchema>;

export const signedDelegateReceiptSchema = signedDelegateReceiptBodySchema.extend({
  signatureBase64: z.string().min(40).max(2_000),
}).strict();
export type SignedDelegateReceipt = z.infer<typeof signedDelegateReceiptSchema>;

export interface AgentDelegateAdapter {
  contract: AgentDelegateContract;
  probe(taskKey: string): Promise<{ passed: boolean; detail: string }>;
  reconcile(operationKey: string): Promise<
    | { status: "not-started" | "unknown" }
    | { status: "completed"; receipt: SignedDelegateReceipt }
  >;
  execute(input: {
    operationKey: string;
    taskKey: string;
    values: Record<string, string>;
  }): Promise<SignedDelegateReceipt>;
}

export interface AgentDelegateOutcomeVerifier {
  key: string;
  verifyOutcome(operationKey: string, input: Record<string, string>): Promise<{
    passed: boolean;
    incorrectSideEffects: number;
    stateDigest: string;
    detail: string;
  }>;
}

export class AgentDelegationRegistry {
  private readonly database: DatabaseSync;

  constructor(databasePath = ":memory:") {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS agent_delegation_capabilities (
        tenant_id TEXT NOT NULL,
        need_key TEXT NOT NULL,
        delegate_id TEXT NOT NULL,
        delegate_version TEXT NOT NULL,
        contract_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'quarantined')),
        PRIMARY KEY (tenant_id, need_key)
      );
    `);
  }

  isRetained(input: { tenantId: string; needKey: string; delegateId: string; delegateVersion: string; contractHash: string }): boolean {
    const row = this.database.prepare(`
      SELECT delegate_id, delegate_version, contract_hash, status
      FROM agent_delegation_capabilities WHERE tenant_id = ? AND need_key = ?
    `).get(input.tenantId, input.needKey) as {
      delegate_id: string;
      delegate_version: string;
      contract_hash: string;
      status: "active" | "quarantined";
    } | undefined;
    return row?.status === "active"
      && row.delegate_id === input.delegateId
      && row.delegate_version === input.delegateVersion
      && row.contract_hash === input.contractHash;
  }

  retain(input: { tenantId: string; needKey: string; delegateId: string; delegateVersion: string; contractHash: string }): void {
    this.database.prepare(`
      INSERT INTO agent_delegation_capabilities
        (tenant_id, need_key, delegate_id, delegate_version, contract_hash, status)
      VALUES (?, ?, ?, ?, ?, 'active')
      ON CONFLICT (tenant_id, need_key) DO UPDATE SET
        delegate_id = excluded.delegate_id,
        delegate_version = excluded.delegate_version,
        contract_hash = excluded.contract_hash,
        status = 'active'
    `).run(input.tenantId, input.needKey, input.delegateId, input.delegateVersion, input.contractHash);
  }

  quarantine(tenantId: string, needKey: string): void {
    this.database.prepare(`
      UPDATE agent_delegation_capabilities SET status = 'quarantined'
      WHERE tenant_id = ? AND need_key = ?
    `).run(tenantId, needKey);
  }

  close(): void {
    this.database.close();
  }
}

export interface AgentDelegationGoalResult {
  status: "completed" | "handoff" | "unknown";
  path?: "trusted-delegate" | "retained-reuse";
  capabilityId?: string;
  parent: { resumed: boolean; completed: boolean; summary: string };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function computeAgentDelegateContractHash(input: Omit<AgentDelegateContract, "contractHash">): string {
  return sha256(JSON.stringify({
    schemaVersion: input.schemaVersion,
    delegateId: input.delegateId,
    version: input.version,
    publicKeySha256: input.publicKeySha256,
    allowedTaskKeys: [...input.allowedTaskKeys].sort(),
    approvalKey: input.approvalKey,
    preUseVerifierKey: input.preUseVerifierKey,
    outcomeVerifierKey: input.outcomeVerifierKey,
    timeoutMs: input.timeoutMs,
  }));
}

function inputDigest(input: Record<string, string>): string {
  return sha256(JSON.stringify(Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)))));
}

export function canonicalDelegateReceiptBytes(body: SignedDelegateReceiptBody): Buffer {
  return Buffer.from(JSON.stringify(body));
}

function verifyReceipt(receipt: SignedDelegateReceipt, contract: AgentDelegateContract, request: AgentDelegationRequest): boolean {
  const parsed = signedDelegateReceiptSchema.safeParse(receipt);
  if (!parsed.success) return false;
  const { signatureBase64, ...body } = parsed.data;
  if (
    body.delegateId !== contract.delegateId
    || body.delegateVersion !== contract.version
    || body.operationKey !== request.operationKey
    || body.taskKey !== request.taskKey
    || body.inputDigest !== inputDigest(request.input)
  ) return false;
  try {
    return verifySignature(null, canonicalDelegateReceiptBytes(body), contract.publicKeyPem, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded the trusted timeout.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function handoff(summary: string): AgentDelegationGoalResult {
  return { status: "handoff", parent: { resumed: false, completed: false, summary } };
}

/**
 * Bounded delegation never treats the delegate's signed receipt as outcome
 * proof. The signature authenticates who reported completion; a separately
 * configured observer must still prove the real external result.
 */
export class ExperimentalAgentDelegationCapabilitySdk {
  constructor(
    private readonly registry: AgentDelegationRegistry,
    private readonly delegates: Map<string, AgentDelegateAdapter>,
    private readonly outcomeVerifiers: Map<string, AgentDelegateOutcomeVerifier>,
  ) {}

  async completeGoal(rawRequest: unknown): Promise<AgentDelegationGoalResult> {
    const request = agentDelegationRequestSchema.parse(rawRequest);
    const delegateKey = `${request.delegateId}@${request.delegateVersion}`;
    const delegate = this.delegates.get(delegateKey);
    if (!delegate) return handoff("No trusted delegate matches the required bounded task.");
    const contract = agentDelegateContractSchema.parse(delegate.contract);
    if (
      contract.delegateId !== request.delegateId
      || contract.version !== request.delegateVersion
      || contract.contractHash !== request.contractHash
      || contract.contractHash !== computeAgentDelegateContractHash(contract)
      || sha256(contract.publicKeyPem) !== contract.publicKeySha256
    ) return handoff("The trusted delegate identity, version, contract or signing key changed.");
    if (!contract.allowedTaskKeys.includes(request.taskKey)) return handoff("The requested task is outside the delegate's reviewed contract.");
    const verifier = this.outcomeVerifiers.get(contract.outcomeVerifierKey);
    if (!verifier || verifier.key !== contract.outcomeVerifierKey) return handoff("No independent external-outcome verifier is configured for the delegate.");
    let probe: { passed: boolean; detail: string };
    try {
      probe = await withTimeout(delegate.probe(request.taskKey), contract.timeoutMs, "Delegate probe");
    } catch {
      return handoff("The delegate failed its bounded pre-use probe.");
    }
    if (!probe.passed) return handoff("The delegate failed its bounded pre-use probe.");
    if (!request.approvals.includes(contract.approvalKey)) return handoff("The exact delegation approval is missing.");

    const retained = this.registry.isRetained({
      tenantId: request.tenantId,
      needKey: request.needKey,
      delegateId: request.delegateId,
      delegateVersion: request.delegateVersion,
      contractHash: request.contractHash,
    });
    let reconciled = await withTimeout(delegate.reconcile(request.operationKey), contract.timeoutMs, "Delegate reconciliation")
      .catch(() => ({ status: "unknown" as const }));
    if (reconciled.status === "unknown") {
      return { status: "unknown", parent: { resumed: false, completed: false, summary: "Delegate state is unknown; no blind retry was attempted." } };
    }
    let receipt: SignedDelegateReceipt;
    if (reconciled.status === "completed") {
      receipt = reconciled.receipt;
    } else {
      try {
        receipt = await withTimeout(delegate.execute({ operationKey: request.operationKey, taskKey: request.taskKey, values: request.input }), contract.timeoutMs, "Delegate execution");
        if (request.simulateLostResponseAfterCommit) throw new Error("Simulated lost response after delegated commit.");
      } catch {
        reconciled = await withTimeout(delegate.reconcile(request.operationKey), contract.timeoutMs, "Post-error delegate reconciliation")
          .catch(() => ({ status: "unknown" as const }));
        if (reconciled.status !== "completed") {
          this.registry.quarantine(request.tenantId, request.needKey);
          return reconciled.status === "unknown"
            ? { status: "unknown", parent: { resumed: false, completed: false, summary: "Delegated outcome is unknown; the route was quarantined and no blind retry occurred." } }
            : handoff("The delegated task did not complete and was not retried blindly.");
        }
        receipt = reconciled.receipt;
      }
    }
    if (!verifyReceipt(receipt, contract, request)) {
      this.registry.quarantine(request.tenantId, request.needKey);
      return handoff("The delegate completion receipt failed pinned-signature or request-identity verification.");
    }
    const outcome = await verifier.verifyOutcome(request.operationKey, request.input)
      .catch(() => ({ passed: false, incorrectSideEffects: 0, stateDigest: "", detail: "Outcome verifier failed." }));
    if (!outcome.passed || outcome.incorrectSideEffects !== 0 || !/^[a-f0-9]{64}$/.test(outcome.stateDigest)) {
      this.registry.quarantine(request.tenantId, request.needKey);
      return handoff("The independent external-outcome verifier rejected the delegated result.");
    }
    this.registry.retain({
      tenantId: request.tenantId,
      needKey: request.needKey,
      delegateId: request.delegateId,
      delegateVersion: request.delegateVersion,
      contractHash: request.contractHash,
    });
    return {
      status: "completed",
      path: retained ? "retained-reuse" : "trusted-delegate",
      capabilityId: `delegate-capability-${sha256(JSON.stringify({ delegateKey, contractHash: contract.contractHash })).slice(0, 24)}`,
      parent: { resumed: true, completed: true, summary: "The signed delegated task passed independent external verification and the original goal resumed." },
    };
  }
}
