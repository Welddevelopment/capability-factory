# CF-027 — Evidence-grounded clean-package authoring and diagnostic checkpoint

Date: 2026-08-14

Evidence class: deterministic local development evidence
Spend/network/container use: none

## Result

Capability Factory now has a durable, authenticated authoring workflow above CF-018 OpenAPI normalization and CF-026 clean-package preview/import. It accepts explicitly approved local OpenAPI material plus an exact server, action, observer, ordinary blocked workflow, observable outcome and credential aliases only. It extracts bounded machine-readable facts, labels their provenance, asks plain-English questions for every remaining consequential fact, and stops on unsupported shapes.

A completed authoring session creates a versioned clean-package draft. It does not execute an action, bind credential values, grant authority, prove acceptance or activate a capability. Only a complete explicitly confirmed draft may be handed to CF-026, which then performs its own separate 21-decision preview and exact import confirmation.

## Product behavior

### Input boundary

The v1 authoring input includes:

- tenant, authoring-session, package-session and adapter identities;
- one explicitly approved local OpenAPI 3.x document and its local reference;
- approving alias and timestamp;
- one exact advertised HTTPS server;
- one selected action operation and one distinct observer operation;
- separately scoped action and observation credential aliases, never values;
- one customer-confirmed ordinary blocked workflow and externally observable outcome.

Prompt-like source text is inert. OpenAPI summaries, descriptions and extensions cannot answer authority questions or promote themselves into trusted facts.

### Fact states and provenance

Every authoring fact uses the established states:

- `observed`;
- `extracted`;
- `inferred-proposal`;
- `customer-confirmed`;
- `independently-verified`;
- `unknown`.

Each fact also carries source class, source pointer and content digest. Explicit answers are separately bound to answering alias and timestamp. The workflow never silently promotes an extracted or proposed fact into customer-confirmed authority.

### Supported deterministic extraction

For the current compact constrained-HTTP package shape, trusted code verifies or extracts:

- approved source kind and exact source-document digest;
- selected advertised server;
- exact POST action operation, path and documented action credential alias;
- exact distinct GET observer operation, path, documented query candidates and separate credential alias;
- exactly three required primitive JSON body fields and types;
- machine-readable `items`, `server_time` and `collateral_clean` observation candidates.

The last three are only candidates until explicitly confirmed as the correct business evidence.

### Explicit authoring questions

Each supported fixture produced 32 bounded confirmation questions. They cover:

- separate action and observer driver/source identities;
- stable and conflict identifiers plus a different frozen conflict value;
- exact observer query and stable-input mapping;
- explicit independent-observation confirmation;
- result, freshness, duplicate and collateral rules;
- reconcile-before-retry, no blind retry and maximum attempts;
- exact write policy, quantity/rate bounds, forbidden-action and approver policy;
- final consequential review;
- all three workflow input values and all three identity-only request mappings.

The authoring layer does not default these facts merely because CF-026 currently supports one conservative shape. Unsupported answers stop the draft and name the engineering gap.

### Durability and revision behavior

The customer-local SQLite workflow stores exact source input, answer set and integrity-bound snapshot for every session. Answer submissions require expected revision and snapshot digest.

- partial answers create a new revision while leaving the draft unavailable;
- stale answer submissions fail closed;
- a reused submission ID with different content or a different session fails closed;
- exact replay returns the integrity-bound result of the original submission even after later revisions;
- previously confirmed facts cannot be silently changed;
- session identity cannot be rebound to changed source material, workflow or package identity;
- restart returns the exact current revision and package draft;
- tenant checks occur on every authenticated sidecar route.

### Authenticated sidecar routes

- `POST /v1/onboarding/authoring/sessions` — create or exactly replay one durable diagnostic session.
- `GET /v1/onboarding/authoring/sessions/:sessionId` — read the tenant-bound integrity-checked revision.
- `POST /v1/onboarding/authoring/sessions/:sessionId/answers` — submit explicit answers against an exact revision.
- `GET /v1/onboarding/authoring/sessions/:sessionId/package` — expose only a complete confirmed draft and point to the separate CF-026 preview/import calls.

Every authoring and handoff response reports `executionAuthorityEffect: none` and `activationEffect: none`.

## Fixture results

| Fixture | Extracted/observed/verified facts | Authoring questions | Explicit decisions | Unresolved blockers | Package-specific executable code | Authoring intervention points | CF-026 decisions | CF-026 result |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Helios Lens Service | 5 | 32 | 32 | 0 | 0 | 2 | 21 | compiled acceptance-only |
| Northstar Sample Vault | 5 | 32 | 32 | 0 | 0 | 2 | 21 | compiled acceptance-only |

The two intervention points are: supply/select the approved source and workflow input; then explicitly answer the generated decision set. This was a deterministic fixture runner, not a fresh-human usability study.

The deliberately unsupported Ambiguous Queue stopped before questions or a package draft. Exact blockers included:

- action and observer use different collection paths;
- the write has four required fields rather than the compact v1 three-field shape;
- observer result does not expose a matching `items` collection;
- observer has no stable query binding;
- observer has no trusted freshness signal;
- observer has no collateral-state signal.

## Adversarial coverage

Tests attacked:

- prompt-like OpenAPI descriptions that demand authority or skipped verification;
- authority-like vendor extensions;
- credential-shaped source material;
- same operation for action and observation;
- shared action/observer credential alias;
- confirmed reuse of the same runtime driver for action and observation;
- unsupported answer values;
- conflicting answers to a previously confirmed fact;
- stale answer submissions;
- exact replay after later revisions;
- reused submission identity across sessions;
- source/session rebinding;
- cross-tenant sidecar start;
- incomplete-draft handoff;
- restart and integrity-bound export.

All fail closed without producing an executable/activated capability.

## Verification

- Repo-wide strict TypeScript typecheck: passed.
- Focused CF-027 suite: 4/4 tests passed.
- Joined CF-018/CF-026/onboarding/binding regression suite: 35/35 tests passed across nine files.
- No paid model calls, external requests, containers, customer data, deployment or external actions.

## Files

- `src/product/onboarding-clean-package-authoring.ts`
- `src/product/onboarding-clean-package.ts`
- `src/product/onboarding-productization-sidecar.ts`
- `src/product/index.ts`
- `test/fixtures/onboarding-clean-package-authoring/helios-lens-openapi.json`
- `test/fixtures/onboarding-clean-package-authoring/northstar-vault-openapi.json`
- `test/fixtures/onboarding-clean-package-authoring/ambiguous-unsupported-openapi.json`
- `test/product-onboarding-clean-package-authoring.test.ts`
- CF-026 fixtures/tests updated only for the additive source-document provenance field.

## Strongest accurate claim

> In deterministic local development, Capability Factory converted two unfamiliar approved OpenAPI fixtures into provenance-labelled authoring diagnostics, required 32 explicit decisions per system, produced complete zero-code clean-package drafts, and passed those drafts through the existing separate CF-026 21-decision preview and acceptance-only import. A deliberately ambiguous API stopped with exact engineering blockers instead of producing a package.

## Evidence boundary

This is deterministic drafting evidence. It does not establish that the questions are understandable or fast for an unfamiliar platform engineer, that arbitrary OpenAPI systems fit compact v1, that real credentials or transports work, that customer authority is valid, that independent observations are semantically correct, that acceptance passed, that any capability is activated, or that onboarding takes less than one day.

The next meaningful validation is a fresh engineer using the frozen authoring package without implementation-author help, followed only then by a real controlled customer workflow. Product work should not relabel this fixture result as human usability or customer evidence.
