import { createHash, createPublicKey, sign as signBytes, verify as verifyBytes, type KeyObject } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const digestPattern = /^[a-f0-9]{64}$/;
const identifierPattern = /^[a-zA-Z0-9_.:-]{1,180}$/;
const zeroDigest = "0".repeat(64);

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

function finiteMoney(value: number, label: string, allowZero = false): void {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0) || value > 1_000_000) {
    throw new Error(`${label} must be a bounded ${allowZero ? "nonnegative" : "positive"} amount.`);
  }
}

function identifier(value: string, label: string): void {
  if (!identifierPattern.test(value)) throw new Error(`${label} must be a bounded stable identifier.`);
}

export interface DurableModelCallPolicy {
  schemaVersion: "1.0";
  ledgerId: string;
  maximumCampaignSpendUsd: number;
  maximumSpendUsdPerCall: number;
  maximumCalls: number;
  maximumConcurrentCalls: 1;
  warningSpendUsd: number;
  ambiguityReconciliationTrust?: {
    signerKeyId: string;
    publicKeyPem: string;
  };
}

export interface DurableModelCallReservationInput {
  seamId: string;
  attemptKey: string;
  requestDigest: string;
  projectedSpendUsd: number;
}

export interface DurableModelCallReservation {
  schemaVersion: "1.0";
  reservationId: string;
  ledgerId: string;
  seamId: string;
  attemptKey: string;
  requestDigest: string;
  projectedSpendUsd: number;
  status: "reserved";
  createdAt: string;
  policyDigest: string;
  receiptDigest: string;
}

export interface DurableModelUsageSettlement {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  providerResponseId: string;
  usageEvidenceDigest: string;
}

export type DurableModelCallStatus =
  | "reserved"
  | "dispatched"
  | "settled"
  | "ambiguous"
  | "verified-uncharged"
  | "cancelled-before-dispatch";

export interface AmbiguousModelUsageUnchargedReceipt {
  schemaVersion: "1.0";
  ledgerId: string;
  reservationId: string;
  requestDigest: string;
  resolution: "verified-uncharged";
  providerEvidenceDigest: string;
  signerKeyId: string;
  issuedAt: string;
  signature: string;
  receiptDigest: string;
}

function ambiguousReceiptPayload(receipt: Omit<AmbiguousModelUsageUnchargedReceipt, "signature" | "receiptDigest">): string {
  return canonical(receipt);
}

export function signAmbiguousModelUsageUnchargedReceipt(input: {
  ledgerId: string;
  reservationId: string;
  requestDigest: string;
  providerEvidenceDigest: string;
  signerKeyId: string;
  issuedAt: string;
  privateKey: KeyObject;
}): AmbiguousModelUsageUnchargedReceipt {
  const payload = {
    schemaVersion: "1.0" as const,
    ledgerId: input.ledgerId,
    reservationId: input.reservationId,
    requestDigest: input.requestDigest,
    resolution: "verified-uncharged" as const,
    providerEvidenceDigest: input.providerEvidenceDigest,
    signerKeyId: input.signerKeyId,
    issuedAt: input.issuedAt,
  };
  const signature = signBytes(null, Buffer.from(ambiguousReceiptPayload(payload)), input.privateKey).toString("base64");
  return { ...payload, signature, receiptDigest: digest({ ...payload, signature }) };
}

interface ReservationRow {
  reservation_id: string;
  seam_id: string;
  attempt_key: string;
  request_digest: string;
  projected_spend_usd: number;
  actual_spend_usd: number | null;
  status: DurableModelCallStatus;
  provider_response_id: string | null;
  usage_json: string | null;
  ambiguity_reason: string | null;
  reconciliation_evidence_digest: string | null;
  created_at: string;
  dispatched_at: string | null;
  settled_at: string | null;
  receipt_digest: string;
}

export interface DurableModelCallSnapshot {
  schemaVersion: "1.0";
  ledgerId: string;
  policyDigest: string;
  baselineSpendUsd: number;
  baselineCalls: number;
  settledSpendUsd: number;
  exposedSpendUsd: number;
  callsCounted: number;
  statuses: Record<DurableModelCallStatus, number>;
  unresolvedReservationIds: string[];
  warning: boolean;
  budgetExceeded: boolean;
  latestEventDigest: string;
  snapshotDigest: string;
}

interface AccountingEventRow {
  sequence: number;
  event_type: string;
  reservation_id: string;
  body_json: string;
  previous_event_digest: string;
  event_digest: string;
}

export class DurableModelCallAccounting {
  readonly policyDigest: string;
  private readonly database: DatabaseSync;

  constructor(
    statePath: string,
    readonly policy: DurableModelCallPolicy,
    baseline: { spentUsd: number; calls: number; warned: boolean } = { spentUsd: 0, calls: 0, warned: false },
    private readonly now: () => number = () => Date.now(),
  ) {
    this.validatePolicy(policy);
    finiteMoney(baseline.spentUsd, "Baseline spend", true);
    if (!Number.isInteger(baseline.calls) || baseline.calls < 0) throw new Error("Baseline calls must be a nonnegative integer.");
    this.policyDigest = digest(policy);
    this.database = new DatabaseSync(statePath);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS model_accounting_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        policy_json TEXT NOT NULL,
        policy_digest TEXT NOT NULL,
        baseline_spend_usd REAL NOT NULL,
        baseline_calls INTEGER NOT NULL,
        baseline_warned INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        meta_digest TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_call_reservations (
        reservation_id TEXT PRIMARY KEY,
        seam_id TEXT NOT NULL,
        attempt_key TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL,
        projected_spend_usd REAL NOT NULL,
        actual_spend_usd REAL,
        status TEXT NOT NULL,
        provider_response_id TEXT,
        usage_json TEXT,
        ambiguity_reason TEXT,
        reconciliation_evidence_digest TEXT,
        created_at TEXT NOT NULL,
        dispatched_at TEXT,
        settled_at TEXT,
        receipt_digest TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_accounting_events (
        sequence INTEGER PRIMARY KEY,
        event_type TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        body_json TEXT NOT NULL,
        previous_event_digest TEXT NOT NULL,
        event_digest TEXT NOT NULL UNIQUE
      );
    `);
    const existing = this.database.prepare("SELECT * FROM model_accounting_meta WHERE singleton=1").get() as {
      policy_json: string; policy_digest: string; baseline_spend_usd: number; baseline_calls: number; baseline_warned: number; created_at: string; meta_digest: string;
    } | undefined;
    if (!existing) {
      const createdAt = this.timestamp();
      const metaDigest = digest({ policy, policyDigest: this.policyDigest, baselineSpendUsd: baseline.spentUsd, baselineCalls: baseline.calls, baselineWarned: baseline.warned, createdAt });
      this.database.prepare(`INSERT INTO model_accounting_meta
        (singleton, policy_json, policy_digest, baseline_spend_usd, baseline_calls, baseline_warned, created_at, meta_digest)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?)`)
        .run(canonical(policy), this.policyDigest, baseline.spentUsd, baseline.calls, baseline.warned ? 1 : 0, createdAt, metaDigest);
    } else if (existing.policy_digest !== this.policyDigest || existing.policy_json !== canonical(policy)) {
      throw new Error("Durable model-call accounting policy cannot be changed after ledger creation.");
    }
    this.validateLedger();
  }

  private validatePolicy(policy: DurableModelCallPolicy): void {
    if (policy.schemaVersion !== "1.0") throw new Error("Unsupported durable model-call policy version.");
    identifier(policy.ledgerId, "Ledger ID");
    finiteMoney(policy.maximumCampaignSpendUsd, "Campaign spend ceiling");
    finiteMoney(policy.maximumSpendUsdPerCall, "Per-call spend ceiling");
    finiteMoney(policy.warningSpendUsd, "Spend warning threshold", true);
    if (policy.maximumSpendUsdPerCall > policy.maximumCampaignSpendUsd) throw new Error("Per-call spend ceiling cannot exceed the campaign ceiling.");
    if (policy.warningSpendUsd > policy.maximumCampaignSpendUsd) throw new Error("Warning threshold cannot exceed the campaign ceiling.");
    if (!Number.isInteger(policy.maximumCalls) || policy.maximumCalls < 1 || policy.maximumCalls > 1_000_000) throw new Error("Maximum calls must be a bounded positive integer.");
    if (policy.maximumConcurrentCalls !== 1) throw new Error("This accounting version permits exactly one unresolved call per ledger.");
    if (policy.ambiguityReconciliationTrust) {
      identifier(policy.ambiguityReconciliationTrust.signerKeyId, "Ambiguity reconciliation signer key ID");
      try { createPublicKey(policy.ambiguityReconciliationTrust.publicKeyPem); } catch { throw new Error("Ambiguity reconciliation trust requires a valid public key."); }
    }
  }

  private timestamp(): string {
    const value = this.now();
    if (!Number.isFinite(value) || value < 0) throw new Error("Model accounting clock returned an invalid timestamp.");
    return new Date(value).toISOString();
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  private reservationBody(row: Omit<ReservationRow, "receipt_digest">): unknown {
    return {
      schemaVersion: "1.0",
      ledgerId: this.policy.ledgerId,
      policyDigest: this.policyDigest,
      ...row,
    };
  }

  private readRow(reservationId: string): ReservationRow {
    const row = this.database.prepare("SELECT * FROM model_call_reservations WHERE reservation_id=?").get(reservationId) as ReservationRow | undefined;
    if (!row) throw new Error(`Unknown model-call reservation ${reservationId}.`);
    this.validateReservationRow(row);
    return row;
  }

  private validateReservationRow(row: ReservationRow): void {
    const { receipt_digest: receiptDigest, ...body } = row;
    if (!digestPattern.test(receiptDigest) || receiptDigest !== digest(this.reservationBody(body))) {
      throw new Error(`Model-call reservation ${row.reservation_id} failed its integrity check.`);
    }
  }

  private writeRow(row: Omit<ReservationRow, "receipt_digest">): ReservationRow {
    const receiptDigest = digest(this.reservationBody(row));
    this.database.prepare(`INSERT OR REPLACE INTO model_call_reservations
      (reservation_id,seam_id,attempt_key,request_digest,projected_spend_usd,actual_spend_usd,status,provider_response_id,usage_json,ambiguity_reason,reconciliation_evidence_digest,created_at,dispatched_at,settled_at,receipt_digest)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.reservation_id, row.seam_id, row.attempt_key, row.request_digest, row.projected_spend_usd, row.actual_spend_usd, row.status,
        row.provider_response_id, row.usage_json, row.ambiguity_reason, row.reconciliation_evidence_digest, row.created_at, row.dispatched_at, row.settled_at, receiptDigest);
    return { ...row, receipt_digest: receiptDigest };
  }

  private appendEvent(eventType: string, reservationId: string, body: unknown): string {
    const previous = this.database.prepare("SELECT sequence,event_digest FROM model_accounting_events ORDER BY sequence DESC LIMIT 1").get() as { sequence: number; event_digest: string } | undefined;
    const sequence = (previous?.sequence ?? 0) + 1;
    const previousEventDigest = previous?.event_digest ?? zeroDigest;
    const eventDigest = digest({ sequence, eventType, reservationId, body, previousEventDigest });
    this.database.prepare(`INSERT INTO model_accounting_events
      (sequence,event_type,reservation_id,body_json,previous_event_digest,event_digest) VALUES (?,?,?,?,?,?)`)
      .run(sequence, eventType, reservationId, canonical(body), previousEventDigest, eventDigest);
    return eventDigest;
  }

  private validateLedger(): void {
    const meta = this.database.prepare("SELECT * FROM model_accounting_meta WHERE singleton=1").get() as {
      policy_json: string; policy_digest: string; baseline_spend_usd: number; baseline_calls: number; baseline_warned: number; created_at: string; meta_digest: string;
    } | undefined;
    if (!meta || meta.policy_digest !== this.policyDigest || meta.policy_json !== canonical(this.policy)) throw new Error("Model accounting metadata failed its policy integrity check.");
    const expectedMetaDigest = digest({ policy: this.policy, policyDigest: this.policyDigest, baselineSpendUsd: meta.baseline_spend_usd, baselineCalls: meta.baseline_calls, baselineWarned: Boolean(meta.baseline_warned), createdAt: meta.created_at });
    if (meta.meta_digest !== expectedMetaDigest) throw new Error("Model accounting baseline failed its integrity check.");
    const rows = this.database.prepare("SELECT * FROM model_call_reservations ORDER BY created_at,reservation_id").all() as unknown as ReservationRow[];
    for (const row of rows) this.validateReservationRow(row);
    const events = this.database.prepare("SELECT * FROM model_accounting_events ORDER BY sequence").all() as unknown as AccountingEventRow[];
    let previous = zeroDigest;
    const latestByReservation = new Map<string, { eventType: string; receiptDigest: string }>();
    const transitionByReservation = new Map<string, string>();
    const allowedTransitions = new Set(["reserved>dispatched", "reserved>cancelled-before-dispatch", "reserved>ambiguous", "dispatched>settled", "dispatched>ambiguous", "ambiguous>verified-uncharged"]);
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      let body: unknown;
      try { body = JSON.parse(event.body_json); } catch { throw new Error(`Model accounting event ${event.sequence} has invalid JSON.`); }
      const expected = digest({ sequence: event.sequence, eventType: event.event_type, reservationId: event.reservation_id, body, previousEventDigest: previous });
      if (event.sequence !== index + 1 || event.previous_event_digest !== previous || event.event_digest !== expected) throw new Error(`Model accounting event chain failed at sequence ${event.sequence}.`);
      if (!body || typeof body !== "object" || Array.isArray(body) || !digestPattern.test(String((body as { receiptDigest?: unknown }).receiptDigest ?? ""))) throw new Error(`Model accounting event ${event.sequence} does not bind a reservation receipt.`);
      const priorType = transitionByReservation.get(event.reservation_id);
      if ((!priorType && event.event_type !== "reserved") || (priorType && !allowedTransitions.has(`${priorType}>${event.event_type}`))) throw new Error(`Model accounting event ${event.sequence} has an invalid state transition.`);
      transitionByReservation.set(event.reservation_id, event.event_type);
      latestByReservation.set(event.reservation_id, { eventType: event.event_type, receiptDigest: String((body as { receiptDigest: string }).receiptDigest) });
      previous = event.event_digest;
    }
    if (events.some((event) => !rows.some((row) => row.reservation_id === event.reservation_id))) throw new Error("Model accounting event references an unknown reservation.");
    for (const row of rows) {
      const latest = latestByReservation.get(row.reservation_id);
      if (!latest || latest.eventType !== row.status || latest.receiptDigest !== row.receipt_digest) throw new Error(`Model-call reservation ${row.reservation_id} does not match its latest accounting event.`);
    }
  }

  reserve(input: DurableModelCallReservationInput): DurableModelCallReservation {
    identifier(input.seamId, "Model seam ID");
    identifier(input.attemptKey, "Model attempt key");
    if (!digestPattern.test(input.requestDigest)) throw new Error("Model request digest must be SHA-256.");
    finiteMoney(input.projectedSpendUsd, "Projected model spend");
    if (input.projectedSpendUsd > this.policy.maximumSpendUsdPerCall) throw new Error("Projected model spend exceeds the per-call ceiling.");
    return this.transaction(() => {
      this.validateLedger();
      const existing = this.database.prepare("SELECT status FROM model_call_reservations WHERE attempt_key=?").get(input.attemptKey) as { status: string } | undefined;
      if (existing) throw new Error(`Model attempt key already exists with status ${existing.status}; retry requires a new reviewed attempt.`);
      const snapshot = this.snapshotInternal();
      if (snapshot.unresolvedReservationIds.length > 0) throw new Error("An unresolved model-call reservation blocks every later call in this ledger.");
      if (snapshot.callsCounted >= this.policy.maximumCalls) throw new Error("Model-call count ceiling is exhausted.");
      if (snapshot.exposedSpendUsd + input.projectedSpendUsd > this.policy.maximumCampaignSpendUsd + 1e-12) throw new Error("Model campaign spend ceiling would be exceeded.");
      const createdAt = this.timestamp();
      const reservationId = digest({ ledgerId: this.policy.ledgerId, policyDigest: this.policyDigest, ...input, createdAt });
      const row = this.writeRow({
        reservation_id: reservationId,
        seam_id: input.seamId,
        attempt_key: input.attemptKey,
        request_digest: input.requestDigest,
        projected_spend_usd: input.projectedSpendUsd,
        actual_spend_usd: null,
        status: "reserved",
        provider_response_id: null,
        usage_json: null,
        ambiguity_reason: null,
        reconciliation_evidence_digest: null,
        created_at: createdAt,
        dispatched_at: null,
        settled_at: null,
      });
      this.appendEvent("reserved", reservationId, { requestDigest: input.requestDigest, projectedSpendUsd: input.projectedSpendUsd, receiptDigest: row.receipt_digest });
      return {
        schemaVersion: "1.0",
        reservationId,
        ledgerId: this.policy.ledgerId,
        seamId: input.seamId,
        attemptKey: input.attemptKey,
        requestDigest: input.requestDigest,
        projectedSpendUsd: input.projectedSpendUsd,
        status: "reserved",
        createdAt,
        policyDigest: this.policyDigest,
        receiptDigest: row.receipt_digest,
      };
    });
  }

  markDispatched(reservationId: string): void {
    this.transaction(() => {
      this.validateLedger();
      const current = this.readRow(reservationId);
      if (current.status !== "reserved") throw new Error(`Only a reserved model call may dispatch; current status is ${current.status}.`);
      const { receipt_digest: _receipt, ...body } = current;
      const row = this.writeRow({ ...body, status: "dispatched", dispatched_at: this.timestamp() });
      this.appendEvent("dispatched", reservationId, { requestDigest: row.request_digest, receiptDigest: row.receipt_digest });
    });
  }

  cancelBeforeDispatch(reservationId: string, reason: string): void {
    if (!reason.trim() || reason.length > 500) throw new Error("Pre-dispatch cancellation requires a bounded reason.");
    this.transaction(() => {
      this.validateLedger();
      const current = this.readRow(reservationId);
      if (current.status !== "reserved") throw new Error("Only a never-dispatched reservation can be cancelled locally.");
      const { receipt_digest: _receipt, ...body } = current;
      const row = this.writeRow({ ...body, status: "cancelled-before-dispatch", ambiguity_reason: reason, settled_at: this.timestamp() });
      this.appendEvent("cancelled-before-dispatch", reservationId, { reason, receiptDigest: row.receipt_digest });
    });
  }

  markAmbiguous(reservationId: string, reason: string): void {
    if (!reason.trim() || reason.length > 500) throw new Error("Ambiguous model usage requires a bounded reason.");
    this.transaction(() => {
      this.validateLedger();
      const current = this.readRow(reservationId);
      if (current.status !== "reserved" && current.status !== "dispatched") throw new Error(`Cannot mark ${current.status} model usage ambiguous.`);
      const { receipt_digest: _receipt, ...body } = current;
      const row = this.writeRow({ ...body, status: "ambiguous", ambiguity_reason: reason, settled_at: this.timestamp() });
      this.appendEvent("ambiguous", reservationId, { reason, receiptDigest: row.receipt_digest });
    });
  }

  settle(reservationId: string, usage: DurableModelUsageSettlement): { snapshot: DurableModelCallSnapshot; overrun: boolean } {
    for (const [label, value] of [["Input tokens", usage.inputTokens], ["Cached input tokens", usage.cachedInputTokens], ["Output tokens", usage.outputTokens]] as const) {
      if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative integer.`);
    }
    if (usage.cachedInputTokens > usage.inputTokens) throw new Error("Cached input tokens cannot exceed input tokens.");
    finiteMoney(usage.costUsd, "Settled model cost", true);
    if (!usage.providerResponseId.trim() || usage.providerResponseId.length > 500 || !digestPattern.test(usage.usageEvidenceDigest)) throw new Error("Settlement requires a bounded provider response ID and usage evidence digest.");
    return this.transaction(() => {
      this.validateLedger();
      const current = this.readRow(reservationId);
      if (current.status !== "dispatched") throw new Error(`Only a dispatched call can settle; current status is ${current.status}.`);
      const { receipt_digest: _receipt, ...body } = current;
      const settledAt = this.timestamp();
      const usageJson = canonical(usage);
      const row = this.writeRow({ ...body, status: "settled", actual_spend_usd: usage.costUsd, provider_response_id: usage.providerResponseId, usage_json: usageJson, settled_at: settledAt });
      this.appendEvent("settled", reservationId, { usage, receiptDigest: row.receipt_digest });
      const snapshot = this.snapshotInternal();
      const overrun = usage.costUsd > this.policy.maximumSpendUsdPerCall + 1e-12 || snapshot.settledSpendUsd > this.policy.maximumCampaignSpendUsd + 1e-12;
      return { snapshot, overrun };
    });
  }

  resolveAmbiguousUncharged(receipt: AmbiguousModelUsageUnchargedReceipt): DurableModelCallSnapshot {
    const trust = this.policy.ambiguityReconciliationTrust;
    if (!trust) throw new Error("This ledger has no pinned authority for ambiguous-usage reconciliation.");
    if (receipt.schemaVersion !== "1.0" || receipt.ledgerId !== this.policy.ledgerId || receipt.resolution !== "verified-uncharged"
      || receipt.signerKeyId !== trust.signerKeyId || !digestPattern.test(receipt.providerEvidenceDigest) || !digestPattern.test(receipt.requestDigest)
      || !digestPattern.test(receipt.reservationId) || !digestPattern.test(receipt.receiptDigest)) throw new Error("Ambiguous-usage reconciliation receipt has an invalid identity or shape.");
    const { signature, receiptDigest, ...payload } = receipt;
    if (receiptDigest !== digest({ ...payload, signature })) throw new Error("Ambiguous-usage reconciliation receipt digest is invalid.");
    let signatureBytes: Buffer;
    try { signatureBytes = Buffer.from(signature, "base64"); } catch { throw new Error("Ambiguous-usage reconciliation signature is malformed."); }
    if (!verifyBytes(null, Buffer.from(ambiguousReceiptPayload(payload)), createPublicKey(trust.publicKeyPem), signatureBytes)) throw new Error("Ambiguous-usage reconciliation signature is invalid.");
    return this.transaction(() => {
      this.validateLedger();
      const current = this.readRow(receipt.reservationId);
      if (current.status !== "ambiguous") throw new Error("Only ambiguous model usage can be resolved as verified uncharged.");
      if (current.request_digest !== receipt.requestDigest) throw new Error("Ambiguous-usage reconciliation targets a different request.");
      const issuedAt = Date.parse(receipt.issuedAt);
      if (!Number.isFinite(issuedAt) || issuedAt < Date.parse(current.created_at) || issuedAt > this.now() + 300_000) throw new Error("Ambiguous-usage reconciliation time is outside the trusted reservation window.");
      const { receipt_digest: _receipt, ...body } = current;
      const row = this.writeRow({ ...body, status: "verified-uncharged", actual_spend_usd: 0, reconciliation_evidence_digest: receipt.receiptDigest, settled_at: this.timestamp() });
      this.appendEvent("verified-uncharged", receipt.reservationId, { reconciliationReceiptDigest: receipt.receiptDigest, providerEvidenceDigest: receipt.providerEvidenceDigest, receiptDigest: row.receipt_digest });
      return this.snapshotInternal();
    });
  }

  private snapshotInternal(): DurableModelCallSnapshot {
    const meta = this.database.prepare("SELECT * FROM model_accounting_meta WHERE singleton=1").get() as { baseline_spend_usd: number; baseline_calls: number; baseline_warned: number };
    const rows = this.database.prepare("SELECT * FROM model_call_reservations ORDER BY created_at,reservation_id").all() as unknown as ReservationRow[];
    const statuses: Record<DurableModelCallStatus, number> = { reserved: 0, dispatched: 0, settled: 0, ambiguous: 0, "verified-uncharged": 0, "cancelled-before-dispatch": 0 };
    for (const row of rows) { this.validateReservationRow(row); statuses[row.status] += 1; }
    const settled = rows.filter((row) => row.status === "settled").reduce((sum, row) => sum + Number(row.actual_spend_usd ?? 0), 0);
    const exposure = rows.filter((row) => ["reserved", "dispatched", "ambiguous"].includes(row.status)).reduce((sum, row) => sum + row.projected_spend_usd, 0);
    const settledSpendUsd = Number((meta.baseline_spend_usd + settled).toFixed(12));
    const exposedSpendUsd = Number((settledSpendUsd + exposure).toFixed(12));
    const callsCounted = meta.baseline_calls + rows.filter((row) => row.status !== "cancelled-before-dispatch").length;
    const unresolvedReservationIds = rows.filter((row) => ["reserved", "dispatched", "ambiguous"].includes(row.status)).map((row) => row.reservation_id);
    const latest = this.database.prepare("SELECT event_digest FROM model_accounting_events ORDER BY sequence DESC LIMIT 1").get() as { event_digest: string } | undefined;
    const body = {
      schemaVersion: "1.0" as const,
      ledgerId: this.policy.ledgerId,
      policyDigest: this.policyDigest,
      baselineSpendUsd: meta.baseline_spend_usd,
      baselineCalls: meta.baseline_calls,
      settledSpendUsd,
      exposedSpendUsd,
      callsCounted,
      statuses,
      unresolvedReservationIds,
      warning: Boolean(meta.baseline_warned) || settledSpendUsd >= this.policy.warningSpendUsd,
      budgetExceeded: settledSpendUsd > this.policy.maximumCampaignSpendUsd + 1e-12,
      latestEventDigest: latest?.event_digest ?? zeroDigest,
    };
    return { ...body, snapshotDigest: digest(body) };
  }

  snapshot(): DurableModelCallSnapshot {
    this.validateLedger();
    return this.snapshotInternal();
  }

  close(): void {
    this.database.close();
  }
}
