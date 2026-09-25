# Swapping in a founder-supplied customer world

Status: **private implementation guide**

The domain-independent boundary is `src/customer-world/contract.ts`. Logistics and
ERPNext nouns live only in adapters. A founder-supplied WMS, TMS, ERP, CRM, or private API
can replace the current world without changing the acquisition core.

## Information required from the founder

- one real recent ordinary goal that was delayed;
- the exact point where the deployed agent stopped;
- official or customer-approved API documentation;
- a sandbox, disposable self-hosted instance, or synthetic replica;
- least-privilege test credentials;
- the exact external records and fields that prove success;
- forbidden records, duplicate conditions, and collateral state;
- expected behavior when authority, data, or a valid target is missing; and
- permission to reproduce the workflow safely.

Do not request production credentials or private customer data for the first test.

## Adapter steps

1. Implement `CustomerWorldModule` and `CustomerWorldHandle`.
2. Put every domain noun, route, field, and synthetic fixture inside that adapter.
3. Define ordinary-goal cases without saying API, endpoint, integration, manifest, or
   capability.
4. Seed and reset the complete world deterministically.
5. Hash the supplied documentation and record its version.
6. Map credential profiles to trusted runtime configuration; expose aliases only.
7. Bind exact host, route, and method allowlists.
8. Define exact expected, forbidden, duplicate, and collateral state.
9. Implement privileged direct verification that does not trust the worker or API result.
10. Run already-satisfied, fresh build, fresh-session reuse, permission denial, missing
    target/no-action, and retry/reconciliation cases.
11. Add negative controls that intentionally create wrong, duplicate, and collateral
    state; ensure the verifier rejects them.
12. Only after the deterministic adapter passes should a frozen model-backed transfer run
    be considered.

## What remains unchanged

- capability manifests and their schema;
- trusted runtime policy;
- tenant-scoped registry and verification receipts;
- search-existing-before-build ordering;
- authority checks;
- outcome verification requirement;
- resume-and-complete requirement;
- handoff semantics; and
- evidence boundaries.

The existing genuine ERPNext adapter is an example of this swap, not a market commitment.
It revealed a real linked-Account permission dependency absent from the compatible fixture,
which is exactly why a representative external application must eventually be used.
