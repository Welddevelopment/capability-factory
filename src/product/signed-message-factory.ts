import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { composedRecoveryDigest } from "./composed-runtime-recovery.js";

const identifier = z.string().min(1).max(180).regex(/^[a-zA-Z0-9_.@-]+$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });
const algorithmSchema = z.enum(["hmac-sha256", "hmac-sha512"]);
export type SignedMessageAlgorithm = z.infer<typeof algorithmSchema>;

const orderSchema = z.object({
  schemaVersion: z.literal("1"), sequence: z.number().int().positive(), purchaseOrderNumber: identifier,
  shipToCode: identifier, lines: z.array(z.object({ lineNumber: z.number().int().positive(), itemCode: identifier, quantity: z.number().int().positive() }).strict()).min(1).max(100),
}).strict().superRefine((value, context) => {
  if (value.lines.some((line, index) => line.lineNumber !== index + 1)) context.addIssue({ code: "custom", message: "Signed message line numbers must be contiguous." });
});
export type SignedMessageOrder = z.infer<typeof orderSchema>;

const trustKeySchema = z.object({
  keyId: identifier, algorithm: algorithmSchema, keyDigest: digestSchema,
  status: z.enum(["active", "revoked"]), notBefore: timestampSchema, expiresAt: timestampSchema,
}).strict();
export const signedMessageContractSchema = z.object({
  schemaVersion: z.literal("1.0"), contractId: identifier, contractVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  tenantId: identifier, envelope: z.enum(["canonical-json-detached-v1", "fixed-header-embedded-v1"]),
  algorithm: algorithmSchema, trustPolicyId: identifier, keys: z.array(trustKeySchema).min(1),
  maximumAgeMs: z.number().int().positive().max(30 * 24 * 60 * 60 * 1_000),
  maximumFutureSkewMs: z.number().int().nonnegative().max(60 * 60 * 1_000),
  orderingPolicy: z.enum(["strict-monotonic", "unique-message-only"]),
  allowedItemCodes: z.array(identifier).min(1), maxQuantityPerLine: z.number().int().positive(),
  targetAlias: identifier, actionKey: identifier, approvalKey: identifier,
  outcomeVerifierKey: identifier, workflowKey: identifier,
}).strict().superRefine((value, context) => {
  if (value.keys.some((key) => key.algorithm !== value.algorithm)) context.addIssue({ code: "custom", message: "Every trusted key must use the contract algorithm." });
  if (new Set(value.keys.map((key) => key.keyId)).size !== value.keys.length) context.addIssue({ code: "custom", message: "Trusted key IDs must be unique." });
  if (new Set(value.allowedItemCodes).size !== value.allowedItemCodes.length) context.addIssue({ code: "custom", message: "Allowed item codes must be unique." });
});
export type SignedMessageContract = z.infer<typeof signedMessageContractSchema>;

export interface SignedMessageMetadata { algorithm: SignedMessageAlgorithm; keyId: string; sentAt: string; nonce: string; messageId: string }
export interface SignedMessageFixtureInput extends SignedMessageMetadata { payload: SignedMessageOrder; key: Uint8Array }
export interface SignedMessageKeyResolver { resolve(tenantId: string, trustPolicyId: string, keyId: string): Uint8Array | undefined }

export interface SignedMessageProposal {
  schemaVersion: "1.0"; proposalId: string; tenantId: string; parentGoalId: string; planId: string;
  planDigest: string; workItemId: string; contractId: string; contractVersion: string;
  contractDigest: string; envelope: SignedMessageContract["envelope"]; algorithm: SignedMessageAlgorithm;
  keyId: string; sentAt: string; nonce: string; messageId: string; messageDigest: string;
  payload: SignedMessageOrder; payloadDigest: string; trustEvidenceDigest: string;
  capabilityMaterialDigest: string; targetAlias: string; actionKey: string; approvalKey: string;
  workflowKey: string; proposedAt: string; proposalDigest: string;
}
function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  throw new Error("Signed message material must be plain structured data.");
}
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
function hmacName(algorithm: SignedMessageAlgorithm): "sha256" | "sha512" { return algorithm === "hmac-sha256" ? "sha256" : "sha512"; }
function sign(algorithm: SignedMessageAlgorithm, key: Uint8Array, value: string): string { return createHmac(hmacName(algorithm), key).update(value).digest("hex"); }

function fixedBody(payload: SignedMessageOrder): string {
  return ["ORDER", `SCHEMA=${payload.schemaVersion}`, `SEQUENCE=${payload.sequence}`, `PO=${payload.purchaseOrderNumber}`, `SHIP_TO=${payload.shipToCode}`,
    ...payload.lines.map((line) => `LINE=${line.lineNumber}|${line.itemCode}|${line.quantity}`), "END ORDER"].join("\n");
}

function signedMaterial(metadata: SignedMessageMetadata, payload: SignedMessageOrder, envelope: SignedMessageContract["envelope"]): string {
  if (envelope === "canonical-json-detached-v1") return canonical({ ...metadata, payload });
  return [`ALGORITHM: ${metadata.algorithm}`, `KEY-ID: ${metadata.keyId}`, `SENT-AT: ${metadata.sentAt}`, `NONCE: ${metadata.nonce}`, `MESSAGE-ID: ${metadata.messageId}`, "", fixedBody(payload)].join("\n");
}

export function createSignedMessageFixture(contract: SignedMessageContract, input: SignedMessageFixtureInput): string {
  const safe = signedMessageContractSchema.parse(contract); const payload = orderSchema.parse(input.payload);
  const metadata: SignedMessageMetadata = { algorithm: input.algorithm, keyId: input.keyId, sentAt: input.sentAt, nonce: input.nonce, messageId: input.messageId };
  const signature = sign(input.algorithm, input.key, signedMaterial(metadata, payload, safe.envelope));
  if (safe.envelope === "canonical-json-detached-v1") return canonical({ ...metadata, payload, signature });
  return [`ALGORITHM: ${metadata.algorithm}`, `KEY-ID: ${metadata.keyId}`, `SENT-AT: ${metadata.sentAt}`, `NONCE: ${metadata.nonce}`, `MESSAGE-ID: ${metadata.messageId}`, `SIGNATURE: ${signature}`, "", fixedBody(payload)].join("\n");
}

function parseJsonEnvelope(raw: string): { metadata: SignedMessageMetadata; payload: SignedMessageOrder; signature: string } {
  const schema = z.object({ algorithm: algorithmSchema, keyId: identifier, sentAt: timestampSchema, nonce: identifier, messageId: identifier, payload: orderSchema, signature: z.string().regex(/^[a-f0-9]{64,128}$/) }).strict();
  const parsed = schema.parse(JSON.parse(raw));
  if (raw !== canonical(parsed)) throw new Error("Canonical JSON envelope is ambiguous or not byte-canonical.");
  const { signature, payload, ...metadata } = parsed;
  return { metadata, payload, signature };
}

function parseFixedEnvelope(raw: string): { metadata: SignedMessageMetadata; payload: SignedMessageOrder; signature: string } {
  if (raw.includes("\r") || raw.includes("\0")) throw new Error("Fixed signed envelope contains unsupported bytes.");
  const [headers, body, ...extra] = raw.split("\n\n");
  if (!headers || !body || extra.length > 0) throw new Error("Fixed signed envelope requires one header/body boundary.");
  const lines = headers.split("\n");
  const prefixes = ["ALGORITHM: ", "KEY-ID: ", "SENT-AT: ", "NONCE: ", "MESSAGE-ID: ", "SIGNATURE: "];
  if (lines.length !== prefixes.length || lines.some((line, index) => !line.startsWith(prefixes[index]!))) throw new Error("Fixed signed envelope headers are missing, duplicated or reordered.");
  const algorithm = algorithmSchema.parse(lines[0]!.slice(prefixes[0]!.length));
  const keyId = identifier.parse(lines[1]!.slice(prefixes[1]!.length));
  const sentAt = timestampSchema.parse(lines[2]!.slice(prefixes[2]!.length));
  const nonce = identifier.parse(lines[3]!.slice(prefixes[3]!.length));
  const messageId = identifier.parse(lines[4]!.slice(prefixes[4]!.length));
  const signature = z.string().regex(/^[a-f0-9]{64,128}$/).parse(lines[5]!.slice(prefixes[5]!.length));
  const bodyLines = body.split("\n");
  if (bodyLines[0] !== "ORDER" || bodyLines[1] !== "SCHEMA=1" || bodyLines.at(-1) !== "END ORDER") throw new Error("Fixed signed message body envelope is invalid.");
  const sequence = Number(bodyLines[2]?.match(/^SEQUENCE=(\d+)$/)?.[1]);
  const purchaseOrderNumber = bodyLines[3]?.match(/^PO=([a-zA-Z0-9_.@-]+)$/)?.[1];
  const shipToCode = bodyLines[4]?.match(/^SHIP_TO=([a-zA-Z0-9_.@-]+)$/)?.[1];
  if (!sequence || !purchaseOrderNumber || !shipToCode) throw new Error("Fixed signed message identity fields are invalid.");
  const orderLines = bodyLines.slice(5, -1).map((line) => {
    const match = line.match(/^LINE=(\d+)\|([a-zA-Z0-9_.@-]+)\|(\d+)$/);
    if (!match) throw new Error("Fixed signed message contains a malformed order row.");
    return { lineNumber: Number(match[1]), itemCode: match[2]!, quantity: Number(match[3]) };
  });
  const payload = orderSchema.parse({ schemaVersion: "1", sequence, purchaseOrderNumber, shipToCode, lines: orderLines });
  return { metadata: { algorithm, keyId, sentAt, nonce, messageId }, payload, signature };
}

export class SignedMessageReplayLedger {
  private readonly database: DatabaseSync;
  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath); if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    this.database.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS accepted_messages (tenant_id TEXT, contract_id TEXT, nonce TEXT, message_id TEXT, sequence INTEGER, accepted_at TEXT, PRIMARY KEY(tenant_id,contract_id,nonce), UNIQUE(tenant_id,contract_id,message_id));`);
  }
  reserve(input: { tenantId: string; contractId: string; nonce: string; messageId: string; sequence: number; orderingPolicy: SignedMessageContract["orderingPolicy"]; acceptedAt: string }): void {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      if (input.orderingPolicy === "strict-monotonic") {
        const current = this.database.prepare("SELECT MAX(sequence) AS value FROM accepted_messages WHERE tenant_id=? AND contract_id=?").get(input.tenantId, input.contractId) as unknown as { value: number | null };
        if (current.value !== null && input.sequence <= current.value) throw new Error("Signed message violates strict monotonic ordering.");
      }
      this.database.prepare("INSERT INTO accepted_messages VALUES (?, ?, ?, ?, ?, ?)").run(input.tenantId, input.contractId, input.nonce, input.messageId, input.sequence, input.acceptedAt);
      this.database.exec("COMMIT;");
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK;"); throw new Error(`Signed message replay or ordering check failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  close(): void { this.database.close(); }
}

export async function createSignedMessageProposal(input: {
  tenantId: string; parentGoalId: string; planId: string; planDigest: string; workItemId: string;
  rawMessage: string; contract: SignedMessageContract; keys: SignedMessageKeyResolver;
  replay: SignedMessageReplayLedger; now: string;
}): Promise<SignedMessageProposal> {
  const contract = signedMessageContractSchema.parse(input.contract);
  if (input.tenantId !== contract.tenantId) throw new Error("Signed message trust policy belongs to another tenant.");
  const parsed = contract.envelope === "canonical-json-detached-v1" ? parseJsonEnvelope(input.rawMessage) : parseFixedEnvelope(input.rawMessage);
  if (parsed.metadata.algorithm !== contract.algorithm) throw new Error("Signed message algorithm does not match the frozen contract.");
  const trust = contract.keys.find((key) => key.keyId === parsed.metadata.keyId);
  if (!trust) throw new Error("Signed message key ID is unknown.");
  if (trust.status !== "active") throw new Error("Signed message key is revoked.");
  const now = Date.parse(timestampSchema.parse(input.now)); const sentAt = Date.parse(parsed.metadata.sentAt);
  if (now < Date.parse(trust.notBefore) || now >= Date.parse(trust.expiresAt)) throw new Error("Signed message trust key is expired or not active yet.");
  if (sentAt > now + contract.maximumFutureSkewMs) throw new Error("Signed message timestamp is too far in the future.");
  if (now - sentAt > contract.maximumAgeMs) throw new Error("Signed message is stale.");
  const key = input.keys.resolve(input.tenantId, contract.trustPolicyId, trust.keyId);
  if (!key || sha256(key) !== trust.keyDigest) throw new Error("Signed message trust key material is unavailable or substituted.");
  const expectedSignature = sign(contract.algorithm, key, signedMaterial(parsed.metadata, parsed.payload, contract.envelope));
  const actualBytes = Buffer.from(parsed.signature, "hex"); const expectedBytes = Buffer.from(expectedSignature, "hex");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) throw new Error("Signed message signature verification failed.");
  if (parsed.payload.lines.some((line) => !contract.allowedItemCodes.includes(line.itemCode) || line.quantity > contract.maxQuantityPerLine)) throw new Error("Signed message payload exceeds the exact schema policy.");
  input.replay.reserve({ tenantId: input.tenantId, contractId: contract.contractId, nonce: parsed.metadata.nonce, messageId: parsed.metadata.messageId, sequence: parsed.payload.sequence, orderingPolicy: contract.orderingPolicy, acceptedAt: input.now });
  const contractDigest = composedRecoveryDigest(contract); const payloadDigest = composedRecoveryDigest(parsed.payload);
  const messageDigest = sha256(input.rawMessage); const trustEvidenceDigest = composedRecoveryDigest({ trust, keyDigest: trust.keyDigest, signature: parsed.signature });
  const capabilityMaterialDigest = composedRecoveryDigest({ documentationDigest: contractDigest, schemaDigest: payloadDigest, provenanceDigest: trustEvidenceDigest });
  const unsigned = { schemaVersion: "1.0" as const, proposalId: "", tenantId: input.tenantId, parentGoalId: input.parentGoalId, planId: input.planId, planDigest: input.planDigest, workItemId: input.workItemId,
    contractId: contract.contractId, contractVersion: contract.contractVersion, contractDigest, envelope: contract.envelope, algorithm: contract.algorithm, keyId: trust.keyId,
    sentAt: parsed.metadata.sentAt, nonce: parsed.metadata.nonce, messageId: parsed.metadata.messageId, messageDigest, payload: parsed.payload, payloadDigest, trustEvidenceDigest,
    capabilityMaterialDigest, targetAlias: contract.targetAlias, actionKey: contract.actionKey, approvalKey: contract.approvalKey, workflowKey: contract.workflowKey, proposedAt: input.now };
  unsigned.proposalId = `signed-message-proposal.${composedRecoveryDigest(unsigned).slice(0, 40)}`;
  return { ...unsigned, proposalDigest: composedRecoveryDigest(unsigned) };
}

export interface SignedMessageAuthorityReceipt { tenantId: string; parentGoalId: string; planId: string; planDigest: string; workItemId: string; targetAlias: string; actionKey: string; approvalKey: string; checkedAt: string; expiresAt: string; authorityDigest: string }
export type SignedMessageOutcomeClassification = "completed" | "not-started" | "partial" | "incorrect" | "duplicate" | "collateral" | "unknown" | "unavailable";
export interface SignedMessageOutcomeOracle { operationKey: string; expected: unknown; oracleDigest: string }

export class SignedMessageActionRuntime {
  private readonly database: DatabaseSync; private verifierState: "available" | "unknown" | "unavailable" = "available";
  constructor(databasePath: string, private readonly now: () => string) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 }); this.database = new DatabaseSync(databasePath);
    this.database.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS message_outcomes(sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_key TEXT, outcome_json TEXT); CREATE TABLE IF NOT EXISTS message_actions(idempotency_key TEXT PRIMARY KEY, operation_key TEXT);`);
  }
  setVerifierState(value: "available" | "unknown" | "unavailable"): void { this.verifierState = value; }
  execute(input: { proposal: SignedMessageProposal; authority: SignedMessageAuthorityReceipt; operationKey: string; idempotencyKey: string; loseResponseAfterCommit?: boolean }): 0 | 1 {
    const { proposalDigest, ...unsigned } = input.proposal; if (composedRecoveryDigest(unsigned) !== proposalDigest) throw new Error("Signed message proposal integrity failed.");
    for (const [label, left, right] of [["tenant", input.authority.tenantId, input.proposal.tenantId], ["parent", input.authority.parentGoalId, input.proposal.parentGoalId], ["plan", input.authority.planDigest, input.proposal.planDigest], ["work item", input.authority.workItemId, input.proposal.workItemId], ["target", input.authority.targetAlias, input.proposal.targetAlias], ["action", input.authority.actionKey, input.proposal.actionKey], ["approval", input.authority.approvalKey, input.proposal.approvalKey]] as const) if (left !== right) throw new Error(`Signed message authority is not bound to exact ${label}.`);
    if (Date.parse(input.authority.checkedAt) > Date.parse(this.now()) || Date.parse(input.authority.expiresAt) <= Date.parse(this.now())) throw new Error("Signed message authority is expired.");
    const expectedOperation = `signed-message-${sha256(input.proposal.messageId)}`; if (input.operationKey !== expectedOperation) throw new Error("Signed message operation identity changed.");
    if (this.database.prepare("SELECT 1 FROM message_actions WHERE idempotency_key=?").get(input.idempotencyKey)) return 0;
    const outcome = { operationKey: input.operationKey, messageId: input.proposal.messageId, messageDigest: input.proposal.messageDigest, payload: input.proposal.payload, status: "draft" };
    this.database.exec("BEGIN IMMEDIATE;"); try { this.database.prepare("INSERT INTO message_outcomes(operation_key,outcome_json) VALUES (?,?)").run(input.operationKey, JSON.stringify(outcome)); this.database.prepare("INSERT INTO message_actions VALUES (?,?)").run(input.idempotencyKey, input.operationKey); this.database.exec("COMMIT;"); } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK;"); throw error; }
    if (input.loseResponseAfterCommit) throw new Error("Signed message action response lost after commit."); return 1;
  }
  observe(oracle: SignedMessageOutcomeOracle): { classification: SignedMessageOutcomeClassification; evidenceDigest: string; incorrectSideEffects: number } {
    if (this.verifierState !== "available") return { classification: this.verifierState, evidenceDigest: composedRecoveryDigest({ oracle, state: this.verifierState }), incorrectSideEffects: 0 };
    if (oracle.oracleDigest !== composedRecoveryDigest({ operationKey: oracle.operationKey, expected: oracle.expected })) throw new Error("Signed message outcome oracle integrity failed.");
    const rows = this.database.prepare("SELECT operation_key,outcome_json FROM message_outcomes ORDER BY sequence").all() as unknown as Array<{ operation_key: string; outcome_json: string }>;
    const target = rows.filter((row) => row.operation_key === oracle.operationKey); const collateral = rows.filter((row) => row.operation_key !== oracle.operationKey);
    const parsed = target.map((row) => JSON.parse(row.outcome_json) as unknown); const exact = parsed.filter((value) => canonical(value) === canonical(oracle.expected));
    let classification: SignedMessageOutcomeClassification;
    if (collateral.length) classification = "collateral"; else if (target.length > 1) classification = "duplicate"; else if (!target.length) classification = "not-started"; else if (exact.length === 1) classification = "completed";
    else { const candidate = parsed[0] as { payload?: { lines?: unknown[] } }; classification = (candidate.payload?.lines?.length ?? 0) < ((oracle.expected as { payload: { lines: unknown[] } }).payload.lines.length) ? "partial" : "incorrect"; }
    return { classification, evidenceDigest: composedRecoveryDigest({ oracleDigest: oracle.oracleDigest, rows }), incorrectSideEffects: ["incorrect", "duplicate", "collateral"].includes(classification) ? 1 : 0 };
  }
  inject(operationKey: string, outcome: unknown): void { this.database.prepare("INSERT INTO message_outcomes(operation_key,outcome_json) VALUES (?,?)").run(operationKey, JSON.stringify(outcome)); }
  actionCount(): number { return (this.database.prepare("SELECT COUNT(*) AS value FROM message_actions").get() as unknown as { value: number }).value; }
  close(): void { this.database.close(); }
}
