import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const EXTERNAL_MONOTONIC_CONTINUITY_ANCHOR_VERSION = "1.0" as const;

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,179}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const maximumCheckpoints = 10_000;

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

function publicKeyDigest(key: KeyObject): string {
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error("Continuity anchor requires an Ed25519 public key.");
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
}

function epoch(value: string, label: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(`${label} timestamp is invalid.`);
  return result;
}

export interface ExternalMonotonicContinuityAnchorConfiguration {
  schemaVersion: typeof EXTERNAL_MONOTONIC_CONTINUITY_ANCHOR_VERSION;
  anchorId: string;
  tenantId: string;
  installationId: string;
  workspaceId: string;
  authorityContractDigest: string;
  trustConfigurationDigest: string;
  signerKeyId: string;
  signerPublicKeyPem: string;
}

export interface ExternalMonotonicContinuityAnchorDescriptor {
  schemaVersion: "1.0";
  anchorId: string;
  tenantId: string;
  installationId: string;
  workspaceId: string;
  authorityContractDigest: string;
  trustConfigurationDigest: string;
  signerKeyId: string;
  signerPublicKeyDigest: string;
  configurationDigest: string;
}

export interface ExternalMonotonicContinuityCheckpoint {
  schemaVersion: "1.0";
  anchorId: string;
  configurationDigest: string;
  generation: number;
  kind: "recovery-pinned" | "restore-completed";
  previousCheckpointDigest: string | null;
  recoveryManifestDigest: string;
  recoveryReceiptDigest: string | null;
  issuedAt: string;
  executionAuthorityEffect: "none";
  activationAuthorityEffect: "none";
  checkpointDigest: string;
  signature: string;
}

interface StoredMetadata { config_json: string; config_digest: string }
interface StoredCheckpoint { generation: number; checkpoint_json: string }

/**
 * File-backed reference for an external continuity service. Security against
 * whole-package rollback depends on this database being stored and protected
 * outside the package root. The class proves protocol behavior; it does not
 * claim hostile-local-administrator resistance for an ordinary local file.
 */
export class DurableExternalMonotonicContinuityAnchor {
  readonly path: string;
  private readonly database: DatabaseSync;
  private readonly config: ExternalMonotonicContinuityAnchorConfiguration;
  private readonly configDigest: string;
  private readonly signerPublicKey: KeyObject;
  private readonly signerPrivateKey: KeyObject | undefined;
  private readonly now: () => string;

  constructor(path: string, config: ExternalMonotonicContinuityAnchorConfiguration, options: { signerPrivateKey?: KeyObject; now?: () => string } = {}) {
    this.validateConfiguration(config);
    this.path = path;
    this.config = structuredClone(config);
    this.signerPublicKey = createPublicKey(config.signerPublicKeyPem);
    this.configDigest = digest(config);
    this.signerPrivateKey = options.signerPrivateKey;
    this.now = options.now ?? (() => new Date().toISOString());
    if (this.signerPrivateKey) {
      if (this.signerPrivateKey.type !== "private" || this.signerPrivateKey.asymmetricKeyType !== "ed25519" || publicKeyDigest(createPublicKey(this.signerPrivateKey)) !== publicKeyDigest(this.signerPublicKey)) throw new Error("Continuity anchor private key does not match its pinned signer.");
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS continuity_metadata (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), config_json TEXT NOT NULL, config_digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS continuity_checkpoints (generation INTEGER PRIMARY KEY, checkpoint_json TEXT NOT NULL);
    `);
    const existing = this.database.prepare("SELECT config_json, config_digest FROM continuity_metadata WHERE singleton = 1").get() as StoredMetadata | undefined;
    if (!existing) this.database.prepare("INSERT INTO continuity_metadata(singleton, config_json, config_digest) VALUES(1, ?, ?)").run(canonical(config), this.configDigest);
    else if (existing.config_digest !== this.configDigest || existing.config_json !== canonical(config)) throw new Error("Continuity anchor configuration was substituted or widened.");
    this.readAndVerifyAll();
  }

  descriptor(): ExternalMonotonicContinuityAnchorDescriptor {
    return {
      schemaVersion: "1.0", anchorId: this.config.anchorId, tenantId: this.config.tenantId,
      installationId: this.config.installationId, workspaceId: this.config.workspaceId,
      authorityContractDigest: this.config.authorityContractDigest,
      trustConfigurationDigest: this.config.trustConfigurationDigest,
      signerKeyId: this.config.signerKeyId, signerPublicKeyDigest: publicKeyDigest(this.signerPublicKey),
      configurationDigest: this.configDigest,
    };
  }

  current(): ExternalMonotonicContinuityCheckpoint | null {
    return structuredClone(this.readAndVerifyAll().at(-1) ?? null);
  }

  pinRecoveryManifest(recoveryManifestDigest: string): ExternalMonotonicContinuityCheckpoint {
    this.requireWriter();
    if (!digestPattern.test(recoveryManifestDigest)) throw new Error("Continuity recovery manifest digest is invalid.");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const checkpoints = this.readAndVerifyAll();
      if (checkpoints.some((checkpoint) => checkpoint.recoveryManifestDigest === recoveryManifestDigest)) throw new Error("Continuity recovery manifest was already pinned and cannot be reintroduced at a later generation.");
      const checkpoint = this.buildCheckpoint({ kind: "recovery-pinned", recoveryManifestDigest, recoveryReceiptDigest: null, previous: checkpoints.at(-1) ?? null });
      this.database.prepare("INSERT INTO continuity_checkpoints(generation, checkpoint_json) VALUES(?, ?)").run(checkpoint.generation, JSON.stringify(checkpoint));
      this.database.exec("COMMIT");
      return structuredClone(checkpoint);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  completeCurrentRecovery(recoveryManifestDigest: string, recoveryReceiptDigest: string): ExternalMonotonicContinuityCheckpoint {
    this.requireWriter();
    if (!digestPattern.test(recoveryManifestDigest) || !digestPattern.test(recoveryReceiptDigest)) throw new Error("Continuity recovery completion identity is invalid.");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.readAndVerifyAll().at(-1);
      if (!current || current.kind !== "recovery-pinned" || current.recoveryManifestDigest !== recoveryManifestDigest) throw new Error("Recovery point is not the current externally pinned continuity head.");
      const completion = this.buildCheckpoint({ kind: "restore-completed", recoveryManifestDigest, recoveryReceiptDigest, previous: current });
      this.database.prepare("INSERT INTO continuity_checkpoints(generation, checkpoint_json) VALUES(?, ?)").run(completion.generation, JSON.stringify(completion));
      this.database.exec("COMMIT");
      return structuredClone(completion);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  assertCurrentRestoreCompletion(input: { recoveryManifestDigest: string; recoveryReceiptDigest: string; completionCheckpointDigest: string }): ExternalMonotonicContinuityCheckpoint {
    const current = this.current();
    if (!current || current.kind !== "restore-completed" || current.recoveryManifestDigest !== input.recoveryManifestDigest
      || current.recoveryReceiptDigest !== input.recoveryReceiptDigest || current.checkpointDigest !== input.completionCheckpointDigest) throw new Error("External continuity restore completion is missing, stale, superseded, or mismatched.");
    return current;
  }

  withCurrentRestoreCompletion<T>(input: { recoveryManifestDigest: string; recoveryReceiptDigest: string; completionCheckpointDigest: string }, consume: () => T): T {
    if (typeof consume !== "function") throw new Error("Continuity consumption requires one trusted synchronous operation.");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.readAndVerifyAll().at(-1);
      if (!current || current.kind !== "restore-completed" || current.recoveryManifestDigest !== input.recoveryManifestDigest
        || current.recoveryReceiptDigest !== input.recoveryReceiptDigest || current.checkpointDigest !== input.completionCheckpointDigest) throw new Error("External continuity restore completion is missing, stale, superseded, or mismatched.");
      const result = consume();
      if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") throw new Error("Continuity consumption cannot span an asynchronous callback.");
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /** Holds the external head under one immediate transaction for the complete
   * synchronous restore callback, then advances the head to restore-completed. */
  withCurrentRecovery<T>(
    recoveryManifestDigest: string,
    restore: (current: ExternalMonotonicContinuityCheckpoint) => { value: T; recoveryReceiptDigest: string },
    onContinuityFailure?: (value: T) => void,
  ): { value: T; recoveryCheckpoint: ExternalMonotonicContinuityCheckpoint; completionCheckpoint: ExternalMonotonicContinuityCheckpoint } {
    this.requireWriter();
    if (!digestPattern.test(recoveryManifestDigest)) throw new Error("Continuity recovery manifest digest is invalid.");
    this.database.exec("BEGIN IMMEDIATE");
    let restored: { value: T; recoveryReceiptDigest: string } | undefined;
    try {
      const checkpoints = this.readAndVerifyAll();
      const current = checkpoints.at(-1);
      if (!current || current.kind !== "recovery-pinned" || current.recoveryManifestDigest !== recoveryManifestDigest) throw new Error("Recovery point is not the current externally pinned continuity head.");
      restored = restore(structuredClone(current));
      if (!digestPattern.test(restored.recoveryReceiptDigest)) throw new Error("Continuity restore callback returned an invalid recovery receipt digest.");
      const completion = this.buildCheckpoint({ kind: "restore-completed", recoveryManifestDigest, recoveryReceiptDigest: restored.recoveryReceiptDigest, previous: current });
      this.database.prepare("INSERT INTO continuity_checkpoints(generation, checkpoint_json) VALUES(?, ?)").run(completion.generation, JSON.stringify(completion));
      this.database.exec("COMMIT");
      return { value: restored.value, recoveryCheckpoint: structuredClone(current), completionCheckpoint: structuredClone(completion) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      if (restored) onContinuityFailure?.(restored.value);
      throw error;
    }
  }

  close(): void { this.database.close(); }

  private validateConfiguration(config: ExternalMonotonicContinuityAnchorConfiguration): void {
    for (const value of [config.anchorId, config.tenantId, config.installationId, config.workspaceId, config.signerKeyId]) if (!identifier.test(value)) throw new Error("Continuity anchor contains an invalid identity.");
    if (config.schemaVersion !== EXTERNAL_MONOTONIC_CONTINUITY_ANCHOR_VERSION || !digestPattern.test(config.authorityContractDigest) || !digestPattern.test(config.trustConfigurationDigest)) throw new Error("Continuity anchor configuration is invalid.");
    const key = createPublicKey(config.signerPublicKeyPem);
    publicKeyDigest(key);
  }

  private requireWriter(): KeyObject {
    if (!this.signerPrivateKey) throw new Error("Continuity anchor is read-only without its external signing key.");
    return this.signerPrivateKey;
  }

  private buildCheckpoint(input: { kind: ExternalMonotonicContinuityCheckpoint["kind"]; recoveryManifestDigest: string; recoveryReceiptDigest: string | null; previous: ExternalMonotonicContinuityCheckpoint | null }): ExternalMonotonicContinuityCheckpoint {
    if ((input.kind === "recovery-pinned") !== (input.recoveryReceiptDigest === null)) throw new Error("Continuity checkpoint kind and receipt state conflict.");
    const issuedAt = this.now();
    if (input.previous && epoch(issuedAt, "Continuity checkpoint") < epoch(input.previous.issuedAt, "Prior continuity checkpoint")) throw new Error("Continuity anchor clock moved backwards.");
    const body = {
      schemaVersion: "1.0" as const, anchorId: this.config.anchorId, configurationDigest: this.configDigest,
      generation: (input.previous?.generation ?? 0) + 1, kind: input.kind,
      previousCheckpointDigest: input.previous?.checkpointDigest ?? null,
      recoveryManifestDigest: input.recoveryManifestDigest, recoveryReceiptDigest: input.recoveryReceiptDigest,
      issuedAt, executionAuthorityEffect: "none" as const, activationAuthorityEffect: "none" as const,
    };
    const checkpointDigest = digest(body);
    const signature = sign(null, Buffer.from(canonical({ ...body, checkpointDigest })), this.requireWriter()).toString("base64");
    return { ...body, checkpointDigest, signature };
  }

  private readAndVerifyAll(): ExternalMonotonicContinuityCheckpoint[] {
    const metadata = this.database.prepare("SELECT config_json, config_digest FROM continuity_metadata WHERE singleton = 1").get() as StoredMetadata | undefined;
    if (!metadata || metadata.config_digest !== this.configDigest || metadata.config_json !== canonical(this.config)) throw new Error("Continuity anchor metadata failed its integrity check.");
    const rows = this.database.prepare("SELECT generation, checkpoint_json FROM continuity_checkpoints ORDER BY generation ASC").all() as unknown as StoredCheckpoint[];
    if (rows.length > maximumCheckpoints) throw new Error("Continuity anchor checkpoint bound exceeded.");
    const result: ExternalMonotonicContinuityCheckpoint[] = [];
    for (const row of rows) {
      const checkpoint = JSON.parse(row.checkpoint_json) as ExternalMonotonicContinuityCheckpoint;
      const previous = result.at(-1) ?? null;
      const { checkpointDigest, signature, ...body } = checkpoint;
      if (checkpoint.schemaVersion !== "1.0" || checkpoint.anchorId !== this.config.anchorId || checkpoint.configurationDigest !== this.configDigest
        || row.generation !== checkpoint.generation || checkpoint.generation !== (previous?.generation ?? 0) + 1
        || checkpoint.previousCheckpointDigest !== (previous?.checkpointDigest ?? null) || !digestPattern.test(checkpoint.recoveryManifestDigest)
        || !["recovery-pinned", "restore-completed"].includes(checkpoint.kind)
        || (checkpoint.kind === "recovery-pinned") !== (checkpoint.recoveryReceiptDigest === null)
        || (checkpoint.recoveryReceiptDigest !== null && !digestPattern.test(checkpoint.recoveryReceiptDigest))
        || checkpoint.executionAuthorityEffect !== "none" || checkpoint.activationAuthorityEffect !== "none"
        || checkpointDigest !== digest(body) || !verify(null, Buffer.from(canonical({ ...body, checkpointDigest })), this.signerPublicKey, Buffer.from(signature, "base64"))
        || (previous && epoch(checkpoint.issuedAt, "Continuity checkpoint") < epoch(previous.issuedAt, "Prior continuity checkpoint"))) throw new Error("Continuity anchor history was reordered, substituted, truncated internally, or tampered.");
      epoch(checkpoint.issuedAt, "Continuity checkpoint");
      result.push(checkpoint);
    }
    return result;
  }
}
