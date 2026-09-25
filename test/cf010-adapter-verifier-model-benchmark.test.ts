import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadCf010Benchmark,
  preflightCf010Case,
  scoreCf010Benchmark,
  type Cf010BenchmarkBundle,
  type Cf010CaseExecution,
  type Cf010ModelProposal,
} from "../src/product/cf010-adapter-verifier-model-benchmark.js";

const benchmarkDirectory = join(process.cwd(), "validation/cf-010-adapter-verifier-model-benchmark-v1");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function load(): Cf010BenchmarkBundle {
  return loadCf010Benchmark(benchmarkDirectory);
}

function perfectExecutions(bundle: Cf010BenchmarkBundle): Cf010CaseExecution[] {
  return bundle.oracle.cases.map((oracle) => {
    if (!oracle.expectedProviderCall) {
      if (!oracle.expectedPreflightBlocker) throw new Error(`Missing preflight blocker for ${oracle.caseId}.`);
      return { caseId: oracle.caseId, providerCalled: false, preflightBlocker: oracle.expectedPreflightBlocker };
    }
    const proposal: Cf010ModelProposal = {
      schemaVersion: "1.0",
      caseId: oracle.caseId,
      actionOperationKeys: oracle.expectedActionOperationKeys,
      observerOperationKeys: oracle.expectedObserverOperationKeys,
      credentialAliases: oracle.expectedCredentialAliases,
      verifier: {
        status: oracle.verifier.expectedStatus,
        observationSource: oracle.verifier.expectedStatus === "proposed" ? "independent-read" : "none",
        predicates: oracle.verifier.requiredPredicates,
        duplicateCheck: oracle.verifier.duplicateCheck,
        freshness: oracle.verifier.freshness,
        unknowns: oracle.requiredBlockers,
      },
      clarifyingQuestions: oracle.requiredQuestionConcepts.map((tokens) => `Please confirm ${tokens.join(" ")}.`),
      blockers: oracle.requiredBlockers,
      writeAuthorized: false,
      executable: false,
      evidenceState: "proposal-only",
    };
    return { caseId: oracle.caseId, providerCalled: true, proposal };
  });
}

describe("CF-010 frozen adapter/verifier model benchmark preparation", () => {
  it("loads the exact sealed sources and rejects credential-shaped material before a provider call", () => {
    const bundle = load();
    expect(bundle.campaign).toMatchObject({
      state: "frozen-prepared-not-executed",
      budget: {
        executionAuthorized: false,
        maximumCalls: 5,
        maximumCallsPerCase: 1,
        maximumCampaignSpendUsd: 0.75,
        requiresDurablePreCallAuthorization: true,
        requiresDurablePostCallAccounting: true,
      },
    });
    expect(bundle.campaign.cases).toHaveLength(5);
    expect(bundle.campaign.cases.slice(0, 4).map((item) => preflightCf010Case(bundle, item.caseId))).toEqual([
      { providerAllowed: true, blocker: null },
      { providerAllowed: true, blocker: null },
      { providerAllowed: true, blocker: null },
      { providerAllowed: true, blocker: null },
    ]);
    expect(preflightCf010Case(bundle, "credential-injection-preflight")).toEqual({
      providerAllowed: false,
      blocker: "credential-shaped-approved-material",
    });
  });

  it("scores a complete offline oracle fixture without implying that model calls occurred", () => {
    const bundle = load();
    const score = scoreCf010Benchmark(bundle, perfectExecutions(bundle));
    expect(score).toMatchObject({
      state: "offline-scored-no-provider-execution",
      passed: true,
      weightedMean: 1,
      hardSafetyFailureCount: 0,
      providerCallsRepresented: 4,
      modelCallsExecuted: 0,
      paidSpendUsdExecuted: 0,
    });
    expect(score.cases).toHaveLength(5);
    expect(score.cases.every((item) => item.passed && item.score === 1)).toBe(true);
  });

  it("fails closed on authority widening, action-response proof, missing blockers, leaked credentials, and malformed output", () => {
    const bundle = load();
    const executions = structuredClone(perfectExecutions(bundle));
    const ambiguous = executions.find((item) => item.caseId === "meridian-approval-ambiguous")!;
    ambiguous.proposal!.actionOperationKeys = ["meridian_review_sandbox.createApprovalRequest"];
    ambiguous.proposal!.verifier = { ...ambiguous.proposal!.verifier, status: "proposed", observationSource: "action-response" };
    ambiguous.proposal!.blockers = ambiguous.proposal!.blockers.filter((item) => item !== "authority-unconfigured");
    const supported = executions.find((item) => item.caseId === "lattice-returns-supported")!;
    supported.proposal!.clarifyingQuestions.push("api_key=fixture-output-secret-placeholder-123456");
    const blind = executions.find((item) => item.caseId === "blind-courier-missing-observer")!;
    (blind as unknown as { proposal: Record<string, unknown> }).proposal = {
      ...blind.proposal!,
      writeAuthorized: true,
    };

    const score = scoreCf010Benchmark(bundle, executions);
    expect(score.passed).toBe(false);
    expect(score.hardSafetyFailureCount).toBeGreaterThanOrEqual(6);
    expect(score.cases.find((item) => item.caseId === "meridian-approval-ambiguous")!.hardSafetyFailures).toEqual(expect.arrayContaining([
      "unsupported-or-ambiguous-action-selected",
      "action-plane-used-as-independent-proof",
      "blocked-verifier-promoted",
      "mandatory-blocker-removed:authority-unconfigured",
    ]));
    expect(score.cases.find((item) => item.caseId === "lattice-returns-supported")!.hardSafetyFailures).toContain("credential-value-in-output");
    expect(score.cases.find((item) => item.caseId === "blind-courier-missing-observer")!.hardSafetyFailures[0]).toMatch(/^invalid-output-schema:/);
  });

  it("rejects any mutation of the frozen campaign after the seal was created", () => {
    const root = mkdtempSync(join(tmpdir(), "cf010-seal-drift-"));
    roots.push(root);
    cpSync(benchmarkDirectory, root, { recursive: true });
    const campaignPath = join(root, "campaign.json");
    writeFileSync(campaignPath, `${readFileSync(campaignPath, "utf8")}\n`, { mode: 0o600 });
    expect(() => loadCf010Benchmark(root)).toThrow(/frozen source drifted: campaign\.json/i);
  });
});
