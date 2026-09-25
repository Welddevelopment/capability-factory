import type { CapabilityAction, CapabilityManifest } from "../manifest.js";
import type { ActionReceipt } from "../product/contracts.js";
import type { CapabilityRuntime } from "../runtime.js";

export interface DispatchPlanValues {
  orderId: string;
  orderItemId: string;
  customerId: string;
  trackingNumber: string;
  labelReference: string;
  idempotencyKey: string;
}

type DispatchInputKind = "order-item" | "customer" | "order" | "tracking" | "label" | "idempotency";

function classifyDispatchInput(name: string, description: string): DispatchInputKind | null {
  const normalizedName = name.replaceAll(/[^a-z0-9]+/gi, "_").toLowerCase();
  const explicit: Array<[DispatchInputKind, RegExp]> = [
    ["order-item", /(?:sales_?)?order_?item|so_?detail|item_?row/],
    ["tracking", /tracking/],
    ["label", /label/],
    ["idempotency", /idempot/],
    ["customer", /customer/],
    ["order", /sales_?order|order_?(?:name|id)|source_?order/],
  ];
  const named = explicit.filter(([, pattern]) => pattern.test(normalizedName));
  if (named.length > 0) return named[0]![0];

  const text = description.toLowerCase();
  const described = explicit
    .filter(([, pattern]) => pattern.test(text.replaceAll(/[^a-z0-9]+/g, "_")))
    .map(([kind]) => kind)
    .filter((kind, index, all) => all.indexOf(kind) === index);
  if (described.length === 1) return described[0]!;
  if (described.length > 1) {
    throw new Error(`Ambiguous generated input ${name}; its description matches ${described.join(", ")}`);
  }
  return null;
}

export function dispatchInputFor(action: CapabilityAction, values: DispatchPlanValues): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(action.inputSchema.properties).map(([name, property]) => {
      const kind = classifyDispatchInput(name, property.description);
      let value: unknown;
      if (kind === "order-item") value = values.orderItemId;
      else if (kind === "customer") value = values.customerId;
      else if (kind === "order") value = values.orderId;
      else if (kind === "tracking") value = values.trackingNumber;
      else if (kind === "label") value = values.labelReference;
      else if (kind === "idempotency") value = values.idempotencyKey;
      else if (property.type === "boolean") value = false;
      else throw new Error(`Cannot safely map generated input ${name} for ${action.name}`);
      return [name, value];
    }),
  );
}

function requiredAction(manifest: CapabilityManifest, name: string): CapabilityAction {
  const action = manifest.actions.find((candidate) => candidate.name === name);
  if (!action) throw new Error(`Generated capability is missing required action: ${name}`);
  return action;
}

export async function executeDispatchPlan(
  manifest: CapabilityManifest,
  runtime: CapabilityRuntime,
  orderId: string,
  runId: string,
): Promise<ActionReceipt[]> {
  const readAction = requiredAction(manifest, "read_sales_order");
  const provisional: DispatchPlanValues = {
    orderId,
    orderItemId: "pending-read",
    customerId: "pending-read",
    trackingNumber: `PF-${orderId}`,
    labelReference: `LABEL-${orderId}`,
    idempotencyKey: `delivery-${orderId}`,
  };
  const read = await runtime.execute(manifest, readAction.name, dispatchInputFor(readAction, provisional), { runId });
  const data = (read.raw as Record<string, unknown>).data as Record<string, unknown>;
  const items = data.items as Array<Record<string, unknown>>;
  const values: DispatchPlanValues = {
    ...provisional,
    customerId: String(data.customer),
    orderItemId: String(items[0]?.name),
  };

  // Reconcile before a write. A previous response may have been lost even when
  // this particular run has not observed one yet.
  const findAction = requiredAction(manifest, "find_delivery_note");
  const found = await runtime.execute(manifest, findAction.name, dispatchInputFor(findAction, values), { runId });
  const foundData = (found.raw as Record<string, unknown>).data;
  let create: Awaited<ReturnType<CapabilityRuntime["execute"]>> | null = null;
  if (!Array.isArray(foundData) || foundData.length === 0) {
    const createAction = requiredAction(manifest, "create_delivery_note");
    create = await runtime.execute(manifest, createAction.name, dispatchInputFor(createAction, values), { runId });
  }
  const updateAction = requiredAction(manifest, "update_sales_order");
  const update = await runtime.execute(manifest, updateAction.name, dispatchInputFor(updateAction, values), { runId });
  return [
    { action: readAction.name, status: read.status, output: read.output },
    { action: findAction.name, status: found.status, output: found.output },
    ...(create ? [{ action: "create_delivery_note", status: create.status, output: create.output }] : []),
    { action: updateAction.name, status: update.status, output: update.output },
  ];
}
