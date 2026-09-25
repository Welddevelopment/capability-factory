# CF-067 — post-recovery authority remains bound to external continuity

Date: 2026-08-14  
State: complete, private customer-local protocol checkpoint  
Spend/model calls: $0 / 0

## Objection attacked

> “The newest recovery point was checked during restore, but after reactivation could the product stop consulting the external anchor and issue authority from rolled-back local state?”

## Result

CF-067 carries the CF-066 external recovery completion through package reactivation, write-lease issuance and write-lease consumption.

The restored installation gate now retains:

- external anchor configuration identity;
- exact recovery manifest;
- exact pinned recovery checkpoint and generation;
- authority contract, workspace and trust configuration; and
- non-authorizing authority-restore identity.

After external completion, CF creates a module-trusted continuity guard bound to the exact recovery manifest, persisted recovery receipt, original recovery checkpoint and current `restore-completed` checkpoint. A structurally similar object cannot substitute for this guard.

## Reactivation

Normal reactivation still cannot clear the recovery gate. The dedicated reactivation path now additionally requires:

- the exact current guard;
- the exact package recovery receipt;
- a completion generation strictly after the recovery pin;
- matching installation/workspace/contract/trust identities; and
- the existing separately signed post-restore workspace activation.

Successful reactivation removes the temporary audit-only gate but persists the exact continuity identity in installation metadata.

## Authority issue and consumption

The independent authority-trust store now permanently records that it entered recovery, even after a fresh activation returns its mode to live.

The production write-authority constructor therefore:

- refuses a recovered trust store without a trusted current continuity guard;
- refuses a guard on a store with no local recovery lineage;
- binds the guard identity into the durable write-authority policy and issuer/verifier implementation identities; and
- rejects a guard from another workspace, authority contract or trust configuration.

At lease issuance, the external completed head is held under an immediate transaction while the exact durable lease is inserted. At lease consumption, the same external head is held while the workspace activation and one-shot lease are serialized and consumed. A later recovery pin invalidates both new issuance and an already-issued unconsumed lease.

## Negative controls and verification

- missing guard after recovery: rejected;
- spurious guard before recovery: rejected;
- forged structural guard: rejected;
- wrong authority store/binding: rejected;
- missing guard during package reactivation: rejected;
- later external recovery pin before issue: rejected;
- later external recovery pin after issue but before consume: rejected;
- guard restart/currentness, checkpoint mutation, clock rollback and recovery controls remain green;
- normal non-recovered authority and genuine localhost TLS write/recovery routes remain green.

Strict TypeScript passed. Forty-two deterministic focused/adjacent checks passed. Two genuine localhost TLS integration checks also passed when rerun with loopback permission; their first sandboxed attempt failed only because the sandbox denied binding `127.0.0.1` and is not counted as a product failure. Model calls/spend were 0/$0.

## Exact boundary

This proves current trusted-runtime enforcement when the recovered installation remains enrolled with its separately supplied external continuity guard.

It does **not** establish hostile-local-administrator resistance. A privileged administrator who can replace the package, authority database, runtime binary and external-enrollment configuration together can deliberately bypass current application code by running an older system. Preventing that requires a separately administered remote or hardware-backed anchor policy that the execution environment cannot omit, plus authenticated boot/deployment policy. The file-backed anchor remains a protocol reference rather than that production service.

Existing pre-CF-067 durable authority stores lack the new persistent continuity metadata and fail closed on open. A reviewed migration/repair path is still required before claiming seamless upgrade compatibility.

## Next work

- CF-068: add an explicit fail-closed migration and repair protocol for pre-CF-067 authority stores without guessing whether recovery occurred.
- CF-069: define a separately administered continuity-provider boundary so package boot cannot silently omit enrollment after it has been established.
- CF-065 remains the highest-value independent core-frontier task while CF-062 waits for provider credentials: freeze an unseen multi-runtime capability-versus-authority diagnosis benchmark.
