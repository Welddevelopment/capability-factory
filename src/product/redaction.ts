import type { CapabilityRequest } from "./contracts.js";

const SENSITIVE_KEY = /authorization|cookie|password|secret|token|api[-_]?key|credential/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const TOKEN_PAIR = /\btoken\s+[A-Za-z0-9._-]+:[A-Za-z0-9._-]+/gi;

export function redactText(value: string): string {
  return value.replaceAll(BEARER, "Bearer [REDACTED]").replaceAll(TOKEN_PAIR, "token [REDACTED]");
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(item),
    ]),
  );
}

/** Preserve policy identifiers while redacting user-controlled prose. */
export function sanitizeCapabilityRequest(request: CapabilityRequest): CapabilityRequest {
  return {
    ...structuredClone(request),
    context: {
      ...structuredClone(request.context),
      ordinaryGoal: "[WITHHELD BY CUSTOMER DATA PLANE]",
      blockedReason: "[WITHHELD BY CUSTOMER DATA PLANE]",
    },
  };
}
