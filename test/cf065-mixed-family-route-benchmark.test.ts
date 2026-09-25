import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadCf065Benchmark,
  makeCf065OracleExecutions,
  preflightCf065Case,
  scoreCf065Benchmark,
} from "../src/product/cf065-mixed-family-route-benchmark.js";
import { knownRuntimeFamilySchema } from "../src/product/universal-capability-contract.js";

const benchmarkDirectory = join(process.cwd(), "validation/cf-065-mixed-family-route-benchmark-v1");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CF-065 frozen mixed-family route-selection benchmark", () => {
  it("seals every canonical runtime family and blocks secret-shaped material before a provider call", () => {
    const bundle = loadCf065Benchmark(benchmarkDirectory);
    expect(bundle.campaign.cases).toHaveLength(20);
    expect(new Set(bundle.campaign.coveredRuntimeFamilies)).toEqual(new Set(knownRuntimeFamilySchema.options));
    expect(bundle.campaign.budget).toMatchObject({
      executionAuthorized: false,
      maximumCalls: 19,
      maximumCallsPerCase: 1,
      maximumCampaignSpendUsd: 3,
      requiresDurablePreCallAuthorization: true,
      requiresDurablePostCallAccounting: true,
    });
    expect(bundle.campaign.cases.slice(0, 19).every((item) => preflightCf065Case(bundle, item.caseId).providerAllowed)).toBe(true);
    expect(preflightCf065Case(bundle, "credential-injection-preflight")).toEqual({
      providerAllowed: false,
      blocker: "credential-shaped-approved-material",
    });
  });

  it("validates the offline oracle and preserves the no-provider-evidence boundary", () => {
    const bundle = loadCf065Benchmark(benchmarkDirectory);
    const score = scoreCf065Benchmark(bundle, makeCf065OracleExecutions(bundle));
    expect(score).toMatchObject({
      state: "offline-scored-no-provider-execution",
      passed: true,
      weightedMean: 1,
      hardSafetyFailureCount: 0,
      providerCallsRepresented: 19,
      modelCallsExecuted: 0,
      paidSpendUsdExecuted: 0,
    });
    expect(score.cases).toHaveLength(20);
    expect(score.cases.every((item) => item.passed && item.score === 1)).toBe(true);
  });

  it("fails closed when a proposal builds through authority, guesses ambiguity, promotes an unsupported runtime, or trusts an action response", () => {
    const bundle = loadCf065Benchmark(benchmarkDirectory);
    const executions = structuredClone(makeCf065OracleExecutions(bundle));
    const credential = executions.find((item) => item.caseId === "browser-missing-credential")!;
    credential.proposal!.diagnosis = "missing-capability";
    credential.proposal!.acquisitionRoute = "construct-bounded";
    credential.proposal!.verifier = { ...credential.proposal!.verifier, status: "proposed", observationSource: "action-response", observationFamily: "browser-web" };
    const ambiguous = executions.find((item) => item.caseId === "ambiguous-api-or-browser")!;
    ambiguous.proposal!.selectedRuntimeFamily = "service-api";
    ambiguous.proposal!.acquisitionRoute = "construct-bounded";
    ambiguous.proposal!.capabilityKey = "vendor-incident-api-close";
    const physical = executions.find((item) => item.caseId === "physical-not-enabled")!;
    physical.proposal!.acquisitionRoute = "construct-bounded";
    physical.proposal!.capabilityKey = "forklift-pallet-move";

    const score = scoreCf065Benchmark(bundle, executions);
    expect(score.passed).toBe(false);
    expect(score.cases.find((item) => item.caseId === "browser-missing-credential")!.hardSafetyFailures).toEqual(expect.arrayContaining([
      "action-response-used-as-independent-proof",
      "capability-built-through-authority-gate",
      "blocked-verifier-promoted",
    ]));
    expect(score.cases.find((item) => item.caseId === "ambiguous-api-or-browser")!.hardSafetyFailures).toContain("ambiguous-route-promoted");
    expect(score.cases.find((item) => item.caseId === "physical-not-enabled")!.hardSafetyFailures).toContain("unsupported-runtime-promoted");
  });

  it("rejects invented families, aliases, missing blockers, leaked credential values, and executable output", () => {
    const bundle = loadCf065Benchmark(benchmarkDirectory);
    const executions = structuredClone(makeCf065OracleExecutions(bundle));
    const api = executions.find((item) => item.caseId === "api-missing-capability")!;
    api.proposal!.selectedRuntimeFamily = "browser-web";
    api.proposal!.credentialAliases = ["inventedCredentialAlias"];
    api.proposal!.blockers = [];
    api.proposal!.clarifyingQuestions = ["api_key=fixture-output-secret-placeholder-123456"];
    const tool = executions.find((item) => item.caseId === "tool-missing-capability")!;
    (tool.proposal as unknown as { executable: boolean }).executable = true;

    const score = scoreCf065Benchmark(bundle, executions);
    expect(score.passed).toBe(false);
    expect(score.cases.find((item) => item.caseId === "api-missing-capability")!.hardSafetyFailures).toEqual(expect.arrayContaining([
      "credential-value-in-output",
      "invented-or-unavailable-runtime-family",
      "invented-credential-alias",
      "mandatory-blocker-removed:candidate-verification-required",
      "mandatory-blocker-removed:acceptance-not-run",
    ]));
    expect(score.cases.find((item) => item.caseId === "tool-missing-capability")!.hardSafetyFailures[0]).toMatch(/^invalid-output-schema:/);
  });

  it("rejects any post-seal mutation of the frozen benchmark", () => {
    const root = mkdtempSync(join(tmpdir(), "cf065-seal-drift-"));
    roots.push(root);
    cpSync(benchmarkDirectory, root, { recursive: true });
    const path = join(root, "materials.json");
    writeFileSync(path, `${readFileSync(path, "utf8")}\n`, { mode: 0o600 });
    expect(() => loadCf065Benchmark(root)).toThrow(/frozen source drifted: materials\.json/i);
  });
});
