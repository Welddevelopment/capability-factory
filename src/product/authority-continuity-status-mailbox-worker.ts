import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { assertAuthorityContinuityProviderState, signAuthorityContinuityLiveStatusResponse, type AuthorityContinuityLiveStatusChallenge, type AuthorityContinuityProviderStateRecord } from "./authority-continuity-enrollment-provider.js";
import type { AuthorityContinuityStatusMailboxIdentity } from "./authority-continuity-status-mailbox.js";

const [mailboxPath, identityPath, statePath, privateKeyPath] = process.argv.slice(2);
if (!mailboxPath || !identityPath || !statePath || !privateKeyPath) throw new Error("Authority continuity mailbox worker requires mailbox, identity, state and private-key paths.");
const identity = JSON.parse(readFileSync(identityPath, "utf8")) as AuthorityContinuityStatusMailboxIdentity;
const privateKey = createPrivateKey(readFileSync(privateKeyPath, "utf8"));
const publicKeyDigest = createHash("sha256").update(createPublicKey(privateKey).export({ type: "spki", format: "der" })).digest("hex");
if (privateKey.asymmetricKeyType !== "ed25519" || publicKeyDigest !== identity.providerSignerPublicKeyDigest) throw new Error("Authority continuity mailbox worker key differs from pinned provider identity.");
const database = new DatabaseSync(mailboxPath);
database.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
const meta = Object.fromEntries((database.prepare("SELECT key,value FROM authority_continuity_mailbox_meta").all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]));
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value !== null && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);
const digest = (value: unknown): string => createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
if (meta.schema_version !== "1.0" || meta.identity_digest !== digest(identity) || meta.identity_json !== canonical(identity)) throw new Error("Authority continuity mailbox worker found substituted mailbox identity.");

let stopping = false;
const timer = setInterval(() => {
  if (stopping) return;
  const pending = database.prepare("SELECT challenge_nonce,challenge_digest,challenge_json FROM authority_continuity_mailbox_requests WHERE status='pending' ORDER BY rowid LIMIT 20").all() as Array<{ challenge_nonce: string; challenge_digest: string; challenge_json: string }>;
  for (const row of pending) {
    try {
      const challenge = JSON.parse(row.challenge_json) as AuthorityContinuityLiveStatusChallenge;
      if (digest(challenge) !== row.challenge_digest || challenge.challengeNonce !== row.challenge_nonce || challenge.providerId !== identity.providerId || challenge.policyId !== identity.policyId || challenge.tenantId !== identity.tenantId || challenge.installationId !== identity.installationId || challenge.workspaceId !== identity.workspaceId || challenge.authorityContractDigest !== identity.authorityContractDigest || challenge.trustConfigurationDigest !== identity.trustConfigurationDigest || challenge.runtimeReleaseDigest !== identity.runtimeReleaseDigest) throw new Error("challenge-identity");
      const state = JSON.parse(readFileSync(statePath, "utf8")) as AuthorityContinuityProviderStateRecord;
      assertAuthorityContinuityProviderState({ record: state, providerPublicKey: createPublicKey(privateKey), expected: identity });
      const issuedAt = new Date().toISOString(), response = signAuthorityContinuityLiveStatusResponse({ ...challenge, statusEpoch: state.statusEpoch, state: state.state, issuedAt, expiresAt: new Date(Date.parse(issuedAt) + 5_000).toISOString(), providerSignerKeyId: identity.providerSignerKeyId, privateKey });
      database.prepare("UPDATE authority_continuity_mailbox_requests SET status='responded',response_json=?,responded_at=? WHERE challenge_nonce=? AND status='pending' AND challenge_digest=?").run(JSON.stringify(response), issuedAt, row.challenge_nonce, row.challenge_digest);
    } catch { /* malformed work remains pending and fails closed at the caller timeout */ }
  }
}, 2);

process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid, identityDigest: digest(identity) })}\n`);
process.on("SIGTERM", () => { stopping = true; clearInterval(timer); database.close(); process.exit(0); });
