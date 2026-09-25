import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Scenario } from "./scenario.js";

export type CompanyDatabase = DatabaseSync;

export function openCompanyDatabase(filename: string): CompanyDatabase {
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS shipments (
      id TEXT PRIMARY KEY,
      arrival_at TEXT NOT NULL,
      warehouse_id TEXT NOT NULL,
      min_temp_c REAL NOT NULL,
      max_temp_c REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS warehouses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS installed_equipment (
      id TEXT PRIMARY KEY,
      warehouse_id TEXT NOT NULL,
      product_sku TEXT NOT NULL,
      min_temp_c REAL NOT NULL,
      max_temp_c REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS catalog (
      product_sku TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      min_temp_c REAL NOT NULL,
      max_temp_c REAL NOT NULL,
      lead_time_hours INTEGER NOT NULL,
      price_cents INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      product_sku TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      warehouse_id TEXT NOT NULL,
      deliver_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scenario_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return database;
}

export function seedCompanyDatabase(database: CompanyDatabase, scenario: Scenario): void {
  database.exec(`
    DELETE FROM purchase_orders;
    DELETE FROM installed_equipment;
    DELETE FROM shipments;
    DELETE FROM warehouses;
    DELETE FROM catalog;
    DELETE FROM scenario_metadata;
  `);

  const insertWarehouse = database.prepare("INSERT INTO warehouses (id, name) VALUES (?, ?)");
  for (const warehouse of scenario.warehouses) {
    insertWarehouse.run(warehouse.id, warehouse.name);
  }

  const insertShipment = database.prepare(
    "INSERT INTO shipments (id, arrival_at, warehouse_id, min_temp_c, max_temp_c) VALUES (?, ?, ?, ?, ?)",
  );
  for (const shipment of scenario.shipments) {
    insertShipment.run(
      shipment.id,
      shipment.arrivalAt,
      shipment.warehouseId,
      shipment.minTempC,
      shipment.maxTempC,
    );
  }

  const insertEquipment = database.prepare(
    "INSERT INTO installed_equipment (id, warehouse_id, product_sku, min_temp_c, max_temp_c) VALUES (?, ?, ?, ?, ?)",
  );
  for (const equipment of scenario.installedEquipment) {
    insertEquipment.run(
      equipment.id,
      equipment.warehouseId,
      equipment.productSku,
      equipment.minTempC,
      equipment.maxTempC,
    );
  }

  const insertCatalog = database.prepare(
    "INSERT INTO catalog (product_sku, name, min_temp_c, max_temp_c, lead_time_hours, price_cents) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const product of scenario.catalog) {
    insertCatalog.run(
      product.productSku,
      product.name,
      product.minTempC,
      product.maxTempC,
      product.leadTimeHours,
      product.priceCents,
    );
  }

  const insertMetadata = database.prepare(
    "INSERT INTO scenario_metadata (key, value) VALUES (?, ?)",
  );
  insertMetadata.run("scenario_id", scenario.id);
  insertMetadata.run("now", scenario.now);
}

export interface PurchaseOrderRow {
  id: string;
  idempotency_key: string;
  product_sku: string;
  quantity: number;
  warehouse_id: string;
  deliver_by: string;
  created_at: string;
}

export function readPurchaseOrders(database: CompanyDatabase): PurchaseOrderRow[] {
  return database
    .prepare("SELECT * FROM purchase_orders ORDER BY created_at, id")
    .all() as unknown as PurchaseOrderRow[];
}
