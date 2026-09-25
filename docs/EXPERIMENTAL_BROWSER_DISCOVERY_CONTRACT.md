# Experimental browser discovery and repair contract

Status: private local development contract. This does not widen the supported
`constrained-http-api` pilot mode.

## Goal

Move the experimental browser route from “translate a complete trusted UI map”
toward “discover the minimum browser capability inside a customer-approved
boundary,” without giving a model arbitrary browser control.

## Non-negotiable boundary

Discovery receives trusted code/data defining:

- one customer-local target alias and disposable localhost origin;
- exact seed and allowed navigation paths;
- exact allowed network method/path/query/count policies;
- approved ordinary input keys and customer-local secret aliases;
- one exact consequential approval key;
- one independent external-outcome verifier key; and
- an at-most-one-business-write rule.

The model may select only controls and paths observed by the trusted read-only
discoverer. It cannot invent a selector, host, path, credential, approval,
verifier, request, script, or additional write.

## Required sequence

1. Trusted discovery opens only approved paths.
2. Discovery permits GET reads only. A session-auth bootstrap, when separately
   configured, may create a session but cannot perform a business write.
3. Trusted code extracts bounded semantic controls and assigns opaque stable
   control IDs. No input value or credential value enters the snapshot.
4. Human-required gates such as MFA, CAPTCHA, security-key prompts, ambiguous
   single-sign-on, or missing credentials stop with a precise handoff.
5. A planner proposes a workflow using only observed control IDs, approved
   paths, input keys, secret aliases, and the one approval key.
6. Trusted code compiles and validates the proposal into the existing
   `experimental-browser-actions` manifest.
7. The existing browser driver probes the candidate without crossing the
   business-write boundary.
8. Only a clean candidate may be registered and executed.
9. Independent external-state verification, not page text alone, determines
   whether the original goal can resume.
10. Uncertain, partial, incorrect, or policy-escaping outcomes quarantine the
    capability and never cause a blind retry.

## Drift and repair

- Each discovery snapshot has a content hash.
- A changed snapshot hash makes a retained capability ineligible for reuse.
- The old capability is quarantined with a drift reason before replacement.
- Repair creates a new versioned capability ID; it never overwrites the old
  record or silently edits its evidence.
- The replacement must pass the complete pre-use verification again.
- If repair fails, the old capability remains quarantined and the goal stops.

## Multi-page limit

Discovery and execution may use several approved read pages, but one capability
still permits at most one consequential business write. Multiple-write
transactions, compensation, arbitrary cross-origin navigation, downloads,
uploads, dialogs, popups, WebSockets, generated JavaScript, and visual-pixel
guessing remain outside this contract.

## Evidence boundary

Passing this contract can support private local evidence for bounded discovery,
drift detection, repair, authentication handoff, transfer and reuse. It cannot
establish arbitrary-site autonomy, customer deployment, production reliability,
security certification, browser-pilot readiness, or a formal final green
verdict.
