import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import Fastify, { type FastifyInstance } from "fastify";
import {
  AuthenticatedNetworkFileTransport,
} from "../experimental/authenticated-network-file-transport.js";
import {
  ExperimentalFileTransferCapabilitySdk,
  StaticTrustedFileTransferCapabilitySource,
  type FileTransferCapabilityBuilder,
  type FileTransferCapabilityGoalRequest,
} from "../experimental/file-transfer-capability-sdk.js";
import {
  ExperimentalFileTransferDriver,
  experimentalFileTransferCapabilitySchema,
  fileTransferOutputAlias,
  type CanonicalPurchaseOrder,
  type ExperimentalFileTransferCapability,
  type ExperimentalFileTransferOutcomeVerifier,
  type ExperimentalFileTransferTarget,
} from "../experimental/file-transfer-driver.js";
import { PersistentFileTransferCapabilityRegistry } from "../experimental/file-transfer-registry.js";
import {
  RotatingMemorySecretProvider,
  type LocalSecretProvider,
  type ScopedSecretDescriptor,
} from "../product/secrets.js";

export const FICTIONAL_EDIFACT_TENANT = "fictional-north-sea-distributor";
export const FICTIONAL_EDIFACT_NEED = "import-approved-edifact-order";
export const FICTIONAL_EDIFACT_APPROVAL = "import-approved-edifact-partner-order";
export const FICTIONAL_EDIFACT_VERIFIER = "network-file-gateway-direct-db-v1";
export const FICTIONAL_EDIFACT_INPUT_ALIAS = "partner-edifact-inbox";
export const FICTIONAL_EDIFACT_OUTPUT_ALIAS = "customer-network-outbox";
export const FICTIONAL_EDIFACT_GATEWAY_ALIAS = "customer-file-gateway";
export const FICTIONAL_EDIFACT_CREDENTIAL_ALIAS = "file_gateway_token";

export const FICTIONAL_EDIFACT_SECRET_DESCRIPTOR: ScopedSecretDescriptor = {
  alias: FICTIONAL_EDIFACT_CREDENTIAL_ALIAS,
  version: "gateway-local-v1",
  scope: {
    targetAliases: [FICTIONAL_EDIFACT_GATEWAY_ALIAS],
    actionNames: ["network-file-read", "network-file-write"],
    methods: ["GET", "PUT"],
  },
};

export interface FictionalEdifactOrderInput {
  fileAlias: string;
  purchaseOrderNumber: string;
  purchaseOrderDate?: string;
  shipToCode?: string;
  lines: Array<{ itemCode: string; quantity: number }>;
}

interface GatewayRow {
  area: "inbox" | "outbox";
  alias: string;
  bytes: Buffer;
  sha256: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameToken(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function safeAlias(value: string): string {
  if (!/^[a-zA-Z0-9_.-]{1,180}$/.test(value) || value.includes("..")) {
    throw new Error("Gateway alias must be one bounded filename.");
  }
  return value;
}

function partnerContract() {
  return {
    schemaVersion: "1",
    senderId: "NORTHSEA",
    receiverId: "FICTIONALBUYER",
    allowedItemCodes: ["BOLT-10", "FILTER-42", "GLOVE-7"],
    maxLineItems: 20,
    maxQuantityPerLine: 500,
    maxInputBytes: 64_000,
    inputFormat: "edifact-orders-d96a",
    outputFormat: "canonical-order-json",
    transportKind: "authenticated-network",
  } as const;
}

export function fictionalEdifactContractHash(): string {
  return sha256(canonical(partnerContract()));
}

export function fictionalEdifactPurchaseOrder(input: FictionalEdifactOrderInput): string {
  const date = input.purchaseOrderDate ?? "20260731";
  const shipTo = input.shipToCode ?? "LONDON02";
  const lines = input.lines.flatMap((line, index) => [
    `LIN+${index + 1}++${line.itemCode}:SA'`,
    `QTY+21:${line.quantity}:EA'`,
  ]);
  return [
    "UNB+UNOC:3+NORTHSEA+FICTIONALBUYER+260731:1200+1'",
    "UNH+1+ORDERS:D:96A:UN'",
    `BGM+220+${input.purchaseOrderNumber}+9'`,
    `DTM+137:${date}:102'`,
    `NAD+DP+${shipTo}::92'`,
    ...lines,
    "UNS+S'",
    `CNT+2:${input.lines.length}'`,
    `UNT+${lines.length + 7}+1'`,
    "UNZ+1+1'",
  ].join("");
}

function buildManifest(contractHash: string): ExperimentalFileTransferCapability {
  const contract = partnerContract();
  return experimentalFileTransferCapabilitySchema.parse({
    schemaVersion: "0.1",
    capabilityMode: "experimental-file-transfer-actions",
    id: "north-sea-edifact-orders-network-v1",
    needKey: FICTIONAL_EDIFACT_NEED,
    inputRootAlias: FICTIONAL_EDIFACT_INPUT_ALIAS,
    outputRootAlias: FICTIONAL_EDIFACT_OUTPUT_ALIAS,
    contractHash,
    inputFormat: contract.inputFormat,
    outputFormat: contract.outputFormat,
    transportKind: contract.transportKind,
    senderId: contract.senderId,
    receiverId: contract.receiverId,
    allowedItemCodes: [...contract.allowedItemCodes],
    maxLineItems: contract.maxLineItems,
    maxQuantityPerLine: contract.maxQuantityPerLine,
    maxInputBytes: contract.maxInputBytes,
    approvalKey: FICTIONAL_EDIFACT_APPROVAL,
    outcomeVerifierKey: FICTIONAL_EDIFACT_VERIFIER,
  });
}

class ContractPinnedEdifactBuilder implements FileTransferCapabilityBuilder {
  readonly builderId = "trusted-edifact-network-contract-builder-v1";

  async build(needKey: string, contractHash: string): Promise<ExperimentalFileTransferCapability | null> {
    if (needKey !== FICTIONAL_EDIFACT_NEED || contractHash !== fictionalEdifactContractHash()) return null;
    return buildManifest(contractHash);
  }
}

function independentlyExpectedOrder(
  source: string,
  operationKey: string,
  sourceFile: string,
  sourceSha256: string,
): CanonicalPurchaseOrder {
  const segments = source.split("'").filter(Boolean).map((segment) => segment.split("+"));
  const exact = (name: string) => {
    const found = segments.filter((segment) => segment[0] === name);
    if (found.length !== 1) throw new Error(`Independent EDIFACT verifier requires one ${name}.`);
    return found[0]!;
  };
  const unb = exact("UNB");
  const bgm = exact("BGM");
  const dtm = exact("DTM");
  const nad = segments.find((segment) => segment[0] === "NAD" && segment[1] === "DP");
  const lineSegments = segments.filter((segment) => segment[0] === "LIN");
  const quantitySegments = segments.filter((segment) => segment[0] === "QTY");
  if (!nad || lineSegments.length !== quantitySegments.length || lineSegments.length === 0) {
    throw new Error("Independent EDIFACT verifier could not pair order lines.");
  }
  return {
    schemaVersion: "1",
    operationKey,
    sourceFile,
    sourceSha256,
    senderId: unb[2]!.split(":")[0]!,
    receiverId: unb[3]!.split(":")[0]!,
    purchaseOrderNumber: bgm[2]!,
    purchaseOrderDate: dtm[1]!.split(":")[1]!,
    shipToCode: nad[2]!.split(":")[0]!,
    lines: lineSegments.map((line, index) => ({
      lineNumber: Number(line[1]),
      itemCode: line[3]!.split(":")[0]!,
      quantity: Number(quantitySegments[index]![1]!.split(":")[1]),
      unit: "EA",
    })),
  };
}

/** Real localhost HTTP boundary that behaves like a credentialed customer file gateway. */
export class FictionalAuthenticatedFileGateway {
  private readonly database: DatabaseSync;
  private readonly app: FastifyInstance;
  private originValue: string | null = null;

  constructor(databasePath: string, private readonly accessToken: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    fs.chmodSync(databasePath, 0o600);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS network_files (
        area TEXT NOT NULL,
        alias TEXT NOT NULL,
        bytes BLOB NOT NULL,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (area, alias)
      );
    `);
    this.app = Fastify({ logger: false, bodyLimit: 128_000 });
    this.app.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );
    this.routes();
  }

  get origin(): string {
    if (!this.originValue) throw new Error("Authenticated file gateway is not running.");
    return this.originValue;
  }

  async start(): Promise<void> {
    if (this.originValue) return;
    await this.app.listen({ host: "127.0.0.1", port: 0 });
    const address = this.app.server.address();
    if (!address || typeof address === "string") throw new Error("File gateway did not expose a TCP address.");
    this.originValue = `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    await this.app.close();
    this.database.close();
  }

  seedInput(alias: string, bytes: Buffer): void {
    this.database.prepare(`
      INSERT INTO network_files (area, alias, bytes, sha256, created_at)
      VALUES ('inbox', ?, ?, ?, ?)
    `).run(safeAlias(alias), bytes, sha256(bytes), new Date().toISOString());
  }

  readDirect(area: "inbox" | "outbox", alias: string): Buffer | null {
    const row = this.database.prepare(`
      SELECT area, alias, bytes, sha256
      FROM network_files
      WHERE area = ? AND alias = ?
    `).get(area, safeAlias(alias)) as unknown as GatewayRow | undefined;
    return row ? Buffer.from(row.bytes) : null;
  }

  listDirect(area: "inbox" | "outbox"): string[] {
    return (this.database.prepare(`
      SELECT alias FROM network_files WHERE area = ? ORDER BY alias
    `).all(area) as unknown as Array<{ alias: string }>).map((row) => row.alias);
  }

  private routes(): void {
    this.app.addHook("preHandler", async (request, reply) => {
      const header = request.headers.authorization;
      const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
      if (!sameToken(token, this.accessToken)) {
        reply.code(401);
        throw new Error("Unauthorized");
      }
    });
    this.app.get("/v1/files/:area/:alias", async (request, reply) => {
      const params = request.params as { area: string; alias: string };
      if (params.area !== "inbox" && params.area !== "outbox") {
        reply.code(404);
        return "Not found";
      }
      const bytes = this.readDirect(params.area, params.alias);
      if (!bytes) {
        reply.code(404);
        return "Not found";
      }
      reply.type("application/octet-stream");
      return bytes;
    });
    this.app.put("/v1/files/outbox/:alias", async (request, reply) => {
      const alias = safeAlias((request.params as { alias: string }).alias);
      if (request.headers["if-none-match"] !== "*") {
        reply.code(428);
        return "Exclusive creation required";
      }
      const raw = request.body;
      const bytes = Buffer.isBuffer(raw)
        ? raw
        : raw instanceof Uint8Array
          ? Buffer.from(raw)
          : Buffer.from(typeof raw === "string" ? raw : JSON.stringify(raw));
      const declared = request.headers["x-content-sha256"];
      if (typeof declared !== "string" || declared !== sha256(bytes)) {
        reply.code(400);
        return "Content digest mismatch";
      }
      try {
        this.database.prepare(`
          INSERT INTO network_files (area, alias, bytes, sha256, created_at)
          VALUES ('outbox', ?, ?, ?, ?)
        `).run(alias, bytes, declared, new Date().toISOString());
      } catch {
        reply.code(409);
        return "Output already exists";
      }
      reply.code(201);
      return "";
    });
  }
}

export class FictionalEdifactNetworkFileWorld {
  readonly registryRoot: string;
  readonly contractHash = fictionalEdifactContractHash();
  private readonly gateway: FictionalAuthenticatedFileGateway;
  private readonly token: string;

  constructor(
    readonly root: string,
    token = "fictional-network-file-gateway-token",
  ) {
    this.registryRoot = path.join(root, "registry");
    fs.mkdirSync(this.registryRoot, { recursive: true, mode: 0o700 });
    this.token = token;
    this.gateway = new FictionalAuthenticatedFileGateway(path.join(root, "gateway.sqlite"), token);
  }

  async start(): Promise<void> {
    await this.gateway.start();
  }

  async close(): Promise<void> {
    await this.gateway.close();
  }

  credentialValue(): string {
    return this.token;
  }

  writeInput(input: FictionalEdifactOrderInput): { sha256: string } {
    if (!input.fileAlias.endsWith(".unb")) throw new Error("EDIFACT input must use one .unb alias.");
    const source = fictionalEdifactPurchaseOrder(input);
    this.gateway.seedInput(input.fileAlias, Buffer.from(source, "utf8"));
    return { sha256: sha256(source) };
  }

  target(secretProvider?: LocalSecretProvider): ExperimentalFileTransferTarget {
    const secrets = secretProvider ?? this.memorySecrets();
    return {
      kind: "authenticated-network",
      contractHash: this.contractHash,
      probeDocument: fictionalEdifactPurchaseOrder({
        fileAlias: "probe.unb",
        purchaseOrderNumber: "PROBE-EDIFACT-1",
        lines: [{ itemCode: "BOLT-10", quantity: 1 }],
      }),
      transport: new AuthenticatedNetworkFileTransport({
        origin: this.gateway.origin,
        targetAlias: FICTIONAL_EDIFACT_GATEWAY_ALIAS,
        credentialAlias: FICTIONAL_EDIFACT_CREDENTIAL_ALIAS,
        secrets,
      }),
    };
  }

  sdk(secretProvider?: LocalSecretProvider): ExperimentalFileTransferCapabilitySdk {
    const target = this.target(secretProvider);
    return new ExperimentalFileTransferCapabilitySdk({
      driver: new ExperimentalFileTransferDriver({
        [FICTIONAL_EDIFACT_INPUT_ALIAS]: target,
        [FICTIONAL_EDIFACT_OUTPUT_ALIAS]: target,
      }),
      registry: new PersistentFileTransferCapabilityRegistry(this.registryRoot),
      trustedSource: new StaticTrustedFileTransferCapabilitySource("empty-edifact-library", []),
      builder: new ContractPinnedEdifactBuilder(),
      outcomeVerifier: (request) => this.verifier(request),
    });
  }

  request(input: {
    requestId: string;
    operationKey: string;
    inputFileAlias: string;
    expectedInputSha256: string;
    approvals?: string[];
    simulateLostResponseAfterCommit?: boolean;
  }): FileTransferCapabilityGoalRequest {
    return {
      tenantId: FICTIONAL_EDIFACT_TENANT,
      requestId: input.requestId,
      parentGoalId: `parent-${input.requestId}`,
      ordinaryGoal: "Import the approved EDIFACT partner order through the customer file gateway and continue fulfilment.",
      needKey: FICTIONAL_EDIFACT_NEED,
      contractHash: this.contractHash,
      operationKey: input.operationKey,
      inputFileAlias: input.inputFileAlias,
      expectedInputSha256: input.expectedInputSha256,
      approvals: input.approvals ?? [FICTIONAL_EDIFACT_APPROVAL],
      ...(input.simulateLostResponseAfterCommit ? { simulateLostResponseAfterCommit: true } : {}),
    };
  }

  outputAliases(): string[] {
    return this.gateway.listDirect("outbox");
  }

  private verifier(request: FileTransferCapabilityGoalRequest): ExperimentalFileTransferOutcomeVerifier {
    return {
      key: FICTIONAL_EDIFACT_VERIFIER,
      verify: async (operationKey) => {
        const alias = fileTransferOutputAlias(operationKey);
        const output = this.gateway.readDirect("outbox", alias);
        if (!output) return { outcome: "not-started", detail: "No network outbox record exists." };
        const input = this.gateway.readDirect("inbox", request.inputFileAlias);
        if (!input) return { outcome: "unknown", detail: "The immutable network inbox source is unavailable." };
        try {
          const actual = JSON.parse(output.toString("utf8")) as CanonicalPurchaseOrder;
          const expected = independentlyExpectedOrder(
            input.toString("utf8"),
            operationKey,
            request.inputFileAlias,
            request.expectedInputSha256,
          );
          if (sha256(input) !== request.expectedInputSha256 || canonical(actual) !== canonical(expected)) {
            return { outcome: "incorrect", detail: "Network outbox content does not match the approved EDIFACT source." };
          }
          return {
            outcome: "complete",
            detail: "Exactly one network outbox order matches the approved immutable EDIFACT input.",
            stateDigest: sha256(output),
          };
        } catch (error) {
          return { outcome: "unknown", detail: error instanceof Error ? error.message : String(error) };
        }
      },
    };
  }

  private memorySecrets(): LocalSecretProvider {
    const secrets = new RotatingMemorySecretProvider();
    secrets.set(FICTIONAL_EDIFACT_SECRET_DESCRIPTOR, this.token);
    return secrets;
  }
}
