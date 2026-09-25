# Overnight product checkpoint

Status: **private handoff for Joel — public claims require separate review**

## Where we are now

This is no longer only the original fictional evaluation harness. There is now a separate,
domain-independent product reference layer plus a genuine disposable ERPNext development
world. It is still not a production SaaS product.

The strongest plain-English product shape is:

> A thin package inside an agent reports where the ordinary goal became blocked. A
> customer-hosted runner searches retained and trusted existing capabilities first,
> acquires only the unsupported residual, verifies it, performs authorized actions,
> checks the real external outcome, and lets the original agent continue. A hosted layer
> can later coordinate updates and exceptional handoffs without holding customer secrets
> or detailed action outputs by default.

## Implemented and verified locally

- Shared typed boundaries for blocked goal, missing ability, customer authority,
  verification receipts, outcomes, resumption, audit events, and handoffs.
- Tenant-separated persistent capability storage, reuse counts, quarantine/revocation
  status, documentation-hash matching, and concurrent acquisition coalescing.
- Search order: retained verified capability → configured trusted catalog/provider →
  structured unsupported-residual builder.
- Provider-neutral catalog filtering that excludes disabled and untrusted entries; every
  chosen candidate still goes through local policy and verification.
- Product-only recursive draft format for nested request bodies, converted to a strict
  model-output schema without dynamic map keywords.
- Limited validation and semantic repair loops.
- Separate capability verification and external-outcome verification.
- Goal resumption is mandatory; a successful connector action without completed original
  goal is a handoff, not success.
- Embedded SDK, authenticated localhost sidecar with thin client, and privacy-minimizing
  split control-plane/customer-data-plane reference paths.
- Customer authority checks for targets, credential aliases, methods, blanket write
  denial, preauthorization, and per-action approval.
- Tenant-separated redacted audit journal and credential-shaped handoff redaction.
- Genuine Frappe 16.28.0 / ERPNext 16.29.0 fixture, roles, deterministic reset, direct
  database verifier, resource API adapter, and safe retry reconciliation.

Current deterministic checks:

- 23/23 product architecture and boundary tests;
- 66/66 complete fast tests after the latest repairs; and
- 7/7 serialized genuine-ERPNext checks, with the earlier invalid 6/7 concurrent harness
  run preserved separately.

Current model-backed product evidence:

- one passed build-and-fresh-process-reuse run against genuine local ERPNext after three
  preserved development failures;
- exact final external state, zero incorrect side effects, and goal resumption in both
  build and reuse; and
- USD 1.6746925 total across 10 model calls for all four attempts.

Subsequent private confirmation evidence:

- a materially different Material Request → Purchase Order workflow passed 3/3 frozen
  model-backed build-and-fresh-process-reuse trials inside the same genuine disposable
  ERPNext installation;
- every valid trial passed direct database verification, goal resumption, retention, and
  fresh-process reuse with zero incorrect side effects;
- one trial needed a bounded retry after an incomplete response, one passed on its first
  call, and one needed two bounded verifier-guided timeout repairs;
- the valid v2 campaign cost USD 0.620939 across 6 model calls; cumulative product-model
  work, including the earlier dispatch work and a preserved invalid procurement harness
  campaign, is USD 3.2069855 across 26 paid calls; and
- this still begins after a diagnosed need and remains same-application, synthetic,
  non-customer, non-held-out development evidence.

## Product choices that remain open

### Commercial center

All three remain viable and composable:

1. **Unsupported capability acquisition** — build only the residual no trusted tool covers.
2. **Orchestration over existing tools** — find and independently verify existing customer
   or provider capabilities before building.
3. **Outcome verification, recovery, and resumption** — make sure actions produced the
   right real state and the original goal actually finished.

Founder conversations should determine which pain is expensive enough to buy. The local
architecture should not force the answer.

### Deployment

- **Embedded SDK:** fastest pilot, but coupled to the customer's language/process.
- **Customer-hosted sidecar:** recommended first default; language-neutral and keeps
  credentials/actions local.
- **Hybrid:** likely long-term shape; hosted coordination plus customer execution, but
  durable queues, workload identity, encryption, and versioning are unbuilt.
- **Fully hosted runtime:** easiest onboarding for some low-risk customers, but the highest
  trust/compliance burden; keep optional rather than default.

## Market state

The commercial segment is not locked. The current best hypothesis is early-stage B2B
companies deploying action-taking agents whose current customer deployment is delayed by
an unsupported or customer-specific authenticated HTTP API.

The stricter score is 83.9/100 and the supported public top tier remains 12, below both
advance thresholds. The reachable pool estimate of roughly 28–50, central estimate about
38, is an inference. Booko, Vooma, Poka Labs, Comena, and CollectWise are research targets,
not customers. Trig and superglue are important adjacent competitors/substitutes. Founder
conversations must validate recurrence, overhead, mechanism, buyer, and buy versus build.

## Recommended next sequence

Steps that genuinely depend on earlier evidence:

1. Run founder conversations and ask about the last ten deployments. Obtain one real,
   recent, safely reproducible blocker.
2. Bind a new customer-world adapter to that workflow; do not bind the core or website to
   ERPNext/logistics now.
3. Freeze a cross-system protocol, documentation, permissions, cases, model, limits, and
   verifier before the held-out transfer run.
4. Run an unchanged build + fresh-session reuse + denial/no-action/retry campaign.
5. Only then choose pilot packaging and production hardening around the customer's real
   environment constraints.

Work that can happen in parallel:

- founder outreach preparation and conversations;
- sanitized evidence design for the website/application without publishing current raw
  artifacts;
- threat-model review, workload identity, capability signing, revocation, durable queue,
  and secret-provider design;
- local adapters for customer-approved existing-tool catalogs; and
- refining the YC narrative while keeping market wording provisional.

## Claim boundary

Do not call this production-ready, cross-system generality, customer validation, a locked
beachhead, or a formal green verdict. Do not publish exact private counts or ERPNext/model
artifacts without Joel's approval and a sanitization review.

The defensible summary today is:

> We have a constrained product reference in which a model-drafted HTTP capability was
> independently probed against a disposable real application, reset, used to complete and
> verify an ordinary goal, then retained and reused by a fresh process. The result is a
> promising development feasibility signal, not production or market validation.
