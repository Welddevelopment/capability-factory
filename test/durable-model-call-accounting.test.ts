import { createHash, generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BudgetTracker } from "../src/budget.js";
import { DurableModelCallAccounting, signAmbiguousModelUsageUnchargedReceipt, type DurableModelCallPolicy } from "../src/durable-model-call-accounting.js";
import { OpenAIModelGateway } from "../src/model-gateway.js";
import { TraceWriter } from "../src/trace.js";

const roots: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0).reverse()) { try { close(); } catch { /* already closed */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "cf019-accounting-"));
  roots.push(value);
  return value;
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function policy(override: Partial<DurableModelCallPolicy> = {}): DurableModelCallPolicy {
  return {
    schemaVersion: "1.0",
    ledgerId: "cf019-test-ledger",
    maximumCampaignSpendUsd: 1,
    maximumSpendUsdPerCall: 0.4,
    maximumCalls: 4,
    maximumConcurrentCalls: 1,
    warningSpendUsd: 0.5,
    ...override,
  };
}

function accounting(directory: string, override: Partial<DurableModelCallPolicy> = {}): DurableModelCallAccounting {
  const value = new DurableModelCallAccounting(join(directory, "calls.sqlite"), policy(override));
  closers.push(() => value.close());
  return value;
}

function reserve(ledger: DurableModelCallAccounting, attemptKey = "attempt-1") {
  return ledger.reserve({ seamId: "test.proposal", attemptKey, requestDigest: sha(attemptKey), projectedSpendUsd: 0.2 });
}

describe("CF-019 durable model-call accounting", () => {
  it("durably reserves before dispatch, settles exact usage, and reconstructs the same state after restart", () => {
    const directory = root();
    const first = accounting(directory);
    const reservation = reserve(first);
    expect(first.snapshot()).toMatchObject({ settledSpendUsd: 0, exposedSpendUsd: 0.2, statuses: { reserved: 1 }, unresolvedReservationIds: [reservation.reservationId] });
    first.markDispatched(reservation.reservationId);
    const settled = first.settle(reservation.reservationId, {
      inputTokens: 1_000,
      cachedInputTokens: 500,
      outputTokens: 200,
      costUsd: 0.01,
      providerResponseId: "response-cf019-1",
      usageEvidenceDigest: sha("usage-1"),
    });
    expect(settled).toMatchObject({ overrun: false, snapshot: { settledSpendUsd: 0.01, exposedSpendUsd: 0.01, callsCounted: 1, unresolvedReservationIds: [] } });
    first.close();
    closers.pop();
    const reopened = accounting(directory);
    expect(reopened.snapshot()).toMatchObject({ settledSpendUsd: 0.01, callsCounted: 1, statuses: { settled: 1 }, latestEventDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(() => reopened.settle(reservation.reservationId, {
      inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, costUsd: 0.001, providerResponseId: "duplicate", usageEvidenceDigest: sha("duplicate"),
    })).toThrow(/only a dispatched call can settle/i);
  });

  it("serializes concurrent processes so one unresolved call blocks every later reservation", () => {
    const directory = root();
    const first = accounting(directory);
    const second = accounting(directory);
    const reservation = reserve(first, "parallel-a");
    expect(() => reserve(second, "parallel-b")).toThrow(/unresolved model-call reservation/i);
    first.markDispatched(reservation.reservationId);
    expect(() => reserve(second, "parallel-c")).toThrow(/unresolved model-call reservation/i);
  });

  it("preserves ambiguous usage across restart and requires explicit evidence before another call", () => {
    const directory = root();
    const reconciliationKeys = generateKeyPairSync("ed25519");
    const trust = { ambiguityReconciliationTrust: { signerKeyId: "provider_billing_audit_v1", publicKeyPem: reconciliationKeys.publicKey.export({ type: "spki", format: "pem" }).toString() } };
    const first = accounting(directory, trust);
    const reservation = reserve(first, "ambiguous-a");
    first.markDispatched(reservation.reservationId);
    first.markAmbiguous(reservation.reservationId, "Provider transport ended without usage.");
    first.close();
    closers.pop();
    const reopened = accounting(directory, trust);
    expect(reopened.snapshot()).toMatchObject({ statuses: { ambiguous: 1 }, exposedSpendUsd: 0.2, unresolvedReservationIds: [reservation.reservationId] });
    expect(() => reserve(reopened, "ambiguous-b")).toThrow(/unresolved model-call reservation/i);
    const attacker = generateKeyPairSync("ed25519");
    const forged = signAmbiguousModelUsageUnchargedReceipt({ ledgerId: policy().ledgerId, reservationId: reservation.reservationId, requestDigest: reservation.requestDigest, providerEvidenceDigest: sha("forged-proof"), signerKeyId: "provider_billing_audit_v1", issuedAt: new Date().toISOString(), privateKey: attacker.privateKey });
    expect(() => reopened.resolveAmbiguousUncharged(forged)).toThrow(/signature is invalid/i);
    const receipt = signAmbiguousModelUsageUnchargedReceipt({ ledgerId: policy().ledgerId, reservationId: reservation.reservationId, requestDigest: reservation.requestDigest, providerEvidenceDigest: sha("provider-billing-proof-uncharged"), signerKeyId: "provider_billing_audit_v1", issuedAt: new Date().toISOString(), privateKey: reconciliationKeys.privateKey });
    const reconciled = reopened.resolveAmbiguousUncharged(receipt);
    expect(reconciled).toMatchObject({ statuses: { "verified-uncharged": 1 }, settledSpendUsd: 0, exposedSpendUsd: 0, unresolvedReservationIds: [] });
    expect(reserve(reopened, "ambiguous-b").status).toBe("reserved");
  });

  it("permits trusted pre-dispatch cancellation but rejects policy widening and row tampering", () => {
    const directory = root();
    const first = accounting(directory);
    const reservation = reserve(first, "cancel-a");
    first.cancelBeforeDispatch(reservation.reservationId, "Trusted trace failed before provider dispatch.");
    expect(first.snapshot()).toMatchObject({ callsCounted: 0, exposedSpendUsd: 0, statuses: { "cancelled-before-dispatch": 1 } });
    expect(reserve(first, "cancel-b").status).toBe("reserved");
    expect(() => new DurableModelCallAccounting(join(directory, "calls.sqlite"), policy({ maximumCampaignSpendUsd: 2 }))).toThrow(/policy cannot be changed/i);
    const database = new DatabaseSync(join(directory, "calls.sqlite"));
    database.prepare("UPDATE model_call_reservations SET projected_spend_usd=0.01 WHERE attempt_key='cancel-b'").run();
    database.close();
    expect(() => first.snapshot()).toThrow(/integrity check/i);
  });

  it("records an actual overrun instead of losing charged usage, then blocks later calls", () => {
    const directory = root();
    const ledger = accounting(directory, { maximumCampaignSpendUsd: 0.3, maximumSpendUsdPerCall: 0.25, warningSpendUsd: 0.2 });
    const reservation = ledger.reserve({ seamId: "test.proposal", attemptKey: "overrun-a", requestDigest: sha("overrun"), projectedSpendUsd: 0.2 });
    ledger.markDispatched(reservation.reservationId);
    const result = ledger.settle(reservation.reservationId, { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, costUsd: 0.31, providerResponseId: "overrun-response", usageEvidenceDigest: sha("overrun-usage") });
    expect(result).toMatchObject({ overrun: true, snapshot: { settledSpendUsd: 0.31, budgetExceeded: true, warning: true } });
    expect(() => ledger.reserve({ seamId: "test.proposal", attemptKey: "overrun-b", requestDigest: sha("overrun-b"), projectedSpendUsd: 0.01 })).toThrow(/spend ceiling/i);
  });

  it("joins the real OpenAI gateway seam without making a network call", async () => {
    const directory = root();
    const budget = new BudgetTracker(join(directory, "budget.json"), { warnUsd: 0.5, maxUsd: 1, maxRunUsd: 0.5, maxCalls: 3 });
    closers.push(() => budget.close());
    const trace = new TraceWriter("cf019-success", join(directory, "trace"));
    const gateway = new OpenAIModelGateway("fixture-key-not-used", budget, trace);
    (gateway as unknown as { client: { responses: { create: () => Promise<unknown> } } }).client.responses.create = async () => ({
      id: "response_success",
      model: "gpt-5.6-fixture",
      status: "completed",
      output: [],
      output_text: "fixture",
      usage: { input_tokens: 1_000, input_tokens_details: { cached_tokens: 500 }, output_tokens: 100 },
    });
    await gateway.create({ model: "gpt-5.6-fixture", input: "offline fixture", max_output_tokens: 100 });
    expect(budget.accountingSnapshot()).toMatchObject({ statuses: { settled: 1 }, callsCounted: 1, unresolvedReservationIds: [] });
    expect(budget.snapshot()).toMatchObject({ calls: 1, spentUsd: 0.00575 });
  });

  it("turns a provider error into a durable ambiguous stop and never retries", async () => {
    const directory = root();
    const budget = new BudgetTracker(join(directory, "budget.json"), { warnUsd: 0.5, maxUsd: 1, maxRunUsd: 0.5, maxCalls: 3 });
    closers.push(() => budget.close());
    const gateway = new OpenAIModelGateway("fixture-key-not-used", budget, new TraceWriter("cf019-error", join(directory, "trace")));
    let calls = 0;
    (gateway as unknown as { client: { responses: { create: () => Promise<unknown> } } }).client.responses.create = async () => { calls += 1; throw new Error("fixture transport ended"); };
    await expect(gateway.create({ model: "gpt-5.6-fixture", input: "offline fixture", max_output_tokens: 100 })).rejects.toThrow(/fixture transport ended/);
    expect(budget.accountingSnapshot()).toMatchObject({ statuses: { ambiguous: 1 }, unresolvedReservationIds: [expect.any(String)] });
    await expect(gateway.create({ model: "gpt-5.6-fixture", input: "must not retry", max_output_tokens: 100 })).rejects.toThrow(/unresolved model call/i);
    expect(calls).toBe(1);
  });

  it("treats a successful provider response without usage as ambiguous rather than uncharged", async () => {
    const directory = root();
    const budget = new BudgetTracker(join(directory, "budget.json"), { warnUsd: 0.5, maxUsd: 1, maxRunUsd: 0.5, maxCalls: 3 });
    closers.push(() => budget.close());
    const gateway = new OpenAIModelGateway("fixture-key-not-used", budget, new TraceWriter("cf019-missing-usage", join(directory, "trace")));
    (gateway as unknown as { client: { responses: { create: () => Promise<unknown> } } }).client.responses.create = async () => ({
      id: "response_without_usage", model: "gpt-5.6-fixture", status: "completed", output: [], output_text: "fixture",
    });
    await expect(gateway.create({ model: "gpt-5.6-fixture", input: "offline fixture", max_output_tokens: 100 })).rejects.toThrow(/omitted usage/i);
    expect(budget.accountingSnapshot()).toMatchObject({ statuses: { ambiguous: 1 }, unresolvedReservationIds: [expect.any(String)] });
  });

  it("redacts credential-shaped response strings from the durable trace without changing accounting", async () => {
    const directory = root(), traceDirectory = join(directory, "trace");
    const budget = new BudgetTracker(join(directory, "budget.json"), { warnUsd: 0.5, maxUsd: 1, maxRunUsd: 0.5, maxCalls: 1 }); closers.push(() => budget.close());
    const gateway = new OpenAIModelGateway("fixture-key-not-used", budget, new TraceWriter("cf019-redaction", traceDirectory));
    (gateway as unknown as { client: { responses: { create: () => Promise<unknown> } } }).client.responses.create = async () => ({ id: "response_secret", model: "gpt-5.6-fixture", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "api_key=fixture-secret-placeholder-123456" }] }], output_text: "api_key=fixture-secret-placeholder-123456", usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10 } });
    await gateway.create({ model: "gpt-5.6-fixture", input: "offline fixture", max_output_tokens: 10 });
    const trace = readFileSync(join(traceDirectory, "trace.jsonl"), "utf8");
    expect(trace).not.toContain("fixture-secret-placeholder-123456"); expect(trace).toContain("REDACTED CREDENTIAL-SHAPED MODEL CONTENT");
    expect(budget.accountingSnapshot()).toMatchObject({ statuses: { settled: 1 }, unresolvedReservationIds: [] });
  });
});
