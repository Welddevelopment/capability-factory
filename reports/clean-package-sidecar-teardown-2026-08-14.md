# CF-011B — two-package authenticated sidecar teardown

Date: 2026-08-14

Evidence class: deterministic local fictional development evidence
Spend / network / containers / customer action: none

## Question

Can two fresh, unfamiliar fictional constrained-HTTP packages traverse the same authenticated customer-local onboarding path—preparation, exact review, binding compilation, observer qualification, executed ten-case acceptance, linked evidence, readiness and process restart—without adding package-specific executable code?

This is not a human-onboarding study. Human active time was not measured and is recorded as `null`, not zero. It does not support an under-one-day, self-serve, customer or production claim.

## Fresh packages

Two new package definitions were written specifically for this checkpoint and were not copied from earlier ERP, order-entry, dispatch, source-control or onboarding worlds:

1. **Aurora Calibration** — reserve one draft calibration slot for an approved sensor capsule, then independently query by a stable slot reference.
2. **Mistral Cold Storage** — register one provisional archive-capsule cold hold, then independently query by a stable hold reference.

Each package uses a different target, server, business vocabulary, operation IDs, credential aliases, stable identifier, conflict field and outcome. Their reviewed declaration and compiled-pair digests are different.

Each package-specific input is a 35-line declarative JSON file. The teardown harness deterministically renders approved OpenAPI 3.1 material, preparation intake and confirmed binding facts from it. That renderer is shared test infrastructure, not an existing self-serve product surface; this distinction is important.

## Reuse introduced

Added a shared `DeclarativeHttpAcceptanceWorld` and `DeclarativeCompiledHttpAcceptanceBinding`:

- one declarative action transport;
- one separately authenticated observer transport;
- one customer-local credential-alias resolver;
- one fixed ten-case acceptance implementation;
- fresh-pair reconstruction;
- lost-response reconciliation, duplicate prevention, missing credential/permission stops, partial-outcome rejection and conflicting-parent rejection.

The shared production development substrate is 269 physical source lines. The shared teardown/test harness is 154 physical source lines. Both packages use identical action-transport, observer-transport, resolver, primitive-registry and verifier-registry implementation digests. Their exact declarations and compiled-pair digests remain package-specific.

Package-specific executable code lines: **0 per package**. This does not mean no engineering was required: one shared harness was authored for the checkpoint and one 35-line package definition was authored and frozen for each package.

## Measured frozen runs

The final local run produced:

| Measure | Aurora Calibration | Mistral Cold Storage |
|---|---:|---:|
| Machine elapsed time | approximately 65–85 ms | approximately 34–45 ms |
| Human active time | not measured | not measured |
| Authenticated API calls | 6 | 6 |
| Ordinary review decisions encoded | 21 | 21 |
| Confirmed facts counted by binding factory | 94 | 94 |
| Generated action declaration fields | 47 | 47 |
| Generated observer declaration fields | 75 | 75 |
| Customer-specific declarative lines | 35 | 35 |
| Package-specific executable lines | 0 | 0 |
| Pre-run package-authoring interventions | 1 | 1 |
| Author interventions during frozen run | 0 | 0 |
| Fixed acceptance cases passed | 10/10 | 10/10 |
| Surviving incorrect side effects | 0 | 0 |
| Remaining explicit bespoke/blocker items | 6 | 6 |

Machine timings include local in-process HTTP injection, SQLite preparation state, compilation/qualification, the ten-case campaign, evidence linking, close/reopen and the post-restart readiness request. They are single-host development timings, not user time, deployment time or a performance benchmark.

The six API calls per package were:

1. start preparation;
2. submit exact review;
3. compile reviewed bindings and qualify observer;
4. link the already-executed acceptance campaign;
5. inspect readiness before restart;
6. inspect readiness after a new sidecar process opened the same durable state.

The acceptance campaign itself used the existing durable generic acceptance store directly. The API does not fabricate or execute acceptance cases merely because a client links them.

## What “21 ordinary decisions” means

This is a deterministic count of explicit package decisions encoded before the run, not measured human clicks or difficulty. It includes the bounded target/server and workflow outcome; selected action and observer operations; separate credential aliases and drivers; stable reconciliation key; request mappings for three business fields; exact success/duplicate/collateral/not-started rules; freshness; authority limits; retry policy; and disposable/restart posture.

The test did not ask a fresh person whether these questions were understandable. It only proved that once the answers exist in the documented artifacts, both packages traverse the same product path.

## Author-only steps converted or exposed

Converted into shared automation:

- per-package action/observer transport fixture code;
- per-package credential resolver fixture code;
- per-package ten-case acceptance implementation;
- fresh-process pair reconstruction;
- evidence linking and post-restart readiness reconstruction;
- removal of two stale preparation-era observer blockers after a compiled observer is qualified and executed.

Converted into explicit ordinary decisions:

- target/server, selected operations, credential aliases, stable key, field mappings, outcome predicates, freshness, authority and retry boundaries.

Still explicit blockers rather than hidden author work:

1. real customer-local credential values and secret-provider bindings;
2. values for the exact action and observer aliases;
3. engineer confirmation of rate limits, pagination, errors, timeouts and drift not proved by static material;
4. review of the real customer-local transports, credential resolver, reset path and observation surfaces;
5. exact activation authority for one real environment;
6. a fresh-platform-engineer comparison followed by a controlled customer workflow.

## Important implementation boundary

The clean-package JSON is a development teardown input. The current authenticated sidecar still expects documented preparation, reviewed normalization, confirmed binding facts and configured runtime bindings. It does not yet accept this compact 35-line package format as a supported customer API, discover every mapping unaided, or prove that a normal engineer can produce the decisions without author help.

The zero package-specific executable-line result therefore demonstrates architectural reuse inside the bounded fictional contract, not no-code onboarding for arbitrary APIs.

## Verification

- Both fresh packages completed 10/10 acceptance with zero surviving incorrect effects.
- Both returned the non-activating readiness receipt before and after process restart.
- Exact compiled-pair identities differed; shared runtime implementation identities matched.
- Strict TypeScript typecheck passed.
- The focused two-package teardown and CF-012 readiness tests passed.
- Diff whitespace validation passed.

## Strongest supported claim

“Two fresh fictional constrained-HTTP packages, expressed without package-specific executable code, traversed the same authenticated durable onboarding, compilation, verifier qualification, ten-case acceptance, evidence-linking and restart-safe readiness path.”

This does not support arbitrary OpenAPI compatibility, self-serve onboarding, under-one-day onboarding, a fresh-human result, customer evidence, activation authority or production readiness.
