# CF-033 — sealed mixed-family broad-goal execution

Date: 2026-08-14

Status: one fictional local multi-family goal completed

## Result

CF-033 executed one frozen ordinary goal across the native CF-007 pinned
document, CF-008 signed-message and CF-009 scoped-database runtimes:

> Read the approved replenishment form, confirm its separately signed
> instruction, create the exact reviewed restock draft, and verify every result
> independently.

CF-031 selected the three routes and CF-032 gated family compatibility. Neither
route receipts nor conformance receipts were accepted as outcome evidence.
Each item created its family-native proposal/manifest, received exact native
authority, used its own CF-005 qualification and independent observer, passed
CF-016 recovery, and retained/reused through CF-020. Native manifests,
authority, verifier receipts and lifecycle state were never translated between
families.

This is one sealed fictional local goal, not general mixed-family universality.

## Frozen decomposition and routes

1. `document-item`
   - route: CF-007 `document-build-extract`;
   - source: constructible;
   - input: approved pinned PDF;
   - output: typed `document-order` artifact.
2. `message-item`
   - depends on the document item;
   - route: CF-008 `message-existing-ingest`;
   - source: trusted existing;
   - validates the independently signed instruction and emits `message-order`.
3. `database-item`
   - depends on both prior artifacts;
   - route: CF-009 `database-retained-apply`;
   - source: retained active;
   - writes and independently verifies one `database-outcome`.

The three routes exactly match the fixed CF-031/exhaustive baseline: **3/3**.

## Execution effects

- Required work items completed: **3/3**
- Native proposals: **3**
- Native manifests/contracts: **3**
- Fictional local writes: **3**
- Independent observations: **3**
- CF-016 recoveries: **3**
- Item resumptions: **3**
- CF-020 retained continuations: **3**
- Blind retries: **0**
- Parent resumptions: **exactly 1**
- Incorrect side effects surviving: **0**
- Model calls / paid spend: **0 / $0**

All writes were isolated fictional SQLite records. There were no external or
customer-system actions.

## Stop, continuation and reconciliation

The signed-message item first ran with its customer-local key unavailable and
stopped before proposal/action. Its stop receipt binds the exact goal, parent,
plan, work item, raw-message digest and contract digest. The continuation adds
only the credential alias and grant time, binds the stop digest, and resumes the
same saved item without replanning or wider authority.

The document action committed and then lost its response. Both the document
runtime and cross-family coordinator were closed and reopened. The native
read-only observer found the exact outcome, enabling CF-016 recovery without a
retry. This also exercises the crash boundary between family completion and
coordinator receipt persistence.

## Typed lineage and aggregate verification

The durable coordinator stores only claim-isolated native completion receipts
and typed artifact digests:

- document order → signed-message validation;
- document order → database action; and
- message order → database action.

Before the database item, it verifies exact family, artifact type and digest
for both dependencies, then compares the independently derived line items. The
aggregate digest contains all three native observation and recovery digests plus
lineage. The parent accepts this digest once; identical duplicate resumption is
idempotent and a conflicting digest fails.

## Fault campaign

All **12/12** frozen probes failed closed:

- duplicate parent;
- conflicting native-receipt reuse;
- reordered completion before dependencies;
- crash before coordinator receipt;
- stale retained capability;
- quarantined retained capability;
- ambiguous route;
- cross-family artifact substitution;
- cross-family evidence substitution;
- native partial document outcome;
- native incorrect message outcome; and
- native unknown database outcome.

The final three use the respective family-native observer implementations in
isolated fault stores before coordinator rejection.

## Code and configuration reuse

Shared orchestration code is limited to route/conformance gates, typed lineage,
durable coordinator idempotency, native-receipt storage and aggregate parent
completion. Family-specific execution remains in the existing reusable
CF-007/008/009 factories and runtimes. The sealed goal supplies declarative
contracts, authority keys, input fixtures, route IDs, database parameters,
oracles and fault list. No per-case dynamic callback or arbitrary family code
is loaded.

## Verification

- CF-033 tests: **5/5 passed**.
- Strict repository TypeScript check: passed.
- Frozen goal and implementation hashes are checked before execution.
- Repeated isolated executions produced identical aggregate and final receipt
  digests.
- Original CF-007/008/009 evidence remained isolated and unchanged.

Seal digest:
`4c3f6e0a07046c0bcb9ab48a8b84ea5f3de257b7cf61e144f6c8583aa712354c`

No queue edit, commit, network, model, paid call, container, customer data or
customer action was used.

## Boundary

This proves one precommitted fictional three-family goal can route, execute,
verify, retain and resume under the local control stack. It does not establish
arbitrary decomposition, arbitrary artifact conversion, production durability,
customer readiness, universal family interoperability or unattended real-world
execution. Other family combinations and live customer adapters require their
own frozen goal, exact authority, native verification and failure campaign.
