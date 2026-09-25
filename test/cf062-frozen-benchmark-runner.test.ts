import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BudgetTracker, estimateGpt56SolCost, type UsageRecord } from "../src/budget.js";
import { loadCf010Benchmark, type Cf010BenchmarkBundle, type Cf010ModelProposal } from "../src/product/cf010-adapter-verifier-model-benchmark.js";
import { runCf062FrozenBenchmark, type Cf062ExecutionAuthorization, type Cf062ProposalProvider, type Cf062ProviderInput } from "../src/product/cf062-frozen-benchmark-runner.js";

const benchmarkDirectory = join(process.cwd(), "validation/cf-010-adapter-verifier-model-benchmark-v1");
const roots: string[] = [], budgets: BudgetTracker[] = [];
afterEach(() => { for (const budget of budgets.splice(0)) { try { budget.close(); } catch {} } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
function root(): string { const value = mkdtempSync(join(tmpdir(), "cf062-runner-")); roots.push(value); return value; }
function budget(directory: string): BudgetTracker { const value = new BudgetTracker(join(directory, "budget.json"), { warnUsd: 0.5, maxUsd: 0.75, maxRunUsd: 0.2, maxCalls: 4 }); budgets.push(value); return value; }
function authorization(bundle: Cf010BenchmarkBundle): Cf062ExecutionAuthorization { return { schemaVersion: "1.0", authorizationId: "cf062-test-authorization", campaignId: bundle.campaign.campaignId, sealDigest: bundle.seal.sealDigest, executionAuthorized: true, maximumProviderCalls: 4, maximumSpendUsdPerCall: 0.2, maximumCampaignSpendUsd: 0.75, automaticRetries: false, authorizedAt: "2026-08-14T14:00:00.000Z", authoritySource: "offline test authorization only" }; }
function proposal(bundle: Cf010BenchmarkBundle, caseId: string): Cf010ModelProposal { const item = bundle.oracle.cases.find((candidate) => candidate.caseId === caseId)!; return { schemaVersion: "1.0", caseId, actionOperationKeys: [...item.expectedActionOperationKeys], observerOperationKeys: [...item.expectedObserverOperationKeys], credentialAliases: [...item.expectedCredentialAliases], verifier: { status: item.verifier.expectedStatus, observationSource: item.verifier.expectedStatus === "proposed" ? "independent-read" : "none", predicates: [...item.verifier.requiredPredicates], duplicateCheck: item.verifier.duplicateCheck, freshness: item.verifier.freshness, unknowns: [...item.requiredBlockers] }, clarifyingQuestions: item.requiredQuestionConcepts.map((tokens) => `Please confirm ${tokens.join(" ")}.`), blockers: [...item.requiredBlockers], writeAuthorized: false, executable: false, evidenceState: "proposal-only" }; }

class AccountedProvider implements Cf062ProposalProvider {
  readonly providerId = "offline-accounted-provider"; calls = 0; inputs: Cf062ProviderInput[] = [];
  constructor(private readonly accounting: BudgetTracker, private readonly bundle: Cf010BenchmarkBundle, private readonly mutate?: (value: Cf010ModelProposal) => unknown) {}
  async propose(input: Cf062ProviderInput): Promise<unknown> {
    this.calls += 1; this.inputs.push(structuredClone(input));
    const reservation = this.accounting.reserveModelCall({ seamId: "cf062.offline.provider", attemptKey: `case:${input.caseId}`, requestDigest: sha(JSON.stringify(input)), projectedUsd: 0.01, runSpentUsd: 0 });
    this.accounting.markModelCallDispatched(reservation.reservationId);
    const usage: UsageRecord = { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 };
    this.accounting.settleModelCall(reservation.reservationId, usage, `response-${input.caseId}`, sha(`usage-${input.caseId}`));
    const value = proposal(this.bundle, input.caseId); return this.mutate ? this.mutate(value) : value;
  }
}

describe("CF-062 frozen one-shot benchmark runner", () => {
  it("runs four accounted proposal cases, rejects the credential case before provider use, and writes one immutable receipt", async () => {
    const directory = root(), bundle = loadCf010Benchmark(benchmarkDirectory), accounting = budget(directory), provider = new AccountedProvider(accounting, bundle), resultPath = join(directory, "result.json");
    const result = await runCf062FrozenBenchmark({ benchmarkDirectory, resultPath, authorization: authorization(bundle), provider, accounting });
    expect(result).toMatchObject({ status: "completed", passed: true, providerCallsExecuted: 4, preflightRejectedCases: 1, hardSafetyFailureCount: 0, weightedMean: 1, unresolvedReservations: 0, automaticRetries: 0 });
    expect(provider.calls).toBe(4); expect(provider.inputs.map((item) => item.caseId)).not.toContain("credential-injection-preflight");
    expect(JSON.stringify(provider.inputs)).not.toContain("requiredQuestionConcepts");
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual(result);
    await expect(runCf062FrozenBenchmark({ benchmarkDirectory, resultPath, authorization: authorization(bundle), provider, accounting })).rejects.toThrow(/one-shot/i);
    expect(provider.calls).toBe(4);
  });

  it("settles then hard-aborts on unsafe output without storing the raw proposal or calling later cases", async () => {
    const directory = root(), bundle = loadCf010Benchmark(benchmarkDirectory), accounting = budget(directory), provider = new AccountedProvider(accounting, bundle, (value) => ({ ...value, writeAuthorized: true }));
    const result = await runCf062FrozenBenchmark({ benchmarkDirectory, resultPath: join(directory, "unsafe.json"), authorization: authorization(bundle), provider, accounting });
    expect(result).toMatchObject({ status: "hard-safety-abort", passed: false, providerCallsExecuted: 1, hardSafetyFailureCount: 1, unresolvedReservations: 0 });
    expect(result.cases).toHaveLength(1); expect(result.cases[0]).toMatchObject({ proposalStored: false, proposalDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(result.cases[0]).not.toHaveProperty("proposal"); expect(provider.calls).toBe(1);
  });

  it("stops when a provider returns without one exact accounting transition", async () => {
    const directory = root(), bundle = loadCf010Benchmark(benchmarkDirectory), accounting = budget(directory); let calls = 0;
    const provider: Cf062ProposalProvider = { providerId: "unaccounted-provider", propose: async (input) => { calls += 1; return proposal(bundle, input.caseId); } };
    const result = await runCf062FrozenBenchmark({ benchmarkDirectory, resultPath: join(directory, "unaccounted.json"), authorization: authorization(bundle), provider, accounting });
    expect(result).toMatchObject({ status: "provider-accounting-stop", passed: false, providerCallsExecuted: 0, cases: [], automaticRetries: 0 }); expect(calls).toBe(1);
  });

  it("rejects widened authorization before provider use", async () => {
    const directory = root(), bundle = loadCf010Benchmark(benchmarkDirectory), accounting = budget(directory), provider = new AccountedProvider(accounting, bundle), widened = { ...authorization(bundle), maximumCampaignSpendUsd: 0.76 as 0.75 };
    await expect(runCf062FrozenBenchmark({ benchmarkDirectory, resultPath: join(directory, "invalid.json"), authorization: widened, provider, accounting })).rejects.toThrow(/authorization/i);
    expect(provider.calls).toBe(0); expect(accounting.accountingSnapshot().callsCounted).toBe(0);
  });
});
