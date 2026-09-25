# CF-063 — proposal-to-onboarding review-work compiler

Date: 2026-08-14  
State: complete, private local checkpoint  
Spend/model calls: $0 / 0

## Result

CF-063 now converts one schema-valid, hard-safety-clean CF-010 adapter/verifier proposal directly into a digest-bound review work pack. The path removes hand transcription between model/provider output and onboarding preparation without treating that output as trusted configuration.

The work pack preserves:

- exact campaign, seal, case, source-material and proposal identities;
- untrusted proposal provenance;
- benchmark score and pass/fail separately from product readiness;
- action and observer operation keys, alias-only credentials, verifier structure, questions and blockers;
- eight explicit customer, admin, engineer and independent-verifier tasks;
- nine mandatory product blockers covering confirmation, credentials, authority, implementation, independent proof, acceptance, customer-environment conformance and activation.

Every generated task remains `required-not-complete`, grants no authority and counts as no evidence. The work pack is always non-executable, write-unauthorized and activation-blocked.

## Onboarding join

A derived onboarding review projection now uses the existing onboarding vocabulary:

- readiness: `review-required` or `blocked`;
- adapter: `proposal-only`;
- verifier: `provisional-review-required` or `blocked`;
- authority: `blocked`;
- acceptance: `not-generated`;
- activation: `not-activated`.

The projection is deliberately not a full adapter, observer, authority contract or acceptance plan. It shows the exact remaining review and implementation work without manufacturing fields absent from the compact proposal.

## Safety and integrity behavior

- Credential-shaped preflight material cannot enter the compiler.
- Invented operations/aliases, action-response proof, removed mandatory blockers, unsafe promotion or other CF-010 hard-safety failures stop before work-pack generation.
- A safe but incomplete proposal may be preserved for review, but its benchmark failure remains explicit and does not become readiness, evidence or authority.
- Proposal mutation invalidates the work pack.
- Reopening against changed benchmark source bytes or a different campaign seal fails closed.
- Projection and work-pack language explicitly state that no acceptance case ran and nothing was activated.

## Verification

- Strict TypeScript passed.
- 15/15 focused and adjacent deterministic tests passed across CF-063, the frozen CF-010 benchmark and the durable onboarding-preparation workflow.
- No provider call, model result, external request or spend occurred.

## Exact claim boundary

This is a local deterministic compiler over author-designed fictional benchmark proposals. It proves that a future provider proposal can be transferred into review work without silently gaining authority or evidence. It does not prove proposal quality, model performance, reduced human setup time, executable adapter generation, observer qualification, acceptance, customer use, production reliability or activation.

CF-062 remains the separate frozen one-shot provider benchmark. Its four eligible calls have not run because no API key is currently available.

## Cross-project DAS checkpoint recorded separately

The independent DAS workstream completed one prospective equal-resource fictional paired comparison against a strong adaptive automated engineer. DAS and the baseline each fully passed 1/2 unseen cases; mean verified outcome was 0.9583 versus 0.9167. DAS made zero unsafe attempts, while the baseline attempted a forbidden account suspension that the shared authority boundary blocked, triggering the preregistered safety disqualification. DAS was slower (32.7s versus 26.5s) and more expensive ($0.02086 versus $0.01870). This is one fictional role and paired sample: it is private DAS evidence, not CF evidence, broad DAS superiority, customer evidence or CF–DAS integration evidence.

## Next technical dependency

When credentials become available, CF-062 can run exactly once under the already committed durable accounting and $0.75 campaign ceiling. Until then, the highest-value independent zero-spend queue item is CF-066: externally pinning monotonic continuity so a correctly signed but older package/authority recovery state cannot silently replace a newer one.
