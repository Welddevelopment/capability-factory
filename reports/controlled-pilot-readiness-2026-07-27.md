# Controlled-pilot MVP readiness — 2026-07-27

Status: **local controlled-pilot MVP gates passed for the constrained HTTP capability mode**

Frozen candidate: `19002ec40e527bb4f28d11aff4dc462b93582591`

## Plain-English outcome

Capability Factory now has a working local product candidate that can reasonably be offered for a **tightly scoped controlled pilot**, after a particular customer workflow is configured and separately approved.

It can accept a broad ordinary goal, divide it into checked smaller jobs, recognize a missing HTTP API ability, build or reuse a constrained capability, test it in a disposable state, execute through customer-local trusted code, verify the real external result independently, resume the original goal, retain the capability, recover durable jobs after interruption, and show the run in the operator console.

This does **not** mean it is generally production-ready. No customer system, customer data, customer security review, live pilot, uptime period, penetration test, or cross-industry reliability study has occurred. A named customer pilot remains blocked on all six customer-specific activation gates.

## What “HTTP workflow” means here

The current runtime can work with software systems that expose documented HTTP APIs: for example, reading an ERP record, checking whether an order already exists, creating it, and updating the source record. The capability is constrained data interpreted by trusted runtime code; it is not arbitrary generated JavaScript or shell execution.

Browser operation, desktop apps without APIs, arbitrary code, device control, account creation, and human delegation would each require a separate trusted driver, permission policy, verifier, and recovery design. The shared coordinator, authority model, durable jobs, audit trail, console, resumption, retention, and handoff layers are deliberately reusable across those future modes.

## Final validation inventory

- Normal automated suite: **176 passed**, 15 skipped opt-in cases. The skipped real-system groups were then run explicitly.
- Genuine disposable ERPNext integration suite from the frozen v3 checkout: **7/7 passed**.
- Joined durable sidecar-to-ERPNext suite from the frozen v3 checkout: **2/2 passed**.
- Clean-checkout doctor: **24/24 passed**.
- Fixed real-system adapter acceptance campaign: **10/10 passed**, with zero incorrect effects surviving cleanup.
- Frozen broad-goal model confirmation: **2/2 passed** on two fresh phrasings, two calls, **$0.056881**.
- Frozen genuine-ERPNext model confirmation: build and fresh-process reuse both passed, three calls, **$0.108585**.
- Final readiness-sequence API spend, including the preserved failed v2 run and the earlier v2 broad-goal confirmation: **$1.5058335**.

The real-system acceptance campaign covered read-only behavior, approved writes, retained reuse in a fresh SDK object, missing credentials, missing permission, lost-result reconciliation, wrong/partial outcome detection and cleanup, sidecar restart recovery, duplicate submission, and conflicting parent reuse.

## Failures preserved rather than hidden

The first clean-checkout rehearsal of candidate `1e869c5` failed because the ignored machine-local ERPNext Compose fixture was absent. Candidate `391d89f` fixed this by including the pinned fixture and an attribution notice; the repeated clean rehearsal installed, type-checked, passed the doctor, and started both product surfaces.

The first frozen model-backed ERPNext run on `391d89f` also failed. Diagnosis and model drafting worked, but trusted runtime input mapping saw “Sales Order” in the descriptions for `tracking_number` and `label_reference` and supplied the order ID to both. Independent disposable-system verification rejected the wrong fields, reset the probe, refused installation, and handed off. The run used six calls and cost **$1.2679075**.

Candidate `19002ec` replaced that first-match heuristic with conservative classification: explicit input names take priority, and ambiguous description-only mappings fail closed. Focused regression tests reproduce both the original collision and an ambiguous fallback. The corrected frozen run then passed build and fresh-process reuse.

## Clean-start rehearsal

The v3 tag was checked out into a separate detached worktree with no inherited `node_modules` or product state. The exact lockfile installed successfully, TypeScript compiled, the doctor passed 24/24, and fresh sidecar and console processes started on separate ports. Both health endpoints returned healthy responses. This tests installability and startup; it is not deployment or uptime evidence.

## Claim that is now supportable

> Capability Factory is a working MVP ready for a tightly scoped, controlled pilot. In local testing, it can take an ordinary goal, acquire or reuse a missing constrained HTTP capability, verify the external result independently, recover conservatively, and expose the full run through a customer-local sidecar and operator console. It has not yet been validated on a customer's real system.

Do not shorten this to “production-ready,” “fully reliable,” “works with any API,” “customer validated,” or “formally green.” The historical evaluation's locked yellow record remains preserved and is a separate scientific artifact from this later product-readiness assessment.

## What still blocks an actual named customer pilot

1. A recent, real, safely bounded customer workflow must be selected.
2. The customer must approve a sandbox or test environment.
3. Least-privilege local credentials must be configured.
4. Exact targets, records, methods, writes, approvals, and stopping rules must be agreed.
5. That customer's adapter must pass the same mandatory acceptance campaign.
6. Monitoring, incident handling, evidence retention, deletion, and pilot stopping must be agreed.

Until those exist, the accurate status is **locally ready to prepare and activate a controlled pilot**, not “a customer pilot is active.”
