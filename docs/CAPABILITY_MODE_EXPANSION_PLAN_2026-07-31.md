# Capability-mode expansion decision — 2026-07-31

## Decision

Build adjacent modes aggressively, but keep every mode separate, bounded, reversible, and
honestly labelled. The constrained-HTTP path remains the strongest evidenced pilot MVP. It
is not widened to absorb browser or file behavior.

The immediate order is:

1. **Authenticated browser/portal actions**
2. **Bounded EDI/file-transfer actions**
3. **Inbox/document-triggered workflows**
4. **Trusted package/tool installation**
5. **Direct database actions**

This ranking is about the next useful controlled experiment, not a permanent product
roadmap.

## Why this order

| Mode | Previously screened prospect relevance | Demo/conversation value | Time to a real bounded loop | Safety and verification |
|---|---:|---|---|---|
| Authenticated browser/portal | At least seven named screens were weakened by browser/portal or zero-API operation. This is not a count of buyers. | Very high: it visibly shows the agent crossing a capability boundary without a pre-existing API integration. | Already achieved locally in a distinct Chromium driver. | Medium-high when restricted to one reviewed site, semantic controls, exact network policy and one approved write. |
| EDI/file transfer | Roughly three to five screened logistics/order-entry candidates had a plausible file/EDI-shaped workflow. This is not a reachable-pilot count. | High for ERP, order-entry and logistics founders because the artifact is concrete and independently inspectable. | Short. A first strict X12 850 → canonical order loop was implemented in this branch. | High for local allowlisted roots, one partner contract, one format, one atomic output and a direct outbox verifier. |
| Inbox/document trigger | More companies mention documents or email, but many need ambiguous extraction or communication rather than a narrow deterministic action. | High if the source document is visually understandable. | Medium. Reading is easy; proving the intended business outcome and preventing unsafe sends is not. | Medium-low until document trust, extraction uncertainty, sender authority and irreversible-send policy are designed. |
| Trusted package/tool install | Broad long-term-vision value, but it is less directly tied to the screened first-pilot workflows. | Very high technically. | Medium. Installation itself is easy; trustworthy source selection, isolation and compatibility proof are the product. | Low-medium without a mature sandbox and supply-chain policy. |
| Direct database action | Some systems expose a database before an API, but access usually carries unusually broad authority. | Medium. It can look like generic automation rather than capability acquisition. | Short technically. | Low: least-privilege, schema drift, transaction meaning and independent business verification are harder. |

Voice/device/delegation modes are not next. They either create much more authority risk or do
not reopen enough of the current prospect pool to justify displacing the two modes above.

## Browser checkpoint

The browser path was not rebuilt for this decision because it already has a genuinely
separate experimental mode. On 2026-07-31, its current local Chromium suite was rerun:

- 6 test files passed;
- 37 checks passed;
- it covered construction and retained reuse, broad-goal coordination, missing-authority
  stops, signed continuation, restart recovery, lost-response reconciliation, trusted UI
  discovery, drift replacement, unsafe-page blocking and the ten-case acceptance route.

This supports only an **experimental local browser capability mode**. It does not establish
arbitrary websites, customer deployment, production reliability or a browser pilot.

## File-transfer v0 boundary

The first file mode is intentionally narrow:

- one local disposable fictional trading partner;
- one pinned X12 850 purchase-order contract;
- one allowlisted sender and receiver;
- allowlisted item codes and quantity/line/byte limits;
- one immutable approved `.edi` inbox file;
- one atomic canonical JSON outbox record;
- one exact business approval;
- an independent outbox-state verifier;
- reconciliation before any write and after an uncertain response;
- tenant-separated retained capability records.

It does **not** support general EDI, EDIFACT, XML, arbitrary CSV, SFTP, AS2, VANs, email
attachments, remote partner networks, customer schemas or production operation.

## Commercial use

HTTP outreach should continue. Browser and file-transfer modes can add conversation hooks and
company-specific synthetic demonstrations, but they do not turn previously screened companies
into qualified buyers automatically. Outreach qualification must still establish an urgent
blocked workflow, unwanted engineering overhead, safe access, buyer authority and willingness
to pay.
