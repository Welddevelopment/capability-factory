# CF-019 — Durable model-call authorization and accounting

Date: 2026-08-14

State: complete local deterministic implementation

Spend: $0

Model calls: 0

## Result

Every current OpenAI-backed Capability Factory call now crosses one durable accounting boundary before provider dispatch. The future model-backed adapter-discovery provider seam is separately joined to the same boundary. No model call was made while implementing or testing it.

The previous budget tracker read a JSON total before a call and wrote usage after a successful response. That left three material gaps: concurrent processes could reserve against stale state; a crash after provider dispatch could leave a charge outside the ledger; and a provider error or response without usage could be retried without first resolving whether the earlier call was charged.

CF-019 replaces that gap with a SQLite-backed state machine:

1. Trusted code computes a digest of the exact provider request.
2. A transaction durably reserves the projected maximum under one immutable policy.
3. The gateway records trusted pre-dispatch trace/observer work. If that local work fails, only the never-dispatched reservation can be cancelled.
4. The reservation is durably marked dispatched immediately before the provider call.
5. A response with integrity-bound token usage settles the exact cost.
6. A provider error, missing usage, invalid accounting or process loss remains unresolved/ambiguous and blocks every later call in that ledger.
7. Ambiguous usage can be cleared as uncharged only by an Ed25519 receipt from the exact reconciliation key pinned into the ledger's original policy. Ledgers without that configured trust have no automatic uncharged-resolution path.

The ledger fixes one unresolved call at a time. It binds campaign and per-call spend ceilings, call count, request digest, seam identity, attempt identity, projected and actual spend, provider response identity, usage evidence, status and timestamps. Policy widening after creation fails. Reservations and transitions have integrity digests; append-only events form a hash chain; each reservation's latest row must match its latest event; and the imported legacy budget baseline has its own integrity digest. The JSON budget file remains only a compatibility mirror of the SQLite source of truth.

## Joined seams

- `OpenAIModelGateway`: every diagnosis, planning, manifest drafting, browser drafting/discovery, worker and evaluation call already routes through this gateway, so those routes now reserve, dispatch and settle through the durable ledger automatically.
- `runAdapterDiscoveryProvider`: a model-backed provider now additionally requires a durable ledger, stable reviewed attempt key, explicit ceiling, provider response identity and integrity-bound token usage. Unsafe proposal output is still charged and settled before trusted validation rejects it; invalid or missing usage remains ambiguous rather than being treated as free.
- Deterministic adapter discovery remains zero-spend and does not create model-call reservations.

The separate console operational model-spend control remains a policy/display control, not a provider seam. It was not relabelled as durable provider accounting.

## Adversarial verification

The new deterministic tests cover:

- reserve → dispatch → settle → restart reconstruction;
- two SQLite clients contending for the same budget;
- duplicate settlement and attempt-key reuse;
- provider failure and response-without-usage ambiguity;
- blocking every later call after ambiguous usage;
- forged versus correctly signed uncharged-reconciliation receipts;
- trusted cancellation only before dispatch;
- policy widening, row mutation and event/baseline integrity;
- charged cost above the reserved ceiling being recorded rather than lost, followed by a hard stop;
- the actual `OpenAIModelGateway` seam with an offline injected provider response;
- the model-backed adapter-discovery seam settling unsafe output before rejecting it;
- adapter-provider failure producing one ambiguous call and no retry.

Strict TypeScript passed. The final combined affected run—including the localhost product and offline harness routes—passed 67/67 checks after the last integrity tightening.

## Failures found and repaired

- The first ambiguity resolver accepted an arbitrary evidence digest. It was replaced with exact policy-pinned Ed25519 reconciliation receipts.
- The first event chain established event ordering but did not cross-check the latest event against the latest reservation row. Exact row/event correspondence is now required.
- The imported legacy budget baseline was policy-pinned but not separately digest-bound. It now has a dedicated integrity digest.
- A pre-dispatch cancellation could have reused the same gateway attempt key. Gateway attempt ordinal is now distinct from dispatched call ordinal.
- Offline scorer language that could imply represented calls were executed had already been removed in CF-010 and remains separate from this ledger.

## Evidence boundary

This is customer-local deterministic accounting infrastructure, not a model-quality result. It does not prove provider billing truth beyond the usage evidence returned through the trusted provider wrapper. The default gateway ledger has no configured billing-reconciliation signing key, so ambiguous calls remain fail-closed. The implementation is one-process-at-a-time SQLite accounting on a cooperative customer-local host; it is not distributed consensus, hostile-local-admin resistance, provider-side idempotency, production operations or customer evidence.

CF-010 remains `frozen-prepared-not-executed`. CF-019 does not itself authorize that campaign, change its $0.75 maximum, or make any paid call.

## Next checkpoint

CF-062 should build the smallest execution wrapper that maps each frozen CF-010 case into the provider contract, checks the credential preflight before reservation, and produces one immutable result receipt. Only then should the four permitted cases be run once under the sealed CF-010 ceiling; no automatic retries are allowed.
