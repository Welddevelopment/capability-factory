# CF-008 — signed-message generic factory

Date: 2026-08-14

Status: local frozen clean-family checkpoint complete

## Result

CF-008 raises the existing bounded signed-message mode through one generic
factory and one frozen clean-family campaign without modifying the historical
inbox-message driver or authenticated-ingress evidence. The factory accepts a
message only after exact envelope parsing, tenant-bound trust resolution, key
status and time checks, signature verification, freshness checks, payload
policy validation, and durable nonce/message/order reservation. It emits a
provenance-bound proposal and performs no business action.

The action runtime is separate. It requires exact tenant, parent, plan,
work-item, target, action and approval authority. Completion comes only from a
separate external-state observation against a frozen oracle; neither a valid
signature nor an action response proves completion.

This is local fictional evidence. It is not customer messaging, arbitrary
message understanding, asymmetric-signature support, production reliability
or a public claim.

## Exact contracts

Two distinct contracts were frozen:

1. `json-detached-orders@1.0.0`
   - canonical JSON with a detached signature field;
   - HMAC-SHA-256;
   - strict monotonic sequence ordering; and
   - tenant-local current, revoked, expired and rotated key fixtures.
2. `fixed-embedded-orders@2.0.0`
   - ordered fixed headers plus a bounded line-oriented body;
   - HMAC-SHA-512;
   - unique-message-only ordering, under which a fresh lower sequence is
     allowed; and
   - a separate tenant-local current, revoked, expired and rotated key set.

Both payload contracts declare exact schema version, message and nonce
identity, purchase-order identity, destination, contiguous line numbers,
allowed item codes and a quantity ceiling. Duplicate or reordered headers,
unknown properties, malformed rows and non-canonical JSON fail closed.

## Frozen campaign

- Contracts: **2**
- Envelope families: **2**
- Algorithms: **2**
- Ordering policies: **2**
- Frozen declarative fault classes: **27 per contract**
- Total cases: **54/54 passed**
- Fixed acceptance cases executed: **20** (10 per contract)
- Additional adversarial cases: **34**
- Factory proposals emitted: **35**
- Cases stopped before a proposal: **20**
- Case-specific executable files added after freeze: **0**
- Handwritten reusable source files: **2**

The campaign covers read-only and approved execution, fresh-process reuse,
missing credential and authority, lost response, partial outcome, restart,
duplicate submission, conflicting parent, tampering, unknown/revoked/expired
and rotated keys, algorithm confusion, cross-tenant use, stale/future time,
replay, policy-specific reordering, schema ambiguity, and
incorrect/duplicate/collateral/unknown/unavailable outcome states.

The same reordered-message stimulus is intentionally interpreted differently
by the two frozen contracts: strict monotonic ordering blocks it before action,
while unique-message-only ordering accepts the fresh identity and completes it.
This demonstrates policy dispatch rather than case-specific code.

## Effects

- Fictional SQLite business writes: **13**
- Replay/order reservations rejected: **3**
- CF-016 recovery decisions: **25**
- Parent resumptions: **13**
- CF-020 retained continuations: **13**
- Unsafe outcome quarantines: **8**
- Incorrect side effects surviving control: **0**
- Model calls: **0**
- Paid spend: **$0**

The 13 writes are isolated fictional draft-order records in temporary local
SQLite stores. They are not external requests or customer actions.

## Joined controls

- **Fixed ten-case acceptance:** both contracts traverse the existing generic
  acceptance executor with all ten precommitted cases represented.
- **CF-005:** each contract separately qualifies its outcome verifier against
  every mandatory control, including lost-response reconciliation and
  adversarial action-response rejection.
- **CF-016:** every recovery result is bound to the exact proposal, capability
  material, tenant, plan, work item, runtime family and state version.
  Completed evidence resumes; partial/incorrect/duplicate/collateral evidence
  quarantines; unknown/unavailable evidence hands off.
- **CF-020:** only independently verified completion is retained. The exact
  workflow dependency is registered, the durable store is reopened, and
  continuation is allowed only through the current active non-stale version.
- **Parent resumption:** completion uses CF-016's one-time digest-bound parent
  resumption receipt after independent observation.

## Factory-before-action boundary

Trust and syntax failures produce no proposal. A proposal is not authority and
cannot write. Exact authority is checked again at action time. Replay/order
state is durable SQLite state and is reserved only after signature, trust,
freshness, schema and payload-policy validation. The action response is ignored
for completion; a lost response is reconciled from external state before any
resumption or reuse.

## Preserved history and failure

The historical experimental inbox driver, loop, SDK/registry integration and
authenticated localhost ingress were left unchanged and their tests were run.
The one implementation syntax failure observed before freeze is preserved in
`validation/cf-008-signed-message-clean-family-v1/DISCOVERED_FAILURES.md`.

## Verification

- Frozen CF-008 tests: **4/4 passed**.
- Targeted non-loopback integration validation: **8 files / 46 tests passed**
  alongside CF-008.
- Preserved localhost authenticated-ingress validation: **1 file / 3 tests
  passed separately** outside the listen-restricted sandbox.
- Strict repository TypeScript check: passed.
- Frozen family plus both reusable implementation hashes are checked before
  campaign execution.

No queue edit, commit, network call, model call, paid call, container, customer
data or customer action was used.

## Remaining boundary

The factory supports exactly these two declared fictional order-message
contracts and symmetric HMAC trust. It does not discover schemas, infer unknown
payloads, validate arbitrary message formats, manage a production PKI, provide
non-repudiation, contact a customer system or establish universal signed-message
support. Real onboarding would require customer-owned key custody, rotation and
revocation procedures, an independently owned outcome verifier, and fresh
acceptance evidence for the exact contract.
