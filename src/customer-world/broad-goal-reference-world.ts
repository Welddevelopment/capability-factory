import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OutcomeReceipt, ResumeReceipt } from "../product/contracts.js";
import {
  GOAL_COORDINATION_SCHEMA_VERSION,
  type GoalPlanProposal,
  type TrustedGoalScope,
  type ValidatedGoalPlan,
  type ValidatedGoalWorkItem,
} from "../product/goal-coordination.js";
import type {
  GoalAggregateOutcomeReceipt,
  GoalAggregateOutcomeVerifier,
  GoalAggregateResumer,
  GoalCoordinationState,
  GoalWorkItemExecutionInput,
  GoalWorkItemExecutionReceipt,
  GoalWorkItemExecutor,
  GoalWorkItemOutcomeVerifier,
} from "../product/goal-scheduler.js";

export const BROAD_GOAL_REFERENCE_WORLD_VERSION = "order-operations-reference-v1";
export const BROAD_GOAL_ORDINARY_GOAL =
  "Complete every fictional order due by 21:00 today, and place one safe restock for every required item that is short.";

export type BroadGoalAuthorityScenario = "partial-authority" | "complete-authority";

const WORK = {
  order1042: "order-1042-ready",
  order1048: "order-1048-details",
  coolant: "north-coolant",
  labels: "north-labels",
  crates: "east-crates",
  sensors: "regulated-sensors",
  order1051: "order-1051-rollup",
} as const;

interface ReferenceWorkDefinition {
  key: string;
  groupKey: string;
  groupLabel: string;
  summary: string;
  coverageKey: string;
  entityAlias: string;
  workflowKey: string;
  requiredActions: string[];
  targetAlias: string;
  criterionKey: string;
  dependsOnKeys: string[];
}

const definitions: ReferenceWorkDefinition[] = [
  {
    key: WORK.order1042,
    groupKey: "orders-ready",
    groupLabel: "No action required",
    summary: "Confirm order 1042 already has complete dispatch details and sufficient stock.",
    coverageKey: "coverage-order-1042",
    entityAlias: "order_1042",
    workflowKey: "inspect-order-readiness",
    requiredActions: ["read_order"],
    targetAlias: "orders",
    criterionKey: "order-1042-ready",
    dependsOnKeys: [],
  },
  {
    key: WORK.order1048,
    groupKey: "order-details",
    groupLabel: "Complete order details",
    summary: "Complete the missing delivery reference for order 1048.",
    coverageKey: "coverage-order-1048",
    entityAlias: "order_1048",
    workflowKey: "complete-order-details",
    requiredActions: ["read_order", "update_order"],
    targetAlias: "orders",
    criterionKey: "order-1048-details",
    dependsOnKeys: [],
  },
  {
    key: WORK.coolant,
    groupKey: "supplier-north",
    groupLabel: "North Supply restock",
    summary: "Restock coolant packs required by orders due before 21:00.",
    coverageKey: "coverage-coolant",
    entityAlias: "sku_coolant_pack",
    workflowKey: "restock-north-supply",
    requiredActions: ["read_stock", "find_restock", "create_restock"],
    targetAlias: "supplier_north",
    criterionKey: "coolant-restock-once",
    dependsOnKeys: [],
  },
  {
    key: WORK.labels,
    groupKey: "supplier-north",
    groupLabel: "North Supply restock",
    summary: "Restock cold-chain labels required by orders due before 21:00.",
    coverageKey: "coverage-labels",
    entityAlias: "sku_cold_chain_labels",
    workflowKey: "restock-north-supply",
    requiredActions: ["read_stock", "find_restock", "create_restock"],
    targetAlias: "supplier_north",
    criterionKey: "labels-restock-once",
    dependsOnKeys: [],
  },
  {
    key: WORK.crates,
    groupKey: "supplier-east",
    groupLabel: "East Industrial restock",
    summary: "Restock insulated crates through the documented East Industrial API.",
    coverageKey: "coverage-crates",
    entityAlias: "sku_insulated_crate",
    workflowKey: "restock-east-industrial",
    requiredActions: ["read_stock", "find_restock", "create_restock"],
    targetAlias: "supplier_east",
    criterionKey: "crates-restock-once",
    dependsOnKeys: [],
  },
  {
    key: WORK.sensors,
    groupKey: "supplier-regulated",
    groupLabel: "Regulated supplier restock",
    summary: "Place one calibrated-sensor restock only when the configured authority permits it.",
    coverageKey: "coverage-sensors",
    entityAlias: "sku_calibrated_sensor",
    workflowKey: "restock-regulated-supplier",
    requiredActions: ["read_stock", "find_restock", "create_regulated_restock"],
    targetAlias: "supplier_regulated",
    criterionKey: "sensors-restock-once",
    dependsOnKeys: [],
  },
  {
    key: WORK.order1051,
    groupKey: "order-finalization",
    groupLabel: "Finalize dependent order",
    summary: "Finalize order 1051 after its insulated-crate restock is externally verified.",
    coverageKey: "coverage-order-1051",
    entityAlias: "order_1051",
    workflowKey: "finalize-order-readiness",
    requiredActions: ["read_order", "update_order"],
    targetAlias: "orders",
    criterionKey: "order-1051-finalized",
    dependsOnKeys: [WORK.crates],
  },
];

function operationSet(targetAlias: string) {
  if (targetAlias === "orders") {
    return [
      { name: "read_order", method: "GET" as const },
      { name: "update_order", method: "PUT" as const, requiredCompanionActions: ["read_order"] },
    ];
  }
  const create = targetAlias === "supplier_regulated" ? "create_regulated_restock" : "create_restock";
  return [
    { name: "read_stock", method: "GET" as const },
    { name: "find_restock", method: "GET" as const },
    {
      name: create,
      method: "POST" as const,
      requiredCompanionActions: ["read_stock", "find_restock"],
    },
  ];
}

export function createBroadGoalTrustedScope(
  parentGoalId: string,
  requestId: string,
  scenario: BroadGoalAuthorityScenario,
  ordinaryGoal = BROAD_GOAL_ORDINARY_GOAL,
): TrustedGoalScope {
  const targetAliases = ["orders", "supplier_north", "supplier_east", "supplier_regulated"];
  const approvedWriteActions = scenario === "complete-authority"
    ? ["update_order", "create_restock", "create_regulated_restock"]
    : ["update_order", "create_restock"];
  return {
    tenantId: "local-alpha",
    parentGoalId,
    requestId,
    ordinaryGoal,
    deadline: { key: "today-2100", description: "Today at 21:00 in the fictional local business timezone." },
    entities: definitions.map((definition) => ({
      alias: definition.entityAlias,
      kind: definition.entityAlias.startsWith("order_") ? "order" : "inventory-item",
      systemAliases: [definition.targetAlias],
    })),
    systems: targetAliases.map((targetAlias) => ({
      targetAlias,
      credentialAliases: [`${targetAlias}_key`],
      operations: operationSet(targetAlias),
    })),
    completionCriteria: definitions.map((definition) => ({
      key: definition.criterionKey,
      summary: `Directly verify ${definition.summary.toLowerCase()}`,
      verifierKey: `reference-direct-${definition.key}-v1`,
    })),
    requiredCoverage: definitions.map((definition) => ({
      key: definition.coverageKey,
      entityAliases: [definition.entityAlias],
      workflowKey: definition.workflowKey,
      requiredActions: [...definition.requiredActions],
      targetAliases: [definition.targetAlias],
      completionCriterionKeys: [definition.criterionKey],
      ...(definition.dependsOnKeys.length > 0
        ? {
            dependsOnCoverageKeys: definition.dependsOnKeys.map(
              (key) => definitions.find((candidate) => candidate.key === key)!.coverageKey,
            ),
          }
        : {}),
    })),
    authority: {
      allowedTargetAliases: targetAliases,
      allowedSecretAliases: targetAliases.map((targetAlias) => `${targetAlias}_key`),
      allowedMethods: ["GET", "POST", "PUT"],
      writeAuthority: "per-action-approval",
      approvedWriteActions,
    },
  };
}

export function createBroadGoalPlanProposal(): GoalPlanProposal {
  return {
    schemaVersion: GOAL_COORDINATION_SCHEMA_VERSION,
    deadlineKey: "today-2100",
    summary: "Inspect every due order, complete missing order details, create each required restock exactly once, and finalize dependent orders only after stock outcomes are verified.",
    workItems: definitions.map((definition) => ({
      key: definition.key,
      groupKey: definition.groupKey,
      groupLabel: definition.groupLabel,
      summary: definition.summary,
      coverageKeys: [definition.coverageKey],
      entityAliases: [definition.entityAlias],
      workflowKey: definition.workflowKey,
      requiredActions: [...definition.requiredActions],
      targetAliases: [definition.targetAlias],
      completionCriterionKeys: [definition.criterionKey],
      dependsOnKeys: [...definition.dependsOnKeys],
    })),
  };
}

interface OrderRow {
  id: string;
  delivery_reference: string | null;
  finalized: number;
}

interface InventoryRow {
  sku: string;
  required_quantity: number;
  supplier: string;
}

interface RestockRow {
  sku: string;
  supplier: string;
  quantity: number;
  operation_key: string;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class BroadGoalReferenceWorld
  implements GoalWorkItemExecutor, GoalWorkItemOutcomeVerifier, GoalAggregateOutcomeVerifier, GoalAggregateResumer
{
  readonly database: DatabaseSync;

  constructor(databasePath = ":memory:") {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    const initialized = this.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orders'").get();
    if (!initialized) this.reset();
  }

  reset(): void {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      DROP TABLE IF EXISTS operations;
      DROP TABLE IF EXISTS restocks;
      DROP TABLE IF EXISTS inventory;
      DROP TABLE IF EXISTS orders;
      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        delivery_reference TEXT,
        finalized INTEGER NOT NULL CHECK (finalized IN (0, 1))
      );
      CREATE TABLE inventory (
        sku TEXT PRIMARY KEY,
        available_quantity INTEGER NOT NULL,
        required_quantity INTEGER NOT NULL,
        supplier TEXT NOT NULL
      );
      CREATE TABLE restocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sku TEXT NOT NULL,
        supplier TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        operation_key TEXT NOT NULL UNIQUE,
        FOREIGN KEY (sku) REFERENCES inventory(sku)
      );
      CREATE TABLE operations (
        operation_key TEXT PRIMARY KEY,
        work_key TEXT NOT NULL,
        execution_path TEXT NOT NULL
      );
      INSERT INTO orders VALUES
        ('order_1042', 'DEL-1042', 1),
        ('order_1048', NULL, 0),
        ('order_1051', 'DEL-1051', 0);
      INSERT INTO inventory VALUES
        ('sku_coolant_pack', 0, 5, 'supplier_north'),
        ('sku_cold_chain_labels', 2, 10, 'supplier_north'),
        ('sku_insulated_crate', 0, 3, 'supplier_east'),
        ('sku_calibrated_sensor', 0, 1, 'supplier_regulated');
    `);
  }

  close(): void {
    this.database.close();
  }

  async execute(input: GoalWorkItemExecutionInput): Promise<GoalWorkItemExecutionReceipt> {
    const prior = this.database.prepare("SELECT operation_key FROM operations WHERE operation_key = ?").get(
      input.item.operationKey,
    );
    if (prior) {
      return this.executionReceipt(input.item, "executed", this.pathFor(input.item), 0, "Reconciled the already-recorded operation without repeating a write.");
    }

    if (this.itemSatisfied(input.item)) {
      return this.executionReceipt(input.item, "already-satisfied", "already-satisfied", 0, "Trusted external state already satisfied this work item.");
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.applyWorkItem(input.item);
      this.database.prepare("INSERT INTO operations (operation_key, work_key, execution_path) VALUES (?, ?, ?)").run(
        input.item.operationKey,
        input.item.key,
        this.pathFor(input.item),
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.executionReceipt(input.item, "executed", this.pathFor(input.item), 1, "Applied one idempotent fictional business-state change.");
  }

  async verify(
    plan: ValidatedGoalPlan,
    item: ValidatedGoalWorkItem,
    execution: GoalWorkItemExecutionReceipt,
  ): Promise<OutcomeReceipt>;
  async verify(
    plan: ValidatedGoalPlan,
    state: GoalCoordinationState,
  ): Promise<GoalAggregateOutcomeReceipt>;
  async verify(
    plan: ValidatedGoalPlan,
    itemOrState: ValidatedGoalWorkItem | GoalCoordinationState,
    _execution?: GoalWorkItemExecutionReceipt,
  ): Promise<OutcomeReceipt | GoalAggregateOutcomeReceipt> {
    if ("workItemId" in itemOrState) return this.verifyItem(itemOrState);
    return this.verifyAggregate(plan, itemOrState);
  }

  async resume(_plan: ValidatedGoalPlan, receipt: GoalAggregateOutcomeReceipt): Promise<ResumeReceipt> {
    const clean = receipt.result === "complete" && receipt.passed && receipt.incorrectSideEffects === 0;
    return {
      completed: clean,
      summary: clean
        ? "The fictional customer agent received the independently verified aggregate outcome."
        : "The broad goal was not resumed because its aggregate outcome was not cleanly complete.",
    };
  }

  stateSnapshot(): Record<string, unknown> {
    return {
      orders: this.database.prepare("SELECT * FROM orders ORDER BY id").all(),
      inventory: this.database.prepare("SELECT * FROM inventory ORDER BY sku").all(),
      restocks: this.database.prepare("SELECT * FROM restocks ORDER BY id").all(),
      operations: this.database.prepare("SELECT * FROM operations ORDER BY work_key").all(),
    };
  }

  private verifyItem(item: ValidatedGoalWorkItem): OutcomeReceipt {
    const passed = this.itemSatisfied(item);
    const entity = item.entityAliases[0]!;
    const restocks = entity.startsWith("sku_") ? this.restocksFor(entity) : [];
    const incorrectSideEffects = restocks.filter((row) => !this.validRestockFor(item, row)).length;
    return {
      verifierVersion: `${BROAD_GOAL_REFERENCE_WORLD_VERSION}:item-verifier`,
      passed: passed && incorrectSideEffects === 0,
      intendedWrites: this.definitionForItem(item)?.key === WORK.order1042 ? 0 : 1,
      incorrectSideEffects,
      stateDigest: digest(this.relevantState(item)),
      checks: [
        { id: `criterion:${item.completionCriteria[0]!.key}`, passed, detail: "Direct SQLite state was checked independently of the executor receipt." },
        { id: "exact-write-and-duplicate-prevention", passed: incorrectSideEffects === 0, detail: "Any restock row has the exact trusted item, supplier, quantity, and operation key, with no duplicate." },
      ],
      verifiedAt: new Date().toISOString(),
    };
  }

  private verifyAggregate(plan: ValidatedGoalPlan, state: GoalCoordinationState): GoalAggregateOutcomeReceipt {
    const items = Object.values(state.items);
    const completedItems = items.filter((item) => item.lifecycle === "completed").length;
    const blockedItems = items.filter((item) => item.lifecycle === "blocked").length;
    const failedItems = items.filter((item) => item.lifecycle === "failed").length;
    const unknownItems = items.length - completedItems - blockedItems - failedItems;
    const allRestocks = this.database.prepare(
      "SELECT sku, supplier, quantity, operation_key FROM restocks ORDER BY id",
    ).all() as unknown as RestockRow[];
    const invalidRestocks = allRestocks.filter((row) => {
      const definition = definitions.find((candidate) => candidate.entityAlias === row.sku);
      const planned = definition
        ? plan.workItems.find((candidate) => candidate.coverageKeys.includes(definition.coverageKey))
        : undefined;
      const itemState = planned ? state.items[planned.workItemId] : undefined;
      return !planned || itemState?.lifecycle !== "completed" || !this.validRestockFor(planned, row);
    });
    const duplicateRestocks = allRestocks.length - new Set(allRestocks.map((row) => row.sku)).size;
    const itemForDefinition = (definitionKey: string) => {
      const definition = definitions.find((candidate) => candidate.key === definitionKey)!;
      return plan.workItems.find((candidate) => candidate.coverageKeys.includes(definition.coverageKey))!;
    };
    const order1048 = itemForDefinition(WORK.order1048);
    const order1051 = itemForDefinition(WORK.order1051);
    const order1042Definition = definitions.find((candidate) => candidate.key === WORK.order1042)!;
    const order1042Clean = this.definitionSatisfied(order1042Definition, itemForDefinition(WORK.order1042));
    const order1048Row = this.order("order_1048");
    const order1051Row = this.order("order_1051");
    const incorrectOrderMutations = [
      order1042Clean,
      state.items[order1048.workItemId]?.lifecycle === "completed"
        ? order1048Row?.delivery_reference === "DEL-1048" && order1048Row.finalized === 0
        : order1048Row?.delivery_reference === null && order1048Row.finalized === 0,
      state.items[order1051.workItemId]?.lifecycle === "completed"
        ? order1051Row?.delivery_reference === "DEL-1051" && order1051Row.finalized === 1
        : order1051Row?.delivery_reference === "DEL-1051" && order1051Row.finalized === 0,
    ].filter((passed) => !passed).length;
    const incorrectSideEffects = invalidRestocks.length + incorrectOrderMutations;
    const everyRequiredSatisfied = definitions.every((definition) => {
      const planned = plan.workItems.find((candidate) => candidate.coverageKeys.includes(definition.coverageKey));
      const item = planned ? state.items[planned.workItemId] : undefined;
      if (!planned || !item || item.lifecycle !== "completed") return false;
      return this.definitionSatisfied(definition, planned);
    });
    const result: GoalAggregateOutcomeReceipt["result"] = failedItems > 0
      ? "failed"
      : unknownItems > 0
        ? "unknown"
        : blockedItems > 0
          ? completedItems > 0 ? "partially-complete" : "blocked"
          : everyRequiredSatisfied ? "complete" : "unknown";
    const passed = result === "complete" && everyRequiredSatisfied && incorrectSideEffects === 0;
    return {
      verifierVersion: `${BROAD_GOAL_REFERENCE_WORLD_VERSION}:aggregate-verifier`,
      receiptId: digest({ parentGoalId: state.parentGoalId, version: state.version, snapshot: this.stateSnapshot() }).slice(0, 32),
      result,
      passed,
      requiredItems: items.length,
      completedItems,
      blockedItems,
      failedItems,
      unknownItems,
      incorrectSideEffects,
      stateDigest: digest(this.stateSnapshot()),
      checks: [
        { id: "all-required-external-state", passed: everyRequiredSatisfied, detail: "Every completed required item was re-read from the external reference database." },
        { id: "no-duplicate-restocks", passed: duplicateRestocks === 0, detail: "No SKU has more than one restock row." },
        { id: "exact-authorized-restocks", passed: invalidRestocks.length === 0, detail: "Every restock belongs to a completed authorized item and exactly matches its trusted contract." },
        { id: "unrelated-order-state-preserved", passed: incorrectOrderMutations === 0, detail: "Order fields outside each completed work-item contract remain unchanged." },
      ],
      verifiedAt: new Date().toISOString(),
    };
  }

  private executionReceipt(
    item: ValidatedGoalWorkItem,
    status: GoalWorkItemExecutionReceipt["status"],
    path: GoalWorkItemExecutionReceipt["path"],
    writesAttempted: number,
    summary: string,
  ): GoalWorkItemExecutionReceipt {
    return {
      status,
      path,
      childRunId: `child-${item.workItemId}`,
      operationKey: item.operationKey,
      writesAttempted,
      summary,
    };
  }

  private pathFor(item: ValidatedGoalWorkItem): GoalWorkItemExecutionReceipt["path"] {
    // This reference-world executor proves coordination and external-state
    // verification only. A capability-acquisition adapter may wrap selected
    // items later; until it really does, it must not claim build/reuse/search.
    return "existing-ability";
  }

  private applyWorkItem(item: ValidatedGoalWorkItem): void {
    const definition = this.definitionForItem(item);
    if (!definition) throw new Error(`Unsupported trusted reference coverage: ${item.coverageKeys.join(", ")}`);
    if (definition.key === WORK.order1048) {
      this.database.prepare("UPDATE orders SET delivery_reference = ? WHERE id = ?").run("DEL-1048", "order_1048");
      return;
    }
    if (definition.key === WORK.order1051) {
      if (this.restocksFor("sku_insulated_crate").length !== 1) {
        throw new Error("Order 1051 cannot finalize before exactly one insulated-crate restock exists.");
      }
      this.database.prepare("UPDATE orders SET finalized = 1 WHERE id = ?").run("order_1051");
      return;
    }
    const sku = item.entityAliases[0];
    if (!sku?.startsWith("sku_")) throw new Error(`Unsupported reference work item: ${definition.key}`);
    const inventory = this.database.prepare("SELECT sku, required_quantity, supplier FROM inventory WHERE sku = ?").get(sku) as InventoryRow | undefined;
    if (!inventory) throw new Error(`Unknown trusted inventory item: ${sku}`);
    this.database.prepare("INSERT INTO restocks (sku, supplier, quantity, operation_key) VALUES (?, ?, ?, ?)").run(
      inventory.sku,
      inventory.supplier,
      inventory.required_quantity,
      item.operationKey,
    );
  }

  private itemSatisfied(item: ValidatedGoalWorkItem): boolean {
    const definition = this.definitionForItem(item);
    return definition ? this.definitionSatisfied(definition, item) : false;
  }

  private definitionForItem(item: ValidatedGoalWorkItem): ReferenceWorkDefinition | undefined {
    return definitions.find((definition) => item.coverageKeys.includes(definition.coverageKey));
  }

  private definitionSatisfied(definition: ReferenceWorkDefinition, item?: ValidatedGoalWorkItem): boolean {
    if (definition.key === WORK.order1042) {
      const order = this.order("order_1042");
      return order?.delivery_reference === "DEL-1042" && order.finalized === 1;
    }
    if (definition.key === WORK.order1048) return this.order("order_1048")?.delivery_reference === "DEL-1048";
    if (definition.key === WORK.order1051) return this.order("order_1051")?.finalized === 1;
    const rows = this.restocksFor(definition.entityAlias);
    return rows.length === 1 && !!item && this.validRestockFor(item, rows[0]!);
  }

  private validRestockFor(item: ValidatedGoalWorkItem, row: RestockRow): boolean {
    const inventory = this.database.prepare(
      "SELECT sku, required_quantity, supplier FROM inventory WHERE sku = ?",
    ).get(item.entityAliases[0]!) as unknown as InventoryRow | undefined;
    return !!inventory &&
      row.sku === inventory.sku &&
      row.supplier === inventory.supplier &&
      row.quantity === inventory.required_quantity &&
      row.operation_key === item.operationKey;
  }

  private relevantState(item: ValidatedGoalWorkItem): unknown {
    const entity = item.entityAliases[0]!;
    return entity.startsWith("order_") ? this.order(entity) : this.restocksFor(entity);
  }

  private order(id: string): OrderRow | undefined {
    return this.database.prepare("SELECT id, delivery_reference, finalized FROM orders WHERE id = ?").get(id) as OrderRow | undefined;
  }

  private restocksFor(sku: string): RestockRow[] {
    return this.database.prepare("SELECT sku, supplier, quantity, operation_key FROM restocks WHERE sku = ? ORDER BY id").all(sku) as unknown as RestockRow[];
  }
}
