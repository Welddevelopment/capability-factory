# Durable onboarding preparation checkpoint

Date: **2026-08-14**

Status: **local deterministic productization checkpoint; no customer, model, or production evidence**

## Investor objection attacked

> “The onboarding factories are useful internal libraries, but a customer still
> needs the repository author to remember their order, preserve their artifacts,
> and decide whether the result is actually ready.”

## What changed

`DurableOnboardingPreparationWorkflow` now joins the existing adapter,
verifier, authority, and acceptance factories behind one customer-local,
restart-safe workflow.

From one exact intake it:

1. records the bounded workflow, approved system material, verifier inputs,
   ordinary-language authority answers, and customer-local runtime assumptions;
2. generates a provenance-bound non-executable adapter proposal;
3. generates an integrity-bound provisional verifier contract;
4. compiles an integrity-bound non-activated authority contract;
5. returns either exact blockers or one review-required snapshot;
6. rejects changed input under the same session identity;
7. requires review of the exact input and snapshot digests;
8. rejects stale concurrent review;
9. derives the fixed ten-case acceptance scaffold only from the reviewed
   artifacts and exact customer-local binding digests; and
10. persists append-only proposal/review events across process restart.

The same workflow is exposed through one customer-local command:
`pnpm product:onboarding:prepare <start|status|review|events>`. Its default
output is a concise readiness receipt rather than the full approved material;
exact artifacts require the explicit `--include-artifacts` flag. Inputs are
read from local files with a 10 MB ceiling, duplicate/confused options are
rejected, and command errors do not emit stack traces or credential material.

Every receipt explicitly separates customer/engineer inputs, CF-generated
artifacts, confirmations, remaining implementation work, and the evidence
boundary. `comparison-preparation-ready` still means the ten cases are merely
declared. It grants no authority, executes nothing, proves no case, and does not
activate a pilot.

## Validation

- strict TypeScript typecheck: **passed**;
- durable preparation workflow: **3/3 tests passed**;
- customer-local command boundary: **3/3 tests passed**;
- focused joined onboarding regression set: **34/34 tests passed**;
- restart before review: **passed**;
- restart after review: **passed**;
- identical-session idempotency: **passed**;
- conflicting-session input rejection: **passed**;
- stale-review rejection: **passed**;
- incomplete authority/verifier refusal: **passed**;
- model calls and paid spend: **0 / USD $0**.

## What this does not solve

This is a real reduction in hidden orchestration work, not yet a complete user
experience. A platform engineer still needs clearer ordinary-language guidance,
reviewed system material, approved observation semantics, and actual
customer-local runtime bindings. The generic acceptance executor, fresh-user
teardown, and measured time-to-safe-first-workflow remain separate queue items.

The core technical frontier also remains independent: durable preparation does
not itself make runtime-family selection, manifest construction, verifier
qualification, or multi-family execution more general.
