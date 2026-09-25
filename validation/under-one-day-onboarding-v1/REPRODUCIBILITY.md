# Reproducibility

From the repository root:

```bash
node validation/under-one-day-onboarding-v1/verify-kit.mjs
```

The command verifies every participant/evaluator bundle digest and every listed product-source digest. A mismatch is a hard stop; create a new versioned manifest rather than editing evidence from a run.

Before an independent run:

1. Create a clean reviewed product commit.
2. Copy this directory to a new version if any product or bundle file changed.
3. Update the new manifest’s commit and hashes.
4. Run the verifier.
5. Give the participant only `participant/` plus the frozen checkout.
6. Preserve the complete output directory and git diff after submission.

The evaluator should independently rerun typecheck, targeted onboarding tests, bundle verification, and deterministic scoring from the preserved artifacts. Never overwrite a failed or aborted run.
