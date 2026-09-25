# CF-081 — Unified structured SDK onboarding readiness journey

Date: 2026-08-14  
State: deterministic customer-local journey complete; no binding, customer execution, activation or usability claim

## Purpose

CF-080, CF-079 and CF-078 formed a safe technical chain, but a platform engineer still had to understand and invoke three separate APIs. CF-081 wraps them in one durable customer-local journey and one integrity-bound readiness receipt without collapsing their evidence boundaries.

## Joined journey

`src/product/customer-local-sdk-structured-onboarding.ts` accepts one immutable input containing:

- byte-pinned local normalized SDK metadata;
- its exact expected SHA-256 and reviewed local source location;
- the CF-036 work pack;
- explicit per-parameter schema reviews;
- an integrity-valid CF-041-style base semantic contract;
- the reviewed bounded workflow-input inventory.

The journey then:

1. re-runs CF-080 extraction and validates the exact source/work-pack/review chain;
2. starts or recovers the CF-079 durable decision workflow in the same customer-local SQLite store;
3. exposes the current dependency-ordered questions and blockers through one receipt;
4. accepts answers only against the exact current receipt and underlying snapshot/revision;
5. supports a non-mutating final-review dry run;
6. emits and recompiles the exact CF-078 contract after committed review;
7. stops at `compiled-acceptance-only` with binding, customer-environment acceptance, execution authority and activation all false.

The outer immutable input is digest-checked on every read. The source bytes are re-extracted rather than trusting a stored “source-ready” flag. If a process stops after the outer immutable record but before the inner draft is initialized, read can deterministically reconstruct the exact missing draft from the unchanged input.

## Readiness semantics

The receipt distinguishes:

- source bytes pinned;
- exact schema reviews accepted;
- structured schema index ready;
- structured mappings complete;
- structured contract reviewed;
- acceptance-only compiler completed;
- action/observer binding qualification false;
- customer-environment acceptance false;
- execution authority false;
- activation false.

Once compilation completes, it still exposes three exact blockers: separate action/observer bindings, mandatory customer-local acceptance, and customer execution/activation authority. It cannot be mistaken for a customer-executable package.

Receipt identity is stable for unchanged state: `checkedAt` comes from the underlying durable snapshot rather than making a fresh wall-clock read silently change the receipt digest.

## Fresh fictional exercise

One fresh supplier journey started from the pinned normalized source and showed 12 decisions. Five decisions were recorded, the process closed, and the exact receipt survived restart. The remaining decisions completed, producing a review-ready state. A dry-run final review projected compiled readiness without mutating the stored state. Committed review then produced a content-addressed contract and compiler implementation identity while all execution and activation gates remained false.

## Negative controls

- stale outer receipt use fails before answer delegation;
- immutable outer source/inventory mutation fails digest validation after restart;
- source/schema/review attacks inherit all CF-080 controls;
- dependency, stale-answer and durable-event attacks inherit CF-079 controls;
- recursion, bounds, unions, custom transforms, auth-shaped fields, authority widening and conflated bindings inherit CF-078 controls;
- source bytes containing recognized raw-secret patterns fail before persistence.

## Verification

- Joined CF-078/079/080/081 focused suite: 25/25 passed.
- Strict repository TypeScript: passed.
- `git diff --check`: passed.
- Model calls, network calls, package installs, containers, customer credentials, customer data and spend: none.

## Remaining gaps

- This is an API-level journey. A normal engineer has not used it and no setup-time/clarity result exists.
- The source format is normalized local JSON metadata, not arbitrary SDK/package parsing.
- The CF-041 base semantic review remains a prerequisite rather than being visually merged into the same front-end form.
- Real action and independently authenticated observer bindings, credentials, customer authority, conformance, mandatory acceptance, signed packaging and activation are still separate.
- No customer, value, demand, production or broad-SDK claim follows.

## Strongest accurate claim

Capability Factory now has one restart-safe customer-local journey that takes byte-pinned normalized SDK metadata and explicit reviews through structured schema extraction, dependency-ordered mapping review and bounded acceptance-only compilation, while preserving exact blockers and refusing to imply executable or activated readiness.
