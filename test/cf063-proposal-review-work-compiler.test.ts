import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCf010Benchmark, type Cf010ModelProposal } from "../src/product/cf010-adapter-verifier-model-benchmark.js";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { assertCf063ReviewWorkPackAgainstBenchmark, assertCf063ReviewWorkPackIntegrity, compileCf063ProposalReviewWorkPack, projectCf063OnboardingReview } from "../src/product/cf063-proposal-review-work-compiler.js";

const directory = join(process.cwd(), "validation/cf-010-adapter-verifier-model-benchmark-v1");
const bundle = () => loadCf010Benchmark(directory);
function proposal(caseId: string): Cf010ModelProposal { const source = bundle().oracle.cases.find((item) => item.caseId === caseId)!; return { schemaVersion: "1.0", caseId, actionOperationKeys: [...source.expectedActionOperationKeys], observerOperationKeys: [...source.expectedObserverOperationKeys], credentialAliases: [...source.expectedCredentialAliases], verifier: { status: source.verifier.expectedStatus, observationSource: source.verifier.expectedStatus === "proposed" ? "independent-read" : "none", predicates: [...source.verifier.requiredPredicates], duplicateCheck: source.verifier.duplicateCheck, freshness: source.verifier.freshness, unknowns: [...source.requiredBlockers] }, clarifyingQuestions: source.requiredQuestionConcepts.map((tokens) => `Please confirm ${tokens.join(" ")}.`), blockers: [...source.requiredBlockers], writeAuthorized: false, executable: false, evidenceState: "proposal-only" }; }

describe("CF-063 proposal-to-review-work compiler", () => {
  it("turns a safe supported proposal into a digest-bound review pack without promoting it", () => {
    const source = proposal("lattice-returns-supported"), pack = compileCf063ProposalReviewWorkPack({ benchmarkDirectory: directory, caseId: source.caseId, proposal: source });
    expect(pack).toMatchObject({ readiness: "review-required", executable: false, writeAuthorized: false, activation: "blocked", proposalProvenance: "model-or-provider-proposal-untrusted", benchmarkCasePassed: true });
    expect(pack.tasks).toHaveLength(8); expect(pack.tasks.every((task) => !task.grantsAuthority && !task.countsAsEvidence && task.state === "required-not-complete")).toBe(true);
    expect(pack.mandatoryProductBlockers).toEqual(expect.arrayContaining(["authority-unconfigured", "mandatory-acceptance-not-run", "activation-not-authorized"])); assertCf063ReviewWorkPackIntegrity(pack, source); assertCf063ReviewWorkPackAgainstBenchmark({ benchmarkDirectory: directory, pack, proposal: source });
    expect(projectCf063OnboardingReview(pack)).toMatchObject({ readiness: "review-required", activation: "not-activated", adapterProposalState: "proposal-only", verifierState: "provisional-review-required", authorityState: "blocked", acceptanceState: "not-generated", benchmarkCasePassed: true, sourceWorkPackDigest: pack.workPackDigest });
  });

  it.each(["meridian-approval-ambiguous", "blind-courier-missing-observer"])("preserves %s as a precise blocked review", (caseId) => {
    const source = proposal(caseId), pack = compileCf063ProposalReviewWorkPack({ benchmarkDirectory: directory, caseId, proposal: source });
    expect(pack.readiness).toBe("blocked"); expect(pack.clarifyingQuestions.length).toBeGreaterThan(0); expect(pack.activation).toBe("blocked"); assertCf063ReviewWorkPackIntegrity(pack, source);
  });

  it("rejects an unsafe action-response verifier rather than converting it into review work", () => {
    const source = proposal("lattice-returns-supported"); source.verifier.observationSource = "action-response";
    expect(() => compileCf063ProposalReviewWorkPack({ benchmarkDirectory: directory, caseId: source.caseId, proposal: source })).toThrow(/unsafe proposal|action-plane/i);
  });

  it("rejects source-proposal mutation after compilation", () => {
    const source = proposal("northstar-authority-prose"), pack = compileCf063ProposalReviewWorkPack({ benchmarkDirectory: directory, caseId: source.caseId, proposal: source }); source.blockers.pop();
    expect(() => assertCf063ReviewWorkPackIntegrity(pack, source)).toThrow(/integrity/i);
  });

  it("rejects a valid pack when the pinned benchmark material is replaced", () => {
    const copied = mkdtempSync(join(tmpdir(), "cf063-stale-source-")); cpSync(directory, copied, { recursive: true });
    const source = proposal("lattice-returns-supported"), pack = compileCf063ProposalReviewWorkPack({ benchmarkDirectory: copied, caseId: source.caseId, proposal: source });
    const materialPath = join(copied, "materials", "lattice-returns-openapi.json");
    const material = JSON.parse(readFileSync(materialPath, "utf8")) as Record<string, unknown>; material["title"] = "Substituted after compilation"; writeFileSync(materialPath, JSON.stringify(material));
    expect(() => assertCf063ReviewWorkPackAgainstBenchmark({ benchmarkDirectory: copied, pack, proposal: source })).toThrow(/seal|integrity|stale|source/i);
  });

  it("keeps a safe but incomplete proposal visibly below benchmark pass and onboarding readiness", () => {
    const source = proposal("lattice-returns-supported"); source.clarifyingQuestions = []; source.observerOperationKeys = []; source.credentialAliases = [];
    const pack = compileCf063ProposalReviewWorkPack({ benchmarkDirectory: directory, caseId: source.caseId, proposal: source });
    expect(pack.benchmarkCasePassed).toBe(false);
    expect(projectCf063OnboardingReview(pack)).toMatchObject({ benchmarkCasePassed: false, activation: "not-activated", acceptanceState: "not-generated" });
  });

  it("never permits the credential-preflight case to enter review", () => {
    const source = proposal("credential-injection-preflight");
    expect(() => compileCf063ProposalReviewWorkPack({ benchmarkDirectory: directory, caseId: source.caseId, proposal: source })).toThrow(/preflight-rejected/i);
  });
});
