# Provisional Logistics Transfer Module

Status: **application-aligned development draft — not validated, frozen, or
run**

This module translates the cross-system transfer protocol into the provisional
logistics and supply-chain beachhead. It exists so technical development can
move during the YC-application window without pretending the market has already
been selected.

## 1. Separation of claims

### Confirmed

The current local candidate has repeated narrow feasibility evidence for one
constrained HTTP capability-acquisition loop in a fictional procurement world.

### Hypothesis

Companies deploying action-taking logistics and supply-chain agents may
repeatedly encounter unsupported warehouse, transportation, procurement,
supplier, carrier, or internal customer APIs that delay deployments.

### Unknown

- how often this occurs;
- which systems cause the delays;
- the engineering and commercial cost;
- who owns the budget;
- whether companies would buy rather than build;
- whether connector infrastructure already solves enough of the problem;
- whether a safe pilot can begin quickly; and
- whether the reachable prospect pool is large enough.

The experiment may test technical transfer. It cannot answer these commercial
questions without a corrected census and conversations.

## 2. Plain-English customer story

> A logistics agent is dispatching a packed customer order. It can read the
> order and warehouse record, but it cannot yet use this customer's shipping
> system. It should recognize the missing ability, safely acquire and verify
> the minimum shipping capability, create exactly one test shipment, record the
> result, and finish the dispatch task.

This keeps the magical product behavior: the customer does not diagnose or
request an integration. The agent encounters the boundary while pursuing the
ordinary goal.

## 3. Proposed ordinary goal

> Order SO-1847 is packed and must be dispatched today using a tracked parcel
> service. Create the shipment and one test shipping label, then record the
> carrier, service, tracking number, and label reference in its dispatch
> record. Do not create more than one shipment or label.

The held-out generator changes the order, address, parcel, dates, allowed
services, record identifiers, and custom field identifiers after freeze.

The worker prompt must not mention:

- APIs;
- routes or fields;
- manifests;
- integrations;
- capability creation;
- ShipStation, ShipEngine, Shippo, ERPNext, or another provider by name unless
  the ordinary business context would naturally expose that system name; or
- how to complete the missing step.

## 4. Proposed development environment

### Customer system

Use a local Frappe/ERPNext instance containing fictional:

- customers and addresses;
- items and parcel characteristics;
- warehouses and stock;
- sales orders;
- delivery notes or dispatch records;
- custom carrier, service, tracking, and label-reference fields; and
- roles with full, read-only, and deliberately incomplete permissions.

The agent begins with a trusted installed capability that can read the order and
warehouse state and update only the final dispatch record. It does not begin
with a shipping/rating/label capability.

### Missing system

Use the ShipStation API / ShipEngine sandbox as the first external development
system:

- sandbox API key only;
- sandbox carriers only;
- test rates and labels only;
- fictional but structurally valid addresses;
- no production shipping account;
- no usable label;
- no real payment; and
- no personal or customer data.

Shippo test mode is the current second-system candidate. It must not be treated
as the final held-out transfer platform merely because it is convenient.

## 5. Required autonomous loop

The agent must:

1. Read the ordinary dispatch goal.
2. Inspect the order and warehouse state.
3. Determine that the packed order still lacks shipment and label records.
4. Discover that no installed capability can use the required shipping system.
5. Search the verified registry.
6. Locate the allowed official API documentation.
7. Generate the minimum constrained shipping capability.
8. Pass technical verification using sandbox objects.
9. Install the verified capability.
10. obtain valid test rates or eligible services;
11. create exactly one test shipment and label;
12. write the returned carrier, service, tracking number, and label reference
    to the correct dispatch record;
13. finish the original dispatch goal; and
14. retain the verified capability.

In a fresh session, the agent must find and reuse the retained capability for a
new held-out order rather than rebuild it.

## 6. Minimum capability surface

The generated capability should be no broader than necessary. A likely minimum
is:

- create or validate the shipment input and obtain eligible services/rates;
- create exactly one test label for the selected service; and
- retrieve the resulting shipment/label state if needed for verification or
  safe recovery.

The trusted runtime, not model-generated content, owns:

- host and route allowlists;
- secret injection;
- timeouts and response-size limits;
- redirect policy;
- idempotency/duplicate guards;
- rate limiting;
- trace redaction; and
- the maximum number of repairs and calls.

## 7. Case module

| Case | Logistics setup | Required result |
| --- | --- | --- |
| L0: already dispatched | Correct dispatch fields and one test transaction already exist | Make no new external or ERP write |
| L1: first acquisition | Packed order; no shipping capability or label | Acquire, verify, create one test label, update dispatch, finish |
| L2: fresh-session reuse | New order; L1 capability retained | Reuse without rebuilding and finish |
| L3: transfer acquisition | Same outcome through a materially different held-out system | Acquire, verify, act, update, finish |
| L4: transfer reuse | New held-out order; L3 capability retained | Reuse successfully |
| L5: permission denial | Shipping action is available, but ERPNext dispatch update is read-only or required authority is absent | No partial/duplicate consequential state; precise handoff |
| L6: invalid order | Missing/invalid address, parcel, inventory, or allowed service | No label; identify the exact business fact blocking dispatch |
| L7: lost response/retry | First label response is safely obscured or retryable | Reconcile state and finish with exactly one test label |

L3 must eventually use a system different enough to meet the diversity
requirements in the main protocol. ShipStation and Shippo alone may be too
similar for the final claim.

## 8. Independent outcome verification

The verifier must not ask the worker whether it succeeded.

It should use separate privileged access to check:

- the exact ERPNext sales order and dispatch record;
- the external sandbox shipment or transaction collection;
- one and only one test shipment and label for the order;
- matching fictional recipient, parcel, carrier, service, and tracking values;
- no second label or shipment after retry;
- no unrelated order, stock, customer, or dispatch change;
- correct fresh-session registry reuse;
- no registered capability that failed technical verification; and
- no external write in denial or invalid-order cases.

The verifier should check both systems because a shipping label without the
updated operational record is incomplete, and an updated record without a real
sandbox transaction is false success.

## 9. Important validity risks

1. **This resembles the existing procurement world.** The advance must come
   from real third-party API behavior, real ERP semantics, cross-system state,
   and an unchanged acquisition core—not from relabeling the fictional world.
2. **Shipping aggregators are well documented.** Use held-out records, custom
   ERP fields, different authentication/object models, and eventually a less
   familiar WMS/TMS/private API.
3. **Two aggregators do not prove broad logistics coverage.** ShipStation plus
   Shippo is useful development evidence, not the strongest final transfer
   claim.
4. **Test labels are not real fulfilment.** Describe them accurately.
5. **Tracking events are not simulated in the ShipStation or Shippo test
   environment.** Do not make tracking-progress claims.
6. **External account terms and Joel's eligibility are unresolved.** Review
   before signup.
7. **A technical pass does not validate demand.** The GTM workstream must still
   establish frequency, cost, buyer, willingness to pay, and pilot access.

## 10. Immediate recommendation

For the application window:

1. Use the logistics story as provisional YC positioning.
2. Prepare the ERPNext fixtures and deterministic verifier design without
   spending money or creating external accounts.
3. Treat ShipStation API / ShipEngine sandbox as the first external practice
   candidate because it supports test rates and labels without affecting real
   shipments.
4. Do not freeze or publicly claim a logistics transfer result until the
   selected systems and account eligibility are reviewed.
5. Let the GTM census determine the genuinely representative held-out
   WMS/TMS/ERP or private-system target.
6. Replace this module if another beachhead survives the market gates more
   strongly.
