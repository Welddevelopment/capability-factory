# CF-017 — authenticated onboarding productization sidecar v1

Date: 2026-08-14

Evidence class: deterministic customer-local synthetic development evidence
Spend / network / containers: none

## Result

Implemented one authenticated customer-local API that exposes the current onboarding journey without creating an activation route:

1. start or resume an exact durable onboarding preparation session;
2. inspect redacted status and generated review-artifact digests;
3. confirm the exact preparation revision and reviewed contract digests;
4. record reviewed HTTP binding inputs and compile the separate action/observer pair through customer-local configured runtime bindings;
5. link only an already-executed generic acceptance campaign from the existing acceptance store;
6. inspect the integrity-bound readiness receipt.

The API returns only documented identities, digests, blockers, maturity states, evidence heads and claim boundaries. It does not return credential values, customer-local transport functions, raw runtime handles or repository object identifiers.

## Durable state and restart behavior

- The existing `DurableOnboardingPreparationWorkflow` remains authoritative for preparation and review state.
- The existing `GenericAcceptanceCampaignStore` remains authoritative for acceptance execution and evidence.
- A small SQLite artifact table stores only exact documented intake, review, binding and acceptance-link envelopes needed to reconstruct the same compiled pair after restart.
- Every envelope binds tenant, session, stage, payload digest, recorded time and envelope digest.
- Compiled runtime functions are not serialized. They are deterministically reconstructed from the exact recorded declarations and customer-local runtime resolver; changed implementation digests produce a different pair and fail against the linked campaign.

## Security and truth boundaries

- Constant-time shared-token authentication protects every onboarding route except health.
- A configured tenant boundary is checked on intake and every session read.
- Exact retries are idempotent; different intake, review, binding or campaign-link content for the same session/stage is rejected as a conflict.
- Acceptance binding identity includes tenant, session and compiled-pair digest, preventing a valid campaign from one session being attached to another.
- Secret-shaped artifacts are rejected; documented credential aliases remain allowed.
- Linking acceptance evidence cannot execute a case, alter a result or grant activation.
- The readiness endpoint retains the CF-012 boundary: synthetic acceptance complete, activation blocked, customer evidence false, human-independent onboarding unproved and production readiness false.
- There is deliberately no activation endpoint.

## API routes

- `POST /v1/onboarding/sessions`
- `GET /v1/onboarding/sessions/:sessionId`
- `GET /v1/onboarding/sessions/:sessionId/events`
- `POST /v1/onboarding/sessions/:sessionId/review`
- `POST /v1/onboarding/sessions/:sessionId/bindings`
- `POST /v1/onboarding/sessions/:sessionId/acceptance-link`
- `GET /v1/onboarding/sessions/:sessionId/readiness`

The review response exposes the exact generated adapter, verifier and authority compilation digests needed for consequential review. Binding input is a documented approved normalization artifact, confirmed binding-facts artifact and bounded qualification lifetime; no source-tree symbol or fixture name is required by the API contract.

## Validation

The targeted journey/security suite passed. It covered:

- unauthorized access;
- cross-tenant intake rejection;
- complete preparation → review → compile → qualification → acceptance link → readiness flow;
- exact request replay/idempotency and semantic conflict rejection;
- cross-session acceptance-evidence rejection;
- process close/reopen with the same durable state;
- persisted-envelope mutation detection after restart;
- non-activation and non-customer-evidence truth fields.

The focused run passed 5/5 tests (the sidecar scenario plus the imported CF-012 integrity tests). Repository-wide strict TypeScript validation then passed after concurrent unrelated edits settled. Diff whitespace validation is clean for the CF-017 files.

## Claim boundary

This supports: “A platform engineer can drive and resume the exact constrained-HTTP onboarding artifact chain through one authenticated customer-local API, with durable tenant/session identity, conflict rejection, verifier qualification, acceptance evidence linking and a non-activating readiness receipt.”

It does not support customer self-service, fresh-human usability, production deployment, customer validation, activation authority, arbitrary API compatibility or non-HTTP capability modes.
