# CF-040 v2 — Registry-v3 replay migration

Date: 2026-08-14
Scope: deterministic local evidence migration
Model/API calls: 0
Paid spend: USD 0
Network, containers and customer data: none

## Outcome

CF-040 now has a separate v2 claims-isolated operator replay over the CF-050-hardened registry-v3 path. It targets the additive CF-044 and CF-045 v3 campaigns and accurately records the guarantees introduced by CF-050:

- state-bound append-only registry event history;
- exact Ed25519 lifecycle-receipt trust;
- action-time currentness checks for the selected capability and its full transitive dependency graph; and
- the existing snapshot-only routing, independent family verification, recovery, resumption and claims-isolation boundaries.

The original `validation/cf-040-claims-isolated-operator-receipt-v1/` artifacts and `reports/cf-040-claims-isolated-operator-receipt-2026-08-14.md` were not edited, relabelled or overwritten. They remain historical v1 evidence over the earlier CF-044/045 v2 and registry-v2 contract.

## Frozen v2 evidence

New frozen directory:

- `validation/cf-040-claims-isolated-operator-receipt-v2/`

The v2 configuration pins the current registry-v3 implementation, CF-044/045 v3 implementations, their v3 corpora and seals, the unchanged CF-033 goal/seal, all three native-family seals, and the preserved CF-038 result/seal.

Sealed values after final implementation stabilization:

- configuration SHA-256: `0bb00ff4c5a79266b362d9d82b728f9f36c0f09b41ea63caea0e44b222f8f7cf`
- CF-040 implementation SHA-256: `22a983a588404e546102329b9458393ee74795c49cd49630b6a3acf3c5fe3a7f`
- seal digest: `293ef88cc27492a306b6c6d080def5501ea9fe3538a1d3efaf7024a4a89a7ecd`

The focused replay exercises the frozen configuration, source hashes, implementation hash and seal digest before reconstructing the receipt. Drift in any pinned source fails closed.

### Preserved pre-seal chronology defect

The first draft used `2026-08-14T20:45:00.000Z`, while actual host UTC was approximately `2026-08-13T19:16Z`. The related first-draft CF-044/045 v3 corpora also used future UTC dates. This was detected before final handoff. Those untruthful draft timestamps and their draft seals were discarded, not treated as evidence. The final files use measured UTC freeze times, and all three loaders now reject correctly formatted but future-dated evidence even when its hashes and seal are recomputed.

## Receipt changes

The v2 operator receipt explicitly records:

- receipt schema `2.0` and campaign `cf-040-claims-isolated-operator-receipt-v2`;
- registry schema `3.0`;
- CF-044 and CF-045 v3 seal identities;
- bounded expiry under the frozen v3 corpora;
- event-history binding;
- Ed25519 lifecycle trust; and
- exact transitive dependency recheck before action.

The event narrative no longer describes hardened-v2 snapshots or a selected-entry-only health check. Existing negative claim flags remain false: no customer evidence, production evidence, activation authority, public approval, universal family coverage, formal reliability verdict or demand evidence is asserted.

## Verification

- CF-040 v2 focused replay: 4/4 passed.
- CF-040 + CF-044 + CF-045 + registry focused suite: 31/31 passed.
- Frozen source/configuration/implementation/seal validation: passed during every CF-040 replay.
- `git diff --check` for scoped files: passed.
- Repository TypeScript: passed after concurrent CF-046/048 fixture migration settled.

## Claim boundary

Supported: the private local operator receipt deterministically reconstructs the existing fictional mixed-family story using the currently sealed registry-v3 and CF-044/045 v3 evidence, while exposing the stronger currentness, event-chain and Ed25519 boundaries accurately.

Not supported: customer or production evidence, tamper-proof administrative storage, activation authority, universal capability coverage, formal security/reliability certification, demand or permission to make a public claim.

## Files changed

- `src/product/claims-isolated-operator-receipt.ts`
- `test/claims-isolated-operator-receipt.test.ts`
- `validation/cf-040-claims-isolated-operator-receipt-v2/config.json`
- `validation/cf-040-claims-isolated-operator-receipt-v2/seal.json`
- `reports/cf-040-v2-registry-v3-replay-migration-2026-08-14.md`

No CF-040 v1 artifact/report, CF-046/048 draft, queue/review state, customer artifact, deployment or public claim was changed.
