# Broad-goal coordinator checkpoint — 2026-07-27

Private development record. This is not a public evidence page or a production-readiness claim.

## Plain-English result

The reference product can now take one broad fictional operations goal, ask a model to propose a bounded plan, and have trusted code check that the plan covers every required item exactly once, uses only approved workflows, preserves dependencies, and never invents authority. A restart-safe scheduler then executes the seven internal jobs. One of those jobs genuinely passes through the Capability Factory core: search retained capabilities, build the smallest constrained HTTP capability when absent, probe it in a disposable state, execute it, verify the external result independently, retain it, and reuse it in a fresh run. The parent goal is only marked complete when direct database checks confirm every item and the aggregate result, with no incorrect side effects.

## Implemented shape

1. One ordinary parent goal enters the product reference.
2. The model proposes decomposition and grouping; it does not receive secrets or authority grants.
3. Trusted validation enforces exact coverage, allowlisted workflows, real dependencies, and current authority.
4. Stable work-item and operation IDs make restarts and reconciliation safe.
5. Jobs execute conservatively; genuinely dependent work waits, while independent branches can continue.
6. Missing authority produces a zero-write handoff rather than a disguised partial success.
7. Each item is checked against external SQLite state.
8. A separate aggregate verifier checks exact counts, duplicates, suppliers, quantities, operation keys, and unrelated-order invariants.
9. Only a clean aggregate result resumes and completes the parent goal.
10. The early console displays the real coordinator/run state. Its prompt field is explicitly a demo input; the rest is an early product-console reference.

## Verification performed

- Full ordinary local regression suite: 155 passed, 13 explicitly skipped genuine-ERPNext tests, 0 failures.
- Selected coordinator and console suite: 37/37 passed.
- Model development campaign: 3/3 broad-goal phrasings passed on the first proposal, 3 calls, USD 0.101820 total.
  - First case built and verified the capability.
  - Second and third cases used the retained capability.
  - All completed seven jobs, resumed the parent, and produced zero incorrect side effects.
- Frozen confirmation: 2/2 new phrasings passed on the first and only proposal, 2 calls, USD 0.070150 total.
  - Build case: 7/7 complete, capability built once, zero incorrect side effects, parent resumed.
  - Fresh reuse case: 7/7 complete, retained capability used, builder not called, zero incorrect side effects, parent resumed.
  - Frozen commit remained `de890b665f52e4d1cd908cee57f22b7a90c19106` throughout.

Saved private artifacts:

- `artifacts/broad-goal-model-development-2026-07-26T22-42-34-659Z/report.json`
- `artifacts/broad-goal-model-confirmation-2026-07-26T22-47-36-854Z/campaign-freeze.json`
- `artifacts/broad-goal-model-confirmation-2026-07-26T22-47-36-854Z/result.json`

## Rollback and recovery

- Branch: `codex/broad-goal-coordinator`
- Before-feature commit: `f49bcb8`
- Before-feature tag: `checkpoint/pre-broad-goal-coordinator-2026-07-27`
- Confirmed implementation commit: `de890b6`
- Confirmed implementation tag: `checkpoint/broad-goal-confirmed-2026-07-27`

If the console or coordinator is not suitable by the application date, the original passing state remains directly recoverable from the before-feature tag. The confirmed coordinator state is independently recoverable from its own tag.

## Claim boundary

This result supports a narrow statement: in a fictional, locally controlled, pre-scoped world, the reference product repeatedly turned differently worded broad goals into a trusted seven-job plan, executed and independently verified the full outcome, and built then reused one constrained missing HTTP capability.

It does **not** establish:

- arbitrary decomposition of any real business goal;
- autonomous discovery of the relevant company data or scope;
- production security, reliability, scale, or multi-company isolation;
- multiple unrelated missing capability types in one broad goal;
- browser, device, arbitrary-code, account, human-delegation, or physical actions;
- customer demand, a pilot, revenue, or a validated beachhead;
- a held-out customer-system result or formal final green verdict.

## Application-safe wording

Current honest wording:

> In a private local reference environment, we can give the system one broad operations goal, have a model propose the individual jobs, reject any plan that invents scope or authority, execute the approved jobs, independently verify the external result, and resume the parent goal. In a frozen two-case confirmation, a new phrasing built and verified one missing HTTP capability and a fresh run reused it; both completed all seven checked jobs with no incorrect side effects. This is constrained development evidence, not a production or customer claim.

For a short YC answer, omit exact counts unless the surrounding answer clearly labels the environment as fictional and local.
