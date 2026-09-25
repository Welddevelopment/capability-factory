# Non-customer hardening protocol — 2026-07-30

Status: **precommitted overnight development protocol**

This pass asks how much additional pilot risk can be removed without pretending that local work replaces a customer. It does not change the product's evidence boundary: Capability Factory remains a working local pilot MVP for constrained HTTP APIs, with fictional/local evidence and no customer-production validation or formal final green verdict.

The criteria below were fixed before the new hardening tests were run. Failures must be preserved in the final report, including failures later corrected.

## 1. Real container execution

Pass only if the pinned customer-local image:

- builds from the tracked Dockerfile and lockfile;
- initializes a fresh mounted state directory;
- starts the packaged sidecar and reports ready;
- runs as a non-root user with a read-only root filesystem, all Linux capabilities dropped, and `no-new-privileges` enabled;
- publishes only to host loopback (`127.0.0.1`);
- keeps secrets out of the image configuration, build history, logs, release manifest, and sanitized evidence; and
- preserves a reproducible image digest in a signed release receipt.

Static policy checks alone do not count as a pass. If the local machine cannot run the image, record that as unverified rather than inferred.

## 2. Clean-room onboarding and lifecycle

Use a new directory outside the repository as if it were a customer machine. Starting from the distributable inputs only, verify:

1. release signature and file/image digests;
2. installation with fresh customer-local secrets;
3. readiness diagnosis with clear next actions;
4. authenticated sidecar startup and one real SDK/client round trip;
5. sanitized evidence export;
6. backup, upgrade, rollback, and restart reconciliation; and
7. deactivation and archive-before-delete uninstall.

Count manual commands and elapsed time. Any undocumented repository dependency, secret copy, unsafe permission change, or source-code edit fails the clean-room criterion.

## 3. Adversarial constrained-HTTP matrix

The hard safety gate is zero unauthorized writes, duplicate writes, false completion signals, or blind retries after an unknown outcome. Exercise at least:

- API-key and bearer authentication;
- missing, expired, rotated, and under-scoped credentials;
- nested request objects and arrays;
- pagination and bounded collection reads;
- redirects and origin changes;
- malformed or oversized responses;
- timeouts, dropped responses, and connection failures;
- structured 4xx errors and transient 5xx/429 responses;
- documented schema drift and undocumented destructive operations;
- idempotent write replay and non-idempotent write refusal; and
- partial, incorrect, and unknown external outcomes.

Unsupported protocol features may remain explicit gaps. They must fail closed with a precise handoff; the pass criterion is not universal HTTP compatibility.

## 4. Security and supply-chain audit

Produce a private threat model and check:

- secret leakage in tracked files, image layers/configuration, logs, exports, and error paths;
- dependency vulnerabilities and production dependency inventory;
- a software bill of materials (SBOM: an inventory of components shipped in the image);
- container user, filesystem, process, capability, and network boundaries;
- tenant isolation and identifier confusion;
- path traversal, symlink, tampering, signature, and rollback attacks;
- request forgery, redirect escape, response exhaustion, and credential exfiltration paths; and
- audit-chain tampering and evidence redaction.

No critical unresolved issue affecting authority, secret containment, tenant isolation, release integrity, or external-outcome safety may be described as passing. Automated scans are not an independent security audit or certification.

## 5. Lifecycle and disaster drills

Preserve and reconcile state across:

- process termination during queued, running, and externally-written-but-unconfirmed states;
- full sidecar restart;
- credential revocation and rotation;
- permission expiration;
- documentation drift and capability quarantine;
- failed upgrade and verified rollback;
- corrupted/truncated backup or state input; and
- unknown external state after a transport failure.

The system must prefer a safe stop over guessing. Recovery must not duplicate a consequential action.

## 6. Performance and stability baseline

This is a development baseline, not an SLA. Measure and record:

- submission and status latency at several concurrency levels;
- throughput and queue behavior under sustained local load;
- memory, CPU, database, event-log, and evidence-export growth;
- multi-tenant isolation under concurrent duplicate/conflicting requests; and
- restart/recovery time with a non-trivial durable queue.

Stop on data corruption, unsafe behavior, unbounded growth, or event loss. Report the machine, runtime, sample size, and test shape so results are reproducible.

## 7. Developer and operator experience

Improve only friction exposed by the rehearsals. The final package should provide:

- a single preflight/doctor entry point with plain-English failure causes and next actions;
- repo-independent installation instructions;
- minimal TypeScript, Python, and raw HTTP examples;
- an explicit customer-input checklist and adapter acceptance command;
- deterministic evidence export and support bundle guidance; and
- a compact troubleshooting decision tree.

Do not polish speculative framework integrations or final customer UI without customer stack evidence.

## 8. Final audit and reporting

Run strict type checking, the ordinary deterministic suite, relevant opt-in real-system groups that are locally available, the clean-room/container suite, and all new hardening tests. Record skipped groups and why. The final report must separate:

- newly verified behavior;
- corrected development failures;
- unresolved technical gaps;
- environmental limitations;
- facts safe for private diligence;
- claims that remain unsafe for public or customer use; and
- work that now has sharply diminishing non-customer returns.

The pass may strengthen confidence in a tightly scoped controlled pilot. It cannot establish demand, buyer urgency, willingness to pay, customer security acceptance, production reliability, or general capability acquisition.
