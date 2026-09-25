# Product model-to-real-system development report

Status: **private development evidence — not a held-out verdict or public reliability claim**

Date: 2026-07-26 (Asia/Seoul)

## Result in plain English

The latest product-specific model-backed run passed against a genuine disposable local
ERPNext installation.

The run began after the missing ability had already been diagnosed. A model received the
missing-ability description, current customer authority aliases, and detailed synthetic
API documentation. It drafted a constrained declarative HTTP capability—data describing
allowed requests, not executable generated code.

The system then:

1. validated the manifest and customer policy;
2. executed the capability in a disposable real ERPNext case;
3. inspected ERPNext's database directly and required the exact intended state with zero
   incorrect side effects;
4. reset the probe state completely;
5. registered the verified capability;
6. executed the ordinary goal through the shared SDK;
7. independently verified the final ERPNext state;
8. resumed and completed the original goal; and
9. created a fresh SDK/coordinator process that reused the retained capability on a second
   order, again with a correct outcome and completed goal.

The passing run required two model calls: the first response was incomplete and the second
returned a complete structured draft. It cost USD 0.321035.

## Preserved development chronology

| Attempt | Model calls | Cost | Result | What it taught us |
|---|---:|---:|---|---|
| 1 | 2 | USD 0.343725 | Safe verification handoff | The model copied OpenAPI `{name}` literally. The runtime had not rejected unresolved single-brace placeholders. |
| 2 | 3 | USD 0.277825 | Safe verification handoff | The path was repaired, but the deterministic verifier adapter mapped “customer from source Sales Order” to the order ID because its matching precedence was wrong. ERPNext rejected the bad Customer link before creation. |
| 3 | 3 | USD 0.7321075 | Safe build handoff | All high-reasoning drafts exhausted the structured response window before completion. No manifest reached verification. |
| 4 | 2 | USD 0.321035 | Passed build + fresh-process reuse | Medium product-drafting reasoning left enough response budget; the completed draft passed probe, reset, execution, direct outcome verification, resumption, retention, and reuse. |

Cumulative: **10 model calls, USD 1.6746925**. All failed attempts are preserved in ignored
local artifacts. No failed draft was registered or used for an accepted business action.

## General repairs made

- The trusted runtime now rejects unresolved OpenAPI-style single-brace path placeholders
  before any network request.
- The product gateway explicitly requires conversion from `{name}` to
  `{{input.name}}`.
- Independent capability-verification failures can trigger at most two structured
  redrafts. The previous draft and failed checks are supplied; authority and verification
  run again before registration.
- Product drafting uses medium reasoning while the historical frozen evaluation remains
  unchanged at its preregistered high setting.
- The real-system planner maps customer semantics before broader source-order semantics.

These are generic transport, repair-loop, generation-budget, and verifier-adapter fixes;
none hard-codes a specific order ID or copies a successful generated manifest into the
builder.

## What this establishes

- A model can produce the nested declarative request structure needed by this documented
  real ERPNext development world.
- Trusted policy plus a disposable direct-state probe can reject bad drafts before
  registration.
- The shared product core can carry a verified model-drafted capability through external
  action, independent outcome verification, goal resumption, retention, and fresh-process
  reuse in this constrained world.
- The bounded repair path and failure-preservation process work in practice.

## What this does not establish

- autonomous diagnosis of the missing ability from an ordinary goal—the test starts with
  `CapabilityNeed` already supplied;
- transfer to an unfamiliar held-out customer system;
- production security, reliability, latency, or economics;
- real customer demand, buyer authority, willingness to pay, or a locked beachhead;
- browser, arbitrary-code, device, account, human-delegation, or physical capabilities;
- that one post-development success is a formal green verdict; or
- that ERPNext or logistics should define the product or market.

At that checkpoint, the recommended next evidence was either a founder-supplied safe
workflow or a deliberately frozen transfer protocol. Joel subsequently authorized the
same-application confirmation below before autonomous-diagnosis work.

## Later same-application confirmation

A later deliberately frozen confirmation campaign used a materially different procurement
workflow in the same genuine disposable ERPNext installation. The corrected v2 campaign
passed 3/3 model-backed build-and-fresh-process-reuse trials with zero incorrect side
effects and unchanged source hashes. It added 6 paid calls and USD 0.6209390.

The first procurement campaign was invalidated because its verifier required a private
output alias that the documentation did not prescribe; its three final candidates had
already passed creation, update, and direct-state probe checks. The invalid campaign and
its USD 0.9113540 cost remain preserved. See `PROCUREMENT_MODEL_CONFIRMATION_REPORT.md` and
`PROCUREMENT_CONFIRMATION_V1_INVALIDATION.md` for the exact boundary.

Cumulative product-model work is now 26 paid calls and USD 3.2069855. The new confirmation
strengthens repeatability and within-application workflow transfer, but it still does not
establish autonomous diagnosis, cross-product transfer, customer validation, production
reliability, or a formal green verdict.
