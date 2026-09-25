# CF-038 discovered failures

## CF038-F1 — unanchored native receipt could poison durable state

The first coordinator draft checked family and artifact labels but did not bind a completion to the exact native CF-033 receipt. A conflicting receipt arriving before the genuine receipt could therefore become the durable first writer. The campaign now freezes each native receipt digest at coordinator construction and rejects every mismatched completion before state mutation.

Minimal counterexample: register active routes, submit a document completion with the correct labels but a changed artifact digest, then submit the genuine document completion. Expected and implemented result: the changed completion is rejected and the genuine completion remains admissible.

## CF038-F2 — parent could resume without a committed aggregate

The first coordinator draft treated an arbitrary caller-supplied aggregate string as sufficient for first parent resumption. A reordered parent event could therefore resume before aggregate verification. The coordinator now durably commits the aggregate after all three exact native receipts, and parent resumption requires an exact match to that committed digest.

Minimal counterexample: invoke parent resumption before any aggregate exists. Expected and implemented result: no parent row and no resumption.

Both failures were found and repaired locally before the campaign was frozen. No customer, external service, model, paid, production, or public action was involved.
