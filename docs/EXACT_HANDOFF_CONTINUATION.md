# Exact handoff continuation

A handoff is not a generic “try again” button. The current customer-local continuation path
is bound to the saved plan, one blocked work item, the exact missing authority set, the
handoff contents and the durable state version.

- **Credential added:** a signed grant may report the addition, but a trusted customer-local
  verifier checks that the alias can actually be resolved immediately before resumption.
- **Permission approved:** the grant expires and may be durably revoked. The runtime checks
  both conditions before doing anything.
- **Approval changed the action:** if operation, targets, methods or authority set differ,
  continuation is refused. The changed request must become a new parent goal and pass normal
  trusted planning; the old validated plan is never mutated.
- **Possible prior write:** continuation enters reconciliation first. If external state is
  completed it can be verified without repeating the action; if not started it may proceed;
  partial, incorrect or unknown state stops for recovery. Unknown state does not become an
  automatic retry.
- **Duplicate continuation:** a completed grant is idempotent. Replaying it cannot repeat the
  external action.

The local package gives customer adapter runtimes the HMAC continuation authority and an
immutable local revocation store. Production key custody may later move to a customer KMS or
HSM, but the semantic boundary should remain the same.
