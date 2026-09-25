import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactValue } from "./redaction.js";

export const RELIABILITY_CASE_IDS = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"] as const;
export type ReliabilityCaseId = (typeof RELIABILITY_CASE_IDS)[number];

export interface ReliabilityCaseDefinition {
  id: ReliabilityCaseId;
  name: string;
  expectedResult: string;
  safetyCritical: boolean;
}

export interface ReliabilityPreflightCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface ReliabilityCaseResult {
  id: ReliabilityCaseId;
  passed: boolean;
  safetyFailure: boolean;
  incorrectSideEffects: number;
  modelCalls: number;
  spentUsd: number;
  detail: Record<string, unknown>;
  completedAt: string;
}

export interface ReliabilityCampaignConfiguration {
  protocolVersion: string;
  repositoryRoot: string;
  artifactRoot: string;
  model: string;
  reasoning: string;
  priorPreservedSpendUsd: number;
  additionalSpendCeilingUsd: number;
  sourceFiles: string[];
  cases: ReliabilityCaseDefinition[];
  now?: () => string;
}

export interface ReliabilityCaseAdapterContext {
  readonly caseId: ReliabilityCaseId;
  readonly campaignId: string;
  readonly artifactDirectory: string;
  readonly modelObserver: import("../model-gateway.js").ModelCallObserver;
  snapshot(): { modelCalls: number; spentUsd: number };
}

export interface ReliabilityCaseAdapter {
  readonly id: ReliabilityCaseId;
  readonly version: string;
  preflight(): Promise<ReliabilityPreflightCheck[]> | ReliabilityPreflightCheck[];
  execute(context: ReliabilityCaseAdapterContext): Promise<
    Omit<ReliabilityCaseResult, "id" | "modelCalls" | "spentUsd" | "completedAt">
  >;
}

interface FrozenCampaign {
  protocolVersion: string;
  campaignId: string;
  frozenAt: string;
  model: string;
  reasoning: string;
  claimBoundary: string;
  budget: {
    priorPreservedSpendUsd: number;
    additionalSpendCeilingUsd: number;
  };
  cases: ReliabilityCaseDefinition[];
  sourceHashes: Record<string, string>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashFile(filename: string): string {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

/**
 * Audit-oriented controller for a frozen paid campaign. It deliberately does
 * not know how a model or customer world works; those remain replaceable case
 * adapters. Its job is to prevent quiet protocol drift, lost failures, budget
 * overruns, and post-hoc relabelling.
 */
export class ReliabilityCampaignController {
  readonly campaignId: string;
  readonly directory: string;
  private readonly now: () => string;
  private preflightPassed = false;
  private frozen: FrozenCampaign | null = null;
  private readonly results = new Map<ReliabilityCaseId, ReliabilityCaseResult>();

  constructor(private readonly configuration: ReliabilityCampaignConfiguration) {
    this.now = configuration.now ?? (() => new Date().toISOString());
    const suffix = this.now().replaceAll(/[:.]/g, "-");
    this.campaignId = `${configuration.protocolVersion}-${suffix}`;
    this.directory = path.resolve(configuration.artifactRoot, this.campaignId);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.validateConfiguration();
  }

  recordPreflight(checks: ReliabilityPreflightCheck[]): void {
    if (this.frozen) throw new Error("Preflight cannot change after campaign freeze.");
    if (checks.length === 0) throw new Error("The campaign requires at least one deterministic preflight check.");
    const sanitized = redactValue({
      protocolVersion: this.configuration.protocolVersion,
      checkedAt: this.now(),
      passed: checks.every((check) => check.passed),
      checks,
    });
    this.writeJson("machine-preflight.json", sanitized);
    this.preflightPassed = checks.every((check) => check.passed);
    if (!this.preflightPassed) throw new Error("Deterministic campaign preflight failed; freeze and paid calls are blocked.");
  }

  freeze(): FrozenCampaign {
    if (!this.preflightPassed) throw new Error("A passing deterministic preflight is required before freeze.");
    if (this.frozen) return structuredClone(this.frozen);
    const sourceHashes = Object.fromEntries(
      this.configuration.sourceFiles.map((relative) => [
        relative,
        hashFile(path.resolve(this.configuration.repositoryRoot, relative)),
      ]),
    );
    this.frozen = {
      protocolVersion: this.configuration.protocolVersion,
      campaignId: this.campaignId,
      frozenAt: this.now(),
      model: this.configuration.model,
      reasoning: this.configuration.reasoning,
      claimBoundary:
        "Constrained local repeatability evidence only; not customer evidence, production reliability, security certification, or a formal final green verdict.",
      budget: {
        priorPreservedSpendUsd: this.configuration.priorPreservedSpendUsd,
        additionalSpendCeilingUsd: this.configuration.additionalSpendCeilingUsd,
      },
      cases: structuredClone(this.configuration.cases),
      sourceHashes,
    };
    this.writeJson("campaign-freeze.json", this.frozen);
    return structuredClone(this.frozen);
  }

  assertCanStartPaidCall(projectedCallUsd: number, currentCampaignSpendUsd: number): void {
    this.assertFrozenSources();
    if (!Number.isFinite(projectedCallUsd) || projectedCallUsd < 0) throw new Error("Projected call cost must be a non-negative number.");
    if (!Number.isFinite(currentCampaignSpendUsd) || currentCampaignSpendUsd < 0) throw new Error("Current campaign spend must be a non-negative number.");
    if (currentCampaignSpendUsd + projectedCallUsd > this.configuration.additionalSpendCeilingUsd) {
      throw new Error("The next model call would exceed the frozen additional-spend ceiling.");
    }
  }

  recordCase(result: ReliabilityCaseResult): void {
    this.assertFrozenSources();
    if (this.results.has(result.id)) throw new Error(`Campaign case ${result.id} already has an immutable result.`);
    if (result.spentUsd < 0 || result.modelCalls < 0 || result.incorrectSideEffects < 0) {
      throw new Error(`Campaign case ${result.id} contains an invalid negative measurement.`);
    }
    if (result.incorrectSideEffects > 0 && !result.safetyFailure) {
      throw new Error(`Campaign case ${result.id} cannot hide an incorrect side effect as a non-safety failure.`);
    }
    const cumulativeSpend = [...this.results.values()].reduce((sum, item) => sum + item.spentUsd, 0) + result.spentUsd;
    if (cumulativeSpend > this.configuration.additionalSpendCeilingUsd) {
      throw new Error("Recorded case spend exceeds the frozen campaign ceiling.");
    }
    const preserved = redactValue(structuredClone(result)) as ReliabilityCaseResult;
    this.results.set(result.id, preserved);
    this.writeJson(path.join(`case-${result.id}`, "result.json"), preserved);
  }

  finalize(): Record<string, unknown> {
    this.assertFrozenSources();
    const orderedResults = RELIABILITY_CASE_IDS.flatMap((id) => {
      const result = this.results.get(id);
      return result ? [result] : [];
    });
    const missingCases = this.configuration.cases
      .map((definition) => definition.id)
      .filter((id) => !this.results.has(id));
    const safetyFailure = orderedResults.some((result) => result.safetyFailure || result.incorrectSideEffects > 0);
    const passed = missingCases.length === 0 && !safetyFailure && orderedResults.every((result) => result.passed);
    const summary = {
      protocolVersion: this.configuration.protocolVersion,
      campaignId: this.campaignId,
      completedAt: this.now(),
      passed,
      safetyFailure,
      passedCount: orderedResults.filter((result) => result.passed).length,
      expectedCount: this.configuration.cases.length,
      missingCases,
      totalModelCalls: orderedResults.reduce((sum, result) => sum + result.modelCalls, 0),
      additionalSpentUsd: orderedResults.reduce((sum, result) => sum + result.spentUsd, 0),
      sourceHashesUnchanged: true,
      results: orderedResults,
    };
    this.writeJson("result.json", summary);
    return summary;
  }

  private assertFrozenSources(): void {
    if (!this.frozen) throw new Error("The campaign must be frozen before execution or result recording.");
    for (const [relative, expected] of Object.entries(this.frozen.sourceHashes)) {
      const actual = hashFile(path.resolve(this.configuration.repositoryRoot, relative));
      if (actual !== expected) throw new Error(`Frozen campaign source changed: ${relative}`);
    }
  }

  private validateConfiguration(): void {
    if (this.configuration.additionalSpendCeilingUsd <= 0) throw new Error("Campaign spend ceiling must be positive.");
    const ids = this.configuration.cases.map((definition) => definition.id);
    if (ids.length !== RELIABILITY_CASE_IDS.length || RELIABILITY_CASE_IDS.some((id) => !ids.includes(id))) {
      throw new Error("The reliability campaign must define each frozen case R1 through R8 exactly once.");
    }
    if (new Set(ids).size !== ids.length) throw new Error("Reliability case IDs must be unique.");
    for (const relative of this.configuration.sourceFiles) {
      const absolute = path.resolve(this.configuration.repositoryRoot, relative);
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
        throw new Error(`Frozen source file does not exist: ${relative}`);
      }
    }
  }

  private writeJson(relative: string, value: unknown): void {
    const filename = path.join(this.directory, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const content = `${JSON.stringify(value, null, 2)}\n`;
    fs.writeFileSync(filename, content, { encoding: "utf8", mode: 0o600 });
    const digest = createHash("sha256").update(canonicalJson(value)).digest("hex");
    fs.writeFileSync(`${filename}.sha256`, `${digest}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

/**
 * Sequential audited adapter runner. A shared observer checks the frozen
 * campaign ceiling before every model call and measures actual usage even
 * when a case throws before it can construct its own result.
 */
export class ReliabilityCampaignExecutor {
  private readonly adapters: ReliabilityCaseAdapter[];
  private campaignSpendUsd = 0;

  constructor(
    private readonly controller: ReliabilityCampaignController,
    adapters: ReliabilityCaseAdapter[],
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.adapters = [...adapters];
    const ids = this.adapters.map((adapter) => adapter.id);
    if (
      ids.length !== RELIABILITY_CASE_IDS.length ||
      new Set(ids).size !== ids.length ||
      RELIABILITY_CASE_IDS.some((id) => !ids.includes(id))
    ) {
      throw new Error("The execution adapter registry must contain R1 through R8 exactly once.");
    }
    if (this.adapters.some((adapter) => adapter.version.trim().length === 0)) {
      throw new Error("Every reliability case adapter requires a non-empty version.");
    }
    this.adapters.sort(
      (left, right) => RELIABILITY_CASE_IDS.indexOf(left.id) - RELIABILITY_CASE_IDS.indexOf(right.id),
    );
  }

  async preflight(): Promise<ReliabilityPreflightCheck[]> {
    const checks: ReliabilityPreflightCheck[] = [];
    for (const adapter of this.adapters) {
      const adapterChecks = await adapter.preflight();
      if (adapterChecks.length === 0) {
        checks.push({
          id: `${adapter.id}:adapter-preflight`,
          passed: false,
          detail: `Adapter ${adapter.id}@${adapter.version} supplied no deterministic preflight checks.`,
        });
        continue;
      }
      checks.push(
        ...adapterChecks.map((check) => ({
          ...check,
          id: `${adapter.id}:${check.id}`,
          detail: `[${adapter.version}] ${check.detail}`,
        })),
      );
    }
    return checks;
  }

  async execute(): Promise<Record<string, unknown>> {
    for (const adapter of this.adapters) {
      let modelCalls = 0;
      let spentUsd = 0;
      const context: ReliabilityCaseAdapterContext = {
        caseId: adapter.id,
        campaignId: this.controller.campaignId,
        artifactDirectory: path.join(this.controller.directory, `case-${adapter.id}`),
        modelObserver: {
          beforeCall: ({ projectedUsd }) => {
            this.controller.assertCanStartPaidCall(projectedUsd, this.campaignSpendUsd);
            modelCalls += 1;
          },
          usageRecorded: ({ callCostUsd }) => {
            spentUsd += callCostUsd;
            this.campaignSpendUsd += callCostUsd;
          },
        },
        snapshot: () => ({ modelCalls, spentUsd }),
      };

      let outcome: Omit<ReliabilityCaseResult, "id" | "modelCalls" | "spentUsd" | "completedAt">;
      try {
        outcome = await adapter.execute(context);
      } catch (error) {
        outcome = {
          passed: false,
          safetyFailure: false,
          incorrectSideEffects: 0,
          detail: {
            adapterVersion: adapter.version,
            error: error instanceof Error
              ? { name: error.name, message: error.message }
              : String(error),
          },
        };
      }
      const measured = context.snapshot();
      this.controller.recordCase({
        id: adapter.id,
        ...outcome,
        modelCalls: measured.modelCalls,
        spentUsd: measured.spentUsd,
        completedAt: this.now(),
      });
    }
    return this.controller.finalize();
  }
}
