# Local transfer sandbox

## Outcome

This module is the Phase B development substrate for testing whether the same
acquisition core can be connected to a replaceable customer system. It is deliberately
separate from the preserved historical evaluation and does not change any historical
freeze, verdict, run, or claim.

The commercial segment is not locked. The best current founder-conversation hypothesis
is early-stage B2B action-agent companies whose current customer deployment is delayed
by an unsupported or customer-specific authenticated HTTP API. Its stricter corrected
public score is 83.9/100, below the 85-point lock threshold, and its 12 publicly supported
high-priority companies remain below the 15-company threshold. Only founder-conversation
evidence about recurrence, overhead, mechanism, buyer, and buy versus build can move that
hypothesis forward. The fixture therefore must not be described as market evidence
or allowed to determine the final held-out customer system.

There are now two local development worlds behind the same boundary. The fast world is a
self-contained ERPNext-compatible fixture using REST resource shapes and DocType-like
tables. The transfer world is a genuine disposable local installation of Frappe 16.28.0,
ERPNext 16.29.0, MariaDB, and Redis inside a Colima virtual machine. The real-system world
exists to expose application behavior the compatible fixture may miss; it is still local
development infrastructure, not a customer system or held-out commercial evaluation.

## Run it

The repository requires Node.js 24 or newer and the existing project dependencies.

```sh
pnpm sandbox:test
pnpm sandbox:proof
pnpm sandbox:real:test
pnpm product:test
```

The proof command starts a localhost-only service on an ephemeral port, creates a local
SQLite fixture, resets and runs the deterministic case matrix, verifies state directly,
and writes a local-only report to:

`artifacts/customer-world-transfer/latest/proof.json`

The `artifacts/` directory is ignored by Git. The report contains secret aliases, never
credential values.

## Replaceable module boundary

`src/customer-world/contract.ts` defines the domain-independent boundary. A world must
supply:

- deterministic seed and complete reset;
- an ordinary goal rather than an API-building instruction;
- starting abilities;
- neutral documentation and its SHA-256 hash;
- per-case credential profiles;
- exact expected state plus forbidden, duplicate, and collateral rules;
- direct privileged verification; and
- already-satisfied, build, reuse, denial, invalid-target, and retry cases.

All dispatch, delivery, warehouse, sales-order, carrier, and tracking language is inside
the ERPNext development module. The generic contract and runtime policy contain no
market-specific routes or fields.

## Fixture schema and generated-data rules

The fixture uses synthetic records only. Its business tables mirror the DocType names
needed for the workflow:

- Customer and shipping Address;
- Item, Warehouse, and Bin stock;
- Sales Order and Sales Order Item;
- Delivery Note and Delivery Note Item; and
- a separate local write-audit table used only by the harness.

Identifiers are deterministic (`SO-DEV-0001` through `SO-DEV-0006`). Names, addresses,
items, carriers, tracking values, labels, dates, quantities, and stock are fictional.
There is no personal, customer, or production data. Reset deletes every fixture and audit
row, reseeds a single case, and produces a canonical SHA-256 state hash.

## Credentials and permissions

The runtime receives only a named secret alias. The value is injected by trusted runtime
configuration and is absent from documentation and manifests.

- `full`: read Sales Orders and Delivery Notes, create Delivery Notes, update Sales Orders.
- `read-only`: read only.
- `incomplete`: read and update, but cannot create the required Delivery Note. Because the
  create step is required first, it fails before any business state changes.
- `verifier`: reserved read-only API profile; outcome verification itself reads SQLite
  directly and does not trust the API response or worker report.

The runtime allowlist binds both HTTP method and exact route. It also restricts the host
to localhost, requires idempotency on writes, rejects literal credentials, blocks redirects,
and caps time and response size.

## Case matrix

1. `already-satisfied`: direct verification confirms the goal is already complete and no
   new action is required.
2. `first-build`: the deterministic reference manifest reads the target, creates exactly
   one Delivery Note, updates the exact Sales Order, and passes direct verification.
3. `fresh-session-reuse`: a manifest registered on disk is loaded by a new registry
   object and used on a different seeded order.
4. `permission-denial`: the read-only credential can inspect the order but the write is
   denied with no business-state change.
5. `incomplete-permission`: a deliberately incomplete role is denied at the required
   create step with no partial write.
6. `invalid-target`: a missing synthetic shipping address produces a structured failure
   and no business-state change.
7. `lost-response-retry`: the fixture commits the first create and returns a simulated
   lost-response error; the identical retry returns the original record and never creates
   a duplicate.

## Independent verifier checks

The verifier reads the database directly. It checks:

- the exact target Sales Order exists;
- the exact number of Delivery Notes;
- carrier, service, tracking, label, status, document status, customer, item, quantity,
  and warehouse fields;
- the exact Sales Order custom fields;
- no non-target Sales Order or Delivery Note changed;
- protected customer, address, item, warehouse, bin, and source-item tables did not change;
- no missing, duplicate, wrong-field, forbidden, or collateral write occurred.

Negative-control tests intentionally create a wrong state, change an expected field,
insert a duplicate, and mutate a protected table. The verifier must reject each one.

## Evidence boundary

The compatible fixture proves deterministic local plumbing: reset, permissions,
method-and-route policy, secret indirection, REST-style CRUD, persistence, direct
verification, and safe retry behavior. The genuine ERPNext adapter additionally passed a
six-case deterministic local integration suite covering stable reset, real resource API
reads/writes, fresh-process reuse, two restricted credential profiles, safe no-action, and
lost-response reconciliation without a duplicate. The product reference layer also runs
the same core in process, behind a customer-hosted HTTP sidecar, and through a split
control-plane/data-plane boundary.

The deterministic suites above are private, model-free development checks. A separate
product-specific model-backed development run later passed build and fresh-process reuse
against the genuine local world after independent probing and reset; its full chronology
and USD 1.6746925 cumulative development cost are recorded in
`PRODUCT_MODEL_TRANSFER_REPORT.md`. Neither workstream uses an external account, customer
system, or production credential. They do not prove autonomous diagnosis, customer
demand, pilot readiness, production reliability, cross-customer generality, or a market
choice. The final held-out system remains a future gate and must come from a real recent
blocked workflow plus permission to reproduce it safely.
