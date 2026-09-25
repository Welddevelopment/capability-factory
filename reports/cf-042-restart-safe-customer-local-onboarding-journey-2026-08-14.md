# CF-042 — Restart-safe customer-local onboarding journey

Date: 2026-08-14
State: deterministic preparation-orchestration foundation complete; no activation, fresh-human, customer or time-savings claim

## Purpose

Capability Factory had strong but separate customer-local onboarding components. CF-042 composes their preparation evidence into one durable journey without making any gate stand in for another. It gives a customer or engineer one current stage, one ordered next action, one failure ledger and one redacted evidence export while retaining the exact boundary of every underlying component.

## Exact stage graph

The journey is a strict dependency chain:

1. CF-027 evidence-grounded OpenAPI/workflow authoring;
2. CF-026 exact clean-package import confirmation;
3. CF-036 exact provider SDK work pack;
4. CF-041 complete semantic review;
5. CF-037 acceptance-only semantic compilation;
6. CF-030 independent customer-local plugin conformance;
7. CF-029 exact binding qualification;
8. CF-035 deterministic signed release;
9. CF-034 current loaded-plugin doctor;
10. separate readiness evidence binding all preceding artifact digests.

The graph also names the responsible owner for every gate: customer, engineer or independent proof.

## Gate preservation

The journey verifies each artifact according to its own evidence contract:

- CF-027 must be a complete integrity-valid package draft;
- CF-026 must contain the exact 21-decision confirmation and bind the CF-027 snapshot;
- CF-036 must be an integrity-valid fail-closed work pack;
- CF-041 must contain the complete reviewed contract for the exact work pack;
- CF-037 remains acceptance-only and records that all four methods fail before acceptance;
- CF-030 must contain all mandatory controls, zero failures and an intact receipt;
- CF-029 must contain an intact qualification receipt;
- CF-035 must contain an intact release manifest plus independently recorded signature verification;
- CF-034 must be conformant/current and match the exact released package/provider/transports;
- readiness evidence must include every exact artifact digest, zero failed controls and zero omitted failures.

Each artifact has its own payload digest, source digest, upstream artifact digest, evidence links, owner, failure ledger, timestamp and journey/tenant identity. No artifact grants execution authority or activation.

## Confirmation reuse

The orchestrator records when an explicitly confirmed upstream fact is reused by digest instead of asking the same question twice. Reuse does not alter fact status. Extracted or proposed facts remain extracted/proposed; a reviewed stage can only reuse a prior explicit confirmation.

The two full fictional journeys recorded:

- 32 CF-027 decisions;
- 21 CF-026 decisions, with the overlap counted as reuse rather than duplicate review;
- 4 CF-036 exact method reviews;
- 9 CF-041 decisions, with exact reviewed method facts reused where applicable;
- zero duplicate reviews in the journey ledger.

This is a deterministic accounting rule, not a human-time or usability measurement.

## Durability and mutation behavior

`DurableCustomerLocalOnboardingJourney` stores:

- the current integrity-bound snapshot;
- every immutable revision;
- a hash-linked event chain;
- invalidated artifact identities;
- restart observations;
- command, decision, reuse, configuration, restart and transition metrics.

Exact replay is idempotent. Conflicting replay requires explicit replacement. Replacing an upstream artifact invalidates every downstream artifact. A rollback creates a new revision and restores only matching preparation artifacts through CF-041 at most; it never revives prior conformance, qualification, release, doctor or readiness evidence.

A restarted process reloads the exact journey and records the restart. It does not silently mark the plugin current. CF-034 evidence is still separately required.

## Quarantine and attack controls

The journey rejects or quarantines:

- stage skipping;
- stale revision/digest submissions;
- tenant/source identity conflicts;
- cross-journey evidence links;
- forged CF-026, CF-030, CF-029, CF-035, CF-034 or readiness receipts;
- trust laundering from extracted/reviewed state into passing proof;
- selectively omitted CF-030 controls or readiness failures;
- unresolved failures followed by an attempted later stage;
- changed CF-041 review with inherited downstream artifacts;
- release/plugin provider, source-package or transport drift;
- readiness evidence claiming activation or customer-production proof;
- rollback attempts that would revive invalid evidence.

An unresolved failure puts the journey into `quarantined`. The only valid progression is to resolve and explicitly replace its originating artifact. Later stages cannot bypass the failure.

## Product surfaces

The authenticated customer-local sidecar exposes:

- create/read journey;
- attach exact stage artifact;
- record restart;
- rollback;
- inspect events;
- export redacted evidence.

The `pnpm onboarding:journey` CLI exposes the same preparation controls for local files and SQLite.

Redacted export omits artifact payloads but preserves payload/artifact/source/upstream digests, evidence links, failures, invalidations, events, metrics and blockers. This supports review without exposing customer material or credential values.

## Exercises and metrics

Two unfamiliar fictional journeys (`nova` and `quasar`) traversed all ten stages independently. Each journey had:

- 11 customer-local commands including journey creation;
- 10 stage transitions;
- 10 separately validated artifacts;
- 0 duplicate reviews;
- 0 manual executable code files attributed to journey orchestration;
- 10 recorded config/evidence objects;
- 0 final blockers;
- 0 authority or activation effects.

Additional controls exercised an unsupported CF-027 stop, stage skipping, forged receipt, cross-journey link, failure quarantine, crash/restart, upstream review replacement, downstream invalidation, exact rollback, release/plugin drift, unauthenticated sidecar access and CLI restart.

## Verification

- Repository-wide TypeScript typecheck: passed.
- Focused CF-042 suite: 8 tests passed.
- Joined CF-026/027/029/030/034/035/036/037/041/042 and readiness/productization suite: 11 files, 83 tests, 0 failures.
- `git diff --check`: passed.
- Model calls, network calls, package installation, containers, customer credentials and customer data: none.

## Strongest accurate claim

Capability Factory now has one restart-safe customer-local preparation journey that coordinates its API and SDK onboarding stages, reuses exact confirmed facts by digest, preserves every separate evidence gate, blocks stale or omitted failures, and produces a redacted integrity-bound readiness chain without granting execution authority or activation.

This does not establish fresh-human usability, reduced onboarding time, customer deployment, production reliability or activation readiness for a real customer.
