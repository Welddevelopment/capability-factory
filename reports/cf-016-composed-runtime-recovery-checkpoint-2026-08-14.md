# CF-016 — composed-runtime recovery, resumption and retained reuse

Date: 2026-08-14

Status: local technical checkpoint complete

## Scope

This checkpoint adds one customer-local, runtime-family-neutral recovery coordinator. It does not perform customer actions, network access, model calls, container work or deployment. It does not change the frozen CF-006/CF-014 campaign sources or their evidence.

The coordinator is implemented in `src/product/composed-runtime-recovery.ts` and tested in `test/composed-runtime-recovery.test.ts`.

## Typed recovery contract

Every decision is integrity-bound to the exact tenant, parent goal, plan ID and digest, work item, state version, runtime family, capability key and version, capability-qualification digest, idempotency key and independent observation.

The state machine covers:

- `completed`: only independent evidence with zero incorrect side effects can produce `verified-completion`; action responses are not evidence.
- `not-started`: one retry permit can be issued only after a separately bound, live authority recheck. The permit is durable and consumable once.
- `partial`, `incorrect`, `duplicate`, `stale`, `collateral`: quarantine and invalidate the exact retained capability binding.
- `unknown`, `unavailable`: precise handoff; no retry and no verified completion.
- `lost-response`: an entered state, never a completion claim. Independent reconciliation produces one of the nine external-state classifications before policy selection.

Cross-plan, cross-work-item, cross-state-version, cross-family, cross-capability-version and cross-qualification evidence is rejected. A `completed` declaration carrying any incorrect side effect is rejected.

## Parent resumption and retained reuse

Parent resumption requires one distinct verified-completion receipt per supplied work item plus aggregate evidence, all bound to the same tenant/parent/plan. The external resumption key is deterministic. The coordinator records the attempt before execution, reconciles after a lost response, and never executes the parent a second time. A completed receipt is returned idempotently.

Retention is allowed only from a valid verified-completion receipt. Reuse requires the exact tenant, runtime family, capability key, version and qualification digest. A stale or unsafe external-state classification invalidates that retained binding; later reuse fails closed.

## Family exercise

The same policy matrix ran across:

1. `generic-local-sqlite` — the reusable SQLite family used by the sealed multi-family work.
2. `generic-local-schema-file` — the reusable schema-selected file family used by the sealed multi-family work.
3. `experimental-document-actions` — the existing bounded document-driver family identifier and its existing `complete | not-started | partial | incorrect | unknown` outcome vocabulary, adapted without upgrading the underlying document evidence.

This checkpoint validates contract portability. It does not rerun or strengthen the frozen sealed-family campaign, and it does not claim broader document reliability.

## Fault injection

Fourteen transition boundaries are explicit and tested:

- before reconciliation;
- when a lost action response is recorded;
- after independent observation;
- before and after authority recheck;
- before and after retry-permit consumption;
- before retention and retained reuse;
- before parent resumption;
- at lost parent response;
- before and after parent reconciliation; and
- before the parent-completion receipt is committed.

Faults before durable changes leave no unsafe transition. Faults inside retry consumption roll back the transaction. Faults after a parent attempt force reconciliation on the next call rather than another execution.

## Verification

- Strict TypeScript check: passed (`tsc --noEmit`).
- Focused CF-016 test file: 8/8 passed.
- No external network, model, paid, container or customer action was used.
- No coordination queue edit or commit was made for this task.

## Boundary note

The existing sealed campaign runtimes contain campaign-local recovery callbacks whose source hashes are part of their frozen evidence. This work deliberately did not rewrite those sealed sources. Instead, it supplies the reusable recovery primitive for new composed runtimes and a typed adapter for the existing bounded-driver outcome vocabulary. Migrating a frozen campaign to the coordinator would require a new campaign version and a fresh seal; silently changing the old campaign would invalidate its evidence.
