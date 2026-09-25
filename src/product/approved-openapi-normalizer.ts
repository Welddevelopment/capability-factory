import { createHash } from "node:crypto";
import type { ApprovedOpenApiMaterial, JsonValue } from "./onboarding-adapter-factory.js";

export const APPROVED_OPENAPI_NORMALIZER_VERSION = "1.0" as const;

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
const WRITE_METHODS = new Set(["post", "put", "patch", "delete"]);
const secretShaped = /(?:bearer\s+[a-z0-9._~-]{8,}|sk-[a-z0-9_-]{12,}|password\s*[:=]|token\s*[:=]|https?:\/\/[^\s/:]+:[^\s/@]+@)/i;

export interface OpenApiServerReview {
  materialDigest: string;
  selectedUrl: string;
  confirmedByAlias: string;
  confirmedAt: string;
}

export interface OpenApiOperationalMetadata {
  operationId: string;
  method: string;
  path: string;
  consequence: "read" | "write";
  documentedResponseStatuses: string[];
  documentedErrorStatuses: string[];
  paginationParameterCandidates: string[];
  securitySchemeAliases: string[];
  operationalUnknowns: string[];
}

export interface ApprovedOpenApiNormalizationResult {
  schemaVersion: typeof APPROVED_OPENAPI_NORMALIZER_VERSION;
  status: "blocked" | "review-required";
  executable: false;
  materialId: string;
  targetAlias?: string;
  originalMaterialDigest: string;
  normalizedMaterialDigest: string;
  normalizedMaterial: ApprovedOpenApiMaterial;
  serverCandidates: string[];
  confirmedServerUrl?: string;
  operations: OpenApiOperationalMetadata[];
  blockers: string[];
  unknowns: string[];
  normalizationReceiptDigest: string;
}

function canonical(value: unknown): string {
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
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function decodePointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolvePointer(root: unknown, reference: string): unknown {
  if (!reference.startsWith("#/")) throw new Error(`External or non-local OpenAPI reference is unsupported: ${reference}`);
  let current = root;
  for (const rawSegment of reference.slice(2).split("/")) {
    const segment = decodePointerSegment(rawSegment);
    if (current === null || typeof current !== "object" || !(segment in (current as Record<string, unknown>))) {
      throw new Error(`OpenAPI reference does not resolve inside the approved document: ${reference}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolveInternalReferences(root: JsonValue): JsonValue {
  let visitedNodes = 0;
  const walk = (value: unknown, stack: string[], depth: number): JsonValue => {
    visitedNodes += 1;
    if (visitedNodes > 20_000) throw new Error("Approved OpenAPI material exceeds the 20,000-node normalization ceiling.");
    if (depth > 32) throw new Error("Approved OpenAPI material exceeds the internal-reference depth ceiling.");
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.map((item) => walk(item, stack, depth + 1));
    const source = record(value, "OpenAPI node");
    if ("$ref" in source) {
      if (typeof source.$ref !== "string") throw new Error("OpenAPI $ref must be a string.");
      if (Object.keys(source).length !== 1) throw new Error(`OpenAPI reference ${source.$ref} has sibling fields; explicit engineer review is required.`);
      if (stack.includes(source.$ref)) throw new Error(`Cyclic OpenAPI reference is unsupported in onboarding normalization: ${source.$ref}`);
      return walk(resolvePointer(root, source.$ref), [...stack, source.$ref], depth + 1);
    }
    return Object.fromEntries(Object.entries(source).map(([key, item]) => [key, walk(item, stack, depth + 1)])) as JsonValue;
  };
  return walk(root, [], 0);
}

function securityAliases(operation: Record<string, unknown>, document: Record<string, unknown>): string[] {
  const raw = operation.security ?? document.security ?? [];
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.flatMap((item) => item && typeof item === "object" && !Array.isArray(item) ? Object.keys(item as Record<string, unknown>) : []))].sort();
}

function operationMetadata(document: Record<string, unknown>): OpenApiOperationalMetadata[] {
  const paths = document.paths && typeof document.paths === "object" && !Array.isArray(document.paths)
    ? document.paths as Record<string, unknown>
    : {};
  const result: OpenApiOperationalMetadata[] = [];
  for (const [route, pathValue] of Object.entries(paths)) {
    const pathItem = record(pathValue, `OpenAPI path ${route}`);
    const pathParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const [methodValue, operationValue] of Object.entries(pathItem)) {
      const method = methodValue.toLowerCase();
      if (!HTTP_METHODS.has(method)) continue;
      const operation = record(operationValue, `${method.toUpperCase()} ${route}`);
      const operationId = typeof operation.operationId === "string" && operation.operationId.length > 0
        ? operation.operationId
        : `${method}:${route}`;
      const responses = operation.responses && typeof operation.responses === "object" && !Array.isArray(operation.responses)
        ? Object.keys(operation.responses as Record<string, unknown>)
        : [];
      const allParameters = [...pathParameters, ...(Array.isArray(operation.parameters) ? operation.parameters : [])];
      const names = allParameters.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const name = (item as Record<string, unknown>).name;
        return typeof name === "string" ? [name] : [];
      });
      const paginationParameterCandidates = names.filter((name) => /^(?:page|page_size|pagesize|limit|offset|cursor|after|before|continuation(?:_token)?)$/i.test(name));
      const consequence = WRITE_METHODS.has(method) ? "write" as const : "read" as const;
      const documentedErrorStatuses = responses.filter((status) => /^(?:4|5)\d\d$/.test(status) || /^(?:4|5)XX$/i.test(status));
      const operationalUnknowns = [
        ...(documentedErrorStatuses.length === 0 ? ["No explicit 4xx/5xx error semantics are documented for this operation."] : []),
        ...(paginationParameterCandidates.length > 0 ? ["Pagination parameters are observed but their stop/continuation semantics still require review."] : []),
        "Live timeouts, rate limits, and drift are not proved by static OpenAPI material.",
      ];
      result.push({
        operationId,
        method: method.toUpperCase(),
        path: route,
        consequence,
        documentedResponseStatuses: [...responses].sort(),
        documentedErrorStatuses: [...documentedErrorStatuses].sort(),
        paginationParameterCandidates: [...new Set(paginationParameterCandidates)].sort(),
        securitySchemeAliases: securityAliases(operation, document),
        operationalUnknowns,
      });
    }
  }
  return result.sort((left, right) => `${left.path}:${left.method}`.localeCompare(`${right.path}:${right.method}`));
}

export function normalizeApprovedOpenApiMaterial(
  material: ApprovedOpenApiMaterial,
  serverReview?: OpenApiServerReview,
): ApprovedOpenApiNormalizationResult {
  if (material.kind !== "openapi" || material.approved !== true) throw new Error("Only explicitly approved OpenAPI material can be normalized.");
  if (secretShaped.test(canonical(material))) throw new Error("Approved OpenAPI material contains credential-shaped content; aliases only are allowed.");
  if (Buffer.byteLength(JSON.stringify(material.document), "utf8") > 10_000_000) throw new Error("Approved OpenAPI document exceeds the 10 MB normalization ceiling.");
  const document = record(material.document, "Approved OpenAPI document");
  const version = typeof document.openapi === "string" ? document.openapi : "";
  if (!/^3(?:\.\d+){1,2}(?:[-+].*)?$/.test(version)) throw new Error("Only approved OpenAPI 3.x material is supported.");
  const originalMaterialDigest = digest(material);
  const normalizedDocument = resolveInternalReferences(material.document);
  const normalizedRecord = record(normalizedDocument, "Normalized OpenAPI document");
  const rawServers = Array.isArray(normalizedRecord.servers) ? normalizedRecord.servers : [];
  const serverCandidates = [...new Set(rawServers.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const url = (item as Record<string, unknown>).url;
    return typeof url === "string" && url.length > 0 ? [url] : [];
  }))].sort();
  if (serverCandidates.some((url) => secretShaped.test(url))) throw new Error("OpenAPI server URL contains credential-shaped content.");
  if (serverReview) {
    if (serverReview.materialDigest !== originalMaterialDigest) throw new Error("Server confirmation is bound to different approved OpenAPI material.");
    if (!serverCandidates.includes(serverReview.selectedUrl)) throw new Error("Confirmed server URL is not present in the approved OpenAPI material.");
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{1,159}$/.test(serverReview.confirmedByAlias) || !Number.isFinite(Date.parse(serverReview.confirmedAt))) {
      throw new Error("Server confirmation requires a stable confirmer alias and timestamp.");
    }
  }
  const components = normalizedRecord.components && typeof normalizedRecord.components === "object" && !Array.isArray(normalizedRecord.components)
    ? normalizedRecord.components as Record<string, unknown>
    : {};
  const schemes = components.securitySchemes && typeof components.securitySchemes === "object" && !Array.isArray(components.securitySchemes)
    ? components.securitySchemes as Record<string, unknown>
    : {};
  const oauthAliases = Object.entries(schemes).flatMap(([alias, raw]) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    return (raw as Record<string, unknown>).type === "oauth2" ? [alias] : [];
  });
  const blockers = [
    ...(serverCandidates.length === 0 ? ["server-url-unavailable"] : []),
    ...(serverCandidates.length > 0 && !serverReview ? ["server-url-not-confirmed"] : []),
  ];
  const unknowns = [
    ...(oauthAliases.length > 0 ? [`OAuth lifecycle and refresh behavior require a customer-local binding for: ${oauthAliases.join(", ")}.`] : []),
    "Static normalization does not establish live availability, rate limits, timeouts, production errors, or drift behavior.",
  ];
  const normalizedMaterial: ApprovedOpenApiMaterial = { ...structuredClone(material), document: normalizedDocument };
  const receiptCore = {
    schemaVersion: APPROVED_OPENAPI_NORMALIZER_VERSION,
    materialId: material.materialId,
    targetAlias: material.targetAlias,
    originalMaterialDigest,
    normalizedMaterialDigest: digest(normalizedMaterial),
    serverCandidates,
    confirmedServerUrl: serverReview?.selectedUrl,
    operations: operationMetadata(normalizedRecord),
    blockers,
    unknowns,
  };
  return {
    schemaVersion: APPROVED_OPENAPI_NORMALIZER_VERSION,
    status: blockers.length > 0 ? "blocked" : "review-required",
    executable: false,
    materialId: material.materialId,
    ...(material.targetAlias ? { targetAlias: material.targetAlias } : {}),
    originalMaterialDigest,
    normalizedMaterialDigest: receiptCore.normalizedMaterialDigest,
    normalizedMaterial,
    serverCandidates,
    ...(serverReview ? { confirmedServerUrl: serverReview.selectedUrl } : {}),
    operations: receiptCore.operations,
    blockers,
    unknowns,
    normalizationReceiptDigest: digest(receiptCore),
  };
}
