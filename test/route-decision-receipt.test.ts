import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRouteDecisionReceipts, validateRouteDecisionReceipt } from "../src/product/route-decision-receipt.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const options = {
  materialDirectory: join(root, "validation", "cf-015-frozen-planning-benchmark-v1"),
  benchmarkReceiptPath: join(root, "output", "cf-015-frozen-planning-benchmark-v1", "execution-receipt.json"),
};
const canonical = (value: any): string => value === null || typeof value !== "object"
  ? JSON.stringify(value)
  : Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
function resign(receipt: any): void {
  const { receiptDigest: _digest, ...unsigned } = receipt;
  receipt.receiptDigest = createHash("sha256").update(canonical(unsigned)).digest("hex");
}

describe("CF-023 tamper-evident route-decision receipts", () => {
  it("creates stable receipts for compiled, handoff and rejected decisions without oracle or value leakage", () => {
    const first = createRouteDecisionReceipts(options); const second = createRouteDecisionReceipts(options);
    expect(first).toEqual(second); expect(first).toHaveLength(6);
    expect(first.map((receipt) => receipt.outcome)).toEqual(["compiled", "compiled", "compiled", "precise-handoff", "rejected", "rejected"]);
    expect(first.every((receipt) => receipt.counterfactuals.map((item) => item.strategy).join() === "adaptive-exhaustive,fixed-policy")).toBe(true);
    expect(first.every((receipt) => !JSON.stringify(receipt).includes("ordinaryGoal") && receipt.oracleAnswersExposed === false && receipt.secretValuesExposed === false)).toBe(true);
    expect(first.map((receipt) => validateRouteDecisionReceipt(receipt, options).receiptDigest)).toEqual(first.map((receipt) => receipt.receiptDigest));
  });

  it.each([
    ["false reason", (receipt: any) => { receipt.reasons[0].detail = "A typed route exists with enabled tools and verifiers, but exact current authority is unavailable."; resign(receipt); }],
    ["missing reason", (receipt: any) => { receipt.reasons = []; }],
    ["mutated candidates", (receipt: any) => { receipt.candidates.pop(); resign(receipt); }],
    ["authority reclassification", (receipt: any) => { receipt.candidates[0].gates.authorityAllowed = !receipt.candidates[0].gates.authorityAllowed; resign(receipt); }],
    ["residual manipulation", (receipt: any) => { receipt.residualCost += 1; resign(receipt); }],
    ["oracle leakage", (receipt: any) => { receipt.oracleAnswers = { expected: true }; }],
  ])("rejects %s", (_label, mutate) => {
    const receipt: any = structuredClone(createRouteDecisionReceipts(options)[0]); mutate(receipt);
    expect(() => validateRouteDecisionReceipt(receipt, options)).toThrow();
  });
});
