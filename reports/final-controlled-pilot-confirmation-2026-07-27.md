# Final controlled-pilot local confirmation — 2026-07-27

Status: **passed private unchanged-candidate confirmation**

Candidate commit: `b2e48ee82766547dee1691434b7ed35e357e533a`

## What changed before the freeze

- The console can distinguish acknowledgement from authority: acknowledgement grants nothing.
- An exact durable permission handoff can issue a short-lived customer-local signed continuation bound to the saved plan, work item, handoff digest and state version.
- The console exposes the persistent customer-local runtime modes `running`, `draining` and `halted`, with typed confirmation, reasons and a hash-chained audit.
- The same operational control object is connected to the genuine local ERPNext capability runtime. `halted` is therefore an execution control rather than a display-only setting.
- The pilot stack requires a separate continuation-signing secret rather than reusing the sidecar access token.

## Frozen confirmation protocol

`pnpm pilot:confirm` refused uncommitted source, recorded the exact Git commit, hashed 159 tracked product, console and test files, and then ran five fixed stages:

1. strict TypeScript checking;
2. JavaScript syntax validation for the browser console;
3. the ordinary deterministic suite;
4. all opt-in genuine disposable ERPNext and Gitea suites, serially; and
5. the full zero-model simulated controlled-pilot lifecycle.

The controller rechecked the commit, worktree and every source hash after execution.

## Result

- TypeScript: passed.
- Console JavaScript: passed.
- Ordinary suite: 32/32 active files and 196/196 active tests passed; five files containing 24 opt-in genuine-system tests were skipped in this stage by design.
- Genuine local systems: 5/5 files and 24/24 tests passed.
- The genuine ERPNext stop-control case ended without completion, preserved the exact pre-run external state hash, made zero intended writes and observed zero incorrect side effects.
- Simulated pilot: initial 6/7 with one precise zero-write authority handoff; sidecar restart; signed continuation without replanning; final 7/7 and parent resumption; four correct restocks; zero incorrect side effects; conflicting request rejected; no raw secret persisted; audit chain valid; backup verified; upgrade completed; final lifecycle deactivated.
- Frozen files changed during the campaign: 0.
- Model calls: 0.
- Paid API spend: USD 0.

Private machine-readable evidence is saved under:

`artifacts/final-pilot-confirmation/pilot-confirmation-2026-07-27T08-27-00-317Z-c844db33/confirmation-report.json`

## What this supports

The result supports describing Capability Factory as a working constrained-HTTP MVP that is locally ready to begin a tightly scoped controlled pilot, subject to the named customer's adapter, sandbox, credentials, authority, acceptance and operating agreement.

It does not establish customer validation, production reliability, universal capability acquisition, formal security certification, commercial demand or a formal final green verdict. The historical frozen evaluation record remains unchanged.
