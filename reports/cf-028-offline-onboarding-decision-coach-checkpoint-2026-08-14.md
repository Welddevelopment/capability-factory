# CF-028 — Offline onboarding simulator and decision-quality coach

Date: 2026-08-14

Evidence class: deterministic local development evidence
Spend/network/container use: none

## Result

Capability Factory now has a read-only decision coach around CF-027 authoring and CF-026 package preview/import. It explains every authoring question in plain English, states why the decision matters, provides answer-shape examples and unsafe counterexamples, shows provenance, enforces prerequisite ordering, and projects downstream effects without answering or mutating the authoring session.

The coach does not recommend authority, identifiers, freshness windows, retry rules, observation independence or proof definitions. Examples explicitly describe shape rather than a value to copy. Source-listed enum options are shown only as the reviewed bounds of the question.

## Dependency-aware rehearsal

The 32 CF-027 questions are grouped into:

- runtime separation;
- identity and mapping;
- independent proof;
- recovery;
- authority and limits.

Each question is `available`, `locked` or `answered`. Locked questions expose their exact prerequisites. The tested graph has maximum dependency depth five: for example final consequential review remains unavailable until action policy, bounds, approver policy, retry and attempt decisions have been explicitly resolved.

For every question the projection includes:

- concise explanation;
- consequence/why it matters;
- safe format-oriented example;
- unsafe counterexample;
- fact key and provenance references;
- exact next-revision effect;
- projected blocker count after an available answer.

## Decision-quality assessment

The assessment endpoint is zero-mutation. It reuses CF-027's strict per-question validator and adds cross-answer diagnostics for:

- stable and conflict identifiers being equal;
- action and observation driver/source conflation;
- claiming independence despite conflation;
- blind retry without explicit reconciliation;
- observer lookup or duplicate detection using a different key from the confirmed stable identifier;
- changed values for previously confirmed facts;
- answers outside approved OpenAPI/workflow options;
- low-information placeholders such as `TBD`, `test`, `any` or `unknown`;
- answers attempted before prerequisites;
- unknown questions.

The coach reports these problems but never submits corrected answers on the operator's behalf.

## Portable rehearsal sessions

Portable coach export contains only the redacted read-only projection. It excludes the OpenAPI document, credential aliases, package/workflow values and answer payloads. The bundle is HMAC-SHA256 bound to:

- tenant;
- authoring session;
- source-input digest;
- exact snapshot digest/revision;
- issuance time;
- maximum seven-day expiry.

Import requires the matching live session and customer-local access-token signing key. Forged payloads/signatures, future/not-yet-valid bundles, expiry, stale snapshot, changed source, cross-session and cross-tenant reuse fail closed. Import returns the projection only and does not restore or mutate product state. Exact import remains stable across sidecar restart.

## Dry-run projection

The coach exposes what exists now (explanation, dependency graph and diagnostic), what complete explicit answers would make eligible (CF-027 package draft and CF-026 preview), and what remains blocked afterward (CF-026 exact confirmation, binding qualification, acceptance execution, runtime authority and activation). Every projection states zero mutation, zero execution-authority effect and zero activation effect.

## Measurements

| Fixture | Questions | Dependency depth | Detected contradictions in clean rehearsal | Human decisions remaining | Package-specific executable code |
|---|---:|---:|---:|---:|---:|
| Helios Lens | 32 | 5 | 0 | 32 | 0 |
| Northstar Vault | 32 | 5 | 0 | 32 | 0 |

An adversarial answer set correctly detected identifier conflict, driver conflation, false independence, blind retry without reconciliation, placeholder input, invalid source option and locked prerequisite violations. These are deterministic fixture outcomes, not a measured improvement in human decision quality.

## Authenticated routes

- `GET /v1/onboarding/authoring/sessions/:sessionId/coach`
- `POST /v1/onboarding/authoring/sessions/:sessionId/coach/assess`
- `POST /v1/onboarding/authoring/sessions/:sessionId/coach/export`
- `POST /v1/onboarding/authoring/sessions/:sessionId/coach/import`

## Verification

- Repo-wide strict TypeScript typecheck passed.
- Focused coach tests: 4/4 passed.
- Joined CF-018/CF-026/CF-027/onboarding/binding regression suite: 39/39 tests passed across ten files.
- `git diff --check` passed.
- No model calls, network, containers, customer data, deployment or external action.

## Evidence boundary

This proves an offline deterministic explanation, dependency and diagnostic mechanism for the tested fixtures. It does not prove that unfamiliar operators understand the questions, make better decisions, finish faster, need less support or can onboard in under one day. It also does not prove arbitrary OpenAPI compatibility, real credential/transport operation, semantic observation independence, customer authority, acceptance, activation or production readiness.

The next evidence step remains a fresh engineer using the frozen workflow without implementation-author help.
