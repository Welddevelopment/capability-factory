# Experimental authenticated-inbox checkpoint — 2026-07-31

## Result

A distinct local experimental inbox mode now completes one narrow fictional workflow:

ordinary fulfilment goal → diagnose a missing supplier-email ability → search retained
capabilities → search a trusted source → construct the minimum capability from a pinned
sender/template contract → probe it without a business write → require an exact approval
→ reconcile draft state → create one atomic customer-local draft → independently compare
the draft with the immutable source through a separate parser → resume the parent goal →
retain and reuse the capability in a fresh SDK process.

Implementation:

- `src/experimental/inbox-message-driver.ts`
- `src/experimental/inbox-message-capability-sdk.ts`
- `src/experimental/inbox-message-registry.ts`
- `src/customer-world/inbox-order-world.ts`
- `src/customer-world/run-inbox-message-expansion.ts`

## Exact trust boundary

The workflow does not trust the visible `From:` header by itself. Before action, the source
file hash must match a customer-local trusted-ingress receipt representing an already
authenticated mail-ingress decision. The capability then separately checks the exact sender,
recipient, subject/body binding, template, item allowlist, quantities, size and approval.

Duplicate identity is derived from the immutable RFC 822 `Message-ID`; the caller cannot
choose a second arbitrary operation key for the same message. The source message stays
read-only. The only business write is one draft-order file created atomically.

## Verified evidence

Focused deterministic suite:

- 2 test files passed;
- 12 checks passed;
- zero model or paid API calls;
- no external inbox, provider, account, customer data or deployment.

The checks cover:

1. no-write in-memory capability probing;
2. minimum construction, pre-use verification, one draft, outcome verification and parent resumption;
3. fresh-process retained reuse;
4. missing exact approval stopping before draft creation;
5. lost-response reconciliation;
6. repeated-message duplicate prevention;
7. arbitrary caller-chosen operation identity refusal;
8. missing trusted-ingress receipt refusal;
9. changed message refusal;
10. spoofed sender, subject/body mismatch and multipart/attachment refusal;
11. semantically altered draft detection and quarantine;
12. unavailable post-write verifier preserving an unknown/one-write result;
13. tenant-separated retained registries;
14. mismatched target aliases and path syntax refusal.

The fourteen behaviors overlap within twelve test cases. They are not fourteen statistically
independent reliability trials.

The ordinary repository regression suite then passed 52 files and 274 checks, with 11 files
and 55 opt-in/environment-dependent checks skipped. The previously recorded real-Chromium
37/37 confirmation remains a separate opt-in result.

## Demo

`pnpm demo:inbox-message`

The disposable demonstration performs one new-capability run, then starts a fresh SDK
process and performs retained reuse with a simulated lost response after the atomic draft
commit. It prints every acquisition/resumption event and independently reads the two drafts.

## Supported statement

> A separate experimental local inbox mode can acquire and verify one strict,
> trusted-ingress-backed RFC 822 plain-text supplier-order capability, create exactly one
> independently verified customer-local draft, reconcile an uncertain response, resume the
> original goal and retain the capability for fresh-process reuse.

## Not supported

- general email or arbitrary message understanding;
- live IMAP, Gmail, Outlook, SMTP or provider integration;
- DKIM/SPF verification by Capability Factory itself;
- attachments, PDFs, spreadsheets, OCR or free-form extraction;
- autonomous email sending;
- customer validation, pilot readiness, production reliability or a formal green verdict.
