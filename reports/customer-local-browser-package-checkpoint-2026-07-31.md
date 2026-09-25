# Customer-local browser package checkpoint — 2026-07-31

## Result

The experimental browser driver now runs through an additive customer-local package and the
shared authenticated capability-mode sidecar. This package remains separate from the
constrained-HTTP controlled-pilot installer, so it does not widen HTTP maturity claims.

The package:

- binds only to `127.0.0.1`;
- generates a private sidecar access token;
- copies trusted UI contracts into private customer-local storage and pins their SHA-256 hashes;
- declares credential aliases and their exact target/action/method scopes without putting
  credential values in config;
- reads credential values only from mode-0600 customer-local files;
- keeps browser registry state and the durable capability-mode job queue customer-local;
- rejects missing or unsafe secrets, altered contracts, undeclared aliases, duplicate mode
  registrations, and runtime drivers that do not exactly match the pinned mode/version; and
- exposes the browser driver with its existing `experimental-local` maturity and claim boundary.

## Genuine third-party UI transfer

The opt-in real-browser test used the disposable genuine Gitea 1.27.0 application rather than
the synthetic dealer portal:

1. The package pinned the reviewed Gitea UI contract.
2. Gitea username and password values existed only in the package's private secret directory.
3. The browser driver logged in through the genuine Gitea UI.
4. The first run built the smallest browser capability from the trusted UI contract.
5. It created exactly one fictional issue through the UI.
6. A separate direct Gitea verifier confirmed the expected title/body marker, one intended
   write, and zero incorrect side effects.
7. The disposable Gitea business world was reset while the customer-local capability registry
   remained.
8. A second sidecar job used the retained verified browser capability and again completed with
   one intended write and zero incorrect side effects.
9. A deliberately wrong-password run stopped during pre-use verification and left Gitea state
   unchanged.

## Validation

- Strict TypeScript check passed.
- Customer-local package and shared boundary tests passed: 5/5.
- Genuine Gitea browser suite passed: 3/3, including the new packaged-sidecar route, prior
  build/reuse route, and bad-credential zero-write route.

## Exact evidence boundary

This is local fictional experimental evidence. It is not a customer deployment, a held-out
customer system, general browser compatibility, arbitrary website operation, production
packaging, an external security review, or permission to call browser mode pilot-ready. The
Gitea UI is genuinely different from the synthetic dealer portal and is useful transfer
evidence, but it remains a known disposable development fixture.

## GTM implication

This removes the specific "browser mode cannot be installed or reached through the
customer-local product boundary" blocker. It makes portal-heavy founder conversations and
synthetic proof more credible. It does not remove regulated-data, enterprise access, MFA,
buyer, urgency, willingness-to-pay, or real-workflow blockers.

