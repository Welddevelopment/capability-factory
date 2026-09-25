import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type { LocalSecretProvider } from "../product/secrets.js";

export const AUTHENTICATED_MESSAGE_INGRESS_VERSION = "authenticated-message-ingress-v0.1" as const;

const DELIVERY_ID = /^[a-zA-Z0-9_-]{1,160}$/;
const FILE_ALIAS = /^[a-zA-Z0-9_.-]{1,180}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface AuthenticatedMessageIngressOptions {
  /**
   * When supplied, the signed route is registered on the existing customer-local
   * sidecar so all capability modes share one loopback process and origin.
   */
  app?: FastifyInstance;
  inboxRoot: string;
  databasePath: string;
  credentialAlias: string;
  targetAlias: string;
  secrets: LocalSecretProvider;
  maxMessageBytes?: number;
  maxClockSkewMs?: number;
  now?: () => Date;
}

export interface TrustedMessageIngressReceipt {
  deliveryId: string;
  inputMessageAlias: string;
  messageSha256: string;
  secretVersion: string;
  receivedAt: string;
}

export interface AuthenticatedMessageIngress {
  app: FastifyInstance;
  receipt(inputMessageAlias: string): TrustedMessageIngressReceipt | undefined;
  close(): Promise<void>;
}

export interface AuthenticatedMessageSubmission {
  deliveryId: string;
  inputMessageAlias: string;
  sentAt: string;
  message: Buffer | string;
}

export interface AuthenticatedMessageIngressClientOptions {
  origin: string;
  credentialAlias: string;
  targetAlias: string;
  secrets: LocalSecretProvider;
  requestTimeoutMs?: number;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeDeliveryId(value: string): string {
  if (!DELIVERY_ID.test(value)) throw new Error("Message delivery ID must be a bounded identifier.");
  return value;
}

function safeInputAlias(value: string): string {
  if (!FILE_ALIAS.test(value) || value.includes("..") || !value.endsWith(".eml")) {
    throw new Error("Message input alias must be one exact .eml filename without path syntax.");
  }
  return value;
}

function canonicalSignatureInput(input: {
  deliveryId: string;
  sentAt: string;
  inputMessageAlias: string;
  messageSha256: string;
}): string {
  return [
    AUTHENTICATED_MESSAGE_INGRESS_VERSION,
    input.deliveryId,
    input.sentAt,
    input.inputMessageAlias,
    input.messageSha256,
  ].join("\n");
}

export function signAuthenticatedMessage(
  secret: string,
  input: {
    deliveryId: string;
    sentAt: string;
    inputMessageAlias: string;
    messageSha256: string;
  },
): string {
  if (!secret) throw new Error("Authenticated message signing secret cannot be empty.");
  if (!SHA256.test(input.messageSha256)) throw new Error("Authenticated message digest must be SHA-256.");
  return createHmac("sha256", secret)
    .update(canonicalSignatureInput(input))
    .digest("hex");
}

function signatureMatches(expected: string, supplied: string): boolean {
  if (!SHA256.test(supplied)) return false;
  const expectedBytes = Buffer.from(expected, "hex");
  const suppliedBytes = Buffer.from(supplied, "hex");
  return expectedBytes.byteLength === suppliedBytes.byteLength &&
    timingSafeEqual(expectedBytes, suppliedBytes);
}

function privateDirectory(directory: string): string {
  const resolved = path.resolve(directory);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error("Authenticated message inbox must be a private real directory.");
  }
  return resolved;
}

function privateDatabasePath(filename: string): string {
  const resolved = path.resolve(filename);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const parent = fs.lstatSync(path.dirname(resolved));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) {
    throw new Error("Authenticated message receipt database parent must be private.");
  }
  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error("Authenticated message receipt database must be a private regular file.");
    }
  }
  return resolved;
}

export function createAuthenticatedMessageIngress(
  options: AuthenticatedMessageIngressOptions,
): AuthenticatedMessageIngress {
  const inboxRoot = privateDirectory(options.inboxRoot);
  const databasePath = privateDatabasePath(options.databasePath);
  const maxMessageBytes = options.maxMessageBytes ?? 64_000;
  const maxClockSkewMs = options.maxClockSkewMs ?? 5 * 60 * 1_000;
  if (!Number.isInteger(maxMessageBytes) || maxMessageBytes < 1 || maxMessageBytes > 5_000_000) {
    throw new Error("Authenticated message byte limit is invalid.");
  }
  if (!Number.isInteger(maxClockSkewMs) || maxClockSkewMs < 1_000 || maxClockSkewMs > 24 * 60 * 60 * 1_000) {
    throw new Error("Authenticated message clock-skew limit is invalid.");
  }

  const database = new DatabaseSync(databasePath);
  fs.chmodSync(databasePath, 0o600);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS trusted_message_ingress (
      delivery_id TEXT PRIMARY KEY,
      input_message_alias TEXT NOT NULL UNIQUE,
      message_sha256 TEXT NOT NULL,
      secret_version TEXT NOT NULL,
      received_at TEXT NOT NULL
    ) STRICT;
  `);

  const app = options.app ?? Fastify({
    logger: false,
    bodyLimit: maxMessageBytes,
  });
  let databaseClosed = false;
  app.addHook("onClose", async () => {
    if (databaseClosed) return;
    databaseClosed = true;
    database.close();
  });
  app.addContentTypeParser(
    "message/rfc822",
    { parseAs: "buffer", bodyLimit: maxMessageBytes },
    (_request, body, done) => done(null, body),
  );

  app.post("/v1/inbox/messages", async (request, reply) => {
    const deliveryId = request.headers["x-cf-delivery-id"];
    const sentAt = request.headers["x-cf-sent-at"];
    const inputMessageAlias = request.headers["x-cf-input-alias"];
    const suppliedSignature = request.headers["x-cf-signature"];
    const suppliedDigest = request.headers["x-cf-content-sha256"];
    if (
      typeof deliveryId !== "string" ||
      typeof sentAt !== "string" ||
      typeof inputMessageAlias !== "string" ||
      typeof suppliedSignature !== "string" ||
      typeof suppliedDigest !== "string"
    ) {
      return reply.code(400).send({ error: "The signed message envelope is incomplete." });
    }

    let safeDelivery: string;
    let safeAlias: string;
    try {
      safeDelivery = safeDeliveryId(deliveryId);
      safeAlias = safeInputAlias(inputMessageAlias);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    const sentAtMs = Date.parse(sentAt);
    if (!Number.isFinite(sentAtMs) || Math.abs((options.now?.() ?? new Date()).getTime() - sentAtMs) > maxClockSkewMs) {
      return reply.code(401).send({ error: "The signed message timestamp is invalid or outside the allowed window." });
    }
    if (!Buffer.isBuffer(request.body)) {
      return reply.code(415).send({ error: "Only one raw message/rfc822 payload is accepted." });
    }
    const message = request.body;
    const messageSha256 = sha256(message);
    if (messageSha256 !== suppliedDigest || !SHA256.test(suppliedDigest)) {
      return reply.code(400).send({ error: "The signed message content digest does not match its body." });
    }

    let resolved: Awaited<ReturnType<LocalSecretProvider["resolve"]>>;
    try {
      resolved = await options.secrets.resolve({
        alias: options.credentialAlias,
        targetAlias: options.targetAlias,
        actionName: "accept-signed-message",
        method: "POST",
        runId: safeDelivery,
        testMode: false,
      });
    } catch {
      return reply.code(503).send({ error: "The customer-local ingress credential is unavailable or out of scope." });
    }
    const expectedSignature = signAuthenticatedMessage(resolved.value, {
      deliveryId: safeDelivery,
      sentAt,
      inputMessageAlias: safeAlias,
      messageSha256,
    });
    if (!signatureMatches(expectedSignature, suppliedSignature)) {
      return reply.code(401).send({ error: "The signed message authentication failed." });
    }

    const replay = database.prepare(
      `SELECT delivery_id, input_message_alias, message_sha256
         FROM trusted_message_ingress
        WHERE delivery_id = ? OR input_message_alias = ?
        LIMIT 1`,
    ).get(safeDelivery, safeAlias) as {
      delivery_id: string;
      input_message_alias: string;
      message_sha256: string;
    } | undefined;
    if (replay) {
      return reply.code(409).send({
        error: "The signed delivery identity or input alias has already been accepted.",
        replay: true,
      });
    }

    const filename = path.resolve(inboxRoot, safeAlias);
    if (path.dirname(filename) !== inboxRoot) {
      return reply.code(400).send({ error: "The signed message escaped its approved inbox." });
    }
    const temporary = `${filename}.${safeDelivery}.pending`;
    try {
      fs.writeFileSync(temporary, message, { mode: 0o600, flag: "wx" });
      // A hard-link promotion is atomic and refuses to replace an existing
      // accepted alias. rename() would overwrite on POSIX and is unsafe here.
      fs.linkSync(temporary, filename);
      fs.unlinkSync(temporary);
      const receivedAt = (options.now?.() ?? new Date()).toISOString();
      try {
        database.prepare(
          `INSERT INTO trusted_message_ingress (
             delivery_id, input_message_alias, message_sha256, secret_version, received_at
           ) VALUES (?, ?, ?, ?, ?)`,
        ).run(safeDelivery, safeAlias, messageSha256, resolved.version, receivedAt);
      } catch (error) {
        fs.rmSync(filename, { force: true });
        throw error;
      }
      return reply.code(201).send({
        accepted: true,
        deliveryId: safeDelivery,
        inputMessageAlias: safeAlias,
        messageSha256,
        secretVersion: resolved.version,
        receivedAt,
      });
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return reply.code(409).send({ error: "The signed message input alias already exists.", replay: true });
      }
      request.log.error({ err: error }, "signed message ingress failed");
      return reply.code(500).send({ error: "The signed message could not be durably accepted." });
    }
  });

  return {
    app,
    receipt(inputMessageAlias) {
      const safeAlias = safeInputAlias(inputMessageAlias);
      const row = database.prepare(
        `SELECT delivery_id, input_message_alias, message_sha256, secret_version, received_at
           FROM trusted_message_ingress
          WHERE input_message_alias = ?`,
      ).get(safeAlias) as {
        delivery_id: string;
        input_message_alias: string;
        message_sha256: string;
        secret_version: string;
        received_at: string;
      } | undefined;
      return row ? {
        deliveryId: row.delivery_id,
        inputMessageAlias: row.input_message_alias,
        messageSha256: row.message_sha256,
        secretVersion: row.secret_version,
        receivedAt: row.received_at,
      } : undefined;
    },
    async close() {
      await app.close();
    },
  };
}

export class AuthenticatedMessageIngressClient {
  private readonly origin: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: AuthenticatedMessageIngressClientOptions) {
    const url = new URL(options.origin);
    if ((url.protocol !== "http:" && url.protocol !== "https:") ||
      url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
      throw new Error("Authenticated message ingress origin must be an exact HTTP(S) origin.");
    }
    this.origin = url.origin;
    this.timeoutMs = options.requestTimeoutMs ?? 5_000;
  }

  async submit(input: AuthenticatedMessageSubmission): Promise<{
    status: number;
    body: Record<string, unknown>;
  }> {
    const deliveryId = safeDeliveryId(input.deliveryId);
    const inputMessageAlias = safeInputAlias(input.inputMessageAlias);
    const message = Buffer.isBuffer(input.message) ? input.message : Buffer.from(input.message, "utf8");
    const messageSha256 = sha256(message);
    const secret = await this.options.secrets.resolve({
      alias: this.options.credentialAlias,
      targetAlias: this.options.targetAlias,
      actionName: "send-signed-message",
      method: "POST",
      runId: deliveryId,
      testMode: false,
    });
    const signature = signAuthenticatedMessage(secret.value, {
      deliveryId,
      sentAt: input.sentAt,
      inputMessageAlias,
      messageSha256,
    });
    const response = await fetch(new URL("/v1/inbox/messages", this.origin), {
      method: "POST",
      headers: {
        "content-type": "message/rfc822",
        "x-cf-delivery-id": deliveryId,
        "x-cf-sent-at": input.sentAt,
        "x-cf-input-alias": inputMessageAlias,
        "x-cf-content-sha256": messageSha256,
        "x-cf-signature": signature,
      },
      body: message,
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await response.json() as Record<string, unknown>;
    return { status: response.status, body };
  }
}
