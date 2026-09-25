# CF-053 — provider-transfer evaluation v1/v2 chronology

Date: 2026-08-14  
Result: no valid transfer campaign opened; v1 invalid, v2 blocked prospectively  
Boundary: private fictional deterministic development; zero model calls, spend, external network, customer data, authority, business writes, observer writes, activation, or public claim

## Plain-English result

CF-053 was meant to test whether the hardened CF-051/052 path transferred to two fresh, materially different fictional HTTP providers and stopped safely on a third unsupported provider. No valid campaign was run.

This is the correct result, not a technical success disguised as a partial pass. V1's supported provider inputs changed after the freeze was handed to the runner. V2 correctly froze the corrected bytes, but the provider-neutral executable runner had not been frozen before those cases were visible, and the unchanged CF-052 core cannot honestly satisfy two precommitted outcomes: fresh-process retained reuse and original parent-goal resumption. Adapting the runner after seeing v2 would have turned the allegedly unseen test into another development case.

## V1 — invalidated chronology

The first handed-off v1 seal pinned:

- `grid-curtailment.json`: `932ef063c08e405720b0980afe4f8b42c7fa6aa915f33a61d3e082049df808a7`
- `polar-calibration.json`: `6ca97461ba17d88c86ae64b0843658269a71a6bc54ffdfc8f45fadb71d11eac4`

After handoff, the fixture author corrected each reconciliation method from the action-plane credential alias to the observer-side alias required by CF-052. The resulting bytes were:

- `grid-curtailment.json`: `23fae4d39eefbc9bb5f8d18249bd0a364c2e8038b13280bfeeeda74a3ebac4d3`
- `polar-calibration.json`: `d6630a1a5cc1291caebbc5fed95649cb43927a4f40f17a7e8dca53cc7d59194a`

The runner detected the change and stopped. V1's seal was later rewritten to match the changed bytes, so today's raw-byte preflight passes 5/5. That does not repair the historical order. The original mismatch and exact cause are preserved in `validation/cf-053-frozen-provider-families-v1/INVALIDATED.md` and in v2's independently sealed `FAILED_V1_CHRONOLOGY.md`.

Per-family v1 evidence:

| Family | State | Candidate | Transport | Authority | Business writes | Observer writes |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Polar calibration | Not run | 0 | 0 | 0 | 0 | 0 |
| Grid curtailment | Not run | 0 | 0 | 0 | 0 | 0 |
| Nested freight stop | Not run | 0 | 0 | 0 | 0 | 0 |

## V2 — valid seal, prospectively blocked before provider content opened by the runner

V2 is a separate freeze. The CF-053 preflight read only `freeze-seal.json` and raw file bytes before any provider/oracle parsing or execution. All six sealed files matched exactly:

- `README.md`
- `FAILED_V1_CHRONOLOGY.md`
- `expectations.json`
- `grid-curtailment.json`
- `nested-freight-stop.json`
- `polar-calibration.json`

The campaign still did not open. Four exact blockers were known from the frozen runner/core boundary:

1. No provider-neutral executable transfer runner was frozen before v2's unseen cases were sealed. Completing that runner after opening v2 would violate the prospective no-core-edits rule.
2. The unchanged executable CF-052 local provider uses one fixed `orderRef` field. It does not provide a frozen generic stable-identity and parameter serializer for the two cases' distinct three-field inputs.
3. CF-052 explicitly does not prove provider-process crash recovery or fresh-process retained candidate reuse.
4. CF-052 does not contain a parent-goal coordinator or original-goal resumption receipt, while v2's oracle requires parent resumption.

Per-family v2 evidence:

| Family | State | Provider content opened by runner | Candidate | Transport | Authority | Business writes | Observer writes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Polar calibration | Not run | 0 | 0 | 0 | 0 | 0 | 0 |
| Grid curtailment | Not run | 0 | 0 | 0 | 0 | 0 | 0 |
| Nested freight stop | Not run | 0 | 0 | 0 | 0 | 0 | 0 |

## Code added

`src/product/cf053-provider-transfer-evaluation.ts` adds only the campaign's raw-byte preflight and honest blocked-result projection. It does not parse provider inputs, create a CF-041 source, call CF-051/052, launch a process, mint authority, execute a write, or claim a pass.

`test/cf053-provider-transfer-evaluation.test.ts` verifies:

- current v1 bytes are distinguished from the preserved historical invalidation;
- v1 remains not-run and non-evidence;
- all six v2 raw-byte digests match;
- v2 stops before provider content is opened by the runner;
- no family receives aggregate-hiding synthetic evidence;
- no authority, transport, write, model call or spend occurs.

Focused verification: 3 tests passed.  
Repository TypeScript: `tsc --noEmit` passed.

## Required v3 order

The next valid attempt must reverse the order:

1. Define the exact provider-neutral input schema and supported parameter subset without seeing v3 cases.
2. Build and freeze a generic stable-identity extractor, flat-primitive serializer, action/probe/reconciliation/observer compiler, separate module-owned process launcher, signed exact-input authority binding, independent freshness classifier, durable retained-candidate registry, restart/recovery route, and parent-goal resumption receipt.
3. Freeze all runner and shared-core source hashes plus the exact per-family pass/fail oracle template.
4. Only then have a separate party generate fresh unseen supported families and one unsupported control.
5. Seal those raw bytes without correction after handoff.
6. Run the frozen runner once. Any case incompatibility is a result, not a reason to patch and rerun under the same freeze.

CF-054 source-byte provenance remains separate. Until that work is complete, provider documentation/SDK source bytes remain identity-only rather than independently trusted typed source-byte evidence.

## Strongest accurate conclusion

> CF-053 did not produce cross-provider transfer evidence. It proved that the evaluation boundaries now stop two common ways of manufacturing it: rewriting a seal after a fixture correction, and adapting the transfer runner after unseen cases are visible. A valid v3 requires the provider-neutral runner—including fresh-process reuse and parent resumption—to be frozen before a separate party generates the next cases.
