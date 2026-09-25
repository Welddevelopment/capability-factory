# CF-062 — Frozen benchmark pre-execution gate

Date: 2026-08-14

State: implementation and offline verification complete; provider execution not started because `OPENAI_API_KEY` is unavailable in the current environment

Spend: $0

Model calls: 0

## Ready behavior

The sealed CF-010 campaign now has a one-shot execution path joined to CF-019 durable accounting. Before any provider can run, the runner reloads and verifies the original seven sealed sources, validates a separate exact execution authorization, requires a fresh zero-call ledger and runs all five deterministic preflights. The credential-shaped artifact must be the sole rejected case and never reaches provider input.

The remaining four cases receive only their workflow, approved OpenAPI material, target alias, ordinary-input names, frozen instruction and public output contract. The evaluator-only oracle is never included. Each returned response must correspond to exactly one new settled CF-019 transition. Missing or ambiguous usage, an unaccounted provider, a hard safety failure or a widened authorization stops later cases; no retry exists.

Safe proposals may be retained in the private receipt. A hard-failing raw proposal is not stored verbatim: only its digest and exact scorer failures are retained. The final receipt is written with exclusive-create semantics, so an existing result prevents campaign replay.

## Provider wrapper

The actual wrapper uses `gpt-5.6-sol` with a strict structured proposal schema and a maximum 4,000 output tokens. It cannot return executable or write-authorized state through the schema. CF-019 caps the campaign at four calls, $0.20 per call and $0.75 total. The separate authorization preserves zero automatic retries.

Model traces now also redact credential-shaped strings in both nested structured output and the convenience `output_text` field. This repair was driven by a failing test that proved the first redaction pass still leaked the latter.

## Verification

The focused zero-spend set passed 30/30. It covers clean completion, oracle exclusion, credential preflight, unsafe-output hard abort after settlement, raw-output non-retention, unaccounted-provider stop, authorization widening, one-shot replay rejection, durable ambiguity and missing-usage stops, signed reconciliation, trace redaction and the CF-010 scorer.

The final combined localhost-capable affected regression passed 72/72, and strict TypeScript passed.

## Remaining gate

No API key is currently present in this environment. Therefore no provider call, result score or model-quality claim exists. When credentials become available, the only authorized next command is:

```sh
npm run product:cf062:run
```

It may create at most four provider calls on a fresh ledger. Any partial result, ambiguous charge, hard safety failure or existing receipt ends the campaign without retry.

## Boundary

This remains private fictional benchmark preparation. It is not customer, production, arbitrary-API, activation, universal-capability, demand, public or independent-human evidence.
