import { createHash } from "node:crypto";
import type { CapabilityAction, CapabilityManifest, JsonValue } from "./manifest.js";
import { capabilityManifestSchema, validateNoLiteralSecrets } from "./manifest.js";
import type { TraceWriter } from "./trace.js";
import type { LocalSecretProvider } from "./product/secrets.js";

export interface RuntimeTarget {
  baseUrl: string;
  allowedPaths: string[];
  /** Optional per-method route policy. Existing targets retain their legacy path-only policy. */
  allowedMethods?: Partial<Record<CapabilityAction["request"]["method"], string[]>>;
}

export interface RuntimeConfiguration {
  targets: Record<string, RuntimeTarget>;
  /** Legacy/local-fixture values. Production-style customer paths should leave this empty. */
  secrets: Record<string, string>;
  /** Customer-local resolver. Secret values cross only the final HTTP execution boundary. */
  secretProvider?: LocalSecretProvider;
  operationGuard?: RuntimeOperationGuard;
}

export interface RuntimeActionControlContext {
  runId: string;
  capabilityId: string;
  actionName: string;
  targetAlias: string;
  method: CapabilityAction["request"]["method"] | "BROWSER";
  write: boolean;
  testMode: boolean;
}

export interface RuntimeOperationGuard {
  beforeAction(context: RuntimeActionControlContext): void;
  afterAction(
    context: RuntimeActionControlContext,
    outcome: "succeeded" | "failed" | "unknown",
    detail: { status?: number; category?: string },
  ): void;
}

export class CapabilityExecutionError extends Error {
  constructor(
    readonly category: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function lookupInput(input: Record<string, unknown>, key: string): unknown {
  if (!(key in input)) throw new CapabilityExecutionError("template", `Missing input value: ${key}`);
  return input[key];
}

function renderString(template: string, input: Record<string, unknown>): unknown {
  const exact = template.match(/^\{\{input\.([a-zA-Z0-9_]+)\}\}$/);
  if (exact?.[1]) return lookupInput(input, exact[1]);
  return template.replaceAll(/\{\{input\.([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) =>
    String(lookupInput(input, key)),
  );
}

function renderPath(template: string, input: Record<string, unknown>): string {
  return template.replaceAll(/\{\{input\.([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) =>
    encodeURIComponent(String(lookupInput(input, key))),
  );
}

function render(value: JsonValue, input: Record<string, unknown>): unknown {
  if (typeof value === "string") return renderString(value, input);
  if (Array.isArray(value)) return value.map((item) => render(item, input));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, render(item, input)]));
  }
  return value;
}

function pointer(value: unknown, jsonPointer: string): unknown {
  const parts = jsonPointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let current = value;
  for (const part of parts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function redactExactSecrets(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return secrets.reduce((safe, secret) => secret ? safe.replaceAll(secret, "[REDACTED]") : safe, value);
  }
  if (Array.isArray(value)) return value.map((item) => redactExactSecrets(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactExactSecrets(item, secrets)]));
  }
  return value;
}

async function readBoundedResponse(response: Response, limit: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > limit) {
    await response.body?.cancel("Declared response length exceeds the capability limit").catch(() => undefined);
    throw new CapabilityExecutionError("response_size", "Response exceeded declared byte limit");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel("Response exceeded the capability byte limit").catch(() => undefined);
        throw new CapabilityExecutionError("response_size", "Response exceeded declared byte limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function matchesAllowedPath(pathname: string, pattern: string): boolean {
  const expression = new RegExp(
    `^${pattern
      .split("/")
      .map((part) => (part.startsWith(":") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("/")}$`,
  );
  return expression.test(pathname);
}

export class CapabilityRuntime {
  constructor(
    private readonly configuration: RuntimeConfiguration,
    private readonly trace?: TraceWriter,
  ) {}

  validateManifest(raw: unknown): CapabilityManifest {
    const manifest = capabilityManifestSchema.parse(raw);
    validateNoLiteralSecrets(manifest, Object.values(this.configuration.secrets));
    const target = this.configuration.targets[manifest.baseUrlAlias];
    if (!target) throw new Error(`Unknown base URL alias: ${manifest.baseUrlAlias}`);
    const url = new URL(target.baseUrl);
    if (!(url.hostname === "127.0.0.1" || url.hostname === "localhost")) {
      throw new Error("Capability target is not an approved localhost host");
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("Capability target cannot contain credentials, query parameters, or a fragment");
    }
    for (const action of manifest.actions) {
      if (/[?#\\]/.test(action.request.pathTemplate)) {
        throw new Error(`Action path must not contain a query, fragment, or backslash: ${action.request.pathTemplate}`);
      }
      const pathWithoutInputTemplates = action.request.pathTemplate.replaceAll(
        /\{\{input\.[a-zA-Z0-9_]+\}\}/g,
        "",
      );
      if (/[{}]/.test(pathWithoutInputTemplates)) {
        throw new Error(
          `Action path contains an unresolved placeholder; use {{input.name}} syntax: ${action.request.pathTemplate}`,
        );
      }
      if (!target.allowedPaths.some((allowed) => matchesAllowedPath(action.request.pathTemplate, allowed))) {
        throw new Error(`Action route is not allowlisted: ${action.request.pathTemplate}`);
      }
      const methodPaths = target.allowedMethods?.[action.request.method];
      if (
        target.allowedMethods &&
        (!methodPaths || !methodPaths.some((allowed) => matchesAllowedPath(action.request.pathTemplate, allowed)))
      ) {
        throw new Error(
          `Action method and route are not allowlisted: ${action.request.method} ${action.request.pathTemplate}`,
        );
      }
      if (action.request.method !== "GET" && action.safety.idempotency !== "required") {
        throw new Error(`Write action ${action.name} must require idempotency`);
      }
      const sensitiveHeader = Object.keys(action.request.headerTemplate).find((header) =>
        /authorization|api[-_]?key|secret|token/i.test(header),
      );
      if (sensitiveHeader) {
        throw new Error(`Authentication header ${sensitiveHeader} must be supplied by secret alias`);
      }
    }
    if (
      manifest.auth.kind !== "none" &&
      !this.configuration.secrets[manifest.auth.secretAlias] &&
      !this.configuration.secretProvider?.has(manifest.auth.secretAlias)
    ) {
      throw new Error(`Unknown secret alias: ${manifest.auth.secretAlias}`);
    }
    return manifest;
  }

  async execute(
    manifest: CapabilityManifest,
    actionName: string,
    input: Record<string, unknown>,
    options: { runId: string; testMode?: boolean },
  ): Promise<{ status: number; output: Record<string, unknown>; raw: unknown }> {
    this.validateManifest(manifest);
    const action = manifest.actions.find((candidate) => candidate.name === actionName);
    if (!action) throw new CapabilityExecutionError("action", `Unknown action: ${actionName}`);
    this.validateInput(action, input);
    const target = this.configuration.targets[manifest.baseUrlAlias];
    if (!target) throw new CapabilityExecutionError("target", "Missing runtime target");
    const renderedPath = renderPath(action.request.pathTemplate, input);
    const baseUrl = new URL(target.baseUrl);
    const url = new URL(renderedPath, baseUrl);
    if (url.origin !== baseUrl.origin) {
      throw new CapabilityExecutionError("allowlist", "Rendered route escaped the approved target origin");
    }
    if (!target.allowedPaths.some((allowed) => matchesAllowedPath(url.pathname, allowed))) {
      throw new CapabilityExecutionError("allowlist", `Rendered route is not allowlisted: ${url.pathname}`);
    }
    const methodPaths = target.allowedMethods?.[action.request.method];
    if (
      target.allowedMethods &&
      (!methodPaths || !methodPaths.some((allowed) => matchesAllowedPath(url.pathname, allowed)))
    ) {
      throw new CapabilityExecutionError(
        "allowlist",
        `Rendered method and route are not allowlisted: ${action.request.method} ${url.pathname}`,
      );
    }
    const query = render(action.request.queryTemplate, input) as Record<string, unknown>;
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers = new Headers({ accept: "application/json" });
    const renderedHeaders = render(action.request.headerTemplate, input) as Record<string, unknown>;
    for (const [key, value] of Object.entries(renderedHeaders)) headers.set(key, String(value));
    if (action.safety.idempotency === "required") {
      const key = createHash("sha256")
        .update(`${options.runId}:${manifest.id}:${action.name}:${canonical(input)}`)
        .digest("hex");
      headers.set("idempotency-key", key);
    }
    if (options.testMode) headers.set("x-capability-test", "1");
    const hasBody = action.request.bodyTemplate !== null && action.request.method !== "GET";
    const body = hasBody ? JSON.stringify(render(action.request.bodyTemplate, input)) : undefined;
    if (hasBody) headers.set("content-type", "application/json");
    const controlContext: RuntimeActionControlContext = {
      runId: options.runId,
      capabilityId: manifest.id,
      actionName: action.name,
      targetAlias: manifest.baseUrlAlias,
      method: action.request.method,
      write: action.request.method !== "GET",
      testMode: options.testMode ?? false,
    };
    // Policy and budget checks happen before a secret value is resolved.
    this.configuration.operationGuard?.beforeAction(controlContext);
    let authenticationSecret: string | undefined;
    if (manifest.auth.kind !== "none") {
      const legacyValue = this.configuration.secrets[manifest.auth.secretAlias];
      let resolved: { value: string; version: string } | undefined;
      try {
        resolved = legacyValue
          ? { value: legacyValue, version: "legacy-inline" }
          : await this.configuration.secretProvider?.resolve({
              alias: manifest.auth.secretAlias,
              targetAlias: manifest.baseUrlAlias,
              actionName: action.name,
              method: action.request.method,
              runId: options.runId,
              testMode: options.testMode ?? false,
            });
      } catch (error) {
        this.configuration.operationGuard?.afterAction(controlContext, "failed", { category: "credential" });
        throw new CapabilityExecutionError("credential", error instanceof Error ? error.message : String(error));
      }
      if (!resolved?.value) throw new CapabilityExecutionError("credential", `Customer-local secret alias is unavailable: ${manifest.auth.secretAlias}`);
      authenticationSecret = resolved.value;
      if (manifest.auth.kind === "bearer") {
        headers.set("authorization", `Bearer ${resolved.value}`);
      } else {
        headers.set(manifest.auth.headerName, resolved.value);
      }
    }
    const authenticationHeader = manifest.auth.kind === "bearer"
      ? "authorization"
      : manifest.auth.kind === "apiKey"
        ? manifest.auth.headerName.toLowerCase()
        : undefined;
    const traceHeaders = Object.fromEntries(
      [...headers.entries()].map(([key, value]) => [
        key,
        key.toLowerCase() === authenticationHeader ? "[REDACTED]" : value,
      ]),
    );
    this.trace?.record("http.request", {
      capabilityId: manifest.id,
      action: action.name,
      method: action.request.method,
      url: url.toString(),
      headers: traceHeaders,
      body: body ? JSON.parse(body) : null,
      testMode: options.testMode ?? false,
    });
    let response: Response;
    try {
      const requestInit: RequestInit = {
        method: action.request.method,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(action.safety.timeoutMs),
        ...(body === undefined ? {} : { body }),
      };
      response = await fetch(url, requestInit);
    } catch (error) {
      this.configuration.operationGuard?.afterAction(controlContext, "unknown", { category: "network" });
      throw new CapabilityExecutionError("network", error instanceof Error ? error.message : String(error));
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedResponse(response, action.safety.maxResponseBytes);
    } catch (error) {
      const category = error instanceof CapabilityExecutionError ? error.category : "network";
      this.configuration.operationGuard?.afterAction(controlContext, "unknown", { status: response.status, category });
      if (error instanceof CapabilityExecutionError) throw error;
      throw new CapabilityExecutionError("network", error instanceof Error ? error.message : String(error), response.status);
    }
    const text = new TextDecoder().decode(bytes);
    let raw: unknown = text;
    let parsedJson = false;
    if (text) {
      try {
        raw = JSON.parse(text);
        parsedJson = true;
      } catch {
        raw = text;
      }
    }
    const exactSecrets = authenticationSecret ? [authenticationSecret] : [];
    const safeRaw = redactExactSecrets(raw, exactSecrets);
    this.trace?.record("http.response", { action: action.name, status: response.status, body: safeRaw });
    if (!action.response.acceptedStatuses.includes(response.status)) {
      const category = response.status === 401
        ? "credential"
        : response.status === 403
          ? "permission"
          : response.status === 429
            ? "rate_limit"
            : response.status >= 500
              ? "service"
              : "request";
      this.configuration.operationGuard?.afterAction(controlContext, "failed", { status: response.status, category });
      const safeText = redactExactSecrets(text.slice(0, 500), exactSecrets) as string;
      throw new CapabilityExecutionError(category, `HTTP ${response.status}: ${safeText}`, response.status);
    }
    const expectsStructuredOutput = Object.keys(action.response.outputPointers).length > 0;
    if (text && !parsedJson && (expectsStructuredOutput || response.headers.get("content-type")?.toLowerCase().includes("json"))) {
      this.configuration.operationGuard?.afterAction(controlContext, "unknown", { status: response.status, category: "response_parse" });
      throw new CapabilityExecutionError("response_parse", "Accepted response was not valid JSON", response.status);
    }
    const output = Object.fromEntries(
      Object.entries(action.response.outputPointers).map(([key, value]) => [key, pointer(safeRaw, value)]),
    );
    const missingOutputs = Object.entries(output).filter(([, value]) => value === undefined).map(([key]) => key);
    if (missingOutputs.length > 0) {
      this.configuration.operationGuard?.afterAction(controlContext, "unknown", { status: response.status, category: "response_schema" });
      throw new CapabilityExecutionError("response_schema", `Accepted response omitted declared outputs: ${missingOutputs.join(", ")}`, response.status);
    }
    this.configuration.operationGuard?.afterAction(controlContext, "succeeded", { status: response.status });
    return { status: response.status, output, raw: safeRaw };
  }

  private validateInput(action: CapabilityAction, input: Record<string, unknown>): void {
    const schema = action.inputSchema;
    const unknown = Object.keys(input).filter((key) => !(key in schema.properties));
    if (unknown.length > 0) {
      throw new CapabilityExecutionError("input", `Unknown input fields: ${unknown.join(", ")}`);
    }
    for (const required of schema.required) {
      if (!(required in input)) {
        throw new CapabilityExecutionError("input", `Missing required input: ${required}`);
      }
    }
    for (const [key, value] of Object.entries(input)) {
      const property = schema.properties[key];
      if (!property) continue;
      const valid =
        (property.type === "string" && typeof value === "string") ||
        (property.type === "boolean" && typeof value === "boolean") ||
        (property.type === "number" && typeof value === "number" && Number.isFinite(value)) ||
        (property.type === "integer" && typeof value === "number" && Number.isInteger(value));
      if (!valid) throw new CapabilityExecutionError("input", `Invalid type for input: ${key}`);
    }
  }
}
