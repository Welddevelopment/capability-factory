# Durable compiled capability-resolution checkpoint

Date: **2026-08-14**

Status: **local deterministic core-frontier checkpoint; no customer or effective-universality claim**

## Investor objection attacked

> “The compiler draws a convincing graph, but the live engine still depends on
> hand-wired execution. Typed artifacts, verification, recovery and parent-goal
> resumption are separate demos rather than one durable causal chain.”

## What changed

The new `DurableCapabilityResolutionExecutor` accepts an integrity-checked
`CompiledCapabilityResolutionPlan` and joins it to customer-local execution.

Before action, it checks:

- exact plan integrity and immutable parent identity;
- primitive and verifier registry digests;
- runtime-family support;
- exact target, action, route-builder, verifier and observation bindings;
- typed input contracts and their allowed sources;
- runtime and aggregate-verifier qualification against the compiled plan; and
- live authority for each work item.

During and after action, it:

- persists job, item and event state in a customer-local durable store;
- passes only typed trusted values or independently verified artifacts between
  work items;
- reconciles any item that was running when a process stopped before deciding
  whether action is safe;
- forbids blind action repetition after restart;
- verifies each external outcome independently before publishing an immutable
  typed artifact;
- retains only externally verified capabilities;
- independently verifies aggregate external state;
- quarantines participating bindings when aggregate state fails; and
- resumes the original parent goal once, reconciling a lost resumption response
  before any second attempt.

## Validation

- strict TypeScript typecheck: **passed**;
- durable resolution executor: **6/6 tests passed**;
- compiler + durable executor + verified artifact suite: **15/15 tests passed**;
- complete two-item typed graph: **passed**;
- mutated plan / unqualified binding / unsupported runtime family pre-action
  rejection: **passed**;
- missing live authority zero-action handoff: **passed**;
- process restart with externally completed action and zero repeat: **passed**;
- lost parent-resumption response reconciled with one resumption: **passed**;
- aggregate collateral-state failure quarantines all participants and does not
  resume parent: **passed**;
- model calls and paid spend: **0 / USD $0**.

## Evidence boundary and next attack

This proves one fictional local compiled graph can traverse the durable core. It
does not establish effective universality, population reliability, production
scale, general verifier quality, or arbitrary runtime-family composition. The
next core attack is verifier-template qualification with mandatory negative
controls, followed by a sealed unfamiliar multi-family graph and restart
campaign.
