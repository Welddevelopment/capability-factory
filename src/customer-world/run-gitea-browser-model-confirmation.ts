import "dotenv/config";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BudgetTracker } from "../budget.js";
import { requireApiKey } from "../config.js";
import { OpenAIModelGateway } from "../model-gateway.js";
import { TraceWriter } from "../trace.js";
import {
  StructuredModelBrowserCapabilityBuilder,
  type BrowserCapabilityModelDraftGateway,
} from "../experimental/model-browser-capability-builder.js";
import { OpenAIStructuredBrowserCapabilityGateway } from "../experimental/openai-browser-capability-gateway.js";
import type { BrowserCapabilityBuilder } from "../experimental/browser-ui-contract.js";
import { startRealGiteaWorld } from "./real-gitea-world.js";
import {
  REAL_GITEA_BROWSER_UI_CONTRACT,
  RealGiteaBrowserWorld,
} from "./real-gitea-browser-world.js";

const PROTOCOL = "gitea-browser-model-confirmation-v1";
const FROZEN_FILES = [
  "src/config.ts",
  "src/model-gateway.ts",
  "src/experimental/browser-driver.ts",
  "src/experimental/browser-capability-sdk.ts",
  "src/experimental/browser-registry.ts",
  "src/experimental/browser-ui-contract.ts",
  "src/experimental/model-browser-capability-builder.ts",
  "src/experimental/openai-browser-capability-gateway.ts",
  "src/experimental/playwright-browser-session.ts",
  "src/customer-world/real-gitea-world.ts",
  "src/customer-world/real-gitea-browser-world.ts",
  "src/customer-world/run-gitea-browser-model-confirmation.ts",
] as const;

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function sha256(filename: string): string {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

class CountingGateway implements BrowserCapabilityModelDraftGateway {
  calls = 0;

  constructor(private readonly underlying: OpenAIStructuredBrowserCapabilityGateway) {}

  get modelLabel(): string {
    return this.underlying.modelLabel;
  }

  async draft(input: Parameters<BrowserCapabilityModelDraftGateway["draft"]>[0]) {
    this.calls += 1;
    return this.underlying.draft(input);
  }

  spentUsd(): number {
    return this.underlying.spentUsd();
  }
}

class ForbiddenReuseBuilder implements BrowserCapabilityBuilder {
  readonly builderId = "forbidden-reuse-builder";
  calls = 0;
  async build(): Promise<null> {
    this.calls += 1;
    throw new Error("Fresh-process retained reuse unexpectedly called the builder.");
  }
}

async function main(): Promise<void> {
  if (process.env.CF_GITEA_BROWSER_MODEL_CONFIRM_ACK !== PROTOCOL) {
    throw new Error(`Set CF_GITEA_BROWSER_MODEL_CONFIRM_ACK=${PROTOCOL} to authorize this bounded paid confirmation.`);
  }
  const startingCommit = git("rev-parse", "HEAD");
  if (git("status", "--porcelain", "--untracked-files=no") !== "") {
    throw new Error("Tracked source must be clean before the Gitea browser model confirmation freeze.");
  }
  const campaignId = `${PROTOCOL}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  const directory = path.resolve("artifacts", "gitea-browser-model-confirmation", campaignId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const sourceHashes = Object.fromEntries(FROZEN_FILES.map((filename) => [filename, sha256(filename)]));
  const freeze = {
    protocol: PROTOCOL,
    campaignId,
    gitCommit: startingCommit,
    frozenAt: new Date().toISOString(),
    model: "gpt-5.6-sol",
    reasoning: "low",
    successRule: "One model-backed capability is constrained to a hashed trusted Gitea UI contract, passes a non-business-write browser probe, creates exactly one independently verified issue, and is reused by a fresh SDK process without another model call or incorrect side effect.",
    maximumPaidCalls: 2,
    spendCeilingUsd: 2,
    sourceHashes,
    evidenceBoundary: "Private local transfer evidence against a genuine disposable Gitea UI. It does not demonstrate arbitrary-site discovery, general browser support, customer validation, production reliability or a formal final green verdict.",
  };
  fs.writeFileSync(path.join(directory, "campaign-freeze.json"), `${JSON.stringify(freeze, null, 2)}\n`, { mode: 0o600 });
  if (process.env.CF_GITEA_BROWSER_MODEL_CONFIRM_DRY_RUN === "1") {
    console.log(JSON.stringify({ campaignId, dryRun: true, freeze: path.join(directory, "campaign-freeze.json") }));
    return;
  }

  const budget = new BudgetTracker(path.join(directory, "budget.json"), {
    warnUsd: 1,
    maxUsd: 2,
    maxRunUsd: 2,
  });
  const model = new OpenAIModelGateway(
    requireApiKey(),
    budget,
    new TraceWriter("gitea-browser-model", path.join(directory, "trace")),
  );
  const gateway = new CountingGateway(new OpenAIStructuredBrowserCapabilityGateway(model));
  const modelBuilder = new StructuredModelBrowserCapabilityBuilder(
    gateway,
    [REAL_GITEA_BROWSER_UI_CONTRACT],
    2,
  );
  const world = await startRealGiteaWorld({
    repositoryRoot: process.cwd(),
    artifactDirectory: path.join(directory, "gitea"),
  });
  const registryDirectory = path.join(directory, "browser-candidate");
  let result: Record<string, unknown>;
  try {
    await world.reset("approved-write");
    const buildWorld = new RealGiteaBrowserWorld(world, registryDirectory, {}, modelBuilder);
    const build = await buildWorld.complete(buildWorld.request("model-build"));
    const buildDirect = await world.verifyBrowserIssue({
      marker: "[CF-BROWSER:model-build]",
      title: "[model-build] Browser-backed incident",
      body: "[CF-BROWSER:model-build]\n\nSynthetic incident created through the genuine disposable Gitea UI.",
    });
    await world.reset("fresh-process-reuse");
    const forbiddenBuilder = new ForbiddenReuseBuilder();
    const reuseWorld = new RealGiteaBrowserWorld(world, registryDirectory, {}, forbiddenBuilder);
    const reuse = await reuseWorld.complete(reuseWorld.request("model-reuse"));
    const reuseDirect = await world.verifyBrowserIssue({
      marker: "[CF-BROWSER:model-reuse]",
      title: "[model-reuse] Browser-backed incident",
      body: "[CF-BROWSER:model-reuse]\n\nSynthetic incident created through the genuine disposable Gitea UI.",
    });
    const passed = build.status === "completed"
      && build.path === "built-capability"
      && buildDirect.passed
      && buildDirect.incorrectSideEffects === 0
      && reuse.status === "completed"
      && reuse.path === "retained-capability"
      && reuseDirect.passed
      && reuseDirect.incorrectSideEffects === 0
      && gateway.calls >= 1
      && gateway.calls <= 2
      && forbiddenBuilder.calls === 0;
    result = {
      passed,
      build: { status: build.status, path: build.status === "completed" ? build.path : undefined, direct: buildDirect },
      reuse: { status: reuse.status, path: reuse.status === "completed" ? reuse.path : undefined, direct: reuseDirect },
      modelCalls: gateway.calls,
      spentUsd: gateway.spentUsd(),
      reuseBuilderCalls: forbiddenBuilder.calls,
    };
  } catch (error) {
    result = {
      passed: false,
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      modelCalls: gateway.calls,
      spentUsd: gateway.spentUsd(),
    };
  }

  const sourceUnchanged = FROZEN_FILES.every((filename) => sha256(filename) === sourceHashes[filename])
    && git("rev-parse", "HEAD") === startingCommit
    && git("status", "--porcelain", "--untracked-files=no") === "";
  const passed = result.passed === true
    && sourceUnchanged
    && Number(result.modelCalls) <= 2
    && Number(result.spentUsd) <= 2;
  const report = {
    ...freeze,
    passed,
    sourceUnchanged,
    result,
    completedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(directory, "confirmation-report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (!passed) process.exitCode = 1;
}

await main();
