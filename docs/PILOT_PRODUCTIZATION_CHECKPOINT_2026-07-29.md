# Pilot productization checkpoint — 2026-07-29

## Outcome

The five approved generic productization priorities are implemented on the reversible
`codex/pilot-productization` branch. They reduce avoidable pilot setup and operating friction
without choosing a market-specific adapter or changing the supported capability mode beyond
constrained HTTP APIs.

## Implemented foundations

1. **Adapter creation:** `product:adapter:new` creates a fail-closed customer-adapter kit
   from local trusted documentation. It pins source hashes, bounds operations, links each
   operation to an independent verifier and marks every required acceptance case not run.
2. **Installation/onboarding:** `pilot:package` initializes private customer-local state,
   pins the adapter runtime, checks readiness, assembles and starts the durable sidecar, and
   creates a sanitized immutable evidence export. Existing lifecycle tooling supplies
   versioned backup, upgrade, rollback, deactivation and verified uninstall archives.
3. **Existing-agent connection:** the localhost HTTP contract is documented as OpenAPI;
   TypeScript has durable event/status callbacks; Python has a dependency-free client. No
   agent framework is made a premature product dependency.
4. **Exact continuation:** credentials are rechecked live; signed grants expire and can be
   durably revoked; changed actions require a newly validated parent goal; every continuation
   reconciles first; unknown state stops without a blind retry; completed replay is idempotent.
5. **Health and drift:** retained capabilities record dependent workflows, compare current
   documentation, run independent probes, quarantine lost trust and permit only a newer,
   independently verified replacement.

## Verification

- Full local Vitest regression: 38 files passed, 11 environment-gated files skipped;
  221 tests passed, 55 skipped.
- TypeScript strict typecheck passed.
- Python client unit suite passed.
- Focused localhost sidecar integration suites passed when run with socket access.

Skipped files are environment-gated real-system, browser or paid/model campaigns. Their
absence from this generic regression is not converted into evidence.

## Remaining activation boundary

This makes the controlled pilot materially easier to configure and operate, but a specific
customer still needs the six activation gates in the controlled-pilot contract: named
workflow and owner, representative safe system access, customer-local credentials and
authority, completed adapter acceptance, security/operations agreement and rollback/handoff
ownership. There is still no customer deployment, revenue, production SLA, universal
capability support or formal final green verdict.

The next technical priority should be selected by the first qualified customer workflow.
Generic work after this checkpoint has lower expected value than external validation unless
it fixes an integration bug found during onboarding.
