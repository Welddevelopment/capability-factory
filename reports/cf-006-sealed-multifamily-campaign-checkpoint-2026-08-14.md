# CF-006 sealed multi-family typed-dataflow and restart campaign

Date: **2026-08-14**

Status: **passed as deterministic fictional local evidence; no customer, production, universality or public claim**

## Result

One precommitted unfamiliar lichen-nursery transfer goal compiled into three
typed work items and completed across two genuinely different implemented
local runtime families:

1. a customer-local SQLite transaction recorded the approved transfer;
2. an exclusive fixed-width filesystem writer consumed the independently
   verified `lichen-transfer-record-v1` artifact and emitted the dispatch
   capsule; and
3. the retained SQLite capability was reused to consume the verified file
   result and mark the transfer dispatched.

The families are not two protocol aliases. One performs transactional relational
state changes and observes rows through a separate read-only database connection;
the other performs exclusive local file creation and observes exact bytes through
the filesystem.

## Seal and chronology

The counted v2 seal binds the fixture, ordinary-goal/input graph, exact authority,
fault point, oracle, and the exact source hashes of the compiler, durable executor,
verified-artifact store, verifier-qualification gate and campaign runtime.

- v2 seal digest:
  `6460aed47141b143fc8d3a6c8bab7bbec49080415953988d43cf441a7b58e589`
- fixture hash:
  `f8970444b5f27961f66616bfe98baa66b9e1c97ab2980ef939a02fde5b420280`
- input hash:
  `561bd8ecf442d15a0fd6360bb50bce40f925f25ee0ca973d01a17ad7c4b0b938`
- oracle hash:
  `ce59a548e8dd01845352ba1358f2a1b63517583dcbbc4fc90af92392e49d7408`
- compiled plan digest:
  `10e354bf3a74a60bc04e373ec41a85a97f5223d6ba833d8b30b7879e9bd68b7b`

No v2 source, fixture, input, oracle or seal byte changed after unsealing.

The earlier v1 seal is preserved but explicitly invalidated. Its first run
correctly failed aggregate verification because a formatter emitted a
25-character padded field while its frozen oracle required 24. The formatter
was repaired after observation, so v1 had an author bridge and is not counted.
The fresh v2 seal was formed only after that implementation and harness were
stable.

## Exact campaign evidence

- job: `autonomous-completion` after **2** durable attempts;
- durable recovery: **1** interrupted job recovered in a fresh executor/runtime
  instance;
- lost action response: **1** independent reconciliation, **0** replayed writes;
- exact live authority: **3/3** work items checked against the compiled plan;
- typed verified artifacts: **3/3** items verified and retained; the SQLite →
  fixed-width boundary used `lichen-transfer-record-v1`;
- verifier qualification: **11/11** mandatory controls passed for each of the
  two family-specific templates, **22/22** in total;
- external business writes: **3** total — **2** SQLite actions and **1** file
  action;
- retained capabilities: **2**, including **1** actual reuse of the SQLite
  capability on the final item;
- aggregate direct-state verification: passed with **0** surviving incorrect
  side effects;
- parent resumption: **1** external execution and **1** independent
  reconciliation after its response was deliberately lost; no second
  resumption;
- protected pre-existing ledger row and outbox file: preserved exactly;
- model calls: **0**;
- paid spend: **USD 0**;
- network requests, external services, containers and customer systems: **0**.

Aggregate evidence digest:
`4820d6c85d2e484d4bba0814163e7653ccc1770266a2f3fde2774921a724acf0`.

Execution receipt internal digest:
`8f21c60498600e0e37bc08588f88377f0d9256eef1e2fb4c5176b65e429264c9`.
The receipt file SHA-256, including pretty-print whitespace and final newline,
is `a9a9b1dbfdc2e425cf19d7ae5e6863003781a7d89f59c6e1a053f369e16242d1`.

Private receipt:
`output/sealed-multifamily-campaign-v2/execution-receipt.json`.

## Validation

- strict TypeScript typecheck: passed;
- focused compiler, durable executor, verified-artifact,
  verifier-qualification and sealed-campaign tests: **22/22 passed** across
  **5/5 files**;
- explicit seal-tamper test: passed by failing closed before world creation;
- `git diff --check`: passed.

## Remaining gaps

This is one deterministic fictional local campaign. It does not establish
population reliability, effective universality, arbitrary database or file
compatibility, production recovery, independent third-party auditing, customer
validation or commercial demand. The verifier templates passed a strong frozen
generic negative-control corpus, but every new domain still requires a
domain-correct independent observation binding and representative frozen cases.
The current compiler also requires a narrow non-enumerable `evidenceId` adapter
when supplying strict trusted-evidence descriptors; CF-006 preserved the strict
contract rather than weakening it, but the descriptor representation should be
cleaned up in a later additive compiler revision.
