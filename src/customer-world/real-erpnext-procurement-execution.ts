import type { CapabilityAction, CapabilityManifest } from "../manifest.js";
import { CapabilityRuntime } from "../runtime.js";
import type { ActionReceipt } from "../product/contracts.js";

interface ProcurementValues {
  materialRequestId: string;
  materialRequestItemId: string;
  supplierId: string;
  procurementKey: string;
  purchaseOrderName: string;
}

export const LOST_CREATE_RESPONSE_RECONCILIATION_ACTION =
  "reconcile_create_purchase_order_after_lost_response";

export interface ReconciledProcurementExecutionOptions {
  /**
   * Deterministic local fault injection: commit the create, discard its
   * response at the caller boundary, then require read-only external-state
   * reconciliation before any possible retry. Disabled by default.
   */
  loseCreateResponseAfterCommit?: boolean;
}

class InjectedPostWriteResponseLoss extends Error {
  constructor() {
    super("Injected local fault: the create committed but its response was unavailable to the caller.");
  }
}

function inputFor(action: CapabilityAction, values: ProcurementValues): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(action.inputSchema.properties).map(([name, property]) => {
      const semantic = `${name} ${property.description}`.toLowerCase();
      let value: unknown;
      if (/material.*request.*item|request.*item.*row/.test(semantic)) value = values.materialRequestItemId;
      else if (/purchase.*order.*name|created.*order|order.*reference/.test(semantic)) value = values.purchaseOrderName;
      else if (/supplier/.test(semantic)) value = values.supplierId;
      else if (/procurement.*key|idempot/.test(semantic)) value = values.procurementKey;
      else if (/material.*request|source.*request|request.*name|request.*id/.test(semantic)) {
        value = values.materialRequestId;
      } else if (property.type === "boolean") value = false;
      else throw new Error(`Cannot safely map generated procurement input ${name} for ${action.name}`);
      return [name, value];
    }),
  );
}

function requiredAction(manifest: CapabilityManifest, name: string): CapabilityAction {
  const action = manifest.actions.find((candidate) => candidate.name === name);
  if (!action) throw new Error(`Generated procurement capability is missing required action: ${name}`);
  return action;
}

export async function executeProcurementPlan(
  manifest: CapabilityManifest,
  runtime: CapabilityRuntime,
  materialRequestId: string,
  runId: string,
): Promise<ActionReceipt[]> {
  const provisional: ProcurementValues = {
    materialRequestId,
    materialRequestItemId: "pending-read",
    supplierId: "pending-read",
    procurementKey: `procurement-${materialRequestId}`,
    purchaseOrderName: "pending-create",
  };
  const readAction = requiredAction(manifest, "read_material_request");
  const read = await runtime.execute(manifest, readAction.name, inputFor(readAction, provisional), { runId });
  const data = (read.raw as Record<string, unknown>).data as Record<string, unknown>;
  const items = data.items as Array<Record<string, unknown>>;
  const values: ProcurementValues = {
    ...provisional,
    supplierId: String(data.custom_cf_preferred_supplier),
    materialRequestItemId: String(items[0]?.name),
  };
  const createAction = requiredAction(manifest, "create_purchase_order");
  const create = await runtime.execute(manifest, createAction.name, inputFor(createAction, values), { runId });
  const createData = (create.raw as Record<string, unknown>).data as Record<string, unknown>;
  values.purchaseOrderName = String(createData.name);
  const updateAction = requiredAction(manifest, "update_material_request");
  const update = await runtime.execute(manifest, updateAction.name, inputFor(updateAction, values), { runId });
  return [read, create, update].map<ActionReceipt>((result, index) => ({
    action: [readAction.name, createAction.name, updateAction.name][index]!,
    status: result.status,
    output: result.output,
  }));
}

export async function findExistingPurchaseOrder(
  manifest: CapabilityManifest,
  runtime: CapabilityRuntime,
  materialRequestId: string,
  runId: string,
) {
  const action = requiredAction(manifest, "find_purchase_order");
  return runtime.execute(
    manifest,
    action.name,
    inputFor(action, {
      materialRequestId,
      materialRequestItemId: "unused",
      supplierId: "unused",
      procurementKey: `procurement-${materialRequestId}`,
      purchaseOrderName: "unused",
    }),
    { runId },
  );
}

/**
 * Read-before-write procurement execution for durable jobs. A repeated or
 * recovered work item discovers the existing Purchase Order before deciding
 * whether a create is still required.
 */
export async function executeReconciledProcurementPlan(
  manifest: CapabilityManifest,
  runtime: CapabilityRuntime,
  materialRequestId: string,
  runId: string,
  options: ReconciledProcurementExecutionOptions = {},
): Promise<ActionReceipt[]> {
  const provisional: ProcurementValues = {
    materialRequestId,
    materialRequestItemId: "pending-read",
    supplierId: "pending-read",
    procurementKey: `procurement-${materialRequestId}`,
    purchaseOrderName: "pending-create",
  };
  const receipts: ActionReceipt[] = [];
  const readAction = requiredAction(manifest, "read_material_request");
  const read = await runtime.execute(manifest, readAction.name, inputFor(readAction, provisional), { runId });
  receipts.push({ action: readAction.name, status: read.status, output: read.output });
  const data = (read.raw as Record<string, unknown>).data as Record<string, unknown>;
  const items = data.items as Array<Record<string, unknown>>;
  const values: ProcurementValues = {
    ...provisional,
    supplierId: String(data.custom_cf_preferred_supplier),
    materialRequestItemId: String(items[0]?.name),
  };

  const findAction = requiredAction(manifest, "find_purchase_order");
  const found = await runtime.execute(manifest, findAction.name, inputFor(findAction, values), { runId });
  receipts.push({ action: findAction.name, status: found.status, output: found.output });
  const matches = Array.isArray(found.output.matches) ? found.output.matches as Array<Record<string, unknown>> : [];
  if (matches.length > 1) throw new Error(`Reconciliation found duplicate Purchase Orders for ${materialRequestId}.`);
  if (matches.length === 1) {
    values.purchaseOrderName = String(matches[0]!.name);
  } else {
    const createAction = requiredAction(manifest, "create_purchase_order");
    try {
      const created = await runtime.execute(manifest, createAction.name, inputFor(createAction, values), { runId });
      if (options.loseCreateResponseAfterCommit) throw new InjectedPostWriteResponseLoss();
      const createdData = (created.raw as Record<string, unknown>).data as Record<string, unknown>;
      values.purchaseOrderName = String(createdData.name);
      receipts.push({ action: createAction.name, status: created.status, output: created.output });
    } catch (error) {
      if (!(error instanceof InjectedPostWriteResponseLoss)) throw error;
      const reconciled = await runtime.execute(
        manifest,
        findAction.name,
        inputFor(findAction, values),
        { runId: `${runId}-post-write-reconciliation` },
      );
      const reconciledMatches = Array.isArray(reconciled.output.matches)
        ? reconciled.output.matches as Array<Record<string, unknown>>
        : [];
      if (reconciledMatches.length !== 1) {
        throw new Error(
          `Post-write reconciliation required exactly one Purchase Order for ${materialRequestId}; found ${reconciledMatches.length}.`,
        );
      }
      values.purchaseOrderName = String(reconciledMatches[0]!.name);
      receipts.push({
        action: LOST_CREATE_RESPONSE_RECONCILIATION_ACTION,
        status: reconciled.status,
        output: {
          reason: "post-write-response-lost",
          externalMatches: 1,
          responseReceived: false,
          writeRetried: false,
          duplicatePrevented: true,
        },
      });
    }
  }

  const updateAction = requiredAction(manifest, "update_material_request");
  const updated = await runtime.execute(manifest, updateAction.name, inputFor(updateAction, values), { runId });
  receipts.push({ action: updateAction.name, status: updated.status, output: updated.output });
  return receipts;
}
