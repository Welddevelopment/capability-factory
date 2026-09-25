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
  GITEA_DISCOVERY_PASSWORD_ALIAS,
  GITEA_DISCOVERY_USERNAME_ALIAS,
  giteaBrowserDiscoveryBoundary,
} from "./gitea-browser-discovery.js";
import { REAL_GITEA_BROWSER_UI_CONTRACT, RealGiteaBrowserWorld } from "./real-gitea-browser-world.js";
import { startRealGiteaWorld } from "./real-gitea-world.js";
import { ExperimentalBrowserCapabilitySdk, StaticTrustedBrowserCapabilitySource } from "../experimental/browser-capability-sdk.js";
import { BrowserDiscoveryGoalRunner } from "../experimental/browser-discovery-sdk.js";
import { OpenAIBrowserDiscoveryPlanner } from "../experimental/browser-discovery-planner.js";
import type { BrowserDiscoveryPlanner, BrowserDiscoveryPlannerInput, BrowserDiscoveryPlan } from "../experimental/browser-discovery.js";
import { ExperimentalBrowserDriver } from "../experimental/browser-driver.js";
import { PlaywrightBrowserDiscoverer } from "../experimental/playwright-browser-discovery.js";
import { FileBrowserCapabilityRegistry } from "../experimental/browser-registry.js";
import { PlaywrightBrowserSessionFactory } from "../experimental/playwright-browser-session.js";
import { RotatingMemorySecretProvider, type SecretScope } from "../product/secrets.js";

const PROTOCOL = "gitea-browser-discovery-model-confirmation-v1";
const FROZEN_FILES = [
  "src/config.ts",
  "src/model-gateway.ts",
  "src/experimental/browser-driver.ts",
  "src/experimental/browser-capability-sdk.ts",
  "src/experimental/browser-registry.ts",
  "src/experimental/browser-discovery.ts",
  "src/experimental/browser-discovery-planner.ts",
  "src/experimental/browser-discovery-sdk.ts",
  "src/experimental/playwright-browser-discovery.ts",
  "src/experimental/playwright-browser-session.ts",
  "src/customer-world/gitea-browser-discovery.ts",
  "src/customer-world/real-gitea-world.ts",
  "src/customer-world/real-gitea-browser-world.ts",
  "src/customer-world/run-gitea-browser-discovery-model-confirmation.ts",
] as const;

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function sha256(filename: string): string {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

class CountingPlanner implements BrowserDiscoveryPlanner {
  calls = 0;
  readonly plannerId: string;

  constructor(private readonly underlying: OpenAIBrowserDiscoveryPlanner) {
    this.plannerId = underlying.plannerId;
  }

  async propose(input: BrowserDiscoveryPlannerInput): Promise<BrowserDiscoveryPlan> {
    this.calls += 1;
    return this.underlying.propose(input);
  }

  spentUsd(): number {
    return this.underlying.spentUsd();
  }
}

class ForbiddenReusePlanner implements BrowserDiscoveryPlanner {
  readonly plannerId = "forbidden-retained-reuse-planner";
  calls = 0;

  async propose(): Promise<BrowserDiscoveryPlan> {
    this.calls += 1;
    throw new Error("Fresh-process retained reuse unexpectedly called the discovery planner.");
  }
}

async function main(): Promise<void> {
  if (process.env.CF_GITEA_BROWSER_DISCOVERY_MODEL_ACK !== PROTOCOL) {
    throw new Error(`Set CF_GITEA_BROWSER_DISCOVERY_MODEL_ACK=${PROTOCOL} to authorize this bounded paid confirmation.`);
  }
  const startingCommit = git("rev-parse", "HEAD");
  if (git("status", "--porcelain", "--untracked-files=no") !== "") {
    throw new Error("Tracked source must be clean before the browser-discovery model freeze.");
  }
  const campaignId = `${PROTOCOL}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  const directory = path.resolve("artifacts", "gitea-browser-discovery-model-confirmation", campaignId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const sourceHashes = Object.fromEntries(FROZEN_FILES.map((filename) => [filename, sha256(filename)]));
  const freeze = {
    protocol: PROTOCOL,
    campaignId,
    gitCommit: startingCommit,
    frozenAt: new Date().toISOString(),
    model: "gpt-5.6-sol",
    reasoning: "medium",
    successRule: "Trusted code observes a genuine disposable Gitea issue UI read-only; one model plan may use only sanitized observed control IDs and approved boundaries; trusted compilation, probe, permissioned execution and direct API verification pass; a fresh process reuses the retained capability with no second model call.",
    maximumPaidCalls: 2,
    spendCeilingUsd: 2,
    sourceHashes,
    evidenceBoundary: "Private local model-backed transfer evidence against one genuine disposable Gitea interface. It does not demonstrate arbitrary-site discovery, customer validation, production reliability, universal browser support or a formal final green verdict.",
  };
  fs.writeFileSync(path.join(directory, "campaign-freeze.json"), `${JSON.stringify(freeze, null, 2)}\n`, { mode: 0o600 });
  if (process.env.CF_GITEA_BROWSER_DISCOVERY_MODEL_DRY_RUN === "1") {
    console.log(JSON.stringify({ campaignId, dryRun: true, freeze: path.join(directory, "campaign-freeze.json") }));
    return;
  }

  const budget = new BudgetTracker(path.join(directory, "budget.json"), { warnUsd: 1, maxUsd: 2, maxRunUsd: 2 });
  const model = new OpenAIModelGateway(requireApiKey(), budget, new TraceWriter("gitea-browser-discovery-model", path.join(directory, "trace")));
  const planner = new CountingPlanner(new OpenAIBrowserDiscoveryPlanner(model));
  const world = await startRealGiteaWorld({ repositoryRoot: process.cwd(), artifactDirectory: path.join(directory, "gitea") });
  const target = new RealGiteaBrowserWorld(world, path.join(directory, "reference-world")).target();
  const credentials = world.browserSessionCredentials();
  const secrets = new RotatingMemorySecretProvider();
  const scope: SecretScope = {
    targetAliases: ["gitea_browser"],
    actionNames: ["browser-discovery-session-auth", "browser-capability-verification", "browser-write"],
    methods: ["BROWSER"],
  };
  secrets.set({ alias: GITEA_DISCOVERY_USERNAME_ALIAS, version: "model-confirm-v1", scope }, credentials.username);
  secrets.set({ alias: GITEA_DISCOVERY_PASSWORD_ALIAS, version: "model-confirm-v1", scope }, credentials.password);
  const registry = new FileBrowserCapabilityRegistry(path.join(directory, "browser-candidate"));
  const request = (suffix: string) => ({
    tenantId: "gitea-browser-discovery-model-tenant",
    requestId: `gitea-browser-discovery-model-request-${suffix}`,
    parentGoalId: `gitea-browser-discovery-model-parent-${suffix}`,
    ordinaryGoal: `Create and verify the approved synthetic Gitea incident ${suffix}, then continue the original goal.`,
    needKey: "create-gitea-issue-through-ui",
    operationKey: `gitea-browser-discovery-model-operation-${suffix}`,
    input: {
      title: `[${suffix}] Discovered browser incident`,
      body: `[CF-DISCOVERY:${suffix}]\n\nSynthetic incident created through model-planned read-only UI discovery.`,
    },
    approvals: ["create-gitea-issue"],
  });
  const runner = (activePlanner: BrowserDiscoveryPlanner) => new BrowserDiscoveryGoalRunner(
    target,
    giteaBrowserDiscoveryBoundary(),
    new PlaywrightBrowserDiscoverer({ secretProvider: secrets }),
    activePlanner,
    registry,
    ({ target: effectiveTarget, builder }) => new ExperimentalBrowserCapabilitySdk({
      driver: new ExperimentalBrowserDriver({ gitea_browser: effectiveTarget }, new PlaywrightBrowserSessionFactory()),
      registry,
      trustedSource: new StaticTrustedBrowserCapabilitySource("empty-model-discovery-catalog", []),
      builder,
      secretProvider: secrets,
      outcomeVerifier: (goal) => {
        const marker = goal.input.body?.match(/^\[CF-DISCOVERY:[^\]]+\]/)?.[0];
        if (!marker) throw new Error("Model discovery request requires a unique body marker.");
        return {
          key: REAL_GITEA_BROWSER_UI_CONTRACT.outcomeVerifierKey,
          verify: async (operationKey: string) => {
            if (operationKey !== goal.operationKey) return { outcome: "unknown" as const, detail: "Wrong operation identity." };
            const direct = await world.verifyBrowserIssue({ marker, title: goal.input.title!, body: goal.input.body! });
            return direct.passed
              ? { outcome: "complete" as const, detail: direct.detail, stateDigest: direct.stateHash }
              : { outcome: direct.incorrectSideEffects > 0 ? "incorrect" as const : "not-started" as const, detail: direct.detail, stateDigest: direct.stateHash };
          },
        };
      },
    }),
  );

  let result: Record<string, unknown>;
  const forbidden = new ForbiddenReusePlanner();
  try {
    await world.reset("approved-write");
    const build = await runner(planner).completeGoal(request("model-build"));
    const buildDirect = await world.verifyBrowserIssue({
      marker: "[CF-DISCOVERY:model-build]",
      title: "[model-build] Discovered browser incident",
      body: "[CF-DISCOVERY:model-build]\n\nSynthetic incident created through model-planned read-only UI discovery.",
    });
    await world.reset("fresh-process-reuse");
    const reuse = await runner(forbidden).completeGoal(request("model-reuse"));
    const reuseDirect = await world.verifyBrowserIssue({
      marker: "[CF-DISCOVERY:model-reuse]",
      title: "[model-reuse] Discovered browser incident",
      body: "[CF-DISCOVERY:model-reuse]\n\nSynthetic incident created through model-planned read-only UI discovery.",
    });
    const passed = build.status === "completed"
      && "capability" in build && build.capability.status === "completed" && build.capability.path === "built-capability"
      && buildDirect.passed && buildDirect.incorrectSideEffects === 0
      && reuse.status === "completed"
      && "capability" in reuse && reuse.capability.status === "completed" && reuse.capability.path === "retained-capability"
      && reuseDirect.passed && reuseDirect.incorrectSideEffects === 0
      && planner.calls === 1 && forbidden.calls === 0;
    result = {
      passed,
      build: { status: build.status, path: "capability" in build && build.capability.status === "completed" ? build.capability.path : undefined, direct: buildDirect },
      reuse: { status: reuse.status, path: "capability" in reuse && reuse.capability.status === "completed" ? reuse.capability.path : undefined, direct: reuseDirect },
      modelCalls: planner.calls,
      spentUsd: planner.spentUsd(),
      reusePlannerCalls: forbidden.calls,
    };
  } catch (error) {
    result = {
      passed: false,
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      modelCalls: planner.calls,
      spentUsd: planner.spentUsd(),
      reusePlannerCalls: forbidden.calls,
    };
  }
  const sourceUnchanged = FROZEN_FILES.every((filename) => sha256(filename) === sourceHashes[filename])
    && git("rev-parse", "HEAD") === startingCommit
    && git("status", "--porcelain", "--untracked-files=no") === "";
  const passed = result.passed === true && sourceUnchanged && Number(result.modelCalls) <= 2 && Number(result.spentUsd) <= 2;
  const report = { ...freeze, passed, sourceUnchanged, result, completedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(directory, "confirmation-report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (!passed) process.exitCode = 1;
}

await main();
