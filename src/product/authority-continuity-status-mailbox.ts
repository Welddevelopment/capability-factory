import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AuthorityContinuityLiveStatusChallenge, AuthorityContinuityLiveStatusProvider, AuthorityContinuityLiveStatusResponse } from "./authority-continuity-enrollment-provider.js";

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,179}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const noncePattern = /^[a-f0-9]{32,128}$/;
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value !== null && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);
const digest = (value: unknown): string => createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");

export interface AuthorityContinuityStatusMailboxIdentity {
  schemaVersion: "1.0";
  providerId: string;
  policyId: string;
  tenantId: string;
  installationId: string;
  workspaceId: string;
  authorityContractDigest: string;
  trustConfigurationDigest: string;
  runtimeReleaseDigest: string;
  providerSignerKeyId: string;
  providerSignerPublicKeyDigest: string;
}

export class DurableLocalAuthorityContinuityStatusMailbox implements AuthorityContinuityLiveStatusProvider {
  private readonly database: DatabaseSync;
  private readonly timeoutMilliseconds: number;
  private closed = false;

  constructor(readonly statePath: string, readonly identity: AuthorityContinuityStatusMailboxIdentity, options: { timeoutMilliseconds?: number } = {}) {
    if (identity.schemaVersion !== "1.0" || ![identity.providerId, identity.policyId, identity.tenantId, identity.installationId, identity.workspaceId, identity.providerSignerKeyId].every((value) => identifier.test(value))
      || ![identity.authorityContractDigest, identity.trustConfigurationDigest, identity.runtimeReleaseDigest, identity.providerSignerPublicKeyDigest].every((value) => digestPattern.test(value))) throw new Error("Authority continuity mailbox identity is malformed.");
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 500;
    if (!Number.isInteger(this.timeoutMilliseconds) || this.timeoutMilliseconds < 25 || this.timeoutMilliseconds > 5_000) throw new Error("Authority continuity mailbox timeout must be between 25 ms and five seconds.");
    if (statePath !== ":memory:") mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(statePath);
    this.database.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    if (statePath !== ":memory:") chmodSync(statePath, 0o600);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS authority_continuity_mailbox_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS authority_continuity_mailbox_requests(
        challenge_nonce TEXT PRIMARY KEY,
        challenge_digest TEXT NOT NULL,
        challenge_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','responded')),
        response_json TEXT,
        created_at TEXT NOT NULL,
        responded_at TEXT
      );
    `);
    const rows = this.database.prepare("SELECT key,value FROM authority_continuity_mailbox_meta ORDER BY key").all() as Array<{ key: string; value: string }>;
    const identityDigest = digest(identity);
    if (rows.length === 0) {
      const insert = this.database.prepare("INSERT INTO authority_continuity_mailbox_meta(key,value) VALUES(?,?)");
      insert.run("schema_version", "1.0"); insert.run("identity_digest", identityDigest); insert.run("identity_json", canonical(identity));
    } else {
      const meta = Object.fromEntries(rows.map((row) => [row.key, row.value]));
      if (meta.schema_version !== "1.0" || meta.identity_digest !== identityDigest || meta.identity_json !== canonical(identity)) { this.database.close(); this.closed = true; throw new Error("Authority continuity mailbox identity is substituted or incompatible."); }
    }
  }

  queryCurrent(challenge: AuthorityContinuityLiveStatusChallenge): AuthorityContinuityLiveStatusResponse {
    this.ensureOpen(); this.assertChallenge(challenge);
    const challengeJson = canonical(challenge), challengeDigest = digest(challenge), createdAt = new Date().toISOString();
    try { this.database.prepare("INSERT INTO authority_continuity_mailbox_requests(challenge_nonce,challenge_digest,challenge_json,status,created_at) VALUES(?,?,?,'pending',?)").run(challenge.challengeNonce, challengeDigest, challengeJson, createdAt); }
    catch { throw new Error("Authority continuity mailbox challenge was replayed or could not be durably enqueued."); }
    const deadline = Date.now() + this.timeoutMilliseconds, waitCell = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() <= deadline) {
      const row = this.database.prepare("SELECT challenge_digest,challenge_json,status,response_json FROM authority_continuity_mailbox_requests WHERE challenge_nonce=?").get(challenge.challengeNonce) as { challenge_digest: string; challenge_json: string; status: string; response_json: string | null } | undefined;
      if (!row || row.challenge_digest !== challengeDigest || row.challenge_json !== challengeJson) throw new Error("Authority continuity mailbox challenge changed after enqueue.");
      if (row.status === "responded") {
        if (!row.response_json || Buffer.byteLength(row.response_json) > 64 * 1024) throw new Error("Authority continuity mailbox response is missing or oversized.");
        return JSON.parse(row.response_json) as AuthorityContinuityLiveStatusResponse;
      }
      if (row.status !== "pending" || row.response_json !== null) throw new Error("Authority continuity mailbox state is malformed.");
      Atomics.wait(waitCell, 0, 0, Math.min(5, Math.max(1, deadline - Date.now())));
    }
    throw new Error("Authority continuity status provider was unavailable before the bounded mailbox timeout.");
  }

  close(): void { if (!this.closed) { this.closed = true; this.database.close(); } }
  private ensureOpen(): void { if (this.closed) throw new Error("Authority continuity mailbox is closed."); }
  private assertChallenge(challenge: AuthorityContinuityLiveStatusChallenge): void {
    if (challenge.schemaVersion !== "1.0" || challenge.kind !== "authority-continuity-live-status-challenge" || !noncePattern.test(challenge.challengeNonce) || /^0+$/.test(challenge.challengeNonce)
      || challenge.providerId !== this.identity.providerId || challenge.policyId !== this.identity.policyId || challenge.tenantId !== this.identity.tenantId || challenge.installationId !== this.identity.installationId
      || challenge.workspaceId !== this.identity.workspaceId || challenge.authorityContractDigest !== this.identity.authorityContractDigest || challenge.trustConfigurationDigest !== this.identity.trustConfigurationDigest
      || challenge.runtimeReleaseDigest !== this.identity.runtimeReleaseDigest) throw new Error("Authority continuity mailbox challenge differs from its pinned installation identity.");
  }
}
