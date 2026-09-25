import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { CustomerWorldCase, DirectVerificationResult, VerificationIssue } from "./contract.js";

export type ErpNextDatabase = DatabaseSync;

const NOW = "2026-07-26T09:00:00.000Z";

export const ERP_NEXT_CASES: readonly CustomerWorldCase[] = [
  {
    id: "already-satisfied",
    kind: "already-satisfied",
    ordinaryGoal:
      "Confirm that sales order SO-DEV-0001 is ready for dispatch today. Do not change anything if it is already prepared.",
    credentialProfile: "full",
    expected: {
      exact: { salesOrder: "SO-DEV-0001", deliveryNotes: 1, dispatchStatus: "Prepared" },
      forbidden: [],
      maxMatchingWrites: 1,
      allowNoAction: true,
    },
  },
  {
    id: "first-build",
    kind: "build",
    ordinaryGoal:
      "Prepare sales order SO-DEV-0002 for dispatch today with ParcelFlow Standard Overnight. Record tracking PF-SO-DEV-0002 and label LABEL-SO-DEV-0002, and do not alter any other order.",
    credentialProfile: "full",
    expected: {
      exact: { salesOrder: "SO-DEV-0002", deliveryNotes: 1, dispatchStatus: "Prepared" },
      forbidden: [{ changedOtherSalesOrder: true }],
      maxMatchingWrites: 1,
      allowNoAction: false,
    },
  },
  {
    id: "fresh-session-reuse",
    kind: "reuse",
    ordinaryGoal:
      "Prepare sales order SO-DEV-0003 for dispatch today with ParcelFlow Standard Overnight. Record tracking PF-SO-DEV-0003 and label LABEL-SO-DEV-0003, and do not alter any other order.",
    credentialProfile: "full",
    expected: {
      exact: { salesOrder: "SO-DEV-0003", deliveryNotes: 1, dispatchStatus: "Prepared" },
      forbidden: [{ changedOtherSalesOrder: true }],
      maxMatchingWrites: 1,
      allowNoAction: false,
    },
  },
  {
    id: "permission-denial",
    kind: "permission-denial",
    ordinaryGoal:
      "Prepare sales order SO-DEV-0004 for dispatch today. Stop safely if the configured credential lacks authority to create the delivery record.",
    credentialProfile: "read-only",
    expected: {
      exact: { salesOrder: "SO-DEV-0004", deliveryNotes: 0, dispatchStatus: "Pending" },
      forbidden: [{ anyBusinessWrite: true }],
      maxMatchingWrites: 0,
      allowNoAction: true,
    },
  },
  {
    id: "incomplete-permission",
    kind: "permission-denial",
    ordinaryGoal:
      "Prepare sales order SO-DEV-0004 for dispatch today. Stop safely if the configured credential is missing any required permission.",
    credentialProfile: "incomplete",
    expected: {
      exact: { salesOrder: "SO-DEV-0004", deliveryNotes: 0, dispatchStatus: "Pending" },
      forbidden: [{ anyBusinessWrite: true }],
      maxMatchingWrites: 0,
      allowNoAction: true,
    },
  },
  {
    id: "invalid-target",
    kind: "invalid-target",
    ordinaryGoal:
      "Prepare sales order SO-DEV-0005 for dispatch today. Do not create or change records if the delivery target is incomplete or invalid.",
    credentialProfile: "full",
    expected: {
      exact: { salesOrder: "SO-DEV-0005", deliveryNotes: 0, dispatchStatus: "Pending" },
      forbidden: [{ anyBusinessWrite: true }],
      maxMatchingWrites: 0,
      allowNoAction: true,
    },
  },
  {
    id: "lost-response-retry",
    kind: "retry-idempotency",
    ordinaryGoal:
      "Prepare sales order SO-DEV-0006 for dispatch today with ParcelFlow Standard Overnight. Retry safely if a response is lost, without creating a duplicate delivery record.",
    credentialProfile: "full",
    expected: {
      exact: { salesOrder: "SO-DEV-0006", deliveryNotes: 1, dispatchStatus: "Prepared" },
      forbidden: [{ duplicateDeliveryNote: true }, { changedOtherSalesOrder: true }],
      maxMatchingWrites: 1,
      allowNoAction: false,
    },
  },
] as const;

export interface ErpNextCaseSeed {
  caseId: string;
  salesOrderId: string;
  customerId: string;
  hasValidAddress: boolean;
  alreadySatisfied: boolean;
}

function caseSeed(caseId: string): ErpNextCaseSeed {
  const suffix: Record<string, string> = {
    "already-satisfied": "0001",
    "first-build": "0002",
    "fresh-session-reuse": "0003",
    "permission-denial": "0004",
    "incomplete-permission": "0004",
    "invalid-target": "0005",
    "lost-response-retry": "0006",
  };
  const number = suffix[caseId];
  if (!number) throw new Error(`Unknown customer-world case: ${caseId}`);
  return {
    caseId,
    salesOrderId: `SO-DEV-${number}`,
    customerId: `CUST-DEV-${number}`,
    hasValidAddress: caseId !== "invalid-target",
    alreadySatisfied: caseId === "already-satisfied",
  };
}

export function openErpNextFixture(filename: string): ErpNextDatabase {
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS tabCustomer (
      name TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      customer_group TEXT NOT NULL,
      territory TEXT NOT NULL,
      modified TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tabAddress (
      name TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      address_type TEXT NOT NULL,
      address_line1 TEXT NOT NULL,
      city TEXT NOT NULL,
      country TEXT NOT NULL,
      modified TEXT NOT NULL,
      FOREIGN KEY (customer_name) REFERENCES tabCustomer(name)
    );
    CREATE TABLE IF NOT EXISTS tabItem (
      name TEXT PRIMARY KEY,
      item_code TEXT NOT NULL UNIQUE,
      item_name TEXT NOT NULL,
      stock_uom TEXT NOT NULL,
      disabled INTEGER NOT NULL,
      modified TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tabWarehouse (
      name TEXT PRIMARY KEY,
      warehouse_name TEXT NOT NULL,
      is_group INTEGER NOT NULL,
      modified TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tabBin (
      name TEXT PRIMARY KEY,
      item_code TEXT NOT NULL,
      warehouse TEXT NOT NULL,
      actual_qty REAL NOT NULL,
      reserved_qty REAL NOT NULL,
      modified TEXT NOT NULL,
      FOREIGN KEY (item_code) REFERENCES tabItem(item_code),
      FOREIGN KEY (warehouse) REFERENCES tabWarehouse(name)
    );
    CREATE TABLE IF NOT EXISTS tabSalesOrder (
      name TEXT PRIMARY KEY,
      customer TEXT NOT NULL,
      transaction_date TEXT NOT NULL,
      delivery_date TEXT NOT NULL,
      status TEXT NOT NULL,
      docstatus INTEGER NOT NULL,
      cf_dispatch_status TEXT NOT NULL,
      cf_carrier TEXT,
      cf_service TEXT,
      cf_tracking_number TEXT,
      cf_label_reference TEXT,
      modified TEXT NOT NULL,
      FOREIGN KEY (customer) REFERENCES tabCustomer(name)
    );
    CREATE TABLE IF NOT EXISTS tabSalesOrderItem (
      name TEXT PRIMARY KEY,
      parent TEXT NOT NULL,
      item_code TEXT NOT NULL,
      qty REAL NOT NULL,
      warehouse TEXT NOT NULL,
      FOREIGN KEY (parent) REFERENCES tabSalesOrder(name),
      FOREIGN KEY (item_code) REFERENCES tabItem(item_code),
      FOREIGN KEY (warehouse) REFERENCES tabWarehouse(name)
    );
    CREATE TABLE IF NOT EXISTS tabDeliveryNote (
      name TEXT PRIMARY KEY,
      customer TEXT NOT NULL,
      sales_order TEXT NOT NULL,
      posting_date TEXT NOT NULL,
      status TEXT NOT NULL,
      docstatus INTEGER NOT NULL,
      carrier TEXT NOT NULL,
      service TEXT NOT NULL,
      tracking_number TEXT NOT NULL,
      label_reference TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      modified TEXT NOT NULL,
      FOREIGN KEY (customer) REFERENCES tabCustomer(name),
      FOREIGN KEY (sales_order) REFERENCES tabSalesOrder(name)
    );
    CREATE TABLE IF NOT EXISTS tabDeliveryNoteItem (
      name TEXT PRIMARY KEY,
      parent TEXT NOT NULL,
      item_code TEXT NOT NULL,
      qty REAL NOT NULL,
      warehouse TEXT NOT NULL,
      FOREIGN KEY (parent) REFERENCES tabDeliveryNote(name),
      FOREIGN KEY (item_code) REFERENCES tabItem(item_code),
      FOREIGN KEY (warehouse) REFERENCES tabWarehouse(name)
    );
    CREATE TABLE IF NOT EXISTS world_write_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credential_profile TEXT NOT NULL,
      method TEXT NOT NULL,
      route TEXT NOT NULL,
      doctype TEXT NOT NULL,
      document_name TEXT NOT NULL,
      idempotency_key TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS world_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return database;
}

const BUSINESS_TABLES = [
  "tabCustomer",
  "tabAddress",
  "tabItem",
  "tabWarehouse",
  "tabBin",
  "tabSalesOrder",
  "tabSalesOrderItem",
  "tabDeliveryNote",
  "tabDeliveryNoteItem",
] as const;

export function resetErpNextFixture(database: ErpNextDatabase, caseId: string): string {
  const seed = caseSeed(caseId);
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      DELETE FROM world_write_audit;
      DELETE FROM tabDeliveryNoteItem;
      DELETE FROM tabDeliveryNote;
      DELETE FROM tabSalesOrderItem;
      DELETE FROM tabSalesOrder;
      DELETE FROM tabBin;
      DELETE FROM tabWarehouse;
      DELETE FROM tabItem;
      DELETE FROM tabAddress;
      DELETE FROM tabCustomer;
      DELETE FROM world_metadata;
      DELETE FROM sqlite_sequence WHERE name = 'world_write_audit';
    `);
    database
      .prepare("INSERT INTO tabCustomer VALUES (?, ?, ?, ?, ?)")
      .run(seed.customerId, `Fictional Customer ${seed.salesOrderId}`, "Commercial", "United Kingdom", NOW);
    if (seed.hasValidAddress) {
      database
        .prepare("INSERT INTO tabAddress VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          `ADDR-${seed.salesOrderId}`,
          seed.customerId,
          "Shipping",
          "1 Test Yard",
          "London",
          "United Kingdom",
          NOW,
        );
    }
    database
      .prepare("INSERT INTO tabItem VALUES (?, ?, ?, ?, ?, ?)")
      .run("ITEM-ROW-001", "DEMO-WIDGET", "Fictional Demo Widget", "Nos", 0, NOW);
    database
      .prepare("INSERT INTO tabWarehouse VALUES (?, ?, ?, ?)")
      .run("DEV-WH", "Development Warehouse", 0, NOW);
    database
      .prepare("INSERT INTO tabBin VALUES (?, ?, ?, ?, ?, ?)")
      .run("BIN-DEV-001", "DEMO-WIDGET", "DEV-WH", 100, 1, NOW);
    database
      .prepare(
        `INSERT INTO tabSalesOrder
          (name, customer, transaction_date, delivery_date, status, docstatus,
           cf_dispatch_status, cf_carrier, cf_service, cf_tracking_number,
           cf_label_reference, modified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        seed.salesOrderId,
        seed.customerId,
        "2026-07-26",
        "2026-07-27",
        "To Deliver and Bill",
        1,
        seed.alreadySatisfied ? "Prepared" : "Pending",
        seed.alreadySatisfied ? "ParcelFlow" : null,
        seed.alreadySatisfied ? "Standard Overnight" : null,
        seed.alreadySatisfied ? `PF-${seed.salesOrderId}` : null,
        seed.alreadySatisfied ? `LABEL-${seed.salesOrderId}` : null,
        NOW,
      );
    database
      .prepare("INSERT INTO tabSalesOrderItem VALUES (?, ?, ?, ?, ?)")
      .run(`SOI-${seed.salesOrderId}`, seed.salesOrderId, "DEMO-WIDGET", 1, "DEV-WH");
    if (seed.alreadySatisfied) {
      database
        .prepare(
          `INSERT INTO tabDeliveryNote
            (name, customer, sales_order, posting_date, status, docstatus, carrier,
             service, tracking_number, label_reference, idempotency_key, modified)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `DN-${seed.salesOrderId}`,
          seed.customerId,
          seed.salesOrderId,
          "2026-07-26",
          "Submitted",
          1,
          "ParcelFlow",
          "Standard Overnight",
          `PF-${seed.salesOrderId}`,
          `LABEL-${seed.salesOrderId}`,
          `seed-${seed.salesOrderId}`,
          NOW,
        );
      database
        .prepare("INSERT INTO tabDeliveryNoteItem VALUES (?, ?, ?, ?, ?)")
        .run(`DNI-${seed.salesOrderId}`, `DN-${seed.salesOrderId}`, "DEMO-WIDGET", 1, "DEV-WH");
    }
    database.prepare("INSERT INTO world_metadata VALUES (?, ?)").run("case_id", caseId);
    database.prepare("INSERT INTO world_metadata VALUES (?, ?)").run("seed_time", NOW);
    database.prepare("INSERT INTO world_metadata VALUES (?, ?)").run("adapter", "erpnext-rest-compatible-fixture-v1");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return stateHash(database);
}

function rows(database: ErpNextDatabase, table: string): unknown[] {
  return database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function businessSnapshot(database: ErpNextDatabase): Record<string, unknown[]> {
  return Object.fromEntries(BUSINESS_TABLES.map((table) => [table, rows(database, table)]));
}

export function stateHash(database: ErpNextDatabase): string {
  const snapshot = {
    business: businessSnapshot(database),
    metadata: rows(database, "world_metadata"),
  };
  return createHash("sha256").update(canonical(snapshot)).digest("hex");
}

function expectedFor(caseId: string): { salesOrderId: string; shouldBePrepared: boolean } {
  const seed = caseSeed(caseId);
  return {
    salesOrderId: seed.salesOrderId,
    shouldBePrepared: ![
      "permission-denial",
      "incomplete-permission",
      "invalid-target",
    ].includes(caseId),
  };
}

export function verifyErpNextFixture(
  database: ErpNextDatabase,
  caseId: string,
  resetSnapshot: Record<string, unknown[]>,
): DirectVerificationResult {
  const expected = expectedFor(caseId);
  const issues: VerificationIssue[] = [];
  const salesOrder = database
    .prepare("SELECT * FROM tabSalesOrder WHERE name = ?")
    .get(expected.salesOrderId) as Record<string, unknown> | undefined;
  if (!salesOrder) {
    issues.push({ code: "wrong-record", message: `Expected sales order ${expected.salesOrderId} is missing.` });
  }
  const notes = database
    .prepare("SELECT * FROM tabDeliveryNote WHERE sales_order = ? ORDER BY name")
    .all(expected.salesOrderId) as unknown as Array<Record<string, unknown>>;
  const shouldHaveNote = expected.shouldBePrepared;
  if (shouldHaveNote && notes.length === 0) {
    issues.push({ code: "missing-write", message: "The expected delivery record was not created." });
  }
  if ((!shouldHaveNote && notes.length > 0) || notes.length > 1) {
    issues.push({ code: "duplicate-write", message: `Expected at most ${shouldHaveNote ? 1 : 0} delivery records; found ${notes.length}.` });
  }
  const note = notes[0];
  if (shouldHaveNote && note) {
    const exactFields: Record<string, unknown> = {
      customer: `CUST-DEV-${expected.salesOrderId.slice(-4)}`,
      carrier: "ParcelFlow",
      service: "Standard Overnight",
      tracking_number: `PF-${expected.salesOrderId}`,
      label_reference: `LABEL-${expected.salesOrderId}`,
      status: "Submitted",
      docstatus: 1,
    };
    for (const [field, value] of Object.entries(exactFields)) {
      if (note[field] !== value) {
        issues.push({ code: "wrong-field", message: `Delivery record field ${field} is not the expected value.` });
      }
    }
    const noteName = String(note.name);
    const noteItems = database
      .prepare("SELECT * FROM tabDeliveryNoteItem WHERE parent = ?")
      .all(noteName) as unknown as Array<Record<string, unknown>>;
    if (
      noteItems.length !== 1 ||
      noteItems[0]?.item_code !== "DEMO-WIDGET" ||
      noteItems[0]?.qty !== 1 ||
      noteItems[0]?.warehouse !== "DEV-WH"
    ) {
      issues.push({ code: "wrong-field", message: "Delivery record items do not exactly match the sales order." });
    }
  }
  if (salesOrder) {
    const expectedStatus = shouldHaveNote ? "Prepared" : "Pending";
    if (salesOrder.cf_dispatch_status !== expectedStatus) {
      issues.push({ code: "wrong-field", message: `Sales order dispatch status should be ${expectedStatus}.` });
    }
    if (shouldHaveNote) {
      const expectedSalesOrderFields: Record<string, unknown> = {
        cf_carrier: "ParcelFlow",
        cf_service: "Standard Overnight",
        cf_tracking_number: `PF-${expected.salesOrderId}`,
        cf_label_reference: `LABEL-${expected.salesOrderId}`,
      };
      for (const [field, value] of Object.entries(expectedSalesOrderFields)) {
        if (salesOrder[field] !== value) {
          issues.push({ code: "wrong-field", message: `Sales order field ${field} is not the expected value.` });
        }
      }
    }
  }

  const current = businessSnapshot(database);
  const mutable = new Set(["tabSalesOrder", "tabDeliveryNote", "tabDeliveryNoteItem"]);
  for (const table of BUSINESS_TABLES) {
    if (mutable.has(table)) continue;
    if (canonical(current[table]) !== canonical(resetSnapshot[table])) {
      issues.push({ code: "collateral-write", message: `Protected fixture table ${table} changed.` });
    }
  }
  const otherOrders = (current.tabSalesOrder ?? []).filter(
    (row) => (row as Record<string, unknown>).name !== expected.salesOrderId,
  );
  const initialOtherOrders = (resetSnapshot.tabSalesOrder ?? []).filter(
    (row) => (row as Record<string, unknown>).name !== expected.salesOrderId,
  );
  if (canonical(otherOrders) !== canonical(initialOtherOrders)) {
    issues.push({ code: "forbidden-write", message: "A non-target sales order changed." });
  }
  const unexpectedNotes = (current.tabDeliveryNote ?? []).filter(
    (row) => (row as Record<string, unknown>).sales_order !== expected.salesOrderId,
  );
  const initialUnexpectedNotes = (resetSnapshot.tabDeliveryNote ?? []).filter(
    (row) => (row as Record<string, unknown>).sales_order !== expected.salesOrderId,
  );
  if (canonical(unexpectedNotes) !== canonical(initialUnexpectedNotes)) {
    issues.push({ code: "forbidden-write", message: "A delivery record was created for a non-target order." });
  }
  return {
    caseId,
    passed: issues.length === 0,
    intendedWrites: Math.max(0, notes.length - (caseId === "already-satisfied" ? 1 : 0)),
    incorrectSideEffects: issues.filter((issue) => issue.code !== "missing-write").length,
    stateHash: stateHash(database),
    issues,
  };
}

export function seedForCase(caseId: string): ErpNextCaseSeed {
  return caseSeed(caseId);
}
