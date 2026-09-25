# CF-032 — runtime-family conformance and evidence isolation

Date: 2026-08-14

Status: frozen local compatibility checkpoint complete

## Result

CF-032 introduces a versioned compatibility contract and generic conformance
runner for bounded runtime families before CF-033 mixed-family execution. It
extracts shared control expectations from CF-005, CF-016, CF-020, CF-021 and
the CF-007/008/009 clean families without merging their manifests, adapters,
authority, verifier receipts, lifecycle records or acceptance evidence.

Pinned document, signed message and scoped database each passed **18/18**
controls under separate family evidence and route-affordance digests. A
deliberately incomplete fake family failed all 18 controls. These are new
compatibility receipts, not replacements or extensions of the original frozen
acceptance receipts.

## Required control planes

The contract checks:

1. strict family-owned manifest schema;
2. strict proposal schema;
3. provenance and family evidence binding;
4. reproducible CF-031 route affordance;
5. exact authority/credential separation;
6. typed artifact input/output;
7. acyclic dependencies;
8. separate action and read-only observer identities;
9. family-specific CF-005 qualification across every mandatory control;
10. separate declared and executed ten-case acceptance evidence;
11. reconcile-before-retry with blind retry prohibited;
12. restart and resumption evidence;
13. retention health and drift detection;
14. quarantine and higher-version replacement;
15. audit/redaction without evidence secrets;
16. implementation/source sealing;
17. explicit isolated local claims; and
18. rejection of action responses as completion proof.

The reference adapter interface exposes only a family ID and strict declarative
contract. It does not accept callbacks, arbitrary code or dynamic manifests.
Family-specific material remains behind digests; the shared kit does not widen
the document, message or database operation grammar.

## Results

- Family declarations: **4**
- Conformant: **3** — CF-007, CF-008, CF-009
- Deliberately nonconformant: **1**
- Controls per real family: **18/18**
- Seeded/metamorphic mutations: **27**
- Mutations blocked: **27/27**
- Restart/reopen receipt stability: **passed**
- Conflicting replay: **blocked**
- Original acceptance receipts modified: **0**
- Model calls / paid spend: **0 / $0**

The nine mutations applied independently to all three real families cover
cross-family evidence reuse, manifest substitution, authority substitution,
verifier substitution, missing verifier controls, action-response-as-proof,
route metadata drift, dependency cycles and source-seal drift.

## Evidence isolation

Every conformance receipt binds the full family contract, family evidence,
route affordance and claims boundary. A verifier qualification must name the
same family and contain all mandatory CF-005 controls. Acceptance declaration
and execution evidence must be distinct and contain all ten fixed cases.
Action and observer identities must differ, and proof sources may contain only
the independent observer.

The three conformance results do not inherit from one another. Passing the
document adapter says nothing about signed-message or database behavior, and
the shared runner does not convert one family's evidence into another's.

## Verification

- CF-032 tests: **5/5 passed**.
- Strict repository TypeScript check: passed.
- Frozen declaration package and implementation hashes are checked before run.
- SQLite receipt store was closed/reopened and returned identical receipt
  digests; conflicting same-family replay was rejected.
- Existing CF-007/008/009 campaign seals remained readable and unchanged.

Seal digest:
`8db4a0fd23708a4970a1760e1640193b63d3805dc102c380fd3f21b9095a895e`

No queue edit, commit, network, model, paid call, container, customer data or
customer action was used.

## Remaining gaps

This kit verifies declared compatibility and sealed evidence references; it
does not rerun the original family campaigns or prove mixed-family execution.
The local SQLite restart test does not establish production durability. A new
family still needs its own strict schemas, independent observer, verifier
qualification, acceptance campaign and lifecycle evidence. CF-033 must execute
selected routes through their native family controls without treating this
compatibility receipt as completion evidence.
