# CF-038 seeded/metamorphic mixed-family fault campaign

Date: 2026-08-14

Status: **passed local fictional campaign**

Campaign seal: `abbd527e95435634b2394f41784506bcbc9e28458aa6a857c09a5fe7301be90a`

Result receipt: `19d27bba6aa69df1b3c4e23fbef6f654fea6ac7d6dcd066eae653de020a9613b`

## Outcome

CF-038 added a reproducible state-machine/property campaign over the sealed CF-033 mixed-family broad goal. Every generated case executes the real CF-033 composition and thereby uses the native CF-007 pinned-document, CF-008 signed-message, and CF-009 scoped-database worlds. The campaign does not simulate those family verifiers with coordinator-only shortcuts.

Eight frozen seeds with three variants each produced 24 unique stored schedule digests and 1,187 transitions. The campaign blocked 661 unsafe attempts, accepted 526 safe/idempotent transitions, generated 448 event-prefix counterexamples, exercised 16 explicitly reordered native completions, accepted 48 post-commit duplicate/lost-response reconciliations, survived 166 crash events, activated 24 valid higher-version replacements, and rejected 144 identity mutations at their exact native boundary after route setup.

Across all 24 cases the terminal result was 72 intended writes, zero unauthorized writes, zero cross-family writes, zero blind retries, 24 exact parent resumptions, zero secret leaks, and no modification to the original CF-007/008/009/031/032/033 seals.

## Frozen mutations and schedules

The frozen event alphabet mutates route selection and health, credential continuation, native manifests/proposals/authority/verifier/observer/lifecycle identity, cross-family artifacts and evidence, duplicates and conflicts, crash timing, lost responses, retry policy, aggregate timing/substitution, parent replay/conflict, replacement versioning, and evidence redaction. Seed, variant, maximum length, mandatory event list, and all 12 invariants are frozen in `validation/cf-038-seeded-mixed-family-fault-v1/campaign.json`. Exact schedule digests and aggregate measurements are stored in `result.json`.

Generation uses a deterministic 32-bit LCG. Each schedule is replayed against a fresh durable SQLite coordinator; crash events close and reopen that database. Unsafe reordered native completion is injected before the safe dependency order in alternating variants. The suffix deliberately demonstrates the admissible path: active routes, exact credential continuation, exact document receipt, duplicate/lost-response reconciliation, crash recovery, message and database receipts, higher-version replacement, exact aggregate commit, exactly-once parent resume/replay, and redaction inspection.

Counterexample shrinking is deterministic event-prefix shrinking: the first failing prefix for each fault class in each case is retained in the case receipt. The two pre-freeze defects and their minimal reproductions are preserved in `DISCOVERED_FAILURES.md`.

## Defects found and repaired before freeze

1. The initial coordinator accepted a label-correct but digest-mutated native receipt as the first durable writer. It now pins every work item to the exact CF-033 native receipt digest before any mutation.
2. The initial coordinator could resume a parent from an arbitrary caller-supplied aggregate before aggregate verification. Aggregate completion is now durably committed only after all three exact native receipts, and parent resumption requires that exact committed digest.

## Verification

- CF-038 tests: 5 passed, 0 failed.
- Targeted CF-007/008/009/031/032/033/038 suite: 36 passed, 0 failed across 7 files.
- Full repository suite with loopback permission: 640 passed, 0 failed, 60 skipped across 135 files (123 passed files, 12 skipped files). The first sandboxed pass produced 62 cascading failures from `listen EPERM: operation not permitted 127.0.0.1`; rerunning the identical suite with local-loopback permission passed all executed tests.
- Campaign replayed twice with identical campaign receipt and identical 24 schedule digests.
- Project-wide strict TypeScript check passed after the concurrent SDK semantic-drafting workstream completed its in-progress fix.

## Claim boundary

This is local deterministic fictional fault evidence for one sealed mixed-family goal. It is not a customer workload, production reliability evidence, a universal-family claim, demand evidence, or a formal production-readiness verdict. No model calls, paid spend, external services, network actions, containers, customer data, queue changes, commits, deployments, or public claims occurred.
