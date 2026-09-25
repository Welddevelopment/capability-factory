# Controlled-pilot offer and activation packet

Status: **internal template; pricing is an unvalidated hypothesis until a customer agrees**

## One-sentence offer

Give Capability Factory one recent agent deployment delayed by a missing authenticated HTTP
action. We first reproduce the residual safely with fictional data, and only if it works and
still matters commercially do we propose a tightly bounded customer-sandbox pilot.

## Why this offer is narrow

Capability Factory does not offer to automate a company's complete implementation work. The
customer keeps the valuable domain judgment: which workflow matters, what records mean, which
action is allowed, and what “done” means. The pilot tests the residual capability gap after
those facts are known.

## Phase 1 — discovery qualification

Proceed only when the company can identify:

- a recent deployment genuinely blocked by an unsupported/customer-specific HTTP API;
- the exact missing authenticated action;
- material engineering effort, launch delay, lost revenue or customer risk;
- a named technical owner who can judge representativeness; and
- why existing integration infrastructure did not already solve it.

A complimentary answer such as “interesting” is not qualification. If the problem is mainly
browser work, EDI/documents, domain mapping, procurement, security review or a finite standard
connector catalogue, record that honestly rather than forcing an HTTP pilot.

## Phase 2 — synthetic reproduction

Inputs: an abstract ordinary goal, fictional records, trusted documentation or synthetic
equivalent, allowed and forbidden actions, representative authentication shape without live
secrets, direct completion criteria, and baseline time/delay estimates.

Pass requires:

- the original ordinary goal completes;
- the smallest missing capability passes independent verification before use;
- the target system independently shows exactly the intended state;
- zero duplicate, unauthorized, incorrect or collateral writes;
- fresh-process reuse succeeds;
- missing authority produces a precise handoff and zero write; and
- the company confirms the synthetic case resembles the real blocker.

The company receives the predeclared case contract, preserved results and failures, external-
state evidence, intervention/cost record, and a stop/narrow/proceed recommendation.

## Phase 3 — paid customer-sandbox pilot

Enter only after the reproduction is technically successful **and** the buyer still values the
result. The pilot order fixes one workflow, one sandbox, one action boundary, named owners,
local credential custody, acceptance cases, monitoring, deletion, incident handling, price,
termination and publicity rights. Production access is excluded.

### Pricing hypothesis for discussion

- Setup/reproduction/onboarding: **USD 2,000–5,000 one time**.
- Customer-local runtime, verification, health and support: **USD 1,000–3,000 per month**.

These ranges are conversation anchors, not validated prices. Discounting to zero removes the
main buying signal; changing the numbers for a customer must be recorded with the reason.
Revenue should be separated into one-time implementation and genuine recurring product value.

## Default stop conditions

Stop and report when the mechanism is not constrained HTTP, representative safe access cannot
be supplied, success is ambiguous, the scope expands beyond the written action, security
review rejects the boundary, incorrect/duplicate/unauthorized effects occur, external state is
unknown, the customer says the result would not affect a buying decision, or the contracting
path remains unresolved.

## Decision language

- **Discovery-ready:** the pain and mechanism are concrete enough to design a reproduction.
- **Reproduction-ready:** the fictional scope and pass/fail contract are complete.
- **Activation-ready:** all six customer gates, owners, agreed terms, contracting/payment path,
  and customer confirmation of representativeness are present.

`PilotEngagement` in `src/product/pilot-engagement.ts` stores this decision contract and fails
closed. A draft or technically successful reproduction cannot silently become permission to
start a customer sandbox.
