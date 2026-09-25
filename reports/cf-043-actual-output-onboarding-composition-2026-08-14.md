# CF-043 — Actual-output onboarding composition gate

Date: 2026-08-14
Evidence class: deterministic, customer-local, fictional development evidence
Spend/network/containers/customer data: none

## Why this checkpoint exists

CF-042 proved that its durable ten-stage journey could persist, resume, invalidate, and export correctly shaped evidence. Its two happy-path journeys nevertheless used hand-authored, fixture-shaped stage payloads. They tested the journey ledger, not whether the real factories' outputs actually fit together.

CF-043 closes that specific evidence gap. It introduces narrow serializable receipt factories for outputs that otherwise contain functions or cryptographic objects, and it drives one fresh fictional system through the real production implementations before attaching their exact receipts to the durable journey.

## Fresh frozen input

The new `Zephyr Crate Dispatch` package is local and fictional. Its source package contains:

- one approved OpenAPI 3.1 document;
- a bounded `POST /dispatches` action and independent `GET /dispatches` observation surface;
- pinned provider-SDK/reference metadata;
- one explicitly reviewed workflow and outcome;
- separate alias-only action and observer credentials;
- explicit synthetic authority answers;
- no credential values or customer data.

The fixture was added after the CF-042 implementation and was not one of CF-042's hand-authored `nova` or `quasar` payloads.

## Exact production chain executed

1. **CF-027** `DurableCleanPackageAuthoringWorkflow` extracted the package facts, asked 32 questions, accepted 32 explicit answers, produced the package draft, and survived reopening its SQLite state.
2. **CF-026** `deriveOnboardingCleanPackage` derived the package, 21-decision preview, binding facts, and clean HTTP declarations. `createCf026PackageImportEvidence` accepted only the exact CF-027 snapshot + exact current derivation + exact 21-decision confirmation.
3. **CF-036** `generateCustomerLocalSdkWorkPack` generated the provider-specific implementation work pack from pinned local SDK metadata and four explicit role reviews.
4. **CF-041** `DurableSdkSemanticDraftWorkflow` asked and recorded all nine semantic decisions, then produced an integrity-bound reviewed contract.
5. **CF-037** `compileSdkSemanticContract` produced acceptance-only, non-executable adapters. `createCf037CompilationEvidence` serialized the exact compiler output without claiming it had passed acceptance.
6. **CF-030** `runCustomerLocalPluginConformance` executed all 21 current customer-local plugin controls and returned a passing receipt with zero failed controls.
7. **CF-029** `provideCf029InputsFromConformantPlugins` exposed only the passing plugin inputs; `qualifyCustomerLocalBindings` then qualified the exact action/observer declarations, separate credential aliases, endpoints, schemas, and probes.
8. **CF-035** the plugin scaffold was deterministically built, released, Ed25519-signed, and signature-verified. `createCf035SignedReleaseEvidence` cannot emit a verified receipt from an invalid signature.
9. **CF-034** `CustomerLocalPluginHost` loaded the exact pinned plugin and produced a conformant, CF-029-usable doctor report.
10. **CF-042 durable journey** attached those outputs in causal order, closed and reopened its SQLite state after CF-041, recorded a restart, attached the downstream independent evidence, and generated readiness only from the exact nine stored artifact digests.

No journey-stage receipt in this new composition test is manually assigned its own digest. The three serialization seams calculate their receipts from verified production outputs, and final readiness is calculated from the stored journey itself.

## Measured result

| Measure | Result |
|---|---:|
| Fresh fictional systems | 1 |
| Extracted CF-027 authoring facts | 5 |
| Explicit CF-027 confirmations | 32 |
| Explicit CF-041 semantic confirmations | 9 |
| CF-030 conformance controls executed | 21 |
| Failed controls | 0 |
| Durable journey restarts | 1 |
| Manual local implementation/config files | 2 code files + 3 bounded config objects |
| Targeted test machine time | about 0.34 seconds for the joined case |
| Incorrect side effects | 0 (no real external action was executed) |
| Customer-production evidence | false |

The two code files are deliberately counted rather than hidden: a type-only declaration shim for the fictional SDK modules and a small engineer-owned completion marker. The bounded metadata, four role reviews, semantic decisions, and explicit authority confirmation are also human/configuration work. CF-043 does not establish zero-touch onboarding.

## Adversarial checks

The joined test additionally confirmed fail-closed behavior for:

- stale package/decision derivation;
- a CF-027 snapshot without completed authority decisions;
- a mutated detached release signature;
- cross-tenant journey reads;
- cross-journey evidence links;
- a customer-local plugin whose source package drifts from the pinned host manifest;
- attempted substitution of a changed release after the completed chain.

Plugin drift produced a quarantined, unusable doctor result rather than being accepted as current proof.

## Narrow reusable seams added

- `createCf026PackageImportEvidence`: derives a serializable CF-026 receipt only from the exact completed CF-027 snapshot, current CF-026 derivation, and exact confirmation.
- `createCf037CompilationEvidence`: serializes only the exact acceptance-only compiler identity; it cannot turn the adapters executable.
- `createCf035SignedReleaseEvidence`: verifies the actual detached Ed25519 signature before emitting a serializable receipt.
- `createOnboardingJourneyReadinessEvidence`: creates final readiness only from the exact complete, unquarantined stored chain through CF-034.

All preserve `executionAuthorityEffect: none` and `activationEffect: none`.

## Strongest accurate claim after CF-043

> One fresh fictional documented HTTP provider has now passed through the actual deterministic CF-027 → CF-026 → CF-036 → CF-041 → CF-037 → CF-030 → CF-029 → CF-035 → CF-034 preparation chain, with the exact outputs persisted through the durable CF-042 journey across a process restart. The chain failed closed on stale, cross-tenant, cross-journey, unsigned, authority-incomplete, and plugin-drifted evidence.

This is stronger than “the journey accepts correctly shaped fixtures.” It is not customer evidence, general provider coverage, production readiness, autonomous SDK implementation, or proof of the ten mandatory business-workflow acceptance cases on Zephyr.

## Remaining blocker

The largest remaining gap to a repeatable under-one-day integration is still engineer-owned provider semantics and independent outcome-observer binding. The actual chain now exposes and preserves that work honestly, but this case still needed explicit SDK role metadata, 32 authoring confirmations, nine semantic confirmations, two small local code files, and three bounded configuration objects. A fresh engineer timing study remains required to establish onboarding time or self-serve usability.

## Verification

- TypeScript: `tsc --noEmit` passed.
- Targeted regression set: 33/33 tests passed across CF-036, CF-037, CF-041, CF-042, and CF-043.
- Focused journey regression: 9/9 tests passed.
- CF-043 joined actual-output case: 1/1 passed, including its adversarial assertions.
