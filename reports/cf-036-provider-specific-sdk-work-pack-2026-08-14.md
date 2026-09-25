# CF-036 — Provider-specific SDK implementation work pack

Date: 2026-08-14
State: deterministic zero-spend SDK metadata scaffolding complete; no arbitrary-SDK or human-time claim

## Purpose

CF-035 can create and release a customer-local plugin project, but it deliberately does not help an engineer map one provider SDK into the action, probe, reconciliation and observer boundaries. CF-036 adds a metadata-only compiler for that implementation work. It never imports or executes the provider package.

## Approved input boundary

`src/product/customer-local-sdk-work-pack.ts` accepts:

- an exact reviewed CF HTTP declaration result;
- a CF-035 scaffold metadata object;
- one pinned approved local SDK index;
- exactly four one-to-one method reviews.

The local SDK index supports normalized facts from TypeScript declarations, reference JSON, MCP descriptors or an explicit minimal machine-readable index. It records:

- module, class, method and overload identity;
- parameters and return/error shapes;
- authentication alias requirements;
- pagination classification;
- retry and idempotency candidates;
- source pointer, local reference and source digest;
- a static import allowlist.

It contains metadata only. CF-036 never imports arbitrary package code, invokes an SDK, runs package scripts, installs dependencies or accesses a network.

## Exact review gates

One explicit review is mandatory for each role:

1. action;
2. no-write probe;
3. reconciliation/readback;
4. independent observer.

Each review binds the exact module, optional class, method, overload and source pointer. Missing, duplicate or source-mismatched selections fail closed. The compiler rejects:

- action/observer method or implementation conflation;
- shared authentication aliases;
- non-read-only probe/reconciliation/observer candidates;
- internally unsafe retry/idempotency metadata;
- overload ambiguity;
- invalid names or unsupported types;
- unallowlisted imports;
- source/reference injection.

These checks do not prove the metadata is semantically correct. They prevent the skeleton from quietly choosing among ambiguous or conflicting options.

## Generated work pack

The work pack is provenance-bound to the SDK source digest and reviewed CF declaration digest. It includes:

- four exact reviewed method records and method digests;
- source kind/reference/pointer provenance per role;
- normalized module, class, method, parameter, return, error, auth, pagination, retry and idempotency inventories;
- generated `src/sdk-adapter-skeleton.ts`;
- generated `sdk-provenance.json`;
- generated `test/sdk-role-controls.json`;
- 21 CF-030 controls explicitly marked `not-run`;
- nine engineer-owned blockers.

The adapter skeleton uses type-only static imports and compiles, but every function throws an engineer-required error. It does not implement:

- parameter mapping;
- credential values or new scopes;
- authority;
- stable identifiers;
- idempotency guarantees;
- reconciliation behavior;
- observer independence;
- outcome predicates;
- pagination completeness;
- error/rate policy.

No control is marked passed.

## Two fresh fictional SDK shapes

The deterministic exercise used:

- `aurora-sdk`: a TypeScript-declaration-shaped, map/direct provider surface;
- `mistral-sdk`: an MCP-descriptor-shaped, callback/queued provider surface.

Each contained four reviewed methods across separate write and read modules/classes. Both work packs:

- mapped 4 methods;
- required 4 explicit role reviews;
- normalized 7 parameters, 1 return shape and 1 error shape;
- generated 3 provider-specific work-pack files;
- preserved 9 blocked engineer decisions;
- preserved all 21 conformance controls as not run.

For the integration exercise, fictional declaration shims and an engineer-owned semantic-completion record were written outside the generator. The generated failing skeleton remained unchanged. The expanded project then:

1. passed the existing CF-035 deterministic build;
2. produced a CF-035 release manifest containing the skeleton, completion layer and provenance;
3. passed CF-030 using the separate explicit local provider fixture;
4. loaded into CF-034 and passed its doctor;
5. restarted into `reload-required`;
6. regained host use only after fresh conformance.

The completion record is not executable proof that arbitrary SDK semantics were solved; the CF-030 fixture remains the explicit tested runtime implementation.

## Adversarial controls

Tests rejected:

- local-reference path traversal;
- docs/source injection;
- dependency/script-shaped imports;
- duplicate overload identity;
- unsupported/name-type mismatch;
- action/observer conflation;
- shared action credential on observer;
- unsafe action retry classification;
- stale/wrong source pointer;
- cross-provider source substitution;
- fake proof through generated control status;
- unexpected project files outside the expanded CF-035 static allowlist.

## Evidence and limits

Final verification:

- repository-wide TypeScript typecheck passed;
- joined CF-029/030/034/035/036 and onboarding target passed 12 files and 76 tests with 0 failures;
- `git diff --check` passed;
- no model, network, package installation, container, customer credential or customer data was used.

Remaining environment-specific work:

- confirm actual provider declarations against its installed package version;
- implement real parameter and return conversions;
- implement provider authentication through CF-030 leases;
- prove stable identifier behavior;
- establish idempotency and reconciliation semantics;
- prove observer separation and external-outcome rules;
- handle pagination, errors, timeouts and rate limits;
- run all CF-030 controls against the actual local implementation;
- complete security, authority and activation review.

## Strongest accurate claim

Capability Factory now has deterministic local machinery that converts pinned, reviewed SDK metadata into a provenance-bound provider implementation work pack and compiling fail-closed adapter skeleton, while preserving every consequential runtime semantic as an explicit engineer-owned blocker.

This is not arbitrary SDK support, executable adapter generation, fresh-human usability evidence or measured human time savings.
