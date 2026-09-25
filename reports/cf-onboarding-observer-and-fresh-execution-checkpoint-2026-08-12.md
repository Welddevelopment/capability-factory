# Capability Factory observer and fresh onboarding execution checkpoint

Status: **complete deterministic local development checkpoint; not customer, production, or fresh-human validation**

## Outcome

Outcome Observer Factory v1 now converts a confirmed business outcome plus approved read-side OpenAPI material into a reviewable, digest-bound, executable independent HTTP observer when reusable primitives are sufficient. A newly frozen synthetic system then exercised the entire joined onboarding path and passed all ten mandatory acceptance cases with zero surviving incorrect side effects, zero model calls, and zero paid spend.

This supports a stronger local product statement, but it does not establish the under-one-day onboarding target. The independent-engineer comparison is packaged and explicitly marked `prepared-not-executed`.

## Meeting demo

The existing seven-item broad-goal route was relaunched from a clean state and visually verified in the local console. The first run showed new constrained capability construction; a new business-world run with the same registry showed retained reuse. Both parent goals completed 7/7 with zero blocked and zero incorrect. The exact meeting flow and genuine-session offline screenshots are in:

- `docs/CF_MEETING_DEMO_RUNBOOK_2026-08-12.md`
- `reports/assets/meeting-demo-2026-08-12/`

## Outcome Observer Factory v1

Implemented reusable primitives:

- fetch resource by confirmed stable ID;
- query collection by confirmed filters;
- equality, inequality, existence, absence, bounded numeric comparison, containment, set inclusion/exclusion, exact cardinality, uniqueness by key, relational equality, changed-from-baseline, sum and all-equal invariants;
- duplicate detection with exact completion cardinality;
- collateral-state checks;
- trusted server timestamp, ETag, version, sequence, or explicitly approved equivalent freshness;
- explicit `completed`, `not-started`, `partial`, `incorrect`, `stale`, `duplicate`, `collateral`, and `unknown` classifications.

Safety boundaries:

- action execution and observation use separate driver identities;
- the observation source, implementation, approved material, read-only credential aliases, and independent review are separately digest-bound;
- non-timestamp freshness is tied to a trusted pre-action baseline capture boundary;
- an unchanged baseline can support only the exact `not-started` branch, never completion;
- the action response is never an observation input;
- missing IDs, filters, paths, sources, freshness facts, or bindings remain precise blockers;
- proposals remain non-executable until explicit review/binding, and the joined acceptance gate remains separate from binding.

## Fresh frozen execution

System: fictional **Solstice Maintenance API**, selected and frozen after the generic observer implementation was written. Inputs:

- blocked workflow description;
- approved local OpenAPI material;
- credential aliases only;
- explicit authority answers;
- exact observable completion/collateral/freshness definition.

Joined sequence:

`adapter proposal → exact review fixture → authority compilation → observer generation/binding → digest-derived acceptance plan → actual ten-case execution → evidence receipt`

Results:

- 4/4 requested operations mapped;
- 0 unsupported operations invented;
- 0 authority inferred by discovery;
- 0 credential values stored;
- one capability construction and one no-write pre-use probe;
- fresh-process retained reuse passed;
- lost-response reconciliation passed without duplicate execution;
- partial outcome was rejected and the capability quarantined;
- missing credential and missing permission produced zero writes;
- sidecar restart, duplicate submission, and conflicting parent reuse passed;
- 10/10 acceptance cases passed;
- 0 surviving incorrect side effects;
- $0 spend and 0 model calls.

The preserved machine-readable result is:

`reports/fresh-onboarding-http-execution-2026-08-12/joined-execution-report.json`

The recorded 121 ms joined runtime and 8 ms first-acquisition timing measure deterministic local machine execution only. They are not engineer onboarding time. Human active time is deliberately `null`.

## Bespoke work and confirmations still required

Automatically proposed/generated in this development run:

- system/operation inventory and provenance;
- read/write classification and credential aliases;
- authority draft from confirmed ordinary-language answers;
- independent observer read plans and predicates;
- acceptance plan and evidence structure;
- constrained action manifest after confirmation.

Explicit confirmations remained required for target/operation mapping, credential aliases, write authority and limits, the independent observation surface, exact completion and collateral predicates, freshness baseline, reconciliation behavior, and disposable reset environment.

The generated adapter and observer required zero handwritten customer-specific implementation code for this supported primitive set. That does **not** mean the complete exercise required no custom code: the synthetic API fixture and acceptance harness were authored as test infrastructure. A real engineer may still need customer-specific observer or runtime code where an API does not expose reusable primitives.

## Strongest claim newly supported

> In a second frozen documented HTTP development world, Capability Factory’s deterministic onboarding path could propose the bounded adapter, compile explicit authority, generate and bind an independent outcome observer from reusable read-side primitives, acquire and retain the constrained capability, and pass the full ten-case local acceptance campaign with zero surviving incorrect side effects.

The broader public-safe baseline remains:

> Inside a predefined trusted scope, Capability Factory can let an agent encounter a missing HTTP capability, construct it from trusted documentation, test it, use it within explicit authority, verify the external result, resume its original goal, and retain the capability.

Do not convert the new result into claims of production readiness, arbitrary API support, customer validation, repeatable under-one-day onboarding, or no-setup acquisition.

## Remaining blocker to a real controlled pilot

The largest technical onboarding blocker is now narrower: whether a normal platform engineer, without author help, can use these factories against a real prospective customer’s supported documented API in less than one working day and how much custom observer/runtime work remains when the API falls outside the reusable primitives.

A real controlled pilot still additionally needs the customer-selected workflow/system, sandbox access, local credential binding, customer authority/security approval, independent observable completion, all activation gates, and legal/engagement readiness.

## Prepared next validation

`validation/under-one-day-onboarding-v1/` contains a separate Cedar Dispatch participant bundle, sealed evaluator oracle, no-author-help protocol, frozen scoring rubric, evidence template, known-issues record, and hash verifier. It has not been run and must remain labelled `prepared-not-executed` until a genuinely fresh engineer performs it.

Before that run, create a clean reviewed product checkpoint and update the versioned manifest because the current repository working tree contains unrelated and pre-existing changes.

## Validation

- strict TypeScript typecheck: passed;
- targeted suite: 8 files / 51 tests passed;
- final joined Solstice run: 10/10 cases passed, zero surviving incorrect effects;
- validation-kit digest verification: passed;
- model calls: 0;
- paid spend: $0;
- containers, broad soaks, deployments, outreach, customer actions: not run.
