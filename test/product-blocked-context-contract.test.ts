import { describe, expect, it } from "vitest";
import {
  BLOCKED_CONTEXT_HTTP_EXAMPLE,
  BLOCKED_CONTEXT_MEDIA_TYPE,
  blockedContextIdentityKey,
  blockedContextWorkItemKey,
  deserializeBlockedContext,
  parseBlockedContext,
  redactBlockedContextForAudit,
  sameBlockedWorkItem,
  serializeBlockedContext,
  validateBlockedContext,
} from "../src/product/blocked-context-contract.js";
import { createCapabilitySidecar } from "../src/product/sidecar.js";

function example() {
  return structuredClone(BLOCKED_CONTEXT_HTTP_EXAMPLE);
}

describe("framework-neutral blocked-context contract", () => {
  it("round-trips a language-neutral HTTP body without changing stable identity", () => {
    const input = example();
    const body = serializeBlockedContext(input);
    const parsed = deserializeBlockedContext(Buffer.from(body, "utf8"));

    expect(BLOCKED_CONTEXT_MEDIA_TYPE).toContain("application/vnd.capability-factory.blocked-context+json");
    expect(parsed).toEqual(input);
    expect(blockedContextIdentityKey(parsed.identity)).toBe(
      "tenant-example:goal-restock-2026-08-12:line-item-7:request-42",
    );
    expect(sameBlockedWorkItem(input, parsed)).toBe(true);
  });

  it("correlates a retry to the same durable work item even when its request ID changes", () => {
    const first = example();
    const retry = example();
    retry.identity.requestId = "request-43";
    expect(blockedContextIdentityKey(first.identity)).not.toBe(blockedContextIdentityKey(retry.identity));
    expect(blockedContextWorkItemKey(first.identity)).toBe(blockedContextWorkItemKey(retry.identity));
    expect(sameBlockedWorkItem(first, retry)).toBe(true);
  });

  it("carries references but grants exactly zero authority", () => {
    const parsed = parseBlockedContext(example());

    expect(parsed.authorityEffect).toBe("none");
    expect(parsed.existingAuthorityReferences).toContainEqual({
      referenceId: "procurement-draft-policy-v2",
      referenceType: "policy",
    });

    expect(() => parseBlockedContext({ ...example(), authorityEffect: "approved" })).toThrow();
    expect(() => parseBlockedContext({ ...example(), writeAuthority: "preauthorized" })).toThrow();
  });

  it("rejects secret-looking context keys and values rather than moving credentials", () => {
    const secretKey = example();
    secretKey.relevantContext.push({ key: "api_token", value: "customer-local-alias" });
    expect(validateBlockedContext(secretKey)).toMatchObject({ ok: false });

    const bearer = example();
    bearer.relevantContext.push({ key: "requestNote", value: "Bearer abcdefghijklmnopqrstuvwxyz" });
    const result = validateBlockedContext(bearer);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(" ")).toContain("Secret-looking");

    const privateKey = example();
    privateKey.observedBlocker = "-----BEGIN PRIVATE KEY-----";
    expect(() => parseBlockedContext(privateKey)).toThrow(/Secret-looking/);
  });

  it("allows customer-local credential aliases only through typed references", () => {
    const parsed = parseBlockedContext(example());
    expect(parsed.existingAuthorityReferences).toContainEqual({
      referenceId: "customer-erp-key-alias",
      referenceType: "credential-alias",
    });
  });

  it("rejects secret-looking values disguised as authority reference IDs", () => {
    const secretReference = example();
    secretReference.existingAuthorityReferences.push({
      referenceId: "sk-abcdefghijklmnopqrstuvwx",
      referenceType: "credential-alias",
    });
    expect(() => parseBlockedContext(secretReference)).toThrow(/never secret-looking/);
  });

  it("rejects duplicate context and authority references", () => {
    const duplicateContext = example();
    duplicateContext.relevantContext.push({ key: "itemReference", value: "ITEM-008" });
    expect(() => parseBlockedContext(duplicateContext)).toThrow(/Duplicate context key/);

    const duplicateAuthority = example();
    duplicateAuthority.existingAuthorityReferences.push({
      referenceId: "procurement-draft-policy-v2",
      referenceType: "policy",
    });
    expect(() => parseBlockedContext(duplicateAuthority)).toThrow(/Duplicate authority reference/);
  });

  it("fails closed on oversize fields, collections and serialized bodies", () => {
    const longGoal = example();
    longGoal.originalGoal = "x".repeat(4_001);
    expect(validateBlockedContext(longGoal)).toMatchObject({ ok: false });

    const tooManyEntries = example();
    tooManyEntries.relevantContext = Array.from({ length: 33 }, (_, index) => ({
      key: `field${index}`,
      value: index,
    }));
    expect(validateBlockedContext(tooManyEntries)).toMatchObject({ ok: false });

    expect(() => deserializeBlockedContext(" ".repeat(65_537))).toThrow(/exceeds 65536/);
  });

  it("produces an audit projection without business prose or context values", () => {
    const input = parseBlockedContext(example());
    const audit = redactBlockedContextForAudit(input);

    expect(audit.identity).toEqual(input.identity);
    expect(audit.originalGoal).toBe("[WITHHELD BY CUSTOMER DATA PLANE]");
    expect(audit.attemptedStep).toBe("[WITHHELD BY CUSTOMER DATA PLANE]");
    expect(audit.observedBlocker).toBe("[WITHHELD BY CUSTOMER DATA PLANE]");
    expect(audit.requiredOutcome).toBe("[WITHHELD BY CUSTOMER DATA PLANE]");
    expect(audit.relevantContext).toEqual([
      { key: "itemReference", value: "[REDACTED]" },
      { key: "requestedQuantity", value: "[REDACTED]" },
    ]);
    expect(audit.existingAuthorityReferences).toEqual(input.existingAuthorityReferences);
    expect(audit.authorityEffect).toBe("none");
  });

  it("rejects malformed JSON and unknown fields", () => {
    expect(() => deserializeBlockedContext("{not-json}")).toThrow();
    expect(() => parseBlockedContext({ ...example(), capabilityMode: "constrained-http-api" })).toThrow();
  });

  it("accepts the contract through an authenticated customer-local HTTP path without granting authority", async () => {
    const accessToken = "blocked-context-local-test-token";
    const app = createCapabilitySidecar(undefined, { resolve: () => undefined }, { accessToken });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/onboarding/blocked-context/validate",
        headers: { "x-capability-sidecar-token": accessToken },
        payload: example(),
      });
      expect(response.statusCode).toBe(202);
      const receipt = response.json();
      expect(receipt).toMatchObject({
        accepted: true,
        authorityEffect: "none",
        next: "adapter-discovery-review",
        contract: { identity: { parentGoalId: "goal-restock-2026-08-12" }, authorityEffect: "none" },
      });
      const unauthorized = await app.inject({
        method: "POST",
        url: "/v1/onboarding/blocked-context/validate",
        headers: { "x-capability-sidecar-token": "wrong-blocked-context-token" },
        payload: example(),
      });
      expect(unauthorized.statusCode).toBe(401);
      const oversized = example();
      oversized.relevantContext = Array.from({ length: 32 }, (_, index) => ({ key: `field${index}`, value: "x".repeat(2_000) }));
      const rejected = await app.inject({
        method: "POST",
        url: "/v1/onboarding/blocked-context/validate",
        headers: { "x-capability-sidecar-token": accessToken },
        payload: oversized,
      });
      expect(rejected.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
