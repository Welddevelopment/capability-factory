import {
  makeParityEvidence,
  runtimeFamilyParityProfileSchema,
  type RuntimeFamilyParityProfile,
  type RuntimeFamilyParityRequirement,
} from "./runtime-family-parity.js";

type EvidenceMap = Partial<Record<RuntimeFamilyParityRequirement, { path: string; detail: string }[]>>;

const ref = (path: string, detail: string) => [{ path, detail }];
const commonLoop: EvidenceMap = {
  "complete-capability-bundle": ref("test/universal-capability-coordinator.test.ts", "The shared bundle and coordinator contract is exercised for every enabled family."),
  "ordinary-goal-entry": ref("test/universal-goal-preparation.test.ts", "The caller supplies an ordinary goal without choosing a runtime family."),
  "no-write-pre-use-probe": ref("src/product/effective-universality-development-gate.ts", "The frozen gate includes pre-use verification for the enabled family."),
  "explicit-authority-zero-write-stop": ref("src/product/effective-universality-development-gate.ts", "The frozen gate includes authority checks and safe stops."),
  "independent-external-outcome-observer": ref("test/universal-verifier.test.ts", "Execution and observation are separate contracts."),
  "incorrect-partial-unknown-rejection": ref("test/universal-verifier.test.ts", "Incorrect, partial and unavailable evidence cannot become completion."),
  "fresh-process-retained-reuse": ref("reports/effective-universality-final-local-checkpoint-2026-08-05.md", "Enabled-family routes retain and recover verified capability identity in local development evidence."),
};

const hardening: EvidenceMap = {
  "lost-response-reconciliation": ref("reports/effective-universality-final-local-checkpoint-2026-08-05.md", "Enabled write-capable routes use reconciliation-before-retry where the mode supports a write."),
  "duplicate-safe-operation-identity": ref("reports/effective-universality-final-local-checkpoint-2026-08-05.md", "Stable operation identity and no-blind-retry behavior are covered locally."),
  "quarantine-or-revocation": ref("src/product/effective-universality-development-gate.ts", "Verification failures preserve a non-active capability state."),
};

function profile(
  family: RuntimeFamilyParityProfile["family"],
  currentMode: string,
  evidence: EvidenceMap,
  boundary: string,
): RuntimeFamilyParityProfile {
  return runtimeFamilyParityProfileSchema.parse({
    schemaVersion: "1.0",
    family,
    currentMode,
    assessedAt: "2026-08-12",
    target: "http-reference-quality",
    evidence: makeParityEvidence(evidence),
    claimBoundary: boundary,
  });
}

export const RUNTIME_FAMILY_PARITY_LEDGER_V1: readonly RuntimeFamilyParityProfile[] = [
  profile("service-api", "constrained-http-api", {
    ...commonLoop,
    ...hardening,
    "restart-recovery-without-replanning": ref("reports/fresh-onboarding-http-execution-2026-08-12/joined-execution-report.json", "The joined HTTP acceptance run exercised sidecar restart."),
    "customer-local-package-boundary": ref("docs/CONTROLLED_PILOT_MVP_CONTRACT.md", "The constrained HTTP route is available through the authenticated customer-local sidecar."),
    "executed-ten-case-acceptance": ref("reports/fresh-onboarding-http-execution-2026-08-12/joined-execution-report.json", "A fresh frozen HTTP development world passed the ten mandatory cases."),
    "second-distinct-system-or-contract": ref("reports/cf-onboarding-observer-and-fresh-execution-checkpoint-2026-08-12.md", "The Solstice Maintenance fixture was frozen after the generic observer implementation."),
    "generic-scaffold-or-factory": ref("src/product/outcome-observer-factory.ts", "HTTP onboarding has adapter, authority, observer and acceptance factories."),
  }, "Working local pilot MVP for constrained documented HTTP APIs only; fresh-engineer onboarding remains unvalidated."),
  profile("browser-web", "experimental-browser-actions", {
    ...commonLoop,
    ...hardening,
    "restart-recovery-without-replanning": ref("reports/experimental-browser-pilot-hardening-checkpoint-2026-07-27.md", "Durable browser-sidecar restart recovery was exercised locally."),
    "customer-local-package-boundary": ref("reports/customer-local-browser-package-checkpoint-2026-07-31.md", "The browser driver runs through the additive customer-local package."),
    "executed-ten-case-acceptance": ref("reports/experimental-browser-pilot-hardening-checkpoint-2026-07-27.md", "The separate browser adapter acceptance contract was executed."),
    "second-distinct-system-or-contract": ref("reports/customer-local-browser-package-checkpoint-2026-07-31.md", "Synthetic portal and genuine disposable Gitea UI routes are distinct local systems."),
    "generic-scaffold-or-factory": ref("test/real-browser-discovery.test.ts", "The bounded discovery compiler constructs and repairs a capability from observed semantic controls inside a trusted boundary."),
  }, "Experimental bounded browser actions against pinned UI contracts; no general unfamiliar-site discovery or fresh-engineer onboarding."),
  profile("file-object-edi", "experimental-file-transfer-actions", {
    ...commonLoop,
    ...hardening,
    "customer-local-package-boundary": ref("reports/shared-mode-package-hardening-checkpoint-2026-07-31.md", "The file/EDI driver is exposed through the shared customer-local package."),
    "executed-ten-case-acceptance": ref("test/experimental-file-transfer-pilot-acceptance.test.ts", "A dedicated file/EDI harness executes the ten precommitted safety and durability cases."),
    "restart-recovery-without-replanning": ref("test/experimental-file-transfer-pilot-acceptance.test.ts", "The durable exact job is recovered after a simulated process restart without replanning or duplicate output."),
    "second-distinct-system-or-contract": ref("reports/experimental-file-transfer-checkpoint-2026-07-31.md", "X12 and EDIFACT shapes plus network-shaped transport have local evidence."),
    "generic-scaffold-or-factory": ref("test/file-transfer-adapter-factory.test.ts", "A provider-neutral reviewed-metadata factory proposes and binds both supported file contracts without embedding credentials."),
  }, "Transfer-local evidence for two bounded reviewed file/EDI contracts; general formats, partner networks and fresh-engineer onboarding remain unvalidated."),
  profile("message-event", "experimental-inbox-message-actions", {
    ...commonLoop,
    ...hardening,
    "restart-recovery-without-replanning": ref("reports/authenticated-signed-message-ingress-checkpoint-2026-07-31.md", "Signed ingress receipts survive restart."),
    "customer-local-package-boundary": ref("reports/authenticated-signed-message-ingress-checkpoint-2026-07-31.md", "Signed ingress and jobs share the customer-local sidecar boundary."),
  }, "Experimental signed local message ingress; no provider transfer, generic message adapter factory or complete ten-case parity campaign."),
  profile("document-media", "experimental-document-actions", {
    ...commonLoop,
    ...hardening,
    "customer-local-package-boundary": ref("reports/second-machine-readable-document-layout-checkpoint-2026-07-31.md", "The v2 route completed through the shared customer-local package and sidecar."),
    "second-distinct-system-or-contract": ref("reports/second-machine-readable-document-layout-checkpoint-2026-07-31.md", "Two incompatible pinned machine-readable PDF layouts are exercised."),
  }, "Experimental pinned machine-readable PDF layouts; no unknown-layout, OCR, generic contract factory or complete ten-case package/restart campaign."),
  profile("database-query", "experimental-database-actions", {
    ...commonLoop,
    ...hardening,
    "second-distinct-system-or-contract": ref("test/experimental-database-real-sqlite.test.ts", "Fake reviewed adapter and genuine disposable SQLite exercise separate implementations."),
  }, "Experimental reviewed database operation; packaging, restart job recovery, ten-case acceptance and generic operation scaffolding remain missing."),
  profile("trusted-tool-code", "experimental-trusted-tool-actions", {
    ...commonLoop,
    "quarantine-or-revocation": ref("reports/effective-universality-trusted-tool-checkpoint-2026-08-05.md", "Failed outcome verification quarantines the tool capability."),
  }, "Experimental import-free pinned WebAssembly compute; no general tool synthesis, package installation, broad I/O, parity campaign or customer-local onboarding validation."),
  profile("agent-service-delegation", "experimental-agent-delegation-actions", {
    ...commonLoop,
    ...hardening,
    "second-distinct-system-or-contract": ref("test/experimental-agent-delegation.test.ts", "The local delegate route includes genuine signed receipt and separate observer implementations."),
  }, "Experimental pinned signed local delegate; no discovery, negotiation, network trust, package parity campaign or fresh-engineer onboarding."),
] as const;
