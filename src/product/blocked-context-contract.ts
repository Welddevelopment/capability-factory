import { z } from "zod";
import { redactText } from "./redaction.js";

export const BLOCKED_CONTEXT_SCHEMA_VERSION = "1.0" as const;
export const BLOCKED_CONTEXT_MEDIA_TYPE =
  "application/vnd.capability-factory.blocked-context+json;version=1.0" as const;

const MAX_SERIALIZED_BYTES = 64 * 1024;
const MAX_CONTEXT_ENTRIES = 32;
const MAX_AUTHORITY_REFERENCES = 32;

const identifier = z
  .string()
  .min(1)
  .max(180)
  .regex(/^[a-zA-Z0-9_.-]+$/, "Identity must contain only letters, numbers, dots, underscores or hyphens.");
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const contextKey = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/, "Context keys must be stable non-secret labels.");

const SECRET_LOOKING_KEY =
  /(^|[._-])(authorization|cookie|password|passwd|secret|token|api[-_]?key|credential(?:[-_]?value)?|private[-_]?key|session)([._-]|$)/i;
const SECRET_LOOKING_VALUES: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}\b/i,
  /\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}\b/i,
  /\b(?:api[-_ ]?key|access[-_ ]?token|client[-_ ]?secret|password|passwd|private[-_ ]?key)\s*[:=]\s*["']?[^\s"']{6,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b/,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@/i,
];

export const blockedContextIdentitySchema = z
  .object({
    tenantId: identifier,
    requestId: identifier,
    parentGoalId: identifier,
    workItemId: identifier,
  })
  .strict();
export type BlockedContextIdentity = z.infer<typeof blockedContextIdentitySchema>;

export const blockedContextEntrySchema = z
  .object({
    key: contextKey,
    value: z.union([z.string().trim().min(1).max(2_000), z.number().finite(), z.boolean(), z.null()]),
  })
  .strict();
export type BlockedContextEntry = z.infer<typeof blockedContextEntrySchema>;

export const authorityReferenceSchema = z
  .object({
    referenceId: identifier,
    referenceType: z.enum([
      "policy",
      "scope",
      "approval",
      "grant",
      "credential-alias",
      "other",
    ]),
  })
  .strict();
export type AuthorityReference = z.infer<typeof authorityReferenceSchema>;

const rawBlockedContextContractSchema = z
  .object({
    schemaVersion: z.literal(BLOCKED_CONTEXT_SCHEMA_VERSION),
    identity: blockedContextIdentitySchema,
    originalGoal: boundedText(4_000),
    attemptedStep: boundedText(2_000),
    observedBlocker: boundedText(2_000),
    relevantContext: z.array(blockedContextEntrySchema).max(MAX_CONTEXT_ENTRIES),
    requiredOutcome: boundedText(2_000),
    existingAuthorityReferences: z.array(authorityReferenceSchema).max(MAX_AUTHORITY_REFERENCES),
    /**
     * This envelope reports a blocker. It can point at customer-owned policy
     * records, but it can never create, widen or confirm authority.
     */
    authorityEffect: z.literal("none"),
  })
  .strict();

function looksLikeSecret(value: string): boolean {
  return SECRET_LOOKING_VALUES.some((pattern) => pattern.test(value));
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

/**
 * Framework-neutral blocked-work contract. It deliberately carries no
 * capability mode, operation, credential value or executable authority.
 */
export const blockedContextContractSchema = rawBlockedContextContractSchema.superRefine((contract, context) => {
  const prose = [
    ["originalGoal", contract.originalGoal],
    ["attemptedStep", contract.attemptedStep],
    ["observedBlocker", contract.observedBlocker],
    ["requiredOutcome", contract.requiredOutcome],
  ] as const;

  for (const [field, value] of prose) {
    if (looksLikeSecret(value)) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: "Secret-looking values are forbidden; pass a customer-local alias or authority reference instead.",
      });
    }
  }

  contract.relevantContext.forEach((entry, index) => {
    if (SECRET_LOOKING_KEY.test(entry.key)) {
      context.addIssue({
        code: "custom",
        path: ["relevantContext", index, "key"],
        message: "Secret-looking context keys are forbidden.",
      });
    }
    if (typeof entry.value === "string" && looksLikeSecret(entry.value)) {
      context.addIssue({
        code: "custom",
        path: ["relevantContext", index, "value"],
        message: "Secret-looking context values are forbidden; pass a customer-local alias instead.",
      });
    }
  });

  contract.existingAuthorityReferences.forEach((reference, index) => {
    if (looksLikeSecret(reference.referenceId)) {
      context.addIssue({
        code: "custom",
        path: ["existingAuthorityReferences", index, "referenceId"],
        message: "Authority references must be stable aliases or IDs, never secret-looking values.",
      });
    }
  });

  for (const duplicate of duplicateValues(contract.relevantContext.map((entry) => entry.key))) {
    context.addIssue({
      code: "custom",
      path: ["relevantContext"],
      message: `Duplicate context key is ambiguous: ${duplicate}`,
    });
  }
  for (const duplicate of duplicateValues(
    contract.existingAuthorityReferences.map(
      (reference) => `${reference.referenceType}:${reference.referenceId}`,
    ),
  )) {
    context.addIssue({
      code: "custom",
      path: ["existingAuthorityReferences"],
      message: `Duplicate authority reference is ambiguous: ${duplicate}`,
    });
  }
});
export type BlockedContextContract = z.infer<typeof blockedContextContractSchema>;

export const blockedContextValidationReceiptSchema = z.object({
  schemaVersion: z.literal(BLOCKED_CONTEXT_SCHEMA_VERSION),
  accepted: z.literal(true),
  mediaType: z.literal(BLOCKED_CONTEXT_MEDIA_TYPE),
  authorityEffect: z.literal("none"),
  next: z.literal("adapter-discovery-review"),
  contract: blockedContextContractSchema,
}).strict();
export type BlockedContextValidationReceipt = z.infer<typeof blockedContextValidationReceiptSchema>;

export type BlockedContextValidation =
  | { ok: true; value: BlockedContextContract }
  | { ok: false; issues: string[] };

function sanitizeAcceptedContract(contract: BlockedContextContract): BlockedContextContract {
  return {
    ...structuredClone(contract),
    originalGoal: redactText(contract.originalGoal),
    attemptedStep: redactText(contract.attemptedStep),
    observedBlocker: redactText(contract.observedBlocker),
    relevantContext: contract.relevantContext.map((entry) => ({
      ...entry,
      value: typeof entry.value === "string" ? redactText(entry.value) : entry.value,
    })),
    requiredOutcome: redactText(contract.requiredOutcome),
  };
}

/** Validate, reject secret-bearing input, and return a detached sanitized value. */
export function parseBlockedContext(value: unknown): BlockedContextContract {
  return sanitizeAcceptedContract(blockedContextContractSchema.parse(value));
}

/** Non-throwing helper for SDKs and HTTP handlers in any framework. */
export function validateBlockedContext(value: unknown): BlockedContextValidation {
  const result = blockedContextContractSchema.safeParse(value);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => {
        const location = issue.path.length ? issue.path.join(".") : "contract";
        return `${location}: ${issue.message}`;
      }),
    };
  }
  return { ok: true, value: sanitizeAcceptedContract(result.data) };
}

/** Request-level correlation key; it distinguishes two delivery attempts for the same work item. */
export function blockedContextRequestKey(identity: BlockedContextIdentity): string {
  return `${identity.tenantId}:${identity.parentGoalId}:${identity.workItemId}:${identity.requestId}`;
}

/** Stable work identity; retries may use a new request ID without becoming a different work item. */
export function blockedContextWorkItemKey(identity: BlockedContextIdentity): string {
  return `${identity.tenantId}:${identity.parentGoalId}:${identity.workItemId}`;
}

/** Backward-compatible request-level identity helper. */
export const blockedContextIdentityKey = blockedContextRequestKey;

export function sameBlockedWorkItem(
  left: Pick<BlockedContextContract, "identity">,
  right: Pick<BlockedContextContract, "identity">,
): boolean {
  return blockedContextWorkItemKey(left.identity) === blockedContextWorkItemKey(right.identity);
}

/** Canonical UTF-8 JSON body for a customer-local, language-neutral HTTP boundary. */
export function serializeBlockedContext(value: unknown): string {
  const serialized = JSON.stringify(parseBlockedContext(value));
  if (Buffer.byteLength(serialized, "utf8") > MAX_SERIALIZED_BYTES) {
    throw new Error(`Blocked-context body exceeds ${MAX_SERIALIZED_BYTES} UTF-8 bytes.`);
  }
  return serialized;
}

/** Parse an HTTP body without accepting oversized or non-JSON input. */
export function deserializeBlockedContext(body: string | Uint8Array): BlockedContextContract {
  const bytes = typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.byteLength;
  if (bytes > MAX_SERIALIZED_BYTES) {
    throw new Error(`Blocked-context body exceeds ${MAX_SERIALIZED_BYTES} UTF-8 bytes.`);
  }
  const text = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
  return parseBlockedContext(JSON.parse(text) as unknown);
}

/**
 * Safe diagnostic projection. Business prose and context values stay on the
 * customer data plane; stable IDs and non-authorizing references remain useful.
 */
export function redactBlockedContextForAudit(contract: BlockedContextContract): BlockedContextContract {
  const parsed = parseBlockedContext(contract);
  return {
    ...parsed,
    originalGoal: "[WITHHELD BY CUSTOMER DATA PLANE]",
    attemptedStep: "[WITHHELD BY CUSTOMER DATA PLANE]",
    observedBlocker: "[WITHHELD BY CUSTOMER DATA PLANE]",
    relevantContext: parsed.relevantContext.map((entry) => ({ ...entry, value: "[REDACTED]" })),
    requiredOutcome: "[WITHHELD BY CUSTOMER DATA PLANE]",
  };
}

/** Example payload for TypeScript and non-TypeScript HTTP clients. */
const blockedContextHttpExample: BlockedContextContract = {
  schemaVersion: BLOCKED_CONTEXT_SCHEMA_VERSION,
  identity: {
    tenantId: "tenant-example",
    requestId: "request-42",
    parentGoalId: "goal-restock-2026-08-12",
    workItemId: "line-item-7",
  },
  originalGoal: "Restock every approved item that is short before 21:00.",
  attemptedStep: "Create one draft purchase order for the approved shortage.",
  observedBlocker: "No configured capability can perform the required documented operation.",
  relevantContext: [
    { key: "itemReference", value: "ITEM-007" },
    { key: "requestedQuantity", value: 12 },
  ],
  requiredOutcome: "Exactly one externally observable draft purchase order linked to ITEM-007.",
  existingAuthorityReferences: [
    { referenceId: "procurement-draft-policy-v2", referenceType: "policy" },
    { referenceId: "customer-erp-key-alias", referenceType: "credential-alias" },
  ],
  authorityEffect: "none",
};

export const BLOCKED_CONTEXT_HTTP_EXAMPLE: BlockedContextContract = Object.freeze(
  blockedContextHttpExample,
);
