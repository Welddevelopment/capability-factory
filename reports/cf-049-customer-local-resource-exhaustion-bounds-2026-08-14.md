# CF-049 — customer-local hostile-input and resource-exhaustion bounds

Date: 2026-08-14

Evidence class: private local deterministic development evidence

Network, model calls, paid spend, containers and customer data: none

## Result

CF-049 adds explicit finite resource envelopes across the customer-local onboarding v1.2 journey, durable registry v3, provider work board, CF-048 trust/backup boundary and CF-040 claims replay. Inputs that exceed a declared byte, depth, node, string, collection, durable-history or file-size limit fail closed before the affected state transition.

The shared structural validator measures exact serialized UTF-8 size, not character count. It rejects malformed surrogate sequences, non-finite and non-JSON values, excessive nesting or width, cyclic objects, proxies, accessors, symbol-keyed properties and non-plain objects. The walk is iterative. A path-active `WeakSet` detects cycles immediately while allowing a legitimate acyclic object to be referenced from more than one field. Every own array descriptor is inspected before serialization: only `length` and canonical in-range numeric indexes are accepted, while accessors, `toJSON`, symbol and non-index properties fail closed. The regression confirms a hostile array `toJSON` getter is never invoked.

The HTTP onboarding and provider-board surfaces use a 2,000,000-byte request ceiling. Direct method calls use the same structural preflight, so bypassing HTTP does not bypass the bounded canonicalization path. Error messages are redacted and length-bounded.

Durable cardinality ceilings now cover onboarding evidence/failure collections and events; registry entries, dependencies, events and imports; provider prerequisites, invalidations and events; trust keys, lifecycle events and evidence; backup source metadata; and claims source artifacts. When a durable history reaches its ceiling, the operation rejects with an explicit export-and-linked-successor handoff instead of truncating prior history or silently overwriting evidence.

Backup and claims inputs are bounded before bulk reads. Backup databases are limited individually and as an exact three-file set; raw SHA-256 uses bounded streaming reads. Claims configuration, seal, source count and source-file sizes are preflighted before replay. Relative claim artifact paths must remain within the repository root and source identities must be unique.

## Exact configured ceilings

The central configuration currently sets:

- generic structured input: 2,000,000 serialized UTF-8 bytes, depth 32, 50,000 nodes, 262,144 bytes per string, 2,048 array items and 2,048 object properties;
- onboarding: 128 evidence links, 64 failures, 64 failure resolutions and 10,000 events;
- registry: 256 entries per scope, 64 dependencies, 5,000 events per scope and 2,000,000-byte imported evidence;
- provider board: 14 prerequisites, 512 invalidations per task and 10,000 events;
- trust: 128 keys, 4,096 lifecycle events, 10,000 evidence records and 32 backup source artifacts;
- backup: 1,000,000-byte manifest, 512 MiB per SQLite file and 1,610,612,736 bytes across the three databases; and
- claims replay: 1,000,000-byte configuration, 64,000-byte seal, 256 source artifacts and 128 MiB per pinned source file.

These are implementation limits for this local reference, not load-test results or capacity recommendations.

## Adversarial regression coverage

The deterministic tests cover exact escaped JSON size, deep nesting, oversized arrays and objects, large strings, malformed Unicode, duplicates, direct onboarding/provider canonicalization, cyclic values, repeated non-cyclic references, proxies, non-invoked accessors, redaction, history ceilings, bounded backup metadata, oversized files, and generated hostile inputs. The measured local rejection cases completed below 500 ms; this is a development-machine observation, not a latency SLA or denial-of-service proof.

Final focused verification after the independent-audit corrections: **61 passed / 0 failed** across five files:

- `test/customer-local-resource-bounds.test.ts`
- `test/product-customer-local-onboarding-journey.test.ts`
- `test/durable-family-registry.test.ts`
- `test/customer-local-provider-work-board.test.ts`
- `test/customer-local-trust-backup.test.ts`

The resealed CF-040 v3 claims suite passed **7/7**, including the direct oversized-config/root-escape regression and exact lifecycle-authority substitution rejection. Combined requested verification was **68 passed / 0 failed** across six test files, and strict TypeScript verification was clean.

The whole-suite sandbox run reached **652 passed / 62 loopback-permission failures / 60 skipped**. All 62 failures came from localhost bind denial and passed in a separately authorized rerun of the affected 14 files (**104/104**), yielding an effective **714 passed / 0 product failures / 60 skipped** for that run.

## Independent review findings preserved

Pre-final review found and corrected four important weaknesses:

1. the first cycle check was a placeholder and only stopped a cycle at the node ceiling; it now uses active-path `WeakSet` detection and has a direct cyclic-object regression;
2. ordinary property enumeration could invoke hostile accessors or proxy traps; proxies and accessors now fail closed before value access;
3. backup signing initially bound only raw files and weak row counts; CF-048 now validates exact tenant/environment/configuration and semantic state/head digests for all three databases before signing and again before and after restore; and
4. CF-040 v3 initially accepted an injected lifecycle authority without pinning its identity; the additive v3 configuration and receipt now bind the exact registry trust-configuration digest, key ID, issuer, Ed25519 algorithm, public-key digest and lifecycle/snapshot time bounds.
5. the first final seal still allowed an array-owned `toJSON` accessor, caller-selected restore currentness, and column-only semantic hashes; that seal is superseded. The repaired validator covers every array descriptor, restore requires the exact trust-store clock, and onboarding/registry databases undergo full snapshot, revision, event-chain and current-head validation before signing and after copying.

## CF-040 additive v3 status

The v1 and v2 evidence directories remain untouched. After the subsequent independent audit exposed the three defects above, the earlier v3 seal was superseded. The repaired additive v3 configuration is now pinned to the exact final sources and the digest below is the only current v3 seal.

- configuration SHA-256: `53f835da44537d1f95940acd8a5c1a9496101324cad9717716194cf9c2645153`
- claims implementation SHA-256: `33b6626b9c59a3227fc9e308814eddd35e28d14310eda4ff29df9891009e9047`
- seal digest: `cad3dd7d9a24129352b2a224c9c49062f3c6adda5e0950314689601617118e6d`
- lifecycle trust-configuration digest: `892ee5efeffe54fadade93496ffb1f074e5e8203dd9b4a72779c95c3242406d9`
- lifecycle key identity: `cf047-test-ed25519-v1`, issuer `cf047-test-fixture-issuer`, Ed25519 public-key digest `2ff1538ea7832ead90deba392255c3663ab87b45802f62fdf807ca415b71cfb6`
- lifecycle/snapshot bounds: `86,400,000 ms` maximum lifecycle age and `3,600,000 ms` maximum snapshot TTL

An independent readback recomputed the seal digest, verified every source hash with zero mismatches and confirmed the frozen authority object exactly equals the runtime authority identity. This is immutable local fictional evidence, not an activation credential or customer result.

Key implementation/test digests:

- resource-bounds implementation: `5a8b328280ff5eab4389984c38065030e0b62dda41df4cef108c425ee3023f43`
- resource-bounds test: `3965b0e53945fedf3f442d91d89e32d63b661ed39d453e8f3dd28e90bc7c6e48`
- onboarding full-integrity validator: `6797dc87ed9491dff5966a16ac0d0a35d4f129a32c200a3544e7b1aa1c6a6107`
- registry full-integrity validator: `138e47e98de418a24053b585fb56fdc910597922c317c0d84f23260fadee27c4`
- trust/backup implementation: `c14122156d6cd135dfac6737b85a726ce2ab5b409a719d035acfe96309201deb`
- trust/backup test: `7c1715ba74bcc1ca7d54daa472058efebcebf652e8e2ff96d72ca34948752aae`

## Claim boundary

Supported: the named customer-local reference paths have explicit finite input, history and file limits, deterministic fail-closed regression coverage, and explicit successor handoffs at durable-history ceilings.

Not supported: resistance to sustained hostile traffic, multi-process resource isolation, memory-hard guarantees, production capacity, formal complexity bounds, penetration-test certification, customer deployment, activation authority, universal capability coverage or a formal reliability verdict.
