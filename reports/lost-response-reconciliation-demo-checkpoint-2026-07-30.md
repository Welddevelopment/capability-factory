# Lost-response reconciliation demo checkpoint — 2026-07-30

## Result

The genuine disposable ERPNext broad-goal route now has an opt-in deterministic post-write
response-loss scenario. The first Purchase Order create commits in ERPNext, its response is
discarded at the caller boundary, external state is reconciled before any retry, exactly one
matching Purchase Order is required, and the create is not repeated. The normal route remains
unchanged and emits no reconciliation receipt.

The private console projects the product receipt as an `execution.reconciled` event. The visible
event states that the response was unavailable, one external match was found, the write was not
retried, and a duplicate was prevented. It is followed by independent direct-database outcome
verification and original-goal resumption.

## Verification performed

- TypeScript typecheck passed.
- Full local suite passed: 250 tests; 55 genuine/optional tests skipped by their normal gates.
- Focused genuine ERPNext durable-pilot suite passed: 3/3 tests.
- A fresh live sidecar + console take was run against localhost ERPNext.
- The first child run visibly contained exactly one `execution.reconciled` event.
- The parent run completed with 3 required, 3 satisfied, 0 blocked, and 0 incorrect.
- Direct ERPNext verification reported six intended business writes and zero incorrect side
  effects.

## Boundary

This is deterministic fault injection in a fictional disposable local system. It is strong
evidence that this implemented route reconciles a deliberately lost post-write response without
blindly retrying. It is not a customer deployment, a network-wide reliability result, an
independent security audit, production readiness, or a formal final-green verdict.
