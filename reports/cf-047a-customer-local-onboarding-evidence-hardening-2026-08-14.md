# CF-047A — customer-local onboarding evidence hardening

Date: 2026-08-14
Scope: CF-042/CF-043 only
Spend/network: zero
Authority effect: none
Activation effect: none

## Result

The customer-local onboarding journey is now version 1.1 and fails closed against the four trust-laundering paths found in the skeptical security review:

1. CF-035 no longer accepts `signatureVerified: true` plus an arbitrary digest. The stored evidence contains the exact detached Ed25519 signature. Attachment and readiness reverify that signature over the exact release manifest against a customer-locally configured trusted signer. The durable journey binds the signer key ID and SHA-256 digest of the trusted SPKI public key; it never stores a private key. The redacted export exposes only the signer identity/key digest and artifact/lineage digests, not stage payloads.
2. The journey derives one source-identity digest from the exact tenant, journey, and source identity at creation. Every artifact must use that exact digest. Each accepted artifact receives a cumulative payload-derived lineage that joins package session/package digest, work pack, provider/plugin, semantic contract, compiled implementation, conformance bundle and package/provider/transport identities, binding qualification, release manifest/signer, and host doctor identities. Cross-package, cross-provider, cross-tenant, cross-plugin, cross-transport, and cross-journey substitutions fail closed.
3. CF-030, CF-029 and its nested credential/transport evidence, CF-035, CF-034, and final readiness now validate timestamp syntax, monotonic chronology, future issuance, and expiry using the injected journey clock. Readiness uses the earliest current expiry from its four time-sensitive upstream gates and rechecks the signed release and exact chain.
4. Failure disclosure is append-only. A replacement cannot erase an unresolved control. It must include an explicit resolution receipt bound to the exact journey, tenant, source identity, originating stage/artifact/control, resolver identity, evidence links, resolution detail, and non-future timestamp. The durable snapshot retains both the original failure and its resolution. Readiness computes its failure-ledger digest and historical/resolved/unresolved/omitted counts from stored history; those counts are no longer hardcoded.

## Compatibility decision

The trust contract was deliberately versioned from 1.0 to 1.1. Existing version-1.0 journey snapshots and the old boolean CF-035 receipt are not silently upgraded or trusted. A preparation chain must be regenerated under the new source, lineage, signer, time, and failure-history rules. This is fail-closed behavior, not a data migration.

## Direct exploit regressions

The focused deterministic tests now reproduce and reject:

- a fixture-shaped CF-035 receipt with a recomputed signature digest but invalid detached signature bytes;
- a caller-shaped 64-character source digest;
- a self-consistent CF-030 receipt sourced from a different package/chain;
- reversed issued/expiry chronology;
- an expired conformance receipt;
- a future-issued binding qualification;
- a genuinely signed but already-expired release manifest;
- a future-issued host doctor;
- replacement that drops an unresolved failure without a resolution receipt;
- final readiness that must retain one historical, explicitly resolved failure with zero unresolved and zero omitted controls.

The genuine CF-043 actual-output path was adapted to retain its real Ed25519 signature and configure the same trusted public key across restart. It still composes from actual CF-027/026/036/041/037/030/029/035/034 outputs through readiness.

## Verification

Commands executed:

```text
pnpm exec tsc --noEmit --pretty false
pnpm exec vitest run \
  test/product-customer-local-onboarding-journey.test.ts \
  test/product-customer-local-onboarding-journey-actual-output.test.ts
```

Results:

- repository TypeScript: passed with zero diagnostics;
- focused CF-042/043 files: 2 passed;
- focused tests: 12 passed, 0 failed.

## Files changed

- `src/product/customer-local-onboarding-journey.ts`
- `test/product-customer-local-onboarding-journey.test.ts`
- `test/product-customer-local-onboarding-journey-actual-output.test.ts`
- `reports/cf-047a-customer-local-onboarding-evidence-hardening-2026-08-14.md`

## Evidence boundary

This proves deterministic local rejection of the enumerated trust-laundering attacks and preservation of one genuine joined development path. It does not establish production security, key lifecycle/rotation operations, external signer custody, hostile database resistance, customer onboarding success, customer deployment, or universal reliability. It does not modify CF-039/CF-044 family-registry behavior and makes no public claim or activation decision.
