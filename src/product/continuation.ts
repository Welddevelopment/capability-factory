import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { VerificationCheck } from "./contracts.js";
import type { ValidatedGoalPlan } from "./goal-coordination.js";
import type { GoalCoordinationState } from "./goal-scheduler.js";

export const GOAL_CONTINUATION_SCHEMA_VERSION = "1.0" as const;

export interface GoalContinuationGrant {
  schemaVersion: typeof GOAL_CONTINUATION_SCHEMA_VERSION;
  grantId: string;
  tenantId: string;
  parentGoalId: string;
  workItemId: string;
  planDigest: string;
  expectedStateVersion: number;
  handoffDigest: string;
  kind: "permission-approved" | "credential-provided" | "combined";
  authorizedMissing: string[];
  preconditions: VerificationCheck[];
  issuedBy: string;
  issuedAt: string;
  expiresAt: string;
  authorityKeyId: string;
  signature: string;
}

export interface GoalContinuationGrantSigner {
  readonly keyId: string;
  sign(payload: Record<string, unknown>): string;
}

export interface GoalContinuationGrantVerifier {
  verify(keyId: string, payload: Record<string, unknown>, signature: string): boolean;
}

export interface GoalContinuationLivePreconditionVerifier {
  verify(grant: GoalContinuationGrant, plan: ValidatedGoalPlan, state: GoalCoordinationState): Promise<VerificationCheck[]>;
}

export interface GoalContinuationRevocationRecord {
  schemaVersion: "1.0";
  grantId: string;
  reason: string;
  revokedBy: string;
  revokedAt: string;
}

export interface GoalContinuationRevocationVerifier {
  get(grantId: string): GoalContinuationRevocationRecord | undefined;
}

/** Customer-local immutable revocation files; production may replace this with KMS/policy infrastructure. */
export class FileGoalContinuationRevocationStore implements GoalContinuationRevocationVerifier {
  constructor(private readonly rootDirectory: string) {
    fs.mkdirSync(rootDirectory, { recursive: true, mode: 0o700 });
  }

  revoke(grantId: string, reason: string, revokedBy: string, revokedAt = new Date().toISOString()): GoalContinuationRevocationRecord {
    if (!/^[a-f0-9]{32}$/.test(grantId)) throw new Error("Continuation grant ID is invalid.");
    if (!reason.trim() || !revokedBy.trim()) throw new Error("Continuation revocation requires a reason and actor.");
    const record: GoalContinuationRevocationRecord = { schemaVersion: "1.0", grantId, reason, revokedBy, revokedAt };
    const filename = this.filename(grantId);
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    try {
      fs.linkSync(temporary, filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = this.get(grantId);
      if (!existing || existing.reason !== reason || existing.revokedBy !== revokedBy) {
        throw new Error("Continuation grant already has a different immutable revocation record.");
      }
      return existing;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    fs.chmodSync(filename, 0o600);
    return structuredClone(record);
  }

  get(grantId: string): GoalContinuationRevocationRecord | undefined {
    if (!/^[a-f0-9]{32}$/.test(grantId)) return undefined;
    const filename = this.filename(grantId);
    if (!fs.existsSync(filename)) return undefined;
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Continuation revocation record is unsafe.");
    const value = JSON.parse(fs.readFileSync(filename, "utf8")) as GoalContinuationRevocationRecord;
    if (value.schemaVersion !== "1.0" || value.grantId !== grantId || !value.reason || !value.revokedBy || Number.isNaN(Date.parse(value.revokedAt))) {
      throw new Error("Continuation revocation record is invalid.");
    }
    return structuredClone(value);
  }

  private filename(grantId: string): string { return path.join(this.rootDirectory, `${grantId}.json`); }
}

export type GoalContinuationChangeAssessment =
  | { decision: "exact-resume"; detail: string }
  | { decision: "new-validated-goal-required"; detail: string; changed: string[] };

/** Distinguishes a true unblock from a changed action that must enter normal planning again under a new parent goal. */
export function assessGoalContinuationChange(input: {
  item: ValidatedGoalPlan["workItems"][number];
  operationKey: string;
  targetAliases: string[];
  methods: ValidatedGoalPlan["workItems"][number]["authority"]["methods"];
  authorizedMissing: string[];
}): GoalContinuationChangeAssessment {
  const changed: string[] = [];
  const sameSet = (left: readonly string[], right: readonly string[]) => left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
  if (input.operationKey !== input.item.operationKey) changed.push("operation");
  if (!sameSet(input.targetAliases, input.item.targetAliases)) changed.push("targets");
  if (!sameSet(input.methods, input.item.authority.methods)) changed.push("methods");
  if (!sameSet(input.authorizedMissing, input.item.authority.missing)) changed.push("authority-set");
  return changed.length === 0
    ? { decision: "exact-resume", detail: "Only the exact saved handoff is being unblocked; reconcile before any action." }
    : { decision: "new-validated-goal-required", detail: "The requested approval changes the saved action. Submit a new parent goal through trusted planning; do not mutate or continue this plan.", changed };
}

/** Customer-local HMAC reference. Production may replace this with KMS/HSM signing. */
export class HmacGoalContinuationAuthority implements GoalContinuationGrantSigner, GoalContinuationGrantVerifier {
  constructor(readonly keyId: string, private readonly secret: string) {
    if (!bounded.safeParse(keyId).success) throw new Error("Continuation authority key ID is invalid.");
    if (Buffer.byteLength(secret) < 32) throw new Error("Continuation authority secret must contain at least 32 bytes.");
  }

  sign(payload: Record<string, unknown>): string {
    return createHmac("sha256", this.secret).update(canonical(payload)).digest("hex");
  }

  verify(keyId: string, payload: Record<string, unknown>, signature: string): boolean {
    if (keyId !== this.keyId || !/^[a-f0-9]{64}$/.test(signature)) return false;
    const expected = Buffer.from(this.sign(payload), "hex");
    const actual = Buffer.from(signature, "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}

const bounded = z.string().min(1).max(200);
export const goalContinuationGrantSchema: z.ZodType<GoalContinuationGrant> = z.object({
  schemaVersion: z.literal(GOAL_CONTINUATION_SCHEMA_VERSION),
  grantId: z.string().regex(/^[a-f0-9]{32}$/),
  tenantId: bounded,
  parentGoalId: bounded,
  workItemId: bounded,
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expectedStateVersion: z.number().int().nonnegative(),
  handoffDigest: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(["permission-approved", "credential-provided", "combined"]),
  authorizedMissing: z.array(bounded).min(1).max(32),
  preconditions: z.array(z.object({ id: bounded, passed: z.boolean(), detail: z.string().min(1).max(1_000) }).strict()).min(1).max(32),
  issuedBy: bounded,
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  authorityKeyId: bounded,
  signature: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function continuationPlanDigest(plan: ValidatedGoalPlan): string {
  return digest(plan);
}

export function goalHandoffDigest(state: GoalCoordinationState, workItemId: string): string {
  const item = state.items[workItemId];
  if (!item?.handoff) throw new Error("The requested work item has no handoff to continue.");
  return digest({
    tenantId: state.tenantId,
    parentGoalId: state.parentGoalId,
    requestId: state.requestId,
    workItemId,
    planDigest: state.planDigest,
    handoff: item.handoff,
  });
}

export function createGoalContinuationGrant(input: {
  plan: ValidatedGoalPlan;
  state: GoalCoordinationState;
  workItemId: string;
  kind: GoalContinuationGrant["kind"];
  authorizedMissing: string[];
  preconditions: VerificationCheck[];
  issuedBy: string;
  issuedAt?: string;
  expiresAt: string;
  authority: GoalContinuationGrantSigner;
}): GoalContinuationGrant {
  const item = input.state.items[input.workItemId];
  const planned = input.plan.workItems.find((candidate) => candidate.workItemId === input.workItemId);
  if (!item || !planned) throw new Error("Continuation work item is not part of the saved plan.");
  if (item.lifecycle !== "blocked" || !item.handoff) throw new Error("Only an exact blocked handoff can receive a continuation grant.");
  if (item.handoff.reason !== "authority-missing" && item.handoff.reason !== "policy-denied") {
    throw new Error("Only an authority or policy handoff can be continued by an approval grant.");
  }
  const expected = [...planned.authority.missing].sort();
  const authorized = [...new Set(input.authorizedMissing)].sort();
  if (expected.length === 0 || expected.length !== authorized.length || !expected.every((value, index) => value === authorized[index])) {
    throw new Error("A continuation grant must satisfy the exact missing authority set; partial or broader grants are rejected.");
  }
  if (input.preconditions.length === 0 || input.preconditions.some((check) => !check.passed)) {
    throw new Error("Every customer-local continuation precondition must pass before a grant can be issued.");
  }
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  if (Date.parse(input.expiresAt) <= Date.parse(issuedAt)) throw new Error("Continuation expiry must be after issuance.");
  const payload = {
    schemaVersion: GOAL_CONTINUATION_SCHEMA_VERSION,
    tenantId: input.state.tenantId,
    parentGoalId: input.state.parentGoalId,
    workItemId: input.workItemId,
    planDigest: continuationPlanDigest(input.plan),
    expectedStateVersion: input.state.version,
    handoffDigest: goalHandoffDigest(input.state, input.workItemId),
    kind: input.kind,
    authorizedMissing: authorized,
    preconditions: structuredClone(input.preconditions),
    issuedBy: input.issuedBy,
    issuedAt,
    expiresAt: input.expiresAt,
    authorityKeyId: input.authority.keyId,
  } as const;
  const unsigned = { ...payload, grantId: digest(payload).slice(0, 32) };
  return goalContinuationGrantSchema.parse({ ...unsigned, signature: input.authority.sign(unsigned) });
}

function verifyGrantAuthenticity(
  raw: GoalContinuationGrant,
  authority: GoalContinuationGrantVerifier,
): GoalContinuationGrant {
  const grant = goalContinuationGrantSchema.parse(raw);
  const { signature, ...unsigned } = grant;
  if (!authority.verify(grant.authorityKeyId, unsigned, signature)) {
    throw new Error("Continuation grant signature is invalid.");
  }
  return grant;
}

export function authenticateGoalContinuationGrant(
  raw: GoalContinuationGrant,
  authority: GoalContinuationGrantVerifier,
): GoalContinuationGrant {
  return verifyGrantAuthenticity(raw, authority);
}

export function validateGoalContinuationGrant(
  raw: GoalContinuationGrant,
  plan: ValidatedGoalPlan,
  state: GoalCoordinationState,
  authority: GoalContinuationGrantVerifier,
): GoalContinuationGrant {
  const grant = verifyGrantAuthenticity(raw, authority);
  if (grant.tenantId !== state.tenantId || grant.parentGoalId !== state.parentGoalId) throw new Error("Continuation grant belongs to another goal.");
  if (grant.planDigest !== continuationPlanDigest(plan) || grant.planDigest !== state.planDigest) throw new Error("Continuation grant does not match the immutable saved plan.");
  if (grant.expectedStateVersion !== state.version) throw new Error("Continuation grant targets a stale goal-state version.");
  if (Date.parse(grant.expiresAt) <= Date.now()) throw new Error("Continuation grant has expired.");
  if (grant.preconditions.some((check) => !check.passed)) throw new Error("Continuation grant contains a failed precondition.");
  const item = state.items[grant.workItemId];
  const planned = plan.workItems.find((candidate) => candidate.workItemId === grant.workItemId);
  if (!item || !planned || item.lifecycle !== "blocked" || !item.handoff) throw new Error("Continuation target is no longer an open blocked handoff.");
  if (goalHandoffDigest(state, grant.workItemId) !== grant.handoffDigest) throw new Error("Continuation handoff changed after the grant was issued.");
  const expected = [...planned.authority.missing].sort();
  const actual = [...grant.authorizedMissing].sort();
  if (expected.length !== actual.length || !expected.every((value, index) => value === actual[index])) {
    throw new Error("Continuation grant no longer matches the exact missing authority set.");
  }
  return grant;
}
