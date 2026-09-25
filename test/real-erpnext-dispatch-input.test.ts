import { describe, expect, it } from "vitest";
import type { CapabilityAction } from "../src/manifest.js";
import { dispatchInputFor, type DispatchPlanValues } from "../src/customer-world/real-erpnext-dispatch-execution.js";

const values: DispatchPlanValues = {
  orderId: "SO-REAL-0002",
  orderItemId: "SO-ITEM-1",
  customerId: "CUSTOMER-1",
  trackingNumber: "PF-SO-REAL-0002",
  labelReference: "LABEL-SO-REAL-0002",
  idempotencyKey: "delivery-SO-REAL-0002",
};

function action(properties: CapabilityAction["inputSchema"]["properties"]): CapabilityAction {
  return {
    name: "update_sales_order",
    description: "Test action",
    inputSchema: { type: "object", additionalProperties: false, required: Object.keys(properties), properties },
    request: { method: "PUT", pathTemplate: "/test", queryTemplate: {}, headerTemplate: {}, bodyTemplate: {} },
    response: { acceptedStatuses: [200], outputPointers: {} },
    safety: { idempotency: "required", timeoutMs: 1_000, maxResponseBytes: 10_000 },
  };
}

describe("trusted dispatch input classification", () => {
  it("uses explicit tracking and label names even when their descriptions mention the Sales Order", () => {
    expect(dispatchInputFor(action({
      sales_order_name: { type: "string", description: "Exact Sales Order name." },
      tracking_number: { type: "string", description: "Tracking number to apply to the Sales Order." },
      label_reference: { type: "string", description: "Label reference to apply to the Sales Order." },
    }), values)).toEqual({
      sales_order_name: values.orderId,
      tracking_number: values.trackingNumber,
      label_reference: values.labelReference,
    });
  });

  it("rejects an unknown generated name whose description has more than one plausible meaning", () => {
    expect(() => dispatchInputFor(action({
      reference: { type: "string", description: "Tracking reference for the Sales Order." },
    }), values)).toThrow(/ambiguous generated input/i);
  });
});
