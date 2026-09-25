# CF-031 — provenance-bound cross-family routing

Date: 2026-08-14

Status: frozen local routing benchmark complete; execution deliberately absent

## Result

CF-031 adds one family registry and reproducible route-decision layer across
six independently evidenced runtime families:

- constrained HTTP;
- CF-007 pinned documents;
- CF-008 signed messages;
- CF-009 scoped databases;
- SQLite/file composition; and
- the mature local browser-action reference family.

The registry normalizes only route-level facts: operation name, input/output
artifact types, environment, authority and credential names, observer
availability, safety/latency/cost estimates, source tier, retention health,
dependencies and exact evidence maturity. Manifest, authority, verifier,
lifecycle and evidence material remains family-owned behind opaque digests.
Every candidate binds its family's isolated evidence boundary; no family claim
is promoted by another family's result.

No family runtime is imported or invoked. CF-031 selects or hands off a route;
CF-033 remains the execution boundary.

## Search and decision policy

The bounded search order is:

1. verified active retained candidates;
2. trusted existing candidates; and
3. constructible residual candidates.

Within a tier, eligible candidates are ordered by safety, latency, cost,
evidence maturity and stable identity. Stale or quarantined retained assets are
ineligible. Capability/environment/artifact/observer/dependency failures are
kept separate from missing authority or credentials. A route that exists but
lacks authority produces a precise handoff, not a missing-capability claim.

Same-name candidates from multiple families produce a precise handoff when
their route-level semantic facts remain tied and the goal supplies no family
constraint. Evidence maturity does not silently resolve that ambiguity.

## Frozen benchmark results

- Families: **6**
- Candidates: **11**
- Mixed-family goals: **10**
- Exact expected decisions: **10/10**
- Exhaustive-baseline matches: **10/10**
- Route accuracy: **100% on this frozen benchmark**
- Selected: **7**
  - retained: **2**
  - trusted existing: **3**
  - constructible: **2**
- Precise handoffs: **2**
  - missing authority: **1**
  - ambiguous same-name operation: **1**
- Safe rejection: **1** unsupported artifact conversion
- Primary candidate expansions: **110 total**
- Exhaustive baseline expansions: **110 total**
- Execution attempts: **0**
- Model calls / paid spend: **0 / $0**

The stale-retention goal rejected the lower-cost stale retained asset and chose
the trusted-existing alternative. The database handoff preserved an otherwise
valid capability while naming missing authority. The unsupported conversion
did not invent a bridge between signed-message and document artifacts.

## Receipt contents

Each CF-023-style receipt binds:

- registry, benchmark and seal digests;
- goal/work-item requirement digest;
- search and exhaustive-baseline budgets/expansions;
- every candidate examined, objective, rejection codes and source tier;
- opaque family reference, candidate evidence and family evidence digests;
- selected route or exact handoff/rejection reason;
- rejected routes and dependency set;
- exhaustive counterfactual and exact-match result; and
- all six family evidence boundaries with claims-isolated markers.

Validation rebuilds the entire receipt from frozen inputs. Re-signing a false
explanation is insufficient.

## Adversarial validation

Tests blocked re-signed receipt manipulation for:

- cross-family evidence substitution;
- candidate/verifier evidence reuse;
- false safety metadata;
- false cost metadata;
- authority/capability conflation;
- false selection explanation; and
- replay under another goal.

Registry validation additionally blocks duplicate evidence references,
cross-family family-evidence substitution, unknown and circular dependencies,
self-dependency and metadata that is not backed by a family affordance. The
outer seal blocks registry drift, including altered safety or cost estimates.
Repeated generation is byte-stable across restart-like fresh calls.

## Verification

- CF-031 tests: **10/10 passed**.
- Strict repository TypeScript check: passed.
- Frozen registry, benchmark and implementation hashes are checked before use.
- Historical family implementations and evidence were not modified or merged.
- No queue edit, commit, network, model, paid call, container, customer data or
  customer action was used.

Seal digest:
`5bcef1fe21b6cd16cb43335e0495b3c5d65a7708e638d5d4b3a410bed7c3b998`

## Remaining execution gap

This benchmark proves deterministic routing over a small frozen local registry,
not runtime interoperability or end-to-end mixed-family completion. It does not
translate manifests, authority receipts, verifier receipts or lifecycle state
between families. Estimates are frozen reviewed metadata, not measured
production guarantees. Real discovery needs authenticated registry updates,
fresh environment/authority checks and family-native execution evidence. The
selected route still must pass its own manifest, authority, verifier,
reconciliation and lifecycle controls when CF-033 executes it.
