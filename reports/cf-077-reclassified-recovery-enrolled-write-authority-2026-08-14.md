# CF-077 — Reclassified recovery joined to enrolled write authority

Date: 2026-08-14
Status: local system-clock joined path complete
Calls/spend: 0 / $0

## Joined scenario

CF-077 exercised the full authority chain in one fresh fictional local setup,
rather than relying only on separate component tests:

1. A real workspace-authority store received an initial signed activation.
2. Its legacy continuity metadata was removed to create the exact pre-CF-068
   migration shape.
3. The store migrated as ambiguous and audit-only.
4. A current independent assessor signed an exact never-recovered
   reclassification attestation.
5. The store reclassified without acquiring authority.
6. A signed audit backup preserved the full reclassification lineage.
7. The backup restored to a fresh audit-only database.
8. A separate monotonic anchor recorded and completed that new recovery.
9. The restored store rejected its original pre-restore activation as
   insufficiently fresh.
10. A new post-restore activation was signed and imported.
11. A provider enrollment policy and live currentness response bound the exact
    installation, runtime release, authority contract, trust configuration and
    new recovery guard.
12. The enrolled authority issued and consumed one bounded lease.

All production-shaped boundaries used the system clock. No test-only authority
constructor or caller-controlled time/nonce seam was used for the joined write
authority.

## Negative controls

- The historical pre-restore activation could not leave the restored store's
  audit-only mode.
- A fresh activation without the required external recovery guard could not
  construct write authority.
- A lease issued while the live provider was active could not be consumed
  after the provider moved to a higher suspended epoch.
- Advancing the external recovery anchor invalidated the formerly current
  recovery guard; the already-running authority could not issue another lease.

The successful write-authority lease and every stopped variant shared the same
restored reclassification lineage and authority contract.

## Verification

- 1/1 joined end-to-end scenario passed.
- The exact scenario passed in three additional unchanged runs.
- 44/44 focused and adjacent migration, trust, write-authority, enrollment and
  provider-process tests passed.
- Strict TypeScript passed.
- No model call, external network, customer data or spend occurred.

## Exact boundary

This is a fictional local system-clock test. It is not a customer recovery,
remote provider, production key-custody, multi-host failover, real API write,
security certification or reliability claim. The authority lease proves the
joined authorization lifecycle, not external business-outcome execution. A
real controlled pilot must still supply its own customer-local keys, recovery
anchor, provider process, policy, adapter, observer and acceptance evidence.
