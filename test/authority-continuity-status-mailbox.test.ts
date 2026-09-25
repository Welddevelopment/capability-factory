import { createHash, generateKeyPairSync } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAuthorityContinuityEnrollmentGuard,
  signAuthorityContinuityProviderState,
  signAuthorityContinuityCurrentnessResponse,
  signAuthorityContinuityEnrollmentPolicy,
} from "../src/product/authority-continuity-enrollment-provider.js";
import { DurableAuthorityContinuityStopLedger } from "../src/product/authority-continuity-stop-ledger.js";
import { DurableLocalAuthorityContinuityStatusMailbox, type AuthorityContinuityStatusMailboxIdentity } from "../src/product/authority-continuity-status-mailbox.js";

const roots: string[] = [], children: ChildProcessWithoutNullStreams[] = [], closers: Array<() => void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) { try { close(); } catch { /* closed */ } }
  for (const child of children.splice(0).reverse()) if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise<void>((resolve) => child.once("exit", () => resolve())); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

async function launch(input: { mailboxPath: string; identityPath: string; statePath: string; privateKeyPath: string }): Promise<ChildProcessWithoutNullStreams> {
  const worker = join(process.cwd(), "src/product/authority-continuity-status-mailbox-worker.ts"), tsx = join(process.cwd(), "node_modules/tsx/dist/loader.mjs");
  const child = spawn(process.execPath, ["--import", tsx, worker, input.mailboxPath, input.identityPath, input.statePath, input.privateKeyPath]); children.push(child);
  await new Promise<void>((resolve, reject) => {
    let stdout = "", stderr = "";
    const timer = setTimeout(() => reject(new Error(`Mailbox worker timeout: ${stderr}`)), 5_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); if (stdout.includes("\n")) { clearTimeout(timer); const ready = JSON.parse(stdout.slice(0, stdout.indexOf("\n"))) as { ready: boolean }; if (ready.ready) resolve(); else reject(new Error("Mailbox worker not ready.")); } });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(`Mailbox worker exited before ready: ${stderr}`)); });
  });
  return child;
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

describe("CF-074 customer-local continuity status process mailbox", () => {
  it("survives provider restart, stops live suspension and unavailability, and durably records redacted receipts", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf074-mailbox-")); roots.push(root);
    const provider = generateKeyPairSync("ed25519"), now = Date.now(), authorityContractDigest = digest("authority"), trustConfigurationDigest = digest("trust"), runtimeReleaseDigest = digest("runtime"), challengeNonce = digest("boot").slice(0, 48);
    const identity: AuthorityContinuityStatusMailboxIdentity = { schemaVersion: "1.0", providerId: "provider_cf074", policyId: "policy_cf074", tenantId: "tenant_cf074", installationId: "installation_cf074", workspaceId: "workspace_cf074", authorityContractDigest, trustConfigurationDigest, runtimeReleaseDigest, providerSignerKeyId: "provider_signer_cf074", providerSignerPublicKeyDigest: digest(provider.publicKey.export({ type: "spki", format: "der" })) };
    const policy = signAuthorityContinuityEnrollmentPolicy({ ...identity, policyEpoch: 1, enrolledAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 600_000).toISOString(), state: "enrolled", privateKey: provider.privateKey });
    const response = signAuthorityContinuityCurrentnessResponse({ providerId: identity.providerId, policyId: identity.policyId, policyEpoch: 1, policyDigest: policy.policyDigest, tenantId: identity.tenantId, installationId: identity.installationId, workspaceId: identity.workspaceId, authorityContractDigest, trustConfigurationDigest, runtimeReleaseDigest, challengeNonce, state: "active", continuityGuardIdentityDigest: null, issuedAt: new Date(now - 1).toISOString(), expiresAt: new Date(now + 299_000).toISOString(), providerSignerKeyId: identity.providerSignerKeyId, privateKey: provider.privateKey });
    const mailboxPath = join(root, "mailbox.sqlite"), identityPath = join(root, "identity.json"), statePath = join(root, "provider-state.json"), privateKeyPath = join(root, "provider-private.pem"), ledgerPath = join(root, "stops.sqlite");
    const providerState = (statusEpoch: number, state: "active" | "suspended" | "revoked" | "unknown") => signAuthorityContinuityProviderState({ ...identity, statusEpoch, state, changedAt: new Date().toISOString(), privateKey: provider.privateKey });
    writeFileSync(identityPath, JSON.stringify(identity), { mode: 0o600 }); writeFileSync(statePath, JSON.stringify(providerState(1, "active")), { mode: 0o600 }); writeFileSync(privateKeyPath, provider.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    const mailbox = new DurableLocalAuthorityContinuityStatusMailbox(mailboxPath, identity, { timeoutMilliseconds: 150 }); closers.push(() => mailbox.close());
    const ledger = new DurableAuthorityContinuityStopLedger(ledgerPath, identity.tenantId, identity.installationId); closers.push(() => ledger.close());
    let child = await launch({ mailboxPath, identityPath, statePath, privateKeyPath });
    const guard = createAuthorityContinuityEnrollmentGuard({ policy, response, providerPublicKey: provider.publicKey, expectedChallengeNonce: challengeNonce, expectedRuntimeReleaseDigest: runtimeReleaseDigest, liveStatusProvider: mailbox, stopRecorder: ledger });
    expect(() => guard.assertCurrent()).not.toThrow();
    const nextState = join(root, "provider-state.next"); writeFileSync(nextState, JSON.stringify(providerState(2, "suspended")), { mode: 0o600 }); renameSync(nextState, statePath);
    expect(() => guard.assertCurrent()).toThrow(/provider-state-suspended/i);
    await stop(child);
    expect(() => guard.assertCurrent()).toThrow(/provider-unavailable/i);
    writeFileSync(nextState, JSON.stringify(providerState(3, "active")), { mode: 0o600 }); renameSync(nextState, statePath);
    child = await launch({ mailboxPath, identityPath, statePath, privateKeyPath });
    expect(() => guard.assertCurrent()).not.toThrow();
    const forgedState = { ...providerState(4, "active"), state: "revoked" }; writeFileSync(nextState, JSON.stringify(forgedState), { mode: 0o600 }); renameSync(nextState, statePath);
    expect(() => guard.assertCurrent()).toThrow(/provider-unavailable/i);
    writeFileSync(nextState, JSON.stringify(providerState(5, "active")), { mode: 0o600 }); renameSync(nextState, statePath);
    expect(() => guard.assertCurrent()).not.toThrow();
    expect(ledger.verify()).toMatchObject({ entries: 3 });
    expect(JSON.stringify(ledger.entries())).not.toMatch(/challengeNonce|privateKey|credential|BEGIN PRIVATE KEY/i);
    expect(() => new DurableLocalAuthorityContinuityStatusMailbox(mailboxPath, { ...identity, installationId: "installation_attacker" })).toThrow(/substituted|incompatible/i);
  });
});
