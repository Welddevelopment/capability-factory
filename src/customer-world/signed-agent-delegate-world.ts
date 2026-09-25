import { createHash, sign as signReceipt } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalDelegateReceiptBytes,
  computeAgentDelegateContractHash,
  type AgentDelegateAdapter,
  type AgentDelegateContract,
  type AgentDelegateOutcomeVerifier,
  type SignedDelegateReceipt,
  type SignedDelegateReceiptBody,
} from "../experimental/agent-delegation-capability-sdk.js";

function hash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

export class LocalSignedShipmentDelegate implements AgentDelegateAdapter {
  readonly contract: AgentDelegateContract;
  private readonly database: DatabaseSync;

  constructor(
    private readonly databasePath: string,
    private readonly privateKeyPem: string,
    publicKeyPem: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS shipment_drafts (
        operation_key TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        carrier TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status = 'draft')
      );
      CREATE TABLE IF NOT EXISTS delegate_receipts (
        operation_key TEXT PRIMARY KEY,
        receipt_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS protected_delegate_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO protected_delegate_settings (setting_key, setting_value)
      VALUES ('region', 'GB');
    `);
    const publicKeySha256 = hash(publicKeyPem);
    const contractWithoutHash: Omit<AgentDelegateContract, "contractHash"> = {
      schemaVersion: "1.0",
      delegateId: "fictional-shipment-agent",
      version: "1_0_0",
      publicKeyPem,
      publicKeySha256,
      allowedTaskKeys: ["create-shipment-draft"],
      approvalKey: "delegate-shipment-draft",
      preUseVerifierKey: "shipment-delegate-probe",
      outcomeVerifierKey: "independent-shipment-database-observer",
      timeoutMs: 2_000,
    };
    this.contract = { ...contractWithoutHash, contractHash: computeAgentDelegateContractHash(contractWithoutHash) };
  }

  async probe(taskKey: string): Promise<{ passed: boolean; detail: string }> {
    const tables = this.database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('shipment_drafts', 'delegate_receipts') ORDER BY name
    `).all();
    const passed = taskKey === "create-shipment-draft" && tables.length === 2;
    return { passed, detail: passed ? "The exact trusted delegate task and local fixture are available." : "Delegate probe rejected the task or fixture." };
  }

  async reconcile(operationKey: string): Promise<
    | { status: "not-started" }
    | { status: "completed"; receipt: SignedDelegateReceipt }
  > {
    const row = this.database.prepare("SELECT receipt_json FROM delegate_receipts WHERE operation_key = ?").get(operationKey) as { receipt_json: string } | undefined;
    return row ? { status: "completed", receipt: JSON.parse(row.receipt_json) as SignedDelegateReceipt } : { status: "not-started" };
  }

  async execute(input: { operationKey: string; taskKey: string; values: Record<string, string> }): Promise<SignedDelegateReceipt> {
    if (input.taskKey !== "create-shipment-draft") throw new Error("The delegate task is outside the reviewed contract.");
    const orderId = input.values.orderId;
    const carrier = input.values.carrier;
    if (!orderId || !carrier) throw new Error("The reviewed delegate input is incomplete.");
    const existing = await this.reconcile(input.operationKey);
    if (existing.status === "completed") return existing.receipt;
    this.database.prepare(`
      INSERT INTO shipment_drafts (operation_key, order_id, carrier, status)
      VALUES (?, ?, ?, 'draft')
    `).run(input.operationKey, orderId, carrier);
    const resultRow = this.database.prepare(`
      SELECT operation_key, order_id, carrier, status FROM shipment_drafts
      WHERE operation_key = ?
    `).get(input.operationKey);
    const body: SignedDelegateReceiptBody = {
      schemaVersion: "1.0",
      delegateId: this.contract.delegateId,
      delegateVersion: this.contract.version,
      operationKey: input.operationKey,
      taskKey: input.taskKey,
      inputDigest: hash(Object.fromEntries(Object.entries(input.values).sort(([left], [right]) => left.localeCompare(right)))),
      status: "completed",
      completedAt: this.now(),
      resultDigest: hash(resultRow),
    };
    const receipt: SignedDelegateReceipt = {
      ...body,
      signatureBase64: signReceipt(null, canonicalDelegateReceiptBytes(body), this.privateKeyPem).toString("base64"),
    };
    this.database.prepare("INSERT INTO delegate_receipts (operation_key, receipt_json) VALUES (?, ?)")
      .run(input.operationKey, JSON.stringify(receipt));
    return receipt;
  }

  protectedStateDigest(): string {
    return hash(this.database.prepare("SELECT setting_key, setting_value FROM protected_delegate_settings ORDER BY setting_key").all());
  }

  countDrafts(): number {
    return (this.database.prepare("SELECT COUNT(*) AS count FROM shipment_drafts").get() as { count: number }).count;
  }

  close(): void {
    this.database.close();
  }
}

export class IndependentShipmentOutcomeVerifier implements AgentDelegateOutcomeVerifier {
  readonly key = "independent-shipment-database-observer";

  constructor(
    private readonly databasePath: string,
    private readonly protectedDigest: string,
  ) {}

  async verifyOutcome(operationKey: string, input: Record<string, string>) {
    const observer = new DatabaseSync(this.databasePath, { readOnly: true });
    try {
      const rows = observer.prepare(`
        SELECT operation_key, order_id, carrier, status FROM shipment_drafts
        WHERE operation_key = ?
      `).all(operationKey) as unknown as Array<{ operation_key: string; order_id: string; carrier: string; status: string }>;
      const protectedRows = observer.prepare("SELECT setting_key, setting_value FROM protected_delegate_settings ORDER BY setting_key").all();
      const exact = rows.length === 1
        && rows[0]!.order_id === input.orderId
        && rows[0]!.carrier === input.carrier
        && rows[0]!.status === "draft";
      const protectedUnchanged = hash(protectedRows) === this.protectedDigest;
      const passed = exact && protectedUnchanged;
      return {
        passed,
        incorrectSideEffects: passed ? 0 : 1,
        stateDigest: hash({ rows, protectedRows }),
        detail: passed
          ? "A separate read-only observer found exactly one intended shipment draft and unchanged protected settings."
          : "Independent delegate outcome state did not satisfy the exact contract.",
      };
    } finally {
      observer.close();
    }
  }
}
