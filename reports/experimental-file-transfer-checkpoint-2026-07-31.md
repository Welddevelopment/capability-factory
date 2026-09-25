# Experimental file-transfer capability checkpoint — 2026-07-31

## Result

A second adjacent capability-mode experiment now completes one bounded fictional file
workflow end to end:

ordinary fulfilment goal → diagnose one missing X12 order-import ability → search the
tenant's retained registry → search a trusted source → construct the minimum capability
from pinned partner metadata → probe it without a business write → require exact approval
→ reconcile outbox state → atomically write one canonical order → independently verify the
outbox → resume the parent goal → retain and reuse the capability in a fresh SDK process.

The mode is implemented separately from the constrained-HTTP and experimental-browser
drivers:

- `src/experimental/file-transfer-driver.ts`
- `src/experimental/file-transfer-capability-sdk.ts`
- `src/experimental/file-transfer-registry.ts`
- `src/customer-world/edi-file-transfer-world.ts`
- `src/customer-world/run-file-transfer-expansion.ts`

## Verified local evidence

Focused deterministic campaign:

- 2 test files passed;
- 11 checks passed;
- zero model or paid API calls;
- no external account, network partner, customer system or public deployment.

The checks cover:

1. no-write disposable capability probe;
2. minimum construction, independent verification, action, parent resumption and retention;
3. fresh-process retained reuse;
4. missing exact approval stopping before a business write;
5. changed input stopping before a business write;
6. untrusted sender and unapproved item stopping before a business write;
7. lost response after commit reconciled as complete;
8. repeated request reconciled without a duplicate output;
9. incorrect pre-existing external state causing quarantine;
10. a plausible but semantically altered order being caught by the independent verifier;
11. an unavailable post-write verifier returning an unknown outcome with one attempted write
    rather than disguising the action as a no-write failure;
12. tenant-separated retained registries;
13. mismatched target aliases and path syntax being refused.

The numbered behaviors overlap within eleven test cases; they are not thirteen statistically
independent reliability trials.

The existing experimental browser mode was also reconfirmed independently on the same date:
6 files and 37 checks passed in genuine local Chromium. That rerun did not alter its historical
evidence or upgrade it to customer/pilot-ready status.

After the focused pass, the ordinary repository regression suite also passed: 50 files and
262 checks passed, with 11 files and 55 opt-in/environment-dependent checks skipped. The
browser checks above were run separately with their real-Chromium opt-in enabled.

## Runnable demonstration

`pnpm demo:file-transfer`

The command creates a new disposable directory, performs one new-capability run, then starts
a fresh SDK process and performs one retained-reuse run with a simulated lost response after
the atomic commit. It prints the acquisition path, verification/resumption events and the
independently read outbox. The disposable evidence root is preserved and printed.

## Exact claim boundary

Supported private development statement:

> A distinct experimental local file-transfer mode can acquire and verify one strict,
> contract-pinned X12 850 order-import capability, create exactly one customer-local canonical
> outbox record, reconcile an uncertain response, resume the original goal and retain the
> capability for fresh-process reuse.

Not supported:

- general EDI or file-transfer support;
- SFTP, AS2, VAN or partner-network operation;
- arbitrary document understanding;
- remote credentials or customer data;
- customer validation;
- pilot readiness for this mode;
- production reliability, security certification or a formal final-green verdict.

## Next gates

The highest-value next gates are:

1. package Chromium and its policy dependencies into the customer-local installation shape;
2. add an explicitly networked but disposable file transport only if it preserves the same
   inbox/outbox authority boundary;
3. add one different file contract or format to test whether the driver boundary generalizes
   without becoming an unsafe universal parser;
4. surface both modes through the existing sidecar/console only after their event contracts
   can remain visibly distinct;
5. let real founder conversations determine which synthetic company-specific workflow is
   worth producing.
