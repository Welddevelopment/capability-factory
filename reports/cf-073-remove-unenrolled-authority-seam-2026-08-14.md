# CF-073 — Remove the unenrolled production-shaped authority seam

Date: 2026-08-14
Status: complete
Calls/spend: 0 / $0

## Change

CF-069 made the default production write-authority constructor require current
provider enrollment, but preserved the former constructor under an explicitly
unenrolled compatibility name so historical CF-057/058 evidence could still be
reproduced. Although no runtime used that function, it remained a
production-shaped wall-clock authority constructor that a new caller could
select deliberately.

That export has now been deleted. Frozen pre-CF-069 tests use a distinct
`createTestCustomerLocalHttpWriteAuthorityFromTrustStore` boundary which:

- requires literal `testOnly: true`;
- rejects caller-controlled time and nonce sources;
- rejects caller-supplied workspace admin keys or activation receipts;
- retains exact trust-store, continuity, activation and durable lease behavior
  needed to reproduce the historical tests; and
- is not referenced by any source runtime path.

The default `createCustomerLocalHttpWriteAuthority` remains the only
production-named constructor and requires the trusted current CF-069 enrollment
guard.

## Verification

- Repository search found no unenrolled compatibility symbol.
- The test-only trust-store constructor appears only in its definition and
  explicit test/fixture callsites.
- 31/31 focused and adjacent non-network authority/process tests passed.
- 3/3 permitted localhost joined HTTP authority tests passed.
- Strict TypeScript passed.
- No historical receipt, seal or result was rewritten.
- No calls, network service or spend occurred.

## Boundary

An explicit test-only constructor remains because historical protocol tests
must be reproducible. This is a source-level and API-boundary guarantee, not an
OS sandbox: a developer who modifies trusted source can always create a new
unsafe path. Runtime-release enrollment, process identity and external
continuity are the separate defenses against stale or substituted deployed
code.
