# Private security and supply-chain scan runbook

Status: **repeatable development checks; not an independent security audit**

Run from the repository root against an exact commit. Keep generated reports in a private
artifact directory, not source control. Record tool versions and vulnerability-database time.

## Checks

1. `pnpm audit --prod --audit-level moderate` — registry advisory check for production dependencies.
2. `gitleaks git --redact=100 .` — full-history secret scan. `.gitleaksignore` contains only exact,
   reviewed synthetic historical fingerprints; never add a path-wide exception to make a scan green.
3. Build `packaging/pilot/Dockerfile` from the allowlisted context.
4. Generate an SBOM with Syft in CycloneDX JSON.
5. Scan the exact local image with Grype and retain the JSON report.
6. Inspect the actual running container: effective user, shell absence, root filesystem mode,
   capability drops, `no-new-privileges`, PID limit, mounts and host port bindings.
7. Generate and verify the detached release manifest/signature outside the repository.

## 2026-07-30 development checkpoint

- Gitleaks 8.30.1 scanned 75 commits / approximately 2.83 MB: no unreviewed leaks after 11 exact
  synthetic fingerprints were classified and narrowly ignored.
- The npm production advisory query reported no known vulnerabilities.
- Syft 1.50.0 inventoried 128 components in the shell-free scratch image.
- Grype 0.116.1 reported zero matches using its then-current database.
- Local image content ID: `sha256:bd7b8ff0c1b8c717de9b2912e53e482ef40b2f00343c6a104906fc2e7eb9b680`.
- A private Ed25519 receipt covering 144 complete container/release inputs plus that image ID
  verified successfully. The receipt used a temporary private development key outside the
  repository; it is not a production release authority. A copied earlier receipt with one altered
  field was rejected by the same verifier.
- The image was built and run locally; it was not pushed to a registry or independently signed by
  a production release authority.

These are time-sensitive results. A later advisory database may correctly find new issues in the
same bytes. Re-run all checks before each controlled-pilot release.
