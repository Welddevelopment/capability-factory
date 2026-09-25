import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BudgetTracker } from "../budget.js";
import { requireApiKey } from "../config.js";
import { OpenAIModelGateway } from "../model-gateway.js";
import { TraceWriter } from "../trace.js";
import { runCf062FrozenBenchmark, type Cf062ExecutionAuthorization } from "./cf062-frozen-benchmark-runner.js";
import { Cf062OpenAIProposalProvider } from "./cf062-openai-proposal-provider.js";

const benchmarkDirectory = resolve(process.env.CF062_BENCHMARK_DIR ?? "validation/cf-010-adapter-verifier-model-benchmark-v1");
const outputDirectory = resolve(process.env.CF062_OUTPUT_DIR ?? "artifacts/cf062-frozen-benchmark-v1");
const authorizationPath = join(benchmarkDirectory, "cf062-execution-authorization.json");
const authorization = JSON.parse(readFileSync(authorizationPath, "utf8")) as Cf062ExecutionAuthorization;
const budget = new BudgetTracker(join(outputDirectory, "budget.json"), {
  warnUsd: 0.5,
  maxUsd: 0.75,
  maxRunUsd: 0.2,
  maxCalls: 4,
});

try {
  const gateway = new OpenAIModelGateway(requireApiKey(), budget, new TraceWriter("cf062-frozen-benchmark-v1", join(outputDirectory, "trace")));
  const result = await runCf062FrozenBenchmark({
    benchmarkDirectory,
    resultPath: join(outputDirectory, "result.json"),
    authorization,
    provider: new Cf062OpenAIProposalProvider(gateway),
    accounting: budget,
  });
  console.log(JSON.stringify({
    status: result.status,
    passed: result.passed,
    providerCallsExecuted: result.providerCallsExecuted,
    preflightRejectedCases: result.preflightRejectedCases,
    settledSpendUsd: result.settledSpendUsd,
    unresolvedReservations: result.unresolvedReservations,
    hardSafetyFailureCount: result.hardSafetyFailureCount,
    weightedMean: result.weightedMean,
    receiptDigest: result.receiptDigest,
  }, null, 2));
} finally {
  budget.close();
}
