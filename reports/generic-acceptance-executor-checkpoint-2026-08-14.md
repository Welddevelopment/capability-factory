# Generic acceptance executor checkpoint — 2026-08-14

## Result

An additive generic executor now owns the fixed ten-case controlled-pilot acceptance campaign independently of any customer-world implementation.

The shared executor owns:

- the mandatory case order;
- a durable distinction between cases merely declared and cases actually executed;
- per-case attempt identity and revision-checked campaign state;
- hash-chained evidence receipts;
- immediate campaign abort when an incorrect side effect survives;
- fail-closed handling of process loss or malformed result evidence;
- restart recovery through independent reconciliation rather than blind action replay; and
- binding and declaration digest checks that prevent a campaign from silently changing underneath its evidence.

Customer-specific behavior enters only through `GenericAcceptanceBinding.execute` and the optional `reconcileInterrupted` method. The latter must inspect independent external state. The generic core never interprets a missing durable result as permission to repeat a write.

## Deliberate boundaries

- This does not convert any declared acceptance scaffold into passing evidence.
- It does not replace or rewrite historical ERPNext, Gitea, browser, file-transfer, or fresh-HTTP results.
- It does not prove that a new customer binding is correct; each binding still requires reviewed, digest-bound operations, authority, reset behavior, external observers, and artifacts.
- The JSON store is a customer-local single-writer reference with revision and integrity checks, not a distributed production campaign service.
- No model call, network service, container, customer data, or external system was used for this checkpoint.

## Verification

Targeted tests cover preparation without execution, exact ordering, receipt chaining, fail-fast safety abort, process-loss recovery without duplicate execution, missing reconciliation, binding changes, state tampering, and malformed evidence. TypeScript typechecking is also required before this checkpoint is considered complete.
