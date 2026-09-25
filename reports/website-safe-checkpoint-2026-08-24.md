# Website-safe checkpoint — 2026-08-24

**Status: SEALED and OPERATIVE.** Approved by Joel in the main-cf session on
2026-08-24 ("seal"). This supersedes the 2026-07-27 checkpoint. It is the
authority for what may be stated in writing externally about Capability
Factory until a later checkpoint replaces it.

Prepared by main-cf. Every claim below was verified against sealed artifacts,
the registry source, or the canonical doc during 2026-08-22 → 08-24 — file
paths in the verification appendix. Scope: **Capability Factory only.** No DAS,
Fleet Brain, or cross-stack claim is cleared by this checkpoint, and none may
be merged into CF copy (cross-repository integration is not authorized; the
ladder-ownership question is under Joel's deferral bar).

---

## A. WRITABLE — the allowed list, with hard edges

Each item may be stated in writing externally, in these terms or weaker.
Strengthening a sentence beyond its stated edge voids this clearance.

**A1. Thesis (unchanged wording).** The product is not fundamentally an
integration generator; generating a constrained integration is one acquisition
mechanism. The intended advance is an agent that understands where its
configured abilities end and resolves that gap while continuing the user's
original objective.

**A2. Maturity label, verbatim only.** "A working local pilot MVP for
constrained HTTP APIs, plus seven additional experimental local capability
routes behind one shared evidence-bounded coordinator." Eight capability
families are enabled; fifteen are registered; seven remain deliberately
disabled, each with a written claim boundary in the code. Edge: the count is
EIGHT. The native-UI work is not claimable (see B2).

**A3. The frozen targeted campaign.** All 5 preregistered cases and all 8
model-backed runs passed with zero incorrect side effects, covering
capability build-and-reuse across two authentication types, handoff when no
compatible product exists, refusal without write permission, and recovery from
structured errors. Edge: state it as a frozen, preregistered campaign on
fictional local systems.

**A4. The autonomous reliability protocol — NOW WRITABLE, twice passed.**
An eight-case preregistered protocol on a genuine disposable local ERPNext —
autonomous capability build from an ordinary goal, fresh-process reuse, a
second materially different workflow, bounded repair after a failed
verification, lost-response reconciliation without a duplicate write, safe
stops on missing credential and missing permission, and refusal of an unsafe
proposal — passed 8/8 with zero safety failures on two separate occasions
(July 2026 and 23 August 2026) under the same frozen protocol, with sealed
per-case artifacts and a per-call spend ledger. Edge: always attach the
scope sentence: "local, fictional data, frozen cases — this demonstrates the
loop and its safety behaviour, not statistical reliability or generality."

**A5. The full loop, described.** Given only an ordinary business
instruction, the system diagnoses the missing capability itself, drafts it as
a constrained declarative manifest, tests it independently before first use,
executes inside exact authority, verifies the real outcome directly against
the external system's database, resumes the original goal, retains the
capability, and a later session reuses it without rebuilding. Edge: "in
private constrained local evidence" or equivalent must be present.

**A6. Verification posture.** Passing tests are treated as proving plumbing,
never model capability; model-backed and deterministic evidence are never
merged; every paid run is preregistered, frozen by source hash, budget-capped
in code, and settled per call in a durable ledger. (This is a description of
method and is fully writable — it is also the strongest differentiator.)

**A7. Demos.** CF's demonstrations are reproducible on demand on local
fictional systems, including an all-adversarial demonstration in which six
capability families each refuse a distinct unsafe request with independent
verification of zero side effects. Edge: no console URLs, no repo names, no
paths, no screenshots of private artifacts without separate approval.

**A8. August hardening arc, generically.** An adversarial review loop
generates the engineering queue; the August arc closed multiple
trust-boundary defects and added signed rotation/revocation and
backup/restore that state plainly local storage cannot resist a coherent
rollback without an external anchor. Edge: no internal work-item IDs, no
defect counts.

**A9. Honest limitations (writable, and should be written).** No customer
system has ever validated the architecture; onboarding by anyone but the
founder is unproven; the verifier corpus is author-designed; evidence
maturity differs sharply across families and family evidence is never merged;
the browser, document, EDI, message, database, compute and delegation routes
are experimental-local.

## B. NOT WRITABLE — with the reason attached

**B1. Any customer / pilot / revenue / funding / incorporation claim.** None
exist. "Ready for a first pilot" is permitted VERBALLY per existing practice;
in writing, only A2's label may carry that weight.
**B2. Native desktop/mobile UI as a capability family.** The machinery exists
and passed its containment suite this week, but the registry deliberately
holds `enabled: false` pending Joel's explicit trust-boundary decision.
Writing it would flip a trust boundary by press release. Count stays eight.
**B3. Any capability-resolution percentage (99.9% or other).** The repo's own
estimate: ~3,000 representative independent trials before a basic statistical
claim. No such trials exist.
**B4. Any waitlist claim.** The site's form is a non-transmitting visual
preview; no provider is connected.
**B5. Any DAS or Fleet Brain number in CF copy** (115/115, V2/V3 fleet
results, compiler comparisons). Cross-repo integration is unauthorized, so no
such number enters CF copy regardless of which product owns it. *(Rationale
updated 2026-08-24: this previously cited Joel's deferral of the ladder-ownership
question. He has since ruled — and a follow-on ruling indicates two separate
ladders, with the 115/115 chain and V3 campaign likely belonging to Fleet Brain
rather than DAS, pending a migration. The prohibition here is unchanged and was
never dependent on that answer.)*
**B6. The Day 7 kill test as a current verdict.** Ruled historical and
practically obsolete (2026-08-22). If referenced at all: "an early
preregistered kill test is preserved unmodified for audit integrity."
**B7. Any OpenAI balance or lifetime spend figure.** Unreconciled, multiple
writers. Exact sealed per-campaign figures (e.g. $0.494725 for the 23 Aug
reliability rerun) are writable because they come from sealed ledgers.
**B8. Generality across families, or "works on any system/website".** Every
boundary document disclaims it; the discovery evidence is one page of one
fictional system.
**B9. Anything from the demo console's paid-but-never-run entries** (the
model-backed family demos built 24 Aug). Their model paths have zero
executions; only their deterministic dry-runs have evidence. Nothing about
them is externally claimable until a paid take passes — each becomes
individually writable at that point, scoped like A4.

## C. Sealing procedure — COMPLETED 2026-08-24

1. Joel approves by name in the main-cf session.
2. This file is committed to the CF repo as
   `reports/website-safe-checkpoint-2026-08-24.md` with DRAFT markers removed.
3. AGENTS.md's "Latest website-safe current-product checkpoint" section is
   updated to 2026-08-24 (this edit is part of the same approval).
4. The hub CLAUDE.md stale lines (CF-062 "missing key", checkpoint date) are
   corrected in the same commit set.
5. A delta event is written and the outbound chat notified that the
   checkpoint is live.

## Verification appendix (what was checked, where)

Registry counts and claim boundaries: `src/product/universal-capability-contract.ts`
(read 2026-08-24, 8× enabled:true, native-ui enabled:false). Reliability rerun:
`artifacts/reliability-campaign/autonomous-reliability-v3-2026-08-23T22-48-21-528Z/`
(result.json passed:true, safetyFailure:false; model-budget.json $0.494725/13
calls; per-case sums agree). Targeted campaign: `EDGE_CAMPAIGN_REPORT.md`.
Full loop: `AUTONOMOUS_REAL_SYSTEM_REPORT.md` + the 08-23 artifacts. Maturity
label: canonical doc 2026-08-09, re-read 08-22. Suite state: 913 passed / 0
failed after every commit this weekend. Kill-test ruling: hub commit 2afa1bb.
Waitlist: standing facts, unchanged. Six-refusals demo:
`artifacts/six-refusals/takes/2026-08-24T01-43-44-054Z/result.json`.
