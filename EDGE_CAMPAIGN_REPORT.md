# Current-candidate targeted edge campaign

Date: **2026-07-25**

Status: **5/5 targeted cases passed; 8/8 model-backed runs passed**

This report describes the latest candidate. The earlier Day 7 yellow result
remains preserved as historical evaluation evidence, but it is not treated as
more important than the later development evidence merely because it happened
on an originally planned calendar day.

## Frozen identity and budget

Campaign:
`post-day7-edge-campaign-2026-07-25T14-08-06-855Z`

Freeze commit:
`5033b076443ddc1728c6de81f12c825c96d70555`

The campaign seed was created only after the clean freeze was verified. The
runner checkpointed after every case and enforced a **USD 2** campaign ceiling
through projected-call budget checks.

Actual campaign spend was **USD 1.103730**. It ran from `14:08:06Z` to
`14:12:23Z`.

## Results

| Case | Result | Runs | Cost (USD) | What happened |
| --- | ---: | ---: | ---: | --- |
| API-key build and reuse | Pass | 2/2 | 0.228620 | Built and independently verified a capability using an API-key contract, completed exactly one correct order, then found and reused the saved capability successfully in a fresh session. |
| Bearer build and reuse | Pass | 2/2 | 0.228880 | Repeated the full build and fresh-session reuse loop with bearer authentication and different generated routes and fields. |
| No compatible product | Pass | 1/1 | 0.079345 | Reused the approved acquisition capability, found no suitable product, created no order, and handed off with the exact missing-route context. |
| Missing write permission | Pass | 1/1 | 0.056640 | Reused the capability, surfaced HTTP 403, created no order, and handed off with the required permission and attempted order context. |
| Structured error build and reuse | Pass | 2/2 | 0.510245 | Recovered during capability verification, completed the build case, then surfaced and retried the injected 422 in the fresh session without producing a duplicate order. |

Every verifier check passed. All eight runs recorded **zero incorrect,
duplicate, unauthorised, or collateral side effects**.

## Structured-error detail

The final case deliberately injected a retryable structured 422 response.

During fresh capability creation:

1. the first Factory transport response was incomplete and retried;
2. the next complete manifest reached deterministic verification;
3. the injected 422 caused the write probe to fail safely;
4. the next bounded repair passed the complete verifier; and
5. the worker installed the verified capability and created exactly one correct
   order.

In the fresh session:

1. the worker found and installed the persisted capability;
2. its first order attempt received the injected retryable 422;
3. it retried the action;
4. the second attempt succeeded; and
5. independent state verification observed exactly one correct order and no
   collateral changes.

## Current evidence interpretation

The current candidate now has:

- two consecutive fresh-seed build-and-reuse pairs from the preceding
  post-Day-7 iterations;
- two additional authentication-varied build-and-reuse pairs in this campaign;
- a safe no-product handoff;
- a safe permission-denial handoff;
- a structured-error recovery and fresh-session retry;
- repeated deterministic capability verification;
- repeated persistence and registry reuse; and
- zero incorrect side effects across the entire targeted campaign.

This is strong evidence for the narrow local HTTP feasibility claim. It is
meaningfully more representative of the current candidate than the earlier
single Day 7 result.

It is not yet production-reliability evidence. The campaign still uses one
fictional procurement world and one model family, and eight runs are a small
sample. It does not prove arbitrary integrations, browser actions, account
creation, device control, customer demand, or real-world deployment quality.

## Exact supported claim

> In the current constrained local evaluation candidate, the agent repeatedly
> detected a missing HTTP capability, generated and independently verified the
> integration, completed the requested external action, retained and reused the
> integration in fresh sessions, and stopped safely when a product or write
> permission was unavailable. A targeted five-case campaign passed 5/5 cases
> and 8/8 runs with zero incorrect side effects.

This claim should always remain scoped to the tested local HTTP harness.
