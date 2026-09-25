import OpenAI from "openai";
import { createHash, randomUUID } from "node:crypto";
import type { Response, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { EXPERIMENT_LIMITS } from "./config.js";
import type { BudgetTracker } from "./budget.js";
import type { TraceWriter } from "./trace.js";

export interface ModelCallObserver {
  beforeCall(input: {
    callNumber: number;
    projectedUsd: number;
    runSpentUsd: number;
  }): void;
  usageRecorded?(input: {
    callNumber: number;
    callCostUsd: number;
    runSpentUsd: number;
  }): void;
}

export function redactEncryptedModelContent(value: unknown): unknown {
  if (typeof value === "string" && /(?:bearer\s+[a-z0-9._~+\/-]{8,}|sk-[a-z0-9_-]{12,}|(?:api[_ -]?key|password|client[_ -]?secret|access[_ -]?token)\s*[:=]\s*["']?[^\s"']{6,}|https?:\/\/[^\s/:]+:[^\s/@]+@)/i.test(value)) {
    return "[REDACTED CREDENTIAL-SHAPED MODEL CONTENT]";
  }
  if (Array.isArray(value)) return value.map(redactEncryptedModelContent);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        key === "encrypted_content" ? "[REDACTED ENCRYPTED MODEL CONTENT]" : redactEncryptedModelContent(item),
      ]),
    );
  }
  return value;
}

export class OpenAIModelGateway {
  private readonly client: OpenAI;
  private runSpentUsd = 0;
  private calls = 0;
  private attempts = 0;
  private priorInputTokens = 0;
  private readonly gatewayInstanceId = randomUUID().replaceAll("-", "");
  private readonly deadline = Date.now() + EXPERIMENT_LIMITS.runTimeoutMs;

  constructor(
    apiKey: string,
    private readonly budget: BudgetTracker,
    private readonly trace: TraceWriter,
    private readonly observer?: ModelCallObserver,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async create(params: ResponseCreateParamsNonStreaming): Promise<Response> {
    if (this.calls >= EXPERIMENT_LIMITS.maxTurns) {
      throw new Error(`Model turn limit reached (${EXPERIMENT_LIMITS.maxTurns})`);
    }
    const remainingMs = this.deadline - Date.now();
    if (remainingMs <= 0) throw new Error("Run time limit reached before the next model call");
    this.budget.assertCanStartRun();
    const requestTokens = Math.ceil(JSON.stringify(params).length / 4);
    const approximateInputTokens = params.previous_response_id
      ? Math.max(requestTokens, this.priorInputTokens + requestTokens)
      : requestTokens;
    const maximumOutputTokens = params.max_output_tokens ?? EXPERIMENT_LIMITS.maxOutputTokens;
    const projectedUsd = approximateInputTokens * 0.000_005 + maximumOutputTokens * 0.000_03;
    const callNumber = this.calls + 1;
    const attemptNumber = ++this.attempts;
    const requestDigest = createHash("sha256").update(JSON.stringify(params)).digest("hex");
    const reservation = this.budget.reserveModelCall({
      seamId: "openai.responses.create",
      attemptKey: `gateway:${this.gatewayInstanceId}:attempt:${attemptNumber}`,
      requestDigest,
      projectedUsd,
      runSpentUsd: this.runSpentUsd,
    });
    const startedAt = Date.now();
    try {
      this.observer?.beforeCall({ callNumber, projectedUsd, runSpentUsd: this.runSpentUsd });
      this.trace.record("model.request", {
        turn: callNumber,
        model: params.model,
        reasoning: params.reasoning,
        instructions: params.instructions,
        input: params.input,
        tools: params.tools,
        previousResponseId: params.previous_response_id,
        projectedUsd,
        remainingMs,
        reservationId: reservation.reservationId,
        requestDigest,
      });
    } catch (error) {
      this.budget.cancelModelCallBeforeDispatch(reservation.reservationId, "Trusted pre-dispatch observer or trace rejected the call.");
      throw error;
    }
    this.budget.markModelCallDispatched(reservation.reservationId);
    this.calls = callNumber;
    let response: Response;
    try {
      response = await this.client.responses.create(params, { signal: AbortSignal.timeout(remainingMs) });
    } catch (error) {
      try { this.budget.markModelCallAmbiguous(reservation.reservationId, "Provider request failed without trusted usage settlement."); } catch { /* dispatched remains unresolved and blocks later calls */ }
      this.trace.record("model.usage-ambiguous", { turn: callNumber, reservationId: reservation.reservationId, requestDigest, reason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    const usage = response.usage;
    if (!usage) {
      this.budget.markModelCallAmbiguous(reservation.reservationId, "Provider returned a response without settleable usage.");
      this.trace.record("model.usage-ambiguous", { turn: callNumber, reservationId: reservation.reservationId, responseId: response.id, reason: "missing-usage" });
      throw new Error("Provider response omitted usage; the durable reservation is ambiguous and blocks any retry.");
    }
    this.priorInputTokens = usage.input_tokens;
    const usageRecord = { inputTokens: usage.input_tokens, cachedInputTokens: usage.input_tokens_details.cached_tokens, outputTokens: usage.output_tokens };
    const usageEvidenceDigest = createHash("sha256").update(JSON.stringify({ responseId: response.id, model: response.model, usage })).digest("hex");
    const recorded = this.budget.settleModelCall(reservation.reservationId, usageRecord, response.id, usageEvidenceDigest);
    this.runSpentUsd += recorded.callCostUsd;
    this.observer?.usageRecorded?.({ callNumber, callCostUsd: recorded.callCostUsd, runSpentUsd: this.runSpentUsd });
    this.trace.record("model.usage", {
      responseId: response.id,
      returnedModel: response.model,
      usage,
      reservationId: reservation.reservationId,
      usageEvidenceDigest,
      callCostUsd: recorded.callCostUsd,
      runCostUsd: this.runSpentUsd,
      globalBudget: recorded.state,
      warning: recorded.warning,
      overrun: recorded.overrun,
    });
    if (recorded.overrun || this.runSpentUsd > EXPERIMENT_LIMITS.maxRunCostUsd) {
      throw new Error(`Settled model cost exceeded a frozen budget ceiling (run ceiling $${EXPERIMENT_LIMITS.maxRunCostUsd}).`);
    }
    this.trace.record("model.response", {
      responseId: response.id,
      model: response.model,
      status: response.status,
      output: redactEncryptedModelContent(response.output),
      outputText: redactEncryptedModelContent(response.output_text),
      durationMs: Date.now() - startedAt,
    });
    return response;
  }

  spentUsd(): number {
    return this.runSpentUsd;
  }

  callCount(): number {
    return this.calls;
  }
}
