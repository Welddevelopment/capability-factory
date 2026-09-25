# Customer security and data boundary — controlled sandbox

Status: **customer-review template, not a certification, penetration-test report or SLA**

## Architecture in plain English

Capability Factory's supported pilot shape runs beside the customer's agent and sandbox. The
agent sends an ordinary goal to an authenticated localhost sidecar. Trusted customer adapter
code supplies the allowed systems, credential aliases, operations and completion criteria.
The model may propose a bounded plan or declarative capability, but trusted code decides what
is valid and executable.

External credential values remain in the customer-controlled runtime. Requests, plans,
events, evidence exports and model inputs use aliases rather than values. The local sidecar
token authenticates the customer's agent to its own sidecar; it is not a credential for the
target system.

## Data flow

1. Customer agent → localhost sidecar: ordinary goal, stable IDs and trusted scope key.
2. Customer adapter → trusted core: allowed fictional/sandbox entities, actions, authority,
   dependencies and external completion criteria.
3. Optional configured model: only the categories explicitly listed in the pilot security
   profile. Credential values are prohibited.
4. Trusted HTTP runtime → allowlisted sandbox aliases: bounded documented methods, timeouts,
   response limits and redirect blocking.
5. Independent verifier → sandbox source of truth: direct state evidence rather than the
   acting agent's claim.
6. Customer-local stores: validated plans, durable jobs, registry, health history, redacted
   audit and evidence for the agreed retention period.

## Current technical controls

- constrained declarative HTTP manifests; no generated JavaScript or shell execution;
- allowlisted target, credential and method aliases;
- least-privilege write authority and per-action approval where required;
- pre-use capability verification and post-action independent outcome verification;
- stable write idempotency or reconciliation before retry;
- exact signed continuation, live precondition recheck, expiry and customer-local revocation;
- customer-local running, draining and halted modes;
- write/model-spend limits, capability quarantine and redacted incident records;
- private local files, append-only durable job events and hash-chained operational audit;
- pinned adapter runtime and fail-closed package readiness; and
- immutable sanitized evidence export.

## Deliberate sandbox limits

- no production access or personal data;
- localhost control boundary, not a public cloud endpoint;
- no supported browser, arbitrary code, device, physical or account-creation mode;
- no claim of formal certification, penetration testing, cyber insurance or uptime SLA;
- no automatic reversal claim after an incorrect side effect;
- no secret manager/KMS default imposed on the customer adapter; the exact customer-local
  secret provider and key custody must be approved for the pilot; and
- no public disclosure, logo, quote or result without separate written permission.

## Model and subprocessor disclosure

Before a customer sandbox is activation-ready, record the exact provider, model, context
categories, retention/API data-use statement and customer approval. “Provider may change” is
not enough for activation. A model never receives permission merely because it can propose an
action.

## Incident behavior

The customer can halt new actions locally. Lost responses or execution errors trigger direct
state inspection before any retry. Completed state may resume without repeating the action;
not-started state requires the defined review path; partial, incorrect or unknown state is
quarantined and handed to the named incident owners. Mitigation or reversal is a separate
authorized action, never an automatic promise.

## Customer responsibilities

The customer approves the sandbox, scope, owners, credential mechanism, model disclosure,
retention, incident contacts and deletion evidence. The customer must not supply production
secrets, production data or personal data under this sandbox packet.

## Evidence versus assurance

Local tests and evidence show how the reference controls behave under constrained fictional
conditions. They do not substitute for the customer's security review, an independent audit,
penetration testing, certification, insurance, production reliability history or legal/data-
protection terms.

The machine-checked companion is `PilotSecurityProfile` in
`src/product/pilot-security-profile.ts`. It fails activation readiness when model disclosure
or required customer approvals remain pending.
