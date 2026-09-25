import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import { types as utilTypes } from "node:util";
import type {
  CompiledHttpRequest,
  CompiledHttpResponse,
  CustomerLocalCredentialHandle,
  CustomerLocalPreparedHttpWrite,
  CustomerLocalHttpTransport,
} from "./http-binding-compiler.js";
import {
  assertTrustedCustomerLocalHttpWriteAuthorityVerifier,
  type CustomerLocalHttpWriteAuthorityVerifier,
  type HttpActionAuthorityLease,
} from "./customer-local-http-write-authority.js";

export const CUSTOMER_LOCAL_PINNED_HTTPS_TRANSPORT_VERSION = "1.0" as const;

const identifier = /^[a-zA-Z][a-zA-Z0-9_.-]{1,179}$/;
const digest = /^[a-f0-9]{64}$/;
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,80}$/;
const forbiddenRequestHeaders = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const authorityEnforcedPinnedTransports = new WeakSet<object>();

export class CustomerLocalPinnedHttpsDispatchUncertainError extends Error {
  readonly consumedAuthorityLease: HttpActionAuthorityLease;
  constructor(consumedAuthorityLease: HttpActionAuthorityLease, cause: unknown) {
    super(`Pinned HTTPS dispatch ended after its write-authority lease was consumed; independent reconciliation is required. Cause: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "CustomerLocalPinnedHttpsDispatchUncertainError";
    this.consumedAuthorityLease = Object.freeze(structuredClone(consumedAuthorityLease));
  }
}

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

export function pinnedHttpsTransportDigest(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

export interface CustomerLocalPinnedHttpsTransportConfig {
  driverId: string;
  sourceId: string;
  serverUrl: string;
  supportedMethods: CustomerLocalHttpTransport["supportedMethods"];
  independentlyAuthenticated: boolean;
  independentFromDriverIds: string[];
  credentialAlias: string;
  reviewedOperations: Array<{
    operationId: string;
    method: CompiledHttpRequest["method"];
    pathTemplate: string;
    declarationDigest: string;
  }>;
  authorizationScheme: "Bearer";
  caCertificatePem: string;
  serverCertificateSha256: string;
  timeoutMilliseconds: number;
  maximumRequestBytes: number;
  maximumResponseBytes: number;
  maximumResponseHeaders: number;
  maximumRequestsPerMinute: number;
  /** Optional durable signed-lease verifier for write methods. */
  writeAuthorityVerifier?: CustomerLocalHttpWriteAuthorityVerifier;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function boundedJsonSnapshot(value: unknown, state = { nodes: 0 }, depth = 0): JsonValue {
  state.nodes += 1;
  if (state.nodes > 4_096 || depth > 16) throw new Error("Pinned HTTPS request data exceeds its node or depth bound.");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("Pinned HTTPS request data contains a non-finite number."); return value; }
  if (typeof value === "string") { if (Buffer.byteLength(value) > 16_384) throw new Error("Pinned HTTPS request data contains an over-bound string."); return value; }
  if (typeof value !== "object" || utilTypes.isProxy(value)) throw new Error("Pinned HTTPS request data must be plain bounded JSON.");
  if (Array.isArray(value)) {
    if (value.length > 1_024) throw new Error("Pinned HTTPS request array exceeds 1,024 items.");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return value.map((_item, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) throw new Error("Pinned HTTPS request array contains an accessor or sparse entry.");
      return boundedJsonSnapshot(descriptor.value, state, depth + 1);
    });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Pinned HTTPS request object has a non-plain prototype.");
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
  if (keys.length > 1_024 || keys.some((key) => typeof key === "symbol") || Object.hasOwn(value, "toJSON")) throw new Error("Pinned HTTPS request object has symbols, serialization hooks, or too many keys.");
  const output: Record<string, JsonValue> = {};
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) throw new Error("Pinned HTTPS request object contains an accessor or hidden field.");
    output[key] = boundedJsonSnapshot(descriptor.value, state, depth + 1);
  }
  return output;
}

function assertConfig(config: CustomerLocalPinnedHttpsTransportConfig): URL {
  for (const [label, value] of [["driver", config.driverId], ["source", config.sourceId], ["credential alias", config.credentialAlias]] as const) {
    if (!identifier.test(value)) throw new Error(`Pinned HTTPS ${label} identity is malformed.`);
  }
  if (!digest.test(config.serverCertificateSha256) || /^0+$/.test(config.serverCertificateSha256)) throw new Error("Pinned HTTPS server certificate digest is malformed or placeholder.");
  if (!config.caCertificatePem.includes("-----BEGIN CERTIFICATE-----") || Buffer.byteLength(config.caCertificatePem) > 64 * 1024) throw new Error("Pinned HTTPS CA material is absent or exceeds 64 KiB.");
  if (config.supportedMethods.length === 0 || config.supportedMethods.length > 6 || new Set(config.supportedMethods).size !== config.supportedMethods.length) throw new Error("Pinned HTTPS method allowlist is empty, duplicated, or over-bound.");
  if (config.reviewedOperations.length === 0 || config.reviewedOperations.length > 32) throw new Error("Pinned HTTPS reviewed-operation allowlist is empty or over-bound.");
  const operationIdentities = new Set<string>();
  for (const operation of config.reviewedOperations) {
    if (!identifier.test(operation.operationId) || !config.supportedMethods.includes(operation.method) || !digest.test(operation.declarationDigest) || /^0+$/.test(operation.declarationDigest) || !operation.pathTemplate.startsWith("/") || operation.pathTemplate.includes("..") || operation.pathTemplate.includes("\\") || operation.pathTemplate.includes("?") || operation.pathTemplate.includes("#")) throw new Error("Pinned HTTPS reviewed operation is malformed or outside the method boundary.");
    const identity = `${operation.operationId}:${operation.method}:${operation.pathTemplate}:${operation.declarationDigest}`;
    if (operationIdentities.has(identity)) throw new Error("Pinned HTTPS reviewed operation is duplicated.");
    operationIdentities.add(identity);
  }
  if (config.independentFromDriverIds.length > 32 || new Set(config.independentFromDriverIds).size !== config.independentFromDriverIds.length || config.independentFromDriverIds.some((value) => !identifier.test(value))) throw new Error("Pinned HTTPS independent-driver allowlist is malformed or over-bound.");
  if (!Number.isInteger(config.timeoutMilliseconds) || config.timeoutMilliseconds < 100 || config.timeoutMilliseconds > 120_000) throw new Error("Pinned HTTPS timeout is outside 100 ms to 120 s.");
  for (const [label, value, maximum] of [
    ["request", config.maximumRequestBytes, 1024 * 1024],
    ["response", config.maximumResponseBytes, 4 * 1024 * 1024],
    ["response header", config.maximumResponseHeaders, 256],
  ] as const) if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`Pinned HTTPS ${label} bound is invalid.`);
  if (!Number.isInteger(config.maximumRequestsPerMinute) || config.maximumRequestsPerMinute < 1 || config.maximumRequestsPerMinute > 10_000) throw new Error("Pinned HTTPS request-rate bound is invalid.");
  const server = new URL(config.serverUrl);
  if (server.protocol !== "https:" || !["localhost", "127.0.0.1", "[::1]"].includes(server.hostname) || server.username || server.password || server.search || server.hash) throw new Error("Pinned HTTPS v1 accepts only one credential-free loopback HTTPS server URL.");
  if (!server.pathname.startsWith("/") || server.pathname.includes("..") || server.pathname.includes("\\")) throw new Error("Pinned HTTPS server base path is unsafe.");
  return server;
}

function safeRequestUrl(server: URL, request: CompiledHttpRequest, query: Record<string, string>): URL {
  if (!request.path.startsWith("/") || request.path.includes("..") || request.path.includes("\\") || request.path.includes("?") || request.path.includes("#") || /%(?:2e|2f|5c|25)/i.test(request.path)) throw new Error("Compiled HTTPS request path escaped its reviewed boundary.");
  if (Object.keys(query).length > 64) throw new Error("Compiled HTTPS query exceeds 64 parameters.");
  const basePath = server.pathname === "/" ? "" : server.pathname.replace(/\/$/, "");
  const target = new URL(server.toString());
  target.pathname = `${basePath}${request.path}`.replace(/\/{2,}/g, "/");
  target.search = "";
  for (const [key, value] of Object.entries(query).sort(([left], [right]) => left.localeCompare(right))) {
    if (!identifier.test(key) || Buffer.byteLength(value) > 4_096 || /[\r\n]/.test(value)) throw new Error("Compiled HTTPS query contains an unsafe name or value.");
    target.searchParams.append(key, value);
  }
  if (target.origin !== server.origin || !target.pathname.startsWith(`${basePath}/`)) throw new Error("Compiled HTTPS request changed the reviewed origin or base path.");
  if (Buffer.byteLength(target.toString()) > 8_192) throw new Error("Compiled HTTPS URL exceeds 8 KiB.");
  return target;
}

function safeHeaders(raw: Record<string, string>): Record<string, string> {
  if (Object.keys(raw).length > 64) throw new Error("Compiled HTTPS request exceeds 64 reviewed headers.");
  const headers: Record<string, string> = {};
  let bytes = 0;
  for (const [name, value] of Object.entries(raw)) {
    const normalized = name.toLowerCase();
    if (!headerName.test(name) || forbiddenRequestHeaders.has(normalized) || /[\r\n]/.test(value)) throw new Error("Compiled HTTPS request contains a forbidden header.");
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (bytes > 16_384) throw new Error("Compiled HTTPS request headers exceed 16 KiB.");
    headers[normalized] = value;
  }
  return headers;
}

function pathMatchesTemplate(path: string, template: string): boolean {
  const actual = path.split("/"), expected = template.split("/");
  if (actual.length !== expected.length) return false;
  return expected.every((segment, index) => /^\{[a-zA-Z][a-zA-Z0-9_.-]{1,179}\}$/.test(segment) ? actual[index]!.length > 0 : actual[index] === segment);
}

function pinnedIdentity(expectedDigest: string, hostname: string, certificate: PeerCertificate): Error | undefined {
  const standardError = checkServerIdentity(hostname, certificate);
  if (standardError) return standardError;
  const observed = createHash("sha256").update(certificate.raw).digest();
  const expected = Buffer.from(expectedDigest, "hex");
  if (observed.length !== expected.length || !timingSafeEqual(observed, expected)) return new Error("Pinned HTTPS server certificate identity changed.");
  return undefined;
}

function sanitizeResponseHeaders(raw: NodeJS.Dict<string | string[]>): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(raw)) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  return headers;
}

function authorityBoundaryPayload(config: CustomerLocalPinnedHttpsTransportConfig, server: URL): unknown {
  return {
    version: CUSTOMER_LOCAL_PINNED_HTTPS_TRANSPORT_VERSION,
    role: "pinned-https-write-authority-boundary",
    driverId: config.driverId,
    sourceId: config.sourceId,
    serverUrl: server.toString(),
    supportedMethods: [...config.supportedMethods].sort(),
    credentialAlias: config.credentialAlias,
    reviewedOperations: config.reviewedOperations.map((operation) => ({ ...operation })).sort((left, right) => canonical(left).localeCompare(canonical(right))),
    authorizationScheme: config.authorizationScheme,
    caCertificateDigest: pinnedHttpsTransportDigest(config.caCertificatePem),
    serverCertificateSha256: config.serverCertificateSha256,
    timeoutMilliseconds: config.timeoutMilliseconds,
    maximumRequestBytes: config.maximumRequestBytes,
    maximumResponseBytes: config.maximumResponseBytes,
    maximumResponseHeaders: config.maximumResponseHeaders,
    maximumRequestsPerMinute: config.maximumRequestsPerMinute,
  };
}

/**
 * Stable pre-construction identity used to bind an authority issuer and the
 * transport verifier without creating a digest cycle.
 */
export function pinnedHttpsAuthorityBoundaryDigest(config: CustomerLocalPinnedHttpsTransportConfig): string {
  const server = assertConfig(config);
  return pinnedHttpsTransportDigest(authorityBoundaryPayload(config, server));
}

export function createCustomerLocalPinnedHttpsTransport(config: CustomerLocalPinnedHttpsTransportConfig): CustomerLocalHttpTransport {
  const writeAuthorityVerifier = config.writeAuthorityVerifier;
  config = Object.freeze({
    ...config,
    supportedMethods: Object.freeze([...config.supportedMethods]) as unknown as CustomerLocalPinnedHttpsTransportConfig["supportedMethods"],
    independentFromDriverIds: Object.freeze([...config.independentFromDriverIds]) as unknown as string[],
    reviewedOperations: Object.freeze(config.reviewedOperations.map((operation) => Object.freeze({ ...operation }))) as unknown as CustomerLocalPinnedHttpsTransportConfig["reviewedOperations"],
  });
  const server = assertConfig(config);
  const writeAuthorityBoundaryDigest = pinnedHttpsTransportDigest(authorityBoundaryPayload(config, server));
  if (writeAuthorityVerifier) assertTrustedCustomerLocalHttpWriteAuthorityVerifier(writeAuthorityVerifier);
  if (writeAuthorityVerifier && writeAuthorityVerifier.transportAuthorityBoundaryDigest !== writeAuthorityBoundaryDigest) {
    throw new Error("Pinned HTTPS write-authority verifier belongs to a different exact transport boundary.");
  }
  const implementationDigest = pinnedHttpsTransportDigest({
    version: CUSTOMER_LOCAL_PINNED_HTTPS_TRANSPORT_VERSION,
    driverId: config.driverId,
    sourceId: config.sourceId,
    serverUrl: server.toString(),
    supportedMethods: [...config.supportedMethods].sort(),
    independentlyAuthenticated: config.independentlyAuthenticated,
    independentFromDriverIds: [...config.independentFromDriverIds].sort(),
    credentialAlias: config.credentialAlias,
    reviewedOperations: config.reviewedOperations.map((operation) => ({ ...operation })).sort((left, right) => canonical(left).localeCompare(canonical(right))),
    authorizationScheme: config.authorizationScheme,
    caCertificateDigest: pinnedHttpsTransportDigest(config.caCertificatePem),
    serverCertificateSha256: config.serverCertificateSha256,
    timeoutMilliseconds: config.timeoutMilliseconds,
    maximumRequestBytes: config.maximumRequestBytes,
    maximumResponseBytes: config.maximumResponseBytes,
    maximumResponseHeaders: config.maximumResponseHeaders,
    maximumRequestsPerMinute: config.maximumRequestsPerMinute,
    writeAuthorityVerifierDigest: writeAuthorityVerifier?.implementationDigest ?? null,
  });
  const requestTimes: number[] = [];
  const activeReservations = new Set<object>();

  function cleanRequestTimes(now: number): void {
    while (requestTimes.length && requestTimes[0]! <= now - 60_000) requestTimes.shift();
  }

  function prepareRequest(request: CompiledHttpRequest, credential: CustomerLocalCredentialHandle): {
    request: CompiledHttpRequest;
    credential: CustomerLocalCredentialHandle;
    target: URL;
    headers: Record<string, string>;
    encodedBody: Buffer | null;
  } {
    const snapshotted = boundedJsonSnapshot(request) as unknown as CompiledHttpRequest;
    const snapshottedCredential = boundedJsonSnapshot(credential) as unknown as CustomerLocalCredentialHandle;
    if (snapshotted.driverId !== config.driverId || snapshotted.serverUrl !== config.serverUrl || !config.supportedMethods.includes(snapshotted.method)) throw new Error("Compiled HTTPS request does not match the reviewed transport identity, server, or method.");
    if (!config.reviewedOperations.some((operation) => operation.operationId === snapshotted.operationId && operation.method === snapshotted.method && operation.declarationDigest === snapshotted.declarationDigest && pathMatchesTemplate(snapshotted.path, operation.pathTemplate))) throw new Error("Compiled HTTPS request does not match an exact reviewed operation, path template, and declaration.");
    if (snapshottedCredential.alias !== config.credentialAlias || snapshottedCredential.value.length < 8 || Buffer.byteLength(snapshottedCredential.value) > 8_192 || /[\r\n]/.test(snapshottedCredential.value)) throw new Error("Customer-local credential handle is unavailable or malformed.");
    const query = snapshotted.query as Record<string, string>;
    const target = safeRequestUrl(server, snapshotted, query);
    const headers = safeHeaders(snapshotted.headers as Record<string, string>);
    const encodedBody = snapshotted.body === null ? null : Buffer.from(JSON.stringify(snapshotted.body));
    if (encodedBody && encodedBody.byteLength > config.maximumRequestBytes) throw new Error("Compiled HTTPS request body exceeds its reviewed byte bound.");
    headers.authorization = `${config.authorizationScheme} ${snapshottedCredential.value}`;
    headers.accept = "application/json";
    if (encodedBody) headers["content-type"] = "application/json";
    headers["content-length"] = String(encodedBody?.byteLength ?? 0);
    return { request: snapshotted, credential: snapshottedCredential, target, headers, encodedBody };
  }

  async function sendPrepared(prepared: ReturnType<typeof prepareRequest>): Promise<CompiledHttpResponse> {
    return await new Promise<CompiledHttpResponse>((resolvePromise, rejectPromise) => {
      const outbound = httpsRequest(prepared.target, {
        method: prepared.request.method,
        headers: prepared.headers,
        ca: config.caCertificatePem,
        agent: false,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
        checkServerIdentity: (hostname, certificate) => pinnedIdentity(config.serverCertificateSha256, hostname, certificate),
      }, (response) => {
        if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400 && response.headers.location) {
          response.resume();
          rejectPromise(new Error("Pinned HTTPS transport refuses redirects."));
          return;
        }
        if (response.rawHeaders.length / 2 > config.maximumResponseHeaders) {
          response.resume();
          rejectPromise(new Error("Pinned HTTPS response exceeds its header-count bound."));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > config.maximumResponseBytes) response.destroy(new Error("Pinned HTTPS response exceeds its byte bound."));
          else chunks.push(Buffer.from(chunk));
        });
        response.on("error", rejectPromise);
        response.on("end", () => {
          try {
            const declared = response.headers["content-length"];
            if (declared !== undefined && (!/^\d{1,12}$/.test(declared) || Number(declared) !== bytes)) throw new Error("Pinned HTTPS response content length is malformed or mismatched.");
            const raw = Buffer.concat(chunks).toString("utf8");
            const safeResponseHeaders = sanitizeResponseHeaders(response.headers);
            if (raw.includes(prepared.credential.value) || Object.values(safeResponseHeaders).some((value) => typeof value === "string" && value.includes(prepared.credential.value))) throw new Error("Pinned HTTPS response reflected a customer-local credential and was rejected.");
            const contentType = String(response.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
            if (raw.length > 0 && contentType !== "application/json") throw new Error("Pinned HTTPS response is not reviewed JSON.");
            const body = raw.length === 0 ? null : JSON.parse(raw);
            resolvePromise({ status: response.statusCode ?? 0, headers: safeResponseHeaders, body });
          } catch (error) { rejectPromise(error); }
        });
      });
      outbound.setTimeout(config.timeoutMilliseconds, () => outbound.destroy(new Error("Pinned HTTPS request exceeded its timeout.")));
      outbound.on("error", rejectPromise);
      if (prepared.encodedBody) outbound.write(prepared.encodedBody);
      outbound.end();
    });
  }

  function prepareWrite(request: CompiledHttpRequest, credential: CustomerLocalCredentialHandle): CustomerLocalPreparedHttpWrite {
    if (!writeAuthorityVerifier) throw new Error("Pinned HTTPS write preparation requires the configured trusted authority verifier.");
    const prepared = prepareRequest(request, credential);
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(prepared.request.method)) throw new Error("Pinned HTTPS write preparation accepts only reviewed write methods.");
    const preparedAt = Date.now();
    cleanRequestTimes(preparedAt);
    if (requestTimes.length + activeReservations.size >= config.maximumRequestsPerMinute) throw new Error("Pinned HTTPS request-rate bound reached before authority issuance.");
    const reservation = Object.freeze({});
    const reservationDigest = pinnedHttpsTransportDigest({
      version: CUSTOMER_LOCAL_PINNED_HTTPS_TRANSPORT_VERSION,
      role: "pre-authority-write-reservation",
      transportAuthorityBoundaryDigest: writeAuthorityBoundaryDigest,
      requestDigest: pinnedHttpsTransportDigest(prepared.request),
      credentialAlias: prepared.credential.alias,
      preparedAt,
      nonce: randomBytes(32).toString("hex"),
    });
    activeReservations.add(reservation);
    let state: "reserved" | "dispatching" | "cancelled" = "reserved";
    return Object.freeze({
      reservationDigest,
      requestDigest: pinnedHttpsTransportDigest(prepared.request),
      credentialAlias: prepared.credential.alias,
      cancelBeforeAuthority() {
        if (state !== "reserved" || !activeReservations.delete(reservation)) throw new Error("Pinned HTTPS write reservation is absent, already dispatched, or already cancelled.");
        state = "cancelled";
      },
      async dispatch(authorityLease: HttpActionAuthorityLease): Promise<CompiledHttpResponse> {
        if (state !== "reserved" || !activeReservations.delete(reservation)) throw new Error("Pinned HTTPS write reservation is absent, cancelled, or replayed.");
        state = "dispatching";
        writeAuthorityVerifier.consume({ lease: authorityLease, request: prepared.request, credentialAlias: prepared.credential.alias, transportReservationDigest: reservationDigest });
        requestTimes.push(Date.now());
        try {
          return await sendPrepared(prepared);
        } catch (error) {
          throw new CustomerLocalPinnedHttpsDispatchUncertainError(authorityLease, error);
        }
      },
    });
  }

  return Object.freeze({
    driverId: config.driverId,
    sourceId: config.sourceId,
    serverUrl: config.serverUrl,
    implementationDigest,
    supportedMethods: Object.freeze([...config.supportedMethods]) as unknown as CustomerLocalHttpTransport["supportedMethods"],
    independentlyAuthenticated: config.independentlyAuthenticated,
    independentFromDriverIds: Object.freeze([...config.independentFromDriverIds]) as unknown as string[],
    ...(writeAuthorityVerifier ? {
      writeAuthorityBoundaryDigest,
      writeAuthorityVerifierDigest: writeAuthorityVerifier.implementationDigest,
      prepareWrite,
    } : {}),
    async perform(request: CompiledHttpRequest, credential: CustomerLocalCredentialHandle, authorityLease?: HttpActionAuthorityLease): Promise<CompiledHttpResponse> {
      if (writeAuthorityVerifier && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return await prepareWrite(request, credential).dispatch(authorityLease!);
      const prepared = prepareRequest(request, credential);
      const now = Date.now();
      cleanRequestTimes(now);
      if (requestTimes.length >= config.maximumRequestsPerMinute) throw new Error("Pinned HTTPS request-rate bound reached.");
      requestTimes.push(now);
      try {
        return await sendPrepared(prepared);
      } catch (error) {
        throw error;
      }
    },
  });
}

/**
 * Hardened write constructor. Unlike the compatibility constructor, it cannot
 * create a write-capable transport without the trusted immediate lease verifier.
 */
export function createAuthorityEnforcedCustomerLocalPinnedHttpsTransport(
  config: CustomerLocalPinnedHttpsTransportConfig & { writeAuthorityVerifier: CustomerLocalHttpWriteAuthorityVerifier },
): CustomerLocalHttpTransport {
  if (!config.supportedMethods.some((method) => ["POST", "PUT", "PATCH", "DELETE"].includes(method))) throw new Error("Authority-enforced pinned HTTPS transport requires at least one reviewed write method.");
  const transport = createCustomerLocalPinnedHttpsTransport(config);
  authorityEnforcedPinnedTransports.add(transport);
  return transport;
}

export function assertAuthorityEnforcedCustomerLocalPinnedHttpsTransport(transport: CustomerLocalHttpTransport): void {
  if (!authorityEnforcedPinnedTransports.has(transport)) throw new Error("Action transport is not an instance of the trusted authority-enforced pinned HTTPS implementation.");
}
