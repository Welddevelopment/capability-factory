# CF-053 author-known local exact-record substrate freeze

Date: 2026-08-14  
Status: private technical checkpoint  
Frozen identity: `cf-053-author-known-local-exact-record-v1`

## Outcome

The author-known CF-053 development core is frozen as a narrowly named
`local-declarative-exact-record-v1` substrate. It is not a provider-transfer result.

The checkpoint can execute one exact bounded record effect in a disposable local world
through distinct action and read-only observer processes. It binds the reviewed contract,
candidate bytes, trusted parent plan, stable identity set, authority issuer, process
generation and durable world. It reconciles before a possible action, prevents duplicate
writes, verifies the externally stored record through the separate observer, supports
retained reuse after a genuine fresh process generation, and resumes the original two-item
parent exactly once after a fresh aggregate observation.

## Lifecycle and crash behavior

The runtime uses a SQLite pending/active/retired generation ledger. Candidate publication
is content addressed, staged, fsynced and atomically adopted. Child processes durably
self-register their PID, nonce, source digest, token digest, local identity endpoint and
recovery credential before announcing readiness.

Recovery does not trust a PID by itself. It targets an explicit lifecycle, optionally an
exact reservation, and requires the exact receipt digest for an active generation. A live
orphan must answer an authenticated identity challenge matching the persisted candidate,
source, process and endpoint identities before it can be terminated. Recovery then uses an
exact database compare-and-swap to delete the pending reservation or retire the active
receipt.

The final overlap regression keeps generation 1 healthy and active while a separate
generation 2 launcher is genuinely killed. Recovery removes only the exact dead pending
reservation; generation 1 remains active and completes a real transfer. After generation 1
closes, a fresh generation 2 adopts the exact generation-1 receipt as its predecessor.

## Resource and integrity bounds

- One active and one pending generation are allowed per candidate/world.
- Retired generation history is bounded.
- Candidate registry size, process source, request, response, launch output, contract,
  binding, input and durable-world sizes are bounded.
- Parent admission rejects a plan whose worst-case complete world can exceed 1 MiB.
- Crash-artifact cleanup first validates every exact candidate and aborts before deletion
  if the 256-item bound is exceeded.
- Candidate stage inspection rejects symlinks and bounds the recursive tree to 512 entries
  and 2 MiB.
- World-next cleanup accepts only bounded regular files in the exact owned namespace.

## Independent review and verification

The authority/plan/claim reviewer approved the exact checkpoint after verifying the
pre-runtime issuer pin, opaque trusted-plan boundary, dependency ordering, completion gates,
fresh-process reuse and narrow claim wording.

The concurrency/resource reviewer initially refused the freeze twice: first for missing
active recovery, registration-window process leakage, weak PID identity and non-prebounded
cleanup; then for ambiguous recovery when active and pending generations coexist. The
freeze was approved only after those defects and their regressions were repaired.

Parent-run verification after the final repair:

- selected focused and adjacent tests: 45 passed, 0 failed across 3 files;
- TypeScript `--noEmit`: passed;
- `git diff --check`: passed.

The exact file identities and freeze rule are in
`development/cf-053-author-known-core-v3/freeze-manifest.json`.

## Explicit limitations

This is local fictional author-known evidence only. It proves neither:

- a real provider SDK or provider transport executed;
- transfer to a materially different unseen provider family;
- arbitrary APIs, schemas, transforms, authentication or outcome semantics;
- customer usability, deployment, production reliability, generality or demand; nor
- any public product claim.

Operationally, bounded cleanup is not a transactional filesystem deletion if the OS fails
midway; the registration-window test is timing-dependent rather than forcing every possible
instruction-level crash point; launcher PID reuse can cause a safe false refusal; and logical
SQLite token clearing is not forensic disk-erasure evidence.

## Next technical decision

The next valid transfer experiment must add or exercise a real reviewed provider-operation
compiler/transport binding. Creating differently named fixtures that all reduce to this same
local exact-record primitive would not establish provider-family transfer and is forbidden as
an evidence shortcut.
