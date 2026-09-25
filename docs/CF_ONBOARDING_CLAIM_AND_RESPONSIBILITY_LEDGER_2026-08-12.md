# Capability Factory onboarding, claim, and responsibility ledger

Status: **private product source of truth — 2026-08-12**

This document closes a wording gap: “the agent acquires a missing capability by itself” is true only after a trusted customer-specific working boundary exists. The boundary is not a hidden implementation detail. It determines what the product automates, what the customer must decide, and which results are safe to claim.

## Strongest accurate current product claim

> Inside a predefined trusted scope, Capability Factory can let an agent encounter a missing HTTP capability, construct it from trusted documentation, test it, use it within explicit authority, verify the external result, resume its original goal, and retain the capability.

This claim is about the locally tested constrained-HTTP product. It does not mean arbitrary goals, arbitrary systems, no-setup acquisition, production reliability, customer validation, or universal capability acquisition.

## Intended onboarding outcome

The near-term product target is:

> A normal product or platform engineer can connect Capability Factory to a supported documented system in less than one working day without manually building each missing integration.

After that one-time trusted setup, an ordinary worker or upstream agent should experience autonomous recovery: ordinary goal → unsupported operation → acquire and verify the missing capability → continue. The worker should not have to diagnose an integration gap or file a capability request.

“Under one day” is a target, not a measured claim. It becomes supported only after fresh engineers complete the frozen onboarding task against unfamiliar approved systems within the time limit.

## Responsibility boundary

| Actor or layer | Supplies or controls | Must not do |
|---|---|---|
| Ordinary worker or upstream agent | The ordinary goal and relevant non-secret work context | Diagnose an integration, invent permission, paste credentials, or define technical verification |
| Customer domain owner | Business meaning, records in scope, exact success and unacceptable side effects | Treat an API success response as proof of the business outcome |
| Workspace administrator | Systems and target aliases, local credential aliases, allowed reads, preauthorized writes, approvals, limits, forbidden actions, approvers, revocation and handoff owners | Give the model raw authority to widen scope or create credentials |
| Product/platform engineer | Approved documentation, customer-local runtime connection, genuinely unsupported adapter or observer code, resettable test environment, agent/sidecar connection | Manually build each future operation when the bounded adapter already covers it |
| Capability Factory trusted code | Validate scope, provenance, authority, manifests, retry and reconciliation rules; compile confirmed contracts; enforce stops; verify evidence; retain or quarantine capabilities | Turn an inference into a fact, turn a proposal into authority, or treat declared tests as passed |
| Model or deterministic proposal provider | Propose operation mappings, request shapes, classifications, capability manifests, verifier criteria, and clarifying questions | Receive credential values, authorize writes, silently widen targets, certify its own output, or mark evidence passed |
| Customer-local execution driver | Execute only the confirmed bounded operation using local aliases and limits | Return its own action response as independent outcome proof |
| Independent observation adapter | Observe the real external success, partial, incorrect, unknown, duplicate, freshness, and collateral state | Share the acting driver’s response path as its only evidence source |

## Provenance states

Every discovered or proposed onboarding fact must retain one of these states:

- `observed` — directly present in an approved runtime or supplied artifact;
- `extracted` — mechanically read from approved material;
- `inferred-proposal` — plausible, but not a trusted fact;
- `customer-confirmed` — explicitly confirmed by an authorized customer owner;
- `independently-verified` — checked through an independent observation or validation path;
- `unknown` — missing or ambiguous and therefore blocking where consequential.

No promotion between states is implicit. In particular, a model proposal cannot promote itself to customer-confirmed or independently-verified.

## Current automation versus remaining setup

### Already automated in the working local HTTP path

- begin from one ordinary goal inside a predefined trusted scope;
- diagnose a missing bounded capability;
- search retained and trusted existing capabilities before construction;
- construct the smallest unsupported declarative HTTP residual from trusted documentation;
- independently probe the candidate before use;
- check exact customer-local authority;
- execute through the constrained runtime;
- inspect external state independently;
- reconcile before retry and prevent blind duplicate writes;
- stop precisely for credentials, permission, approval, incorrect, partial, or unknown outcomes;
- resume the original parent goal after verified completion;
- retain and reuse the verified capability, including after a fresh process;
- preserve customer-local durable state and sanitized audit evidence.

### Assisted and scaffolded by the new onboarding layer

- extract a bounded system and operation inventory from approved local OpenAPI, MCP, SDK, or reference metadata;
- preserve provenance for every proposed fact;
- classify reads and writes conservatively and flag ambiguous operations;
- identify credential aliases without accepting credential values;
- propose retry, idempotency, and reconciliation requirements;
- translate ordinary authority answers into a fail-closed draft policy contract;
- propose an external-outcome verification contract and adversarial cases;
- generate and bind a reusable constrained-HTTP outcome observer when the approved read API supplies sufficient primitives: stable-ID fetch, confirmed-filter collection queries, exact/relational/bounded/set/invariant predicates, exact cardinality and duplicate checks, collateral-state checks, and trusted timestamp/version/sequence/ETag freshness;
- derive the mandatory ten-case acceptance plan in fixed order only after the reviewed adapter, verifier, authority, execution-driver, authority-runtime binding, and observation-adapter binding agree; preserve a digest receipt linking the scaffold to those exact source artifacts;
- show exact unknowns and engineering blockers through a staged console projection.

Scaffolding is not executable proof. Any item in `proposed`, `review-required`, `unknown`, or `declared-not-run` state remains incomplete.

The Outcome Observer Factory remains fail-closed when a stable identifier, confirmed filter, observable result path, freshness proof, independent source, read-only credential boundary, or required predicate cannot be bound. Its action and observation drivers are separately identified and digest-bound; the observer cannot use an action response as proof.

### Customer or engineer work that remains unavoidable

- choose and approve the exact system, workflow, records, and documentation version;
- provide local credential values outside all generated artifacts;
- confirm consequential authority, approvals, limits, and forbidden actions;
- confirm business success, collateral constraints, and freshness windows;
- provide or approve an independent observation surface;
- implement customer-specific runtime or verifier code where no safe generic pattern exists;
- create a resettable sandbox or disposable fixture;
- execute the acceptance campaign and inspect its artifacts;
- connect the SDK or sidecar to the customer’s existing agent;
- make an explicit activation decision after all technical, security, contracting, and engagement gates pass.

## State labels that must remain distinct

1. **Proposed** — the system generated a reviewable candidate.
2. **Confirmed** — an authorized owner accepted a consequential fact.
3. **Scaffolded** — code-shaped or contract-shaped work exists but remains fail-closed.
4. **Executable** — customer-specific code and environment wiring exist.
5. **Executed** — a test actually ran.
6. **Passed** — preserved evidence satisfied every check with zero surviving incorrect side effects.
7. **Preparation ready** — onboarding artifacts are complete enough for explicit pilot review.
8. **Activation ready** — separate technical, security, contracting, engagement, package, and acceptance gates pass.
9. **Activated** — an authorized operator made a separate explicit decision.
10. **Production validated** — not currently claimed.

## Conditions for stronger claims

### “CF scaffolds most of the customer adapter”

The new deterministic fresh-system development run strengthens this from a scaffold-only statement: from frozen local OpenAPI and explicit confirmations, the system mapped all four required operations, created no unsupported operation, inferred no authority, stored no credential value, generated and bound the independent observer, and executed all ten acceptance cases with zero surviving incorrect side effects. This is still author-run local development evidence, not a fresh-human, customer, or comparative onboarding result. A public/general “most adapters” claim still requires multiple unfamiliar systems and independent review.

### “A normal platform engineer can connect a documented system in under one day”

Requires multiple fresh engineers, unfamiliar systems, no hidden author assistance, actual local SDK/sidecar setup, executable independent verification, all ten acceptance cases, measured elapsed and active time, code written, clarification count, and comparison with a manual integration baseline.

### “The agent acquires missing capabilities without integration work”

Not currently supportable. A trusted adapter and outcome observer still require setup. A future version might reduce the remaining implementation to rare unsupported pieces, but it cannot erase customer authority or business definitions of success.

### “Universal capability acquisition”

Not currently supportable. Constrained HTTP is the supported pilot mode. Other bounded modes have separate experimental local evidence and must not be merged into the HTTP claim.

## Exact current commercial and evidence boundary

- local and fictional evidence, not a customer deployment;
- no production reliability claim;
- no customer, revenue, demand, or willingness-to-pay evidence created by this onboarding work;
- no formal final green verdict;
- no claim that the under-one-day target has been achieved;
- no permission to publish private test counts, artifacts, costs, or benchmark internals;
- no authority to deploy, contact customers, or activate a pilot.

## Minimum later model-backed validation proposal — not authorized or run

When DAS is no longer credit-constrained and Joel separately approves it, run the precommitted benchmark through the provider-neutral model seam with a proposed **USD $3 maximum accounted spend**. Before execution, the chosen provider must also enforce a real pre-call/token budget; the current generic seam passes a maximum to the provider and rejects self-reported overspend after return, so it is not by itself a guaranteed billing cap.

1. one pass over each of the seven precommitted onboarding cases;
2. one fresh repeat on the unfamiliar OpenAPI case;
3. deterministic scoring against facts and blockers frozen before the run;
4. immediate abort on any inferred authority, credential leakage/invention, or budget threshold;
5. no automatic activation or mutation of customer-local policy.

This small run tests proposal quality only. The decisive later product test is still a fresh platform engineer completing a real unfamiliar sandbox connection against a manual-integration comparison.
