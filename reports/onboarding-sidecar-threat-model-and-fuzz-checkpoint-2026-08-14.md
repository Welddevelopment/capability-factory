# CF-022 — onboarding sidecar threat model and deterministic adversarial pass

Date: 2026-08-14

Evidence class: local deterministic development security testing

Not: a formal security audit, penetration-test certification, production-hardening claim or compliance result
Spend / network / containers / customer action: none

## Result

Threat-modelled and adversarially exercised the authenticated onboarding sidecar across its token, secret, tenant, session, provenance, persistence, evidence and resource boundaries.

The explicit model is in `docs/ONBOARDING_SIDECAR_THREAT_MODEL_2026-08-14.md`. It identifies protected assets, five attacker classes, seven trust boundaries, named controls and out-of-scope host/network/security assumptions.

## Concrete findings repaired

### 1. Token-length side channel in application code

The first implementation compared candidate-token length before calling `timingSafeEqual`. It now hashes both candidate and configured tokens to fixed-size SHA-256 buffers and always compares those fixed-size buffers when a string header exists. This expresses constant-time comparison intent across token lengths. It is not a laboratory timing proof.

### 2. Unbounded recursive artifact canonicalization

Deep untrusted JSON could reach recursive canonicalization before a structural bound. A dedicated iterative preflight now caps:

- nesting depth;
- visited node count;
- collection/object width;
- string length;
- key length;
- total canonical size;
- prototype-control keys.

Secret-shaped values are inspected during the iterative walk before persistence or compilation.

### 3. Post-review crash recovery gap

If the durable preparation workflow committed a review and the process stopped before the API envelope was inserted, an exact retry previously reached a non-reviewable state. Recovery now verifies the proposed-event snapshot, input digest and every derivation-receipt field before reconstructing only the missing envelope. A changed review still fails closed.

### 4. Failed compilation pinned an unusable binding artifact

The API previously stored a binding request before compilation. A transient or malicious runtime failure could permanently occupy the stage. Compilation now succeeds first; only then is the exact request envelope committed. An exact safe retry can recover after a runtime failure.

### 5. Downstream error leakage

Errors from customer-local runtime dependencies are now single-line, length-bounded and redacted for bearer tokens, `sk-` keys, password/API-key/client-secret/access-token pairs and private-key blocks. Parser-level malformed and oversized requests use stable redacted responses.

## Deterministic adversarial coverage

The new property-style suite uses a fixed seeded generator so attacks are reproducible. It covers:

- malformed tokens across many generated lengths and characters, with uniform 401 bodies;
- path, SQL-shaped, null, slash and header-injection attempts;
- nested bearer/key/password/private-key payloads and runtime-thrown secret errors;
- deeply nested, very wide, oversized and malformed JSON;
- parser-level and direct prototype-control key rejection;
- exact concurrent replay and conflicting intent;
- crash/restart after preparation commit and after review commit;
- retry after failed binding compilation;
- tenant/session/pair-derived acceptance identity;
- generated wrong-pair links;
- forged acceptance result/receipt chains;
- verifier qualification expiry at readiness time;
- stored envelope substitution under a different session key;
- response truth labels remaining non-activating and non-customer evidence.

Existing CF-017 tests separately retain direct persisted-envelope mutation coverage. CF-012 continues to recompute every acceptance receipt and predecessor hash before issuing readiness.

## Validation

- Strict repository TypeScript typecheck passed.
- CF-022 focused suite passed 8/8 tests (four security properties plus the imported four CF-012 receipt-integrity tests).
- The combined onboarding/binding/security suite passed without network, model calls, containers or external services.
- Diff whitespace validation passed for the checkpoint files.

## Remaining security gaps

- no production TLS, multi-user authentication, RBAC or remote deployment boundary;
- no host-admin confidentiality, encrypted SQLite, hardware-backed keys or anti-rollback ledger;
- no sustained hostile-load or distributed concurrency testing;
- no formal side-channel measurement;
- no third-party penetration test, formal verification or supply-chain certification;
- no customer-production environment or regulated-data evidence.

## Claim boundary

Supported: “The customer-local onboarding API has an explicit threat model and deterministic regression coverage for the named authentication, secret, tenant/session provenance, evidence-integrity, restart and resource-boundary attacks.”

Not supported: “secure,” “production hardened,” “audited,” “certified,” “penetration tested,” or safe for arbitrary public network exposure.
