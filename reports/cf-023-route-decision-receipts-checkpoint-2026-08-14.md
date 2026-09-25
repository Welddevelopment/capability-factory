# CF-023 tamper-evident route-decision receipts

Date: **2026-08-14**

Status: **passed as deterministic private local evidence; no runtime, customer, production or public claim**

## Result

Capability Factory now emits one deterministic, tamper-evident explanation for
every compiled, precise-handoff and rejected decision in the frozen CF-015
planning benchmark.

Each receipt binds:

- benchmark, registry and CF-015 execution-receipt digests;
- sanitized initial and terminal schema keys plus a digest of the authority
  envelope, never private values;
- maximum search budget, actual CF search expansions, separate candidate
  enumeration expansions and exhaustion state;
- every reachable typed terminal candidate within the bounded enumerator,
  including topology and typed bindings;
- per-candidate tool, independent-verifier and authority gates with stable
  failure codes;
- residual cost, execution-cost proxy and eligibility;
- selected candidate/path and compiled plan digest where applicable;
- stable selection, handoff or rejection reason;
- same-context adaptive-exhaustive and same-tool fixed-policy
  counterfactuals from the frozen CF-015 execution receipt; and
- an integrity digest over the complete explanation.

The generator reads only the frozen `benchmark.json` and the integrity-checked
CF-015 execution receipt. It does not open or copy `oracle.json`, an expected
plan, secret, ordinary-goal text or trusted/private input value.

## Exact receipts

| Goal | Outcome | Candidate routes | CF expansions | Candidate-enumerator expansions | Reason |
| --- | ---: | ---: | ---: | ---: | --- |
| linear aurora archive | compiled | 1 | 3 | 3 | minimum objective |
| fork/join tidal release | compiled | 7 | 8 | 23 | minimum objective |
| minimum-residual comet notice | compiled | 3 | 3 | 5 | minimum objective |
| missing secure authority | precise handoff | 1 | 5 | 3 | authority required |
| unsatisfied abyssal schema | rejected | 0 | 2 | 1 | no typed route |
| disabled unsafe audit | rejected | 1 | 2 | 2 | tool/verifier unavailable |

The minimum-residual receipt preserves all three reachable terminal candidates,
including the higher-residual direct construction, rather than showing only the
winner. The disabled-route receipt preserves the typed candidate while marking
both tool and verifier gates unavailable. The authority receipt preserves the
typed, tool-available and verifier-available candidate while marking exact
authority false. The no-route receipt records an empty candidate set and a
bounded no-typed-route reason.

Internal receipt digests:

- linear:
  `bd2e5310c981cbb98e517d108bcf0be456b8289abe3f00778d9ae50d250c6ca0`
- fork/join:
  `36ed63804aac41b3f349261932281f49b921a9bf6e599e1436ca945d4196ce20`
- minimum residual:
  `6db8fca467f079ff75f149a079cf4bbe3a81878bb54dc924575b9fd5e8c550b0`
- authority handoff:
  `758e0387b886838cd525007005ef421d86285080f05ce0c3963cb3415834e33d`
- no typed route:
  `eea7b54769ad8d808052c91c6b8d88e612aa7ae48f4787068ace09992f8e5e35`
- disabled route:
  `3c000a64fee2f66c494e089b4c5db015b1045b9fcb0b043242411a58da4d8647`

Private receipt directory:
`output/cf-023-route-decision-receipts-v1/`.

## Integrity and adversarial validation

Validation performs two independent checks:

1. it recomputes the outer receipt digest; and
2. it rebuilds the entire decision explanation from the frozen non-oracle
   inputs and requires exact canonical equality.

The second check matters because an attacker could otherwise alter an
explanation and recompute its digest. Tests re-signed manipulated receipts and
still rejected:

- a false reason;
- a missing reason;
- a changed candidate list;
- authority-gate reclassification;
- residual-cost manipulation; and
- added oracle-answer material.

Stable repeat generation produced byte-equivalent structured receipts. Strict
schemas also reject extra fields, and reason codes/details use a closed
deterministic vocabulary.

## Verification

- strict TypeScript typecheck: passed;
- focused CF-023 and CF-015 tests: **10/10 passed across 2/2 files**;
- broader compiler, durable-resolution, artifact, verifier-qualification and
  prior-seal focused suite: **36/36 passed across 8/8 files**;
- `git diff --check`: passed;
- model calls and paid spend: **0 / USD 0**;
- network, containers, external systems, runtime business actions, customers,
  deployment and public action: **0**.

## Boundary

These receipts make one bounded deterministic planner inspectable. They do not
prove the candidate enumerator is complete for large registries, that the
reason vocabulary covers ambiguous real customer semantics, or that a receipt
constitutes independent audit. Counterfactuals are deterministic frozen
benchmark outputs, not new executions or oracle answers. CF-023 deliberately
does not change or claim runtime execution behavior.
