import "dotenv/config";
import { runBaseline } from "./baseline.js";
import { artifactsRoot } from "./config.js";
import {
  runHeldOutSuite,
  runEdgeCampaign,
  runLiveDevelopment,
  runOfflineDevelopment,
  runPostDay7Iteration,
} from "./evaluation.js";
import { createFreezeRecord } from "./freeze.js";
import { generateSanitizedReport } from "./report.js";
import { DEVELOPMENT_CASES, type DevelopmentCaseName } from "./scenario.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "dev") {
    const caseName = option("--case") ?? "cold-shipment";
    if (!DEVELOPMENT_CASES.includes(caseName as DevelopmentCaseName)) {
      throw new Error(`Unknown development case: ${caseName}. Available: ${DEVELOPMENT_CASES.join(", ")}`);
    }
    const live = process.argv.includes("--live");
    if (!live && caseName !== "cold-shipment") {
      throw new Error("Development variations require --live; the offline thin slice is cold-shipment only");
    }
    const summary = live
      ? await runLiveDevelopment(caseName as DevelopmentCaseName)
      : await runOfflineDevelopment();
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (!summary.passed) process.exitCode = 1;
    return;
  }
  if (command === "freeze") {
    process.stdout.write(`${JSON.stringify(createFreezeRecord(artifactsRoot()), null, 2)}\n`);
    return;
  }
  if (command === "heldout") {
    const summary = await runHeldOutSuite(process.argv.includes("--confirmation"));
    process.stdout.write(
      `${JSON.stringify({ suiteId: summary.suiteId, provisionalVerdict: summary.provisionalVerdict, resultCount: summary.results.length }, null, 2)}\n`,
    );
    return;
  }
  if (command === "baseline") {
    const run = option("--run");
    if (!run) throw new Error("eval:baseline requires --run <held-out-suite-id>");
    process.stdout.write(`${JSON.stringify(await runBaseline(run), null, 2)}\n`);
    return;
  }
  if (command === "iterate") {
    const summary = await runPostDay7Iteration();
    process.stdout.write(
      `${JSON.stringify(
        {
          iterationId: summary.iterationId,
          passed: summary.passed,
          resultCount: summary.results.length,
          lockedVerdict: summary.lockedVerdict.colour,
        },
        null,
        2,
      )}\n`,
    );
    if (!summary.passed) process.exitCode = 1;
    return;
  }
  if (command === "edge") {
    const summary = await runEdgeCampaign();
    process.stdout.write(
      `${JSON.stringify(
        {
          campaignId: summary.campaignId,
          passed: summary.passed,
          completedCases: summary.cases.length,
          campaignCostUsd: summary.campaignCostUsd,
          maxCampaignCostUsd: summary.maxCampaignCostUsd,
          lockedVerdict: summary.lockedVerdict.colour,
        },
        null,
        2,
      )}\n`,
    );
    if (!summary.passed) process.exitCode = 1;
    return;
  }
  if (command === "report") {
    const run = option("--run");
    if (!run) throw new Error("eval:report requires --run <id>");
    process.stdout.write(`${generateSanitizedReport(run)}\n`);
    return;
  }
  throw new Error("Usage: dev | freeze | heldout | iterate | edge | baseline | report");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
