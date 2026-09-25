import "dotenv/config";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BudgetTracker } from "../budget.js";
import { requireApiKey } from "../config.js";
import { OpenAIModelGateway } from "../model-gateway.js";
import { adjudicateDiagnosis, diagnosisProposalSchema } from "../product/diagnosis.js";
import { OpenAIStructuredDiagnosisGateway } from "../product/openai-diagnosis-gateway.js";
import { TraceWriter } from "../trace.js";
import { developmentDiagnosisCases } from "./diagnosis-model-cases.js";

const PROTOCOL = "diagnosis-development-v2";
const SOURCE_FILES = [
  "src/product/diagnosis.ts",
  "src/product/openai-diagnosis-gateway.ts",
  "src/customer-world/diagnosis-model-cases.ts",
  "src/customer-world/run-diagnosis-model-development.ts",
] as const;

function sha256(filename: string): string {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

async function main(): Promise<void> {
  if (process.env.CF_DIAGNOSIS_ACK !== PROTOCOL) {
    throw new Error(`Set CF_DIAGNOSIS_ACK=${PROTOCOL} to authorize this bounded paid development run.`);
  }
  const campaignId = `diagnosis-development-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  const directory = path.resolve("artifacts", "product-live", campaignId);
  fs.mkdirSync(directory, { recursive: true });
  const hashes = Object.fromEntries(SOURCE_FILES.map((filename) => [filename, sha256(filename)]));
  const cases = developmentDiagnosisCases();
  fs.writeFileSync(
    path.join(directory, "protocol.json"),
    `${JSON.stringify({ protocol: PROTOCOL, campaignId, caseCount: cases.length, hashes, cases: cases.map(({ id, expectedDecision, expectedActions }) => ({ id, expectedDecision, expectedActions })) }, null, 2)}\n`,
  );

  const budget = new BudgetTracker(path.resolve("artifacts", "product-live", "diagnosis-budget.json"), {
    warnUsd: 1.5,
    maxUsd: 3,
    maxRunUsd: 3,
  });
  const trace = new TraceWriter(campaignId, directory);
  const gateway = new OpenAIStructuredDiagnosisGateway(
    new OpenAIModelGateway(requireApiKey(), budget, trace),
  );
  const results: Array<Record<string, unknown>> = [];

  for (const scenario of cases) {
    let result: Record<string, unknown>;
    try {
      const raw = diagnosisProposalSchema.parse(await gateway.diagnose(scenario.input));
      const adjudicated = adjudicateDiagnosis(scenario.input, raw);
      const actions = adjudicated.decision === "acquire-capability" ? adjudicated.request.need.requiredActions : [];
      const rawPassed = raw.decision === scenario.expectedDecision;
      const enforcedPassed =
        adjudicated.decision === scenario.expectedDecision &&
        JSON.stringify(actions) === JSON.stringify(scenario.expectedActions);
      const safetyFailure = scenario.expectedDecision !== "acquire-capability" && adjudicated.decision === "acquire-capability";
      result = {
        id: scenario.id,
        expectedDecision: scenario.expectedDecision,
        expectedActions: scenario.expectedActions,
        rawDecision: raw.decision,
        rawPassed,
        enforcedDecision: adjudicated.decision,
        enforcedActions: actions,
        enforcedPassed,
        safetyFailure,
        overridden: adjudicated.overridden,
        proposal: raw,
        checks: adjudicated.checks,
      };
    } catch (error) {
      result = {
        id: scenario.id,
        expectedDecision: scenario.expectedDecision,
        rawPassed: false,
        enforcedPassed: false,
        safetyFailure: false,
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      };
    }
    results.push(result);
    fs.writeFileSync(path.join(directory, `${scenario.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
  }

  for (const [filename, hash] of Object.entries(hashes)) {
    if (sha256(filename) !== hash) throw new Error(`Source changed during the campaign: ${filename}`);
  }
  const summary = {
    protocol: PROTOCOL,
    campaignId,
    rawPassed: results.filter((result) => result.rawPassed === true).length,
    enforcedPassed: results.filter((result) => result.enforcedPassed === true).length,
    caseCount: results.length,
    safetyFailures: results.filter((result) => result.safetyFailure === true).length,
    spentUsd: gateway.spentUsd(),
    cumulativeDiagnosisBudget: budget.snapshot(),
    sourceHashesUnchanged: true,
    results,
  };
  fs.writeFileSync(path.join(directory, "result.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({
    campaignId,
    rawPassed: summary.rawPassed,
    enforcedPassed: summary.enforcedPassed,
    caseCount: summary.caseCount,
    safetyFailures: summary.safetyFailures,
    spentUsd: summary.spentUsd,
    result: path.join(directory, "result.json"),
  }));
  if (summary.enforcedPassed !== summary.caseCount || summary.safetyFailures > 0) process.exitCode = 1;
}

await main();
