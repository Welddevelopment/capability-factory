# CF-040 claims-isolated operator receipt and replay

Date: 2026-08-14
Status: **passed local fictional reconstruction**
Seal: `1ad680f9d782c83eb4b9edc9bbafb6b49c507a7309f7b3b5cd39b948509ccc96`
Receipt: `91d875fb1519229bdad02e85d0f5c4b63f154991235eec5cb9f346ae94e615dd`
Private export digest: `23f4e1fe07c34185317f7c8988505b134ccdbba78909513659817d99a2b91af9`

## Outcome

CF-040 creates one claims-isolated operator receipt by reconstructing actual hardened-v2 CF-039/044/045 execution plus the preserved sealed CF-033 native-family path. Fourteen immutable source artifacts are hash-pinned before execution, including the hardened registry/executor implementations, frozen v2 corpora and seals, CF-033 goal/seal, all three native-family seals and CF-038 result/seal.

The receipt exposes a 16-event causal sequence: ordinary goal, typed decomposition, persisted snapshot, route reasons, three distinct native family proofs, exact authority/credential posture, pre-action health, native verification, restart/reconciliation, drift/replacement/handoff, retention, aggregate external proof, parent completion and claim boundary.

Evidence is not flattened. Pinned document, signed message and scoped database each retain their own seal, manifest/proposal digest, qualification, independent observation, recovery and retention digest. The aggregate references those domains without turning one family’s evidence into another family’s proof.

The reconstructed fault domain contains 10 precise handoffs and five explicit replacement lineages. Eighteen restart transitions preserve prior verified actions without replay. Completed CF-044 branches resume their parent once each; the handoff branch does not resume. Aggregate completion remains tied to new external proof.

## Replay and attacks

Replay rebuilds the receipt from the exact immutable inputs and reruns CF-033, CF-044 v2 and CF-045 v2. It compares the complete canonical receipt rather than trusting a caller-updated digest.

Thirteen independently re-digested mutations were rejected:

- selective failure omission;
- edited causal explanation;
- stale snapshot metadata;
- cross-tenant scope;
- cross-provider scope;
- cross-family evidence domain;
- replaced-lineage mutation;
- event reorder;
- missing native seal/domain;
- false customer evidence;
- false production evidence;
- false activation authority; and
- false public-claim approval.

The concise operator projection retains goal, work items, route reason, family-domain isolation, health/restart/replacement/handoff posture, parent completions, limitations and all claim-safe false flags. The full export is private and explicitly non-activating.

## Verification

- CF-040 focused: 4 passed, 0 failed.
- Relevant CF-039/044/045/040: 22 passed, 0 failed.
- Strict repository TypeScript passed during CF-040 verification. A final rerun after the full suite picked up an unrelated concurrent `test/customer-local-provider-work-board.test.ts` narrowing error for `JourneyStagePayload.workPackDigest`; CF-040 emitted no diagnostic.
- Diff check passed.
- Full repository suite: 674 passed, 0 failed and 60 skipped across 141 files.

## Claim boundary

Every customer, production, activation, public-approval, universal-family, formal-reliability and demand flag is false. This is local deterministic fictional evidence, not customer or production evidence. No network, model, spend, container, customer data, queue/review edit, commit, deployment or public claim occurred.
