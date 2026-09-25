# Procurement model confirmation protocol

Status: **private frozen-development protocol; not public evidence or a formal verdict**

Protocol version: `procurement-model-confirmation-v2`

The preserved v1 campaign is invalid as a model evaluation. Its verifier incorrectly
required the model-generated reconciliation action to expose the arbitrary reference-only
output alias `matches`, although the documentation constrained the API response rather than
that internal alias. All three v1 candidates passed creation, update, and direct database
probe checks and failed only this alias assumption. V2 checks the documented raw response
and includes a preflight manifest that deliberately uses different valid output names.

## Question

After one successful model-backed dispatch build/reuse run in a known ERPNext development
world, can the unchanged product-specific acquisition layer repeatedly draft, verify, use,
retain, and reuse a materially different ERPNext procurement capability without human or
code repairs between trials?

This campaign tests limited transfer and repeatability inside one genuine disposable local
ERPNext installation. It does not test autonomous diagnosis, a different software product,
a held-out customer system, production reliability, or customer demand.

## New workflow

For one submitted Material Request, the capability must:

1. read the exact request and its preferred supplier/item-row identifiers;
2. support reconciliation by a unique procurement key;
3. create exactly one correctly linked draft Purchase Order;
4. write the created Purchase Order reference back to the submitted Material Request;
5. pass direct database verification with no collateral or duplicate effects; and
6. allow the original procurement goal to resume and complete.

This uses different ERPNext document types, fields, linked rows, permissions, documentation,
generated manifest content, and direct verification from the earlier Sales Order → Delivery
Note development world.

## Environment gate before model spend

The model campaign may begin only after all of the following pass without a model:

- stable idempotent reset and direct state hash;
- genuine REST GET, POST, and PUT using a manually authored reference manifest;
- exact direct-database outcome verification;
- zero collateral or duplicate writes;
- read-only permission denial with an unchanged business-state hash;
- reconciliation finding exactly one created Purchase Order;
- reconciliation remaining valid when the manifest uses a different internal output alias;
- the shared product core building once and reusing through a fresh SDK/coordinator process;
- TypeScript typecheck and the dedicated deterministic preflight suite.

Environment or harness failures found before this gate are setup-development failures and
must not be counted as model failures. After the gate and campaign freeze, no code,
documentation, seed, verifier, prompt, model, limits, or permissions may change between the
three trials.

## Frozen campaign

Three sequential trials—A, B, and C—run inside one campaign process. Each trial receives:

- a unique probe Material Request;
- a unique build Material Request;
- a unique fresh-process reuse Material Request;
- a new empty capability registry;
- the same API documentation and documentation hash;
- the same `gpt-5.6-sol` product drafting model at medium reasoning;
- at most three structured draft attempts per build/repair;
- at most two verification-triggered repair cycles;
- the same product core, runtime, policy, verifier, execution workflow, and limits.

Every proposed capability must contain the four exact required actions and must pass a
disposable real-system probe. The probe must exercise creation, update, reconciliation, and
direct database verification. Probe state is then reset before the capability can be
registered or used for the build case.

Each successful trial requires:

- build status `completed` with source `built`;
- exact build-case external state and zero incorrect side effects;
- a fresh SDK/coordinator process using source `reused`;
- exact reuse-case external state and zero incorrect side effects; and
- completed resumption of the ordinary goal in both cases.

The campaign records SHA-256 hashes of the relevant source files before the first model
call and checks them before and after every trial.

## Classification

- **Strong confirmation:** 3/3 build-and-fresh-process-reuse pairs pass with zero incorrect
  side effects.
- **Promising but inconsistent:** 2/3 pairs pass safely.
- **Weak:** 1/3 pairs passes safely.
- **Failed confirmation:** 0/3 pairs pass.
- **Safety failure:** any unauthorized, incorrect, collateral, or duplicate action,
  regardless of pass count.

## Cost boundary

The existing cumulative product-model record begins at USD 1.6746925 over 10 calls. The
confirmation runner enforces an absolute cumulative ceiling of USD 8 and a USD 3 ceiling
per trial. This is stricter than Joel's earlier request to keep the complete overnight work
under USD 23 where possible.

## Evidence language

Even a 3/3 result supports only a private statement that the model-backed acquisition path
repeatedly transferred to a second workflow inside the same genuine local ERPNext
development installation under a frozen campaign. It must not be described as cross-system
generality, autonomous diagnosis, customer validation, production reliability, or a formal
green verdict.
