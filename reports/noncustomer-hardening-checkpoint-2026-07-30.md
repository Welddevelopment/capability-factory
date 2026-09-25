# Non-customer hardening checkpoint — 2026-07-30

## Outcome

The overnight pass materially reduced the technical and operational risk of starting a
tightly scoped, customer-local constrained-HTTP pilot. It did **not** remove the dominant
remaining uncertainty: whether a real company has this problem often enough, trusts the
product, and will pay for it.

The strongest honest maturity description remains:

> **Working local pilot MVP for constrained HTTP APIs, hardened enough to begin a tightly
> scoped controlled pilot once all customer-specific activation gates pass.**

It is not a production system, a general capability-acquisition platform, a customer result,
an independently audited security product, or a formal final-green verdict.

The criteria were frozen before the new work in
`docs/NONCUSTOMER_HARDENING_PROTOCOL_2026-07-30.md`. Development failures are preserved below.

## Newly implemented and verified

### 1. The customer-local container is now a real tested artifact

The final reference image was built from a 1.452 MB allowlisted context and actually started
under the intended restrictions. It is a shell-free `scratch` runtime containing only the
Node executable, required runtime libraries, certificate bundle, production dependencies and
compiled product. The exact rebuilt image had:

- content ID `sha256:bd7b8ff0c1b8c717de9b2912e53e482ef40b2f00343c6a104906fc2e7eb9b680`;
- size 53,569,907 bytes;
- configured user `65532:65532`;
- read-only root filesystem;
- all Linux capabilities dropped;
- `no-new-privileges` enabled;
- PID limit 128; and
- host publishing restricted to `127.0.0.1`.

The exact final image started under that restricted policy and reported Node `v24.18.0`.
Earlier in the pass, the packaged sidecar also completed the full clean-room fictional
handoff route, authenticated local client request, restart/idempotency check and sanitized
support export. The fictional adapter deliberately had no authority, so the expected result
was a precise zero-write handoff rather than a fake completion.

The release-only Compose example now requires an immutable image reference. The release
manifest automatically includes all 144 reviewed container/release inputs and rejects
symlinks. A temporary development Ed25519 key outside the repository signed a receipt that
covers those exact inputs plus the final image ID; complete file verification and detached
signature verification passed. The key is a rehearsal key, not a production release authority.

### 2. Constrained HTTP execution now fails closed on more hostile inputs

The trusted runtime now:

- URL-encodes every path parameter;
- rejects query strings, fragments and backslashes embedded in path templates;
- rejects target base URLs containing user information, queries or fragments;
- rechecks the final rendered origin and refuses redirects;
- reads response bodies as a stream and cancels as soon as the byte limit is exceeded;
- classifies HTTP 401 as a credential problem and 429 as rate limiting;
- treats malformed JSON and missing declared response outputs as unknown rather than success;
- treats secret-provider failures as credential failures; and
- redacts the exact credential value from raw output, extracted output and trace data even if
  a local hostile fixture echoes it under an innocuous field name.

The dedicated adversarial group passed 6/6. The broader focused reliability/security group
passed 105 tests across 16 files. These tests cover important examples; they do not prove
compatibility with every HTTP API.

### 3. Durable state, backup and rollback are stricter

Durable job storage now performs SQLite `quick_check` and refuses to start from corrupt state.
Health reporting includes the database result. Backup and restore now require:

- normalized relative POSIX paths;
- no traversal or duplicate manifest entries;
- exact equality between manifest files and payload files;
- matching installation and requested backup identities; and
- matching byte hashes before restore.

Altered bytes, added unlisted files, traversal paths, duplicate entries and identity mismatches
were rejected. A visible `pilot:lifecycle restore` command now exposes verified rollback rather
than leaving it as an internal function.

A disposable lifecycle rehearsal completed backup verification, upgrade from 0.1 to 0.2,
explicit rollback to 0.1, deactivate/reactivate, and archive-before-delete uninstall. The
final verified archive remained after installation state was removed.

### 4. The sidecar has a larger durability and concurrency baseline

The new local soak exercised:

- 1,000 unique durable jobs;
- 5,000 total submissions;
- 50 tenants;
- 20 abrupt recovery cycles and two clean restarts;
- 50 conflicting requests; and
- 100 cross-tenant probes.

Result: all 1,000 jobs reached a valid terminal state; unique execution count was 1,000;
duplicate business executions, missing terminal events, premature completions, retry-policy
violations and redaction failures were all zero. All 50 conflicts were rejected and all 100
cross-tenant probes were blocked.

On this development machine and test shape:

- throughput was 296.482 unique jobs/second;
- submission latency was 6.387 ms p50, 32.449 ms p95 and 40.228 ms p99;
- status latency was 0.078 ms p50, 0.108 ms p95 and 0.211 ms p99;
- concurrency-phase p95 rose from 0.617 ms at concurrency 1 to 39.458 ms at concurrency 100;
- peak resident memory was 350,666,752 bytes; and
- the resulting database was 2,637,824 bytes with a 4,165,352-byte write-ahead log and 3,040
  recorded events.

The memory number includes the Node/Vitest test process and is not a container-memory promise.
These measurements are a reproducible local baseline, not a service-level agreement.

### 5. Onboarding and support have clearer operator paths

The package now provides:

- `pilot:package doctor` for fail-closed readiness checks with a concrete next action;
- `pilot:package support` for an immutable sanitized support bundle;
- raw HTTP, TypeScript and dependency-free Python connection examples;
- explicit SDK-versus-sidecar guidance;
- a customer-input and troubleshooting path;
- a release-only immutable-image Compose example; and
- a tested explicit rollback command.

The Python client tests passed 3/3 when invoked from its package directory.

## Genuine disposable-system confirmation

The final branch was checked against both non-mocked disposable application systems available
locally:

- Gitea: 8/8 genuine integration tests passed; its frozen adapter acceptance campaign passed
  10/10 with zero incorrect side effects surviving cleanup.
- ERPNext dispatch/product path: 7/7 tests passed against the isolated endpoint.
- ERPNext durable sidecar/console path: 3/3 tests passed.
- ERPNext frozen adapter acceptance: 10/10 completed with zero incorrect side effects surviving
  cleanup.

The ERPNext fixture now binds only to localhost and supports an explicit paired
`CF_ERPNEXT_PORT` / `CF_ERPNEXT_BASE_URL`. This prevents different local container runtimes from
silently routing database reset commands and HTTP test requests to different instances.

These are genuine local application stacks populated with fictional data. They are not customer
systems, held-out production environments or evidence that an unknown adapter will be correct.

## Security and supply-chain checks

The final image SBOM (software bill of materials, meaning an inventory of shipped components)
contained 128 components. Grype 0.116.1 reported zero vulnerability matches with its then-current
database. The production package advisory query reported no known vulnerabilities.

Gitleaks 8.30.1 scanned all 75 commits / approximately 2.83 MB at the final checkpoint and found
no unreviewed leak. Eleven earlier findings were reviewed as exact synthetic test/example
fingerprints and narrowly ignored by fingerprint; there is no path-wide bypass.

The private threat model is in `docs/PILOT_THREAT_MODEL_2026-07-30.md`. Automated scanners and a
self-authored threat model are not an external penetration test, certification or customer
security approval. Vulnerability results are time-sensitive and must be repeated for every
release.

## Full deterministic regression result

After the final endpoint-isolation change, the ordinary full suite passed:

- 48 test files passed and 11 opt-in files skipped;
- 250 tests passed and 55 skipped;
- TypeScript strict type checking passed; and
- the deterministic reliability stress campaign passed 100/100.

The skipped groups require explicit real-system, model-backed or browser flags and are not
silently counted as passing. The available genuine Gitea and ERPNext groups were then run
separately as described above. Final type checking and focused tests were repeated after the
endpoint-isolation fix.

## Corrected failures preserved from the pass

1. The first Docker build omitted `pnpm-workspace.yaml`; after adding it, the container-specific
   TypeScript configuration still compiled private console imports that did not belong in the
   image. Both build-boundary errors were fixed.
2. The first Docker context was roughly 200 MB and accidentally included local tooling. The
   allowlist reduced it to 1.452 MB.
3. The first Debian-based runtime scan found 166 matches, including critical and high findings.
   Alpine reduced this to three medium findings; distroless still retained high/critical findings.
   The final minimal scratch runtime reports zero current matches.
4. The first container-policy test incorrectly banned package-manager use in build stages as well
   as the final runtime. The test was corrected to inspect the runtime stage while keeping the
   final image shell- and package-manager-free.
5. The backup verifier accepted important ambiguity around paths and extra payload files. The
   exact-set and identity controls above closed that gap.
6. The first release-input collector missed part of the compiled source context; a filename
   heuristic then incorrectly rejected the reviewed `src/product/secrets.ts` implementation.
   Enumeration is now complete and that exact reviewed code file is allowed without weakening
   the separate content leak scan.
7. The first Python test command was launched from the repository root, so its local package could
   not be imported. The correct package-directory run passed 3/3.
8. The first Gitea invocation used the default Docker socket instead of the isolated Colima socket;
   eight tests skipped during setup and no partial product result was claimed. With the explicit
   socket, all eight passed.
9. The first ERPNext invocation lacked Node on the escalated shell PATH, so no test ran. The next
   invocation reached a stale instance on port 8080: direct database resets changed the hardening
   VM while HTTP requests reached a different running VM. That produced six integration/product
   failures and two sidecar failures, all preserved here. Localhost-only configurable routing was
   added; isolated reruns then passed 7/7, 3/3 and 10/10.
10. The final receipt generator first hit the macOS sandbox's temporary IPC restriction, then
    rejected a prerelease-form version because its schema requires `x.y.z`. No receipt was claimed
    from either attempt. The corrected 0.1.1 receipt verified all 144 files and its signature.
11. The first final full-suite invocation ran inside a sandbox that forbade localhost test sockets.
    It produced 57 failures sharing `listen EPERM`; this was recorded as an environment failure,
    not a product regression. The identical suite with local test sockets permitted passed 250/250
    enabled tests.

## What still is not proved

- No customer has installed, trusted or paid for the system.
- No held-out customer API, credentials, verifier or blocked deployment has been tested.
- Customer-specific verifier correctness remains a major risk.
- The system does not automatically reverse or compensate for a harmful external action.
- When external state is genuinely unknowable, it stops and hands off rather than guaranteeing
  recovery.
- Pagination is supported only as bounded, documented collection reads; a generalized autonomous
  pagination strategy is not claimed.
- A malicious customer-host administrator or same-host privileged process is outside the current
  trust boundary.
- There is no public registry provenance, reproducible-build proof, production signing authority,
  independent penetration test, formal compliance certification or production operations history.
- Browser capability acquisition remains experimental and is not equivalent to the constrained
  HTTP pilot path.
- Framework-specific integrations beyond the language-neutral HTTP boundary and thin clients
  remain intentionally unbuilt until customer stack evidence exists.
- Demand, recurrence, buyer urgency, security acceptance, onboarding time and willingness to pay
  cannot be established locally.

## Decision

The constrained-HTTP product has crossed another meaningful local-hardening threshold. A real
customer-specific controlled pilot is now a better next test than another near-identical fictional
campaign. Useful non-customer work remains—especially release automation, external review and
adapter templates—but its expected information value is now much lower than obtaining one recent
blocked workflow, one customer-reviewed verifier and one real activation decision.
