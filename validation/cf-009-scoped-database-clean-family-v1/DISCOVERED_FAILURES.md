# CF-009 discovered failures preserved

## CF-009-F1 — privilege-token schema excluded its separator

The first frozen-family load stopped before execution because connection
privileges such as `insert:restock_drafts` were validated with the general key
schema, which did not allow `:`. The fix introduced a narrow privilege grammar
allowing only `insert|update|delete|select` plus one validated identifier. The
family was resealed.

## CF-009-F2 — update reconciliation confused source state with completion

The first executed campaign correctly handled the insert contract but
quarantined normal update cases. The observer saw the pre-existing ticket row
and classified its not-yet-updated values as an incorrect outcome before the
action ran. The fix made update reconciliation require the operation ledger,
while injected fault outcomes create ledger evidence. Action results were not
promoted to proof. The implementation was resealed before the passing run.
