# CF-047B durable family registry security hardening

Date: 2026-08-14
Status: **implemented and locally verified**

## Outcome

CF-047B replaces CF-039’s self-asserted lifecycle digest boundary with signed lifecycle receipts. A receipt now binds tenant, environment, family, candidate, version, status, trusted issuer and key ID, issued/checked/expires chronology, and exact manifest, documentation, schema and provenance digests. The registry verifies an Ed25519 signature over the canonical exact payload using configured trusted public keys. No production export can mint a lifecycle receipt; tests use a private fixture signer defined only in the test file.

Registry rows are now self-authenticating across their stored scope, revision and payload. `list`, `snapshot`, `route`, `recheckBeforeAction` and export recompute row/snapshot digests and reject/quarantine raw SQLite tampering. Cross-tenant/environment receipt replay, attacker re-signing, invalid chronology and material substitution fail before admission.

Upsert uses `BEGIN IMMEDIATE`, reads the revision inside the transaction and performs a conditional revision update. Exact same-version replay is idempotent; any same-version semantic mutation is rejected, and semantic replacement requires a higher version. The two-handle CAS regression observed exactly one successful higher-version writer.

Dependencies must exist and be eligible/current; cycles fail closed. Routing recursively evaluates snapshot dependencies, and execution rechecks the current dependency graph. When a dependency becomes unhealthy, its dependent route becomes a precise handoff.

Refresh is now a single exact evidence path. Every entry requires a signed lifecycle observation and route digest; omission aborts the refresh. Source, route, manifest, documentation/schema/provenance receipt, status, expiry or signature drift makes the entry ineligible. A signed quarantine cannot be turned back into active by an untrusted re-signature.

Snapshot identity binds scope, revision, exact entry digests, event digest, `createdAt` and `expiresAt`. Creation enforces `createdAt < expiresAt` and a configured maximum TTL. An identical request at the same deterministic time returns the exact persisted receipt; timestamp or receipt mutation fails closed.

Authenticated local access, redacted evidence export and non-activating import remain intact.

## Direct exploit regressions

Eight focused groups cover:

1. trusted signature, scope, issuer/key, chronology and exact material enforcement;
2. attacker re-signing and cross-tenant replay;
3. exact idempotency, same-version mutation and two-handle CAS;
4. two distinct OS processes racing the same expected revision, with exactly one winner;
5. selective refresh omission plus source/route/material/quarantine transitions;
6. raw SQLite payload/scope integrity;
7. missing/unhealthy/circular dependencies and dependent handoff;
8. timestamp-bound snapshots, authentication, redacted export and evidence-only import.

Focused CF-031/032/039 result: 23 passed, 0 failed across 3 files. Diff check passed. The broader suite excluding explicitly deferred CF-044/045 migrations produced 647 passed, 9 failed and 60 skipped; all nine failures are in concurrently changing CF-042/043 onboarding tests, which this task forbids editing. Repository-wide TypeScript currently reports the explicitly permitted CF-044/045 API migration failures because the public minting helper was removed and the constructor now requires trust configuration; separate concurrent onboarding typing changes also report errors. CF-042/043 and CF-045 partial files were not edited.

## Claim boundary

This is local deterministic registry security evidence over fictional inputs and test-only signing keys. It is not customer, production, deployment, certification, demand or universal-reliability evidence. No network, model, spend, container, customer data, queue/review edit, commit, deployment or public claim occurred.
