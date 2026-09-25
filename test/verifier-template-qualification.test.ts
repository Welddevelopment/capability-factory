import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  VerifierTemplateQualificationRegistry,
  qualificationReference,
  qualifyVerifierTemplate,
  verifierQualificationDigest,
  type ExpectedVerifierTemplateVerdict,
  type VerifierTemplateCandidate,
  type VerifierTemplateControlId,
  type VerifierTemplateQualificationCase,
  type VerifierTemplateQualificationCorpus,
} from "../src/product/verifier-template-qualification.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const expected: Record<VerifierTemplateControlId, ExpectedVerifierTemplateVerdict> = {
  completed: { classification: "completed", passed: true, nextAction: "resume", incorrectSideEffects: 0 },
  "not-started": { classification: "not-started", passed: false, nextAction: "retry-after-authority-recheck", incorrectSideEffects: 0 },
  partial: { classification: "partial", passed: false, nextAction: "quarantine", incorrectSideEffects: 0 },
  incorrect: { classification: "incorrect", passed: false, nextAction: "quarantine", incorrectSideEffects: 1 },
  duplicate: { classification: "duplicate", passed: false, nextAction: "quarantine", incorrectSideEffects: 1 },
  stale: { classification: "stale", passed: false, nextAction: "quarantine", incorrectSideEffects: 0 },
  collateral: { classification: "collateral", passed: false, nextAction: "quarantine", incorrectSideEffects: 1 },
  unknown: { classification: "unknown", passed: false, nextAction: "handoff", incorrectSideEffects: 0 },
  unavailable: { classification: "unavailable", passed: false, nextAction: "handoff", incorrectSideEffects: 0 },
  "lost-response-reconciliation": { classification: "completed", passed: true, nextAction: "resume", incorrectSideEffects: 0 },
  "adversarial-action-response": { classification: "unavailable", passed: false, nextAction: "handoff", incorrectSideEffects: 0 },
};

function qualificationCase(controlId: VerifierTemplateControlId): VerifierTemplateQualificationCase {
  return {
    controlId,
    independentObservation: {
      source: "read-side-observer",
      classification: expected[controlId].classification,
      passed: expected[controlId].passed,
      nextAction: expected[controlId].nextAction,
      incorrectSideEffects: expected[controlId].incorrectSideEffects,
    },
    responseDisposition: controlId === "lost-response-reconciliation"
      ? "lost"
      : controlId === "adversarial-action-response" ? "available" : "not-applicable",
    ...(controlId === "adversarial-action-response"
      ? { actionResponse: { status: 200, body: { success: true, orderId: "FAKE-SUCCESS" } } }
      : {}),
    expected: expected[controlId],
  };
}

function corpus(): VerifierTemplateQualificationCorpus {
  return {
    schemaVersion: "1.0",
    corpusVersion: "negative-controls-v1",
    cases: (Object.keys(expected) as VerifierTemplateControlId[]).map(qualificationCase),
  };
}

function candidate(overrides: Partial<VerifierTemplateCandidate> = {}): VerifierTemplateCandidate {
  return {
    templateKey: "purchase-order-observer",
    templateVersion: "v1",
    runtimeFamily: "constrained-http-api",
    implementationDigest: hash("purchase-order-observer implementation v1"),
    outcomeSchemaDigest: hash("purchase-order-observer outcome schema v1"),
    evaluate(input) {
      const observation = input.independentObservation as Record<string, unknown>;
      return {
        classification: observation.classification as ExpectedVerifierTemplateVerdict["classification"],
        passed: observation.passed as boolean,
        nextAction: observation.nextAction as ExpectedVerifierTemplateVerdict["nextAction"],
        incorrectSideEffects: observation.incorrectSideEffects as number,
        observedStateDigest: verifierQualificationDigest(input.independentObservation),
      };
    },
    ...overrides,
  };
}

function qualification(preparedCandidate = candidate()) {
  return qualifyVerifierTemplate({
    candidate: preparedCandidate,
    corpus: corpus(),
    primitiveRegistryDigest: hash("primitive registry v1"),
    verifierRegistryDigest: hash("verifier registry v1"),
    qualifiedAt: "2026-08-14T10:00:00.000Z",
    expiresAt: "2026-09-13T10:00:00.000Z",
  });
}

describe("verifier-template qualification", () => {
  it("qualifies only after every mandatory negative control matches the fixed oracle", () => {
    const result = qualification();
    expect(result.status).toBe("qualified");
    if (result.status !== "qualified") return;
    expect(result.receipt.controls).toHaveLength(11);
    expect(result.receipt.controls.every((control) => control.passed)).toBe(true);
    expect(result.receipt.corpusDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.receipt.oracleDigest).toMatch(/^[a-f0-9]{64}$/);

    const registry = new VerifierTemplateQualificationRegistry([result.receipt]);
    expect(registry.assertQualified({
      reference: qualificationReference(result.receipt),
      runtimeFamily: "constrained-http-api",
      primitiveRegistryDigest: hash("primitive registry v1"),
      verifierRegistryDigest: hash("verifier registry v1"),
      now: "2026-08-14T10:01:00.000Z",
    }).qualificationDigest).toBe(result.receipt.qualificationDigest);
  });

  it("rejects a template that trusts a successful action response over unavailable external evidence", () => {
    const unsafe = candidate({
      evaluate(input) {
        if (input.actionResponse) {
          return {
            classification: "completed",
            passed: true,
            nextAction: "resume",
            incorrectSideEffects: 0,
            observedStateDigest: verifierQualificationDigest(input.independentObservation),
          };
        }
        const observation = input.independentObservation as Record<string, unknown>;
        return {
          classification: observation.classification as ExpectedVerifierTemplateVerdict["classification"],
          passed: observation.passed as boolean,
          nextAction: observation.nextAction as ExpectedVerifierTemplateVerdict["nextAction"],
          incorrectSideEffects: observation.incorrectSideEffects as number,
          observedStateDigest: verifierQualificationDigest(input.independentObservation),
        };
      },
    });
    const result = qualification(unsafe);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.controls.find((control) => control.controlId === "adversarial-action-response")).toMatchObject({ passed: false });
    }
  });

  it("rejects a corpus that omits a control or weakens the mandatory oracle", () => {
    const incomplete = corpus();
    incomplete.cases = incomplete.cases.filter((testCase) => testCase.controlId !== "duplicate");
    incomplete.cases.find((testCase) => testCase.controlId === "partial")!.expected = {
      classification: "partial",
      passed: true,
      nextAction: "resume",
      incorrectSideEffects: 0,
    };
    const result = qualifyVerifierTemplate({
      candidate: candidate(),
      corpus: incomplete,
      primitiveRegistryDigest: hash("primitive registry v1"),
      verifierRegistryDigest: hash("verifier registry v1"),
      qualifiedAt: "2026-08-14T10:00:00.000Z",
      expiresAt: "2026-09-13T10:00:00.000Z",
    });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.errors.join(" ")).toMatch(/duplicate|mandatory fail-closed oracle/i);
  });

  it("rejects a mutated receipt and mismatched implementation, family, registries or expiry", () => {
    const result = qualification();
    if (result.status !== "qualified") throw new Error(JSON.stringify(result));

    const mutatedReceipt = structuredClone(result.receipt);
    mutatedReceipt.outcomeSchemaDigest = hash("mutated outcome schema");
    expect(() => new VerifierTemplateQualificationRegistry([mutatedReceipt])).toThrow(/integrity/i);

    const registry = new VerifierTemplateQualificationRegistry([result.receipt]);
    const base = {
      reference: qualificationReference(result.receipt),
      runtimeFamily: "constrained-http-api",
      primitiveRegistryDigest: hash("primitive registry v1"),
      verifierRegistryDigest: hash("verifier registry v1"),
      now: "2026-08-14T10:01:00.000Z",
    };
    expect(() => registry.assertQualified({
      ...base,
      reference: { ...base.reference, implementationDigest: hash("mutated implementation") },
    })).toThrow(/identity changed/i);
    expect(() => registry.assertQualified({ ...base, runtimeFamily: "experimental-browser-actions" })).toThrow(/different runtime family/i);
    expect(() => registry.assertQualified({ ...base, verifierRegistryDigest: hash("other verifier registry") })).toThrow(/current primitive and verifier registries/i);
    expect(() => registry.assertQualified({ ...base, now: "2026-09-13T10:00:00.000Z" })).toThrow(/expired/i);
  });
});
