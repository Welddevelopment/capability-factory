import { createHash } from "node:crypto";
import type { LocalSecretProvider } from "../product/secrets.js";
import {
  ExperimentalFileTransferPolicyError,
  type ExperimentalFileTransferTransport,
} from "./file-transfer-driver.js";

export interface AuthenticatedNetworkFileTransportOptions {
  origin: string;
  targetAlias: string;
  credentialAlias: string;
  secrets: LocalSecretProvider;
  requestTimeoutMs?: number;
}

function safeAlias(value: string): string {
  if (!/^[a-zA-Z0-9_.-]{1,180}$/.test(value) || value.includes("..")) {
    throw new ExperimentalFileTransferPolicyError("Network file alias must be one bounded filename without path syntax.");
  }
  return value;
}

/** Credentialed customer-local network file gateway with exact inbox/outbox routes. */
export class AuthenticatedNetworkFileTransport implements ExperimentalFileTransferTransport {
  readonly kind = "authenticated-network" as const;
  private readonly origin: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: AuthenticatedNetworkFileTransportOptions) {
    const url = new URL(options.origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ExperimentalFileTransferPolicyError("Network file gateway must use HTTP or HTTPS.");
    }
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
      throw new ExperimentalFileTransferPolicyError("Network file gateway origin must not contain paths, credentials, query, or fragments.");
    }
    this.origin = url.origin;
    this.timeoutMs = options.requestTimeoutMs ?? 5_000;
  }

  async readInput(alias: string, maxBytes: number): Promise<Buffer> {
    const response = await this.request("GET", `/v1/files/inbox/${encodeURIComponent(safeAlias(alias))}`, undefined, maxBytes);
    if (response.status === 404) throw new ExperimentalFileTransferPolicyError("Approved network input does not exist.");
    if (!response.ok) throw new ExperimentalFileTransferPolicyError(`Network input read failed with HTTP ${response.status}.`);
    return response.bytes;
  }

  async readOutput(alias: string, maxBytes: number): Promise<Buffer | null> {
    const response = await this.request("GET", `/v1/files/outbox/${encodeURIComponent(safeAlias(alias))}`, undefined, maxBytes);
    if (response.status === 404) return null;
    if (!response.ok) throw new ExperimentalFileTransferPolicyError(`Network output read failed with HTTP ${response.status}.`);
    return response.bytes;
  }

  async writeOutputExclusive(alias: string, bytes: Buffer): Promise<void> {
    const response = await this.request(
      "PUT",
      `/v1/files/outbox/${encodeURIComponent(safeAlias(alias))}`,
      bytes,
      16_384,
    );
    if (response.status === 409) {
      throw new ExperimentalFileTransferPolicyError("Network output already exists; exclusive write refused a duplicate.");
    }
    if (response.status !== 201) {
      throw new ExperimentalFileTransferPolicyError(`Network output write failed with HTTP ${response.status}.`);
    }
  }

  private async request(
    method: "GET" | "PUT",
    route: string,
    body: Buffer | undefined,
    maxResponseBytes: number,
  ): Promise<{ status: number; ok: boolean; bytes: Buffer }> {
    if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 10_000_000) {
      throw new ExperimentalFileTransferPolicyError("Network file response limit is invalid.");
    }
    const resolved = await this.options.secrets.resolve({
      alias: this.options.credentialAlias,
      targetAlias: this.options.targetAlias,
      actionName: method === "GET" ? "network-file-read" : "network-file-write",
      method,
      runId: `network-file-${method.toLowerCase()}`,
      testMode: false,
    });
    const response = await fetch(new URL(route, this.origin), {
      method,
      headers: {
        accept: "application/octet-stream",
        authorization: `Bearer ${resolved.value}`,
        ...(body
          ? {
              "content-type": "application/octet-stream",
              "content-length": String(body.byteLength),
              "x-content-sha256": createHash("sha256").update(body).digest("hex"),
              "if-none-match": "*",
            }
          : {}),
      },
      ...(body ? { body } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxResponseBytes) {
      throw new ExperimentalFileTransferPolicyError("Network file gateway response exceeded the bounded byte limit.");
    }
    return { status: response.status, ok: response.ok, bytes };
  }
}
