# CF-026 — Clean-package import contract v1 checkpoint

Date: 2026-08-14

Evidence class: deterministic local development evidence
Spend/network/container use: none

## Objective

Replace the clean-package teardown test's private renderer with a real, versioned, authenticated customer-local sidecar contract. A compact package must be inspectable before persistence, must require explicit confirmation of every consequential decision before review/compilation, and must never grant execution or activation authority.

## Implemented contract

`OnboardingCleanPackage` v1 is a strict bounded JSON contract for the currently supported compact constrained-HTTP shape. It contains tenant/session/adapter identity, one approved HTTPS system, one exact write, one separately authenticated read-side observer, three bounded workflow inputs, stable and conflict keys, and approved-document provenance.

The customer-local sidecar now exposes:

- `POST /v1/onboarding/packages/preview`: authenticated, non-persistent, non-authorizing deterministic derivation.
- `POST /v1/onboarding/packages/import`: authenticated exact-confirmation gate followed by normal durable preparation, review and acceptance-only binding compilation.
- `GET /v1/onboarding/packages/:sessionId`: authenticated restart-safe export of the exact compact package, preview, import state and persisted artifact digests.

Preview derives the same product artifacts used by normal onboarding:

- approved local OpenAPI material with a pinned derived-content digest;
- reviewed OpenAPI normalization;
- adapter/verifier/authority preparation intake;
- HTTP action and independent-observer binding facts;
- proposal-only binding declarations;
- exact blockers and remaining engineering work.

The preview contains 21 indexed confirmation decisions: 15 system, outcome, operation, credential, authority, retry, freshness, duplicate and collateral decisions; three request mappings; and three independent post-action field checks. It reports `executionAuthorityEffect: none` and `activationEffect: none`.

Import requires the literal confirmation `CONFIRM ALL 21 CONSEQUENTIAL DECISIONS`, plus the current package digest, current decision digest, reviewer alias, confirmation time and bounded qualification interval. A successful import reaches only `confirmed-compiled-acceptance-only`. It does not execute an action, fabricate acceptance evidence, mint runtime authority, or activate a capability.

## Durability and conflict behavior

The artifact store now retains separate integrity-bound envelopes for the package, package confirmation, intake, review, binding request and later acceptance link. Every envelope is tenant/session/stage bound and content digested.

- Replaying the exact package and exact confirmation is idempotent and returns the same compiled pair digest.
- Reusing the session with a changed package, changed confirmation, changed binding inputs or changed runtime-review binding fails closed.
- A package cannot attach itself to a pre-existing session created outside the clean-package contract.
- Review recovery is bound to the original durable proposal event and the exact generated acceptance derivation receipt, so restart or a write interruption cannot silently review a later snapshot.
- Export after sidecar restart returns the exact original package and all five persisted pre-acceptance artifact digests.

## Schema, resource, provenance and secret controls

The v1 package is strict: unknown properties and unsupported versions are rejected. It permits exactly three scalar workflow inputs and bounded identifiers, strings, paths and timestamps. The authenticated sidecar also retains the existing 10 MB body limit, structural node/depth/collection bounds, prototype-control-key rejection and secret-shaped-value scan.

Action and observation must use different drivers, sources and customer-local credential aliases. The current compact v1 shape requires one reviewed collection path. Stable/conflict keys must exist and differ. Server URLs must use HTTPS and cannot contain user info, query parameters or fragments.

Approved-document provenance is explicit: local reference, approving alias, approval timestamp and SHA-256 digest of the deterministic OpenAPI material. Any digest drift fails before proposal generation.

Adversarial tests covered:

- four-field ambiguity against the fixed 21-decision contract;
- shared action/observer credentials;
- missing stable identifier;
- embedded URL credentials and query widening;
- approved-document digest drift;
- unsupported capability mode and schema version;
- oversized bounded fields;
- secret-shaped values without reflected secret leakage;
- absent/wrong exact confirmation with no session persistence;
- cross-tenant use;
- changed-package conflict after an accepted import;
- exact replay and restart-safe export.

## Actual clean-package migration

Both previously frozen clean packages now use the real import API. The test no longer has private OpenAPI, authority, binding-fact or preparation renderers.

| Package | JSON lines | Review decisions | Confirmed facts | Action declaration fields | Observer declaration fields | Acceptance | Incorrect effects |
|---|---:|---:|---:|---:|---:|---:|---:|
| Aurora Calibration | 43 | 21 | 94 | 47 | 75 | 10/10 | 0 |
| Mistral Cold Storage | 43 | 21 | 94 | 47 | 75 | 10/10 | 0 |

Both packages used the same executable runtime implementation identity, produced different pair digests, required zero package-specific executable code, and preserved fresh-process readiness after sidecar restart. This is synthetic local evidence, not a fresh-human onboarding result or customer evidence.

## Verification

- TypeScript typecheck: passed.
- Focused clean-package suite: 6/6 tests passed.
- Joined onboarding/binding regression suite: 27/27 tests passed across seven files.
- Both imported acceptance campaigns: 10/10 mandatory cases passed; zero incorrect side effects survived.
- No paid model calls, external network requests, containers, customer data or deployment.

## Files changed

- `src/product/onboarding-clean-package.ts`
- `src/product/onboarding-productization-sidecar.ts`
- `src/product/index.ts`
- `test/fixtures/onboarding-clean-packages/aurora-calibration.json`
- `test/fixtures/onboarding-clean-packages/mistral-cold-storage.json`
- `test/product-onboarding-clean-package.test.ts`
- `test/product-clean-package-sidecar-teardown.test.ts`
- `reports/clean-package-import-contract-v1-checkpoint-2026-08-14.md`

## Evidence boundary and remaining work

The strongest supported statement is:

> In deterministic local development, two bounded constrained-HTTP systems were each expressed as a 43-line clean package, previewed through an authenticated non-authorizing API, explicitly confirmed across 21 decisions, compiled through the normal durable onboarding path, and passed the fixed ten-case acceptance campaign after restart using one shared runtime with zero surviving incorrect side effects.

This does not show that an unfamiliar customer engineer can prepare the package unassisted, that the schema covers arbitrary HTTP systems, or that a customer-local deployment is activated. Customer-local secret values, real transport and observer bindings, real reset/reconciliation behavior, real authority, fresh-engineer comparison, customer workflow evidence, production drift and operational reliability remain separate gates.
