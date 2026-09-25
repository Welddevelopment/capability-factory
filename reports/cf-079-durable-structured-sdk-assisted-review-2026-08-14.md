# CF-079 — Durable assisted review for structured SDK contracts

Date: 2026-08-14  
State: zero-spend deterministic assisted-review path complete; no fresh-human usability, arbitrary-SDK, execution or activation claim

## Purpose

CF-078 proved that a safely bounded nested SDK contract can be compiled and exercised, but its complete structured contract was still fixture-authored. That left the main onboarding objection untouched: a platform engineer could still be forced to write a large configuration object by hand.

CF-079 adds a durable question-and-review path for the structured portion of the contract. It preserves CF-041's already reviewed non-structural decisions and turns the CF-078 schema tree into exact dependency-ordered confirmations and mappings.

## Mechanism

`src/product/customer-local-sdk-structured-semantic-drafting.ts` starts only from:

- the exact CF-036 work pack;
- the exact approved CF-078 structured-schema index;
- an integrity-valid, unexpired CF-041-style base semantic contract;
- a digest-bound reviewed workflow-input inventory containing types and source pointers;
- customer-local session and tenant identity.

The base contract supplies the already reviewed role, credential alias/scope, stable identity, idempotency, reconciliation, observer, outcome, pagination and bounded runtime-policy decisions. Its old top-level parameter mappings are not silently treated as structured mappings. The new workflow produces every structured expression from separate reviewed answers.

For every pinned parameter tree it generates:

- an explicit fixed-object shape confirmation;
- one mapping question for each primitive leaf;
- one whole-source mapping question for each homogeneous array, retaining the exact pinned `maximumItems` and item schema;
- dependencies that prevent nested field mappings from advancing before their containing object shape is confirmed.

Shape confirmations must cite the exact schema-index digest. Data mappings must cite the exact reviewed workflow digest and source pointer. Authentication-shaped inventory keys, unknown sources, type-incompatible identity mapping, transform/destination mismatch, stale answers and dependency bypass fail closed.

## Durable state

The workflow stores the immutable input, current snapshot and an append-only previous-hash event chain in SQLite. Each answer uses an exact snapshot/revision compare-and-swap. Restart reloads and revalidates:

- the complete source digest;
- work-pack, schema-index and base-contract integrity;
- snapshot digest;
- final event head and every previous-event link;
- all current upstream expiry and source identities.

A final review may dry-run without mutation. The committed final review creates the complete CF-078 contract, compiles it through the real CF-078 compiler and remains acceptance-only/non-executable.

## Fresh fictional exercise

The same fictional supplier SDK used by CF-078 generated 12 decisions rather than a hand-authored structured object:

- 4 fixed-object shape confirmations;
- 5 scalar source mappings;
- 3 bounded-array mappings;
- 0 manually created final contract objects.

Four top-level questions were initially ready. Nested decisions unlocked only after their parent shape confirmations. All 12 answers were durably recorded, the process closed and reopened, and the exact snapshot survived restart. A dry-run review did not mutate the stored review-ready state. The committed review produced the exact CF-078 contract, including the nested supplier object, maximum-20 line list and separate maximum-8 observer field list. The compiled result remained non-executable and non-activating.

## Negative controls

The joined suite rejects or preserves as blocked:

- final review with unanswered decisions;
- a nested question answered before its dependencies;
- an answer against a stale snapshot/revision;
- authentication-shaped reviewed input inventory;
- persisted source/schema mutation after session creation;
- structured contract expiry beyond the base contract;
- any paginated base contract that would otherwise be silently narrowed;
- all inherited CF-078 recursive, unbounded, union, custom-transform, auth-shaped, source-substitution and authority-widening controls.

## Verification

- Joined CF-078/079 focused suite: 13/13 passed.
- Strict repository TypeScript: passed.
- `git diff --check`: passed at checkpoint.
- Model calls, network calls, package installs, containers, customer data, credential values and spend: none.

## Remaining gaps

- A human still must supply or approve the reviewed workflow input inventory and all consequential mappings. No fresh non-author human has measured clarity or time.
- The approved structured-schema index remains upstream trusted material. Automatic parsing of arbitrary raw provider SDK packages into that index is not established.
- CF-079 reuses a complete CF-041-style base contract. A single unified onboarding screen/CLI joining the base nine questions and the structured questions has not yet been implemented.
- Real provider serialization, transport qualification, customer credentials, authority attachment, customer-environment conformance, mandatory real acceptance, signed release and activation remain separate.
- No customer, demand, setup-time, arbitrary-SDK or production claim follows.

## Strongest accurate claim

Capability Factory can now turn an approved bounded structured SDK schema plus a reviewed workflow inventory into a durable, dependency-ordered assisted review and emit the exact nested CF-078 contract without hand-writing the final contract object. The output is provenance-bound and compiles, but remains non-executable until separate local binding and acceptance gates pass.
