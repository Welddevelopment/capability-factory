# CF-009 — scoped-database generic factory

Date: 2026-08-14

Status: local frozen clean-family checkpoint complete

## Result

CF-009 packages reviewed database actions through one generic provider-neutral
contract factory and one executed clean-family campaign. It preserves the
historical experimental database SDK, reviewed inventory adapter and their
evidence unchanged.

The factory accepts only a strict declarative transaction AST. It has no SQL
string field or callback, validates exact table/column/row scope, typed bounded
parameters, one-statement/one-row limits, conflict keys, declared isolation,
schema and migration pins, connection-profile validity and separate action and
observer identities before emitting a proposal. A proposal performs no write.

The runtime compiles only validated identifiers and uses bound values. Exact
authority is checked again at action time. The action connection's result and
affected-row count are not completion proof: a distinct read-only observer
connection classifies external state before CF-016 recovery can resume or
CF-020 can retain the capability.

This is fictional local SQLite evidence for provider-neutral contracts. It is
not arbitrary SQL, all-database support, production isolation or customer data.

## Frozen contracts

1. `inventory-restock-insert@1.0.0`
   - serializable, single-row insert into `restock_drafts`;
   - exact `operation_key` conflict/row identity;
   - bounded typed SKU, quantity and status parameters; and
   - separate `inventory_writer` / `inventory_auditor` profiles.
2. `support-ticket-update@2.0.0`
   - repeatable-read, single-row update of `support_tickets`;
   - exact ticket ID plus version row scope and conflict identity;
   - typed assignee/status/version parameters; and
   - separate `support_writer` / `support_auditor` profiles.

No per-contract executable parser, query builder, action or verifier callback
was added after freeze. Both declarations traverse the same validator,
compiler, runtime, observer, recovery and lifecycle implementation.

## Campaign

- Contracts: **2**
- Materially different operations: **insert + version-scoped update**
- Frozen fault classes: **30 per contract**
- Cases: **60/60 passed**
- Fixed acceptance cases: **20**
- Additional database-specific cases: **40**
- Proposals: **40**
- Statements committed: **12**
- Fictional business writes: **12**
- Busy/deadlock/timeout retries blocked: **6**
- CF-016 recovery decisions: **24**
- Parent resumptions: **12**
- CF-020 retained continuations: **12**
- Unsafe quarantines: **8**
- Incorrect effects surviving control: **0**
- Model calls / paid spend: **0 / $0**

The campaign exercises schema drift, migration mismatch, injected query fields,
identifier and parameter injection, scope widening, mass update/delete,
shared action/observer identity, missing/expired/revoked authority,
busy/deadlock/timeout, lost response after commit, partial/incorrect/duplicate/
collateral/unknown/unavailable outcomes, restart, duplicate submission,
concurrency, conflicting parent and fresh-process retained reuse.

Busy, deadlock and timeout simulations occur before the transaction and block
blind retry. Lost response occurs after commit and resumes only after the
read-only observer reconciles the exact external outcome. Duplicate submission
and the concurrency stimulus share one idempotency key and commit once.

## Joined controls

- Both contracts separately pass CF-005 verifier-template qualification,
  including lost-response and adversarial action-response controls.
- CF-016 binds recovery to the exact tenant, parent, plan, work item, capability
  version, material and qualified verifier. Unsafe outcomes quarantine;
  unknown/unavailable observation hands off.
- CF-020 retains only independently verified completion, records the workflow
  dependency and permits continuation through the current non-stale version.
- Fresh-process reuse closes and reopens the lifecycle store before continuing.
- Parent resumption uses CF-016's one-time digest-bound receipt.

## Preserved failures

Two failures were retained in
`validation/cf-009-scoped-database-clean-family-v1/DISCOVERED_FAILURES.md`:
the initial privilege-token grammar rejected its own narrow separator, and the
first update campaign confused a pre-existing source row with completed action
state. Both failed closed; neither was waived. The sources were fixed and
resealed before the passing run.

## Verification and boundary

- CF-009 tests: **4/4 passed**.
- Strict repository TypeScript check: passed.
- Frozen family plus both reusable source hashes are verified before execution.
- Historical database source files were not modified.

The SQLite action and observer connections model identity separation but do not
prove operating-system, network or production credential isolation. The two
contracts do not establish portability across SQL dialects or providers. Real
onboarding still requires a customer-owned least-privilege connection profile,
independently owned observer, exact schema/migration evidence and fresh
acceptance results for that database and operation.

No queue edit, commit, network, model, paid call, container, customer data or
customer action was used.
