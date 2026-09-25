# Effective-universality signed-delegation checkpoint — 2026-08-05

Status: private local implementation checkpoint. This does not authorize a customer,
production, open-agent-network, general-delegation, trust, security or universality claim.

## What changed

The eighth enabled architectural route is one bounded agent/digital-service delegation shape:

- the delegate identity, version, Ed25519 public key, allowed task keys, approval, verifier keys
  and timeout are pinned by a recomputed contract hash;
- only an exact preconfigured delegate and exact task key may run;
- a bounded no-action probe must pass first;
- the exact delegation approval must be present;
- prior external state is reconciled before execution;
- the delegate signs a receipt bound to delegate, version, operation, task and canonical input;
- a lost response is reconciled and the signed receipt is recovered without a blind retry;
- the signature proves only who reported completion—it is never accepted as outcome proof;
- a separate read-only observer must prove the real external result and unchanged protected
  state;
- failed signatures, malformed outcome evidence and incorrect side effects quarantine the route;
  and
- verified delegate capability identity is tenant/need/contract bound in a durable local SQLite
  registry and can be reused after a fresh registry process.

## Genuine disposable route

A fictional local shipment delegate wrote one exact shipment draft to a disposable SQLite world,
stored a signed completion receipt, and exposed reconciliation. A separately constructed
read-only observer—not the delegate—verified the exact order, carrier, draft state and unchanged
protected settings.

The following paths were exercised:

- first trusted delegation;
- durable retained reuse on a second operation;
- lost response after commit with receipt recovery and no duplicate;
- missing approval before delegation;
- changed contract and unsupported task rejection;
- unknown prior state with no action;
- forged signed receipt rejection;
- delegate-reported success without independent outcome proof rejection; and
- strict shared mode-router execution.

## Verification completed

- strict TypeScript compilation passed;
- focused signed-delegation tests passed;
- complete-bundle family binding and automatic universal selection passed;
- capability-mode sidecar coverage passed; and
- the full ordinary regression passed **359 active checks across 71 files**, with 59 explicitly
  skipped model/real-system/environment checks unchanged.

No model call, API spend, customer data, external delegate, external account, paid service or
public deployment was used.

## Exact evidence boundary

Demonstrated locally:

- one pinned delegate protocol;
- one signed completion-receipt shape;
- exact task/approval/identity binding;
- reconciliation and no-blind-retry behavior;
- independent external-state verification;
- quarantine; and
- durable retained reuse.

Not demonstrated or claimed:

- autonomous discovery of arbitrary agents or services;
- negotiation, payment, identity creation or authority delegation;
- trust in an unknown delegate;
- network transport security or a production service mesh;
- general remote-agent interoperability;
- customer compatibility or production reliability; or
- that delegation resolves a representative share of real capability gaps.

Human delegation remains a precise handoff path, not autonomous completion. Identity, credential,
approval and legal-authority gaps cannot be manufactured by this runtime.

## Why the remaining families stay disabled

- Native UI needs a genuine accessibility/OS isolation and outcome-observation boundary; browser
  evidence cannot be relabelled as native UI.
- Shell and remote command execution would grant ambient host power without a materially stronger
  sandbox; the import-free WebAssembly route is the current safe compute floor.
- Cloud administration requires scoped real control-plane credentials and consequential external
  validation.
- Identity/account work cannot create missing customer authority.
- Device, IoT and physical action require actual hardware and physical safety controls.

Synthetic wrappers would increase the enabled-family count without making the target more true,
so those families remain planned or future.
