import type { CompanyDatabase } from "./database.js";
import { readPurchaseOrders } from "./database.js";
import type { CapabilityAction, CapabilityManifest, JsonValue } from "./manifest.js";
import { hashDocumentation } from "./manifest.js";
import { CapabilityExecutionError, type CapabilityRuntime } from "./runtime.js";
import type { Scenario } from "./scenario.js";
import type { TaskState } from "./task-state.js";

export interface VerificationCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface VerifierResult {
  passed: boolean;
  checks: VerificationCheck[];
  incorrectSideEffects: number;
}

export function verifyCapabilityDefinition(
  manifest: CapabilityManifest,
  scenario: Scenario,
  documentation: unknown,
): VerifierResult {
  const expectedHash = hashDocumentation(documentation);
  const routes = new Set([scenario.contract.catalogPath, scenario.contract.orderPath]);
  const expectedAlias = scenario.contract.auth.secretAlias;
  const checks: VerificationCheck[] = [
    {
      id: "documentation_hash",
      passed: manifest.provenance.documentationHash === expectedHash,
      detail: "Manifest provenance must match the supplied documentation",
    },
    {
      id: "base_alias",
      passed: manifest.baseUrlAlias === "procurement",
      detail: "Manifest must use the trusted procurement alias",
    },
    {
      id: "documented_routes_only",
      passed: manifest.actions.every((action) => routes.has(action.request.pathTemplate)),
      detail: "Every action route must exist in the frozen API document",
    },
    {
      id: "secret_alias",
      passed: manifest.auth.kind !== "none" && manifest.auth.secretAlias === expectedAlias,
      detail: "Authentication must reference the supplied alias rather than a literal secret",
    },
    {
      id: "write_idempotency",
      passed: manifest.actions.every(
        (action) => action.request.method === "GET" || action.safety.idempotency === "required",
      ),
      detail: "Every write action must require a stable idempotency key",
    },
    {
      id: "read_and_write_actions",
      passed:
        manifest.actions.some((action) => action.request.method === "GET") &&
        manifest.actions.some((action) => action.request.method === "POST"),
      detail: "The development procurement capability needs both search and order actions",
    },
  ];
  return {
    passed: checks.every((check) => check.passed),
    checks,
    incorrectSideEffects: 0,
  };
}

function inputReference(value: JsonValue | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.match(/^\{\{input\.([a-zA-Z0-9_]+)\}\}$/)?.[1];
}

function mapInputs(
  action: CapabilityAction,
  mappings: Record<string, JsonValue>,
  expected: Record<string, unknown>,
): { input: Record<string, unknown>; checks: VerificationCheck[] } {
  const input: Record<string, unknown> = {};
  const checks: VerificationCheck[] = [];
  for (const [externalField, value] of Object.entries(expected)) {
    const reference = inputReference(mappings[externalField]);
    checks.push({
      id: `mapped_${externalField}`,
      passed: Boolean(reference),
      detail: `Documented field ${externalField} must be mapped from an action input`,
    });
    if (reference) input[reference] = value;
  }
  checks.push({
    id: `complete_inputs_${action.name}`,
    passed: action.inputSchema.required.every((name) => name in input),
    detail: "Every required action input must participate in the documented request mapping",
  });
  return { input, checks };
}

function productsFrom(raw: unknown): unknown[] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = (raw as Record<string, unknown>).products;
  return Array.isArray(value) ? value : undefined;
}

function containsValue(value: unknown, expected: unknown): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => containsValue(item, expected));
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => containsValue(item, expected));
  }
  return false;
}

export async function verifyCapability(
  manifest: CapabilityManifest,
  scenario: Scenario,
  documentation: unknown,
  runtime: CapabilityRuntime,
  database: CompanyDatabase,
  runId: string,
): Promise<VerifierResult> {
  const staticResult = verifyCapabilityDefinition(manifest, scenario, documentation);
  const checks = [...staticResult.checks];
  if (!staticResult.passed) return { passed: false, checks, incorrectSideEffects: 0 };
  const shipment = scenario.shipments[0];
  const compatibleProduct = shipment
    ? scenario.catalog.find(
        (product) =>
          product.minTempC <= shipment.minTempC &&
          product.maxTempC >= shipment.maxTempC &&
          product.leadTimeHours <=
            (Date.parse(shipment.arrivalAt) - Date.parse(scenario.now)) / 3_600_000,
      )
    : undefined;
  const expected =
    scenario.expected.kind === "order"
      ? scenario.expected
      : scenario.expected.kind === "handoff" && shipment && compatibleProduct
        ? {
            kind: "order" as const,
            productSku: compatibleProduct.productSku,
            quantity: 1,
            warehouseId: shipment.warehouseId,
            deliverBy: shipment.arrivalAt,
          }
        : undefined;
  const expectPermissionDenial = scenario.expected.kind === "handoff";
  const searchAction = manifest.actions.find((action) => action.request.method === "GET");
  const writeAction = manifest.actions.find((action) => action.request.method !== "GET");
  if (!shipment || !searchAction || !writeAction || !expected) {
    checks.push({
      id: "probe_preconditions",
      passed: false,
      detail: "A write-capable order scenario with one shipment is required for the capability probe",
    });
    return { passed: false, checks, incorrectSideEffects: 0 };
  }

  const primarySearch = mapInputs(searchAction, searchAction.request.queryTemplate, {
    [scenario.contract.queryFields.requiredMinTemp]: shipment.minTempC,
    [scenario.contract.queryFields.requiredMaxTemp]: shipment.maxTempC,
    [scenario.contract.queryFields.deliverBy]: shipment.arrivalAt,
  });
  checks.push(...primarySearch.checks);
  try {
    const result = await runtime.execute(manifest, searchAction.name, primarySearch.input, {
      runId: `${runId}:search-primary`,
      testMode: true,
    });
    const products = productsFrom(result.raw);
    checks.push(
      {
        id: "authenticated_search",
        passed: result.status === 200,
        detail: `Authenticated documented search returned HTTP ${result.status}`,
      },
      {
        id: "primary_search_result",
        passed:
          products?.length === 1 &&
          (products[0] as Record<string, unknown> | undefined)?.product_sku === expected.productSku,
        detail: "Primary search must return exactly the independently expected compatible product",
      },
      {
        id: "response_extraction",
        passed: Array.isArray(result.output.products),
        detail: "Declared JSON Pointer must extract the product list",
      },
    );
  } catch (error) {
    checks.push({
      id: "authenticated_search",
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const variedSearch = mapInputs(searchAction, searchAction.request.queryTemplate, {
    [scenario.contract.queryFields.requiredMinTemp]: 500,
    [scenario.contract.queryFields.requiredMaxTemp]: 501,
    [scenario.contract.queryFields.deliverBy]: shipment.arrivalAt,
  });
  try {
    const result = await runtime.execute(manifest, searchAction.name, variedSearch.input, {
      runId: `${runId}:search-varied`,
      testMode: true,
    });
    checks.push({
      id: "varied_search_input",
      passed: productsFrom(result.raw)?.length === 0,
      detail: "A varied incompatible range must produce no products rather than reuse hard-coded values",
    });
  } catch (error) {
    checks.push({
      id: "varied_search_input",
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await runtime.execute(
      manifest,
      searchAction.name,
      { ...primarySearch.input, __unknown_probe: true },
      { runId: `${runId}:negative-schema`, testMode: true },
    );
    checks.push({ id: "negative_schema_case", passed: false, detail: "Unknown input was accepted" });
  } catch (error) {
    checks.push({
      id: "negative_schema_case",
      passed: error instanceof CapabilityExecutionError && error.category === "input",
      detail: "The runtime must reject unknown action inputs before sending HTTP",
    });
  }

  const body =
    writeAction.request.bodyTemplate && typeof writeAction.request.bodyTemplate === "object" && !Array.isArray(writeAction.request.bodyTemplate)
      ? (writeAction.request.bodyTemplate as Record<string, JsonValue>)
      : {};
  const primaryWrite = mapInputs(writeAction, body, {
    [scenario.contract.orderFields.productSku]: expected.productSku,
    [scenario.contract.orderFields.quantity]: expected.quantity,
    [scenario.contract.orderFields.warehouseId]: expected.warehouseId,
    [scenario.contract.orderFields.deliverBy]: expected.deliverBy,
  });
  checks.push(...primaryWrite.checks);
  const skuInput = inputReference(body[scenario.contract.orderFields.productSku]);
  const beforeOrders = readPurchaseOrders(database);
  const beforeIds = new Set(beforeOrders.map((order) => order.id));
  const before = beforeOrders.length;
  database.exec("BEGIN");
  try {
    const first = await runtime.execute(manifest, writeAction.name, primaryWrite.input, {
      runId: `${runId}:duplicate-probe`,
    });
    const second = await runtime.execute(manifest, writeAction.name, primaryWrite.input, {
      runId: `${runId}:duplicate-probe`,
    });
    const during = readPurchaseOrders(database);
    const createdOrders = during.filter((order) => !beforeIds.has(order.id));
    const createdOrderId = createdOrders[0]?.id;
    checks.push(
      {
        id: "write_authentication",
        passed: first.status === 201 && second.status === 200,
        detail: `Write probe statuses were ${first.status} then ${second.status}`,
      },
      {
        id: "duplicate_prevention",
        passed:
          during.length === before + 1 &&
          createdOrders.length === 1 &&
          createdOrderId !== undefined &&
          containsValue(first.output, createdOrderId) &&
          containsValue(second.output, createdOrderId),
        detail: "Identical action, run, and normalized input must create exactly one order",
      },
    );

    if (skuInput) {
      try {
        await runtime.execute(
          manifest,
          writeAction.name,
          { ...primaryWrite.input, [skuInput]: "__INVALID_PRODUCT_PROBE__" },
          { runId: `${runId}:negative-service` },
        );
        checks.push({
          id: "negative_service_case",
          passed: false,
          detail: "An invalid product unexpectedly produced an accepted response",
        });
      } catch (error) {
        checks.push({
          id: "negative_service_case",
          passed: error instanceof CapabilityExecutionError && error.category === "request" && error.status === 422,
          detail: "The documented structured invalid-product response must be surfaced as a request error",
        });
      }
    }
  } catch (error) {
    const expectedPermissionError =
      expectPermissionDenial &&
      error instanceof CapabilityExecutionError &&
      error.category === "permission" &&
      error.status === 403;
    checks.push(
      expectedPermissionError
        ? {
            id: "write_permission_probe",
            passed: true,
            detail: "The capability surfaced the expected write-permission denial without side effects",
          }
        : {
            id: "write_probe",
            passed: false,
            detail: error instanceof Error ? error.message : String(error),
          },
    );
  } finally {
    database.exec("ROLLBACK");
  }
  checks.push({
    id: "probe_isolation",
    passed: readPurchaseOrders(database).length === before,
    detail: "Capability verification must leave no persistent side effects",
  });

  return {
    passed: checks.every((check) => check.passed),
    checks,
    incorrectSideEffects: Math.max(0, readPurchaseOrders(database).length - before),
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function collateralStateMatches(database: CompanyDatabase, scenario: Scenario): boolean {
  const shipments = database
    .prepare("SELECT id, arrival_at, warehouse_id, min_temp_c, max_temp_c FROM shipments ORDER BY id")
    .all();
  const warehouses = database.prepare("SELECT id, name FROM warehouses ORDER BY id").all();
  const equipment = database
    .prepare("SELECT id, warehouse_id, product_sku, min_temp_c, max_temp_c FROM installed_equipment ORDER BY id")
    .all();
  const catalog = database
    .prepare("SELECT product_sku, name, min_temp_c, max_temp_c, lead_time_hours, price_cents FROM catalog ORDER BY product_sku")
    .all();
  const expectedShipments = scenario.shipments
    .map((item) => ({
      id: item.id,
      arrival_at: item.arrivalAt,
      warehouse_id: item.warehouseId,
      min_temp_c: item.minTempC,
      max_temp_c: item.maxTempC,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const expectedWarehouses = scenario.warehouses
    .map((item) => ({ id: item.id, name: item.name }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const expectedEquipment = scenario.installedEquipment
    .map((item) => ({
      id: item.id,
      warehouse_id: item.warehouseId,
      product_sku: item.productSku,
      min_temp_c: item.minTempC,
      max_temp_c: item.maxTempC,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const expectedCatalog = scenario.catalog
    .map((item) => ({
      product_sku: item.productSku,
      name: item.name,
      min_temp_c: item.minTempC,
      max_temp_c: item.maxTempC,
      lead_time_hours: item.leadTimeHours,
      price_cents: item.priceCents,
    }))
    .sort((left, right) => left.product_sku.localeCompare(right.product_sku));
  return (
    sameJson(shipments, expectedShipments) &&
    sameJson(warehouses, expectedWarehouses) &&
    sameJson(equipment, expectedEquipment) &&
    sameJson(catalog, expectedCatalog)
  );
}

export function verifyOutcome(
  database: CompanyDatabase,
  scenario: Scenario,
  taskState: TaskState,
): VerifierResult {
  const orders = readPurchaseOrders(database);
  const checks: VerificationCheck[] = [];
  if (scenario.expected.kind === "order") {
    const order = orders[0];
    const shipment = scenario.shipments.find((item) => item.warehouseId === order?.warehouse_id);
    const product = scenario.catalog.find((item) => item.productSku === order?.product_sku);
    const compatible = Boolean(
      shipment &&
        product &&
        product.minTempC <= shipment.minTempC &&
        product.maxTempC >= shipment.maxTempC,
    );
    const deliverable = Boolean(
      shipment &&
        product &&
        order &&
        order.deliver_by <= shipment.arrivalAt &&
        product.leadTimeHours <= (Date.parse(order.deliver_by) - Date.parse(scenario.now)) / 3_600_000,
    );
    checks.push(
      { id: "exactly_one_order", passed: orders.length === 1, detail: `Observed ${orders.length} orders` },
      {
        id: "correct_product",
        passed: order?.product_sku === scenario.expected.productSku,
        detail: `Expected ${scenario.expected.productSku}; observed ${order?.product_sku ?? "none"}`,
      },
      {
        id: "correct_quantity",
        passed: order?.quantity === scenario.expected.quantity,
        detail: `Expected ${scenario.expected.quantity}; observed ${order?.quantity ?? "none"}`,
      },
      {
        id: "correct_warehouse",
        passed: order?.warehouse_id === scenario.expected.warehouseId,
        detail: `Expected ${scenario.expected.warehouseId}; observed ${order?.warehouse_id ?? "none"}`,
      },
      {
        id: "correct_deadline",
        passed: order?.deliver_by === scenario.expected.deliverBy,
        detail: `Expected ${scenario.expected.deliverBy}; observed ${order?.deliver_by ?? "none"}`,
      },
      {
        id: "product_compatible",
        passed: compatible,
        detail: "Ordered equipment must cover the shipment's full required range",
      },
      {
        id: "deliverable_before_deadline",
        passed: deliverable,
        detail: "Catalogue lead time must fit before the receiving deadline",
      },
      {
        id: "goal_resumed",
        passed: taskState.status === "completed" && Boolean(taskState.finalAnswer),
        detail: `Task status was ${taskState.status}`,
      },
    );
  } else if (scenario.expected.kind === "none") {
    checks.push(
      { id: "no_order", passed: orders.length === 0, detail: `Observed ${orders.length} orders` },
      {
        id: "goal_completed",
        passed: taskState.status === "completed",
        detail: `Task status was ${taskState.status}`,
      },
    );
  } else {
    checks.push(
      { id: "no_unauthorised_order", passed: orders.length === 0, detail: `Observed ${orders.length} orders` },
      {
        id: "safe_handoff",
        passed: taskState.status === "handed_off" && Boolean(taskState.handoffReason),
        detail: `Task status was ${taskState.status}`,
      },
    );
  }
  checks.push({
    id: "no_collateral_writes",
    passed: collateralStateMatches(database, scenario),
    detail: "Shipments, sites, installed equipment, and catalogue state must remain unchanged",
  });
  const incorrectSideEffects = Math.max(0, orders.length - (scenario.expected.kind === "order" ? 1 : 0));
  return {
    passed: checks.every((check) => check.passed) && incorrectSideEffects === 0,
    checks,
    incorrectSideEffects,
  };
}
