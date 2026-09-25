import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  DurableModelCallAccounting,
  type DurableModelCallReservation,
  type DurableModelCallSnapshot,
} from "./durable-model-call-accounting.js";

export interface UsageRecord {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface BudgetState {
  spentUsd: number;
  warned: boolean;
  calls: number;
}

export function estimateGpt56SolCost(usage: UsageRecord): number {
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return uncached * 0.000_005 + usage.cachedInputTokens * 0.000_000_5 + usage.outputTokens * 0.000_03;
}

export class BudgetTracker {
  private state: BudgetState;
  private readonly accounting: DurableModelCallAccounting;

  constructor(
    private readonly filename: string,
    private readonly limits: { warnUsd: number; maxUsd: number; maxRunUsd: number; maxCalls?: number },
  ) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const baseline = fs.existsSync(filename)
      ? (JSON.parse(fs.readFileSync(filename, "utf8")) as BudgetState)
      : { spentUsd: 0, warned: false, calls: 0 };
    const ledgerId = `budget-${createHash("sha256").update(path.resolve(filename)).digest("hex").slice(0, 48)}`;
    this.accounting = new DurableModelCallAccounting(`${filename}.calls.sqlite`, {
      schemaVersion: "1.0",
      ledgerId,
      maximumCampaignSpendUsd: limits.maxUsd,
      maximumSpendUsdPerCall: limits.maxRunUsd,
      maximumCalls: limits.maxCalls ?? 10_000,
      maximumConcurrentCalls: 1,
      warningSpendUsd: limits.warnUsd,
    }, baseline);
    this.state = this.stateFromSnapshot(this.accounting.snapshot());
    this.persistMirror();
  }

  private stateFromSnapshot(snapshot: DurableModelCallSnapshot): BudgetState {
    return { spentUsd: snapshot.settledSpendUsd, warned: snapshot.warning, calls: snapshot.callsCounted };
  }

  private persistMirror(): void {
    fs.writeFileSync(this.filename, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }

  assertCanStartRun(): void {
    const snapshot = this.accounting.snapshot();
    if (snapshot.unresolvedReservationIds.length > 0) {
      throw new Error("An unresolved model call blocks this budget until its charge status is reconciled.");
    }
    if (this.state.spentUsd >= this.limits.maxUsd) {
      throw new Error(`Global API budget exhausted at $${this.state.spentUsd.toFixed(4)}`);
    }
  }

  assertProjectedCall(projectedUsd: number, runSpentUsd: number): void {
    if (runSpentUsd + projectedUsd > this.limits.maxRunUsd) {
      throw new Error("Per-run API budget would be exceeded");
    }
    if (this.accounting.snapshot().exposedSpendUsd + projectedUsd > this.limits.maxUsd) {
      throw new Error("Global API budget would be exceeded");
    }
  }

  reserveModelCall(input: { seamId: string; attemptKey: string; requestDigest: string; projectedUsd: number; runSpentUsd: number }): DurableModelCallReservation {
    this.assertCanStartRun();
    this.assertProjectedCall(input.projectedUsd, input.runSpentUsd);
    return this.accounting.reserve({
      seamId: input.seamId,
      attemptKey: input.attemptKey,
      requestDigest: input.requestDigest,
      projectedSpendUsd: input.projectedUsd,
    });
  }

  markModelCallDispatched(reservationId: string): void {
    this.accounting.markDispatched(reservationId);
  }

  cancelModelCallBeforeDispatch(reservationId: string, reason: string): void {
    this.accounting.cancelBeforeDispatch(reservationId, reason);
  }

  markModelCallAmbiguous(reservationId: string, reason: string): void {
    this.accounting.markAmbiguous(reservationId, reason);
  }

  settleModelCall(reservationId: string, usage: UsageRecord, providerResponseId: string, usageEvidenceDigest: string): { callCostUsd: number; state: BudgetState; warning: boolean; overrun: boolean } {
    const callCostUsd = estimateGpt56SolCost(usage);
    const previousWarning = this.state.warned;
    const settled = this.accounting.settle(reservationId, { ...usage, costUsd: callCostUsd, providerResponseId, usageEvidenceDigest });
    this.state = this.stateFromSnapshot(settled.snapshot);
    this.persistMirror();
    return { callCostUsd, state: { ...this.state }, warning: !previousWarning && this.state.warned, overrun: settled.overrun };
  }

  /** Direct post-hoc usage recording cannot prove that budget was reserved before dispatch. */
  record(_usage: UsageRecord): never {
    throw new Error("Post-hoc model usage recording is disabled; reserve, dispatch, and settle through the durable call ledger.");
  }

  snapshot(): BudgetState {
    this.state = this.stateFromSnapshot(this.accounting.snapshot());
    return { ...this.state };
  }

  accountingSnapshot(): DurableModelCallSnapshot {
    return this.accounting.snapshot();
  }

  close(): void {
    this.accounting.close();
  }
}
