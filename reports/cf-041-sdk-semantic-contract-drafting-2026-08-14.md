# CF-041 — SDK semantic-contract drafting workflow

Date: 2026-08-14
State: deterministic customer-local drafting workflow complete; no usability, human-time, arbitrary-SDK or activation claim

## Purpose

CF-036 identifies exact SDK methods but stops with nine unresolved semantic classes. CF-037 can compile those semantics, but only after they have been explicitly confirmed. CF-041 joins the two with a durable drafting workflow: it extracts only source-grounded facts, shows the exact unanswered decisions in dependency order, records reviewed answers with provenance, and produces a CF-037-compatible contract only after all nine classes have been explicitly resolved.

It does not select defaults for consequential semantics.

## Inputs and integrity boundary

`src/product/customer-local-sdk-semantic-drafting.ts` accepts:

- an integrity-valid CF-036 work pack;
- its exact integrity-valid reviewed CF HTTP declarations;
- a reviewed bounded workflow/outcome and its input inventory;
- stable provider/session identities and source digests.

The workflow rejects stale work-pack digests, declaration mutation, different provider identity, blocked declarations, source/credential-shaped injection, ambiguous input fields and mismatched CF-036/CF declaration identities.

## Facts extracted automatically

For each of four reviewed SDK roles, the workflow extracts and provenance-labels:

- exact module/class/method/overload and method digest;
- parameter names, types, required flags and source pointers;
- authentication alias candidates;
- response and error shapes;
- pagination candidate;
- retry and idempotency candidates;
- reviewed source kind, pointer and SDK source digest.

It also extracts the reviewed CF action declaration, observer declaration and outcome rules, plus the workflow’s reviewed inputs and desired outcome. These remain `extracted-source-fact`, never confirmation of the provider-specific semantic mapping.

The two fresh fictional work packs each produced 27 extracted facts.

## Dependency-ordered questions

Nine plain-English questions cover the nine CF-036 blocker classes:

1. parameter mappings;
2. credential aliases and exact scopes;
3. stable identity and collision handling;
4. idempotency and conflicting-reuse identity;
5. retry and lost-response reconciliation;
6. observer independence;
7. success, duplicate, collateral and freshness proof;
8. complete pagination;
9. timeout, rate, attempt and error policy.

Only parameter mapping and credentials/scopes are initially answerable. Later questions unlock when their semantic dependencies have been explicitly answered. The longest dependency chain has depth five. This prevents an answer-order shortcut from creating a superficially complete contract.

Every answer records:

- explicit-confirmation status;
- source pointer and one of the exact known source digests;
- reviewer alias and review timestamp;
- integrity digest;
- the structured value used in the partial contract.

Dry-run projects the next snapshot without changing SQLite. Exact answer replay is idempotent. A different answer for an already answered question fails closed. Durable restart reloads the exact snapshot and event history.

## No-default policy

CF-041 deliberately does not choose or infer:

- business parameter meaning or conversion;
- stable identity;
- idempotency/conflict keys;
- credential aliases as approved credentials;
- authority or scopes;
- retry/reconciliation policy;
- observer independence;
- outcome, duplicate, collateral or freshness predicates;
- pagination completeness;
- timeout, rate, attempt or error policy.

SDK and prior CF declarations are shown only as source hints. The initial partial contract contains identities, reviewed method bindings, source digests and no authority/activation effect; all nine semantic sections remain absent until answered.

## Validation controls

Structured answer validation rejects:

- missing or duplicate required parameter coverage;
- parameter sources that are not reviewed workflow inputs;
- wildcard/admin/all scope widening;
- shared action/observer aliases or scopes;
- unstable identity sources;
- collision behavior other than reject-conflict;
- blind retry or missing reconcile-before-retry;
- incomplete reconciliation classifications;
- fake/shared observer source or missing independence assertions;
- low-information outcome proof;
- missing exactly-one, collateral or freshness rules;
- pagination omission or partial role coverage;
- unbounded timeout/rate/attempt policy;
- missing terminal-error classification;
- stale/unknown answer provenance;
- prompt/source injection;
- stale/cross-provider work packs and declarations;
- dependency-order bypass.

## Joined exercise

Two fresh fictional CF-036 work packs were used:

- `orion`: map/direct provider shape;
- `lyra`: callback/queued provider shape.

For each:

- 27 facts were extracted;
- 9 questions and 9 intervention points were produced;
- 9 explicit decisions were supplied in the fictional fixture;
- blockers decreased from 9 to 0;
- one config object and zero executable code lines were generated;
- manual executable code created by CF-041 was zero;
- a dry-run final review did not mutate durable state;
- an explicit final review produced a complete CF-037 contract;
- CF-037 compiled it and the fictional action/independent-observer route passed;
- CF-035 built and signed the release containing the semantic JSON;
- CF-034 loaded it, detected restart staleness and required a fresh load/conformance path.

These are deterministic fictional development worlds, not fresh-human, customer or production evidence.

## CLI

`pnpm sdk:semantic:draft` exposes customer-local:

- `start`;
- `status`;
- `answer`;
- `review`;
- `events`.

Its default projection shows questions, blockers, metrics and evidence boundaries but excludes detailed artifacts. `--include-artifacts` is explicitly required inside the trusted customer-local environment. CLI output never marks execution or activation authority.

## Verification

- Repository-wide TypeScript typecheck: passed.
- Joined CF-029/030/034/035/036/037/041 and onboarding target: 11 files, 83 tests, 0 failures.
- `git diff --check`: passed.
- Model calls, network, package installation, containers, customer data and customer credentials: none.

## Strongest accurate claim

Capability Factory can now turn an integrity-valid reviewed SDK work pack and bounded workflow into a durable, provenance-labelled partial semantic-contract draft with nine dependency-ordered questions; only an explicit complete review can produce the CF-037 contract that enters separate compilation, conformance, qualification and acceptance gates.

This does not prove that a normal engineer can complete the review quickly, that unfamiliar real SDKs need no custom runtime implementation, or that the resulting provider adapter is production/customer ready.
