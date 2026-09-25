import { describe, expect, it } from "vitest";
import { makeConsoleEvent, recordingDigest } from "../shared/contracts.js";
import { recordedFixture } from "../server/fixtures.js";

const base = { tenantId: "tenant-a", runId: "run-a", requestId: "request-a", type: "goal.received" as const,
  occurredAt: "2026-07-27T00:00:00.000Z", sensitivity: { classification: "tenant-confidential" as const, source: "console-adapter" as const, sanitized: true as const } };

describe("console sanitization boundary", () => {
  it("rejects secret-shaped keys and values", () => {
    expect(() => makeConsoleEvent({ ...base, payload: { accessToken: "not-browser-safe" } })).toThrow(/Forbidden/);
    expect(() => makeConsoleEvent({ ...base, payload: { note: "Bearer abc.def.ghi" } })).toThrow(/secret/i);
  });
  it("drops nested opaque content and rejects excessive approved strings", () => {
    expect(() => makeConsoleEvent({ ...base, payload: { summary: "a".repeat(900) } })).toThrow(/exceeds limit/);
    const event = makeConsoleEvent({ ...base, payload: { summary: "safe", nested: { customer: "private" }, aliases: ["safe_alias"] } });
    expect(event.payload).not.toHaveProperty("nested"); expect(event.payload.aliases).toEqual(["safe_alias"]);
  });
  it("detects manipulated replay files", () => {
    const fixture = recordedFixture(); const original = fixture.digest; fixture.events[0]!.payload.goal = "manipulated";
    expect(recordingDigest(fixture.events)).not.toBe(original);
  });
});
