import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  DatabaseCapabilityAdapter,
  DatabaseCapabilityManifest,
  DatabaseOperationContract,
  DatabaseOutcomeReceipt,
} from "../experimental/database-capability-sdk.js";

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class ReviewedInventoryDatabaseAdapter implements DatabaseCapabilityAdapter {
  readonly contract: DatabaseOperationContract;
  private readonly execution: DatabaseSync;
  private readonly protectedDigest: string;

  constructor(private readonly databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.execution = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.execution.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS stock (
        sku TEXT PRIMARY KEY,
        on_hand INTEGER NOT NULL,
        reorder_point INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS restock_drafts (
        operation_key TEXT PRIMARY KEY,
        sku TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 1000),
        status TEXT NOT NULL CHECK (status = 'draft')
      );
      CREATE TABLE IF NOT EXISTS protected_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO stock (sku, on_hand, reorder_point) VALUES ('widget-one', 2, 5);
      INSERT OR IGNORE INTO protected_settings (setting_key, setting_value) VALUES ('currency', 'GBP');
    `);
    const schemaRows = this.execution.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'table' AND name IN ('stock', 'restock_drafts', 'protected_settings')
      ORDER BY name
    `).all();
    const schemaHash = hash(schemaRows);
    this.contract = {
      schemaVersion: "1.0",
      targetAlias: "inventory-database",
      procedureKey: "create-reviewed-restock-draft",
      schemaHash,
      requiredInputKeys: ["sku", "quantity"],
      approvalKey: "create-approved-draft",
      preUseVerifierKey: "reviewed-procedure-probe",
      outcomeVerifierKey: "independent-sqlite-read",
    };
    this.protectedDigest = this.readProtectedDigest();
  }

  async probe(manifest: DatabaseCapabilityManifest, input: Record<string, string>) {
    const sku = input.sku;
    const quantity = Number(input.quantity);
    const stock = sku
      ? this.execution.prepare("SELECT sku FROM stock WHERE sku = ?").get(sku) as { sku: string } | undefined
      : undefined;
    const passed = manifest.targetAlias === this.contract.targetAlias
      && manifest.procedureKey === this.contract.procedureKey
      && manifest.contractHash === this.contract.schemaHash
      && Boolean(stock)
      && Number.isInteger(quantity)
      && quantity > 0
      && quantity <= 1_000;
    return { passed, detail: passed ? "Reviewed schema, procedure identity and parameters passed without a write." : "Reviewed database probe rejected the candidate." };
  }

  async reconcile(operationKey: string): Promise<"completed" | "not-started"> {
    const row = this.execution.prepare("SELECT operation_key FROM restock_drafts WHERE operation_key = ?").get(operationKey);
    return row ? "completed" : "not-started";
  }

  async execute(manifest: DatabaseCapabilityManifest, operationKey: string, input: Record<string, string>): Promise<void> {
    if (manifest.procedureKey !== this.contract.procedureKey || manifest.contractHash !== this.contract.schemaHash) {
      throw new Error("Reviewed database procedure contract mismatch.");
    }
    const sku = input.sku;
    if (!sku) throw new Error("Reviewed database input is missing sku.");
    this.execution.prepare(`
      INSERT OR IGNORE INTO restock_drafts (operation_key, sku, quantity, status)
      VALUES (?, ?, ?, 'draft')
    `).run(operationKey, sku, Number(input.quantity));
  }

  async verifyOutcome(operationKey: string, input: Record<string, string>): Promise<DatabaseOutcomeReceipt> {
    const observer = new DatabaseSync(this.databasePath, { readOnly: true });
    try {
      const matches = observer.prepare(`
        SELECT operation_key, sku, quantity, status
        FROM restock_drafts WHERE operation_key = ?
      `).all(operationKey) as unknown as Array<{ operation_key: string; sku: string; quantity: number; status: string }>;
      const allDrafts = observer.prepare("SELECT operation_key, sku, quantity, status FROM restock_drafts ORDER BY operation_key").all();
      const protectedRows = observer.prepare("SELECT setting_key, setting_value FROM protected_settings ORDER BY setting_key").all();
      const exact = matches.length === 1
        && matches[0]!.sku === input.sku
        && matches[0]!.quantity === Number(input.quantity)
        && matches[0]!.status === "draft";
      const protectedUnchanged = hash(protectedRows) === this.protectedDigest;
      const incorrectSideEffects = exact && protectedUnchanged ? 0 : 1;
      return {
        passed: exact && protectedUnchanged,
        incorrectSideEffects,
        stateDigest: hash({ allDrafts, protectedRows }),
        detail: exact && protectedUnchanged
          ? "A separate read-only database connection found exactly one intended draft and unchanged protected state."
          : "Independent database state did not satisfy the exact draft and protected-state contract.",
      };
    } finally {
      observer.close();
    }
  }

  countDrafts(): number {
    const row = this.execution.prepare("SELECT COUNT(*) AS count FROM restock_drafts").get() as { count: number };
    return row.count;
  }

  close(): void {
    this.execution.close();
  }

  private readProtectedDigest(): string {
    return hash(this.execution.prepare("SELECT setting_key, setting_value FROM protected_settings ORDER BY setting_key").all());
  }
}
