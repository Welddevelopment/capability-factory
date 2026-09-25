# Verifier-template qualification checkpoint — 2026-08-14

## Result

Capability Factory now has a generic, fail-closed qualification gate for verifier templates used by the compiled durable capability-resolution path.

A verifier template cannot be treated as executable merely because its key appears in a trusted registry. It must first produce the mandatory verdict for every precommitted negative control:

- completed;
- not started;
- partial;
- incorrect;
- duplicate;
- stale;
- collateral;
- unknown;
- unavailable;
- completed external state after a lost action response; and
- a misleading successful action response without independent external proof.

Only a complete passing corpus produces a qualification receipt. The receipt is integrity-bound to the template key and version, implementation digest, outcome-schema digest, supported runtime family, primitive registry, verifier registry, test corpus, fixed oracle, qualification time, and expiry time. Qualification expires after at most 90 days.

The durable executor checks the exact receipt before accepting a compiled plan. A missing receipt, changed implementation or schema, mutated receipt, expired qualification, wrong runtime family, or mismatched primitive/verifier registry stops before authority checking or any external action.

## Verification

- Focused verifier-template and durable-resolution tests: **11 passed, 0 failed**.
- Strict TypeScript check: **passed**.
- Zero model calls, network calls, containers, paid spend, customer data, deployment, or external action.

## Evidence boundary

This is deterministic local development evidence for a qualification mechanism. It does not show that every existing or future verifier template is already qualified, that a customer integration is safe, that the product is production-ready, or that negative-control coverage is complete for every domain. Each real template still needs a domain-correct independent observation implementation and a frozen representative corpus.
