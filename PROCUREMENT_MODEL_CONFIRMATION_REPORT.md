# Procurement model confirmation report

Status: **private development evidence — not a public claim or formal green verdict**

Date: 2026-07-26 (Asia/Seoul)

## Result

The corrected frozen `procurement-model-confirmation-v2` campaign passed **3/3** model-backed
build-and-fresh-process-reuse trials against a genuine disposable local ERPNext 16.29.0
installation. It met the protocol's private **strong confirmation** threshold with zero
incorrect side effects and unchanged frozen source hashes.

This was a materially different workflow from the earlier Sales Order → Delivery Note
development result. The new capability read a submitted Material Request, reconciled by a
unique procurement key, created exactly one correctly linked draft Purchase Order, wrote
the created order reference back to the source Material Request, independently verified
the database outcome, resumed the ordinary goal, retained the capability, and reused it
from a fresh SDK/coordinator process on another request.

## Valid v2 trial results

| Trial | Model calls | Cost | Build | Fresh-process reuse | Incorrect side effects |
|---|---:|---:|---|---|---:|
| A | 2 | USD 0.3235550 | Passed | Passed | 0 |
| B | 1 | USD 0.0691095 | Passed | Passed | 0 |
| C | 3 | USD 0.2282745 | Passed | Passed | 0 |
| **Total** | **6** | **USD 0.6209390** | **3/3** | **3/3** | **0** |

Trial A's first structured response was incomplete at the output-token limit. The existing
bounded draft retry returned a complete candidate on the second call.

Trial B completed on its first model call.

Trial C's first two candidates timed out during the genuine ERPNext disposable probe. The
existing bounded verification-repair loop supplied the exact failed check; the third
candidate increased its action timeouts and passed. There was no human or code change
between trials or repair attempts.

Therefore the strongest supported statement concerns **system-level completion with
bounded automatic repair**, not first-draft reliability. First completed-draft success was
1/3; all three trials completed within the precommitted automatic limits.

## What every passing trial did

1. Started with an empty tenant-scoped capability registry.
2. Gave the model a diagnosed `CapabilityNeed`, current authority aliases, and frozen
   synthetic ERPNext API documentation.
3. Produced a strict declarative HTTP manifest rather than executable generated code.
4. Passed policy and required-action checks.
5. Executed creation, update, reconciliation, and direct-database verification in a
   disposable probe case.
6. Reset the probe state before registration.
7. Registered and used the verified capability on a separate build case.
8. Directly verified the exact external state with two intended writes and zero incorrect
   side effects.
9. Resumed and completed the original procurement goal.
10. Created a fresh SDK/coordinator process and reused the retained capability on a second
    Material Request, again with the exact verified outcome and completed goal.

## Invalid and interrupted campaigns preserved

### V1 harness invalidation

The first frozen procurement campaign printed 0/3 and `safety-failure`, but it is invalid
as a model-performance result. All three final model candidates passed genuine ERPNext
creation, update, and direct-database probe checks. They were rejected only because the
verifier required the arbitrary reference-manifest output alias `matches`; the candidates
validly named the documented `/data` output `purchase_orders`.

The false safety label separately counted an untouched expected `Pending` value after safe
handoff as an incorrect side effect. No candidate was registered and no model-driven
business write was accepted. See `PROCUREMENT_CONFIRMATION_V1_INVALIDATION.md`.

V1 used 10 paid model calls and cost USD 0.9113540. Preserve that cost and its artifacts,
but do not count the campaign as passes or model failures.

### Interrupted no-response v2 attempt

One corrected v2 attempt received no model response because the task/network connection
was interrupted. It recorded USD 0 and no accepted external write. It is infrastructure
interruption evidence, not a model result. A later retry initially aborted before campaign
creation because the local VM was stopped; the preserved VM and containers were restarted,
health checked, and the unchanged v2 protocol was run successfully.

## Cost accounting

- Earlier dispatch model-development chronology: 10 paid calls, USD 1.6746925.
- Invalid v1 procurement harness campaign: 10 paid calls, USD 0.9113540.
- Valid v2 procurement confirmation: 6 paid calls, USD 0.6209390.
- **Cumulative product-model work: 26 paid calls, USD 3.2069855.**

This remained far below the USD 23 requested ceiling and the runner's stricter USD 8
absolute ceiling.

## What this establishes

- The product-specific model-backed acquisition path was not limited to the earlier
  dispatch manifest.
- Under a frozen campaign, three independent empty-registry trials all completed a second
  ERPNext workflow through build, real-system probe, reset, execution, direct outcome
  verification, goal resumption, retention, and fresh-process reuse.
- The bounded automatic draft and verification-repair mechanisms contributed materially:
  they converted one incomplete response and two probe-timeout candidates into safe
  completed trials without human intervention.
- No generated candidate caused an accepted incorrect, collateral, unauthorized, or
  duplicate business action.

## What this does not establish

- autonomous diagnosis from only the ordinary goal—the campaign began after the missing
  ability was supplied;
- transfer to a different software product or unfamiliar held-out customer system;
- production reliability, security, latency, or economics;
- customer demand, willingness to pay, buyer authority, or a locked beachhead;
- support for browser, arbitrary-code, device, account, human-delegation, or physical
  capabilities; or
- a formal final green verdict.

## Next technical step

The highest-value next experiment is autonomous diagnosis: give the agent only an ordinary
goal and existing abilities, require it to distinguish a missing capability from missing
data, credentials, permission, approval, or a transient error, and allow acquisition only
after it produces the minimum justified structured `CapabilityNeed`.
